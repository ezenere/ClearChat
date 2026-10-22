// Streaming ao vivo (docs/SYNC_PROTOCOL.md §11): diferenças de draft no host e aplicação no
// controle remoto. Funções puras (testáveis).
import { randomUUID } from 'node:crypto'
import type { ApiMessage, StreamDraft } from '@shared/types'

export interface DraftState extends StreamDraft {
  streamId: string
}

export interface DraftDelta {
  sessionId: string
  streamId: string
  off: { content: number; reasoning: number }
  append: { content?: string; reasoning?: string }
  toolCalls?: { index: number; id?: string; name?: string; argsAppend?: string }[]
}

/**
 * Diferença entre o último draft enviado e o atual. Se o atual não continua o anterior (nova
 * resposta do assistente), começa um `streamId` novo com off 0.
 */
export function diffDraft(
  sessionId: string,
  prev: DraftState | null,
  next: StreamDraft
): { delta: DraftDelta | null; state: DraftState } {
  const continues =
    !!prev &&
    next.content.startsWith(prev.content) &&
    next.reasoning.startsWith(prev.reasoning) &&
    prev.toolCalls.every(
      (t, i) =>
        next.toolCalls[i] &&
        next.toolCalls[i].id === t.id &&
        next.toolCalls[i].arguments.startsWith(t.arguments)
    )
  const base: DraftState = continues
    ? prev!
    : { streamId: randomUUID(), content: '', reasoning: '', toolCalls: [] }
  const delta: DraftDelta = {
    sessionId,
    streamId: base.streamId,
    off: { content: base.content.length, reasoning: base.reasoning.length },
    append: {}
  }
  if (next.content.length > base.content.length)
    delta.append.content = next.content.slice(base.content.length)
  if (next.reasoning.length > base.reasoning.length)
    delta.append.reasoning = next.reasoning.slice(base.reasoning.length)
  const tcs: NonNullable<DraftDelta['toolCalls']> = []
  next.toolCalls.forEach((t, index) => {
    const old = base.toolCalls[index]
    if (!old) tcs.push({ index, id: t.id, name: t.name, argsAppend: t.arguments })
    else if (t.arguments.length > old.arguments.length || t.name !== old.name)
      tcs.push({
        index,
        ...(t.name !== old.name ? { name: t.name } : {}),
        argsAppend: t.arguments.slice(old.arguments.length)
      })
  })
  if (tcs.length) delta.toolCalls = tcs
  const state: DraftState = {
    streamId: base.streamId,
    content: next.content,
    reasoning: next.reasoning,
    toolCalls: next.toolCalls.map((t) => ({ ...t }))
  }
  const empty = !delta.append.content && !delta.append.reasoning && !tcs.length
  return { delta: empty && continues ? null : delta, state }
}

/** Aplica um delta; 'resync' = buraco (pedir snapshot). */
export function applyDraftDelta(cur: DraftState | null, d: DraftDelta): DraftState | 'resync' {
  let base: DraftState
  if (!cur || cur.streamId !== d.streamId) {
    if (d.off.content !== 0 || d.off.reasoning !== 0) return 'resync'
    base = { streamId: d.streamId, content: '', reasoning: '', toolCalls: [] }
  } else base = cur
  if (base.content.length !== d.off.content || base.reasoning.length !== d.off.reasoning)
    return 'resync'
  const toolCalls = base.toolCalls.map((t) => ({ ...t }))
  for (const t of d.toolCalls ?? []) {
    const old = toolCalls[t.index]
    if (!old) {
      if (t.index !== toolCalls.length) return 'resync'
      toolCalls.push({ id: t.id ?? '', name: t.name ?? '', arguments: t.argsAppend ?? '' })
    } else {
      if (t.id) old.id = t.id
      if (t.name) old.name = t.name
      old.arguments += t.argsAppend ?? ''
    }
  }
  return {
    streamId: d.streamId,
    content: base.content + (d.append.content ?? ''),
    reasoning: base.reasoning + (d.append.reasoning ?? ''),
    toolCalls
  }
}

export const toStreamDraft = (d: DraftState): StreamDraft => ({
  content: d.content,
  reasoning: d.reasoning,
  toolCalls: d.toolCalls.map((t) => ({ ...t }))
})

/**
 * A mensagem `assistant` persistida é a resposta que este draft transmitia? (o texto gravado
 * continua o do draft — o último pedaço pode não ter ido pelo stream — e as tool calls batem).
 * Usado pelo controle remoto para trocar o draft encerrado pela mensagem sem buraco na tela.
 */
export function draftMatchesMessage(d: StreamDraft, m: ApiMessage): boolean {
  if (m.role !== 'assistant') return false
  if (!(m.content ?? '').startsWith(d.content)) return false
  const calls = m.tool_calls ?? []
  if (calls.length < d.toolCalls.length) return false
  return d.toolCalls.every((t, i) => !t.id || !calls[i].id || calls[i].id === t.id)
}
