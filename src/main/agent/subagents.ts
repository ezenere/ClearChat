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

/** `a` e `b` são irmãos (sessões diferentes com o mesmo agente pai)? */
export function areSiblings(
  a: Pick<Session, 'id' | 'parentSessionId'>,
  b: Pick<Session, 'id' | 'parentSessionId'>
): boolean {
  return a.id !== b.id && !!a.parentSessionId && a.parentSessionId === b.parentSessionId
}

/**
 * Alvo de message_subagent: descendente da sessão chamadora (como resolveSubagentRef) OU irmão
 * dela (mesmo agente pai). 'not-owned' para qualquer outra sessão (pai, primo, sobrinho, a própria).
 */
export function resolveMessageTarget<T extends Pick<Session, 'id' | 'parentSessionId'>>(
  sessions: T[],
  callerId: string,
  ref: string
): { target: T; relation: 'descendant' | 'sibling' } | 'ambiguous' | 'not-owned' | null {
  const r = ref.trim().toLowerCase()
  if (!r) return null
  let found = sessions.filter((s) => s.id === r)
  if (!found.length && r.length >= 4) found = sessions.filter((s) => s.id.startsWith(r))
  if (!found.length) return null
  const caller = sessions.find((s) => s.id === callerId)
  const owned: { target: T; relation: 'descendant' | 'sibling' }[] = []
  for (const s of found) {
    if (isDescendant(sessions, callerId, s.id)) owned.push({ target: s, relation: 'descendant' })
    else if (caller && areSiblings(caller, s)) owned.push({ target: s, relation: 'sibling' })
  }
  if (!owned.length) return 'not-owned'
  return owned.length === 1 ? owned[0] : 'ambiguous'
}

// ---------------- anti pingue-pongue entre irmãos ----------------

/** Chave do par (sem ordem): as duas direções dividem a mesma janela. */
export function siblingPairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`
}

/**
 * Janela deslizante em memória (por chave). `now` é injetável (testes). Ids de sessão são UUIDs,
 * então a chave do par já é única entre chats.
 */
export class SlidingWindowLimiter {
  private hits = new Map<string, number[]>()
  /** Relógio (ms) — trocado nos testes. */
  now: () => number

  constructor(now: () => number = Date.now) {
    this.now = now
  }

  /** Tenta consumir uma vaga de `key`: 0 = consumida; senão, segundos até liberar (≥ 1). */
  take(key: string, max: number, windowMs: number): number {
    const t = this.now()
    if (this.hits.size > 500) this.prune(t, windowMs)
    const list = (this.hits.get(key) ?? []).filter((x) => t - x < windowMs)
    if (list.length >= max) {
      this.hits.set(key, list)
      return Math.max(1, Math.ceil((list[0] + windowMs - t) / 1000))
    }
    list.push(t)
    this.hits.set(key, list)
    return 0
  }

  clear(): void {
    this.hits.clear()
  }

  private prune(t: number, windowMs: number): void {
    for (const [k, v] of this.hits) if (!v.some((x) => t - x < windowMs)) this.hits.delete(k)
  }
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
  awaiting_retry: 'aguardando decisão do usuário (falha de conexão)',
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

// ---------------- irmãos (check_subagents num subagente / messages=true) ----------------

export interface SiblingRow {
  id: string
  title: string
  status: SessionStatus
}

/** Seção "Irmãos" do check_subagents chamado por um subagente. */
export function formatSiblingList(rows: SiblingRow[]): string {
  if (!rows.length) return '[Irmãos: nenhum — você é o único subagente do seu agente pai]'
  const lines = rows.map((r) =>
    [
      r.id,
      `"${r.title.replace(/\s+/g, ' ').trim() || 'Subagente'}"`,
      STATUS_LABEL[r.status] ?? r.status
    ].join(' · ')
  )
  return `[Irmãos (mesmo agente pai): ${fmtNum(rows.length)} — fale com eles por message_subagent (id) ou broadcast=true; máx. ${LIMITS.siblingMaxPerWindow} mensagens por minuto por par, sem wait_for_reply]\n${lines.join('\n')}`
}

export interface SiblingExchange {
  at: number
  from: { id: string; title: string }
  /** Destinatários (1 na mensagem direta; N no broadcast). */
  to: { id: string; title: string }[]
  broadcast: boolean
  text: string
  /** Ainda na fila do destinatário (não persistida). */
  queued?: boolean
}

const shortId = (id: string): string => id.slice(0, 8)
const who = (s: { id: string; title: string }): string =>
  `"${s.title.replace(/\s+/g, ' ').trim() || 'Subagente'}" (${shortId(s.id)})`

/** Hora local HH:MM:SS. */
export function fmtClock(ts: number): string {
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/**
 * Mensagens trocadas entre os subagentes (irmãos entre si) de uma sessão, em ordem cronológica:
 * as mais recentes que cabem em `maxChars` / LIMITS.siblingListMax, cada texto cortado.
 */
export function formatSiblingExchanges(
  items: SiblingExchange[],
  chatId: string,
  maxChars: number = LIMITS.maxToolOutputChars
): string {
  if (!items.length) return '[nenhuma mensagem trocada entre os seus subagentes]'
  const sorted = [...items].sort((a, b) => a.at - b.at)
  const lines: string[] = []
  let total = 0
  const budget = Math.max(500, maxChars - 400)
  for (let i = sorted.length - 1; i >= 0 && lines.length < LIMITS.siblingListMax; i--) {
    const it = sorted[i]
    const body = it.text.replace(/\s+/g, ' ').trim()
    const cut =
      body.length > LIMITS.siblingListMsgChars
        ? `${body.slice(0, LIMITS.siblingListMsgChars)}… (${fmtNum(body.length)} caracteres)`
        : body
    const dest = it.broadcast
      ? `broadcast a ${fmtNum(it.to.length)} ${it.to.length === 1 ? 'irmão' : 'irmãos'} (${it.to.map(who).join(', ')})`
      : it.to.map(who).join(', ')
    const line = `${fmtClock(it.at)} · ${who(it.from)} → ${dest}${it.queued ? ' [na fila]' : ''}: ${cut}`
    if (lines.length && total + line.length + 1 > budget) break
    lines.push(line)
    total += line.length + 1
  }
  lines.reverse()
  const head =
    lines.length < sorted.length
      ? `[${fmtNum(sorted.length)} mensagens entre os seus subagentes; mostrando as ${fmtNum(lines.length)} mais recentes]`
      : `[${fmtNum(sorted.length)} ${sorted.length === 1 ? 'mensagem' : 'mensagens'} entre os seus subagentes]`
  return `${head}\n${lines.join('\n')}\n[texto inteiro: read_history com chat_id "${chatId}" e session_id do destinatário (as mensagens ficam na subsessão de quem recebeu), ou abra a subsessão]`
}
