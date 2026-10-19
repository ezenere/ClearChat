// Bundles de skill do sync (docs/SYNC_PROTOCOL.md §13): pasta da skill ↔ JSON
// `clearchat-skill-bundle` (dentro da moldura §3.9, cifrado como blob CCB1). Sem Electron.
import { promises as fs } from 'node:fs'
import { isAbsolute, join, normalize, sep } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { listSkillFiles } from '../skills/discovery'
import { COMPRESS_OVER, frameJson, hex, sha256, unframeJson } from './crypto'

export interface BundleFile {
  path: string
  size: number
  executable: boolean
  sha256: string
  data: string
}

export interface SkillBundle {
  format: 'clearchat-skill-bundle'
  v: 1
  name: string
  files: BundleFile[]
}

export interface BuiltBundle {
  bundle: SkillBundle
  /** Plaintext do blob (moldura + JSON). */
  plaintext: Uint8Array
  /** SHA-256 (hex) do plaintext. */
  sha256: string
  /** Hash estável do conteúdo (só caminhos + sha + bit de execução) — detecção de mudança local. */
  contentHash: string
  size: number
  files: number
}

/** Hash do conteúdo de uma pasta de skill (sem montar o bundle inteiro). */
export function bundleContentHash(
  files: Pick<BundleFile, 'path' | 'sha256' | 'executable'>[]
): string {
  const h = createHash('sha256')
  for (const f of [...files].sort((a, b) => a.path.localeCompare(b.path)))
    h.update(`${f.path}\0${f.sha256}\0${f.executable ? 1 : 0}\n`)
  return h.digest('hex')
}

export async function buildBundle(dir: string, name: string): Promise<BuiltBundle> {
  const list = await listSkillFiles(dir)
  const files: BundleFile[] = []
  let size = 0
  for (const f of list.files) {
    const abs = join(dir, ...f.path.split('/'))
    const data = await fs.readFile(abs)
    const st = await fs.stat(abs)
    size += data.byteLength
    files.push({
      path: f.path,
      size: data.byteLength,
      executable: (st.mode & 0o111) !== 0,
      sha256: hex(sha256(new Uint8Array(data))),
      data: data.toString('base64')
    })
  }
  if (!files.some((f) => f.path === 'SKILL.md'))
    throw new Error('A pasta da skill não tem SKILL.md.')
  files.sort((a, b) =>
    a.path === 'SKILL.md' ? -1 : b.path === 'SKILL.md' ? 1 : a.path.localeCompare(b.path)
  )
  const bundle: SkillBundle = { format: 'clearchat-skill-bundle', v: 1, name, files }
  const json = JSON.stringify(bundle)
  const plaintext = frameJson(json, Buffer.byteLength(json) > COMPRESS_OVER)
  return {
    bundle,
    plaintext,
    sha256: hex(sha256(plaintext)),
    contentHash: bundleContentHash(files),
    size,
    files: files.length
  }
}

/** Valida um caminho relativo do bundle (POSIX, sem `..`, sem absoluto). */
export function safeBundlePath(p: string): string | null {
  if (typeof p !== 'string' || !p || p.includes('\0') || p.includes('\\')) return null
  if (p.startsWith('/') || isAbsolute(p)) return null
  const parts = p.split('/')
  if (parts.some((x) => !x || x === '.' || x === '..')) return null
  return parts.join(sep)
}

export function parseBundle(plaintext: Uint8Array): SkillBundle {
  const obj = unframeJson(plaintext) as unknown as SkillBundle
  if (obj?.format !== 'clearchat-skill-bundle' || obj.v !== 1 || !Array.isArray(obj.files))
    throw new Error('Bundle de skill inválido.')
  return obj
}

/**
 * Extrai o bundle em `target` com troca atômica da pasta (escreve num temporário ao lado e
 * renomeia). Recusa caminhos que escapem da pasta e confere o sha256 de cada arquivo.
 */
export async function extractBundle(bundle: SkillBundle, target: string): Promise<string> {
  const parent = normalize(join(target, '..'))
  await fs.mkdir(parent, { recursive: true })
  const tmp = join(parent, `.tmp-${randomUUID()}`)
  await fs.mkdir(tmp, { recursive: true })
  try {
    for (const f of bundle.files) {
      const rel = safeBundlePath(f.path)
      if (!rel) throw new Error(`Caminho inválido no bundle: ${f.path}`)
      const data = Buffer.from(String(f.data ?? ''), 'base64')
      if (hex(sha256(new Uint8Array(data))) !== f.sha256)
        throw new Error(`Arquivo corrompido no bundle: ${f.path}`)
      const abs = join(tmp, rel)
      if (!normalize(abs).startsWith(tmp + sep)) throw new Error(`Caminho inválido: ${f.path}`)
      await fs.mkdir(join(abs, '..'), { recursive: true })
      await fs.writeFile(abs, data)
      if (f.executable) await fs.chmod(abs, 0o755)
    }
    const old = join(parent, `.old-${randomUUID()}`)
    let hadOld = false
    try {
      await fs.rename(target, old)
      hadOld = true
    } catch {
      /* não existia */
    }
    await fs.rename(tmp, target)
    if (hadOld) await fs.rm(old, { recursive: true, force: true })
  } catch (e) {
    await fs.rm(tmp, { recursive: true, force: true })
    throw e
  }
  return bundleContentHash(bundle.files)
}

/** Hash do conteúdo atual de uma pasta (para saber se a cópia foi editada localmente). */
export async function folderContentHash(dir: string): Promise<string | null> {
  try {
    const list = await listSkillFiles(dir)
    const files: Pick<BundleFile, 'path' | 'sha256' | 'executable'>[] = []
    for (const f of list.files) {
      const abs = join(dir, ...f.path.split('/'))
      const data = await fs.readFile(abs)
      const st = await fs.stat(abs)
      files.push({
        path: f.path,
        sha256: hex(sha256(new Uint8Array(data))),
        executable: (st.mode & 0o111) !== 0
      })
    }
    return bundleContentHash(files)
  } catch {
    return null
  }
}
