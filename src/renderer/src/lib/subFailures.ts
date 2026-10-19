// Falhas de subagentes (vermelho na sidebar / aviso acima do composer). Ver SPEC.md → "Subagente
// que falhou". Funções puras: o store só aplica o resultado.
import type { Session } from '@shared/types'

/**
 * Subagente que terminou em erro (status `error`), detectado pela transição em `session-updated`.
 * Só em memória (não sobrevive a reiniciar o app). `seen`: o chat foi aberto depois da falha (o
 * vermelho da sidebar some); `dismissed`: o aviso acima do composer foi dispensado / visto.
 */
export interface SubFailure {
  chatId: string
  sessionId: string
  title: string
  error?: string
  at: number
  seen: boolean
  dismissed: boolean
}

export type FailureView = { kind: 'new' } | { kind: 'chat'; chatId: string; sessionId: string }

/**
 * Subsessão PASSOU para `error` (transição vista nesta execução) → registra a falha; voltou a
 * rodar/concluiu → some. `prev` = a sessão como estava no store antes do evento.
 *
 * Sem `prev` (primeira vez que a sessão aparece no store: download do sync num PC novo, registro
 * de um chat ainda não aberto vindo de outro aparelho, snapshot do host) não há transição: o
 * `error` é o status gravado de uma falha antiga — já vista/dispensada no aparelho onde aconteceu
 * (as falhas são só em memória e não sincronizam) — e não vira pendência. Falhas ao vivo sempre
 * têm `prev`: a subsessão nasce `running` (`session-created`, local ou espelhado do host).
 */
export function trackFailure(
  list: Record<string, SubFailure>,
  prev: Session | undefined,
  session: Session,
  view: FailureView,
  error?: string
): Record<string, SubFailure> {
  if (session.depth === 0 || prev?.status === session.status) return list
  const cur = list[session.id]
  if (session.status === 'error') {
    if (cur || !prev) return list
    const open = view.kind === 'chat' && view.chatId === session.chatId
    const viewing = open && view.kind === 'chat' && view.sessionId === session.id
    return {
      ...list,
      [session.id]: {
        chatId: session.chatId,
        sessionId: session.id,
        title: session.title || session.task?.slice(0, 40) || 'Subagente',
        error,
        at: Date.now(),
        seen: open,
        dismissed: viewing
      }
    }
  }
  if (!cur) return list
  const next = { ...list }
  delete next[session.id]
  return next
}
