// Memória modular — schema SQLite (idempotente). Sem Electron: recebe a conexão (db.ts no app;
// banco temporário nos testes, e2e/memory.test.ts). Ver SPEC.md → "Memória" → Dados.
//
// memory_collections: categoria FIXA por coleção; todas globais, criadas pelo usuário. As colunas
//   `scope`/`chat_id` são LEGADAS (a antiga "memória do chat", removida): toda coleção é 'shared' e
//   a migração abaixo apaga as que eram scope 'chat' (com as memórias delas).
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
  scope       TEXT NOT NULL DEFAULT 'shared', -- legado: sempre 'shared'
  chat_id     TEXT REFERENCES chats(id) ON DELETE CASCADE, -- legado: sempre NULL
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

export interface ChatMemoryRemovalStats {
  /** Coleções scope 'chat' apagadas. */
  collections: number
  /** Memórias dessas coleções apagadas. */
  memories: number
  /** Configs (chats / personas) das quais `memory.chatMemory` foi retirado. */
  chats: number
  presets: number
}

const hasTable = (conn: Database.Database, name: string): boolean =>
  !!conn.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)

/** config_json sem `memory.chatMemory` (null = nada a mudar ou JSON inválido). */
function stripChatMemory(json: string): string | null {
  try {
    const c = JSON.parse(json) as { memory?: Record<string, unknown> } | null
    const m = c?.memory
    if (!m || typeof m !== 'object' || Array.isArray(m) || !('chatMemory' in m)) return null
    delete m.chatMemory
    return JSON.stringify(c)
  } catch {
    return null
  }
}

/**
 * Remove a antiga "memória do chat" (idempotente — roda a cada abertura e não acha nada depois da
 * 1ª): apaga as coleções scope 'chat' e as memórias delas (só serviam ao chat dono) e tira
 * `memory.chatMemory` das configs de chats e personas.
 */
export function removeChatMemory(conn: Database.Database): ChatMemoryRemovalStats {
  const stats: ChatMemoryRemovalStats = { collections: 0, memories: 0, chats: 0, presets: 0 }
  // sem a tabela chats (banco só com a memória, testes) não há coleção de chat — e o DELETE nem
  // compila (FK para chats)
  if (!hasTable(conn, 'chats')) return stats
  conn.transaction(() => {
    stats.memories = conn
      .prepare(
        "DELETE FROM memories WHERE collection_id IN (SELECT id FROM memory_collections WHERE scope = 'chat')"
      )
      .run().changes
    stats.collections = conn
      .prepare("DELETE FROM memory_collections WHERE scope = 'chat'")
      .run().changes
    for (const table of ['chats', 'presets'] as const) {
      if (!hasTable(conn, table)) continue
      const rows = conn
        .prepare(`SELECT id, config_json FROM ${table} WHERE config_json LIKE '%"chatMemory"%'`)
        .all() as { id: string; config_json: string }[]
      const upd = conn.prepare(`UPDATE ${table} SET config_json = ? WHERE id = ?`)
      for (const r of rows) {
        const next = stripChatMemory(r.config_json)
        if (next) {
          upd.run(next, r.id)
          stats[table]++
        }
      }
    }
  })()
  return stats
}

/**
 * Cria tabelas, índices, triggers e a coluna sessions.memory_json (idempotente) e remove a antiga
 * memória do chat (removeChatMemory). O FTS é populado uma vez se estiver vazio e houver memórias
 * (ex.: tabela recriada).
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
  try {
    const r = removeChatMemory(conn)
    if (r.collections || r.memories || r.chats || r.presets)
      console.log(
        `[clearchat] memória do chat removida: ${r.collections} coleções e ${r.memories} memórias apagadas; chatMemory retirado de ${r.chats} chats e ${r.presets} personas`
      )
  } catch (e) {
    console.error('[clearchat] memória: remoção da memória do chat', e)
  }
}
