// Processos filhos do modo GPU (pip, downloads, servidor): sem shell, saída por linhas, cancelamento
// que derruba a ÁRVORE inteira (o pip abre subprocessos; no POSIX o filho vira líder de grupo e o
// grupo recebe o sinal; no Windows, `taskkill /T /F`). Injetável nos testes (`ProcessRunner`).
import { spawn, type ChildProcess } from 'node:child_process'

export interface RunOptions {
  env?: NodeJS.ProcessEnv
  cwd?: string
  signal?: AbortSignal
  onStdoutLine?: (line: string) => void
  onStderrLine?: (line: string) => void
}

export interface RunResult {
  code: number | null
  /** Últimas linhas (stdout+stderr) para mensagens de erro legíveis. */
  tail: string[]
}

export type ProcessRunner = (cmd: string, args: string[], opts: RunOptions) => Promise<RunResult>

/** Derruba o processo e seus filhos (melhor esforço). */
export function killTree(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): void {
  if (child.pid == null || child.exitCode !== null) return
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true
      })
    } catch {
      child.kill()
    }
    return
  }
  try {
    process.kill(-child.pid, signal)
  } catch {
    try {
      child.kill(signal)
    } catch {
      /* já saiu */
    }
  }
}

/** Separa um stream em linhas (o resto incompleto fica para o próximo pedaço). */
export function lineSplitter(cb: (line: string) => void): (b: Buffer | string) => void {
  let rest = ''
  return (b) => {
    rest += b.toString()
    const parts = rest.split(/\r?\n|\r/)
    rest = parts.pop() ?? ''
    for (const p of parts) cb(p)
  }
}

export const defaultRunner: ProcessRunner = (cmd, args, opts) =>
  new Promise((resolve, reject) => {
    const tail: string[] = []
    const push = (l: string): void => {
      if (!l.trim()) return
      tail.push(l)
      if (tail.length > 40) tail.shift()
    }
    let child: ChildProcess
    try {
      child = spawn(cmd, args, {
        cwd: opts.cwd,
        env: opts.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true
      })
    } catch (e) {
      reject(e)
      return
    }
    const onAbort = (): void => {
      killTree(child, 'SIGTERM')
      setTimeout(() => killTree(child, 'SIGKILL'), 3000).unref()
    }
    if (opts.signal?.aborted) onAbort()
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout?.on(
      'data',
      lineSplitter((l) => {
        push(l)
        opts.onStdoutLine?.(l)
      })
    )
    child.stderr?.on(
      'data',
      lineSplitter((l) => {
        push(l)
        opts.onStderrLine?.(l)
      })
    )
    child.on('error', (e) => {
      opts.signal?.removeEventListener('abort', onAbort)
      reject(e)
    })
    child.on('close', (code) => {
      opts.signal?.removeEventListener('abort', onAbort)
      resolve({ code, tail })
    })
  })
