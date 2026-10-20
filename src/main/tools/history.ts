// read_history: lê o histórico PERSISTIDO da sessão chamadora — inclusive as mensagens anteriores
// às fronteiras de compactação (que não vão mais para a API). Busca (query) ou faixa (from/to).
// Tudo puro sobre StoredMessage[] — testado em e2e/unit.test.ts. Outros chats (chat_id / scope
// "all"): HistoryStore (consultas + índice FTS5, ver searchIndex.ts) — e2e/historySearch.test.ts.
import { contentText, messageAttachments, toolContentText } from '@shared/attachments'
import { LIMITS } from '@shared/limits'
import { isDisplayOnly } from '@shared/context'
import type { ApiMessage, StoredMessage } from '@shared/types'
import {
  fail,
  fmtNum,
  maxOutputOf,
  ok,
  optBool,
  optNumber,
  optString,
  type ToolContext,
  type ToolResult
} from './util'
import type { HistoryStore, StoreSession } from '../historyStore'
import {
  ftsQuery,
  matchSnippet,
  queryTerms,
  searchableText,
  type SearchFilter,
  type SearchHit
} from '../searchIndex'

export interface HistoryOptions {
  query?: string
  fromSeq?: number
  toSeq?: number
  limit?: number
  includeToolResults?: boolean
}

/** Texto da mensagem; anexos viram uma linha `[anexos: a.png, b.pdf]` (os bytes não entram). */
function messageText(msg: ApiMessage): string {
  const text = contentText(msg.content)
  const atts = messageAttachments(msg)
  return atts.length
    ? `${text}${text ? '\n' : ''}[anexos: ${atts.map((a) => a.name).join(', ')}]`
    : text
}

const clampInt = (v: number | undefined, def: number, max: number): number =>
  v === undefined || !Number.isFinite(v) || v <= 0 ? def : Math.min(max, Math.max(1, Math.floor(v)))

/** Mensagens consultáveis: tudo menos erros só de exibição, em ordem de seq. */
export function historyMessages(history: StoredMessage[]): StoredMessage[] {
  return history.filter((m) => !isDisplayOnly(m.meta)).sort((a, b) => a.seq - b.seq)
}

function toolNameMap(msgs: StoredMessage[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const m of msgs)
    if (m.message.role === 'assistant')
      for (const tc of m.message.tool_calls ?? []) map.set(tc.id, tc.function.name)
  return map
}

/** Corta mantendo início (70%) e fim (30%), com marcador que diz como ler a mensagem inteira. */
export function cutMessage(text: string, max: number, seq: number): string {
  if (text.length <= max) return text
  const head = Math.floor(max * 0.7)
  const tail = Math.max(0, max - head)
  return `${text.slice(0, head)}\n[… ${fmtNum(text.length - head - tail)} caracteres omitidos — leia inteira com from_seq=${seq} to_seq=${seq}]\n${tail ? text.slice(text.length - tail) : ''}`
}

/** Rótulo + texto completo (sem cortes) de uma mensagem. */
export function describeMessage(
  m: StoredMessage,
  names: Map<string, string>,
  includeToolResults: boolean
): { label: string; text: string } {
  const msg = m.message
  switch (msg.role) {
    case 'user': {
      const text = messageText(msg)
      if (m.meta.kind === 'compaction') {
        const r = m.meta.summaryOf
        return {
          label: `user [fronteira de compactação${r ? ` · resume #${r.fromSeq}–#${r.toSeq}` : ''}]`,
          text
        }
      }
      if (m.meta.kind === 'inter-chat') return { label: 'user [de outro chat]', text }
      if (m.meta.kind === 'sibling-message' || m.meta.kind === 'sibling-broadcast')
        return { label: 'user [de subagente irmão]', text }
      return { label: m.meta.synthetic ? 'user (app)' : 'user', text }
    }
    case 'assistant': {
      const calls = (msg.tool_calls ?? []).map((tc) => {
        const a = tc.function.arguments ?? ''
        return `→ chamou ${tc.function.name}(${a.length > 300 ? `${a.slice(0, 300)}…` : a})`
      })
      const text = [msg.content ?? '', ...calls].filter(Boolean).join('\n')
      return { label: m.meta.interrupted ? 'assistant (interrompida)' : 'assistant', text }
    }
    case 'tool': {
      const name = names.get(msg.tool_call_id) ?? '?'
      const st = m.meta.toolStatus && m.meta.toolStatus !== 'ok' ? `, ${m.meta.toolStatus}` : ''
      return {
        label: `tool (${name}${st})`,
        text: includeToolResults
          ? messageText(msg) // read_file de imagem/PDF: texto + `[anexos: a.png]`
          : `[resultado omitido · ${fmtNum(toolContentText(msg.content).length)} caracteres${typeof msg.content === 'string' ? '' : ` + ${msg.content.filter((p) => p._attachment).length} anexo(s)`} — use include_tool_results=true para ver]`
      }
    }
    default:
      return { label: msg.role, text: messageText(msg) }
  }
}

/** Cabeçalho: total de mensagens e onde estão as fronteiras de compactação. */
export function historyHeader(msgs: StoredMessage[], label = 'desta sessão'): string {
  if (!msgs.length) return `[histórico ${label}: vazio]`
  const bounds = msgs.filter((m) => m.meta.kind === 'compaction')
  const base = `[histórico ${label}: ${fmtNum(msgs.length)} mensagens (#${msgs[0].seq}–#${msgs[msgs.length - 1].seq})`
  if (!bounds.length) return `${base}; sem compactações]`
  const list = bounds
    .map((b) => {
      const r = b.meta.summaryOf
      return `#${b.seq}${r ? ` (resume #${r.fromSeq}–#${r.toSeq})` : ''}`
    })
    .join(', ')
  const last = bounds[bounds.length - 1]
  if (label !== 'desta sessão') return `${base}; fronteiras de compactação: ${list}]`
  return `${base}; fronteiras de compactação: ${list} — as mensagens antes de #${last.seq} não estão mais no seu contexto]`
}

/** Modo faixa: `#seq papel: conteúdo`, respeitando `maxChars`. */
export function formatHistoryRange(
  history: StoredMessage[],
  opts: HistoryOptions,
  maxChars: number = LIMITS.maxToolOutputChars,
  label?: string
): string {
  const msgs = historyMessages(history)
  const header = historyHeader(msgs, label)
  if (!msgs.length) return header
  const limit = clampInt(opts.limit, LIMITS.historyDefaultMessages, LIMITS.historyMaxMessages)
  const { fromSeq: from, toSeq: to } = opts
  let pool: StoredMessage[]
  if (from != null) pool = msgs.filter((m) => m.seq >= from && (to == null || m.seq <= to))
  else if (to != null) {
    const upTo = msgs.filter((m) => m.seq <= to)
    pool = upTo.slice(Math.max(0, upTo.length - limit))
  } else pool = msgs
  if (!pool.length) return `${header}\n[nenhuma mensagem na faixa pedida]`
  const sel = pool.slice(0, limit)
  const names = toolNameMap(msgs)
  const single = sel.length === 1
  const perMsg = single ? Math.max(500, maxChars - header.length - 300) : LIMITS.historyMsgChars
  const lines: string[] = []
  let used = header.length + 200
  let shown = 0
  for (const m of sel) {
    const d = describeMessage(m, names, !!opts.includeToolResults || single)
    const line = `#${m.seq} ${d.label}: ${cutMessage(d.text, perMsg, m.seq)}`
    if (shown > 0 && used + line.length + 1 > maxChars) break
    lines.push(line)
    used += line.length + 1
    shown++
  }
  const last = sel[shown - 1]
  const next = msgs.find((m) => m.seq > last.seq)
  const moreInRange = shown < pool.length
  const footer = moreInRange
    ? `[mostrando #${sel[0].seq}–#${last.seq} (${shown} de ${pool.length} na faixa) — continue com from_seq=${next?.seq ?? last.seq + 1}${to != null ? ` to_seq=${to}` : ''}]`
    : next && to == null && from == null
      ? `[mostrando #${sel[0].seq}–#${last.seq}; há mais — continue com from_seq=${next.seq}]`
      : `[mostrando #${sel[0].seq}–#${last.seq}]`
  return `${header}\n${lines.join('\n')}\n${footer}`
}

/** Texto pesquisável de uma mensagem (inclui argumentos e resultados de tools; não as do read_history). */
function searchable(m: StoredMessage, names: Map<string, string>): string {
  const msg = m.message
  if (msg.role === 'assistant') {
    const calls = (msg.tool_calls ?? [])
      .filter((tc) => tc.function.name !== 'read_history')
      .map((tc) => `${tc.function.name}(${tc.function.arguments ?? ''})`)
    return [msg.content ?? '', ...calls].filter(Boolean).join('\n')
  }
  if (msg.role === 'tool') {
    // resultados do próprio read_history repetiriam trechos já encontrados
    return names.get(msg.tool_call_id) === 'read_history' ? '' : toolContentText(msg.content)
  }
  return messageText(msg)
}

function snippet(text: string, at: number, len: number): string {
  const half = Math.floor(LIMITS.historySnippetChars / 2)
  const a = Math.max(0, at - half)
  const b = Math.min(text.length, at + len + half)
  const s = text.slice(a, b).replace(/\s+/g, ' ').trim()
  return `${a > 0 ? '…' : ''}${s}${b < text.length ? '…' : ''}`
}

/** Modo busca: trechos das mensagens que contêm `query` (sem diferenciar maiúsculas). */
export function searchHistory(
  history: StoredMessage[],
  opts: HistoryOptions & { query: string },
  maxChars: number = LIMITS.maxToolOutputChars,
  label?: string
): string {
  const all = historyMessages(history)
  const header = historyHeader(all, label)
  const names = toolNameMap(all)
  const msgs = all.filter(
    (m) =>
      (opts.fromSeq == null || m.seq >= opts.fromSeq) && (opts.toSeq == null || m.seq <= opts.toSeq)
  )
  const q = opts.query.trim().toLowerCase()
  const limit = clampInt(opts.limit, LIMITS.historySearchDefault, LIMITS.historySearchMax)
  const docs = msgs.map((m) => {
    const text = searchable(m, names)
    return { m, text, lower: text.toLowerCase() }
  })
  let terms = [q]
  let hits = docs.filter((d) => d.lower.includes(q))
  // nada com a frase exata → mensagens que têm todos os termos
  if (!hits.length && /\s/.test(q)) {
    terms = q.split(/\s+/).filter(Boolean)
    hits = docs.filter((d) => terms.every((t) => d.lower.includes(t)))
  }
  if (!hits.length)
    return `${header}\n[nenhuma mensagem contém "${opts.query}" — tente outro termo ou leia uma faixa com from_seq/to_seq]`
  const lines: string[] = []
  let used = header.length + 300
  for (const d of hits.slice(0, limit)) {
    const t = terms[0]
    const first = d.lower.indexOf(t)
    const second = d.lower.indexOf(t, first + t.length + LIMITS.historySnippetChars)
    const parts = [snippet(d.text, first, t.length)]
    if (second !== -1) parts.push(snippet(d.text, second, t.length))
    const role = describeMessage(d.m, names, false).label
    const line = `#${d.m.seq} ${role}: ${parts.join(' … ')}`
    if (lines.length && used + line.length + 1 > maxChars) break
    lines.push(line)
    used += line.length + 1
  }
  const verb = hits.length === 1 ? 'contém' : 'contêm'
  const how =
    terms.length > 1 ? `${verb} todos os termos de "${opts.query}"` : `${verb} "${opts.query}"`
  const head = `[${fmtNum(hits.length)} ${hits.length === 1 ? 'mensagem' : 'mensagens'} ${how}; mostrando ${lines.length}]`
  const more =
    lines.length < hits.length ? ' Há mais resultados: refine a busca ou use from_seq/to_seq.' : ''
  return `${header}\n${head}\n${lines.join('\n')}\n[para ler uma mensagem inteira: from_seq=N to_seq=N.${more}]`
}

// ---------------- outros chats (chat_id / scope "all") ----------------

const titleOf = (t: string): string => `"${(t || 'Novo chat').replace(/\s+/g, ' ')}"`
const shortSession = (id: string): string => id.slice(0, 8)

/** Resolve id ou prefixo único (≥ 4) entre `items` (como send_to_chat). */
export function resolveRef<T extends { id: string }>(
  items: T[],
  ref: string
): T | 'ambiguous' | null {
  const r = ref.trim().toLowerCase()
  const exact = items.find((i) => i.id === r || i.id === ref.trim())
  if (exact) return exact
  if (r.length < 4) return null
  const m = items.filter((i) => i.id.toLowerCase().startsWith(r))
  return m.length === 1 ? m[0] : m.length > 1 ? 'ambiguous' : null
}

/** Rótulo de papel de um resultado (busca no índice): `user`, `tool (shell)`, … + subagente. */
function hitLine(
  store: HistoryStore,
  hit: SearchHit,
  sessions: Map<string, StoreSession>,
  terms: string[]
): string {
  const m = store.message(hit.messageId)
  const names = new Map<string, string>()
  if (m?.message.role === 'tool') {
    const n = store.toolName(m.sessionId, m.seq, m.message.tool_call_id)
    if (n) names.set(m.message.tool_call_id, n)
  }
  const role = m ? describeMessage(m, names, false).label : '?'
  const s = sessions.get(hit.sessionId)
  const sub =
    s && s.depth > 0 ? ` [subagente ${titleOf(s.title)} · session_id ${shortSession(s.id)}]` : ''
  const st = m ? searchableText(m.message, m.meta) : { body: '', tool: '' }
  const text = [st.body, st.tool].filter(Boolean).join('\n')
  return `#${hit.seq} ${role}${sub}: ${matchSnippet(text, terms, LIMITS.historySnippetChars)}`
}

/** FTS com todos os termos; sem resultado → qualquer termo (bm25 favorece quem tem mais). */
function ftsSearch(
  store: HistoryStore,
  query: string,
  f: SearchFilter
): { hits: SearchHit[]; expr: string; any: boolean } | null {
  const all = ftsQuery(query, 'all')
  if (!all) return null
  const hits = store.search(all, f)
  if (hits.length) return { hits, expr: all, any: false }
  const any = ftsQuery(query, 'any')
  if (!any || any === all) return { hits, expr: all, any: false }
  return { hits: store.search(any, f), expr: any, any: true }
}

const NO_TERMS = (q: string): string =>
  `[a busca "${q}" não tem termos pesquisáveis (letras ou números) — tente palavras do conteúdo]`

const nChats = (n: number): string => `${fmtNum(n)} ${n === 1 ? 'chat' : 'chats'}`
const nMsgs = (n: number): string => `${fmtNum(n)} ${n === 1 ? 'mensagem' : 'mensagens'}`

/** Busca/leitura num chat específico (sessão principal; busca inclui subagentes). */
export function readOtherChat(
  store: HistoryStore,
  ref: string,
  opts: HistoryOptions & { sessionRef?: string },
  maxChars: number = LIMITS.maxToolOutputChars
): { ok: boolean; text: string } {
  const chat = resolveRef(store.chats(), ref)
  if (chat === 'ambiguous')
    return {
      ok: false,
      text: `Erro: "${ref}" corresponde a mais de um chat. Use o id completo (veja list_chats).`
    }
  if (!chat)
    return {
      ok: false,
      text: `Erro: chat não encontrado: "${ref}". Use list_chats ou read_history com scope "all" para achá-lo.`
    }
  const sessions = store.sessions(chat.id)
  let session =
    sessions.find((s) => s.id === chat.mainSessionId) ?? sessions.find((s) => s.depth === 0)
  if (opts.sessionRef) {
    const s = resolveRef(sessions, opts.sessionRef)
    if (s === 'ambiguous')
      return {
        ok: false,
        text: `Erro: "${opts.sessionRef}" corresponde a mais de uma sessão do chat ${chat.id}.`
      }
    if (!s)
      return {
        ok: false,
        text: `Erro: sessão "${opts.sessionRef}" não encontrada no chat ${titleOf(chat.title)} (id ${chat.id}).`
      }
    session = s
  }
  if (!session) return { ok: false, text: `Erro: o chat ${chat.id} não tem sessão principal.` }
  const subs = sessions.filter((s) => s.depth > 0).length
  const label =
    session.depth > 0
      ? `do subagente ${titleOf(session.title)} (session_id ${shortSession(session.id)}) no chat ${titleOf(chat.title)} (id ${chat.id})`
      : `do chat ${titleOf(chat.title)} (id ${chat.id}, sessão principal${subs ? `; ${subs} subagente${subs > 1 ? 's' : ''}` : ''})`
  const q = opts.query?.trim()
  if (!q)
    return { ok: true, text: formatHistoryRange(store.messages(session.id), opts, maxChars, label) }
  // busca: índice FTS (relevância) no chat inteiro — ou só na sessão pedida / com faixa de seq
  if (!store.indexReady)
    return {
      ok: true,
      text: searchHistory(store.messages(session.id), { ...opts, query: q }, maxChars, label)
    }
  const scoped = !!opts.sessionRef || opts.fromSeq != null || opts.toSeq != null
  const limit = clampInt(opts.limit, LIMITS.historySearchDefault, LIMITS.historySearchMax)
  const filter: SearchFilter = {
    chatId: chat.id,
    sessionId: scoped ? session.id : undefined,
    fromSeq: opts.fromSeq,
    toSeq: opts.toSeq,
    limit
  }
  const r = ftsSearch(store, q, filter)
  if (!r) return { ok: true, text: NO_TERMS(q) }
  const header = `[busca no histórico ${label}]`
  if (!r.hits.length)
    return {
      ok: true,
      text: `${header}\n[nenhuma mensagem com "${q}" — tente outros termos ou leia uma faixa com from_seq/to_seq]`
    }
  const total = store.countByChat(r.expr, filter).get(chat.id) ?? r.hits.length
  const smap = new Map(sessions.map((s) => [s.id, s]))
  const terms = queryTerms(q)
  const lines: string[] = []
  let used = header.length + 400
  for (const h of r.hits) {
    const line = hitLine(store, h, smap, terms)
    if (lines.length && used + line.length + 1 > maxChars) break
    lines.push(line)
    used += line.length + 1
  }
  const how = r.any ? `com algum dos termos de "${q}" (nenhuma tem todos)` : `com "${q}"`
  return {
    ok: true,
    text: `${header}\n[${fmtNum(total)} ${total === 1 ? 'mensagem' : 'mensagens'} ${how}, mais relevantes primeiro; mostrando ${lines.length}]\n${lines.join('\n')}\n[para ler uma mensagem inteira: chat_id="${chat.id}" from_seq=N to_seq=N (+ session_id para as de subagente)]`
  }
}

/** Data curta local: 2026-10-15. */
function fmtDate(ts: number): string {
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** Busca em todos os chats menos `selfChatId`; resultados agrupados por chat. */
export function searchAllChats(
  store: HistoryStore,
  query: string,
  selfChatId: string | undefined,
  opts: { limit?: number } = {},
  maxChars: number = LIMITS.maxToolOutputChars
): { ok: boolean; text: string } {
  if (!store.indexReady)
    return {
      ok: false,
      text: 'Erro: índice de busca indisponível — use list_chats e read_history com chat_id.'
    }
  const q = query.trim()
  const maxChats = clampInt(opts.limit, LIMITS.historyAllChatsDefault, LIMITS.historyAllChatsMax)
  const per = LIMITS.historyAllPerChat
  const filter: SearchFilter = { excludeChatId: selfChatId, limit: 400 }
  const r = ftsSearch(store, q, filter)
  if (!r) return { ok: true, text: NO_TERMS(q) }
  const chats = store.chats().filter((c) => c.id !== selfChatId)
  const byId = new Map(chats.map((c) => [c.id, c]))
  // chats cujo título casa (sem acento/caixa) — úteis mesmo sem mensagens encontradas
  const terms = normalizeText(q).split(/\s+/).filter(Boolean)
  const titleHits = chats.filter((c) => {
    const t = normalizeText(c.title || 'Novo chat')
    return terms.every((x) => t.includes(x))
  })
  const counts = r.hits.length
    ? store.countByChat(r.expr, { excludeChatId: selfChatId })
    : new Map()
  const groups = new Map<string, SearchHit[]>()
  for (const h of r.hits) {
    if (!byId.has(h.chatId)) continue
    const g = groups.get(h.chatId) ?? []
    if (!groups.has(h.chatId)) {
      if (groups.size >= maxChats) continue
      groups.set(h.chatId, g)
    }
    if (g.length < per) g.push(h)
  }
  const qterms = queryTerms(q)
  const out: string[] = []
  let used = 600
  let shownChats = 0
  for (const [chatId, hits] of groups) {
    const c = byId.get(chatId)!
    const smap = new Map(store.sessions(chatId).map((s) => [s.id, s]))
    const n = counts.get(chatId) ?? hits.length
    const head = `## ${titleOf(c.title)} · chat_id ${c.id} · atualizado ${fmtDate(c.updatedAt)} · ${nMsgs(n)}`
    const block = [head]
    for (const h of hits) block.push(hitLine(store, h, smap, qterms))
    let text = block.join('\n')
    if (used + text.length + 1 > maxChars) {
      if (shownChats) break
      text = text.slice(0, Math.max(200, maxChars - used))
    }
    out.push(text)
    used += text.length + 1
    shownChats++
  }
  const totalMsgs = [...counts.values()].reduce((a, b) => a + b, 0)
  const how = r.any ? `com algum dos termos (nenhuma tem todos)` : 'com todos os termos'
  const where = `busca em ${nChats(chats.length)}${selfChatId ? ' (exceto este)' : ''} por "${q}"`
  const head = r.hits.length
    ? `[${where}: ${nMsgs(totalMsgs)} ${how} em ${nChats(counts.size)}; mostrando ${shownChats} (mais relevantes primeiro, até ${per} trechos cada)]`
    : `[${where}: nenhuma mensagem encontrada]`
  const extraTitles = titleHits.filter((c) => !groups.has(c.id)).slice(0, 5)
  const titles = extraTitles.length
    ? `\n[chats com título parecido: ${extraTitles.map((c) => `${titleOf(c.title)} (chat_id ${c.id})`).join(', ')}]`
    : ''
  const more =
    counts.size > shownChats
      ? ` Há mais ${fmtNum(counts.size - shownChats)} chat(s): refine a busca ou aumente limit.`
      : ''
  const foot = r.hits.length
    ? `\n[para ler uma mensagem: read_history chat_id=<id> from_seq=N to_seq=N (+ session_id para subagente); para buscar só num chat: chat_id + query.${more}]`
    : ''
  return { ok: true, text: `${head}${out.length ? `\n${out.join('\n')}` : ''}${titles}${foot}` }
}

/** Minúsculas sem acentos (comparação de títulos). */
export const normalizeText = (s: string): string =>
  s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()

export async function readHistoryTool(
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  const opts: HistoryOptions = {
    query: optString(args, 'query'),
    fromSeq: optNumber(args, 'from_seq'),
    toSeq: optNumber(args, 'to_seq'),
    limit: optNumber(args, 'limit'),
    includeToolResults: optBool(args, 'include_tool_results')
  }
  const max = maxOutputOf(ctx)
  const chatRef = optString(args, 'chat_id')?.trim()
  const scope = optString(args, 'scope')
  const sessionRef = optString(args, 'session_id')?.trim()
  const q = opts.query?.trim()
  if (scope != null && scope !== 'all' && scope !== 'session')
    return fail('Erro: scope deve ser "all" (todos os outros chats) ou omitido.')
  if (scope === 'all' || chatRef) {
    if (!ctx.historyStore) return fail('Erro: busca em outros chats indisponível nesta sessão.')
    if (scope === 'all') {
      if (chatRef) return fail('Erro: use chat_id (um chat) OU scope "all" (todos), não os dois.')
      if (!q) return fail('Erro: scope "all" exige query (o texto a buscar em todos os chats).')
      const r = searchAllChats(ctx.historyStore, q, ctx.chatId, { limit: opts.limit }, max)
      return r.ok ? ok(r.text) : fail(r.text)
    }
    const r = readOtherChat(ctx.historyStore, chatRef!, { ...opts, query: q, sessionRef }, max)
    return r.ok ? ok(r.text) : fail(r.text)
  }
  if (sessionRef) return fail('Erro: session_id só vale junto com chat_id.')
  if (!ctx.history) return fail('Erro: histórico indisponível nesta sessão.')
  const history = ctx.history()
  return ok(
    q ? searchHistory(history, { ...opts, query: q }, max) : formatHistoryRange(history, opts, max)
  )
}
