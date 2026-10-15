import { app } from 'electron'
import { join } from 'path'
import Database from 'better-sqlite3'
import { DB_FILENAME } from './migrate'

// Schema: ver SPEC.md → "Banco". JSON fica em colunas *_json; IDs = crypto.randomUUID(); timestamps = Date.now().
const SCHEMA = `
CREATE TABLE IF NOT EXISTS providers (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  base_url     TEXT NOT NULL,
  api_key      TEXT NOT NULL DEFAULT '',
  headers_json TEXT NOT NULL DEFAULT '{}',
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS chats (
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL DEFAULT '',
  config_json     TEXT NOT NULL,
  main_session_id TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id                  TEXT PRIMARY KEY,
  chat_id             TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  parent_session_id   TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  parent_tool_call_id TEXT,
  depth               INTEGER NOT NULL DEFAULT 0,
  model               TEXT NOT NULL,
  title               TEXT NOT NULL DEFAULT '',
  task                TEXT,
  status              TEXT NOT NULL DEFAULT 'idle',
  created_at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_chat ON sessions(chat_id);

CREATE TABLE IF NOT EXISTS messages (
  id           TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL,
  message_json TEXT NOT NULL,
  meta_json    TEXT NOT NULL DEFAULT '{}',
  created_at   INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_session_seq ON messages(session_id, seq);

CREATE TABLE IF NOT EXISTS presets (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  icon        TEXT NOT NULL DEFAULT '',
  config_json TEXT NOT NULL DEFAULT '{}',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
`

let db: Database.Database | null = null

export function getDbPath(): string {
  return join(app.getPath('userData'), DB_FILENAME)
}

/** Abre (uma vez) o banco em userData/clearchat.db, com WAL + foreign_keys e schema criado. */
export function getDb(): Database.Database {
  if (db) return db
  const conn = new Database(getDbPath())
  conn.pragma('journal_mode = WAL')
  conn.pragma('foreign_keys = ON')
  conn.exec(SCHEMA)
  migrate(conn)
  db = conn
  return conn
}

/** Colunas adicionadas depois do schema inicial (idempotente). */
function migrate(conn: Database.Database): void {
  const cols = (conn.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]).map(
    (c) => c.name
  )
  // provedor da subsessão (a principal segue o do chat)
  if (!cols.includes('provider_id')) conn.exec('ALTER TABLE sessions ADD COLUMN provider_id TEXT')
}

export function closeDb(): void {
  db?.close()
  db = null
}
