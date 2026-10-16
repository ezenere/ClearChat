// Migração idempotente (uma vez, flag em settings): "Auto-aprovar"/"sempre neste chat"
// (ChatConfig.autoApprove) e Smart-Approve por tool → modos por item (ChatConfig.approvalModes).
// Ver migrateApprovalConfig em @shared/approvalPolicy. Sem Electron — testável com banco temporário.
import type Database from 'better-sqlite3'
import { migrateApprovalConfig } from '@shared/approvalPolicy'
import type { ChatConfig } from '@shared/types'

export const APPROVAL_MODES_MIGRATION_FLAG = 'migration.approvalModes'

export interface ApprovalMigrationStats {
  skipped: boolean
  chats: number
  presets: number
}

/** config_json → migrado (null = nada mudou ou JSON inválido). */
export function migrateApprovalConfigJson(json: string): string | null {
  let c: unknown
  try {
    c = JSON.parse(json)
  } catch {
    return null
  }
  if (!c || typeof c !== 'object' || Array.isArray(c)) return null
  const next = migrateApprovalConfig(c as Partial<ChatConfig>, { assumeLegacy: true })
  return next === c ? null : JSON.stringify(next)
}

export function migrateApprovalModes(conn: Database.Database): ApprovalMigrationStats {
  const stats: ApprovalMigrationStats = { skipped: false, chats: 0, presets: 0 }
  const flag = conn
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get(APPROVAL_MODES_MIGRATION_FLAG)
  if (flag) return { ...stats, skipped: true }
  const tx = conn.transaction(() => {
    for (const table of ['chats', 'presets'] as const) {
      const rows = conn
        .prepare(
          `SELECT id, config_json FROM ${table} WHERE config_json LIKE '%"autoApprove"%' OR config_json LIKE '%"smartApprove"%'`
        )
        .all() as { id: string; config_json: string }[]
      const upd = conn.prepare(`UPDATE ${table} SET config_json = ? WHERE id = ?`)
      for (const r of rows) {
        const c = migrateApprovalConfigJson(r.config_json)
        if (c) {
          upd.run(c, r.id)
          stats[table]++
        }
      }
    }
    conn
      .prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
      .run(APPROVAL_MODES_MIGRATION_FLAG, 'true')
  })
  tx()
  return stats
}
