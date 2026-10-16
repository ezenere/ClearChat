// Fonte de dados do read_history para OUTROS chats (chat_id / scope "all"): consultas diretas na
// conexão (sem Electron) — o runner passa historyStore(getDb()); os testes, um banco temporário.
import type Database from 'better-sqlite3'
import type { ApiMessage, MessageMeta, StoredMessage } from '@shared/types'
import {
  countByChat,
  isSearchIndexReady,
  searchIndex,
  type SearchFilter,
  type SearchHit
} from './searchIndex'

export interface StoreChat {
  id: string
  title: string
  mainSessionId: string
  updatedAt: number
}

export interface StoreSession {
  id: string
  chatId: string
  title: string
  depth: number
}

export interface HistoryStore {
  /** Índice FTS disponível (senão, só a busca por substring na sessão principal). */
  indexReady: boolean
  chats(): StoreChat[]
  chat(id: string): StoreChat | null
  sessions(chatId: string): StoreSession[]
  messages(sessionId: string): StoredMessage[]
  message(id: string): StoredMessage | null
  /** Nome da tool chamada por `toolCallId` (mensagem assistant anterior a `seq` na sessão). */
  toolName(sessionId: string, seq: number, toolCallId: string): string | null
  search(query: string, f: SearchFilter): SearchHit[]
  countByChat(query: string, f: Omit<SearchFilter, 'limit'>): Map<string, number>
}

interface Row {
  id: string
  session_id: string
  seq: number
  message_json: string
  meta_json: string
  created_at: number
}

function parse<T>(s: string, fallback: T): T {
  try {
    return JSON.parse(s) as T
  } catch {
    return fallback
  }
}

const toMessage = (r: Row): StoredMessage => ({
  id: r.id,
  sessionId: r.session_id,
  seq: r.seq,
  message: parse<ApiMessage>(r.message_json, { role: 'user', content: '' }),
  meta: parse<MessageMeta>(r.meta_json, {}),
  createdAt: r.created_at
})

const CHAT_COLS = 'id, title, main_session_id AS mainSessionId, updated_at AS updatedAt'

export function historyStore(conn: Database.Database): HistoryStore {
  return {
    indexReady: isSearchIndexReady(conn),
    chats: () =>
      conn.prepare(`SELECT ${CHAT_COLS} FROM chats ORDER BY updated_at DESC`).all() as StoreChat[],
    chat: (id) =>
      (conn.prepare(`SELECT ${CHAT_COLS} FROM chats WHERE id = ?`).get(id) as StoreChat) ?? null,
    sessions: (chatId) =>
      conn
        .prepare(
          'SELECT id, chat_id AS chatId, title, depth FROM sessions WHERE chat_id = ? ORDER BY created_at'
        )
        .all(chatId) as StoreSession[],
    messages: (sessionId) =>
      (
        conn
          .prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY seq')
          .all(sessionId) as Row[]
      ).map(toMessage),
    message: (id) => {
      const r = conn.prepare('SELECT * FROM messages WHERE id = ?').get(id) as Row | undefined
      return r ? toMessage(r) : null
    },
    toolName: (sessionId, seq, toolCallId) => {
      const rows = conn
        .prepare(
          "SELECT message_json FROM messages WHERE session_id = ? AND seq < ? AND message_json LIKE ? ESCAPE '\\' ORDER BY seq DESC LIMIT 3"
        )
        .all(sessionId, seq, `%${toolCallId.replace(/[\\%_]/g, (c) => `\\${c}`)}%`) as {
        message_json: string
      }[]
      for (const r of rows) {
        const m = parse<ApiMessage | null>(r.message_json, null)
        if (m?.role !== 'assistant') continue
        const tc = m.tool_calls?.find((t) => t.id === toolCallId)
        if (tc) return tc.function.name
      }
      return null
    },
    search: (q, f) => searchIndex(conn, q, f),
    countByChat: (q, f) => countByChat(conn, q, f)
  }
}
