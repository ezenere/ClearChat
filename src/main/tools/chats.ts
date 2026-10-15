// get_chat_info / list_chats: informações do chat chamador e dos outros chats do app.
// Os dados vêm do runner (ToolContext.chats); a formatação é pura — testada em e2e/unit.test.ts.
// send_to_chat é tratado pelo runner (precisa do loop do chat de destino).
import { LIMITS } from '@shared/limits'
import {
  fail,
  fmtNum,
  maxOutputOf,
  ok,
  optNumber,
  optString,
  type ChatInfoData,
  type ChatListEntry,
  type ToolContext,
  type ToolResult
} from './util'

/** Data/hora local legível e sem ambiguidade: 2026-10-15 14:03 (UTC-3). */
export function fmtDateTime(ts: number): string {
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  const off = -d.getTimezoneOffset()
  const tz = `UTC${off >= 0 ? '+' : '-'}${Math.floor(Math.abs(off) / 60)}${off % 60 ? `:${p(Math.abs(off) % 60)}` : ''}`
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())} (${tz})`
}

/** "agora", "há 5 min", "há 3 h", "há 2 d". */
export function fmtAgo(ts: number, now = Date.now()): string {
  const min = Math.floor((now - ts) / 60_000)
  if (min < 1) return 'agora'
  if (min < 60) return `há ${min} min`
  const h = Math.floor(min / 60)
  if (h < 24) return `há ${h} h`
  return `há ${Math.floor(h / 24)} d`
}

const STATUS_LABEL: Record<ChatListEntry['status'], string> = {
  idle: 'ocioso',
  running: 'rodando',
  awaiting_approval: 'aguardando aprovação'
}

export function formatChatInfo(i: ChatInfoData): string {
  const lines = [
    `chat_id: ${i.chatId}`,
    `título: ${i.title || 'Novo chat'}`,
    i.depth === 0
      ? `sessão: ${i.sessionId} (principal)`
      : `sessão: ${i.sessionId} (subagente, nível ${i.depth}: "${i.sessionTitle}")`
  ]
  if (i.depth > 0) {
    lines.push(`sessão-pai: ${i.parentSessionId ?? '?'}`)
    lines.push(`sessão principal do chat: ${i.mainSessionId}`)
  }
  lines.push(
    `modelo: ${i.model || '(nenhum)'}`,
    `provedor: ${i.providerName || '(nenhum)'}`,
    `diretório raiz: ${i.root}`,
    `criado em: ${fmtDateTime(i.createdAt)}`
  )
  return lines.join('\n')
}

/** Normaliza `limit` (padrão 30, 1..100). */
export function clampChatsLimit(v: number | undefined): number {
  if (v === undefined || !Number.isFinite(v) || v <= 0) return LIMITS.chatsDefaultResults
  return Math.min(LIMITS.chatsMaxResults, Math.max(1, Math.floor(v)))
}

export function formatChatList(
  chats: ChatListEntry[],
  opts: { query?: string; limit?: number },
  info: { maxChars?: number; now?: number } = {}
): string {
  const q = opts.query?.trim().toLowerCase()
  const matched = q
    ? chats.filter((c) => (c.title || 'Novo chat').toLowerCase().includes(q) || c.id.startsWith(q))
    : chats
  const limit = clampChatsLimit(opts.limit)
  const max = info.maxChars ?? LIMITS.maxToolOutputChars
  if (!matched.length)
    return q ? `[nenhum chat de ${chats.length} casa com "${opts.query}"]` : '[nenhum chat]'
  const lines: string[] = []
  let used = 200
  for (const c of matched.slice(0, limit)) {
    const line = [
      `${c.id}${c.self ? ' (este chat)' : ''}`,
      `"${(c.title || 'Novo chat').replace(/\s+/g, ' ')}"`,
      c.model || '(sem modelo)',
      STATUS_LABEL[c.status],
      `atualizado ${fmtAgo(c.updatedAt, info.now)}`
    ].join(' · ')
    if (used + line.length + 1 > max) break
    lines.push(line)
    used += line.length + 1
  }
  const head = `[${fmtNum(matched.length)} ${matched.length === 1 ? 'chat' : 'chats'}${q ? ` com "${opts.query}"` : ''}; mostrando ${lines.length}]`
  const tail =
    lines.length < matched.length
      ? `\n[${fmtNum(matched.length - lines.length)} não listados — refine com query ou aumente limit]`
      : ''
  return `${head}\n${lines.join('\n')}${tail}`
}

export async function getChatInfoTool(
  _args: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  if (!ctx.chats) return fail('Erro: informações do chat indisponíveis.')
  return ok(formatChatInfo(ctx.chats.self()))
}

export async function listChatsTool(
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  if (!ctx.chats) return fail('Erro: lista de chats indisponível.')
  return ok(
    formatChatList(
      ctx.chats.list(),
      { query: optString(args, 'query'), limit: optNumber(args, 'limit') },
      { maxChars: maxOutputOf(ctx) }
    )
  )
}
