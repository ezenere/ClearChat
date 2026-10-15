// Migração de dados do nome antigo do app ("CleartChat", um typo) para "ClearChat".
// Sem dependência do Electron (testável no Node puro): quem chama passa o diretório userData.
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync } from 'fs'
import { basename, dirname, join } from 'path'
import Database from 'better-sqlite3'

export const DB_FILENAME = 'clearchat.db'
export const LEGACY_DIR_NAME = 'CleartChat'
export const LEGACY_DB_FILENAME = 'cleartchat.db'

export interface LegacyMigrationResult {
  migrated: boolean
  /** Motivo quando não migrou (ou método usado quando migrou). */
  reason: string
  from?: string
  to?: string
}

/**
 * Se `<userData>/clearchat.db` não existe mas `<irmão CleartChat>/cleartchat.db` existe, copia o
 * banco antigo para o novo local com o novo nome. O diretório antigo fica intacto.
 *
 * A cópia usa `VACUUM INTO` numa conexão somente leitura (cópia consistente, já incorporando o
 * WAL); se falhar, copia os arquivos crus (.db + -wal + -shm) — o SQLite recupera o WAL ao abrir.
 * Grava primeiro num arquivo temporário e renomeia no fim, para nunca deixar um banco pela metade.
 */
export function migrateLegacyData(
  userDataDir: string,
  opts: { legacyDir?: string } = {}
): LegacyMigrationResult {
  const to = join(userDataDir, DB_FILENAME)
  if (existsSync(to)) return { migrated: false, reason: 'already-exists', to }
  const legacyDir = opts.legacyDir ?? join(dirname(userDataDir), LEGACY_DIR_NAME)
  const from = join(legacyDir, LEGACY_DB_FILENAME)
  if (legacyDir === userDataDir && basename(from) === DB_FILENAME) {
    return { migrated: false, reason: 'same-dir' }
  }
  if (!existsSync(from)) return { migrated: false, reason: 'no-legacy-db', from }

  mkdirSync(userDataDir, { recursive: true })
  const tmp = `${to}.migrating`
  const cleanupTmp = (): void => {
    for (const s of ['', '-wal', '-shm', '-journal']) rmSync(tmp + s, { force: true })
  }
  cleanupTmp()

  try {
    const src = new Database(from, { readonly: true, fileMustExist: true })
    try {
      src.prepare('VACUUM INTO ?').run(tmp)
    } finally {
      src.close()
    }
    renameSync(tmp, to)
    return { migrated: true, reason: 'vacuum-into', from, to }
  } catch (e) {
    cleanupTmp()
    console.warn('[clearchat] migração: VACUUM INTO falhou, copiando arquivos:', e)
  }

  // Fallback: cópia crua. O -wal/-shm acompanham o novo nome (o SQLite os associa pelo nome).
  try {
    for (const s of ['-wal', '-shm']) {
      if (existsSync(from + s)) copyFileSync(from + s, to + s)
    }
    copyFileSync(from, tmp)
    renameSync(tmp, to)
    // Confere que a cópia abre (e incorpora o WAL nela); senão desfaz para o app começar limpo.
    const check = new Database(to, { fileMustExist: true })
    try {
      check.prepare('SELECT count(*) FROM sqlite_master').get()
    } finally {
      check.close()
    }
    return { migrated: true, reason: 'file-copy', from, to }
  } catch (e) {
    rmSync(to, { force: true })
    cleanupTmp()
    for (const s of ['-wal', '-shm']) rmSync(to + s, { force: true })
    return { migrated: false, reason: `error: ${(e as Error).message}`, from }
  }
}
