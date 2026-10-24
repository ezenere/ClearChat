// Extrator mínimo de .tar.gz em streaming (o Python portátil do python-build-standalone vem em
// tar.gz) — sem depender do `tar` do sistema. Suporta ustar, nomes longos GNU (`L`/`K`), cabeçalhos
// pax (`x`/`g`: path/linkpath), arquivos, pastas, symlinks e hardlinks. Seguro: caminho absoluto,
// `..` ou symlink que aponta para fora da pasta de destino → erro (nada é escrito fora dela).
import { createReadStream, createWriteStream, type WriteStream } from 'node:fs'
import { chmod, copyFile, mkdir, symlink } from 'node:fs/promises'
import { createGunzip } from 'node:zlib'
import { dirname, isAbsolute, normalize, relative, resolve } from 'node:path'

const BLOCK = 512

function cstr(buf: Buffer, start: number, len: number): string {
  const sub = buf.subarray(start, start + len)
  const z = sub.indexOf(0)
  return (z >= 0 ? sub.subarray(0, z) : sub).toString('utf8')
}

function octal(buf: Buffer, start: number, len: number): number {
  const sub = buf.subarray(start, start + len)
  // base-256 (GNU) para tamanhos enormes
  if (sub[0] & 0x80) {
    let n = 0
    for (let i = 1; i < sub.length; i++) n = n * 256 + sub[i]
    return n
  }
  const s = cstr(buf, start, len).trim()
  return s ? parseInt(s, 8) : 0
}

function parsePax(data: Buffer): Record<string, string> {
  const out: Record<string, string> = {}
  let i = 0
  while (i < data.length) {
    const sp = data.indexOf(0x20, i)
    if (sp < 0) break
    const len = parseInt(data.subarray(i, sp).toString('utf8'), 10)
    if (!len || len <= 0) break
    const rec = data.subarray(sp + 1, i + len - 1).toString('utf8')
    const eq = rec.indexOf('=')
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1)
    i += len
  }
  return out
}

/** Caminho relativo seguro dentro de `root` (lança para absoluto/`..`). */
export function safeTarPath(root: string, name: string): string {
  const clean = name.replace(/\\/g, '/').replace(/^\.\/+/, '')
  if (!clean || isAbsolute(clean) || /^[A-Za-z]:/.test(clean))
    throw new Error(`entrada do tar com caminho inválido: ${name}`)
  const target = resolve(root, normalize(clean))
  const rel = relative(root, target)
  if (rel.startsWith('..') || isAbsolute(rel))
    throw new Error(`entrada do tar fora da pasta: ${name}`)
  return target
}

export interface ExtractTarOptions {
  /** Progresso em bytes LIDOS do arquivo compactado. */
  onProgress?: (bytes: number) => void
  signal?: AbortSignal
}

/** Extrai `archive` (.tar.gz) para `dest` (criado se faltar). */
export async function extractTarGz(
  archive: string,
  dest: string,
  opts: ExtractTarOptions = {}
): Promise<{ files: number }> {
  const root = resolve(dest)
  await mkdir(root, { recursive: true })
  const src = createReadStream(archive)
  let read = 0
  src.on('data', (b) => {
    read += b.length
    opts.onProgress?.(read)
  })
  const gz = src.pipe(createGunzip())
  let pending: Buffer = Buffer.alloc(0)
  let files = 0
  // estado da entrada corrente
  let remaining = 0
  let padding = 0
  // (atribuídos dentro de `header` — o cast evita o estreitamento do TS para `null`)
  let out = null as WriteStream | null
  let meta = null as {
    kind: 'pax' | 'gnuname' | 'gnulink'
    chunks: Buffer[]
    global?: boolean
  } | null
  let longName: string | null = null
  let longLink: string | null = null
  let pax: Record<string, string> = {}
  let globalPax: Record<string, string> = {}
  let fileMode = 0o644
  let filePath = ''
  const links: { path: string; target: string; hard: boolean }[] = []
  const modes: { path: string; mode: number }[] = []
  let ended = false

  const write = (w: WriteStream, chunk: Buffer): Promise<void> =>
    new Promise((res, rej) => {
      if (w.write(chunk)) res()
      else {
        w.once('drain', res)
        w.once('error', rej)
      }
    })
  const close = (w: WriteStream): Promise<void> =>
    new Promise((res, rej) => {
      w.end(() => res())
      w.once('error', rej)
    })

  async function header(h: Buffer): Promise<void> {
    if (h.every((b) => b === 0)) {
      ended = true
      return
    }
    const type = String.fromCharCode(h[156] || 0x30)
    const size = octal(h, 124, 12)
    const mode = octal(h, 100, 8)
    const prefix = cstr(h, 345, 155)
    let name = cstr(h, 0, 100)
    if (prefix && cstr(h, 257, 6).startsWith('ustar')) name = `${prefix}/${name}`
    const linkname = cstr(h, 157, 100)
    remaining = size
    padding = (BLOCK - (size % BLOCK)) % BLOCK
    if (type === 'x' || type === 'g' || type === 'L' || type === 'K') {
      meta = {
        kind: type === 'L' ? 'gnuname' : type === 'K' ? 'gnulink' : 'pax',
        chunks: [],
        global: type === 'g'
      }
      return
    }
    const p = { ...globalPax, ...pax }
    const path = longName ?? p.path ?? name
    const link = longLink ?? p.linkpath ?? linkname
    longName = longLink = null
    pax = {}
    const target = safeTarPath(root, path)
    if (type === '5') {
      await mkdir(target, { recursive: true })
      remaining = 0
      return
    }
    if (type === '2' || type === '1') {
      links.push({ path: target, target: link, hard: type === '1' })
      remaining = 0
      return
    }
    if (type === '0' || type === '\0' || type === '7') {
      await mkdir(dirname(target), { recursive: true })
      out = createWriteStream(target)
      fileMode = mode || 0o644
      filePath = target
      files++
      if (size === 0) {
        await close(out)
        modes.push({ path: target, mode: fileMode })
        out = null
      }
      return
    }
    // outros tipos (fifo, dispositivos): ignorados, corpo pulado
  }

  for await (const chunk of gz as AsyncIterable<Buffer>) {
    if (opts.signal?.aborted) {
      src.destroy()
      throw Object.assign(new Error('extração cancelada'), { name: 'AbortError' })
    }
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk
    while (!ended) {
      if (remaining > 0) {
        if (!pending.length) break
        const take = Math.min(remaining, pending.length)
        const part = pending.subarray(0, take)
        pending = pending.subarray(take)
        remaining -= take
        if (out) await write(out, Buffer.from(part))
        else if (meta) meta.chunks.push(Buffer.from(part))
        if (remaining === 0) {
          if (out) {
            await close(out)
            modes.push({ path: filePath, mode: fileMode })
            out = null
          } else if (meta) {
            const data = Buffer.concat(meta.chunks)
            if (meta.kind === 'gnuname') longName = cstr(data, 0, data.length)
            else if (meta.kind === 'gnulink') longLink = cstr(data, 0, data.length)
            else if (meta.global) globalPax = { ...globalPax, ...parsePax(data) }
            else pax = parsePax(data)
            meta = null
          }
        }
        continue
      }
      if (padding > 0) {
        if (!pending.length) break
        const take = Math.min(padding, pending.length)
        pending = pending.subarray(take)
        padding -= take
        continue
      }
      if (pending.length < BLOCK) break
      const h = pending.subarray(0, BLOCK)
      pending = pending.subarray(BLOCK)
      await header(Buffer.from(h))
    }
    if (ended) break
  }
  src.destroy()
  // links por último (o alvo de um hardlink pode vir depois na ordem do arquivo)
  for (const l of links) {
    await mkdir(dirname(l.path), { recursive: true })
    if (l.hard) {
      await copyFile(safeTarPath(root, l.target), l.path)
      continue
    }
    const resolved = resolve(dirname(l.path), l.target)
    const rel = relative(root, resolved)
    if (isAbsolute(l.target) || rel.startsWith('..') || isAbsolute(rel))
      throw new Error(`symlink do tar aponta para fora da pasta: ${l.target}`)
    try {
      await symlink(l.target, l.path)
    } catch (e) {
      // Windows sem permissão de symlink: copia o alvo (arquivos)
      if (process.platform === 'win32') await copyFile(resolved, l.path)
      else throw e
    }
  }
  if (process.platform !== 'win32')
    for (const m of modes) await chmod(m.path, m.mode & 0o777).catch(() => undefined)
  return { files }
}
