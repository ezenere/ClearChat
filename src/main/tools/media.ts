// read_file de arquivos binários que o MODELO DA SESSÃO consegue ler (imagens, PDF).
// Ver SPEC.md → "Tools" (read_file) e "Anexos". Sem dependência do Electron: o redimensionamento
// de imagens é injetado (index.ts usa nativeImage; os testes, um mock).
//
// Decisão por capacidade (modalitySupport de @shared/attachments, a mesma regra dos anexos):
// - 'ok'          → devolve o conteúdo (part de imagem/PDF por referência ao store);
// - 'parsed'      → PDF no OpenRouter em modelo sem 'file': devolve (o OpenRouter extrai o texto);
// - 'unsupported' → erro claro ("Este modelo não lê imagens…");
// - 'unknown'     → imagem: devolve (a maioria dos modelos OpenAI-compatible com visão aceita; se o
//                   modelo não aceitar, a API devolve erro e o usuário apaga a mensagem); PDF: erro
//                   com dica (parts `file` fora do OpenAI/OpenRouter são raros).
import { basename } from 'path'
import { attachmentUrl, KIND_LABEL, modalitySupport } from '@shared/attachments'
import type { ProviderKind } from '@shared/providerKinds'
import type { AttachmentMeta, ContentPart, ModelInfo } from '@shared/types'
import { saveStoreFile } from '../attachments'
import { fmtNum, fmtSize } from './util'

/**
 * Limites (fontes):
 * - Anthropic (docs "Vision"): máx. 8000×8000 px; com mais de 20 imagens numa request (o histórico
 *   inteiro conta, inclusive imagens dentro de tool_result) cada uma precisa ter ≤ 2000 px de lado;
 *   10 MB por imagem (base64) na API direta e 5 MB (base64) no Bedrock/Vertex — o OpenRouter
 *   roteia Claude para o Bedrock. Lado nativo: 1568 px (padrão) / 2576 px (Claude 4.7+).
 * - OpenAI (docs "Images and vision"): PNG/JPEG/WEBP/GIF não animado; high detail encaixa em
 *   2048×2048. → teto: lado maior ≤ 2000 px e ≤ 3,75 MB de bytes (5 MB em base64).
 * - PDF (Anthropic "PDF support"): request ≤ 32 MB, ≤ 100 páginas (janela < 1M). → ≤ 10 MB e
 *   ≤ 100 páginas (contadas por heurística; PDFs com object streams podem não ser contáveis).
 */
export const MEDIA_LIMITS = {
  imageMaxSide: 2000,
  imageMaxBytes: Math.floor((5 * 1024 * 1024 * 3) / 4),
  /** Acima disso nem tenta decodificar/reduzir (proteção de memória). */
  imageMaxInputBytes: 50 * 1024 * 1024,
  pdfMaxBytes: 10 * 1024 * 1024,
  pdfMaxPages: 100
} as const

export type MediaKind = 'image' | 'pdf'

/** Imagem reduzida/recomprimida pelo processador injetado. */
export interface ProcessedImage {
  data: Uint8Array
  mime: string
  width: number
  height: number
}

/**
 * Reduz a imagem para caber em `maxSide` (lado maior) e `maxBytes`. null = não conseguiu
 * (formato que a plataforma não decodifica etc.).
 */
export type ImageProcessor = (
  data: Uint8Array,
  mime: string,
  opts: { maxSide: number; maxBytes: number }
) => ProcessedImage | null | Promise<ProcessedImage | null>

let processor: ImageProcessor | null = null
/** index.ts registra o processador do Electron (nativeImage); testes injetam um mock. */
export function setImageProcessor(p: ImageProcessor | null): void {
  processor = p
}

/** Contexto que o read_file precisa para decidir: tipo de provider + modelo da sessão. */
export interface MediaContext {
  providerKind: ProviderKind
  /** Modelo da sessão (cache de /models); null = desconhecido. */
  model: () => Promise<Pick<ModelInfo, 'inputModalities'> | null>
}

// ---------------- detecção ----------------

/** Tipo de mídia pelos bytes iniciais (png/jpeg/gif/webp/pdf); null = outro. */
export function sniffMedia(head: Uint8Array): { kind: MediaKind; mime: string } | null {
  const b = Buffer.from(head.buffer, head.byteOffset, head.byteLength)
  const hex = b.subarray(0, 8).toString('hex')
  const ascii = b.subarray(0, 16).toString('latin1')
  if (hex.startsWith('89504e470d0a1a0a')) return { kind: 'image', mime: 'image/png' }
  if (hex.startsWith('ffd8ff')) return { kind: 'image', mime: 'image/jpeg' }
  if (ascii.startsWith('GIF87a') || ascii.startsWith('GIF89a'))
    return { kind: 'image', mime: 'image/gif' }
  if (ascii.startsWith('RIFF') && b.subarray(8, 12).toString('latin1') === 'WEBP')
    return { kind: 'image', mime: 'image/webp' }
  if (ascii.startsWith('%PDF-')) return { kind: 'pdf', mime: 'application/pdf' }
  return null
}

/** Dimensões de PNG/JPEG/GIF/WEBP lendo só o cabeçalho; null se não reconhecer. */
export function imageSize(data: Uint8Array): { width: number; height: number } | null {
  const b = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  const sniff = sniffMedia(b)
  if (!sniff || sniff.kind !== 'image') return null
  try {
    switch (sniff.mime) {
      case 'image/png':
        return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) }
      case 'image/gif':
        return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) }
      case 'image/webp': {
        const chunk = b.subarray(12, 16).toString('latin1')
        if (chunk === 'VP8X')
          return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) }
        if (chunk === 'VP8L') {
          const bits = b.readUInt32LE(21)
          return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) }
        }
        if (chunk === 'VP8 ')
          return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff }
        return null
      }
      case 'image/jpeg': {
        let i = 2
        while (i + 9 < b.length) {
          if (b[i] !== 0xff) {
            i++
            continue
          }
          const marker = b[i + 1]
          if (marker === 0xff) {
            i++
            continue
          }
          // SOF0–SOF15, exceto DHT (C4), JPG (C8) e DAC (CC)
          if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))
            return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) }
          if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) {
            i += 2
            continue
          }
          i += 2 + b.readUInt16BE(i + 2)
        }
        return null
      }
    }
  } catch {
    return null
  }
  return null
}

/**
 * Páginas de um PDF (heurística: objetos `/Type /Page`, sem contar `/Pages`). 0 = não deu para
 * contar (ex.: object streams comprimidos) — aí o limite de páginas não é verificado aqui.
 */
export function pdfPageCount(data: Uint8Array): number {
  const s = Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('latin1')
  return (s.match(/\/Type\s*\/Page(?![a-zA-Z])/g) ?? []).length
}

// ---------------- decisão ----------------

export type MediaDecision = { send: true } | { send: false; error: string }

/**
 * Pode devolver este tipo ao modelo da sessão? (pura — testada em unit.test.ts)
 * `what` descreve o arquivo para a mensagem de erro (ex.: `"a.png" (imagem PNG, 140 KB)`).
 */
export function mediaDecision(
  kind: MediaKind,
  model: Pick<ModelInfo, 'inputModalities'> | null | undefined,
  providerKind: ProviderKind,
  what: string
): MediaDecision {
  const s = modalitySupport(kind, model, providerKind)
  if (s === 'ok' || s === 'parsed') return { send: true }
  if (s === 'unknown' && kind === 'image') return { send: true }
  const plural = kind === 'image' ? 'imagens' : 'PDFs'
  const hint =
    kind === 'pdf'
      ? 'Extraia o texto pelo shell (ex.: pdftotext arquivo.pdf -) ou delegue a um modelo que leia PDFs.'
      : 'Para ver a imagem, delegue a um modelo com visão (delegate_task com model).'
  if (s === 'unknown')
    return {
      send: false,
      error: `Erro: não sei se este modelo lê ${plural} (o provider não informa as modalidades), então read_file só devolve texto — ${what}. ${hint}`
    }
  return {
    send: false,
    error: `Erro: Este modelo não lê ${plural}; read_file só pode devolver texto para ele — ${what}. ${hint}`
  }
}

// ---------------- leitura ----------------

export interface MediaReadResult {
  status: 'ok' | 'error'
  /** Texto (descrição ou erro). */
  text: string
  /** Parts persistidos (texto + imagem/PDF por referência ao store). */
  parts?: ContentPart[]
}

const MIME_LABEL: Record<string, string> = {
  'image/png': 'imagem PNG',
  'image/jpeg': 'imagem JPEG',
  'image/gif': 'imagem GIF',
  'image/webp': 'imagem WebP',
  'application/pdf': 'documento PDF'
}
const EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'application/pdf': 'pdf'
}

/**
 * Lê um binário de mídia para o modelo: decide pela capacidade, aplica os limites (reduz imagens
 * grandes), salva os bytes no store de anexos (content-addressed) e devolve os parts por
 * referência (`clearchat-attachment://…` + `_attachment`) — nunca base64 no banco.
 */
export async function readMediaFile(input: {
  data: Uint8Array
  kind: MediaKind
  mime: string
  /** Caminho exibido (relativo à raiz). */
  shown: string
  media: MediaContext | undefined
  /** offset/limit passados (não se aplicam a binários). */
  ignoredArgs?: boolean
}): Promise<MediaReadResult> {
  const { kind, shown } = input
  let data = input.data
  let mime = input.mime
  const what = `"${shown}" é ${kind === 'image' ? 'uma' : 'um'} ${MIME_LABEL[mime] ?? KIND_LABEL[kind]} (${fmtSize(data.byteLength)})`
  const ctx = input.media
  if (!ctx)
    return {
      status: 'error',
      text: `Erro: "${shown}" é um arquivo binário (${MIME_LABEL[mime] ?? KIND_LABEL[kind]}, ${fmtSize(data.byteLength)}). read_file só lê arquivos de texto neste contexto (modelo da sessão desconhecido).`
    }
  // /models falhou → modalidades desconhecidas ('unknown')
  const model = await ctx.model().catch(() => null)
  const d = mediaDecision(kind, model, ctx.providerKind, what)
  if (!d.send) return { status: 'error', text: d.error }

  const notes: string[] = []
  let desc: string
  if (kind === 'image') {
    const orig = imageSize(data)
    const dims = orig ? `${fmtNum(orig.width)}×${fmtNum(orig.height)}` : 'dimensões desconhecidas'
    const big =
      data.byteLength > MEDIA_LIMITS.imageMaxBytes ||
      (orig && Math.max(orig.width, orig.height) > MEDIA_LIMITS.imageMaxSide)
    let finalDims = dims
    if (big) {
      const limitsTxt = `${fmtNum(MEDIA_LIMITS.imageMaxSide)} px de lado e ${fmtSize(MEDIA_LIMITS.imageMaxBytes)}`
      if (data.byteLength > MEDIA_LIMITS.imageMaxInputBytes || !processor)
        return {
          status: 'error',
          text: `Erro: ${what}, ${dims} — grande demais para enviar ao modelo (limite ${limitsTxt}) e não foi possível reduzi-la aqui. Gere uma versão menor (ex.: pelo shell) e leia essa.`
        }
      const proc = processor
      const out: ProcessedImage | null = await Promise.resolve()
        .then(() =>
          proc(data, mime, {
            maxSide: MEDIA_LIMITS.imageMaxSide,
            maxBytes: MEDIA_LIMITS.imageMaxBytes
          })
        )
        .catch(() => null)
      if (
        !out ||
        out.data.byteLength > MEDIA_LIMITS.imageMaxBytes ||
        Math.max(out.width, out.height) > MEDIA_LIMITS.imageMaxSide
      )
        return {
          status: 'error',
          text: `Erro: ${what}, ${dims} — grande demais para enviar ao modelo (limite ${limitsTxt}) e não foi possível reduzi-la (formato não decodificável nesta plataforma?). Gere uma versão menor/PNG (ex.: pelo shell) e leia essa.`
        }
      data = out.data
      mime = out.mime
      finalDims = `${fmtNum(out.width)}×${fmtNum(out.height)}`
      notes.push(
        `reduzida de ${dims} (${fmtSize(input.data.byteLength)}) para ${finalDims} (${fmtSize(data.byteLength)}, ${mime === 'image/jpeg' ? 'JPEG' : 'PNG'})`
      )
    }
    desc = `[imagem: ${shown}, ${fmtSize(input.data.byteLength)}, ${big ? finalDims : dims}${notes.length ? ` — ${notes.join('; ')}` : ''}]`
  } else {
    if (data.byteLength > MEDIA_LIMITS.pdfMaxBytes)
      return {
        status: 'error',
        text: `Erro: ${what} — o limite para devolver um PDF ao modelo é ${fmtSize(MEDIA_LIMITS.pdfMaxBytes)}. Divida o PDF ou extraia o texto pelo shell (ex.: pdftotext arquivo.pdf -).`
      }
    const pages = pdfPageCount(data)
    if (pages > MEDIA_LIMITS.pdfMaxPages)
      return {
        status: 'error',
        text: `Erro: ${what}, ${fmtNum(pages)} páginas — o limite é ${MEDIA_LIMITS.pdfMaxPages} páginas por request. Divida o PDF (ex.: qpdf/pdfseparate pelo shell) ou extraia o texto (pdftotext).`
      }
    desc = `[PDF: ${shown}, ${fmtSize(data.byteLength)}${pages ? `, ${fmtNum(pages)} página${pages > 1 ? 's' : ''}` : ''}]`
  }
  if (input.ignoredArgs) desc += '\n[offset/limit ignorados: valem só para arquivos de texto]'

  const file = saveStoreFile(data, EXT[mime] ?? 'bin')
  const meta: AttachmentMeta = {
    name: basename(shown) || shown,
    mime,
    size: data.byteLength,
    kind,
    file
  }
  const url = attachmentUrl(file)
  const part: ContentPart =
    kind === 'image'
      ? { type: 'image_url', image_url: { url }, _attachment: meta }
      : { type: 'file', file: { filename: meta.name, file_data: url }, _attachment: meta }
  return { status: 'ok', text: desc, parts: [{ type: 'text', text: desc }, part] }
}
