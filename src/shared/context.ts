// Janela de contexto, uso e fronteiras de compactação — funções puras usadas pelo main (runner /
// buildRequest) e pelo renderer (medidor de contexto, divisor "Conversa compactada").
import type { ChatConfig, MessageMeta, ModelInfo, Session, StoredMessage, Usage } from './types'
import { DEFAULT_COMPACT_THRESHOLD } from './defaults'

/**
 * Mensagens só de exibição (synthetic): erro persistido ('error'), card da extração de memórias
 * ('memory-extraction') e marcadores da chamada de voz ('voice-call'). NUNCA vão para a API nem
 * contam como resposta do assistente.
 */
export const DISPLAY_ONLY_KINDS: readonly NonNullable<MessageMeta['kind']>[] = [
  'error',
  'memory-extraction',
  'voice-call'
]
export const isDisplayOnly = (meta: MessageMeta | null | undefined): boolean =>
  !!meta?.kind && DISPLAY_ONLY_KINDS.includes(meta.kind)

/** Índice da fronteira de compactação mais recente (-1 = nenhuma). */
export function latestBoundaryIndex(history: StoredMessage[]): number {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].meta?.kind === 'compaction') return i
  }
  return -1
}

/** Mensagens que ainda vão para a API: da fronteira mais recente (inclusive) em diante. */
export function activeHistory(history: StoredMessage[]): StoredMessage[] {
  const i = latestBoundaryIndex(history)
  return i <= 0 ? history : history.slice(i)
}

export interface ContextUsage {
  /** Tokens de contexto em uso (prompt + completion da última chamada; ou estimativa pós-compactação). */
  used: number
  /** true = estimativa (logo após uma compactação, antes da próxima chamada real). */
  estimated: boolean
  usage?: Usage
}

/**
 * Contexto usado = promptTokens + completionTokens da última resposta (após a fronteira mais
 * recente). Sem resposta desde a compactação → estimativa salva na fronteira.
 */
export function contextUsage(history: StoredMessage[]): ContextUsage | null {
  const start = latestBoundaryIndex(history)
  for (let i = history.length - 1; i > start; i--) {
    const m = history[i]
    const u = m.meta?.usage
    if (u && m.message.role === 'assistant' && !isDisplayOnly(m.meta)) {
      return { used: (u.promptTokens || 0) + (u.completionTokens || 0), estimated: false, usage: u }
    }
  }
  if (start >= 0) {
    const est = history[start].meta.contextEstimate
    if (typeof est === 'number' && est > 0) return { used: est, estimated: true }
  }
  return null
}

/**
 * Janela de contexto da sessão. Principal: override do chat → contextLength do modelo.
 * Subsessões: janela do próprio modelo → override do chat.
 */
export function resolveContextWindow(
  cfg: Pick<ChatConfig, 'contextWindow'>,
  session: Pick<Session, 'depth' | 'model'>,
  models?: ModelInfo[] | null
): number | null {
  const fromModel = models?.find((m) => m.id === session.model)?.contextLength
  const override =
    typeof cfg.contextWindow === 'number' && cfg.contextWindow > 0 ? cfg.contextWindow : undefined
  const v = session.depth === 0 ? (override ?? fromModel) : (fromModel ?? override)
  return v && v > 0 ? v : null
}

export function compactThreshold(cfg: Pick<ChatConfig, 'compactThreshold'>): number {
  const t = cfg.compactThreshold
  return typeof t === 'number' && t > 0 && t <= 1 ? t : DEFAULT_COMPACT_THRESHOLD
}

/** Há algo a resumir desde a última fronteira (ao menos uma resposta do assistente)? */
export function hasCompactableHistory(history: StoredMessage[]): boolean {
  const start = latestBoundaryIndex(history)
  return history
    .slice(start + 1)
    .some((m) => m.message.role === 'assistant' && !isDisplayOnly(m.meta))
}

/** Erros de "contexto excedido" (OpenAI, OpenRouter, Anthropic, Gemini, vLLM, llama.cpp…). */
const CONTEXT_ERROR_PATTERNS = [
  /context[_ ]length[_ ]exceeded/i,
  /maximum context length/i,
  /prompt is too long/i,
  /context window/i,
  /exceeds? (?:the )?(?:model'?s? )?(?:maximum )?context/i,
  /(?:input|prompt) (?:is )?too long/i,
  /too many (?:input )?tokens/i,
  /reduce the length of the (?:messages|prompt|input)/i,
  /input token count.*exceeds/i,
  /tokens? exceeds? (?:the )?(?:max|limit)/i,
  /requested \d+ tokens/i
]

export function isContextLengthError(text: string | null | undefined): boolean {
  if (!text) return false
  if (/rate.?limit|per min(?:ute)?\b|\bTPM\b/i.test(text)) return false
  return CONTEXT_ERROR_PATTERNS.some((re) => re.test(text))
}
