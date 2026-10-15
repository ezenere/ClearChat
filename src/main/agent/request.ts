// Construção da request (função pura). Usada pelo runner E pelo previewRequest.
// Ver SPEC.md → "Construção da request" e "Token caching".
import * as os from 'os'
import { defaultToolsPrompt, isOpenRouter } from '@shared/defaults'
import { DEFAULT_APP_SIGNATURE, resolveAppSignatureHeaders } from '@shared/appSignatures'
import { TOOL_NAMES, toolDefinitionFor, type ToolDefinition } from '@shared/tools'
import { activeHistory } from '@shared/context'
import { bwrapAvailable } from '../tools/bash'
import { expandAttachments } from '../attachments'
import type {
  ApiMessage,
  Chat,
  ChatConfig,
  ChatParams,
  ContentPart,
  Provider,
  Session,
  StoredMessage,
  ToolCall,
  ToolName
} from '@shared/types'

export interface BuiltRequest {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
}

export interface EnvInfo {
  os: string
  shell: string
  /** bubblewrap instalado (o sandbox do bash só vale se existir). */
  bwrap?: boolean
}

/** Info do ambiente para o bloco <environment> — sem data/hora (estável para cache). */
export function defaultEnvInfo(): EnvInfo {
  const name =
    process.platform === 'linux'
      ? 'Linux'
      : process.platform === 'darwin'
        ? 'macOS'
        : process.platform === 'win32'
          ? 'Windows'
          : process.platform
  return {
    os: `${name} ${os.release()} (${process.arch})`,
    shell: 'bash',
    bwrap: bwrapAvailable()
  }
}

/**
 * Bloco <environment>: diretório raiz, SO, shell e regras do workspace. Só valores estáveis
 * (sem data/hora nem diretório atual do shell) — o prefixo do prompt não muda entre chamadas.
 */
export function environmentBlock(
  cfg: Pick<ChatConfig, 'cwd' | 'confineToRoot' | 'sandboxBash'>,
  env: EnvInfo = defaultEnvInfo()
): string {
  const lines = [
    `root: ${cfg.cwd}`,
    `os: ${env.os}`,
    `shell: ${env.shell}`,
    'Diretório raiz (workspace) desta sessão: root acima. Caminhos relativos nas ferramentas resolvem a partir dele e o bash começa nele (o diretório do shell persiste entre chamadas).'
  ]
  if (cfg.confineToRoot)
    lines.push('As ferramentas de arquivo só acessam caminhos dentro do diretório raiz.')
  if (cfg.sandboxBash && env.bwrap)
    lines.push('O bash roda em sandbox: só o diretório raiz (e um /tmp privado) é gravável.')
  return `<environment>\n${lines.join('\n')}\n</environment>`
}

/** Tools que só fazem sentido com delegate_task disponível (subagentes da própria sessão). */
const SUBAGENT_TOOLS: ToolName[] = [
  'check_subagents',
  'wait_subagents',
  'cancel_subagent',
  'message_subagent'
]

/** A sessão já chamou delegate_task (tem ou teve subagentes)? */
export function hasDelegated(history: StoredMessage[]): boolean {
  return history.some(
    (m) =>
      m.message.role === 'assistant' &&
      !!m.message.tool_calls?.some((t) => t.function.name === 'delegate_task')
  )
}

/**
 * Tools disponíveis para a sessão: habilitadas no chat, na ordem fixa de TOOL_NAMES; delegate só se
 * depth < 2. As de gerenciar subagentes (check/wait/cancel/message) só com delegate_task disponível;
 * num SUBAGENTE, e quando o histórico é informado (request), só depois que ele criou algum
 * subagente: modelos fracos não as confundem com "responder" a quem delegou (o prefixo de cache
 * muda uma vez, no primeiro delegate). A principal as vê sempre (para planejar). Sem histórico
 * (execução de tool), é permissivo.
 */
export function availableTools(
  chat: Chat,
  session: Pick<Session, 'depth'>,
  history?: StoredMessage[]
): ToolName[] {
  const enabled = new Set(chat.config.enabledTools ?? [])
  const canDelegate =
    enabled.has('delegate_task') &&
    session.depth < 2 &&
    (!history || session.depth === 0 || hasDelegated(history))
  return TOOL_NAMES.filter(
    (n) =>
      enabled.has(n) &&
      (n !== 'delegate_task' || session.depth < 2) &&
      (!SUBAGENT_TOOLS.includes(n) || canDelegate)
  )
}

/** Nomes dos provedores configurados (o runner registra; sem registro = nenhum → sem `provider`). */
let providerNamesSource: () => string[] = () => []
export function setProviderNamesSource(fn: () => string[]): void {
  providerNamesSource = fn
}

export function toolDefinitions(
  names: ToolName[],
  providerNames: string[] = providerNamesSource()
): ToolDefinition[] {
  return names.map((n) => toolDefinitionFor(n, providerNames))
}

/** Conteúdo do system prompt (string; vazio = não envia). */
export function systemContent(
  chat: Chat,
  session: Pick<Session, 'depth'>,
  env: EnvInfo = defaultEnvInfo(),
  history?: StoredMessage[]
): string {
  const cfg = chat.config
  let s = session.depth === 0 ? (cfg.systemPrompt ?? '') : (cfg.subagentSystemPrompt ?? '')
  const add = (block: string): void => {
    if (!block) return
    s = s ? `${s}\n\n${block}` : block
  }
  if (cfg.envInPrompt) add(environmentBlock(cfg, env))
  if (cfg.toolsInPrompt) {
    const defs = toolDefinitions(availableTools(chat, session, history))
    add(cfg.toolsPromptText ?? defaultToolsPrompt(defs, cfg.nativeTools))
  }
  return s
}

const PARAM_KEYS: (keyof ChatParams)[] = [
  'temperature',
  'top_p',
  'top_k',
  'max_tokens',
  'frequency_penalty',
  'presence_penalty',
  'repetition_penalty',
  'seed'
]

export function parseExtraBody(extra: string | undefined): Record<string, unknown> | null {
  if (extra == null || !extra.trim()) return null
  let v: unknown
  try {
    v = JSON.parse(extra)
  } catch (e) {
    throw new Error(`extraBody não é um JSON válido: ${(e as Error).message}`, { cause: e })
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    throw new Error('extraBody deve ser um objeto JSON (ex.: {"chave": "valor"}).')
  }
  return v as Record<string, unknown>
}

/**
 * Sanitiza o histórico para envio (determinístico → estável para cache):
 * - descarta mensagens 'tool' órfãs (sem tool_call correspondente no assistant anterior);
 * - insere resultados placeholder para tool_calls sem resposta (ex.: usuário apagou a msg tool);
 * - remove `reasoning` dos assistants quando o provider não é OpenRouter.
 */
export function sanitizeHistory(messages: ApiMessage[], keepReasoning: boolean): ApiMessage[] {
  const out: ApiMessage[] = []
  let pending: string[] = [] // ids de tool_calls aguardando resposta
  const flush = (): void => {
    for (const id of pending) {
      out.push({ role: 'tool', tool_call_id: id, content: '[Resultado indisponível]' })
    }
    pending = []
  }
  for (const m of messages) {
    if (m.role === 'tool') {
      const i = pending.indexOf(m.tool_call_id)
      if (i === -1) continue // órfã
      pending.splice(i, 1)
      out.push(m)
      continue
    }
    flush()
    if (m.role === 'assistant') {
      let a = m
      if (!keepReasoning && 'reasoning' in a) {
        const { reasoning: _r, ...rest } = a
        void _r
        a = rest
      }
      if (a.tool_calls && a.tool_calls.length === 0) {
        const { tool_calls: _t, ...rest } = a
        void _t
        a = rest
      }
      out.push(a)
      pending = (a.tool_calls ?? []).map((t) => t.id)
    } else {
      out.push(m)
    }
  }
  flush()
  return out
}

/** Mensagem como vai no fio: igual a ApiMessage, mas qualquer content pode virar parts (cópia com cache_control). */
export type WireMessage =
  | ApiMessage
  | { role: 'assistant'; content: ContentPart[]; tool_calls?: ToolCall[]; reasoning?: string }
  | { role: 'tool'; tool_call_id: string; content: ContentPart[] }

/**
 * Marca o último text part de uma mensagem com cache_control (na CÓPIA). Mensagem só com anexos
 * (sem text part): marca o último part (imagem/arquivo/áudio) — aceito via OpenRouter por
 * Anthropic, OpenAI e Gemini (verificado empiricamente).
 */
function withCacheControl(content: string | ContentPart[]): ContentPart[] {
  const parts: ContentPart[] =
    typeof content === 'string' ? [{ type: 'text', text: content }] : content.map((p) => ({ ...p }))
  let i = parts.length - 1
  while (i >= 0 && parts[i].type !== 'text') i--
  if (i < 0) i = parts.length - 1
  if (i >= 0) parts[i] = { ...parts[i], cache_control: { type: 'ephemeral' } }
  return parts
}

/** Cópia da mensagem com breakpoint de cache; null se não houver onde marcar (conteúdo vazio). */
function markMessage(m: ApiMessage): WireMessage | null {
  const c = m.content
  if (c == null || (typeof c === 'string' && c === '')) return null
  if (Array.isArray(c) && !c.length) return null
  return { ...m, content: withCacheControl(c) } as WireMessage
}

/**
 * Breakpoints `cache_control` (Anthropic aceita no máx. 4 por request; usamos até 3), só na CÓPIA:
 * 1. system prompt;
 * 2. a ÚLTIMA mensagem do array, de qualquer role (inclusive `tool` — verificado empiricamente
 *    via OpenRouter → Anthropic) — em loops longos de tools cada passo lê o prefixo do anterior;
 *    se ela não tiver texto marcável (ex.: assistant só com tool_calls), recua até a próxima que tenha;
 * 3. a última mensagem `user` (se ainda não marcada) — ponto estável do turno.
 */
export function applyCacheBreakpoints(messages: ApiMessage[]): WireMessage[] {
  const out: WireMessage[] = [...messages]
  if (out.length && messages[0].role === 'system') {
    out[0] = { role: 'system', content: withCacheControl(messages[0].content) }
  }
  const start = messages[0]?.role === 'system' ? 1 : 0
  let lastMarked = -1
  for (let i = messages.length - 1; i >= start; i--) {
    const marked = markMessage(messages[i])
    if (marked) {
      out[i] = marked
      lastMarked = i
      break
    }
  }
  for (let i = messages.length - 1; i >= start; i--) {
    if (messages[i].role !== 'user') continue
    if (i !== lastMarked) {
      const marked = markMessage(messages[i])
      if (marked) out[i] = marked
    }
    break
  }
  return out
}

/**
 * Headers: Content-Type, Authorization, assinatura de app (HTTP-Referer/X-Title, qualquer provider)
 * e por último provider.headers (sobrescrevem).
 */
export function buildHeaders(
  provider: Provider,
  appSignature: Record<string, string> = {}
): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' }
  if (provider.apiKey) h['Authorization'] = `Bearer ${provider.apiKey}`
  Object.assign(h, appSignature)
  for (const [k, v] of Object.entries(provider.headers ?? {})) {
    if (typeof v === 'string') h[k] = v
  }
  return h
}

export function chatCompletionsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/chat/completions`
}

/**
 * Monta a request EXATA para `POST {baseUrl}/chat/completions`.
 * - Só o histórico a partir da fronteira de compactação mais recente (meta.kind 'compaction') vai;
 *   as mensagens anteriores continuam salvas (e visíveis), mas não são enviadas.
 * - Mensagens com meta.kind === 'error' (se existirem) não são enviadas.
 * - sanitizeHistory descarta resultados de tool órfãos logo após a fronteira (nunca envia um par
 *   tool_calls ↔ tool partido).
 */
export function buildRequest(
  chat: Chat,
  session: Pick<Session, 'depth' | 'model'>,
  history: StoredMessage[],
  provider: Provider,
  env: EnvInfo = defaultEnvInfo()
): BuiltRequest {
  const cfg = chat.config
  const openRouter = isOpenRouter(provider.baseUrl)

  const sys = systemContent(chat, session, env, history)
  const hist = sanitizeHistory(
    activeHistory(history)
      .filter((m) => m.meta?.kind !== 'error')
      .map((m) => m.message),
    openRouter
  )
  const messages: ApiMessage[] = []
  if (sys) messages.push({ role: 'system', content: sys })
  messages.push(...hist)

  // Anexos: referências clearchat-attachment:// → base64 e `_attachment` removido (só na cópia).
  const sent = expandAttachments(messages)
  const wire: WireMessage[] = cfg.cacheEnabled ? applyCacheBreakpoints(sent) : sent

  const body: Record<string, unknown> = {
    model: session.model,
    messages: wire,
    stream: true,
    stream_options: { include_usage: true }
  }

  const tools = availableTools(chat, session, history)
  if (cfg.nativeTools && tools.length) body.tools = toolDefinitions(tools)

  const params = cfg.params ?? {}
  for (const k of PARAM_KEYS) {
    const v = params[k]
    if (v !== undefined && v !== null && !(typeof v === 'number' && Number.isNaN(v))) body[k] = v
  }
  if (params.reasoning_effort) {
    if (openRouter) body.reasoning = { effort: params.reasoning_effort }
    else body.reasoning_effort = params.reasoning_effort
  }
  if (openRouter) body.usage = { include: true }

  const extra = parseExtraBody(params.extraBody)
  if (extra) Object.assign(body, extra)

  const signature = resolveAppSignatureHeaders(
    cfg.appSignature ?? DEFAULT_APP_SIGNATURE,
    cfg.appSignatureCustom
  )
  return {
    url: chatCompletionsUrl(provider.baseUrl),
    headers: buildHeaders(provider, signature),
    body
  }
}

/** `sk-or-v1-abc…a3b9` → `sk-or-…a3b9`. */
export function maskKey(key: string): string {
  if (!key) return ''
  if (key.length <= 12) return '…' + key.slice(-2)
  return `${key.slice(0, 6)}…${key.slice(-4)}`
}

/** Versão para exibição (preview): Authorization com a key mascarada. */
export function maskRequest(req: BuiltRequest, apiKey: string): BuiltRequest {
  const headers: Record<string, string> = {}
  for (const [k, v] of Object.entries(req.headers)) {
    headers[k] = apiKey && v.includes(apiKey) ? v.split(apiKey).join(maskKey(apiKey)) : v
  }
  return { ...req, headers }
}
