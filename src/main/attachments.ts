// Anexos no main: store content-addressed (userData/attachments/<sha256>.<ext>), codificação dos
// parts persistidos, expansão das referências para base64 na cópia enviada, truncamento do preview
// e GC de arquivos órfãos. Sem dependência do Electron (testável no Node). Ver SPEC.md → "Anexos".
import { createHash, randomUUID } from 'crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from 'fs'
import { join } from 'path'
import {
  ATTACHMENT_FILE_RE,
  ATTACHMENT_URL_PREFIX,
  attachmentUrl,
  audioFormat,
  classifyAttachment,
  formatSize,
  parseAttachmentUrl,
  textFileBlock
} from '@shared/attachments'
import { ATTACHMENT_LIMITS } from '@shared/limits'
import type { ApiMessage, AttachmentInfo, AttachmentMeta, ContentPart } from '@shared/types'

// ---------------- store ----------------

let dir: string | null = null

/** Define a pasta do store (index.ts: userData/attachments; testes: pasta temporária). */
export function setAttachmentsDir(d: string): void {
  dir = d
  cache.clear()
  cacheBytes = 0
}

export function attachmentsDir(): string {
  if (!dir) throw new Error('Store de anexos não inicializado.')
  return dir
}

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'application/pdf': 'pdf',
  'audio/wav': 'wav',
  'audio/mpeg': 'mp3'
}
const MIME_BY_EXT: Record<string, string> = Object.fromEntries(
  Object.entries(EXT_BY_MIME).map(([m, e]) => [e, m])
)
MIME_BY_EXT.txt = 'text/plain; charset=utf-8'

/** Mime para servir um arquivo do store (protocolo clearchat-attachment://). */
export function mimeForFile(file: string): string {
  const ext = file.includes('.') ? file.slice(file.lastIndexOf('.') + 1) : ''
  return MIME_BY_EXT[ext] ?? 'application/octet-stream'
}

/** Nome exibido/enviado: sem diretórios nem caracteres de controle, até 200 chars. */
export function sanitizeName(name: unknown): string {
  const base = (typeof name === 'string' ? name : '').split(/[\\/]/).pop() ?? ''
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  return (clean || 'arquivo').slice(0, 200)
}

/** UTF-8 válido e sem NUL nos primeiros 8 KB? (heurística de "é texto"). */
export function isUtf8Text(buf: Uint8Array): boolean {
  if (buf.subarray(0, 8000).includes(0)) return false
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf)
    return true
  } catch {
    return false
  }
}

export interface AttachmentInput {
  name: string
  mime?: string
  data: Uint8Array
}

/**
 * Valida (tamanho, tipo), classifica e salva no store (dedup por sha256; escrita atômica).
 * Erros legíveis em pt-BR.
 */
export function saveAttachment(input: AttachmentInput): AttachmentInfo {
  const name = sanitizeName(input.name)
  const data =
    input.data instanceof Uint8Array ? input.data : new Uint8Array(input.data as ArrayBuffer)
  if (!data.byteLength) throw new Error(`"${name}" está vazio.`)
  if (data.byteLength > ATTACHMENT_LIMITS.maxFileBytes)
    throw new Error(
      `"${name}" tem ${formatSize(data.byteLength)} — o limite por arquivo é ${formatSize(ATTACHMENT_LIMITS.maxFileBytes)}.`
    )
  const c = classifyAttachment(name, input.mime)
  let kind = c.kind
  let mime = c.mime
  if (kind === 'maybe-text' || kind === 'text') {
    if (!isUtf8Text(data)) {
      throw new Error(
        `"${name}" não parece ser texto (UTF-8) e o tipo não é suportado. Anexos aceitos: imagens (png, jpg, webp, gif), PDF, áudio (wav, mp3) e arquivos de texto/código.`
      )
    }
    kind = 'text'
    if (!mime || mime === 'application/octet-stream') mime = 'text/plain'
  }
  if (!kind) {
    throw new Error(
      `Tipo não suportado: "${name}"${mime ? ` (${mime})` : ''}. Anexos aceitos: imagens (png, jpg, webp, gif), PDF, áudio (wav, mp3) e arquivos de texto/código.`
    )
  }
  const sha256 = createHash('sha256').update(data).digest('hex')
  const ext = kind === 'text' ? 'txt' : (EXT_BY_MIME[mime] ?? 'bin')
  const file = `${sha256}.${ext}`
  const d = attachmentsDir()
  mkdirSync(d, { recursive: true })
  const path = join(d, file)
  if (!existsSync(path)) {
    const tmp = join(d, `.tmp-${randomUUID()}`)
    writeFileSync(tmp, data)
    renameSync(tmp, path)
  } else {
    // dedup: renova o mtime (o GC poupa arquivos recentes ainda não enviados)
    const t = new Date()
    try {
      utimesSync(path, t, t)
    } catch {
      /* */
    }
  }
  return { sha256, name, mime, size: data.byteLength, kind, file }
}

// leitura com cache LRU (o histórico é reenviado a cada passo do agente)
const CACHE_MAX = 96 * 1024 * 1024
const cache = new Map<string, Buffer>()
let cacheBytes = 0

export class MissingAttachmentError extends Error {}

/** Lê um arquivo do store. Ausente → erro legível (nunca crash). */
export function readAttachment(file: string, name?: string): Buffer {
  if (!ATTACHMENT_FILE_RE.test(file)) throw new Error(`Referência de anexo inválida: ${file}`)
  const hit = cache.get(file)
  if (hit) {
    cache.delete(file)
    cache.set(file, hit)
    return hit
  }
  let buf: Buffer
  try {
    buf = readFileSync(join(attachmentsDir(), file))
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT')
      throw new MissingAttachmentError(
        `Anexo não encontrado no disco: "${name ?? file}" (${join(attachmentsDir(), file)}). Apague a mensagem que contém esse anexo para continuar a conversa.`
      )
    throw e
  }
  if (buf.byteLength <= CACHE_MAX / 4) {
    cache.set(file, buf)
    cacheBytes += buf.byteLength
    for (const [k, v] of cache) {
      if (cacheBytes <= CACHE_MAX) break
      cache.delete(k)
      cacheBytes -= v.byteLength
    }
  }
  return buf
}

export function attachmentExists(file: string): boolean {
  return ATTACHMENT_FILE_RE.test(file) && !!dir && existsSync(join(dir, file))
}

// ---------------- codificação (parts persistidos) ----------------

/** Metadados privados persistidos no part (sem o sha256 solto: ele está em `file`). */
function metaOf(a: AttachmentInfo, extra: Partial<AttachmentMeta> = {}): AttachmentMeta {
  return { name: a.name, mime: a.mime, size: a.size, kind: a.kind, file: a.file, ...extra }
}

/** Corta texto no limite (em caracteres) com aviso. */
export function capText(
  text: string,
  max: number = ATTACHMENT_LIMITS.maxTextChars
): {
  text: string
  truncated: boolean
} {
  if (text.length <= max) return { text, truncated: false }
  return {
    text: `${text.slice(0, max)}\n[… arquivo cortado: mostrando ${max.toLocaleString('pt-BR')} de ${text.length.toLocaleString('pt-BR')} caracteres]`,
    truncated: true
  }
}

/**
 * Part persistido de um anexo:
 * - imagem → `{type:'image_url', image_url:{url:'clearchat-attachment://…'}}`
 * - PDF    → `{type:'file', file:{filename, file_data:'clearchat-attachment://…'}}`
 * - áudio  → `{type:'input_audio', input_audio:{data:'clearchat-attachment://…', format}}`
 * - texto  → `{type:'text', text:'<file name="…">\n…\n</file>'}` (conteúdo inline, cortado no limite)
 * Todos com `_attachment` (privado; removido na request).
 */
export function attachmentPart(a: AttachmentInfo): ContentPart {
  const url = attachmentUrl(a.file)
  switch (a.kind) {
    case 'image':
      return { type: 'image_url', image_url: { url }, _attachment: metaOf(a) }
    case 'pdf':
      return { type: 'file', file: { filename: a.name, file_data: url }, _attachment: metaOf(a) }
    case 'audio':
      return {
        type: 'input_audio',
        input_audio: { data: url, format: audioFormat(a.mime) },
        _attachment: metaOf(a)
      }
    case 'text': {
      const raw = readAttachment(a.file, a.name).toString('utf8')
      const { text, truncated } = capText(raw)
      return {
        type: 'text',
        text: textFileBlock(a.name, text),
        _attachment: metaOf(a, truncated ? { truncated: true } : {})
      }
    }
  }
}

/** Valida anexos vindos do renderer (IPC) contra o store. */
export function validateAttachments(list: unknown): AttachmentInfo[] {
  if (list == null) return []
  if (!Array.isArray(list)) throw new Error('Anexos inválidos.')
  if (list.length > ATTACHMENT_LIMITS.maxFiles)
    throw new Error(`No máximo ${ATTACHMENT_LIMITS.maxFiles} anexos por mensagem.`)
  let total = 0
  const out = list.map((x): AttachmentInfo => {
    const a = x as Partial<AttachmentInfo>
    if (!a || typeof a.file !== 'string' || !ATTACHMENT_FILE_RE.test(a.file))
      throw new Error('Anexo inválido.')
    if (!['image', 'pdf', 'audio', 'text'].includes(a.kind as string))
      throw new Error(`Tipo de anexo inválido: ${String(a.kind)}`)
    const path = join(attachmentsDir(), a.file)
    let size: number
    try {
      size = statSync(path).size
    } catch {
      throw new Error(`Anexo não encontrado no disco: "${sanitizeName(a.name)}". Anexe de novo.`)
    }
    total += size
    return {
      sha256: a.file.slice(0, 64),
      name: sanitizeName(a.name),
      mime: typeof a.mime === 'string' && a.mime ? a.mime : mimeForFile(a.file),
      size,
      kind: a.kind as AttachmentInfo['kind'],
      file: a.file
    }
  })
  if (total > ATTACHMENT_LIMITS.maxTotalBytes)
    throw new Error(
      `Os anexos somam ${formatSize(total)} — o limite por mensagem é ${formatSize(ATTACHMENT_LIMITS.maxTotalBytes)}.`
    )
  return out
}

/**
 * Conteúdo da mensagem do usuário: sem anexos → string (como sempre); com anexos →
 * `[...parts dos anexos, {type:'text', text}]` (texto por último: o breakpoint de cache no último
 * text part cobre a mensagem inteira; Anthropic recomenda imagens antes do texto). Texto vazio é omitido.
 */
export function buildUserContent(
  text: string,
  attachments: AttachmentInfo[]
): string | ContentPart[] {
  if (!attachments.length) return text
  const parts = attachments.map(attachmentPart)
  if (text.trim()) parts.push({ type: 'text', text })
  return parts
}

// ---------------- expansão (cópia enviada) ----------------

const toBase64 = (b: Buffer): string => b.toString('base64')

/** Remove campos privados (prefixo `_`) de um part. */
function stripPrivate(p: ContentPart): ContentPart {
  if (!p._attachment) return p
  const { _attachment: _a, ...rest } = p
  void _a
  return rest as ContentPart
}

/** Expande um part: referência → data URL/base64; remove `_attachment`. */
export function expandPart(
  p: ContentPart,
  read: (file: string, name?: string) => Buffer = readAttachment
): ContentPart {
  const meta = p._attachment
  const out = stripPrivate(p)
  if (out.type === 'image_url') {
    const file = parseAttachmentUrl(out.image_url.url)
    if (file) {
      const mime = meta?.mime || mimeForFile(file)
      return {
        ...out,
        image_url: {
          ...out.image_url,
          url: `data:${mime};base64,${toBase64(read(file, meta?.name))}`
        }
      }
    }
  } else if (out.type === 'file') {
    const file = parseAttachmentUrl(out.file.file_data)
    if (file) {
      const mime = meta?.mime || mimeForFile(file)
      return {
        ...out,
        file: { ...out.file, file_data: `data:${mime};base64,${toBase64(read(file, meta?.name))}` }
      }
    }
  } else if (out.type === 'input_audio') {
    const file = parseAttachmentUrl(out.input_audio.data)
    if (file)
      return { ...out, input_audio: { ...out.input_audio, data: toBase64(read(file, meta?.name)) } }
  }
  return out
}

/**
 * Cópia das mensagens com as referências de anexo expandidas e campos privados removidos.
 * Determinística (mesmos arquivos → mesmos bytes). Mensagens sem parts ficam idênticas (mesmo objeto).
 */
export function expandAttachments(
  messages: ApiMessage[],
  read: (file: string, name?: string) => Buffer = readAttachment
): ApiMessage[] {
  return messages.map((m) => {
    if ((m.role !== 'user' && m.role !== 'system') || typeof m.content === 'string') return m
    if (!m.content.some((p) => p._attachment || hasRef(p))) return m
    return { ...m, content: m.content.map((p) => expandPart(p, read)) } as ApiMessage
  })
}

function hasRef(p: ContentPart): boolean {
  if (p.type === 'image_url') return p.image_url.url.startsWith(ATTACHMENT_URL_PREFIX)
  if (p.type === 'file') return p.file.file_data.startsWith(ATTACHMENT_URL_PREFIX)
  if (p.type === 'input_audio') return p.input_audio.data.startsWith(ATTACHMENT_URL_PREFIX)
  return false
}

// ---------------- preview ----------------

const PREVIEW_KEEP = 24

function shortB64(value: string, prefix: string): string {
  const b64 = value.slice(prefix.length)
  const bytes =
    Math.floor((b64.length * 3) / 4) - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0)
  return `${prefix}${b64.slice(0, PREVIEW_KEEP)}…(${formatSize(bytes)})`
}

/**
 * Versão do body para exibição: base64 de anexos encurtado (`data:image/png;base64,iVBOR…(812 KB)`).
 * Retorna quantos valores foram encurtados (para a nota no modal).
 */
export function truncateBodyForPreview(body: Record<string, unknown>): {
  body: Record<string, unknown>
  truncated: number
} {
  const msgs = body.messages
  if (!Array.isArray(msgs)) return { body, truncated: 0 }
  let truncated = 0
  const dataPrefix = (s: string): string | null => {
    const m = /^data:[^;,]+;base64,/.exec(s)
    return m ? m[0] : null
  }
  const next = msgs.map((m: { content?: unknown }) => {
    if (!m || !Array.isArray(m.content)) return m
    let changed = false
    const content = (m.content as ContentPart[]).map((p) => {
      if (p.type === 'image_url' && p.image_url.url.length > 200) {
        const pre = dataPrefix(p.image_url.url)
        if (pre) {
          changed = true
          truncated++
          return { ...p, image_url: { ...p.image_url, url: shortB64(p.image_url.url, pre) } }
        }
      }
      if (p.type === 'file' && p.file.file_data.length > 200) {
        const pre = dataPrefix(p.file.file_data)
        if (pre) {
          changed = true
          truncated++
          return { ...p, file: { ...p.file, file_data: shortB64(p.file.file_data, pre) } }
        }
      }
      if (p.type === 'input_audio' && p.input_audio.data.length > 200) {
        changed = true
        truncated++
        return { ...p, input_audio: { ...p.input_audio, data: shortB64(p.input_audio.data, '') } }
      }
      return p
    })
    return changed ? { ...m, content } : m
  })
  return truncated ? { body: { ...body, messages: next }, truncated } : { body, truncated: 0 }
}

// ---------------- GC ----------------

/** Arquivos do store referenciados por alguma mensagem (`clearchat-attachment://<file>`). */
export function referencedFiles(messageJsons: Iterable<string>): Set<string> {
  const out = new Set<string>()
  const re = /clearchat-attachment:\/\/([0-9a-f]{64}(?:\.[a-z0-9]{1,10})?)/g
  for (const json of messageJsons) {
    for (const m of json.matchAll(re)) out.add(m[1])
  }
  return out
}

/** Lê do banco só as mensagens com referência (LIKE barato) — `db` é um better-sqlite3. */
export function referencedFilesInDb(db: {
  prepare(sql: string): { iterate(...a: unknown[]): IterableIterator<unknown> }
}): Set<string> {
  const rows = db
    .prepare(
      "SELECT message_json FROM messages WHERE message_json LIKE '%clearchat-attachment://%'"
    )
    .iterate() as IterableIterator<{ message_json: string }>
  return referencedFiles(
    (function* () {
      for (const r of rows) yield r.message_json
    })()
  )
}

/**
 * Apaga do store os arquivos não referenciados (e temporários de escrita interrompida).
 * Só toca em nomes no formato do store e mais velhos que `graceMs` (anexos recém-escolhidos no
 * composer, ainda não enviados, ficam). Nunca apaga pastas nem outros arquivos.
 */
export function gcAttachments(
  storeDir: string,
  referenced: Set<string>,
  opts: { now?: number; graceMs?: number } = {}
): { deleted: string[]; kept: number } {
  const now = opts.now ?? Date.now()
  const grace = opts.graceMs ?? 60 * 60_000
  const deleted: string[] = []
  let kept = 0
  let names: string[]
  try {
    names = readdirSync(storeDir)
  } catch {
    return { deleted, kept }
  }
  for (const name of names) {
    const isStore = ATTACHMENT_FILE_RE.test(name)
    const isTmp = /^\.tmp-[0-9a-f-]{36}$/.test(name)
    if (!isStore && !isTmp) continue
    if (isStore && referenced.has(name)) {
      kept++
      continue
    }
    const path = join(storeDir, name)
    try {
      const st = statSync(path)
      if (!st.isFile() || now - st.mtimeMs < grace) {
        kept++
        continue
      }
      rmSync(path)
      deleted.push(name)
    } catch {
      /* corrida/permissão: ignora */
    }
  }
  return { deleted, kept }
}
