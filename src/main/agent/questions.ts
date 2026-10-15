// Questionários pendentes (tool ask_user) — memória, análogo a approvals.ts. Resolve com as
// respostas do usuário ou 'cancel' (Esc / Parar / ⚡ / abort do signal).
import { randomUUID } from 'crypto'
import type { QuestionAnswer, QuestionRequest } from '@shared/types'
import { validateAnswers } from '@shared/askUser'
import { emit } from '../events'

export type QuestionOutcome = { kind: 'answered'; answers: QuestionAnswer[] } | { kind: 'cancel' }

interface Pending {
  request: QuestionRequest
  resolve: (o: QuestionOutcome) => void
}

const pending = new Map<string, Pending>()

export function requestQuestion(
  input: Omit<QuestionRequest, 'id' | 'createdAt'>,
  signal: AbortSignal
): Promise<QuestionOutcome> {
  const request: QuestionRequest = { ...input, id: randomUUID(), createdAt: Date.now() }
  if (signal.aborted) return Promise.resolve({ kind: 'cancel' })
  return new Promise<QuestionOutcome>((resolve) => {
    const onAbort = (): void => {
      settle(request.id, { kind: 'cancel' })
    }
    pending.set(request.id, {
      request,
      resolve: (o) => {
        signal.removeEventListener('abort', onAbort)
        resolve(o)
      }
    })
    signal.addEventListener('abort', onAbort, { once: true })
    emit({ type: 'question-requested', request })
  })
}

function settle(id: string, outcome: QuestionOutcome): boolean {
  const p = pending.get(id)
  if (!p) return false
  pending.delete(id)
  emit({ type: 'question-resolved', id })
  p.resolve(outcome)
  return true
}

export function getQuestion(id: string): QuestionRequest | null {
  return pending.get(id)?.request ?? null
}

/** Respostas do usuário (validadas contra as perguntas; erro legível se incompletas). */
export function answerQuestion(id: string, answers: unknown): void {
  const p = pending.get(id)
  if (!p) throw new Error('Este questionário não está mais pendente.')
  const v = validateAnswers(p.request.questions, answers)
  if ('error' in v) throw new Error(v.error)
  settle(id, { kind: 'answered', answers: v.answers })
}

export function cancelQuestion(id: string): boolean {
  return settle(id, { kind: 'cancel' })
}

export function listQuestions(): QuestionRequest[] {
  return [...pending.values()].map((p) => p.request).sort((a, b) => a.createdAt - b.createdAt)
}
