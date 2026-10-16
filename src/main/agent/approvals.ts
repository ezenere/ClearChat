// Aprovações pendentes (memória). Resolve com 'allow' | 'deny' | 'cancel' (abort) ou 'reeval'
// (as listas globais mudaram enquanto o card estava aberto: o runner reavalia a chamada).
// `items` = decisões por sub-comando do card do modo Listas (ver approvalPolicy.ts).
import { randomUUID } from 'crypto'
import type { ApprovalItemDecision } from '@shared/approvalPolicy'
import type { ApprovalRequest } from '@shared/types'
import { emit } from '../events'

export interface ApprovalOutcome {
  kind: 'allow' | 'deny' | 'cancel' | 'reeval'
  items?: ApprovalItemDecision[]
}

interface Pending {
  request: ApprovalRequest
  resolve: (o: ApprovalOutcome) => void
}

const pending = new Map<string, Pending>()

export function requestApproval(
  input: Omit<ApprovalRequest, 'id' | 'createdAt'>,
  signal: AbortSignal
): Promise<ApprovalOutcome> {
  const request: ApprovalRequest = { ...input, id: randomUUID(), createdAt: Date.now() }
  if (signal.aborted) return Promise.resolve({ kind: 'cancel' })
  return new Promise<ApprovalOutcome>((resolve) => {
    const onAbort = (): void => {
      resolveApproval(request.id, { kind: 'cancel' })
    }
    pending.set(request.id, {
      request,
      resolve: (o) => {
        signal.removeEventListener('abort', onAbort)
        resolve(o)
      }
    })
    signal.addEventListener('abort', onAbort, { once: true })
    emit({ type: 'approval-requested', request })
  })
}

export function getApproval(id: string): ApprovalRequest | null {
  return pending.get(id)?.request ?? null
}

export function resolveApproval(id: string, outcome: ApprovalOutcome): boolean {
  const p = pending.get(id)
  if (!p) return false
  pending.delete(id)
  emit({ type: 'approval-resolved', id })
  p.resolve(outcome)
  return true
}

export function listApprovals(): ApprovalRequest[] {
  return [...pending.values()].map((p) => p.request).sort((a, b) => a.createdAt - b.createdAt)
}
