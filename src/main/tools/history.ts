// read_history: lê o histórico PERSISTIDO da sessão chamadora — inclusive as mensagens anteriores
// às fronteiras de compactação (que não vão mais para a API). Busca (query) ou faixa (from/to).
// Tudo puro sobre StoredMessage[] — testado em e2e/unit.test.ts.
import { LIMITS } from '@shared/limits'
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

export interface HistoryOptions {
  query?: string
  fromSeq?: number
  toSeq?: number
  limit?: number
  includeToolResults?: boolean
}

const contentText = (c: ApiMessage['content']): string =>
  c == null ? '' : typeof c === 'string' ? c : c.map((p) => p.text ?? '').join('')

const clampInt = (v: number | undefined, def: number, max: number): number =>
  v === undefined || !Number.isFinite(v) || v <= 0 ? def : Math.min(max, Math.max(1, Math.floor(v)))

/** Mensagens consultáveis: tudo menos erros só de exibição, em ordem de seq. */
export function historyMessages(history: StoredMessage[]): StoredMessage[] {
  return history.filter((m) => m.meta?.kind !== 'error').sort((a, b) => a.seq - b.seq)
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
      const text = contentText(msg.content)
      if (m.meta.kind === 'compaction') {
        const r = m.meta.summaryOf
        return {
          label: `user [fronteira de compactação${r ? ` · resume #${r.fromSeq}–#${r.toSeq}` : ''}]`,
          text
        }
      }
      if (m.meta.kind === 'inter-chat') return { label: 'user [de outro chat]', text }
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
          ? msg.content
          : `[resultado omitido · ${fmtNum(msg.content.length)} caracteres — use include_tool_results=true para ver]`
      }
    }
    default:
      return { label: msg.role, text: contentText(msg.content) }
  }
}

/** Cabeçalho: total de mensagens e onde estão as fronteiras de compactação. */
export function historyHeader(msgs: StoredMessage[]): string {
  if (!msgs.length) return '[histórico desta sessão: vazio]'
  const bounds = msgs.filter((m) => m.meta.kind === 'compaction')
  const base = `[histórico desta sessão: ${fmtNum(msgs.length)} mensagens (#${msgs[0].seq}–#${msgs[msgs.length - 1].seq})`
  if (!bounds.length) return `${base}; sem compactações]`
  const list = bounds
    .map((b) => {
      const r = b.meta.summaryOf
      return `#${b.seq}${r ? ` (resume #${r.fromSeq}–#${r.toSeq})` : ''}`
    })
    .join(', ')
  const last = bounds[bounds.length - 1]
  return `${base}; fronteiras de compactação: ${list} — as mensagens antes de #${last.seq} não estão mais no seu contexto]`
}

/** Modo faixa: `#seq papel: conteúdo`, respeitando `maxChars`. */
export function formatHistoryRange(
  history: StoredMessage[],
  opts: HistoryOptions,
  maxChars: number = LIMITS.maxToolOutputChars
): string {
  const msgs = historyMessages(history)
  const header = historyHeader(msgs)
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
    return names.get(msg.tool_call_id) === 'read_history' ? '' : msg.content
  }
  return contentText(msg.content)
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
  maxChars: number = LIMITS.maxToolOutputChars
): string {
  const all = historyMessages(history)
  const header = historyHeader(all)
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

export async function readHistoryTool(
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  if (!ctx.history) return fail('Erro: histórico indisponível nesta sessão.')
  const opts: HistoryOptions = {
    query: optString(args, 'query'),
    fromSeq: optNumber(args, 'from_seq'),
    toSeq: optNumber(args, 'to_seq'),
    limit: optNumber(args, 'limit'),
    includeToolResults: optBool(args, 'include_tool_results')
  }
  const max = maxOutputOf(ctx)
  const history = ctx.history()
  const q = opts.query?.trim()
  return ok(
    q ? searchHistory(history, { ...opts, query: q }, max) : formatHistoryRange(history, opts, max)
  )
}
