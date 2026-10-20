// Mensagens entre subagentes irmãos (message_subagent com um irmão como alvo, ou broadcast=true) —
// textos compartilhados por main (runner) e renderer (bolha "Mensagem do irmão …"). Testadas em
// e2e/unit.test.ts. Irmãos = subsessões com o mesmo agente pai (ver SPEC → Subagentes).
import type { MessageMeta } from './types'

export type SiblingKind = 'sibling-message' | 'sibling-broadcast'

export function isSiblingKind(kind: MessageMeta['kind'] | undefined): kind is SiblingKind {
  return kind === 'sibling-message' || kind === 'sibling-broadcast'
}

const cleanTitle = (t: string): string => t.replace(/\s+/g, ' ').trim() || 'Subagente'

/** Conteúdo persistido no irmão para uma mensagem direta: cabeçalho + quebra de linha + texto. */
export function siblingMessageText(fromTitle: string, fromId: string, message: string): string {
  return `[Mensagem do subagente irmão "${cleanTitle(fromTitle)}" (${fromId})]\n${message}`
}

/** Conteúdo persistido em cada irmão para um broadcast (só quem for o destinatário responde). */
export function siblingBroadcastText(fromTitle: string, fromId: string, message: string): string {
  return `[Broadcast do subagente irmão "${cleanTitle(fromTitle)}" (${fromId}) — responda diretamente (message_subagent para ${fromId}) só se isto for com você; caso contrário ignore e siga sua tarefa]\n${message}`
}

const HEADER_RE = /^\[(?:Mensagem|Broadcast) do subagente irmão "[^\n]*" \([^\s)]+\)[^\n]*\]\n/
const TITLE_RE = /^\[(?:Mensagem|Broadcast) do subagente irmão "([^\n]*)" \(/

/** Separa cabeçalho e corpo (exibição / listagem). Sem cabeçalho reconhecível → header ''. */
export function splitSiblingText(text: string): { header: string; body: string; title: string } {
  const m = HEADER_RE.exec(text)
  if (!m) return { header: '', body: text, title: '' }
  return {
    header: m[0].slice(0, -1),
    body: text.slice(m[0].length),
    title: TITLE_RE.exec(m[0])?.[1] ?? ''
  }
}
