// Processos em segundo plano (process_start / process_logs / process_list / process_stop).
// - Escopo: CHAT (todas as sessões do chat — principal e subagentes — veem e controlam os mesmos
//   processos; um subagente pode subir o emulador para o pai).
// - Cada processo roda no shell do usuário (shellEnv.ts) DETACHED, num process group próprio;
//   stdout+stderr viram linhas (ANSI removido, linhas longas cortadas) num buffer circular em
//   memória (LIMITS.processBufferLines/Chars) + arquivo completo em <logDir>/<chat>-<id>-<ts>.log.
// - Ciclo de vida: process_stop (grupo inteiro; SIGKILL após ~3 s), apagar o chat
//   (stopChatProcesses), fechar o app (killAllProcesses — síncrono: SIGTERM, ~300 ms, SIGKILL).
// - Abortar a tool (Parar) durante o wait_for só interrompe a ESPERA: o processo continua.
import { spawn, type ChildProcess } from 'child_process'
import { closeSync, mkdirSync, openSync, readdirSync, rmSync, statSync, writeSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { StringDecoder } from 'string_decoder'
import { LIMITS } from '@shared/limits'
import type { ProcessInfo } from '@shared/types'
import { bwrapAvailable, isDir, killGroup, real, sandboxBinds, shellArgv } from './bash'
import { shellLaunch } from './shellEnv'
import { setReadableProcessLogDir } from './toolOutputs'
import {
  fail,
  fmtNum,
  isInside,
  maxOutputOf,
  ok,
  optBool,
  optNumber,
  optString,
  requireString,
  resolveToolPath,
  ToolError,
  type ToolContext,
  type ToolResult
} from './util'

const L = LIMITS
const STOP_GRACE_MS = 3000
const START_SETTLE_MS = 1000
/** Processos encerrados guardados por chat (para process_logs depois que saem). */
const KEEP_EXITED = 20

// ---------------- diretório de logs ----------------

let logDir: string | null = null

/** index.ts: userData/processes; testes: pasta temporária. */
export function setProcessLogDir(d: string): void {
  logDir = d
  // read_file/search_files alcançam os logs do próprio chat mesmo com confineToRoot
  setReadableProcessLogDir(d)
}

function ensureLogDir(): string {
  const d = logDir ?? join(tmpdir(), 'clearchat-processes')
  mkdirSync(d, { recursive: true })
  return d
}

/** Apaga logs mais antigos que `maxAgeDays` (start do app). Retorna os apagados. */
export function gcProcessLogs(maxAgeDays: number = L.processLogMaxAgeDays): string[] {
  const d = logDir
  if (!d) return []
  const out: string[] = []
  const limit = Date.now() - maxAgeDays * 86_400_000
  let names: string[]
  try {
    names = readdirSync(d)
  } catch {
    return out
  }
  for (const n of names) {
    if (!n.endsWith('.log')) continue
    const p = join(d, n)
    try {
      if (statSync(p).mtimeMs < limit) {
        rmSync(p, { force: true })
        out.push(p)
      }
    } catch {
      /* ignora */
    }
  }
  return out
}

// ---------------- registro ----------------

interface Waiter {
  re: RegExp
  resolve: (line: string) => void
}

interface Proc {
  info: ProcessInfo
  child: ChildProcess
  /** Linhas em memória: lines[0] é a linha número `first`. */
  lines: string[]
  first: number
  chars: number
  partial: Record<'out' | 'err', string>
  decoders: Record<'out' | 'err', StringDecoder>
  fd: number | null
  /** stdout/stderr fechados (nenhum membro do grupo segura os pipes). */
  closed: boolean
  waiters: Set<Waiter>
  exitWaiters: Set<() => void>
}

const registry = new Map<string, Map<string, Proc>>()
const counters = new Map<string, number>()

type Listener = (chatId: string, list: ProcessInfo[]) => void
let listener: Listener | null = null

/** index.ts: emite `processes-updated` (início, saída, parada, remoção). */
export function setProcessListener(fn: Listener | null): void {
  listener = fn
}

function notify(chatId: string): void {
  if (!listener) return
  try {
    listener(chatId, listProcesses(chatId))
  } catch {
    /* ignora */
  }
}

const snapshot = (p: Proc): ProcessInfo => ({
  ...p.info,
  lines: p.first - 1 + p.lines.length,
  lastLine: lastLineOf(p)
})

function lastLineOf(p: Proc): string {
  const partial = (p.partial.out || p.partial.err).trim()
  if (partial) return partial.slice(0, 300)
  for (let i = p.lines.length - 1; i >= 0; i--)
    if (p.lines[i].trim()) return p.lines[i].slice(0, 300)
  return ''
}

/** Processos do chat (mais antigos primeiro). */
export function listProcesses(chatId: string): ProcessInfo[] {
  return [...(registry.get(chatId)?.values() ?? [])].map(snapshot)
}

function getProc(chatId: string, id: string): Proc {
  const p = registry.get(chatId)?.get(id.trim())
  if (!p) {
    const ids = [...(registry.get(chatId)?.keys() ?? [])]
    throw new ToolError(
      `Erro: processo "${id}" não encontrado neste chat.${ids.length ? ` Ids: ${ids.join(', ')}.` : ' Nenhum processo iniciado (use process_start).'}`
    )
  }
  return p
}

const runningCount = (chatId: string): number =>
  [...(registry.get(chatId)?.values() ?? [])].filter((p) => p.info.status === 'running').length

/** Mantém no máximo KEEP_EXITED encerrados por chat (os mais antigos saem). */
function pruneExited(chatId: string): void {
  const m = registry.get(chatId)
  if (!m) return
  const exited = [...m.values()].filter((p) => p.info.status === 'exited')
  for (const p of exited.slice(0, Math.max(0, exited.length - KEEP_EXITED))) m.delete(p.info.id)
}

// ---------------- linhas ----------------

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g

/** Limpa uma linha: remove ANSI, resolve `\r` (fica o último segmento não vazio), corta longas. */
export function cleanLine(raw: string): string {
  let s = raw.replace(ANSI_RE, '')
  if (s.includes('\r')) {
    const segs = s.split('\r').filter((x) => x.length)
    s = segs.length ? segs[segs.length - 1] : ''
  }
  if (s.length > L.processMaxLineChars)
    s = `${s.slice(0, L.processMaxLineChars)} [… linha cortada: ${fmtNum(s.length)} caracteres]`
  return s
}

function pushLine(p: Proc, line: string): void {
  p.lines.push(line)
  p.chars += line.length + 1
  if (p.fd !== null) {
    try {
      writeSync(p.fd, line + '\n')
    } catch {
      /* disco cheio etc.: segue só com a memória */
    }
  }
  // descarte em blocos (evita shift a cada linha)
  if (p.lines.length > L.processBufferLines * 1.1 || p.chars > L.processBufferChars * 1.1) {
    let drop = Math.max(0, p.lines.length - L.processBufferLines)
    let chars = p.chars
    for (let i = 0; i < drop; i++) chars -= p.lines[i].length + 1
    while (chars > L.processBufferChars && drop < p.lines.length - 1) {
      chars -= p.lines[drop].length + 1
      drop++
    }
    p.lines.splice(0, drop)
    p.chars = chars
    p.first += drop
  }
  for (const w of p.waiters) {
    if (w.re.test(line)) {
      p.waiters.delete(w)
      w.resolve(line)
    }
  }
}

function onChunk(p: Proc, which: 'out' | 'err', text: string): void {
  const s = p.partial[which] + text
  const parts = s.split('\n')
  p.partial[which] = parts.pop() ?? ''
  for (const raw of parts) pushLine(p, cleanLine(raw))
  // linha incompleta (ex.: prompt sem \n) também pode casar o wait_for
  const pending = p.partial[which]
  if (pending && p.waiters.size) {
    const line = cleanLine(pending)
    for (const w of p.waiters) {
      if (w.re.test(line)) {
        p.waiters.delete(w)
        w.resolve(line)
      }
    }
  }
}

function flushPartials(p: Proc): void {
  for (const w of ['out', 'err'] as const) {
    const rest = p.partial[w] + p.decoders[w].end()
    p.partial[w] = ''
    if (rest) pushLine(p, cleanLine(rest))
  }
}

// ---------------- helpers de saída ----------------

function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s} s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min${s % 60 ? ` ${s % 60} s` : ''}`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} h${m % 60 ? ` ${m % 60} min` : ''}`
  return `${Math.floor(h / 24)} d ${h % 24} h`
}

function stateText(info: ProcessInfo, now = Date.now()): string {
  if (info.status === 'running')
    return `rodando há ${fmtDuration(now - info.startedAt)}${info.pid ? ` (pid ${info.pid})` : ''}`
  const how =
    info.exitCode !== null
      ? `com código ${info.exitCode}`
      : info.signal
        ? `pelo sinal ${info.signal}`
        : ''
  const ago = info.endedAt ? ` há ${fmtDuration(now - info.endedAt)}` : ''
  return `encerrado ${how}${ago}`.replace(/\s+/g, ' ').trim()
}

const label = (info: ProcessInfo): string => `${info.id}${info.name ? ` "${info.name}"` : ''}`

/** Últimas `n` linhas numeradas (com a linha em andamento, se houver). */
function tailText(p: Proc, n: number, maxChars: number): string {
  const total = p.first - 1 + p.lines.length
  const out: string[] = []
  let used = 0
  for (let i = p.lines.length - 1; i >= 0 && out.length < n; i--) {
    const s = `${p.first + i}\t${p.lines[i]}`
    if (used + s.length + 1 > maxChars) break
    out.unshift(s)
    used += s.length + 1
  }
  const partial = cleanLine(p.partial.out || p.partial.err)
  if (partial) out.push(`…\t${partial}  [linha em andamento]`)
  if (!out.length) return '(sem saída ainda)'
  const firstShown = Number(out[0].split('\t')[0])
  const hidden = Number.isFinite(firstShown) ? firstShown - 1 : total
  return `${hidden > 0 ? `[… ${fmtNum(hidden)} linhas anteriores — use process_logs]\n` : ''}${out.join('\n')}`
}

function headText(p: Proc, n: number, maxChars: number): string {
  const out: string[] = []
  let used = 0
  for (let i = 0; i < p.lines.length && out.length < n; i++) {
    const s = `${p.first + i}\t${p.lines[i]}`
    if (used + s.length + 1 > maxChars) break
    out.push(s)
    used += s.length + 1
  }
  return out.join('\n')
}

// ---------------- process_start ----------------

function waitExit(p: Proc, ms: number): Promise<boolean> {
  if (p.info.status === 'exited') return Promise.resolve(true)
  return new Promise((res) => {
    const done = (): void => {
      clearTimeout(t)
      p.exitWaiters.delete(done)
      res(true)
    }
    const t = setTimeout(() => {
      p.exitWaiters.delete(done)
      res(false)
    }, ms)
    p.exitWaiters.add(done)
  })
}

export async function processStart(
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  const chatId = ctx.chatId
  if (!chatId) return fail('Erro: process_start indisponível (sem chat).')
  const command = requireString(args, 'command')
  const name = (optString(args, 'name') ?? '').trim().slice(0, 60)
  const waitFor = optString(args, 'wait_for')
  let waitRe: RegExp | null = null
  if (waitFor) {
    try {
      waitRe = new RegExp(waitFor)
    } catch (e) {
      return fail(`Erro: wait_for não é uma regex válida: ${(e as Error).message}`)
    }
  }
  const timeoutS = Math.min(
    L.processWaitMaxS,
    Math.max(1, optNumber(args, 'timeout_s') ?? L.processWaitDefaultS)
  )
  if (runningCount(chatId) >= L.processMaxPerChat) {
    const list = listProcesses(chatId)
      .filter((p) => p.status === 'running')
      .map((p) => `${p.id}${p.name ? ` "${p.name}"` : ''}`)
      .join(', ')
    return fail(
      `Erro: limite de ${L.processMaxPerChat} processos rodando neste chat atingido (${list}). Pare algum com process_stop antes de iniciar outro.`
    )
  }

  // diretório: arg (relativo ao raiz; confinado) ou o diretório atual do shell da sessão
  const root = ctx.cwd
  let cwd: string
  const cwdArg = optString(args, 'cwd')
  if (cwdArg) {
    cwd = await resolveToolPath(ctx, cwdArg)
  } else {
    cwd = ctx.shell?.dir || root
    if (cwd !== root && (!isDir(cwd) || (ctx.confine && !isInside(real(root), real(cwd)))))
      cwd = root
  }
  if (!isDir(cwd)) return fail(`Erro: diretório não encontrado: ${cwd}`)

  const sandbox = !!ctx.sandbox && bwrapAvailable()
  // sem TTY, muitos programas fazem buffer do stdout (o wait_for não veria as linhas):
  // PYTHONUNBUFFERED cobre Python; o resto a descrição orienta (stdbuf -oL etc.)
  const launch = await shellLaunch({
    CLEAR_START_DIR: cwd,
    CLEAR_ROOT_DIR: root,
    PYTHONUNBUFFERED: '1'
  })
  // checa de novo (a resolução do env é assíncrona)
  if (runningCount(chatId) >= L.processMaxPerChat)
    return fail(`Erro: limite de ${L.processMaxPerChat} processos rodando neste chat atingido.`)

  const n = (counters.get(chatId) ?? 0) + 1
  counters.set(chatId, n)
  const id = `p${n}`
  const startedAt = Date.now()
  const dir = ensureLogDir()
  const logFile = join(dir, `${chatId.replace(/[^\w-]/g, '_')}-${id}-${startedAt}.log`)
  let fd: number | null
  try {
    fd = openSync(logFile, 'a')
  } catch {
    fd = null
  }

  // cd explícito (o bwrap faz --chdir para o raiz); mesma linha do comando
  const script = `cd -- "$CLEAR_START_DIR" || exit 1; ${command}`
  const [cmd, argv] = shellArgv(
    launch.shell.path,
    launch.flag,
    script,
    sandbox,
    real(root),
    sandboxBinds(ctx.roBinds)
  )
  let child: ChildProcess
  try {
    child = spawn(cmd, argv, {
      cwd,
      env: launch.env,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch (e) {
    if (fd !== null) closeSync(fd)
    return fail(`Erro ao iniciar o processo: ${(e as Error).message}`)
  }

  const p: Proc = {
    info: {
      id,
      chatId,
      sessionId: ctx.sessionId ?? '',
      name,
      command,
      cwd,
      pid: child.pid ?? null,
      status: 'running',
      exitCode: null,
      signal: null,
      startedAt,
      endedAt: null,
      lines: 0,
      lastLine: '',
      logFile: fd !== null ? logFile : ''
    },
    child,
    lines: [],
    first: 1,
    chars: 0,
    partial: { out: '', err: '' },
    decoders: { out: new StringDecoder('utf8'), err: new StringDecoder('utf8') },
    fd,
    closed: false,
    waiters: new Set(),
    exitWaiters: new Set()
  }
  if (!registry.has(chatId)) registry.set(chatId, new Map())
  registry.get(chatId)!.set(id, p)

  child.stdout?.on('data', (d: Buffer) => onChunk(p, 'out', p.decoders.out.write(d)))
  child.stderr?.on('data', (d: Buffer) => onChunk(p, 'err', p.decoders.err.write(d)))
  let spawnError: string | null = null
  const markExit = (code: number | null, sig: NodeJS.Signals | null): void => {
    if (p.info.status === 'exited') return
    p.info.status = 'exited'
    p.info.exitCode = code
    p.info.signal = sig
    p.info.endedAt = Date.now()
    for (const w of [...p.exitWaiters]) w()
    pruneExited(chatId)
    notify(chatId)
  }
  child.on('error', (e) => {
    spawnError = e.message
    markExit(null, null)
  })
  child.on('exit', (code, sig) => {
    // dá um instante para os pipes entregarem o resto antes de marcar o fim
    setTimeout(() => {
      if (p.closed) return
      markExit(code, sig)
    }, 150)
  })
  child.on('close', (code, sig) => {
    p.closed = true
    flushPartials(p)
    if (p.fd !== null) {
      try {
        closeSync(p.fd)
      } catch {
        /* ignora */
      }
      p.fd = null
    }
    markExit(code, sig)
  })
  notify(chatId)

  // ---- espera: wait_for (ou ~1 s para pegar falhas imediatas) ----
  const max = maxOutputOf(ctx)
  type Outcome = { kind: 'match'; line: string } | { kind: 'exit' } | { kind: 'timeout' | 'abort' }
  const outcome = await new Promise<Outcome>((res) => {
    let settled = false
    const finish = (o: Outcome): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      p.exitWaiters.delete(onExit)
      if (waiter) p.waiters.delete(waiter)
      ctx.signal.removeEventListener('abort', onAbort)
      res(o)
    }
    const onExit = (): void => finish({ kind: 'exit' })
    const onAbort = (): void => finish({ kind: 'abort' })
    const waiter: Waiter | null = waitRe
      ? { re: waitRe, resolve: (line) => finish({ kind: 'match', line }) }
      : null
    if (waiter) p.waiters.add(waiter)
    p.exitWaiters.add(onExit)
    if (p.info.status === 'exited') onExit()
    const timer = setTimeout(
      () => finish({ kind: 'timeout' }),
      waitRe ? timeoutS * 1000 : START_SETTLE_MS
    )
    if (ctx.signal.aborted) onAbort()
    else ctx.signal.addEventListener('abort', onAbort, { once: true })
  })
  if (outcome.kind === 'exit') await waitExit(p, 500)

  const info = snapshot(p)
  const header = [
    `[processo ${label(info)} · ${stateText(info)}]`,
    `comando: ${command}`,
    `cwd: ${cwd}`,
    info.logFile ? `log completo: ${info.logFile}` : '[log em arquivo indisponível — só memória]'
  ].join('\n')
  const budget = Math.max(1000, max - header.length - 600)

  if (outcome.kind === 'exit') {
    const code = info.exitCode
    const failed = spawnError !== null || code !== 0
    const body = tailText(p, 60, budget)
    const what = spawnError
      ? `Erro: não foi possível iniciar o processo: ${spawnError}`
      : `${failed ? 'Erro: o processo' : 'O processo'} ${label(info)} saiu ${waitRe ? 'antes de casar o wait_for' : 'logo após iniciar'} (${info.exitCode !== null ? `exit code ${info.exitCode}` : `sinal ${info.signal ?? '?'}`}).`
    const content = `${what}\n${header}\n--- fim do log ---\n${body}`
    return failed || waitRe ? fail(content) : ok(content)
  }

  const head = headText(p, 15, Math.floor(budget * 0.4))
  const tail = tailText(p, 25, Math.floor(budget * 0.6))
  const total = info.lines
  const out =
    total <= 40 ? tailText(p, 40, budget) : `${head}\n[…]\n${tail.replace(/^\[… .*\]\n/, '')}`
  let status: string
  if (outcome.kind === 'match')
    status = `[wait_for casou em ${fmtDuration(Date.now() - startedAt)}: ${outcome.line.slice(0, 300)}]`
  else if (outcome.kind === 'timeout' && waitRe)
    status = `[wait_for não casou em ${timeoutS} s — o processo CONTINUA rodando; acompanhe com process_logs (since_line=${total}) ou pare com process_stop]`
  else if (outcome.kind === 'abort')
    status = '[espera interrompida — o processo CONTINUA rodando em segundo plano]'
  else status = '[iniciado; continua rodando em segundo plano]'
  return ok(
    `${status}\n${header}\n--- saída (${fmtNum(total)} linhas até agora) ---\n${out || '(sem saída ainda)'}\n[próximo: process_logs id=${id} since_line=${total} para ler só o que for novo]`
  )
}

// ---------------- process_logs ----------------

export async function processLogs(
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  const chatId = ctx.chatId
  if (!chatId) return fail('Erro: process_logs indisponível (sem chat).')
  const p = getProc(chatId, requireString(args, 'id'))
  const pattern = optString(args, 'pattern')
  let re: RegExp | null = null
  if (pattern) {
    try {
      re = new RegExp(pattern, optBool(args, 'case_insensitive') ? 'i' : '')
    } catch (e) {
      return fail(`Erro: pattern não é uma regex válida: ${(e as Error).message}`)
    }
  }
  const clampN = (v: number | undefined, def: number): number =>
    Math.min(L.processLogsMaxLines, Math.max(1, Math.floor(v ?? def)))
  const tail = clampN(optNumber(args, 'tail'), L.processLogsDefaultLines)
  const since = optNumber(args, 'since_line')
  const offset = optNumber(args, 'offset')
  const limit = clampN(optNumber(args, 'limit'), tail)
  const info = snapshot(p)
  const total = info.lines

  const head = [
    `[processo ${label(info)} · ${stateText(info)} · ${fmtNum(total)} linhas]`,
    info.logFile ? `log completo: ${info.logFile}` : ''
  ]
    .filter(Boolean)
    .join('\n')
  const notes: string[] = []
  if (p.first > 1)
    notes.push(
      `[a memória guarda as linhas ${fmtNum(p.first)}–${fmtNum(total)}; as ${fmtNum(p.first - 1)} primeiras só no arquivo de log${info.logFile ? ' (use search_files/read_file nele)' : ''}]`
    )
  // sem teto de caracteres além do de linhas: resultado grande vai para arquivo (runToolImpl)
  const budget = L.processLogsMaxLines * (L.processMaxLineChars + 64)
  const fmt = (i: number): string => `${p.first + i}\t${p.lines[i]}`
  const out: string[] = []
  let used = 0
  let footer = ''

  if (since !== undefined || offset !== undefined) {
    // leitura para a frente: since_line (exclusivo) ou offset (inclusivo)
    const startNo = since !== undefined ? Math.floor(since) + 1 : Math.max(1, Math.floor(offset!))
    if (startNo < p.first)
      notes.push(
        `[linhas ${fmtNum(startNo)}–${fmtNum(p.first - 1)} já saíram da memória — veja o arquivo de log]`
      )
    let i = Math.max(0, startNo - p.first)
    let lastNo = startNo - 1
    let matched = 0
    for (; i < p.lines.length && matched < limit; i++) {
      if (re && !re.test(p.lines[i])) {
        lastNo = p.first + i
        continue
      }
      const s = fmt(i)
      if (used + s.length + 1 > budget) break
      out.push(s)
      used += s.length + 1
      matched++
      lastNo = p.first + i
    }
    const more = i < p.lines.length
    if (!out.length && startNo > total)
      footer = `[nenhuma linha nova depois da linha ${fmtNum(startNo - 1)}]`
    else if (!out.length) footer = `[nenhuma linha${re ? ` casando /${pattern}/` : ''} nessa faixa]`
    if (more) footer += `${footer ? '\n' : ''}[há mais — continue com since_line=${lastNo}]`
    else footer += `${footer ? '\n' : ''}[fim do log até agora — próximo: since_line=${total}]`
  } else {
    // tail: últimas N linhas (ou N ocorrências)
    for (let i = p.lines.length - 1; i >= 0 && out.length < tail; i--) {
      if (re && !re.test(p.lines[i])) continue
      const s = fmt(i)
      if (used + s.length + 1 > budget) {
        notes.push('[saída cortada no limite de caracteres — peça menos linhas ou use pattern]')
        break
      }
      out.unshift(s)
      used += s.length + 1
    }
    if (!out.length) footer = re ? `[nenhuma linha casa /${pattern}/ na memória]` : '(sem saída)'
    else footer = `[próximo: since_line=${total} para ler só o que for novo]`
  }
  const partial = cleanLine(p.partial.out || p.partial.err)
  const forward = since !== undefined || offset !== undefined
  if (partial && (!re || re.test(partial)) && !forward)
    out.push(`…\t${partial}  [linha em andamento]`)
  const r = ok([head, ...notes, ...out, footer].filter(Boolean).join('\n'))
  if (out.length) {
    // só as linhas vão para o arquivo; estado e rodapé ficam inline (tail: início + fim)
    const top = [head, ...notes].filter(Boolean).join('\n')
    r.spill = {
      head: `${top}\n`,
      body: out.join('\n'),
      foot: footer ? `\n${footer}` : '',
      tail: !forward
    }
  }
  return r
}

// ---------------- process_list ----------------

export async function processList(
  _args: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  const chatId = ctx.chatId
  if (!chatId) return fail('Erro: process_list indisponível (sem chat).')
  const list = listProcesses(chatId)
  if (!list.length) return ok('Nenhum processo em segundo plano neste chat (use process_start).')
  const running = list.filter((p) => p.status === 'running').length
  const lines = list.map((p) => {
    const last = p.lastLine ? ` · último: "${p.lastLine.slice(0, 160)}"` : ''
    const own =
      ctx.sessionId && p.sessionId && p.sessionId !== ctx.sessionId ? ' · (outra sessão)' : ''
    return `${label(p)} · ${stateText(p)} · ${fmtNum(p.lines)} linhas · cwd ${p.cwd}${own}\n  $ ${p.command.replace(/\s+/g, ' ').slice(0, 300)}${last}`
  })
  return ok(`[${list.length} processo(s); ${running} rodando]\n${lines.join('\n')}`)
}

// ---------------- process_stop ----------------

const SIGNALS = ['SIGTERM', 'SIGINT', 'SIGKILL'] as const

/** Para o processo (grupo inteiro). Retorna o snapshot final. */
export async function stopProcess(
  chatId: string,
  id: string,
  signal: NodeJS.Signals = 'SIGTERM'
): Promise<{ info: ProcessInfo; already: boolean; forced: boolean }> {
  const p = getProc(chatId, id)
  const pid = p.info.pid ?? undefined
  const already = p.info.status === 'exited'
  let forced = false
  if (!already) {
    killGroup(pid, signal)
    if (!(await waitExit(p, signal === 'SIGKILL' ? 2000 : STOP_GRACE_MS))) {
      forced = true
      killGroup(pid, 'SIGKILL')
      await waitExit(p, 2000)
    }
  }
  // membros do grupo que ainda seguram os pipes (filhos em segundo plano)
  if (!p.closed) killGroup(pid, 'SIGKILL')
  notify(chatId)
  return { info: snapshot(p), already, forced }
}

export async function processStop(
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  const chatId = ctx.chatId
  if (!chatId) return fail('Erro: process_stop indisponível (sem chat).')
  const id = requireString(args, 'id')
  const sig = optString(args, 'signal') ?? 'SIGTERM'
  if (!(SIGNALS as readonly string[]).includes(sig))
    return fail(`Erro: signal deve ser um de ${SIGNALS.join(', ')}.`)
  const r = await stopProcess(chatId, id, sig as NodeJS.Signals)
  const p = getProc(chatId, id)
  const what = r.already
    ? `O processo ${label(r.info)} já tinha encerrado (${stateText(r.info)}).`
    : `Processo ${label(r.info)} parado: ${stateText(r.info)}${r.forced ? ` (não saiu com ${sig} em ${STOP_GRACE_MS / 1000} s — SIGKILL)` : ''}.`
  const budget = Math.max(1000, maxOutputOf(ctx) - 600)
  return ok(
    `${what}\n${r.info.logFile ? `log completo: ${r.info.logFile}\n` : ''}--- fim do log ---\n${tailText(p, 20, budget)}`
  )
}

// ---------------- ciclo de vida ----------------

/** Apagar o chat: para todos os processos dele e apaga os logs. */
export async function stopChatProcesses(chatId: string): Promise<void> {
  const m = registry.get(chatId)
  if (!m) return
  await Promise.all(
    [...m.keys()].map((id) => stopProcess(chatId, id, 'SIGTERM').catch(() => undefined))
  )
  for (const p of m.values()) {
    if (p.info.logFile) rmSync(p.info.logFile, { force: true })
  }
  registry.delete(chatId)
  counters.delete(chatId)
  listener?.(chatId, [])
}

function alive(pid: number): boolean {
  try {
    process.kill(-pid, 0)
    return true
  } catch {
    return false
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * Fechamento do app (before-quit / exit): SIGTERM em todos os grupos, até ~300 ms de espera e
 * SIGKILL nos que restarem. Síncrono — não deixa órfãos.
 */
export function killAllProcesses(graceMs = 300): number {
  const pids: number[] = []
  for (const m of registry.values())
    for (const p of m.values())
      if (p.info.pid && (p.info.status === 'running' || !p.closed)) pids.push(p.info.pid)
  for (const pid of pids) killGroup(pid, 'SIGTERM')
  const until = Date.now() + graceMs
  while (pids.some(alive) && Date.now() < until) sleepSync(20)
  for (const pid of pids) if (alive(pid)) killGroup(pid, 'SIGKILL')
  return pids.length
}

/** UI: últimas linhas (numeradas) de um processo do chat. */
export function processLogLines(
  chatId: string,
  id: string,
  tail = 200
): { info: ProcessInfo; lines: { n: number; text: string }[] } {
  const p = getProc(chatId, id)
  const n = Math.min(L.processLogsMaxLines, Math.max(1, Math.floor(tail)))
  const start = Math.max(0, p.lines.length - n)
  const lines = p.lines.slice(start).map((text, i) => ({ n: p.first + start + i, text }))
  const partial = cleanLine(p.partial.out || p.partial.err)
  if (partial) lines.push({ n: p.first + p.lines.length, text: partial })
  return { info: snapshot(p), lines }
}

/** Testes: limpa o registro (sem matar). */
export function _resetProcesses(): void {
  registry.clear()
  counters.clear()
}
