// Índice de busca (SQLite FTS5) das mensagens persistidas — read_history em outros chats.
// Sem Electron: recebe a conexão (db.ts no app; banco temporário nos testes, e2e/historySearch.test.ts).
//
// Estrutura:
//   message_search(docid INTEGER PRIMARY KEY, message_id UNIQUE) — docid estável (VACUUM não
//     renumera INTEGER PRIMARY KEY; o rowid implícito de `messages` poderia mudar).
//   messages_fts(body, tool) FTS5 contentless (content='', contentless_delete=1 — SQLite ≥ 3.43:
//     só o índice invertido, sem cópia do texto; os trechos saem da mensagem em JS), rowid = docid;
//     tokenizer unicode61 remove_diacritics 2 (sem caixa/acentos). body = texto de user/assistant;
//     tool = chamadas (nome + argumentos) e resultados de tools — pesos diferentes no bm25.
// Manutenção: inserção/edição pelo repo (indexMessage — o texto pesquisável sai do JSON, com regras
// em JS); remoção por TRIGGER (cobre DELETE direto e os CASCADE de apagar chat/sessão). insertAt só
// muda `seq`, que não está no índice (o seq vem do JOIN com messages).
import type Database from 'better-sqlite3'
import { contentText, messageAttachments } from '@shared/attachments'
import type { ApiMessage, MessageMeta } from '@shared/types'

export const SEARCH_INDEX_FLAG = 'migration.searchIndex'
/** Suba quando mudar as regras de searchableText (a migração reindexa tudo). */
export const SEARCH_INDEX_VERSION = '1'

/** Teto de texto indexado por coluna de uma mensagem (resultados de tool já vêm limitados). */
const MAX_INDEXED_CHARS = 60_000

const DDL = `
CREATE TABLE IF NOT EXISTS message_search (
  docid      INTEGER PRIMARY KEY,
  message_id TEXT NOT NULL UNIQUE
);
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  body, tool, content = '', contentless_delete = 1,
  tokenize = 'unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS messages_search_ad AFTER DELETE ON messages BEGIN
  DELETE FROM messages_fts WHERE rowid = (SELECT docid FROM message_search WHERE message_id = old.id);
  DELETE FROM message_search WHERE message_id = old.id;
END;
`

/** Conexões com o índice pronto (indexMessage é no-op sem ele — ex.: SQLite sem FTS5). */
const ready = new WeakSet<Database.Database>()

export const isSearchIndexReady = (conn: Database.Database): boolean => ready.has(conn)

/** Saídas do próprio read_history (repetiriam trechos já encontrados). */
export const isHistoryToolOutput = (text: string): boolean =>
  /^\[(histórico |busca no histórico |busca em [\d.]+ chats? )/.test(text)

/** Remove blobs (base64/hex longos) que só poluiriam o índice. */
const stripBlobs = (s: string): string =>
  s.replace(/[A-Za-z0-9+/=_-]{200,}/g, ' ').slice(0, MAX_INDEXED_CHARS)

/** Texto pesquisável: { body (conversa), tool (chamadas/resultados) }. Nunca bytes de anexos. */
export function searchableText(
  message: ApiMessage,
  meta: MessageMeta = {}
): { body: string; tool: string } {
  if (meta.kind === 'error') return { body: '', tool: '' } // erro só de exibição
  if (message.role === 'assistant') {
    const calls = (message.tool_calls ?? [])
      .filter((tc) => tc.function.name !== 'read_history')
      .map((tc) => `${tc.function.name}(${tc.function.arguments ?? ''})`)
    return { body: stripBlobs(message.content ?? ''), tool: stripBlobs(calls.join('\n')) }
  }
  const text = contentText(message.content)
  const atts = messageAttachments(message).map((a) => a.name)
  const full = atts.length ? `${text}\n${atts.join(' ')}` : text
  if (message.role === 'tool')
    return { body: '', tool: isHistoryToolOutput(text) ? '' : stripBlobs(full) }
  return { body: stripBlobs(full), tool: '' }
}

/** (Re)indexa uma mensagem (append, insertAt, update). */
export function indexMessage(
  conn: Database.Database,
  id: string,
  message: ApiMessage,
  meta: MessageMeta = {}
): void {
  if (!ready.has(conn)) return
  const { body, tool } = searchableText(message, meta)
  const cur = conn.prepare('SELECT docid FROM message_search WHERE message_id = ?').get(id) as
    { docid: number } | undefined
  if (cur) conn.prepare('DELETE FROM messages_fts WHERE rowid = ?').run(cur.docid)
  if (!body && !tool) {
    if (cur) conn.prepare('DELETE FROM message_search WHERE docid = ?').run(cur.docid)
    return
  }
  const docid = cur
    ? cur.docid
    : Number(
        conn.prepare('INSERT INTO message_search (message_id) VALUES (?)').run(id).lastInsertRowid
      )
  conn
    .prepare('INSERT INTO messages_fts (rowid, body, tool) VALUES (?, ?, ?)')
    .run(docid, body, tool)
}

function parseJson<T>(s: string, fallback: T): T {
  try {
    return JSON.parse(s) as T
  } catch {
    return fallback
  }
}

/** Reconstrói o índice inteiro (transação). */
export function rebuildSearchIndex(conn: Database.Database): number {
  let n = 0
  conn.transaction(() => {
    conn.exec('DELETE FROM messages_fts; DELETE FROM message_search;')
    const ins = conn.prepare('INSERT INTO message_search (message_id) VALUES (?)')
    const fts = conn.prepare('INSERT INTO messages_fts (rowid, body, tool) VALUES (?, ?, ?)')
    // em lotes por rowid (better-sqlite3 não deixa escrever enquanto itera um SELECT)
    const page = conn.prepare(
      'SELECT rowid AS r, id, message_json, meta_json FROM messages WHERE rowid > ? ORDER BY rowid LIMIT 500'
    )
    let last = -1
    for (;;) {
      const rows = page.all(last) as {
        r: number
        id: string
        message_json: string
        meta_json: string
      }[]
      if (!rows.length) break
      last = rows[rows.length - 1].r
      for (const r of rows) {
        const msg = parseJson<ApiMessage | null>(r.message_json, null)
        if (!msg || typeof msg !== 'object') continue
        const { body, tool } = searchableText(msg, parseJson<MessageMeta>(r.meta_json, {}))
        if (!body && !tool) continue
        fts.run(Number(ins.run(r.id).lastInsertRowid), body, tool)
        n++
      }
    }
    conn.exec("INSERT INTO messages_fts (messages_fts) VALUES ('optimize')")
  })()
  return n
}

/**
 * Migração idempotente: cria as tabelas/trigger; popula na primeira vez (ou se a versão das regras
 * mudou, ou o índice sumiu). Marca a conexão como pronta (o repo passa a manter o índice).
 */
export function ensureSearchIndex(conn: Database.Database): {
  skipped: boolean
  indexed: number
  ms: number
} {
  const t0 = Date.now()
  const existed = !!conn
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'messages_fts'")
    .get()
  conn.exec(DDL)
  ready.add(conn)
  const flag = conn.prepare('SELECT value FROM settings WHERE key = ?').get(SEARCH_INDEX_FLAG) as
    { value: string } | undefined
  if (existed && flag?.value === SEARCH_INDEX_VERSION) return { skipped: true, indexed: 0, ms: 0 }
  const indexed = rebuildSearchIndex(conn)
  conn
    .prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
    .run(SEARCH_INDEX_FLAG, SEARCH_INDEX_VERSION)
  return { skipped: false, indexed, ms: Date.now() - t0 }
}

// ---------------- consulta ----------------

/**
 * Entrada livre do agente → expressão FTS5 segura. Cada pedaço separado por espaço vira uma frase
 * entre aspas (aspas internas duplicadas — operadores como NEAR( / AND / * perdem o sentido) com
 * prefixo (`"termo"*`) quando o último token tem ≥ 3 caracteres. Pedaços sem letras/dígitos são
 * descartados. `mode: 'all'` = todos os termos (AND); `'any'` = qualquer um (OR; bm25 ainda
 * favorece quem tem mais). null = nada pesquisável.
 */
export function ftsQuery(input: string, mode: 'all' | 'any' = 'all'): string | null {
  const parts: string[] = []
  for (const chunk of input.split(/\s+/)) {
    const words = chunk.match(/[\p{L}\p{N}]+/gu)
    if (!words) continue
    const phrase = words.join(' ')
    const last = words[words.length - 1]
    parts.push(`"${phrase.replace(/"/g, '""')}"${[...last].length >= 3 ? '*' : ''}`)
    if (parts.length >= 16) break
  }
  if (!parts.length) return null
  return parts.join(mode === 'all' ? ' AND ' : ' OR ')
}

export interface SearchHit {
  docid: number
  messageId: string
  sessionId: string
  chatId: string
  seq: number
  score: number
}

export interface SearchFilter {
  /** Só este chat (todas as sessões, ou só `sessionId`). */
  chatId?: string
  sessionId?: string
  /** Todos os chats menos este. */
  excludeChatId?: string
  fromSeq?: number
  toSeq?: number
  limit: number
}

/** Pesos do bm25: texto da conversa vale mais que chamadas/resultados de tools. */
const RANK = 'bm25(messages_fts, 3.0, 1.0)'

function whereOf(f: SearchFilter): { sql: string; params: (string | number)[] } {
  const c: string[] = []
  const params: (string | number)[] = []
  if (f.fromSeq != null) {
    c.push('m.seq >= ?')
    params.push(f.fromSeq)
  }
  if (f.toSeq != null) {
    c.push('m.seq <= ?')
    params.push(f.toSeq)
  }
  if (f.chatId) {
    c.push('s.chat_id = ?')
    params.push(f.chatId)
  }
  if (f.sessionId) {
    c.push('m.session_id = ?')
    params.push(f.sessionId)
  }
  if (f.excludeChatId) {
    c.push('s.chat_id <> ?')
    params.push(f.excludeChatId)
  }
  return { sql: c.length ? ` AND ${c.join(' AND ')}` : '', params }
}

const FROM = `FROM messages_fts
  JOIN message_search ms ON ms.docid = messages_fts.rowid
  JOIN messages m ON m.id = ms.message_id
  JOIN sessions s ON s.id = m.session_id
  WHERE messages_fts MATCH ?`

/** Melhores mensagens (bm25) para a expressão FTS (sem trechos — ver snippets). */
export function searchIndex(conn: Database.Database, query: string, f: SearchFilter): SearchHit[] {
  const w = whereOf(f)
  return conn
    .prepare(
      `SELECT messages_fts.rowid AS docid, m.id AS messageId, m.session_id AS sessionId,
        s.chat_id AS chatId, m.seq AS seq, ${RANK} AS score
       ${FROM}${w.sql} ORDER BY score LIMIT ?`
    )
    .all(query, ...w.params, f.limit) as SearchHit[]
}

/** Termos (minúsculos, sem acentos) de uma busca — para destacar o trecho em JS. */
export function queryTerms(input: string): string[] {
  return [...new Set((normalizeForMatch(input).match(/[\p{L}\p{N}]+/gu) ?? []).filter(Boolean))]
}

/** Minúsculas sem acentos, preservando o comprimento por caractere (índices batem com o original). */
function normalizeForMatch(s: string): string {
  let out = ''
  for (const ch of s) {
    const n = ch.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
    out +=
      n.length === ch.length ? n : ch.toLowerCase().length === ch.length ? ch.toLowerCase() : ch
  }
  return out
}

/**
 * Trecho de `text` ao redor da primeira ocorrência (início de palavra, como o prefixo do FTS) do
 * termo mais raro no texto; sem ocorrência → início do texto. `window` caracteres no total.
 */
export function matchSnippet(text: string, terms: string[], window = 220): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const low = normalizeForMatch(flat)
  let at = -1
  let len = 0
  for (const t of terms) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'u')
    const m = re.exec(low)
    if (m && (at === -1 || m.index < at)) {
      at = m.index
      len = t.length
    }
  }
  if (at === -1) at = 0
  const half = Math.floor((window - len) / 2)
  const a = Math.max(0, at - half)
  const b = Math.min(flat.length, Math.max(at + len + half, a + window))
  return `${a > 0 ? '…' : ''}${flat.slice(a, b).trim()}${b < flat.length ? '…' : ''}`
}

/** Total de mensagens que casam, por chat. */
export function countByChat(
  conn: Database.Database,
  query: string,
  f: Omit<SearchFilter, 'limit'>
): Map<string, number> {
  const w = whereOf({ ...f, limit: 0 })
  const rows = conn
    .prepare(`SELECT s.chat_id AS chatId, COUNT(*) AS n ${FROM}${w.sql} GROUP BY s.chat_id`)
    .all(query, ...w.params) as { chatId: string; n: number }[]
  return new Map(rows.map((r) => [r.chatId, r.n]))
}
