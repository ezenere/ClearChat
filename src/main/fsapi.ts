// fs.* para o renderer: listDir (pastas primeiro), readFile (limite ~1MB + detecção de binário).
import { promises as fs } from 'fs'
import { homedir } from 'os'
import { join, resolve } from 'path'
import type { FileContent } from '@shared/ipc'
import type { DirEntry } from '@shared/types'

const MAX_READ = 1024 * 1024

const expand = (p: string): string => {
  const s = (p ?? '').trim() || homedir()
  if (s === '~') return homedir()
  if (s.startsWith('~/')) return join(homedir(), s.slice(2))
  return resolve(s)
}

export async function listDir(path: string): Promise<DirEntry[]> {
  const dir = expand(path)
  const dirents = await fs.readdir(dir, { withFileTypes: true })
  const entries = await Promise.all(
    dirents.map(async (d): Promise<DirEntry> => {
      const p = join(dir, d.name)
      try {
        const st = await fs.stat(p)
        return { name: d.name, path: p, isDir: st.isDirectory(), size: st.size, mtime: st.mtimeMs }
      } catch {
        return { name: d.name, path: p, isDir: d.isDirectory(), size: 0, mtime: 0 }
      }
    })
  )
  return entries.sort((a, b) =>
    a.isDir === b.isDir
      ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
      : a.isDir
        ? -1
        : 1
  )
}

export async function readFile(path: string): Promise<FileContent> {
  const p = expand(path)
  const st = await fs.stat(p)
  if (st.isDirectory()) throw new Error(`"${p}" é um diretório.`)
  const fh = await fs.open(p, 'r')
  try {
    const len = Math.min(st.size, MAX_READ)
    const buf = Buffer.alloc(len)
    const { bytesRead } = await fh.read(buf, 0, len, 0)
    const data = buf.subarray(0, bytesRead)
    const sample = data.subarray(0, 8000)
    if (sample.includes(0)) return { content: '', truncated: st.size > MAX_READ, binary: true }
    let content = data.toString('utf8')
    // corta caractere UTF-8 incompleto no fim
    if (st.size > MAX_READ) content = content.replace(/�+$/, '')
    return { content, truncated: st.size > MAX_READ, binary: false }
  } finally {
    await fh.close()
  }
}

export const homeDir = (): string => homedir()

/** Cria uma pasta (o pai precisa existir). Erro legível se já existir. */
export async function mkdir(path: string): Promise<string> {
  const p = expand(path)
  const name = p.split('/').pop() ?? ''
  if (!name || /[\0]/.test(name)) throw new Error('Nome de pasta inválido.')
  try {
    await fs.mkdir(p)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'EEXIST') throw new Error(`Já existe: ${p}`, { cause: e })
    if (code === 'ENOENT') throw new Error(`A pasta-pai não existe: ${p}`, { cause: e })
    if (code === 'EACCES' || code === 'EPERM')
      throw new Error(`Sem permissão para criar ${p}`, { cause: e })
    throw e
  }
  return p
}
