// shell (tool `shell`, antes `bash`): roda o comando no shell do usuário (zsh ou bash — ver
// shellEnv.ts: `-c` com o ambiente do shell de login/interativo resolvido uma vez) num process
// group próprio (kill do grupo em abort/timeout). Helpers exportados são reusados por processes.ts.
// - Começa no diretório do shell da sessão (ctx.shell.dir; 1ª chamada = diretório raiz) e, ao sair,
//   um trap EXIT escreve o `pwd` final no fd 3 — o diretório persiste entre chamadas.
// - Confinação: se o shell terminar fora do raiz, a próxima chamada volta ao raiz (e o resultado avisa).
// - Sandbox opcional (bubblewrap): raiz gravável, resto do FS somente leitura, /tmp privado, rede ok.
import { spawn, spawnSync } from 'child_process'
import { existsSync, realpathSync, statSync } from 'fs'
import { LIMITS } from '@shared/limits'
import { shellLaunch } from './shellEnv'
export { shellLabel } from './shellEnv'
import {
  abortError,
  fail,
  fmtNum,
  isInside,
  maxOutputOf,
  ok,
  optNumber,
  requireString,
  truncateHeadTail,
  type ToolContext,
  type ToolResult
} from './util'

const DEFAULT_TIMEOUT = 120_000
const MAX_TIMEOUT = 30 * 60_000
const HEAD_KEEP = 200_000 // início da saída sempre preservado
const TAIL_KEEP = 2_000_000 // fim da saída (o meio além disso é descartado e contado)

export const BASH_HINT =
  '[dica: redirecione saídas grandes para um arquivo (cmd > saida.txt 2>&1) e inspecione com grep/head/tail ou read_file com offset/limit]'

let bwrapCache: boolean | null = null
export function bwrapAvailable(): boolean {
  if (bwrapCache === null) {
    try {
      bwrapCache = process.platform === 'linux' && spawnSync('bwrap', ['--version']).status === 0
    } catch {
      bwrapCache = false
    }
  }
  return bwrapCache
}

export function killGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return
  try {
    process.kill(-pid, signal)
  } catch {
    try {
      process.kill(pid, signal)
    } catch {
      /* já morreu */
    }
  }
}

export const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

export const real = (p: string): string => {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

/** Script executado: trap que reporta o pwd final no fd 3, cd para o diretório inicial, comando. */
export function wrapCommand(command: string): string {
  // Prólogo na MESMA linha do comando: números de linha em mensagens de erro do bash batem.
  return (
    `trap 'builtin pwd >&3 2>/dev/null' EXIT; ` +
    `cd -- "$CLEAR_START_DIR" 2>/dev/null || cd -- "$CLEAR_ROOT_DIR" || exit 1; ` +
    command
  )
}

/** Comando + argv para rodar `script` no shell (via bubblewrap se `sandbox`). */
export function shellArgv(
  shellPath: string,
  flag: string,
  script: string,
  sandbox: boolean,
  rootReal: string
): [string, string[]] {
  return sandbox
    ? [
        'bwrap',
        [
          '--ro-bind',
          '/',
          '/',
          '--dev',
          '/dev',
          '--proc',
          '/proc',
          '--tmpfs',
          '/tmp',
          '--bind',
          rootReal,
          rootReal,
          '--chdir',
          rootReal,
          '--die-with-parent',
          shellPath,
          flag,
          script
        ]
      ]
    : [shellPath, [flag, script]]
}

export function shell(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const command = requireString(args, 'command')
  const timeoutMs = Math.min(
    MAX_TIMEOUT,
    Math.max(1000, Math.floor(optNumber(args, 'timeout_ms') ?? DEFAULT_TIMEOUT))
  )
  const root = ctx.cwd
  if (!existsSync(root)) return Promise.resolve(fail(`Erro: o diretório raiz não existe: ${root}`))
  if (ctx.signal.aborted) return Promise.reject(abortError())

  const notes: string[] = []
  let start = ctx.shell?.dir || root
  if (start !== root && (!isDir(start) || (ctx.confine && !isInside(real(root), real(start))))) {
    notes.push(
      `[o diretório anterior do shell (${start}) não está disponível; começando no diretório raiz]`
    )
    start = root
  }
  const max = maxOutputOf(ctx)
  const sandbox = !!ctx.sandbox && bwrapAvailable()

  return shellLaunch({ CLEAR_START_DIR: start, CLEAR_ROOT_DIR: root }).then((launch) =>
    runShell(launch, command, start, root, timeoutMs, notes, max, sandbox, ctx)
  )
}

function runShell(
  launch: Awaited<ReturnType<typeof shellLaunch>>,
  command: string,
  start: string,
  root: string,
  timeoutMs: number,
  notes: string[],
  max: number,
  sandbox: boolean,
  ctx: ToolContext
): Promise<ToolResult> {
  if (ctx.signal.aborted) return Promise.reject(abortError())
  return new Promise<ToolResult>((resolvePromise, reject) => {
    const env = launch.env
    const script = wrapCommand(command)
    const rootReal = real(root)
    const [cmd, argv] = shellArgv(launch.shell.path, launch.flag, script, sandbox, rootReal)
    const child = spawn(cmd, argv as string[], {
      cwd: start,
      env,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe', 'pipe']
    })
    let head = ''
    let tail = ''
    let dropped = 0
    let droppedLines = 0
    let pwdOut = ''
    let timedOut = false
    let aborted = false
    let settled = false
    let killTimer: NodeJS.Timeout | null = null

    const onData = (d: Buffer): void => {
      let s = d.toString('utf8')
      if (head.length < HEAD_KEEP) {
        const take = HEAD_KEEP - head.length
        head += s.slice(0, take)
        s = s.slice(take)
      }
      if (s) {
        tail += s
        if (tail.length > TAIL_KEEP) {
          const cut = tail.slice(0, tail.length - TAIL_KEEP)
          dropped += cut.length
          droppedLines += cut.split('\n').length - 1
          tail = tail.slice(cut.length)
        }
      }
      if (ctx.onOutput)
        ctx.onOutput(tail.length ? (head + tail).slice(-20_000) : head.slice(-20_000))
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    const fd3 = child.stdio[3] as NodeJS.ReadableStream | null | undefined
    fd3?.on('data', (d: Buffer) => {
      pwdOut += d.toString('utf8')
    })
    fd3?.on('error', () => {})

    const terminate = (): void => {
      killGroup(child.pid, 'SIGTERM')
      killTimer = setTimeout(() => killGroup(child.pid, 'SIGKILL'), 2000)
    }
    const timer = setTimeout(() => {
      timedOut = true
      terminate()
    }, timeoutMs)
    const onAbort = (): void => {
      aborted = true
      terminate()
    }
    ctx.signal.addEventListener('abort', onAbort, { once: true })

    const finish = (code: number | null, sig: NodeJS.Signals | null, err?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      ctx.signal.removeEventListener('abort', onAbort)
      if (aborted) {
        reject(abortError())
        return
      }
      if (err) {
        resolvePromise(fail(`Erro ao executar o shell: ${err.message}`))
        return
      }
      // diretório final do shell
      const reported = pwdOut
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .pop()
      let endDir = reported && isDir(reported) ? reported : start
      if (ctx.confine && !isInside(rootReal, real(endDir))) {
        notes.push(
          `[o shell terminou fora do diretório raiz (${endDir}); a próxima chamada começará no diretório raiz ${root}]`
        )
        endDir = root
      }
      if (ctx.shell) ctx.shell.dir = endDir

      const full = (head + tail).replace(/\s+$/, '')
      const body = truncateHeadTail(
        full,
        Math.max(1000, max - 400),
        LIMITS.bashHeadRatio,
        BASH_HINT,
        dropped ? { chars: dropped, lines: droppedLines } : undefined
      )
      const status = timedOut
        ? `[timeout: processo encerrado após ${fmtNum(timeoutMs)} ms]`
        : `[exit code: ${code ?? (sig ? `sinal ${sig}` : '?')}]`
      const where = endDir !== root ? `\n[cwd: ${endDir}]` : ''
      const content = `${body ? body + '\n' : '(sem saída)\n'}${status}${where}${notes.length ? '\n' + notes.join('\n') : ''}`
      const meta = { shellCwd: endDir }
      resolvePromise(timedOut ? fail(content, meta) : ok(content, meta))
    }
    child.on('error', (e) => finish(null, null, e))
    child.on('close', (code, sig) => finish(code, sig))
    // Processos em background podem manter stdout aberto: após 'exit', espera um pouco e encerra.
    child.on('exit', (code, sig) => {
      setTimeout(() => finish(code, sig), 300)
    })
  })
}

/** Nome antigo (testes/compatibilidade). */
export const bash = shell
