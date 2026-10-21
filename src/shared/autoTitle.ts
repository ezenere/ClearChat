// Título automático de chats novos (Configurações → Novos chats → "Título automático"): config
// global, prompt enviado ao modelo e limpeza da resposta. Puro (sem Electron). A chamada fica em
// src/main/agent/autoTitle.ts e a ligação com banco/eventos em src/main/autoTitle.ts.
// Ver SPEC.md → "Título automático".
import { DEFAULT_AUTO_TITLE_PROMPT } from './defaults'
import { normalizeThinkingTokens } from './sideReasoning'
import type { Usage } from './types'

/** Chave em `settings` (sincroniza: registro `setting autoTitle`, protocolo 1.4.0, §4.3.2). */
export const AUTO_TITLE_SETTING = 'autoTitle'

export interface AutoTitleSettings {
  /** Par do modelo do título; sem os dois = "Nenhum" (o título fica o começo da 1ª mensagem). */
  providerId: string | null
  model: string | null
  /** Inclui um índice compacto das memórias ativas do chat (nada se a memória estiver desligada nele). */
  useMemory: boolean
  /** `max_tokens` da chamada (só vai onde o modelo/provedor aceita). */
  maxTokens: number
  /** System prompt da chamada; null = DEFAULT_AUTO_TITLE_PROMPT. */
  prompt: string | null
  /**
   * "Tokens de pensamento" (0.8.8): só em modelo de raciocínio obrigatório (@shared/sideReasoning),
   * somados ao `max_tokens`. Ausente/null = o padrão (SIDE_THINKING.title).
   */
  thinkingTokens?: number | null
}

export const AUTO_TITLE_DEFAULTS = {
  maxTokens: 64,
  minMaxTokens: 8,
  maxMaxTokens: 1024,
  /** Teto do título final (caracteres). */
  maxTitleChars: 60,
  /** Teto da 1ª mensagem enviada (o começo dela). */
  messageChars: 2000,
  /** Anexos: só os nomes, no máx. N, cada um cortado. */
  attachmentNames: 10,
  attachmentNameChars: 80,
  /** Teto do índice de memórias enviado. */
  memoryChars: 1500,
  /** Tempo máximo da chamada. */
  timeoutMs: 30_000
} as const

/** Registro da geração na meta da mensagem de origem (custo e modelo; nunca vai à API). */
export interface AutoTitleRecord {
  /** Título limpo que o modelo deu. */
  title: string
  /** false = não substituiu (o chat foi renomeado antes de a resposta chegar). */
  applied: boolean
  trigger: 'auto' | 'manual'
  providerId: string
  model: string
  usage?: Usage
  durationMs: number
  at: number
}

export function defaultAutoTitleSettings(): AutoTitleSettings {
  return {
    providerId: null,
    model: null,
    useMemory: false,
    maxTokens: AUTO_TITLE_DEFAULTS.maxTokens,
    prompt: null
  }
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null)

/** Completa/limpa qualquer valor salvo (ausente/inválido = padrão: sem modelo). */
export function normalizeAutoTitleSettings(v: unknown): AutoTitleSettings {
  const d = defaultAutoTitleSettings()
  if (!v || typeof v !== 'object') return d
  const o = v as Record<string, unknown>
  const providerId = str(o.providerId)
  const model = str(o.model)
  const n = typeof o.maxTokens === 'number' && Number.isFinite(o.maxTokens) ? o.maxTokens : NaN
  const thinkingTokens = normalizeThinkingTokens(o.thinkingTokens)
  return {
    // par: um sem o outro não vale
    providerId: providerId && model ? providerId : null,
    model: providerId && model ? model : null,
    useMemory: o.useMemory === true,
    maxTokens: Number.isNaN(n)
      ? d.maxTokens
      : Math.min(
          AUTO_TITLE_DEFAULTS.maxMaxTokens,
          Math.max(AUTO_TITLE_DEFAULTS.minMaxTokens, Math.round(n))
        ),
    prompt: typeof o.prompt === 'string' && o.prompt.trim() ? o.prompt : null,
    ...(thinkingTokens != null ? { thinkingTokens } : {})
  }
}

/** Há modelo escolhido (senão nenhuma chamada é feita). */
export const autoTitleEnabled = (s: AutoTitleSettings): boolean => !!(s.providerId && s.model)

// ---------------- prompt ----------------

/** Cabeçalho do índice compacto de memórias (renderIndex no main). */
export const AUTO_TITLE_MEMORY_HEADER =
  'Memórias do usuário (contexto). Formato: id · título — resumo.'

/** Corta `text` em `max` caracteres (com marca), sem quebrar no meio de um par surrogate. */
export function boundText(text: string, max: number, mark = '…'): string {
  if (text.length <= max) return text
  let cut = max - mark.length
  const c = text.charCodeAt(cut - 1)
  if (c >= 0xd800 && c <= 0xdbff) cut--
  return text.slice(0, Math.max(0, cut)).trimEnd() + mark
}

export interface AutoTitleInput {
  /** Texto digitado da 1ª mensagem (sem anexos). */
  text: string
  /** Nomes dos anexos/skills (nunca o conteúdo). */
  attachments?: string[]
  /** Índice compacto das memórias (já renderizado); null/vazio = sem memória. */
  memory?: string | null
}

/** Mensagem `user` da chamada: memórias (se houver) → anexos → a mensagem → instrução final. */
export function autoTitleUserContent(input: AutoTitleInput): string {
  const D = AUTO_TITLE_DEFAULTS
  const parts: string[] = []
  const memory = input.memory?.trim()
  if (memory)
    parts.push(
      `Contexto sobre o usuário (use só se ajudar a nomear o assunto):\n${boundText(memory, D.memoryChars, '\n[…]')}`
    )
  const names = (input.attachments ?? []).map((n) => n.replace(/\s+/g, ' ').trim()).filter(Boolean)
  if (names.length) {
    const shown = names.slice(0, D.attachmentNames).map((n) => boundText(n, D.attachmentNameChars))
    const more = names.length - shown.length
    parts.push(
      `Anexos (só os nomes): ${shown.join(', ')}${more > 0 ? ` (+${more} outro${more > 1 ? 's' : ''})` : ''}`
    )
  }
  const text = input.text.trim()
  parts.push(
    `Primeira mensagem do usuário:\n<message>\n${
      text ? boundText(text, D.messageChars, '\n[… mensagem cortada]') : '(sem texto — só anexos)'
    }\n</message>`
  )
  parts.push('Responda só com o título.')
  return parts.join('\n\n')
}

/** Mensagens da chamada: system = prompt (ou o padrão) + user com a 1ª mensagem. */
export function buildAutoTitleMessages(
  prompt: string | null,
  input: AutoTitleInput
): { role: 'system' | 'user'; content: string }[] {
  return [
    { role: 'system', content: prompt?.trim() ? prompt : DEFAULT_AUTO_TITLE_PROMPT },
    { role: 'user', content: autoTitleUserContent(input) }
  ]
}

// ---------------- limpeza da resposta ----------------

const QUOTES = `"'\`“”‘’«»„‚‹›「」『』`
const QUOTE_RE = new RegExp(`^[${QUOTES}\\s]+|[${QUOTES}\\s]+$`, 'g')

/** Títulos que não dizem nada (comparados sem caixa/acento/pontuação) → mantém o provisório. */
const GENERIC = new Set([
  'nova conversa',
  'novo chat',
  'conversa',
  'chat',
  'sem titulo',
  'titulo',
  'pergunta',
  'ajuda',
  'ola',
  'oi',
  'new chat',
  'new conversation',
  'conversation',
  'untitled',
  'title',
  'question',
  'help',
  'hello',
  'nueva conversacion'
])

const plain = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()

/** Linha candidata → sem marcadores de lista/título, rótulo "Título:", markdown, emoji e aspas. */
function cleanLine(line: string): string {
  let s = line.trim()
  for (let i = 0; i < 4; i++) {
    const before = s
    s = s
      .replace(/^(#{1,6}\s+|[-*+•]\s+|>\s*|\d+[.)]\s+)/, '')
      .replace(/^\**\s*(t[íi]tulo|title|nome)\s*\**\s*[:：—–-]\s*/i, '')
      .replace(/[*`~]+/g, '')
      .replace(/(^|\s)_+|_+(?=\s|$)/g, '$1')
      .replace(/\p{Extended_Pictographic}|[\u{1F1E6}-\u{1F1FF}]|\uFE0F|\u200D|\u20E3/gu, '')
      .replace(QUOTE_RE, '')
      .replace(/[.。:;,]+$/u, '')
      .trim()
    if (s === before) break
  }
  return s.replace(/\s+/g, ' ')
}

/**
 * Resposta crua do modelo → título: sem `<think>`, 1ª linha útil, sem aspas/markdown/emoji/ponto
 * final, espaços colapsados, até `maxTitleChars` (corta na palavra + "…"). Vazio ou genérico → ''
 * (quem chama mantém o título provisório).
 */
export function sanitizeTitle(
  raw: string,
  max: number = AUTO_TITLE_DEFAULTS.maxTitleChars
): string {
  const text = String(raw ?? '')
    .replace(/<think>[\s\S]*?(<\/think>|$)/gi, '')
    .replace(/<\/?[a-z][\w-]*>/gi, ' ')
  let title = ''
  for (const line of text.split(/\r?\n/)) {
    title = cleanLine(line)
    if (title) break
  }
  if (!title || GENERIC.has(plain(title)) || !/[\p{L}\p{N}]/u.test(title)) return ''
  if (title.length > max) {
    let cut = title.slice(0, max - 1)
    const sp = cut.lastIndexOf(' ')
    if (sp >= max / 2) cut = cut.slice(0, sp)
    title = cut.replace(/[\s.,;:—–-]+$/u, '') + '…'
  }
  return title
}
