// Extração de ZIP mínima em TS puro (SPEC → "Áudio → Runtime local de STT"): parser do diretório
// central + inflate das entries `store` (0) e `deflate` (8) via `zlib.inflateRaw`, com verificação
// (tamanho + CRC-32 por entry) e caminhos seguros (nada de absoluto, `..`, letra de unidade ou
// separador invertido — sem zip-slip). É o que o `.zip` do Vosk precisa (16 entries, store+deflate)
// — por isso sem dependência nova. Zip64 não é suportado (o artefato do Vosk tem 32 MB; entrada
// zip64 → erro legível). Testes: `e2e/sttLocal.test.ts` (fixture gerada no próprio teste).
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { inflateRaw } from 'node:zlib'

const inflateRawAsync = promisify(inflateRaw)

const EOCD_SIG = 0x06054b50 // End Of Central Directory
const CDIR_SIG = 0x02014b50 // central directory file header
const LFH_SIG = 0x04034b50 // local file header

/** Entry do diretório central (só o que a extração precisa). */
export interface ZipEntry {
  /** Nome no zip (com `/`); termina em `/` para diretórios. */
  name: string
  /** 0 = store, 8 = deflate. */
  method: number
  /** CRC-32 do conteúdo (verificado na extração). */
  crc32: number
  compressedSize: number
  uncompressedSize: number
  localHeaderOffset: number
  isDirectory: boolean
}

// ---------------- CRC-32 (tabela, polinômio 0xEDB88320) ----------------

let crcTable: Uint32Array | null = null

function getCrcTable(): Uint32Array {
  if (crcTable) return crcTable
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  crcTable = t
  return t
}

/** CRC-32 (IEEE) dos bytes; `seed` permite encadear pedaços. */
export function crc32(data: Uint8Array, seed = 0): number {
  const t = getCrcTable()
  let c = (seed ^ 0xffffffff) >>> 0
  for (let i = 0; i < data.length; i++) c = (t[(c ^ data[i]) & 0xff] ^ (c >>> 8)) >>> 0
  return (c ^ 0xffffffff) >>> 0
}

// ---------------- parser do diretório central ----------------

const u16 = (b: Uint8Array, o: number): number => b[o] | (b[o + 1] << 8)
const u32 = (b: Uint8Array, o: number): number =>
  (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0

/**
 * Lê as entries do diretório central de um zip em memória. Erros legíveis para zip truncado,
 * assinaturas quebradas e zip64 (não suportado — fora do tamanho do artefato do Vosk).
 */
export function readZipEntries(buf: Uint8Array): ZipEntry[] {
  // EOCD: as últimas 22 bytes + comentário (máx. 64 KiB) — procura a assinatura de trás para frente
  const maxBack = Math.min(buf.length, 22 + 0xffff)
  let eocd = -1
  for (let i = buf.length - 22; i >= buf.length - maxBack; i--) {
    if (i < 0) break
    if (u32(buf, i) === EOCD_SIG) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('zip inválido: assinatura final (EOCD) não encontrada')
  const total = u16(buf, eocd + 10)
  const cdSize = u32(buf, eocd + 12)
  const cdOffset = u32(buf, eocd + 16)
  if (cdOffset === 0xffffffff || cdSize === 0xffffffff)
    throw new Error('zip em formato zip64 não é suportado (além do tamanho esperado dos modelos)')
  if (cdOffset + cdSize > buf.length)
    throw new Error('zip inválido: diretório central fora dos limites do arquivo')

  const entries: ZipEntry[] = []
  let o = cdOffset
  for (let i = 0; i < total; i++) {
    if (o + 46 > buf.length || u32(buf, o) !== CDIR_SIG)
      throw new Error(`zip inválido: entrada ${i} do diretório central corrompida`)
    const method = u16(buf, o + 10)
    const crc = u32(buf, o + 16)
    const compSize = u32(buf, o + 20)
    const uncompSize = u32(buf, o + 24)
    const nameLen = u16(buf, o + 28)
    const extraLen = u16(buf, o + 30)
    const commentLen = u16(buf, o + 32)
    const localOffset = u32(buf, o + 42)
    const name = new TextDecoder('utf-8').decode(buf.subarray(o + 46, o + 46 + nameLen))
    entries.push({
      name,
      method,
      crc32: crc,
      compressedSize: compSize,
      uncompressedSize: uncompSize,
      localHeaderOffset: localOffset,
      isDirectory: name.endsWith('/')
    })
    o += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

// ---------------- caminhos seguros (sem zip-slip) ----------------

/**
 * Nome de entry → segmentos de caminho seguros. Rejeita absoluto, `..`, letra de unidade (`C:`),
 * NUL e nomes vazios; `\` é tratado como separador (zips feitos no Windows).
 */
export function safeEntrySegments(rawName: string): string[] {
  const name = rawName.replace(/\\/g, '/').replace(/\0/g, '')
  if (!name || name.startsWith('/') || /^[a-zA-Z]:/.test(name))
    throw new Error(`entry com caminho inseguro no zip: ${JSON.stringify(rawName)}`)
  const parts = name.split('/').filter((p) => p.length > 0 && p !== '.')
  if (!parts.length || parts.some((p) => p === '..'))
    throw new Error(`entry com caminho inseguro no zip: ${JSON.stringify(rawName)}`)
  return parts
}

// ---------------- extração ----------------

export interface ExtractZipOptions {
  /**
   * Raiz única esperada das entries (ex.: `vosk-model-small-pt-0.3` do zip do Vosk): quando
   * informada, entry fora dela é erro legível.
   */
  expectedRoot?: string
  /** Progresso: entry, arquivos já gravados e total de entries. */
  onEntry?: (entry: ZipEntry, done: number, total: number) => void
}

export interface ExtractZipResult {
  /** Entries de arquivo extraídas (diretórios não contam). */
  files: number
  /** Bytes escritos (tamanho descomprimido). */
  bytes: number
  /** Raiz comum das entries quando todas vivem num diretório único (senão null). */
  rootDir: string | null
}

/**
 * Extrai o zip (em memória ou caminho) para `destDir`, verificando tamanho e CRC-32 de cada entry
 * e confinando os caminhos a `destDir`. Só os métodos store (0) e deflate (8). Idempotente na
 * prática (reescreve os arquivos); falha no meio deixa o que já escreveu (a próxima chamada
 * regrava por cima — a checagem de integridade é por entry).
 */
export async function extractZipToDir(
  zip: Uint8Array | string,
  destDir: string,
  opts: ExtractZipOptions = {}
): Promise<ExtractZipResult> {
  const buf = zip instanceof Uint8Array ? zip : new Uint8Array(await readFileBytes(zip))
  const entries = readZipEntries(buf)
  if (!entries.length) throw new Error('zip vazio: nada a extrair')
  const dest = resolve(destDir)
  let files = 0
  let bytes = 0
  let root: string | null = null
  let done = 0
  for (const entry of entries) {
    const segs = safeEntrySegments(entry.name)
    if (opts.expectedRoot && segs[0] !== opts.expectedRoot)
      throw new Error(
        `entry fora da pasta esperada ${JSON.stringify(opts.expectedRoot)}: ${JSON.stringify(entry.name)}`
      )
    if (root === null) root = segs.length > 1 ? segs[0] : null
    else if (segs.length <= 1 || segs[0] !== root) root = null
    const target = resolve(join(dest, ...segs))
    if (target !== dest && !target.startsWith(dest + sep))
      throw new Error(`entry com caminho inseguro no zip: ${JSON.stringify(entry.name)}`)
    done++
    if (entry.isDirectory) {
      await mkdir(target, { recursive: true })
      opts.onEntry?.(entry, done, entries.length)
      continue
    }
    const data = await inflateEntry(buf, entry)
    if (data.length !== entry.uncompressedSize)
      throw new Error(
        `zip inválido: ${JSON.stringify(entry.name)} descomprimiu ${data.length} bytes (esperado ${entry.uncompressedSize})`
      )
    if (crc32(data) !== entry.crc32)
      throw new Error(`zip inválido: CRC-32 divergente em ${JSON.stringify(entry.name)}`)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, data)
    files++
    bytes += data.length
    opts.onEntry?.(entry, done, entries.length)
  }
  return { files, bytes, rootDir: root }
}

/** Descomprime a entry (store = fatia direta; deflate = inflateRaw) a partir do local header. */
async function inflateEntry(buf: Uint8Array, entry: ZipEntry): Promise<Uint8Array> {
  const o = entry.localHeaderOffset
  if (o + 30 > buf.length || u32(buf, o) !== LFH_SIG)
    throw new Error(`zip inválido: cabeçalho local ausente para ${JSON.stringify(entry.name)}`)
  const nameLen = u16(buf, o + 26)
  const extraLen = u16(buf, o + 28)
  const start = o + 30 + nameLen + extraLen
  const end = start + entry.compressedSize
  if (end > buf.length)
    throw new Error(`zip inválido: dados truncados em ${JSON.stringify(entry.name)}`)
  const raw = buf.subarray(start, end)
  if (entry.method === 0) return new Uint8Array(raw)
  if (entry.method === 8) return new Uint8Array(await inflateRawAsync(raw))
  throw new Error(
    `zip: método de compressão ${entry.method} não suportado em ${JSON.stringify(entry.name)} (esperado store/deflate)`
  )
}

async function readFileBytes(path: string): Promise<ArrayBuffer> {
  const { readFile } = await import('node:fs/promises')
  const b = await readFile(path)
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
}
