// Árvore de mensagens (ramificação da conversa): colunas + preenchimento único do parent_id. Sem
// Electron — chamado por migrate() em db.ts e testável com um banco temporário (e2e/branches.test.ts).
//
// messages.parent_id: id da mensagem anterior no mesmo ramo; '' = raiz da sessão; NULL = legado
//   (linha gravada por código/registro que não conhece a árvore — ex.: sync de um cliente < 0.7):
//   quem lê deriva "a anterior por seq" (resolveParent em src/shared/branches.ts). Por isso a raiz
//   NÃO é NULL: um NULL perdido no meio do histórico nunca vira uma segunda raiz.
// sessions.branch_sel_json: seleção do ramo ativo ({ [parentId | "root"]: childId | null }).
import type Database from 'better-sqlite3'

export const MESSAGE_TREE_FLAG = 'migration.messageTree'

/** Valor gravado em messages.parent_id para "raiz da sessão" (NULL = legado/derivar). */
export const ROOT_PARENT = ''

export interface MessageTreeStats {
  /** true = o preenchimento já tinha rodado (flag presente). */
  skipped: boolean
  /** Mensagens que receberam parent_id agora. */
  filled: number
}

const columns = (conn: Database.Database, table: string): string[] =>
  (conn.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name)

/**
 * Idempotente: garante as colunas e o índice; na 1ª vez (flag em settings) preenche o parent_id de
 * todas as mensagens com a anterior por seq na mesma sessão (a 1ª de cada sessão → raiz). Roda numa
 * transação com `sync_flags 'apply'` (quando o sync existe): os triggers do sync NÃO marcam as
 * mensagens como sujas — senão o app reenviaria todas as mensagens de todos os chats (e falharia
 * com not_host/divergência nos chats que este aparelho não hospeda).
 */
export function ensureMessageTree(conn: Database.Database): MessageTreeStats {
  if (!columns(conn, 'messages').includes('parent_id'))
    conn.exec('ALTER TABLE messages ADD COLUMN parent_id TEXT')
  if (!columns(conn, 'sessions').includes('branch_sel_json'))
    conn.exec("ALTER TABLE sessions ADD COLUMN branch_sel_json TEXT NOT NULL DEFAULT '{}'")
  conn.exec(
    'CREATE INDEX IF NOT EXISTS idx_messages_session_parent ON messages(session_id, parent_id)'
  )

  if (conn.prepare('SELECT 1 FROM settings WHERE key = ?').get(MESSAGE_TREE_FLAG))
    return { skipped: true, filled: 0 }
  const hasSync = !!conn
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sync_flags'")
    .get()
  let filled = 0
  conn.transaction(() => {
    const setApply = hasSync && !conn.prepare("SELECT 1 FROM sync_flags WHERE k = 'apply'").get()
    if (setApply) conn.prepare("INSERT INTO sync_flags (k) VALUES ('apply')").run()
    try {
      filled = conn
        .prepare(
          `UPDATE messages SET parent_id = COALESCE(
             (SELECT p.id FROM messages p
               WHERE p.session_id = messages.session_id AND p.seq < messages.seq
               ORDER BY p.seq DESC, p.id DESC LIMIT 1),
             ?)
           WHERE parent_id IS NULL`
        )
        .run(ROOT_PARENT).changes
      conn
        .prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
        .run(MESSAGE_TREE_FLAG, 'true')
    } finally {
      if (setApply) conn.prepare("DELETE FROM sync_flags WHERE k = 'apply'").run()
    }
  })()
  return { skipped: false, filled }
}
