// Smart-Approve: um modelo "juiz" decide se uma chamada de tool que pediria confirmação pode rodar.
// Funções puras (main: runner/juiz; renderer: editor, (i) com a request de exemplo). Ver SPEC.md →
// "Smart-Approve".
//
// Quando o juiz é chamado: ver approvalRoute em approvalPolicy.ts (itens em modo `smart`, com um
// modelo escolhido); nos itens com listas, só para o que as listas não decidem (smartListPlan).
// Aprovar → roda · perguntar → usuário · rejeitar → só com "O juiz pode negar" (canDeny); sem ele,
// vira perguntar (mapJudgeDecision). Qualquer erro, tempo esgotado ou resposta ambígua do juiz →
// pergunta ao usuário (nunca libera nem nega). Contexto extra: smartApproveContext.ts.
import { contentText } from './attachments'
import { describeShell } from './shellParse'
import { activeHistory, isDisplayOnly } from './context'
import {
  DEFAULT_SMART_APPROVE_LABELS,
  DEFAULT_SMART_APPROVE_PROMPT,
  DEFAULT_SMART_APPROVE_TEMPLATE
} from './defaults'
import {
  approvedBlock,
  buildJudgeExtras,
  checkBlock,
  recentActivityBlock,
  subagentBlock,
  touchedFilesBlock,
  userGoalText,
  type JudgeExtras
} from './smartApproveContext'
import {
  type ApiMessage,
  type ApprovalCheck,
  type SmartApproveConfig,
  type SmartApproveDecision,
  type SmartApproveLabels,
  type StoredMessage,
  type ToolName
} from './types'

export const SMART_APPROVE_DEFAULTS = {
  contextMessages: 6,
  timeoutS: 30,
  /** Limites aceitos na UI/normalização. */
  minTimeoutS: 3,
  maxTimeoutS: 300,
  maxContextMessages: 50,
  /** Parâmetros fixos da chamada ao juiz. */
  temperature: 0,
  maxTokens: 300
} as const

/** Placeholders aceitos no prompt e no template (cola na UI). */
export const SMART_APPROVE_PLACEHOLDERS: { key: string; desc: string }[] = [
  { key: 'tool', desc: 'nome da tool (ex.: shell)' },
  { key: 'args', desc: 'argumentos da chamada (JSON formatado)' },
  {
    key: 'commands',
    desc: 'shell/process_start: a decomposição do comando (ssh, sudo, bash -c… desmontados, com o contexto); vazio nas outras tools'
  },
  {
    key: 'user_goal',
    desc: 'objetivo do usuário: as últimas 3 mensagens digitadas na sessão principal (a mais recente primeiro, ≤ 1.500 chars)'
  },
  {
    key: 'subagent',
    desc: 'subagente: profundidade, título e a tarefa recebida do pai (+ a dos subagentes acima); vazio no agente principal'
  },
  {
    key: 'touched_files',
    desc: 'arquivos criados/editados/apresentados nesta tarefa (sessão + pais; até 30); vazio se nenhum'
  },
  {
    key: 'approved_before',
    desc: 'já aprovados: entradas parecidas da whitelist + o que você aprovou nesta sessão; vazio se nada'
  },
  {
    key: 'recent_activity',
    desc: 'últimas 12 chamadas de tool da sessão (status, nome, args curtos) + a última fala do agente'
  },
  { key: 'cwd', desc: 'diretório raiz do chat' },
  { key: 'confine', desc: 'tools de arquivo confinadas à raiz (yes/no)' },
  { key: 'sandbox', desc: 'shell em sandbox (yes/no)' },
  { key: 'last_user_message', desc: 'última mensagem do usuário na sessão' },
  { key: 'recent_context', desc: 'últimas N mensagens da sessão, compactas' },
  {
    key: 'labels',
    desc: 'os rótulos aceitos separados por " | " (o de rejeitar só com “O juiz pode negar”)'
  },
  { key: 'approve', desc: 'rótulo de aprovar' },
  { key: 'reject', desc: 'rótulo de rejeitar' },
  { key: 'ask', desc: 'rótulo de perguntar ao usuário' },
  {
    key: 'reject_rule',
    desc: 'a regra de rejeitar (uma linha começando com quebra de linha) com “O juiz pode negar”; vazio sem ela'
  }
]

const clampInt = (v: unknown, min: number, max: number, def: number): number => {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : def
  return Math.min(max, Math.max(min, n))
}

/** Erro de validação dos rótulos (null = ok): não vazios, uma linha, distintos (sem caixa). */
export function validateLabels(labels: Partial<SmartApproveLabels> | undefined): string | null {
  const vals = [labels?.approve, labels?.reject, labels?.ask].map((v) =>
    typeof v === 'string' ? v.trim() : ''
  )
  if (vals.some((v) => !v)) return 'Os três rótulos são obrigatórios.'
  if (vals.some((v) => /[\r\n]/.test(v))) return 'Rótulos não podem ter quebra de linha.'
  if (vals.some((v) => v.length > 40)) return 'Rótulos devem ter no máximo 40 caracteres.'
  const lower = vals.map((v) => v.toLowerCase())
  if (new Set(lower).size !== 3) return 'Os rótulos precisam ser diferentes entre si.'
  return null
}

/**
 * Config completa a partir do que estiver salvo (campos ausentes/inválidos → padrão). Chaves
 * legadas (`enabled`, `tools` — ≤ 0.4.0) não entram: ver migrateSmartApproveConfig.
 */
export function normalizeSmartApprove(
  sa: Partial<SmartApproveConfig> | null | undefined
): SmartApproveConfig {
  const s = sa ?? {}
  const labels =
    s.labels && !validateLabels(s.labels)
      ? {
          approve: s.labels.approve.trim(),
          reject: s.labels.reject.trim(),
          ask: s.labels.ask.trim()
        }
      : { ...DEFAULT_SMART_APPROVE_LABELS }
  const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null)
  return {
    providerId: str(s.providerId),
    model: str(s.model)?.trim() ?? null,
    prompt: typeof s.prompt === 'string' ? s.prompt : null,
    template: typeof s.template === 'string' ? s.template : null,
    labels,
    contextMessages: clampInt(
      s.contextMessages,
      0,
      SMART_APPROVE_DEFAULTS.maxContextMessages,
      SMART_APPROVE_DEFAULTS.contextMessages
    ),
    timeoutS: clampInt(
      s.timeoutS,
      SMART_APPROVE_DEFAULTS.minTimeoutS,
      SMART_APPROVE_DEFAULTS.maxTimeoutS,
      SMART_APPROVE_DEFAULTS.timeoutS
    ),
    // 0.8.4: ausentes (configs anteriores) = desligados — quem já usava o juiz passa a ter
    // rejeição → perguntar e a whitelist decidindo sozinha o que ela cobre
    canDeny: s.canDeny === true,
    judgeWhitelisted: s.judgeWhitelisted === true
  }
}

/**
 * Decisão efetiva do juiz: sem "O juiz pode negar" (`canDeny`), rejeitar vira perguntar
 * (`wouldReject` — o card mostra o motivo como dica). Aprovar/perguntar não mudam.
 */
export function mapJudgeDecision(
  decision: SmartApproveDecision,
  canDeny: boolean
): { decision: SmartApproveDecision; wouldReject?: true } {
  return decision === 'reject' && !canDeny ? { decision: 'ask', wouldReject: true } : { decision }
}

/**
 * Juiz pronto = provedor + modelo escolhidos. Sem modelo, os itens em modo `smart` perguntam a
 * você (fail-closed). Não há mais liga/desliga: o juiz age só nos itens em modo `smart`.
 */
export function smartApproveActive(sa: Partial<SmartApproveConfig> | null | undefined): boolean {
  return !!sa?.providerId && !!sa.model?.trim()
}

// ---------------- parse da resposta ----------------

const escRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const KEYS: SmartApproveDecision[] = ['approve', 'reject', 'ask']
/** Fronteira de rótulo: nem letra, nem dígito, nem _ ou - colados (ASK-USER ≠ ASK). */
const B_BEFORE = '(?<![\\p{L}\\p{N}_-])'
const B_AFTER = '(?![\\p{L}\\p{N}_-])'

function findLabels(
  text: string,
  labels: SmartApproveLabels,
  caseInsensitive: boolean
): { key: SmartApproveDecision; index: number; length: number }[] {
  const out: { key: SmartApproveDecision; index: number; length: number }[] = []
  for (const key of KEYS) {
    const re = new RegExp(
      `${B_BEFORE}${escRe(labels[key])}${B_AFTER}`,
      caseInsensitive ? 'giu' : 'gu'
    )
    for (const m of text.matchAll(re)) out.push({ key, index: m.index, length: m[0].length })
  }
  return out.sort((a, b) => a.index - b.index)
}

/** Prefixos tolerados antes do rótulo na 1ª linha ("Decision: APPROVED", "Veredito — …"). */
const PREFIX_RE =
  /^(?:(?:final\s+)?(?:decision|decisão|decisao|verdict|veredito|label|rótulo|rotulo|answer|resposta)\s*[:\-–—]\s*)?["'«“[(]*/iu

export interface ParsedJudge {
  decision: SmartApproveDecision | null
  reason: string
  /** Sem decisão: resposta vazia, sem rótulo no início da 1ª linha, ou mais de um rótulo distinto. */
  problem?: 'empty' | 'no-label' | 'multiple'
}

/**
 * Lê a resposta do juiz. Regras (fail-closed — na dúvida, sem decisão → perguntar ao usuário):
 * - ignora blocos <think>…</think>, marcação Markdown (* ` ~~, #, >, marcadores de lista) e linhas vazias;
 * - a 1ª linha precisa COMEÇAR com um rótulo (sem caixa; tolera "Decision:" e aspas/colchetes) —
 *   "this should not be APPROVED" não vale;
 * - outro rótulo distinto na mesma linha (sem caixa) ou no resto do texto (com a caixa exata)
 *   → ambíguo;
 * - o resto (depois do rótulo, sem pontuação inicial) é o motivo, numa linha só (≤ 500 chars).
 */
export function parseJudgeOutput(raw: string, labelsIn?: Partial<SmartApproveLabels>): ParsedJudge {
  const labels = normalizeSmartApprove({ labels: labelsIn as SmartApproveLabels }).labels
  const text = (raw ?? '')
    .replace(/\r/g, '')
    .replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, '')
    .replace(/[*`]|~~/g, '')
  const lines = text.split('\n').map((l) => l.replace(/^\s*(?:[#>]+\s*|[-•]\s+)*/u, '').trim())
  const firstIdx = lines.findIndex((l) => l)
  const flat = (s: string): string => s.replace(/\s+/g, ' ').trim().slice(0, 500)
  if (firstIdx < 0) return { decision: null, reason: '', problem: 'empty' }
  const first = lines[firstIdx]
  const prefix = PREFIX_RE.exec(first)?.[0] ?? ''
  const head = first.slice(prefix.length)
  const atStart = findLabels(head, labels, true).find((f) => f.index === 0)
  if (!atStart) return { decision: null, reason: flat(lines.join(' ')), problem: 'no-label' }
  const key = atStart.key
  const restFirst = head.slice(atStart.length)
  const rest = [restFirst, ...lines.slice(firstIdx + 1)].join('\n')
  const reason = flat(rest.replace(/^[\s:.\-–—,;)\]"'»”]+/u, ''))
  const otherInLine = findLabels(restFirst, labels, true).some((f) => f.key !== key)
  const otherAfter = findLabels(lines.slice(firstIdx + 1).join('\n'), labels, false).some(
    (f) => f.key !== key
  )
  if (otherInLine || otherAfter) return { decision: null, reason, problem: 'multiple' }
  return { decision: key, reason }
}

// ---------------- template e contexto ----------------

/**
 * Substitui `{{nome}}` (espaços tolerados) numa passada só — valores inseridos não são
 * reprocessados. Placeholders desconhecidos ficam como estão.
 */
export function renderSmartTemplate(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (m, k: string) =>
    Object.prototype.hasOwnProperty.call(vars, k.toLowerCase()) ? vars[k.toLowerCase()] : m
  )
}

const cut = (s: string, max: number): string => {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max)}… [+${t.length - max} chars]` : t
}

/** Última mensagem "do usuário" da sessão (na subsessão: a tarefa ou a última mensagem recebida). */
export function lastUserMessage(history: StoredMessage[], max = 2000): string {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]
    if (m.message.role !== 'user') continue
    if (m.meta?.kind === 'compaction' || isDisplayOnly(m.meta)) continue
    if (m.meta?.kind === 'subagent-callback') continue
    const text = contentText(m.message.content).trim()
    if (!text || text.startsWith('<tool_result')) continue
    return text.length > max ? `${text.slice(0, max)}… [+${text.length - max} chars]` : text
  }
  return '(none)'
}

function messageLine(m: ApiMessage, toolNames: Map<string, string>): string {
  switch (m.role) {
    case 'user':
      return `[user] ${cut(contentText(m.content), 600) || '(attachments only)'}`
    case 'system':
      return `[system] ${cut(contentText(m.content), 300)}`
    case 'assistant': {
      const parts: string[] = []
      if (m.content?.trim()) parts.push(cut(m.content, 600))
      for (const tc of m.tool_calls ?? [])
        parts.push(`→ ${tc.function.name}(${cut(tc.function.arguments, 300)})`)
      return `[assistant] ${parts.join('\n  ') || '(empty)'}`
    }
    case 'tool':
      return `[tool ${toolNames.get(m.tool_call_id) ?? '?'}] ${cut(contentText(m.content), 300)}`
  }
}

/** As últimas `n` mensagens ativas da sessão em texto compacto (resultados de tool cortados). */
export function recentContext(history: StoredMessage[], n: number): string {
  if (n <= 0) return '(omitted)'
  const active = activeHistory(history).filter((m) => !isDisplayOnly(m.meta))
  const toolNames = new Map<string, string>()
  for (const m of active)
    if (m.message.role === 'assistant')
      for (const tc of m.message.tool_calls ?? []) toolNames.set(tc.id, tc.function.name)
  const slice = active.slice(-n)
  if (!slice.length) return '(empty)'
  return slice.map((m) => messageLine(m.message, toolNames)).join('\n')
}

export function prettyArgs(args: unknown): string {
  try {
    return JSON.stringify(args ?? {}, null, 2)
  } catch {
    return String(args)
  }
}

export interface JudgeContext {
  tool: ToolName | string
  args: unknown
  cwd: string
  confine: boolean
  sandbox: boolean
  /** Histórico da sessão chamadora ({{last_user_message}}, {{recent_context}}). */
  history: StoredMessage[]
  /** Itens com listas: a avaliação das listas e os índices que o juiz decide (smartListPlan). */
  check?: ApprovalCheck
  judgeIdx?: number[]
  /** Contexto extra montado no main; ausente = derivado de `history` como sessão principal. */
  extra?: JudgeExtras
}

/**
 * `{{commands}}`: decomposição do comando de shell/process_start (o que o modo Listas avalia — ver
 * describeShell), para o juiz ver os comandos remotos/sob sudo/no container e não só `ssh`. Com a
 * avaliação das listas (`check`), cada item vem marcado "already allowed" (whitelist, só contexto)
 * ou "TO DECIDE" (checkBlock). Outras tools (ou comando vazio): "".
 */
export function commandsBlock(
  tool: string,
  args: unknown,
  check?: ApprovalCheck,
  judgeIdx?: number[]
): string {
  if (tool !== 'shell' && tool !== 'process_start') return ''
  if (check && judgeIdx) return checkBlock(check, judgeIdx)
  const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>
  const cmd = typeof a.command === 'string' ? a.command : ''
  const text = cmd.trim() ? describeShell(cmd) : ''
  if (!text) return ''
  return `\nDecomposed commands (parsed by the app; indented lines run inside the line above):\n${text}\n`
}

/**
 * `{{reject_rule}}`: a opção de rejeitar no prompt padrão — só com "O juiz pode negar"; sem ela, ""
 * (o juiz escolhe entre aprovar e perguntar). Começa com quebra de linha (continua a lista).
 */
export function rejectRule(sa: SmartApproveConfig): string {
  if (!sa.canDeny) return ''
  const l = sa.labels
  return `\n- ${l.reject} — only for calls that are clearly malicious or that the user explicitly forbade: exfiltrating secrets or private data, deliberately destroying data unrelated to the work, obfuscated code or scripts piped from the internet (curl … | sh), disabling security tools. When in doubt between ${l.reject} and ${l.ask}, choose ${l.ask}.`
}

/** Valores dos placeholders para uma chamada. */
export function judgeVars(sa: SmartApproveConfig, ctx: JudgeContext): Record<string, string> {
  const l = sa.labels
  const x = ctx.extra ?? buildJudgeExtras({ history: ctx.history, cwd: ctx.cwd })
  return {
    tool: String(ctx.tool),
    args: prettyArgs(ctx.args),
    commands: commandsBlock(ctx.tool, ctx.args, ctx.check, ctx.judgeIdx),
    cwd: ctx.cwd,
    confine: ctx.confine ? 'yes' : 'no',
    sandbox: ctx.sandbox ? 'yes' : 'no',
    last_user_message: lastUserMessage(ctx.history),
    recent_context: recentContext(ctx.history, sa.contextMessages),
    user_goal: userGoalText(x),
    subagent: subagentBlock(x),
    touched_files: touchedFilesBlock(x),
    approved_before: approvedBlock(x),
    recent_activity: recentActivityBlock(x),
    labels: sa.canDeny ? `${l.approve} | ${l.reject} | ${l.ask}` : `${l.approve} | ${l.ask}`,
    approve: l.approve,
    reject: l.reject,
    ask: l.ask,
    reject_rule: rejectRule(sa)
  }
}

/** Mensagens exatas da chamada ao juiz: system (prompt) + user (template), ambos renderizados. */
export function buildJudgeMessages(
  sa: SmartApproveConfig,
  ctx: JudgeContext
): { role: 'system' | 'user'; content: string }[] {
  const vars = judgeVars(sa, ctx)
  return [
    {
      role: 'system',
      content: renderSmartTemplate(sa.prompt ?? DEFAULT_SMART_APPROVE_PROMPT, vars)
    },
    {
      role: 'user',
      content: renderSmartTemplate(sa.template ?? DEFAULT_SMART_APPROVE_TEMPLATE, vars)
    }
  ]
}

/** Body da chamada ao juiz (sem tools; temperatura 0; poucos tokens; streaming acumulado). */
export function buildJudgeBody(
  model: string,
  messages: { role: 'system' | 'user'; content: string }[],
  openRouter: boolean
): Record<string, unknown> {
  return {
    model,
    messages,
    temperature: SMART_APPROVE_DEFAULTS.temperature,
    max_tokens: SMART_APPROVE_DEFAULTS.maxTokens,
    stream: true,
    stream_options: { include_usage: true },
    ...(openRouter ? { usage: { include: true } } : {})
  }
}

/** Resultado de tool enviado ao agente quando o juiz rejeita. */
export function smartRejectText(model: string, reason: string): string {
  return `Rejeitado pelo Smart-Approve (${model}): ${reason.trim() || 'sem motivo informado.'}`
}

/** Chave canônica de argumentos (objetos com chaves ordenadas) — compara chamadas idênticas. */
export function argsKey(args: unknown): string {
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(norm)
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.keys(v as Record<string, unknown>)
          .sort()
          .map((k) => [k, norm((v as Record<string, unknown>)[k])])
      )
    }
    return v
  }
  return JSON.stringify(norm(args ?? {}))
}

/** Resumo curto dos argumentos para a mensagem "Pode executar …; eu aprovo." */
export function argsSummary(tool: string, args: unknown): string {
  const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>
  const pick = (k: string): string => (typeof a[k] === 'string' ? (a[k] as string) : '')
  const main =
    tool === 'shell' || tool === 'bash' || tool === 'process_start'
      ? pick('command') + (tool === 'process_start' && pick('cwd') ? ` (cwd ${pick('cwd')})` : '')
      : tool === 'process_stop'
        ? pick('id')
        : tool === 'web_search'
          ? pick('query')
          : tool === 'browse_url'
            ? pick('url')
            : tool === 'write_file' || tool === 'edit_file'
              ? pick('path')
              : ''
  const s = main || JSON.stringify(a)
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > 160 ? `${flat.slice(0, 160)}…` : flat
}

/** Texto da mensagem enviada em nome do usuário ao clicar "Executar mesmo assim". */
export function overrideMessageText(tool: string, args: unknown): string {
  return `Pode executar ${tool} \`${argsSummary(tool, args)}\`; eu aprovo.`
}

/** Exemplo usado no (i) e no "Testar" do editor. */
export const SMART_APPROVE_SAMPLE = {
  tool: 'shell' as ToolName,
  args: { command: 'rm -rf node_modules && npm install' },
  history: [
    {
      id: 'sample-1',
      sessionId: 'sample',
      seq: 1,
      message: { role: 'user', content: 'As dependências do projeto estão quebradas, reinstale.' },
      meta: {},
      createdAt: 0
    },
    {
      id: 'sample-2',
      sessionId: 'sample',
      seq: 2,
      message: {
        role: 'assistant',
        content: 'Vou apagar node_modules e reinstalar.',
        tool_calls: [
          {
            id: 'call_sample',
            type: 'function',
            function: {
              name: 'shell',
              arguments: '{"command":"rm -rf node_modules && npm install"}'
            }
          }
        ]
      },
      meta: {},
      createdAt: 0
    }
  ] as StoredMessage[]
}
