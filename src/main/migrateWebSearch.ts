// Migração idempotente dos buscadores do web_search (chamada por db.ts; sem Electron, testável).
import type Database from 'better-sqlite3'
import {
  normalizeEngines,
  normalizeKeys,
  SEARCH_ENGINES_SETTING,
  SEARCH_KEYS_SETTING
} from '@shared/webSearchSettings'

/**
 * Migração idempotente (antes do repo existir): grava a lista normalizada — instalações
 * antigas ganham DuckDuckGo → Brave (site) ligados e as APIs desligadas; listas salvas ganham os
 * buscadores que faltarem. Só escreve se mudou.
 */
export function migrateWebSearchEngines(conn: Database.Database): { changed: boolean } {
  const get = (key: string): unknown => {
    const r = conn.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      { value: string | null } | undefined
    try {
      return r?.value != null ? JSON.parse(r.value) : null
    } catch {
      return null
    }
  }
  const k = normalizeKeys(get(SEARCH_KEYS_SETTING))
  const stored = get(SEARCH_ENGINES_SETTING)
  const next = normalizeEngines(stored, (id) => !!k[id])
  if (JSON.stringify(stored) === JSON.stringify(next)) return { changed: false }
  conn
    .prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    )
    .run(SEARCH_ENGINES_SETTING, JSON.stringify(next))
  return { changed: true }
}
