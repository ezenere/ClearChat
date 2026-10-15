// Subagentes em segundo plano, callbacks e mensagens a subagentes — partes puras (sem banco nem
// loop), testadas em e2e/unit.test.ts. O runner registra cada execução de subsessão cujo resultado
// volta ao pai como callback (delegate_task com background, ou subsessão retomada por uma mensagem
// nova) e decide entrega/reivindicação com este registro.
import { LIMITS } from '@shared/limits'
import type { Session, SessionStatus } from '@shared/types'
import { delegateEmptyText, delegateFailureText } from '../tools/models'
import { fmtNum, truncateHeadTail } from '../tools/util'

export type RunOutcome =
  | { kind: 'final'; text: string }
  | { kind: 'aborted'; partial: string }
  | { kind: 'error'; error: string }
  /** O app foi fechado com a execução em andamento. */
  | { kind: 'app-closed' }

/** Uma execução de subsessão que reporta ao pai por callback. */
export interface Report {
  id: number
  sessionId: string
  parentSessionId: string
  title: string
  model: string
  /** Retomada por mensagem nova (usuário/pai/callback) depois de já ter entregado o resultado. */
  update: boolean
  startedAt: number
  finishedAt?: number
  outcome?: RunOutcome
  /** Resultado entregue por outro caminho (wait_subagents / message_subagent): sem callback. */
  claimed: boolean
  /** Subsessão apagada (regenerate/apagar mensagem): sem callback. */
  dropped: boolean
  /** Parada em cascata (pai também parado): o callback é registrado sem acordar o pai. */
  silent: boolean
  /** Callback já enviado ao pai (entregue direto ou na fila). */
  callbackSent: boolean
  /** Id do item na fila do pai, se o callback foi enfileirado (para retirar ao reivindicar). */
  callbackQueuedId?: string
}

export class ReportRegistry {
  private seq = 0
  private reports: Report[] = []

  add(
    r: Omit<Report, 'id' | 'claimed' | 'dropped' | 'silent' | 'callbackSent' | 'startedAt'> & {
      startedAt?: number
    }
  ): Report {
    const rep: Report = {
      startedAt: Date.now(),
      ...r,
      id: ++this.seq,
      claimed: false,
      dropped: false,
      silent: false,
      callbackSent: false
    }
    this.reports.push(rep)
    return rep
  }

  all(): Report[] {
    return [...this.reports]
  }

  /** Execuções ainda em andamento que vão reportar a `parentSessionId` (o pai dorme enquanto houver). */
  pending(parentSessionId: string): Report[] {
    return this.reports.filter(
      (r) => r.parentSessionId === parentSessionId && !r.outcome && !r.dropped
    )
  }

  /** Execução mais recente de uma subsessão. */
  latest(sessionId: string): Report | undefined {
    for (let i = this.reports.length - 1; i >= 0; i--)
      if (this.reports[i].sessionId === sessionId) return this.reports[i]
    return undefined
  }

  /** Execuções das subsessões de um pai, mais recente por subsessão, na ordem de criação. */
  forParent(parentSessionId: string): Report[] {
    const out = new Map<string, Report>()
    for (const r of this.reports)
      if (r.parentSessionId === parentSessionId && !r.dropped) out.set(r.sessionId, r)
    return [...out.values()]
  }

  /**
   * Marca o fim; retorna true se o callback deve ser entregue (não reivindicado nem apagado).
   * Chamado na ordem em que as execuções terminam → os callbacks entram na fila nessa ordem.
   */
  complete(r: Report, outcome: RunOutcome, now = Date.now()): boolean {
    if (r.outcome) return false
    r.outcome = outcome
    r.finishedAt = now
    return !r.claimed && !r.dropped
  }

  /** Callback enviado (direto ou enfileirado com `queuedId`). */
  sent(r: Report, queuedId?: string): void {
    r.callbackSent = true
    if (queuedId) r.callbackQueuedId = queuedId
  }

  /**
   * Reivindica o resultado (wait_subagents/message_subagent): nenhum callback novo. Retorna o item
   * da fila a retirar (se o callback já foi enfileirado) e se o callback já tinha sido enviado — se
   * foi e não está mais na fila, ele já virou mensagem no pai.
   */
  claim(r: Report): { queuedId?: string; sent: boolean } {
    r.claimed = true
    return { queuedId: r.callbackQueuedId, sent: r.callbackSent }
  }

  /** Subsessões apagadas: nenhum callback delas. */
  drop(sessionIds: Iterable<string>): void {
    const set = new Set(sessionIds)
    for (const r of this.reports) if (set.has(r.sessionId)) r.dropped = true
    this.reports = this.reports.filter((r) => !(r.dropped && r.outcome))
  }

  /** Esquece execuções terminadas e já resolvidas (higiene de memória). */
  prune(keepPerParent = 200): void {
    const counts = new Map<string, number>()
    for (let i = this.reports.length - 1; i >= 0; i--) {
      const r = this.reports[i]
      const n = (counts.get(r.parentSessionId) ?? 0) + 1
      counts.set(r.parentSessionId, n)
      if (n > keepPerParent && r.outcome) this.reports.splice(i, 1)
    }
  }
}

/** Cabeçalho do callback (primeira linha). */
export function callbackHeader(
  title: string,
  sessionId: string,
  outcome: RunOutcome,
  update: boolean
): string {
  const who = `Subagente "${title.replace(/\s+/g, ' ').trim() || 'Subagente'}" (id ${sessionId})`
  if (outcome.kind === 'final')
    return update ? `[${who} — atualização após nova mensagem]` : `[${who} concluiu]`
  if (outcome.kind === 'error') return `[${who} falhou]`
  if (outcome.kind === 'aborted') return `[${who} foi cancelado]`
  return `[${who} não concluiu]`
}

/** Texto exato do callback (mensagem `role: user` sintética no pai). */
export function callbackText(
  r: Pick<Report, 'title' | 'sessionId' | 'model' | 'update'>,
  outcome: RunOutcome,
  maxChars: number = LIMITS.maxToolOutputChars
): string {
  const header = callbackHeader(r.title, r.sessionId, outcome, r.update)
  let body: string
  if (outcome.kind === 'final') body = outcome.text.trim() || delegateEmptyText(r.model)
  else if (outcome.kind === 'error') body = delegateFailureText(r.model, outcome.error)
  else if (outcome.kind === 'aborted')
    body = outcome.partial.trim() ? `Resposta parcial:\n${outcome.partial.trim()}` : ''
  else body = '(interrompido: o app foi fechado)'
  const text = body ? `${header}\n${body}` : header
  return truncateHeadTail(text, maxChars, 0.5)
}

export const PARENT_MESSAGE_HEADER = '[Mensagem do agente pai]'

/** Conteúdo persistido no subagente para message_subagent. */
export function parentMessageText(message: string): string {
  return `${PARENT_MESSAGE_HEADER}\n${message}`
}

/** `id` é descendente (filho, neto…) de `ancestorId`? */
export function isDescendant(
  sessions: Pick<Session, 'id' | 'parentSessionId'>[],
  ancestorId: string,
  id: string
): boolean {
  const byId = new Map(sessions.map((s) => [s.id, s]))
  let cur = byId.get(id)
  const seen = new Set<string>()
  while (cur?.parentSessionId && !seen.has(cur.id)) {
    seen.add(cur.id)
    if (cur.parentSessionId === ancestorId) return true
    cur = byId.get(cur.parentSessionId)
  }
  return false
}

/**
 * Resolve o id (ou prefixo único ≥ 4) de um subagente da sessão chamadora. Só aceita descendentes
 * dela: 'not-owned' para sessões de outro ramo (ou a própria), null se não existir.
 */
export function resolveSubagentRef<T extends Pick<Session, 'id' | 'parentSessionId'>>(
  sessions: T[],
  callerId: string,
  ref: string
): T | 'ambiguous' | 'not-owned' | null {
  const r = ref.trim().toLowerCase()
  if (!r) return null
  let found = sessions.filter((s) => s.id === r)
  if (!found.length && r.length >= 4) found = sessions.filter((s) => s.id.startsWith(r))
  if (!found.length) return null
  const owned = found.filter((s) => isDescendant(sessions, callerId, s.id))
  if (!owned.length) return 'not-owned'
  return owned.length === 1 ? owned[0] : 'ambiguous'
}

/** Sessões de `rootIds` e todos os descendentes. */
export function subtreeIds(
  sessions: Pick<Session, 'id' | 'parentSessionId'>[],
  rootIds: string[]
): string[] {
  const out: string[] = []
  const visit = (id: string): void => {
    out.push(id)
    for (const c of sessions) if (c.parentSessionId === id) visit(c.id)
  }
  for (const id of rootIds) visit(id)
  return out
}

// ---------------- check_subagents ----------------

export interface SubagentRow {
  id: string
  title: string
  model: string
  status: SessionStatus
  background: boolean
  startedAt: number
  /** Fim da última execução (undefined = rodando). */
  finishedAt?: number
  /** 'delivered' entregue; 'pending' ainda vai chegar como callback; 'tool' devolvido ao chamar (bloqueante). */
  result: 'delivered' | 'pending' | 'tool' | 'none'
  tail: string
}

const STATUS_LABEL: Record<SessionStatus, string> = {
  idle: 'ocioso',
  running: 'rodando',
  awaiting_approval: 'aguardando aprovação',
  awaiting_input: 'aguardando resposta do usuário',
  waiting: 'aguardando subagentes',
  done: 'concluído',
  error: 'erro',
  interrupted: 'interrompido'
}

export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}min ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}min`
}

const RESULT_LABEL: Record<SubagentRow['result'], string> = {
  delivered: 'resultado entregue',
  pending: 'resultado ainda não entregue (chegará como mensagem)',
  tool: 'resultado devolvido no delegate_task',
  none: 'sem resultado'
}

export function formatSubagentList(rows: SubagentRow[], now = Date.now()): string {
  if (!rows.length) return '[nenhum subagente nesta sessão]'
  const running = rows.filter((r) => r.finishedAt === undefined).length
  const lines = rows.map((r) => {
    const tail = r.tail.replace(/\s+/g, ' ').trim()
    return [
      r.id,
      `"${r.title.replace(/\s+/g, ' ')}"`,
      r.model,
      STATUS_LABEL[r.status] ?? r.status,
      r.background ? 'em segundo plano' : 'bloqueante',
      `duração ${fmtDuration((r.finishedAt ?? now) - r.startedAt)}`,
      RESULT_LABEL[r.result],
      tail ? `último: "${tail.length > 160 ? `${tail.slice(0, 160)}…` : tail}"` : ''
    ]
      .filter(Boolean)
      .join(' · ')
  })
  return `[${fmtNum(rows.length)} subagentes; ${fmtNum(running)} em execução]\n${lines.join('\n')}`
}
