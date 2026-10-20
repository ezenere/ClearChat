// Host: arquivos do chat para um controle remoto — comandos `fs.list` / `fs.read`
// (docs/SYNC_PROTOCOL.md §8.6, desde 1.3.0). Sem Electron (testável).
//
// Segurança: as regras são EXATAMENTE as da aba Arquivos / visualizador / tools de leitura do chat
// neste dispositivo — raiz = `config.cwd`; com `confineToRoot` (padrão), nada fora dela após
// realpath (symlink para fora = negado); sem confinamento, o mesmo que a aba Arquivos local já
// mostra. Só arquivos comuns (diretório, FIFO, dispositivo → recusado). Nada além do que um
// controle remoto já consegue pedir ao agente deste chat (read_file / list_dir).
import { constants, promises as fs } from 'fs'
import { homedir } from 'os'
import { basename, resolve } from 'path'
import { detectViewerKind, viewerMime, VIEWER_LIMITS } from '@shared/fileViewer'
import { REMOTE_FS_LIMITS, type RemoteFsEntry, type RemoteFsRejectCode } from '@shared/remoteFs'
import { listDir } from '../fsapi'
import { locate } from '../fileViewer'
import { assertInsideRoot, resolvePath } from '../tools/util'

/** Raiz do chat neste dispositivo (de `chats.config_json`). */
export interface ChatRoot {
  cwd: string
  confine: boolean
}

export type RemoteFsLimits = Pick<
  typeof REMOTE_FS_LIMITS,
  'chunkBytes' | 'maxFileBytes' | 'listMaxEntries' | 'listMaxJsonBytes'
>

/** Recusa com código (vai no `remote.result` junto com o texto em pt-BR). */
export class RemoteFsError extends Error {
  code: RemoteFsRejectCode
  constructor(code: RemoteFsRejectCode, message: string) {
    super(message)
    this.code = code
  }
}

/** Raiz/confinamento a partir do `config_json` do chat (cwd ausente = home, como o repo). */
export function chatRootFrom(configJson: string | null | undefined): ChatRoot {
  let cfg: { cwd?: unknown; confineToRoot?: unknown } = {}
  try {
    cfg = configJson ? (JSON.parse(configJson) as typeof cfg) : {}
  } catch {
    cfg = {}
  }
  return {
    cwd: typeof cfg.cwd === 'string' && cfg.cwd ? cfg.cwd : homedir(),
    confine: cfg.confineToRoot !== false
  }
}

const isErrno = (e: unknown, ...codes: string[]): boolean =>
  codes.includes((e as NodeJS.ErrnoException)?.code ?? '')

function requirePath(path: unknown, allowEmpty: boolean): string {
  if (path === undefined || path === null || path === '') {
    if (allowEmpty) return ''
    throw new RemoteFsError('invalid', 'Caminho inválido.')
  }
  if (typeof path !== 'string' || path.includes('\0') || path.length > 4096)
    throw new RemoteFsError('invalid', 'Caminho inválido.')
  return path.trim()
}

/** `fs.list`: pasta do chat (vazio = a raiz). Pastas primeiro, como a aba Arquivos. */
export async function hostListDir(
  chat: ChatRoot,
  path: unknown,
  limits: RemoteFsLimits = REMOTE_FS_LIMITS
): Promise<{
  dir: string
  root: string
  confine: boolean
  truncated: boolean
  entries: RemoteFsEntry[]
}> {
  const p = requirePath(path, true)
  const root = resolve(chat.cwd)
  const dir = p ? resolvePath(root, p) : root
  if (chat.confine) {
    try {
      await assertInsideRoot(root, dir, p || dir)
    } catch {
      throw new RemoteFsError(
        'denied',
        'Acesso negado: a pasta fica fora do diretório raiz do chat.'
      )
    }
  }
  let list
  try {
    const st = await fs.stat(dir)
    if (!st.isDirectory()) throw new RemoteFsError('missing', 'Não é uma pasta.')
    list = await listDir(dir)
  } catch (e) {
    if (e instanceof RemoteFsError) throw e
    if (isErrno(e, 'EACCES', 'EPERM'))
      throw new RemoteFsError('denied', 'Sem permissão para ler a pasta.')
    throw new RemoteFsError('missing', 'Pasta não encontrada.')
  }
  const entries: RemoteFsEntry[] = []
  let bytes = 0
  let truncated = false
  for (const d of list) {
    const e: RemoteFsEntry = d.isDir
      ? { name: d.name, kind: 'dir', mtime: Math.round(d.mtime) }
      : { name: d.name, kind: 'file', size: d.size, mtime: Math.round(d.mtime) }
    bytes += JSON.stringify(e).length + 1
    if (entries.length >= limits.listMaxEntries || bytes > limits.listMaxJsonBytes) {
      truncated = true
      break
    }
    entries.push(e)
  }
  return { dir, root, confine: chat.confine, truncated, entries }
}

const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0)

/**
 * `fs.read`: até `chunkBytes` de um arquivo do chat a partir de `offset` (`length: 0` = só
 * tamanho/mtime). Nunca além de `maxFileBytes`. `mime` só no pedaço do começo (offset 0).
 */
export async function hostReadFile(
  chat: ChatRoot,
  path: unknown,
  offset: unknown,
  length: unknown,
  limits: RemoteFsLimits = REMOTE_FS_LIMITS
): Promise<{ size: number; mtime: number; mime?: string; offset: number; data: string }> {
  const p = requirePath(path, false)
  if (!Number.isSafeInteger(offset) || (offset as number) < 0)
    throw new RemoteFsError('invalid', 'Pedido inválido (offset).')
  if (!Number.isSafeInteger(length) || (length as number) < 0)
    throw new RemoteFsError('invalid', 'Pedido inválido (length).')
  const off = offset as number
  const abs = resolvePath(resolve(chat.cwd), p)
  const loc = await locate({ config: { cwd: chat.cwd, confineToRoot: chat.confine } }, abs)
  if ('ok' in loc)
    throw new RemoteFsError(loc.reason === 'denied' ? 'denied' : 'missing', loc.message)
  const max = limits.maxFileBytes
  if ((length as number) > 0 && off >= max)
    throw new RemoteFsError(
      'too_large',
      `Arquivo grande demais para buscar do host (máximo ${Math.round(max / 1024 / 1024)} MB).`
    )
  const len = Math.min(length as number, limits.chunkBytes, Math.max(0, max - off))
  let fh: fs.FileHandle
  try {
    // O_NONBLOCK: um FIFO trocado no lugar depois da checagem não trava o host; O_NOFOLLOW: o
    // realpath conferido não pode ter virado symlink
    fh = await fs.open(loc.real, OPEN_FLAGS)
  } catch (e) {
    if (isErrno(e, 'EACCES', 'EPERM'))
      throw new RemoteFsError('denied', 'Sem permissão para ler o arquivo.')
    throw new RemoteFsError('missing', 'Arquivo não encontrado.')
  }
  try {
    const st = await fh.stat()
    if (!st.isFile()) throw new RemoteFsError('missing', 'Não é um arquivo comum.')
    const n = Math.max(0, Math.min(len, st.size - off))
    const buf = Buffer.alloc(n)
    let got = 0
    while (got < n) {
      const { bytesRead } = await fh.read(buf, got, n - got, off + got)
      if (!bytesRead) break
      got += bytesRead
    }
    const data = buf.subarray(0, got)
    let mime: string | undefined
    if (off === 0) {
      let head: Uint8Array = data.subarray(0, VIEWER_LIMITS.sniffBytes)
      if (head.length < Math.min(st.size, VIEWER_LIMITS.sniffBytes)) {
        const h = Buffer.alloc(Math.min(st.size, VIEWER_LIMITS.sniffBytes))
        const { bytesRead } = await fh.read(h, 0, h.length, 0)
        head = h.subarray(0, bytesRead)
      }
      const name = basename(loc.real)
      mime = viewerMime(detectViewerKind(name, head), name, head)
    }
    return {
      size: st.size,
      mtime: Math.round(st.mtimeMs),
      ...(mime ? { mime } : {}),
      offset: off,
      data: data.toString('base64')
    }
  } finally {
    await fh.close()
  }
}
