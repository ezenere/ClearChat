// Saídas grandes de tools → arquivo (spill). Quando o texto de um resultado passa do limite
// (setting `toolOutputSpillChars`, padrão LIMITS.spillThresholdChars), o texto COMPLETO vai para
// `<userData>/tool-outputs/<chatId>/<toolCallId>.txt` e o modelo recebe só um trecho (início, ou
// início + fim no shell/logs) + tamanho + caminho + como ler o resto (read_file offset/limit,
// search_files). Os arquivos ficam só no host (não são sincronizados), são somente leitura para as
// tools (read_file/search_files podem lê-los mesmo com confineToRoot; write_file/edit_file nunca
// escrevem neles), somem quando o chat é apagado e são podados no start do app (idade / orçamento).
// Sem imports de util.ts (util importa este módulo); só fs/path.
import { readdirSync, rmdirSync, rmSync, statSync } from 'fs'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'path'
import { LIMITS } from '@shared/limits'

let rootDir: string | null = null
let processLogDir: string | null = null

/** index.ts: userData/tool-outputs; testes: pasta temporária. */
export function setToolOutputDir(d: string | null): void {
  rootDir = d ? resolve(d) : null
}

/** processes.ts: pasta dos logs de processos (read_file pode ler os logs do próprio chat). */
export function setReadableProcessLogDir(d: string | null): void {
  processLogDir = d ? resolve(d) : null
}

export function toolOutputDir(): string {
  return rootDir ?? join(tmpdir(), 'clearchat-tool-outputs')
}

const safeName = (s: string): string => s.replace(/[^\w.-]/g, '_').replace(/^\.+/, '_') || '_'

/** Pasta das saídas salvas de um chat. */
export function chatToolOutputDir(chatId: string | undefined): string {
  return join(toolOutputDir(), safeName(chatId || '_sem-chat'))
}

const inside = (root: string, p: string): boolean => {
  const rel = relative(root, p)
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel)
}

// ---------------- trecho + aviso (puros) ----------------

/** Partes de um resultado para o spill: só `body` vai para o arquivo; head/foot ficam sempre inline. */
export interface SpillParts {
  head?: string
  body: string
  foot?: string
  /** Trecho do início E do fim (shell, logs) em vez de só o início. */
  tail?: boolean
}

const fmt = (n: number): string => n.toLocaleString('pt-BR')

/** Linhas de um texto (última sem \n conta). */
export function countTextLines(s: string): number {
  if (!s) return 0
  let n = 0
  for (let i = s.indexOf('\n'); i !== -1; i = s.indexOf('\n', i + 1)) n++
  return s.endsWith('\n') ? n : n + 1
}

/**
 * Início de `s` com até `budget` caracteres, cortado na última quebra de linha (se ela não ficar
 * cedo demais). `lines` = linhas completas mostradas; `partial` = a última foi cortada no meio.
 */
export function headExcerpt(
  s: string,
  budget: number
): { text: string; lines: number; partial: boolean } {
  if (s.length <= budget) return { text: s, lines: countTextLines(s), partial: false }
  const cut = s.slice(0, budget)
  const nl = cut.lastIndexOf('\n')
  if (nl >= budget * 0.3) {
    const text = cut.slice(0, nl)
    return { text, lines: countTextLines(text + '\n'), partial: false }
  }
  // linha enorme logo no começo: corta no meio dela
  return { text: cut, lines: countTextLines(cut), partial: true }
}

/** Fim de `s` com até `budget` caracteres, começando numa linha inteira quando possível. */
export function tailExcerpt(s: string, budget: number): { text: string; lines: number } {
  const body = s.replace(/\n$/, '')
  if (body.length <= budget) return { text: body, lines: countTextLines(body) }
  const cut = body.slice(body.length - budget)
  const nl = cut.indexOf('\n')
  const text = nl !== -1 && nl <= budget * 0.7 ? cut.slice(nl + 1) : cut
  return { text, lines: countTextLines(text) }
}

/** Trecho do início (e do fim, se `tail`) + aviso com tamanho, caminho e como ler o resto. */
export function renderSpilled(parts: SpillParts, path: string, excerptChars: number): string {
  const body = parts.body
  const total = body.length
  const lines = countTextLines(body)
  const hasLong = body.split('\n').some((l) => l.length > LIMITS.readMaxLineChars)
  let excerpt: string
  let shown: string
  let next: number
  if (parts.tail) {
    const headBudget = Math.floor(excerptChars * 0.4)
    const h = headExcerpt(body, headBudget)
    const t = tailExcerpt(body.slice(h.text.length), excerptChars - h.text.length)
    const firstTail = lines - t.lines + 1
    const lastHead = h.partial ? Math.max(1, h.lines) : h.lines
    const gap =
      firstTail > lastHead + 1
        ? `[… linhas ${fmt(lastHead + 1)}–${fmt(firstTail - 1)} omitidas …]`
        : '[… trecho omitido …]'
    excerpt = `${h.text}\n${gap}\n${t.text}`
    shown = `o início (linhas 1–${fmt(lastHead)}${h.partial ? ', a última cortada' : ''}) e o fim (linhas ${fmt(firstTail)}–${fmt(lines)})`
    next = lastHead + 1
  } else {
    const h = headExcerpt(body, excerptChars)
    excerpt = h.text
    shown = h.partial
      ? `só o começo da linha 1${h.lines > 1 ? `–${fmt(h.lines)}` : ''} (cortada)`
      : `só o início (linhas 1–${fmt(h.lines)})`
    next = h.partial ? Math.max(1, h.lines) : h.lines + 1
  }
  const long = hasLong
    ? ` Há linhas com mais de ${fmt(LIMITS.readMaxLineChars)} caracteres (read_file as corta): para elas use a tool shell no arquivo (ex.: cut -c1-5000, jq, python).`
    : ''
  const notice =
    `[saída longa: ${fmt(total)} caracteres em ${fmt(lines)} linhas — acima, ${shown}; o resto NÃO está neste resultado. Conteúdo completo salvo em:\n${path}\n` +
    `Leia em partes com read_file (esse path, offset/limit em linhas — ex.: offset=${next}, limit=200) ou localize trechos com search_files (pattern + path = esse arquivo).${long}]`
  return `${parts.head ?? ''}${excerpt.replace(/\n+$/, '')}\n${notice}${parts.foot ?? ''}`
}

// ---------------- escrita ----------------

/**
 * Grava `body` em `<chat>/<toolCallId>.txt` (sufixo -2, -3… se o id já existir — provedores que
 * repetem ids não sobrescrevem saídas antigas referenciadas no histórico). Retorna o caminho.
 */
export async function writeToolOutput(
  chatId: string | undefined,
  toolCallId: string | undefined,
  body: string
): Promise<string> {
  const dir = chatToolOutputDir(chatId)
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  const base = safeName(
    toolCallId || `saida-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  ).slice(0, 120)
  for (let i = 1; i <= 100; i++) {
    const p = join(dir, `${base}${i > 1 ? `-${i}` : ''}.txt`)
    try {
      await fs.writeFile(p, body, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      return p
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    }
  }
  throw new Error('nomes de arquivo de saída esgotados')
}

// ---------------- acesso (read_file / search_files / write_file) ----------------

async function realOrNull(p: string): Promise<string | null> {
  try {
    return await fs.realpath(p)
  } catch {
    return null
  }
}

/**
 * read_file/search_files com confineToRoot: `abs` é uma saída salva DESTE chat (ou o log de um
 * processo deste chat)? Exige arquivo comum e realpath dentro da pasta (symlink para fora → não).
 */
export async function isReadableToolOutput(
  chatId: string | undefined,
  abs: string
): Promise<boolean> {
  const real = await realOrNull(abs)
  if (!real) return false
  try {
    if (!(await fs.stat(real)).isFile()) return false
  } catch {
    return false
  }
  const chatDir = await realOrNull(chatToolOutputDir(chatId))
  if (chatDir && inside(chatDir, real)) return true
  if (processLogDir && chatId) {
    const logs = await realOrNull(processLogDir)
    const name = basename(real)
    if (
      logs &&
      dirname(real) === logs &&
      name.startsWith(`${chatId.replace(/[^\w-]/g, '_')}-`) &&
      name.endsWith('.log')
    )
      return true
  }
  return false
}

/** `abs` (lexicamente) dentro da pasta de saídas salvas (de qualquer chat)? */
export function isUnderToolOutputs(abs: string): boolean {
  return inside(toolOutputDir(), resolve(abs))
}

/** write_file/edit_file: caminho (após realpath) dentro da pasta de saídas salvas? */
export async function isToolOutputTarget(abs: string): Promise<boolean> {
  if (isUnderToolOutputs(abs)) return true
  const root = await realOrNull(toolOutputDir())
  if (!root) return false
  // realpath do ancestral existente mais profundo (o arquivo pode ainda não existir)
  let cur = resolve(abs)
  const rest: string[] = []
  for (;;) {
    const real = await realOrNull(cur)
    if (real) return inside(root, rest.length ? join(real, ...rest.reverse()) : real)
    const parent = dirname(cur)
    if (parent === cur) return false
    rest.push(basename(cur))
    cur = parent
  }
}

// ---------------- limpeza ----------------

/** Apagar o chat (local ou via sync): apaga as saídas salvas dele. */
export function removeChatToolOutputs(chatId: string): void {
  try {
    rmSync(chatToolOutputDir(chatId), { recursive: true, force: true })
  } catch {
    /* ignora */
  }
}

export interface ToolOutputGcOptions {
  maxAgeDays?: number
  maxTotalBytes?: number
  /** Ids dos chats existentes: pastas de chats que não existem mais são apagadas. */
  liveChatIds?: Iterable<string>
  now?: number
}

/**
 * Start do app: apaga pastas de chats inexistentes, arquivos mais antigos que `maxAgeDays` e, se o
 * total passar de `maxTotalBytes`, os mais antigos até caber. Retorna os caminhos apagados.
 */
export function gcToolOutputs(opts: ToolOutputGcOptions = {}): string[] {
  const root = toolOutputDir()
  const maxAge = (opts.maxAgeDays ?? LIMITS.spillMaxAgeDays) * 86_400_000
  const budget = opts.maxTotalBytes ?? LIMITS.spillMaxTotalBytes
  const now = opts.now ?? Date.now()
  const live = opts.liveChatIds ? new Set([...opts.liveChatIds].map(safeName)) : null
  const deleted: string[] = []
  let dirs: string[]
  try {
    dirs = readdirSync(root)
  } catch {
    return deleted
  }
  const keep: { path: string; size: number; mtime: number }[] = []
  for (const d of dirs) {
    const dir = join(root, d)
    try {
      if (!statSync(dir).isDirectory()) continue
    } catch {
      continue
    }
    if (live && !live.has(d)) {
      rmSync(dir, { recursive: true, force: true })
      deleted.push(dir)
      continue
    }
    let names: string[] = []
    try {
      names = readdirSync(dir)
    } catch {
      /* ignora */
    }
    for (const n of names) {
      const p = join(dir, n)
      try {
        const st = statSync(p)
        if (!st.isFile()) continue
        if (now - st.mtimeMs > maxAge) {
          rmSync(p, { force: true })
          deleted.push(p)
        } else keep.push({ path: p, size: st.size, mtime: st.mtimeMs })
      } catch {
        /* ignora */
      }
    }
  }
  let total = keep.reduce((a, f) => a + f.size, 0)
  if (total > budget) {
    keep.sort((a, b) => a.mtime - b.mtime)
    for (const f of keep) {
      if (total <= budget) break
      rmSync(f.path, { force: true })
      deleted.push(f.path)
      total -= f.size
    }
  }
  // pastas que ficaram vazias
  for (const d of dirs) {
    const dir = join(root, d)
    try {
      if (statSync(dir).isDirectory() && readdirSync(dir).length === 0) rmdirSync(dir)
    } catch {
      /* ignora */
    }
  }
  return deleted
}
