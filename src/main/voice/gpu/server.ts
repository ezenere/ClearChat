// "Modo avançado (GPU local)" — ciclo de vida dos processos do servidor (main, sem Electron).
//
// Um processo `server.py serve` por GRUPO de pacotes (os motores TTS de grupos diferentes não
// convivem no mesmo Python — conflitos de transformers): cada um em 127.0.0.1:<porta livre>, com o
// TOKEN da sessão no ambiente (`CLEARCHAT_GPU_TOKEN`, exigido em toda request — nunca vai ao
// renderer). O whisper (faster-whisper, sem transformers) roda junto do processo de qualquer grupo;
// sem TTS rodando, num processo do grupo base. Spawn sem shell → espera `/health` → pronto. Caiu
// sem ser pedido: reinicia UMA vez; caiu de novo → erro legível (com as últimas linhas do log).
// O próprio servidor sai depois de ocioso (`idle-exit`) — aí o estado volta a "parado" e a próxima
// fala sobe de novo. stderr → `<gpu-runtime>/logs/server-<grupo>.log`.
import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createWriteStream, type WriteStream } from 'node:fs'
import { mkdir, rename, stat } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import type { GpuEngineGroup } from '@shared/gpuVoice'
import { killTree, lineSplitter } from './proc'

export type ServerProcState = 'starting' | 'running' | 'error' | 'stopped'

export interface ServerProcInfo {
  group: GpuEngineGroup
  engines: string[]
  state: ServerProcState
  port: number | null
  error: string | null
}

export interface SpawnSpec {
  python: string
  args: string[]
  env: NodeJS.ProcessEnv
  cwd: string
}

export interface ServerManagerDeps {
  /** Monta o comando de um grupo (python do grupo + server.py serve …). */
  spec(group: GpuEngineGroup, engines: string[], port: number, token: string): SpawnSpec
  logDir: string
  spawn?: (spec: SpawnSpec) => ChildProcess
  fetch?: typeof fetch
  /** Porta livre (testes injetam). */
  freePort?: () => Promise<number>
  healthTimeoutMs?: number
  onChange?: () => void
  log?: (msg: string) => void
}

interface Proc {
  group: GpuEngineGroup
  engines: string[]
  port: number
  child: ChildProcess | null
  state: ServerProcState
  error: string | null
  ready: Promise<void> | null
  restarts: number
  stopping: boolean
  idleExit: boolean
  tail: string[]
  log: WriteStream | null
}

/** Porta TCP livre em 127.0.0.1 (o SO escolhe). */
export function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.unref()
    s.on('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      s.close(() => (port ? resolve(port) : reject(new Error('sem porta livre'))))
    })
  })
}

/** Token aleatório da sessão (192 bits, base64url). */
export const newSessionToken = (): string => randomBytes(24).toString('base64url')

export class GpuServerManager {
  readonly token: string
  private readonly procs = new Map<GpuEngineGroup, Proc>()
  private readonly locks = new Map<GpuEngineGroup, Promise<void>>()
  private readonly fetchImpl: typeof fetch

  private readonly deps: ServerManagerDeps

  constructor(deps: ServerManagerDeps, token: string = newSessionToken()) {
    this.deps = deps
    this.token = token
    this.fetchImpl = deps.fetch ?? fetch
  }

  list(): ServerProcInfo[] {
    return [...this.procs.values()].map((p) => ({
      group: p.group,
      engines: [...p.engines],
      state: p.state,
      port: p.state === 'running' ? p.port : null,
      error: p.error
    }))
  }

  /** Processo vivo (ou subindo) de um grupo. */
  get(group: GpuEngineGroup): ServerProcInfo | null {
    return this.list().find((p) => p.group === group) ?? null
  }

  private changed(): void {
    this.deps.onChange?.()
  }

  private async openLog(group: GpuEngineGroup): Promise<WriteStream | null> {
    try {
      await mkdir(this.deps.logDir, { recursive: true })
      const file = join(this.deps.logDir, `server-${group}.log`)
      // rotação simples: > 5 MB → .1
      const st = await stat(file).catch(() => null)
      if (st && st.size > 5 * 2 ** 20) await rename(file, `${file}.1`).catch(() => undefined)
      return createWriteStream(file, { flags: 'a' })
    } catch {
      return null
    }
  }

  /**
   * Garante o processo do grupo rodando e saudável com (pelo menos) estes motores. Já rodando com
   * todos → reaproveita; faltando motor → reinicia com a união. Resolve com a porta.
   */
  async ensure(group: GpuEngineGroup, engines: string[]): Promise<number> {
    // uma subida por grupo de cada vez (duas falas simultâneas não sobem dois processos)
    const prev = this.locks.get(group) ?? Promise.resolve()
    let release: () => void = () => undefined
    const mine = new Promise<void>((r) => (release = r))
    const chain = prev.then(() => mine)
    this.locks.set(group, chain)
    await prev
    try {
      return await this.ensureLocked(group, engines)
    } finally {
      release()
      if (this.locks.get(group) === chain) this.locks.delete(group)
    }
  }

  private async ensureLocked(group: GpuEngineGroup, engines: string[]): Promise<number> {
    const cur = this.procs.get(group)
    if (cur && (cur.state === 'running' || cur.state === 'starting')) {
      const missing = engines.filter((e) => !cur.engines.includes(e))
      if (!missing.length) {
        await cur.ready
        if (cur.state !== 'running') throw new Error(cur.error ?? 'servidor da GPU não subiu')
        return cur.port
      }
      engines = [...new Set([...cur.engines, ...engines])]
      await this.stop(group)
    }
    return this.start(group, engines)
  }

  private async start(group: GpuEngineGroup, engines: string[], restarts = 0): Promise<number> {
    const port = await (this.deps.freePort ?? findFreePort)()
    const p: Proc = {
      group,
      engines: [...engines],
      port,
      child: null,
      state: 'starting',
      error: null,
      ready: null,
      restarts,
      stopping: false,
      idleExit: false,
      tail: [],
      log: await this.openLog(group)
    }
    this.procs.set(group, p)
    this.changed()
    const spec = this.deps.spec(group, engines, port, this.token)
    p.log?.write(
      `\n[${new Date().toISOString()}] iniciando ${group}: ${engines.join(',')} porta ${port}\n`
    )
    let child: ChildProcess
    try {
      child = this.deps.spawn
        ? this.deps.spawn(spec)
        : spawn(spec.python, spec.args, {
            cwd: spec.cwd,
            env: spec.env,
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: process.platform !== 'win32',
            windowsHide: true
          })
    } catch (e) {
      p.state = 'error'
      p.error = `não consegui iniciar o servidor da GPU: ${e instanceof Error ? e.message : String(e)}`
      this.changed()
      throw new Error(p.error, { cause: e })
    }
    p.child = child
    const keep = (l: string): void => {
      if (!l.trim()) return
      p.tail.push(l)
      if (p.tail.length > 30) p.tail.shift()
      p.log?.write(`${l}\n`)
    }
    child.stdout?.on(
      'data',
      lineSplitter((l) => {
        if (l.includes('"idle-exit"')) p.idleExit = true
        keep(l)
      })
    )
    child.stderr?.on('data', lineSplitter(keep))
    let exited: (code: number | null) => void = () => undefined
    const exitP = new Promise<number | null>((r) => (exited = r))
    child.on('error', (e) => {
      keep(`erro do processo: ${e.message}`)
      exited(-1)
    })
    child.on('exit', (code) => exited(code))
    void exitP.then((code) => this.onExit(p, code))
    p.ready = this.waitHealthy(p, exitP)
    try {
      await p.ready
    } catch (e) {
      if (p.state === 'starting') {
        p.state = 'error'
        p.error = e instanceof Error ? e.message : String(e)
        killTree(child, 'SIGKILL')
        this.changed()
      }
      throw e
    }
    return port
  }

  private async waitHealthy(p: Proc, exitP: Promise<number | null>): Promise<void> {
    const deadline = Date.now() + (this.deps.healthTimeoutMs ?? 90_000)
    let exitedCode: number | null | undefined
    void exitP.then((c) => (exitedCode = c))
    while (Date.now() < deadline) {
      if (exitedCode !== undefined) {
        throw new Error(
          `o servidor da GPU saiu ao iniciar (código ${exitedCode})${p.tail.length ? `: ${p.tail.slice(-4).join(' | ')}` : ''}`
        )
      }
      if (p.stopping) throw new Error('servidor da GPU parado')
      try {
        const r = await this.fetchImpl(`http://127.0.0.1:${p.port}/health`, {
          headers: { Authorization: `Bearer ${this.token}` },
          signal: AbortSignal.timeout(2000)
        })
        if (r.ok) {
          p.state = 'running'
          p.error = null
          this.changed()
          return
        }
      } catch {
        /* ainda subindo */
      }
      await new Promise((r) => setTimeout(r, 250))
    }
    throw new Error('o servidor da GPU não respondeu a tempo (90 s) — veja o log do servidor')
  }

  private onExit(p: Proc, code: number | null): void {
    p.log?.write(`[${new Date().toISOString()}] saiu (código ${code})\n`)
    p.log?.end()
    p.log = null
    if (this.procs.get(p.group) !== p) return
    if (p.stopping || p.idleExit || code === 0) {
      this.procs.delete(p.group)
      this.deps.log?.(`servidor GPU ${p.group} parado${p.idleExit ? ' (ocioso)' : ''}`)
      this.changed()
      return
    }
    if (p.state === 'starting') return // o waitHealthy reporta
    // caiu sozinho: reinicia uma vez; na segunda, erro
    if (p.restarts < 1) {
      this.deps.log?.(`servidor GPU ${p.group} caiu (código ${code}) — reiniciando`)
      void this.start(p.group, p.engines, p.restarts + 1).catch(() => undefined)
      return
    }
    p.state = 'error'
    p.error = `o servidor da GPU caiu (código ${code})${p.tail.length ? `: ${p.tail.slice(-3).join(' | ')}` : ''}`
    p.child = null
    this.changed()
  }

  /** Para um grupo (SIGTERM; SIGKILL depois de 3 s). */
  async stop(group: GpuEngineGroup): Promise<void> {
    const p = this.procs.get(group)
    if (!p) return
    p.stopping = true
    const child = p.child
    this.procs.delete(group)
    this.changed()
    if (!child || child.exitCode !== null) return
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        killTree(child, 'SIGKILL')
        resolve()
      }, 3000)
      child.once('exit', () => {
        clearTimeout(t)
        resolve()
      })
      killTree(child, 'SIGTERM')
    })
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.procs.keys()].map((g) => this.stop(g)))
  }

  /** Saída do app: mata tudo já (síncrono). */
  killAllNow(): void {
    for (const p of this.procs.values()) {
      p.stopping = true
      if (p.child) killTree(p.child, 'SIGKILL')
    }
    this.procs.clear()
  }

  /** Últimas linhas do processo (para mensagens/log). */
  tail(group: GpuEngineGroup): string[] {
    return [...(this.procs.get(group)?.tail ?? [])]
  }
}
