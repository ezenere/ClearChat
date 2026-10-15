// list_dir, read_file, write_file, edit_file — com confinação ao diretório raiz e limites de saída.
import { createReadStream, promises as fs } from 'fs'
import { createInterface } from 'readline'
import { dirname, join } from 'path'
import { LIMITS } from '@shared/limits'
import {
  binaryKind,
  displayPath,
  fail,
  fmtNum,
  fmtSize,
  isBinary,
  maxOutputOf,
  ok,
  optNumber,
  requireString,
  resolveToolPath,
  truncate,
  type ToolContext,
  type ToolResult
} from './util'
import { MEDIA_LIMITS, readMediaFile, sniffMedia } from './media'

export async function listDir(
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  const dir = await resolveToolPath(ctx, args.path)
  const dirents = await fs.readdir(dir, { withFileTypes: true })
  const entries = await Promise.all(
    dirents.map(async (d) => {
      let isDir = d.isDirectory()
      let size = 0
      try {
        const st = await fs.stat(join(dir, d.name))
        isDir = st.isDirectory()
        size = st.size
      } catch {
        /* link quebrado etc. */
      }
      return { name: d.name, isDir, size, link: d.isSymbolicLink() }
    })
  )
  entries.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1))
  const max = LIMITS.listMaxEntries
  const shown = entries.slice(0, max)
  const lines = shown.map((e) =>
    e.isDir
      ? `${e.name}/${e.link ? ' (link)' : ''}`
      : `${e.name}${e.link ? ' (link)' : ''}  (${fmtSize(e.size)})`
  )
  const nDirs = entries.filter((e) => e.isDir).length
  let out = `${dir}  [${fmtNum(nDirs)} pastas, ${fmtNum(entries.length - nDirs)} arquivos]\n${lines.length ? lines.join('\n') : '(vazio)'}`
  if (entries.length > shown.length)
    out += `\n[… mais ${fmtNum(entries.length - shown.length)} entradas omitidas (limite ${max}). Use find_files ou search_files para localizar arquivos em pastas grandes.]`
  return ok(truncate(out, maxOutputOf(ctx)))
}

// ---------------- read_file ----------------

export interface FileWindow {
  /** Linhas da janela pedida, começando em `start`. */
  lines: string[]
  /** 1 = primeira linha. */
  start: number
  totalLines: number
  sizeBytes: number
  /** offset/limit informados explicitamente pelo modelo. */
  explicit: boolean
  maxChars: number
  maxLineChars?: number
}

/**
 * Formata a janela de um arquivo (pura — testada em unit.test.ts): linhas numeradas `N\t…`, corte
 * de linhas longas, teto de caracteres alinhado a linhas e cabeçalho/rodapé com o total de linhas.
 */
export function renderFileWindow(w: FileWindow): string {
  const maxLine = w.maxLineChars ?? LIMITS.readMaxLineChars
  if (w.lines.length === 0) {
    return `[o arquivo tem ${fmtNum(w.totalLines)} linhas (${fmtSize(w.sizeBytes)}); nada a partir da linha ${fmtNum(w.start)}]`
  }
  const budget = Math.max(500, w.maxChars - 400)
  const rows: string[] = []
  let used = 0
  let cutByChars = false
  let longLines = 0
  for (let i = 0; i < w.lines.length; i++) {
    let l = w.lines[i]
    if (l.length > maxLine) {
      l = `${l.slice(0, maxLine)} [… linha cortada: ${fmtNum(l.length)} caracteres]`
      longLines++
    }
    const row = `${w.start + i}\t${l}`
    if (rows.length > 0 && used + row.length + 1 > budget) {
      cutByChars = true
      break
    }
    rows.push(row)
    used += row.length + 1
  }
  const end = w.start + rows.length - 1
  const body = rows.join('\n')
  const longNote = longLines ? ` ${fmtNum(longLines)} linha(s) longa(s) cortada(s).` : ''
  if (w.start === 1 && end >= w.totalLines) {
    return `${body}\n[fim do arquivo · ${fmtNum(w.totalLines)} linhas]${longNote ? `\n[${longNote.trim()}]` : ''}`
  }
  const range = `linhas ${fmtNum(w.start)}–${fmtNum(end)}`
  const why = cutByChars ? ' (limite de caracteres da saída)' : ''
  let header: string
  if (!w.explicit) {
    header = `[arquivo grande: ${fmtNum(w.totalLines)} linhas, ${fmtSize(w.sizeBytes)} — mostrando ${range}${why}. Use offset/limit para ler o resto, ou search_files para localizar trechos.${longNote}]`
  } else {
    const next = end < w.totalLines ? ` Continue com offset=${end + 1}.` : ' Fim do arquivo.'
    header = `[arquivo com ${fmtNum(w.totalLines)} linhas (${fmtSize(w.sizeBytes)}) — mostrando ${range}${why}.${next}${longNote}]`
  }
  return `${header}\n${body}`
}

async function readHead(path: string, n: number): Promise<Buffer> {
  const fh = await fs.open(path, 'r')
  try {
    const buf = Buffer.alloc(n)
    const { bytesRead } = await fh.read(buf, 0, n, 0)
    return buf.subarray(0, bytesRead)
  } finally {
    await fh.close()
  }
}

/** Lê a janela de linhas em streaming (arquivos acima do limite) contando o total de linhas. */
async function streamWindow(
  path: string,
  start: number,
  limit: number
): Promise<{ lines: string[]; total: number }> {
  const rl = createInterface({
    input: createReadStream(path, { encoding: 'utf8' }),
    crlfDelay: Infinity
  })
  const lines: string[] = []
  let total = 0
  for await (const line of rl) {
    total++
    if (total >= start && lines.length < limit) lines.push(line)
  }
  return { lines, total }
}

export async function readFile(
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  const path = await resolveToolPath(ctx, requireString(args, 'path'))
  const shown = displayPath(ctx.cwd, path)
  const st = await fs.stat(path)
  if (st.isDirectory()) return fail(`Erro: "${shown}" é um diretório (use list_dir).`)
  const offArg = optNumber(args, 'offset')
  const limArg = optNumber(args, 'limit')
  const explicit = offArg !== undefined || limArg !== undefined
  const head = await readHead(path, 8000)
  // Imagem/PDF: devolve ao modelo se ele lê o tipo (ver media.ts); SVG é XML → cai no texto.
  const media = sniffMedia(head)
  if (media) {
    if (st.size > MEDIA_LIMITS.imageMaxInputBytes)
      return fail(
        `Erro: "${shown}" é um arquivo binário (${binaryKind(head)}, ${fmtSize(st.size)}) grande demais para devolver ao modelo.`
      )
    const r = await readMediaFile({
      data: await fs.readFile(path),
      kind: media.kind,
      mime: media.mime,
      shown,
      media: ctx.media,
      ignoredArgs: explicit
    })
    if (r.status === 'error' || !r.parts) return fail(r.text)
    return { content: r.text, status: 'ok', parts: r.parts }
  }
  if (isBinary(head)) {
    return fail(
      `Erro: "${shown}" é um arquivo binário (${binaryKind(head)}, ${fmtSize(st.size)}). read_file lê arquivos de texto e, se o modelo aceitar, imagens (png/jpg/webp/gif) e PDF.`
    )
  }
  if (st.size > LIMITS.readHardMaxBytes && !explicit) {
    return fail(
      `[arquivo muito grande: "${shown}" tem ${fmtSize(st.size)} — não foi lido inteiro para não estourar o contexto. ` +
        'Leia uma faixa com read_file usando offset/limit (ex.: offset=1, limit=200) ou localize o trecho com search_files.]'
    )
  }
  const start = Math.max(1, Math.floor(offArg ?? 1))
  const limit = Math.max(1, Math.floor(limArg ?? LIMITS.readDefaultLines))
  let lines: string[]
  let total: number
  if (st.size > LIMITS.readHardMaxBytes) {
    ;({ lines, total } = await streamWindow(path, start, limit))
  } else {
    const all = (await fs.readFile(path, 'utf8')).split('\n')
    if (all.length > 1 && all[all.length - 1] === '') all.pop()
    if (all.length === 1 && all[0] === '') all.pop()
    total = all.length
    lines = all.slice(start - 1, start - 1 + limit)
  }
  if (total === 0) return ok(`[arquivo vazio: ${shown}]`)
  return ok(
    renderFileWindow({
      lines,
      start,
      totalLines: total,
      sizeBytes: st.size,
      explicit,
      maxChars: maxOutputOf(ctx)
    })
  )
}

export async function writeFile(
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  const path = await resolveToolPath(ctx, requireString(args, 'path'))
  const content = requireString(args, 'content', true)
  await fs.mkdir(dirname(path), { recursive: true })
  let existed = true
  try {
    await fs.access(path)
  } catch {
    existed = false
  }
  await fs.writeFile(path, content, 'utf8')
  const lines = content === '' ? 0 : content.split('\n').length
  return ok(
    `Arquivo ${existed ? 'sobrescrito' : 'criado'}: ${path} (${Buffer.byteLength(content)} bytes, ${lines} linhas)`
  )
}

export async function editFile(
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  const path = await resolveToolPath(ctx, requireString(args, 'path'))
  const oldStr = requireString(args, 'old_string', true)
  const newStr = requireString(args, 'new_string', true)
  const replaceAll = args.replace_all === true || args.replace_all === 'true'
  if (oldStr === '') return fail('Erro: old_string não pode ser vazio.')
  if (oldStr === newStr) return fail('Erro: old_string e new_string são idênticos.')
  const text = await fs.readFile(path, 'utf8')
  const count = text.split(oldStr).length - 1
  if (count === 0) return fail(`Erro: old_string não encontrado em ${path}.`)
  if (count > 1 && !replaceAll) {
    return fail(
      `Erro: old_string aparece ${count} vezes em ${path}. Inclua mais contexto para torná-lo único ou use replace_all: true.`
    )
  }
  const next = replaceAll ? text.split(oldStr).join(newStr) : text.replace(oldStr, () => newStr)
  await fs.writeFile(path, next, 'utf8')
  return ok(
    `Arquivo editado: ${path} (${replaceAll ? count : 1} substituição${(replaceAll ? count : 1) > 1 ? 'ões' : ''})`
  )
}
