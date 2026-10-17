// Mensagens entre chats (send_to_chat) — partes puras compartilhadas por main (runner/tools) e
// renderer (bolha "De: <chat>"). Testadas em e2e/unit.test.ts.
import type { StoredMessage } from './types'
import { LIMITS } from './limits'
import { isDisplayOnly } from './context'

/**
 * Cabeçalho da mensagem entregue ao chat de destino (primeira linha do `content` persistido).
 * O modelo de destino sabe de onde veio e, conforme o modo, como responder.
 */
export function interChatHeader(
  fromTitle: string,
  fromChatId: string,
  opts: { waitForReply?: boolean; canReply?: boolean } = {}
): string {
  const title = (fromTitle || 'Novo chat').replace(/\s+/g, ' ').trim()
  const hint = opts.waitForReply
    ? ' — o remetente aguarda: sua resposta final neste turno será devolvida a ele automaticamente'
    : opts.canReply
      ? ` — se precisar responder, use send_to_chat com chat_id "${fromChatId}"`
      : ''
  return `[Mensagem do chat "${title}" (id ${fromChatId})${hint}]`
}

/** Conteúdo exato persistido: cabeçalho + quebra de linha + mensagem. */
export function interChatText(header: string, message: string): string {
  return `${header}\n${message}`
}

const HEADER_RE = /^\[Mensagem do chat "[^\n]*" \(id [^\s)]+\)[^\n]*\]\n/

/** Separa cabeçalho e corpo (para exibição). Sem cabeçalho reconhecível → header ''. */
export function splitInterChatText(text: string): { header: string; body: string } {
  const m = HEADER_RE.exec(text)
  if (!m) return { header: '', body: text }
  return { header: m[0].slice(0, -1), body: text.slice(m[0].length) }
}

/**
 * Saltos da cadeia que originou o turno atual da sessão: a última mensagem do usuário (não
 * sintética, fora fronteiras/erros) é inter-chat? → o número de saltos dela; senão 0 (humano).
 * Uma mensagem enviada a partir deste turno terá `currentInterChatHops + 1` saltos.
 */
export function currentInterChatHops(history: StoredMessage[]): number {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]
    if (m.message.role !== 'user') continue
    if (m.meta.kind === 'compaction' || isDisplayOnly(m.meta) || m.meta.synthetic) continue
    if (m.meta.kind !== 'inter-chat') return 0
    const h = m.meta.interChatHops
    return typeof h === 'number' && h > 0 ? h : 1
  }
  return 0
}

/** Saltos da próxima mensagem e se ela é permitida (≤ LIMITS.interChatMaxHops). */
export function nextInterChatHops(history: StoredMessage[]): { hops: number; allowed: boolean } {
  const hops = currentInterChatHops(history) + 1
  return { hops, allowed: hops <= LIMITS.interChatMaxHops }
}

export interface WaitEdge {
  /** Chat que está aguardando a resposta. */
  from: string
  /** Chat cujo turno está sendo aguardado. */
  to: string
}

/**
 * `from` passar a aguardar `to` fecharia um ciclo de espera? (já existe um caminho to → … → from
 * entre as esperas em andamento — ex.: A aguarda B e B tenta aguardar A).
 */
export function wouldCreateWaitCycle(
  edges: readonly WaitEdge[],
  from: string,
  to: string
): boolean {
  if (from === to) return true
  const seen = new Set<string>([to])
  const stack = [to]
  while (stack.length) {
    const cur = stack.pop()!
    for (const e of edges) {
      if (e.from !== cur || seen.has(e.to)) continue
      if (e.to === from) return true
      seen.add(e.to)
      stack.push(e.to)
    }
  }
  return false
}
