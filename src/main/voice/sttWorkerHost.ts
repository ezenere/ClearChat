// Host do processo do motor local de STT (`sttWorker.ts`) no main: inicia o processo sob demanda
// (lazy), fala o protocolo de `sttWorkerProtocol.ts`, traduz falhas em `SttError` legível e
// sobrevive a crash (o processo morto rejeita os pedidos pendentes; o próximo pedido o recria).
// Sem import estático do Electron: no app usa `utilityProcess` (o jeito recomendado para módulos
// nativos fora do main), em Node puro (testes/scripts) `child_process.fork`. O spawner é injetável.
// Ver SPEC → "Áudio → Runtime local de STT".
import { fork } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { abortError } from '../tools/util'
import { SttError } from './stt'
import type {
  SttWorkerProbeResult,
  SttWorkerRequest,
  SttWorkerResponse,
  SttWorkerTranscribeResult
} from './sttWorkerProtocol'

/** Canal mínimo com o processo do worker (utilityProcess ou child_process). */
export interface SttWorkerChannel {
  post(msg: SttWorkerRequest): void
  onMessage(cb: (msg: SttWorkerResponse) => void): void
  /** Saída do processo (código; null = morto por sinal) — inclui crash nativo. */
  onExit(cb: (code: number | null) => void): void
  kill(): void
  /**
   * Segura (true) ou solta (false) o processo pai vivo por causa deste filho: ocioso, o worker
   * nunca impede o Node/Electron de sair; com pedido pendente, sim. Opcional.
   */
  hold?(active: boolean): void
  /** Como o processo foi iniciado (diagnóstico nos logs). */
  kind?: string
}

/** Cria (inicia) o processo do worker. */
export type SttWorkerSpawner = () => SttWorkerChannel

type Distribute<T> = T extends unknown ? Omit<T, 'id'> : never
/** Pedido sem o `id` (o host numera). */
export type SttWorkerCommand = Distribute<SttWorkerRequest>

/** Desliga o processo ocioso depois deste tempo (libera a RAM do modelo). */
export const STT_WORKER_IDLE_MS = 10 * 60_000

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

// ---------------- spawners padrão ----------------

/** Caminho do entry do worker no build (`out/main/sttWorker.js`, ao lado do `index.js`). */
function builtWorkerEntry(): string | null {
  if (typeof __dirname !== 'string') return null
  const p = join(__dirname, 'sttWorker.js')
  return p
}

/** Entry em TS + hooks de resolução (Node puro, a partir da raiz do repositório — testes/scripts). */
function sourceWorkerEntry(): { entry: string; hooks: string } | null {
  const entry = join(process.cwd(), 'src/main/voice/sttWorker.ts')
  const hooks = join(process.cwd(), 'e2e/ts-hooks.mjs')
  return existsSync(entry) && existsSync(hooks) ? { entry, hooks } : null
}

/** `child_process.fork` com serialização estruturada (Float32Array passa intacto). */
export function forkSpawner(entry: string, execArgv: string[] = []): SttWorkerSpawner {
  return () => {
    const child = fork(entry, [], {
      execArgv,
      serialization: 'advanced',
      stdio: ['ignore', 'inherit', 'inherit', 'ipc']
    })
    return {
      kind: 'child_process',
      post: (msg) => {
        if (child.connected) child.send(msg)
      },
      onMessage: (cb) => child.on('message', (m) => cb(m as SttWorkerResponse)),
      onExit: (cb) => {
        child.on('exit', (code) => cb(code))
        child.on('error', () => cb(null))
      },
      kill: () => {
        child.kill()
      },
      hold: (active) => {
        const ch = child.channel as { ref?(): void; unref?(): void } | null | undefined
        if (active) {
          child.ref()
          ch?.ref?.()
        } else {
          child.unref()
          ch?.unref?.()
        }
      }
    }
  }
}

type UtilityProcessLike = {
  postMessage(msg: unknown): void
  on(event: 'message', cb: (msg: unknown) => void): void
  on(event: 'exit', cb: (code: number) => void): void
  on(event: 'error', cb: (...args: unknown[]) => void): void
  kill(): boolean
}

/** Electron `utilityProcess.fork` (processo Node à parte, gerenciado pelo Electron). */
function utilitySpawner(entry: string): SttWorkerSpawner | null {
  try {
    const base = typeof __filename === 'string' ? __filename : join(process.cwd(), 'stt-host.js')
    const electron = createRequire(base)('electron') as
      | { utilityProcess?: { fork(p: string, a?: string[], o?: object): UtilityProcessLike } }
      | string
    const up = typeof electron === 'object' ? electron.utilityProcess : undefined
    if (!up) return null
    return () => {
      const child = up.fork(entry, [], { serviceName: 'ClearChat STT', stdio: 'inherit' })
      let exited = false
      return {
        kind: 'utilityProcess',
        post: (msg) => {
          if (!exited) child.postMessage(msg)
        },
        onMessage: (cb) => child.on('message', (m) => cb(m as SttWorkerResponse)),
        onExit: (cb) => {
          child.on('exit', (code) => {
            exited = true
            cb(code)
          })
          // erro fatal do V8 no filho: o 'exit' vem em seguida; o host trata a dupla notificação
          child.on('error', () => {
            exited = true
            cb(null)
          })
        },
        kill: () => {
          child.kill()
        }
      }
    }
  } catch {
    return null
  }
}

/**
 * Spawner padrão: no Electron (main do app) `utilityProcess` com o entry do build; fora dele (Node
 * puro) `child_process.fork` com o entry do build, ou o `.ts` do repositório com os hooks dos testes.
 */
export function defaultSttWorkerSpawner(): SttWorkerSpawner {
  const built = builtWorkerEntry()
  if (process.versions.electron && process.type === 'browser' && built) {
    const sp = utilitySpawner(built)
    if (sp) return sp
  }
  if (built && existsSync(built)) return forkSpawner(built)
  const src = sourceWorkerEntry()
  if (src) return forkSpawner(src.entry, ['--import', src.hooks])
  return () => {
    throw new Error('entry do processo de transcrição local não encontrado nesta instalação')
  }
}

// ---------------- host ----------------

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: unknown) => void
  /** Pedido abandonado pelo chamador (abort): a resposta é descartada quando chegar. */
  abandoned: boolean
}

export interface SttWorkerHostOptions {
  spawn?: SttWorkerSpawner
  /** Ociosidade até desligar o processo (padrão `STT_WORKER_IDLE_MS`; 0 = nunca). */
  idleMs?: number
}

/**
 * Processo do motor local com fila de pedidos: `probe`, `transcribe` (modelo em cache dentro do
 * worker — no máximo um; trocar de modelo reinicia o processo para devolver a RAM), `unload`,
 * `terminate`. Abort do chamador rejeita na hora com `AbortError` (o whisper é síncrono no worker:
 * o resultado que chegar depois é descartado). Crash do processo → `SttError` `config` legível nos
 * pendentes e o próximo pedido inicia um processo novo.
 */
export class SttWorkerHost {
  readonly #spawn: SttWorkerSpawner
  readonly #idleMs: number
  readonly #log: boolean
  #ch: SttWorkerChannel | null = null
  #gen = 0
  #seq = 0
  #pending = new Map<number, Pending>()
  #loadedModel: string | null = null
  #idleTimer: ReturnType<typeof setTimeout> | null = null
  /** Quantos processos já foram iniciados (diagnóstico/testes). */
  spawnCount = 0

  constructor(opts: SttWorkerHostOptions = {}) {
    this.#spawn = opts.spawn ?? defaultSttWorkerSpawner()
    this.#idleMs = opts.idleMs ?? STT_WORKER_IDLE_MS
    this.#log = !opts.spawn // só o host padrão (o do app) registra nos logs
  }

  /** Modelo carregado no processo atual (null = nenhum/processo parado). */
  get loadedModel(): string | null {
    return this.#loadedModel
  }

  get running(): boolean {
    return this.#ch !== null
  }

  #ensure(): SttWorkerChannel {
    if (this.#ch) return this.#ch
    const gen = ++this.#gen
    let ch: SttWorkerChannel
    try {
      ch = this.#spawn()
    } catch (e) {
      throw new SttError(
        'config',
        `motor local de transcrição não está pronto — o processo do motor não pôde ser iniciado (${errText(e)})`,
        { backend: 'local', cause: e }
      )
    }
    this.spawnCount++
    this.#ch = ch
    ch.hold?.(false)
    if (this.#log)
      console.log(`[clearchat] STT local: processo do motor iniciado (${ch.kind ?? '?'})`)
    ch.onMessage((msg) => {
      if (gen !== this.#gen) return
      this.#onMessage(msg)
    })
    ch.onExit((code) => {
      if (gen !== this.#gen) return // processo antigo (terminado de propósito) — já tratado
      this.#gen++
      this.#ch = null
      this.#loadedModel = null
      this.#clearIdle()
      const err = new SttError(
        'config',
        `o motor local de transcrição parou inesperadamente (${code === null ? 'sinal' : `código ${code}`}) — tente de novo; se repetir, troque o modelo em Configurações → Áudio ou use o modo API`,
        { backend: 'local' }
      )
      this.#rejectAll(err)
    })
    return ch
  }

  #onMessage(msg: SttWorkerResponse): void {
    if (!msg || typeof msg !== 'object' || typeof msg.id !== 'number') return
    const p = this.#pending.get(msg.id)
    if (!p) return
    this.#pending.delete(msg.id)
    if (!this.#pending.size) this.#ch?.hold?.(false)
    this.#armIdle()
    if (p.abandoned) return
    if (msg.ok) p.resolve(msg.value)
    else p.reject(Object.assign(new Error(msg.message), { workerCode: msg.code }))
  }

  #rejectAll(err: unknown): void {
    const all = [...this.#pending.values()]
    this.#pending.clear()
    for (const p of all) if (!p.abandoned) p.reject(err)
  }

  #clearIdle(): void {
    if (this.#idleTimer) clearTimeout(this.#idleTimer)
    this.#idleTimer = null
  }

  #armIdle(): void {
    this.#clearIdle()
    if (!this.#idleMs || this.#pending.size || !this.#ch) return
    this.#idleTimer = setTimeout(() => {
      this.#idleTimer = null
      if (!this.#pending.size) this.terminate()
    }, this.#idleMs)
    this.#idleTimer.unref?.()
  }

  /** Envia um pedido e espera a resposta (abort → `AbortError` imediato; resposta descartada). */
  request<T>(cmd: SttWorkerCommand, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(abortError())
    let ch: SttWorkerChannel
    try {
      ch = this.#ensure()
    } catch (e) {
      return Promise.reject(e)
    }
    this.#clearIdle()
    const id = ++this.#seq
    return new Promise<T>((resolve, reject) => {
      const entry: Pending = {
        resolve: (v) => {
          signal?.removeEventListener('abort', onAbort)
          resolve(v as T)
        },
        reject: (e) => {
          signal?.removeEventListener('abort', onAbort)
          reject(e)
        },
        abandoned: false
      }
      const onAbort = (): void => {
        entry.abandoned = true
        reject(abortError())
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.#pending.set(id, entry)
      ch.hold?.(true)
      try {
        ch.post({ ...cmd, id } as SttWorkerRequest)
      } catch (e) {
        this.#pending.delete(id)
        entry.reject(e)
      }
    })
  }

  /** O binding nativo carrega neste processo? (nunca lança — falha vira `available: false`). */
  async probe(): Promise<SttWorkerProbeResult> {
    try {
      return await this.request<SttWorkerProbeResult>({ type: 'probe' })
    } catch (e) {
      return { available: false, reason: errText(e) }
    }
  }

  /**
   * Transcreve no processo do worker. Modelo diferente do carregado com o processo ocioso → reinicia
   * o processo (garante a RAM do anterior de volta; no máximo um modelo carregado).
   */
  async transcribe(
    modelPath: string,
    samples: Float32Array,
    opts: { language: string | null; nThreads: number; signal?: AbortSignal }
  ): Promise<SttWorkerTranscribeResult> {
    if (this.#loadedModel && this.#loadedModel !== modelPath && !this.#pending.size)
      this.terminate()
    this.#loadedModel = modelPath
    try {
      return await this.request<SttWorkerTranscribeResult>(
        {
          type: 'transcribe',
          modelPath,
          samples,
          language: opts.language,
          nThreads: opts.nThreads
        },
        opts.signal
      )
    } catch (e) {
      const code = (e as { workerCode?: string }).workerCode
      if (code === 'model') {
        this.#loadedModel = null
        throw new SttError(
          'config',
          `modelo local inválido ou corrompido (${modelPath}) — baixe novamente em Configurações → Áudio (${errText(e)})`,
          { backend: 'local', cause: e }
        )
      }
      if (code === 'runtime')
        throw new SttError(
          'config',
          `motor local de transcrição não está pronto — o motor whisper.cpp não pôde ser carregado nesta instalação (${errText(e)})`,
          { backend: 'local', cause: e }
        )
      if (code === 'internal')
        throw new SttError('config', `falha no motor local de transcrição: ${errText(e)}`, {
          backend: 'local',
          cause: e
        })
      throw e
    }
  }

  /** Solta o modelo `modelPath` (ou qualquer um, sem argumento): encerra o processo se carregado. */
  unload(modelPath?: string): void {
    if (!this.#ch) return
    if (modelPath && this.#loadedModel && this.#loadedModel !== modelPath) return
    if (this.#pending.size) {
      // em uso: só pede para soltar o cache (o processo segue)
      void this.request({ type: 'unload' }).catch(() => undefined)
      this.#loadedModel = null
      return
    }
    this.terminate()
  }

  /** Encerra o processo (pendentes → `AbortError`). O próximo pedido inicia outro. */
  terminate(): void {
    this.#clearIdle()
    const ch = this.#ch
    this.#gen++
    this.#ch = null
    this.#loadedModel = null
    this.#rejectAll(abortError())
    if (ch) {
      try {
        ch.kill()
      } catch {
        /* já morto */
      }
    }
  }
}

// ---------------- instância compartilhada (o app tem um processo de STT) ----------------

let shared: SttWorkerHost | null = null

/** O host compartilhado do processo (criado na primeira chamada). */
export function sharedSttWorkerHost(): SttWorkerHost {
  return (shared ??= new SttWorkerHost())
}

/** Encerra o processo compartilhado (saída do app). */
export function shutdownSttWorker(): void {
  shared?.terminate()
}

/** Troca o host compartilhado (testes). */
export function setSharedSttWorkerHost(host: SttWorkerHost | null): void {
  shared?.terminate()
  shared = host
}
