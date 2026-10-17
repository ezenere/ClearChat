// Memória modular — schema SQLite (idempotente). Sem Electron: recebe a conexão (db.ts no app;
// banco temporário nos testes, e2e/memory.test.ts). Ver SPEC.md → "Memória" → Dados.
//
// memory_collections: categoria FIXA por coleção; scope 'shared' (global, criada pelo usuário) ou
//   'chat' (memória própria de um chat — chat_id com ON DELETE CASCADE: apagar o chat apaga a coleção).
// memories: category denormalizada (= da coleção); facts_json = string[]; supersedes_id = memória
//   (de outra coleção) que esta substitui (memory_rewrite) — sem FK: o trigger zera quando a
//   original é apagada.
// memories_fts: FTS5 (title, summary, facts) com memory_id UNINDEXED, mantido por TRIGGERS (cobre
//   DELETE direto e os CASCADE de coleção/chat). facts = facts_json cru (o tokenizer ignora a
//   pontuação do JSON). unicode61 remove_diacritics 2 = sem caixa/acentos.
// sessions.memory_json: { snapshot?: { at, key, index }, lastExtractedSeq? } — snapshot do índice
//   por sessão (token caching) e a última mensagem já extraída.
import type Database from 'better-sqlite3'

const TABLES = `
CREATE TABLE IF NOT EXISTS memory_collections (
  id          TEXT PRIMARY KEY,
  category    TEXT NOT NULL,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  icon        TEXT,
  scope       TEXT NOT NULL DEFAULT 'shared',
  chat_id     TEXT REFERENCES chats(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_collections_chat ON memory_collections(chat_id);

CREATE TABLE IF NOT EXISTS memories (
  id                 TEXT PRIMARY KEY,
  collection_id      TEXT NOT NULL REFERENCES memory_collections(id) ON DELETE CASCADE,
  category           TEXT NOT NULL,
  title              TEXT NOT NULL,
  slug               TEXT NOT NULL,
  summary            TEXT NOT NULL DEFAULT '',
  facts_json         TEXT NOT NULL DEFAULT '[]',
  pinned             INTEGER NOT NULL DEFAULT 0,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  updated_by_chat_id TEXT,
  updated_by         TEXT NOT NULL DEFAULT 'user',
  supersedes_id      TEXT
);
CREATE INDEX IF NOT EXISTS idx_memories_collection ON memories(collection_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_slug ON memories(slug);
CREATE INDEX IF NOT EXISTS idx_memories_supersedes ON memories(supersedes_id);

CREATE TRIGGER IF NOT EXISTS memories_supersedes_ad AFTER DELETE ON memories BEGIN
  UPDATE memories SET supersedes_id = NULL WHERE supersedes_id = old.id;
END;
`

const FTS = `
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  title, summary, facts, memory_id UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS memories_fts_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts (title, summary, facts, memory_id)
  VALUES (new.title, new.summary, new.facts_json, new.id);
END;
CREATE TRIGGER IF NOT EXISTS memories_fts_au AFTER UPDATE OF title, summary, facts_json ON memories BEGIN
  DELETE FROM memories_fts WHERE memory_id = old.id;
  INSERT INTO memories_fts (title, summary, facts, memory_id)
  VALUES (new.title, new.summary, new.facts_json, new.id);
END;
CREATE TRIGGER IF NOT EXISTS memories_fts_ad AFTER DELETE ON memories BEGIN
  DELETE FROM memories_fts WHERE memory_id = old.id;
END;
`

/** Conexões com o FTS pronto (sem FTS5 a busca cai para LIKE). */
const ftsReady = new WeakSet<Database.Database>()
export const isMemoryFtsReady = (conn: Database.Database): boolean => ftsReady.has(conn)

/**
 * Cria tabelas, índices, triggers e a coluna sessions.memory_json (idempotente). O FTS é populado
 * uma vez se estiver vazio e houver memórias (ex.: tabela recriada).
 */
export function ensureMemorySchema(conn: Database.Database): void {
  conn.exec(TABLES)
  const cols = (conn.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]).map(
    (c) => c.name
  )
  if (cols.length && !cols.includes('memory_json'))
    conn.exec('ALTER TABLE sessions ADD COLUMN memory_json TEXT')
  try {
    conn.exec(FTS)
    const n = (conn.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number }).n
    const f = (conn.prepare('SELECT COUNT(*) AS n FROM memories_fts').get() as { n: number }).n
    if (n && n !== f) {
      conn.transaction(() => {
        conn.exec('DELETE FROM memories_fts')
        conn.exec(
          'INSERT INTO memories_fts (title, summary, facts, memory_id) SELECT title, summary, facts_json, id FROM memories'
        )
      })()
    }
    ftsReady.add(conn)
  } catch (e) {
    console.error('[clearchat] memória: FTS5 indisponível — busca por LIKE', e)
  }
}
