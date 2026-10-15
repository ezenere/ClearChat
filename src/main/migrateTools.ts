// Migração idempotente de dados: tool `bash` renomeada para `shell`. Roda uma vez (flag em
// settings), numa transação. Sem Electron — testável com um banco temporário (better-sqlite3).
import type Database from 'better-sqlite3'
import { migrateConfigJson, migrateMessageJson, migrateMetaJson } from '@shared/toolRename'

export const TOOL_SHELL_RENAME_FLAG = 'migration.toolShellRename'

export interface ToolRenameStats {
  skipped: boolean
  messages: number
  metas: number
  chats: number
  presets: number
}

export function migrateToolShellRename(conn: Database.Database): ToolRenameStats {
  const stats: ToolRenameStats = { skipped: false, messages: 0, metas: 0, chats: 0, presets: 0 }
  const flag = conn.prepare('SELECT value FROM settings WHERE key = ?').get(TOOL_SHELL_RENAME_FLAG)
  if (flag) return { ...stats, skipped: true }
  const tx = conn.transaction(() => {
    const msgs = conn
      .prepare(
        `SELECT id, message_json, meta_json FROM messages WHERE message_json LIKE '%"bash"%' OR meta_json LIKE '%"bash"%'`
      )
      .all() as { id: string; message_json: string; meta_json: string }[]
    const updMsg = conn.prepare('UPDATE messages SET message_json = ? WHERE id = ?')
    const updMeta = conn.prepare('UPDATE messages SET meta_json = ? WHERE id = ?')
    for (const r of msgs) {
      const m = migrateMessageJson(r.message_json)
      if (m) {
        updMsg.run(m, r.id)
        stats.messages++
      }
      const meta = migrateMetaJson(r.meta_json)
      if (meta) {
        updMeta.run(meta, r.id)
        stats.metas++
      }
    }
    for (const [table, key] of [
      ['chats', 'chats'],
      ['presets', 'presets']
    ] as const) {
      const rows = conn
        .prepare(`SELECT id, config_json FROM ${table} WHERE config_json LIKE '%"bash"%'`)
        .all() as { id: string; config_json: string }[]
      const upd = conn.prepare(`UPDATE ${table} SET config_json = ? WHERE id = ?`)
      for (const r of rows) {
        const c = migrateConfigJson(r.config_json)
        if (c) {
          upd.run(c, r.id)
          stats[key]++
        }
      }
    }
    conn
      .prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
      .run(TOOL_SHELL_RENAME_FLAG, 'true')
  })
  tx()
  return stats
}
