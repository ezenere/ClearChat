// Fila de mensagens por sessão (memória). Emite `queue-updated` a cada mudança.
import { randomUUID } from 'crypto'
import type { QueuedMessage } from '@shared/types'
import { emit } from '../events'

const queues = new Map<string, QueuedMessage[]>()

const notify = (sessionId: string): void =>
  emit({ type: 'queue-updated', sessionId, queue: getQueue(sessionId) })

export function getQueue(sessionId: string): QueuedMessage[] {
  return [...(queues.get(sessionId) ?? [])]
}

export function hasQueued(sessionId: string): boolean {
  return (queues.get(sessionId)?.length ?? 0) > 0
}

export function enqueue(sessionId: string, text: string): QueuedMessage {
  const item: QueuedMessage = { id: randomUUID(), sessionId, text, createdAt: Date.now() }
  queues.set(sessionId, [...(queues.get(sessionId) ?? []), item])
  notify(sessionId)
  return item
}

/** Devolve itens para o início da fila (ex.: forçados que não chegaram a ser enviados). */
export function requeueFront(sessionId: string, items: QueuedMessage[]): void {
  if (!items.length) return
  queues.set(sessionId, [...items, ...(queues.get(sessionId) ?? [])])
  notify(sessionId)
}

/** Remove e retorna um item pelo id (de qualquer sessão). */
export function takeQueued(id: string): QueuedMessage | null {
  for (const [sid, q] of queues) {
    const i = q.findIndex((m) => m.id === id)
    if (i !== -1) {
      const [item] = q.splice(i, 1)
      if (!q.length) queues.delete(sid)
      notify(sid)
      return item
    }
  }
  return null
}

/** Remove e retorna todos os itens da sessão. */
export function drainQueue(sessionId: string): QueuedMessage[] {
  const q = queues.get(sessionId) ?? []
  if (!q.length) return []
  queues.delete(sessionId)
  notify(sessionId)
  return q
}

export function clearQueue(sessionId: string): void {
  if (queues.delete(sessionId)) notify(sessionId)
}
