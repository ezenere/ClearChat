// Questionário (ask_user): resolve ícones/imagens/ajuda das opções para arquivos do store de anexos
// (servidos ao renderer por clearchat-attachment://, exibidos SEMPRE via <img>). URL remota →
// baixada aqui no main (timeout, limite de tamanho, só image/*); caminho local → relativo ao raiz
// (confinado se confineToRoot); "<svg…>" inline / data URL → salvos como arquivo. Falha numa imagem
// não derruba a tool: a imagem só não aparece e uma nota vai no resultado ao modelo.
// Ver SPEC.md → "Questionário (ask_user)".
import { promises as fs } from 'fs'
import { attachmentUrl } from '@shared/attachments'
import {
  ASK_USER_LIMITS,
  classifyHelp,
  classifyIcon,
  classifyImageRef,
  type RawAskUserQuestion
} from '@shared/askUser'
import type { AskUserOption, AskUserQuestion } from '@shared/types'
import { saveStoreFile } from './attachments'
import { assertInsideRoot, resolvePath } from './tools/util'

export interface ImageResolveCtx {
  /** Diretório raiz (base dos caminhos relativos). */
  root: string
  /** confineToRoot: caminhos fora do raiz são recusados. */
  confine: boolean
  signal?: AbortSignal
  /** Testes: fetch injetável. */
  fetchImpl?: typeof fetch
}

const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg'
}

/** Formato real pelos bytes (png/jpg/gif/webp/svg) ou null. */
export function sniffImage(buf: Uint8Array): string | null {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength)
  if (b.length >= 8 && b.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') return 'png'
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg'
  if (b.length >= 6 && /^GIF8[79]a$/.test(b.subarray(0, 6).toString('latin1'))) return 'gif'
  if (
    b.length >= 12 &&
    b.subarray(0, 4).toString('latin1') === 'RIFF' &&
    b.subarray(8, 12).toString('latin1') === 'WEBP'
  )
    return 'webp'
  const head = b
    .subarray(0, 4096)
    .toString('utf8')
    .replace(/^\uFEFF/, '')
  if (/^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE[^>]*>\s*)?<svg[\s>]/i.test(head))
    return 'svg'
  return null
}

class ImageError extends Error {}

const sizeErr = (n: number): ImageError =>
  new ImageError(
    `${(n / 1024 / 1024).toFixed(1)} MB — máximo ${ASK_USER_LIMITS.imageBytes / 1024 / 1024} MB`
  )

function store(data: Uint8Array): string {
  const fmt = sniffImage(data)
  if (!fmt) throw new ImageError('não é uma imagem png/jpeg/webp/gif/svg')
  return attachmentUrl(saveStoreFile(data, fmt))
}

async function download(url: string, ctx: ImageResolveCtx): Promise<string> {
  const timeout = AbortSignal.timeout(ASK_USER_LIMITS.downloadTimeoutMs)
  const signal = ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout
  let res: Response
  try {
    res = await (ctx.fetchImpl ?? fetch)(url, {
      signal,
      redirect: 'follow',
      headers: { Accept: 'image/png,image/jpeg,image/webp,image/gif,image/svg+xml;q=0.9' }
    })
  } catch (e) {
    if (ctx.signal?.aborted) throw e
    if (timeout.aborted)
      throw new ImageError(`tempo esgotado (${ASK_USER_LIMITS.downloadTimeoutMs / 1000} s)`)
    throw new ImageError(`falha de rede: ${(e as Error).message}`)
  }
  if (!res.ok) {
    void res.body?.cancel().catch(() => {})
    throw new ImageError(`HTTP ${res.status}`)
  }
  const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
  if (!MIME_EXT[type]) {
    void res.body?.cancel().catch(() => {})
    throw new ImageError(`tipo não suportado (${type || 'sem content-type'})`)
  }
  const len = Number(res.headers.get('content-length'))
  if (Number.isFinite(len) && len > ASK_USER_LIMITS.imageBytes) {
    void res.body?.cancel().catch(() => {})
    throw sizeErr(len)
  }
  const chunks: Uint8Array[] = []
  let total = 0
  if (res.body) {
    const reader = res.body.getReader()
    for (;;) {
      let r: ReadableStreamReadResult<Uint8Array>
      try {
        r = await reader.read()
      } catch (e) {
        if (ctx.signal?.aborted) throw e
        if (timeout.aborted)
          throw new ImageError(`tempo esgotado (${ASK_USER_LIMITS.downloadTimeoutMs / 1000} s)`)
        throw new ImageError(`falha de rede: ${(e as Error).message}`)
      }
      if (r.done) break
      total += r.value.byteLength
      if (total > ASK_USER_LIMITS.imageBytes) {
        void reader.cancel().catch(() => {})
        throw sizeErr(total)
      }
      chunks.push(r.value)
    }
  }
  const data = Buffer.concat(chunks)
  if (!data.length) throw new ImageError('resposta vazia')
  const fmt = sniffImage(data)
  if (!fmt) throw new ImageError(`o conteúdo não é uma imagem válida (${type})`)
  return attachmentUrl(saveStoreFile(data, fmt))
}

async function readLocal(ref: string, ctx: ImageResolveCtx): Promise<string> {
  const abs = resolvePath(ctx.root, ref)
  if (ctx.confine) {
    try {
      await assertInsideRoot(ctx.root, abs, ref)
    } catch {
      throw new ImageError('caminho fora do diretório raiz (acesso negado)')
    }
  }
  let st
  try {
    st = await fs.stat(abs)
  } catch {
    throw new ImageError('arquivo não encontrado')
  }
  if (!st.isFile()) throw new ImageError('não é um arquivo')
  if (st.size > ASK_USER_LIMITS.imageBytes) throw sizeErr(st.size)
  return store(await fs.readFile(abs))
}

function fromData(ref: string): string {
  const m = /^data:([^;,]*)(;base64)?,(.*)$/is.exec(ref)
  if (!m) throw new ImageError('data URL inválida')
  const data = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]), 'utf8')
  if (data.length > ASK_USER_LIMITS.imageBytes) throw sizeErr(data.length)
  return store(data)
}

/** Resolve uma referência de imagem (svg inline, URL, data URL, caminho) → URL do store. */
export async function resolveImageRef(ref: string, ctx: ImageResolveCtx): Promise<string> {
  const t = ref.trim()
  switch (classifyImageRef(t)) {
    case 'svg': {
      const data = Buffer.from(t, 'utf8')
      if (data.length > ASK_USER_LIMITS.svgBytes)
        throw new ImageError(`SVG com mais de ${ASK_USER_LIMITS.svgBytes / 1024} KB`)
      if (sniffImage(data) !== 'svg') throw new ImageError('SVG inválido')
      return attachmentUrl(saveStoreFile(data, 'svg'))
    }
    case 'url':
      return download(t, ctx)
    case 'data':
      return fromData(t)
    default:
      return readLocal(t, ctx)
  }
}

const reason = (e: unknown): string =>
  e instanceof ImageError ? e.message : (e as Error)?.message || String(e)

/**
 * Resolve as perguntas do modelo para o formato da UI. Imagens que falharem somem (com nota);
 * abort (Parar/⚡) é relançado.
 */
export async function resolveAskUserQuestions(
  raw: RawAskUserQuestion[],
  ctx: ImageResolveCtx
): Promise<{ questions: AskUserQuestion[]; notes: string[] }> {
  const notes: string[] = []
  const tryImg = async (ref: string, what: string): Promise<string | undefined> => {
    try {
      return await resolveImageRef(ref, ctx)
    } catch (e) {
      if (ctx.signal?.aborted) throw e
      notes.push(`[${what} indisponível: ${reason(e)}]`)
      return undefined
    }
  }
  const questions: AskUserQuestion[] = []
  for (let qi = 0; qi < raw.length; qi++) {
    const q = raw[qi]
    const options: AskUserOption[] = []
    for (let oi = 0; oi < q.options.length; oi++) {
      const o = q.options[oi]
      const where = `da opção ${oi + 1} da pergunta ${qi + 1}`
      const opt: AskUserOption = { title: o.title }
      if (o.description) opt.description = o.description
      if (o.icon) {
        const k = classifyIcon(o.icon)
        if (k === 'lucide') opt.icon = { kind: 'lucide', name: o.icon.trim() }
        else if (k === 'text') opt.icon = { kind: 'text', text: o.icon.trim() }
        else {
          const url = await tryImg(o.icon, `ícone ${where}`)
          if (url) opt.icon = { kind: 'image', url }
        }
      }
      if (o.image) {
        const url = await tryImg(o.image, `imagem ${where}`)
        if (url) opt.image = url
      }
      if (o.help) {
        if (classifyHelp(o.help) === 'text') opt.help = { kind: 'text', text: o.help }
        else {
          const url = await tryImg(o.help, `imagem de ajuda ${where}`)
          if (url) opt.help = { kind: 'image', url }
        }
      }
      options.push(opt)
    }
    questions.push({
      title: q.title,
      ...(q.description ? { description: q.description } : {}),
      multiple: q.multiple,
      options
    })
  }
  return { questions, notes }
}
