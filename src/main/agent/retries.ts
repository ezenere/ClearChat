// Falhas de conexão pendentes (card "Falha de conexão com o provedor") — memória, análogo a
// questions.ts / approvals.ts. Resolve com 'retry' (Tentar de novo) ou 'cancel' (Cancelar, Parar,
// ⚡ ou abort do signal). Ver SPEC.md → "Falha de conexão (nova tentativa)".
import { randomUUID } from 'crypto'
import type { RetryRequest } from '@shared/types'
import { emit } from '../events'

export type RetryOutcome = 'retry' | 'cancel'

interface Pending {
  request: RetryRequest
  resolve: (o: RetryOutcome) => void
}

const pending = new Map<string, Pending>()

export function requestRetry(
  input: Omit<RetryRequest, 'id' | 'createdAt'>,
  signal: AbortSignal
): Promise<RetryOutcome> {
  const request: RetryRequest = { ...input, id: randomUUID(), createdAt: Date.now() }
  if (signal.aborted) return Promise.resolve('cancel')
  return new Promise<RetryOutcome>((resolve) => {
    const onAbort = (): void => {
      resolveRetry(request.id, 'cancel')
    }
    pending.set(request.id, {
      request,
      resolve: (o) => {
        signal.removeEventListener('abort', onAbort)
        resolve(o)
      }
    })
    signal.addEventListener('abort', onAbort, { once: true })
    emit({ type: 'retry-requested', request })
  })
}

export function resolveRetry(id: string, outcome: RetryOutcome): boolean {
  const p = pending.get(id)
  if (!p) return false
  pending.delete(id)
  emit({ type: 'retry-resolved', id })
  p.resolve(outcome)
  return true
}

export function getRetry(id: string): RetryRequest | null {
  return pending.get(id)?.request ?? null
}

export function retryForSession(sessionId: string): RetryRequest | null {
  for (const p of pending.values()) if (p.request.sessionId === sessionId) return p.request
  return null
}

export function listRetries(): RetryRequest[] {
  return [...pending.values()].map((p) => p.request).sort((a, b) => a.createdAt - b.createdAt)
}

/**
 * Faz a chamada ao modelo; em falha de REDE (`isNetwork`) descarta o parcial (`onDiscard`) e espera a
 * decisão do usuário (`ask`): 'retry' repete a chamada do zero (`attempt` reconstrói a request a
 * partir do histórico), 'cancel' devolve o erro original (turno termina como erro, como antes).
 * Abort (Parar/⚡) durante a chamada ou o card → 'aborted'. Outros erros → 'error' direto.
 */
export async function callWithNetworkRetry<T>(p: {
  signal: AbortSignal
  attempt: () => Promise<T>
  isNetwork: (e: unknown) => boolean
  onDiscard?: () => void
  ask: (error: unknown) => Promise<RetryOutcome>
}): Promise<
  | { kind: 'ok'; value: T }
  | { kind: 'error'; error: unknown; network?: boolean; abortedInCard?: boolean }
  | { kind: 'aborted' }
> {
  for (;;) {
    try {
      return { kind: 'ok', value: await p.attempt() }
    } catch (e) {
      if (p.signal.aborted) return { kind: 'aborted' }
      if (!p.isNetwork(e)) return { kind: 'error', error: e }
      p.onDiscard?.()
      const d = await p.ask(e)
      // Parar/⚡ com o card aberto = Cancelar (o chamador decide: erro, ou injeta a mensagem forçada)
      if (p.signal.aborted) return { kind: 'error', error: e, network: true, abortedInCard: true }
      if (d === 'cancel') return { kind: 'error', error: e, network: true }
    }
  }
}
