// Host do processo do motor local de TTS (`ttsWorker.ts` — Kokoro/onnxruntime-node) no main: inicia
// o processo sob demanda (lazy), fala o protocolo de `ttsWorkerProtocol.ts`, traduz as falhas em
// `TtsError` legível e sobrevive a crash (o processo morto rejeita os pendentes; o próximo pedido o
// recria). Sem import estático do Electron: no app usa `utilityProcess`, em Node puro (testes/
// scripts) `child_process.fork`. O spawner é injetável. Espelho de `sttWorkerHost.ts`.
// Ver SPEC → "Áudio → Serviço de TTS → Processo do motor local".
import { fork } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { abortError } from '../tools/util'
import { TtsError } from './tts'
import type {
  TtsWorkerProbeResult,
  TtsWorkerRequest,
  TtsWorkerResponse,
  TtsWorkerSynthResult
} from './ttsWorkerProtocol'

/** Canal mínimo com o processo do worker (utilityProcess ou child_process). */
export interface TtsWorkerChannel {
  post(msg: TtsWorkerRequest): void
  onMessage(cb: (msg: TtsWorkerResponse) => void): void
  /** Saída do processo (código; null = morto por sinal) — inclui crash nativo. */
  onExit(cb: (code: number | null) => void): void
  kill(): void
  /** Segura (true) ou solta (false) o processo pai vivo por causa deste filho (ocioso = solto). */
  hold?(active: boolean): void
  /** Como o processo foi iniciado (diagnóstico nos logs). */
  kind?: string
}

/** Cria (inicia) o processo do worker. */
export type TtsWorkerSpawner = () => TtsWorkerChannel

type Distribute<T> = T extends unknown ? Omit<T, 'id'> : never
/** Pedido sem o `id` (o host numera). */
export type TtsWorkerCommand = Distribute<TtsWorkerRequest>

/** Desliga o processo ocioso depois deste tempo (libera a RAM da sessão ONNX, ~0,3–1 GB). */
export const TTS_WORKER_IDLE_MS = 10 * 60_000

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

// ---------------- spawners padrão ----------------

/** Caminho do entry do worker no build (`out/main/ttsWorker.js`, ao lado do `index.js`). */
function builtWorkerEntry(): string | null {
  return typeof __dirname === 'string' ? join(__dirname, 'ttsWorker.js') : null
}

/** Entry em TS + hooks de resolução (Node puro, a partir da raiz do repositório — testes/scripts). */
function sourceWorkerEntry(): { entry: string; hooks: string } | null {
  const entry = join(process.cwd(), 'src/main/voice/ttsWorker.ts')
  const hooks = join(process.cwd(), 'e2e/ts-hooks.mjs')
  return existsSync(entry) && existsSync(hooks) ? { entry, hooks } : null
}

/** `child_process.fork` com serialização estruturada (Uint8Array passa intacto). */
export function ttsForkSpawner(entry: string, execArgv: string[] = []): TtsWorkerSpawner {
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
      onMessage: (cb) => child.on('message', (m) => cb(m as TtsWorkerResponse)),
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
function utilitySpawner(entry: string): TtsWorkerSpawner | null {
  try {
    const base = typeof __filename === 'string' ? __filename : join(process.cwd(), 'tts-host.js')
    const electron = createRequire(base)('electron') as
      | { utilityProcess?: { fork(p: string, a?: string[], o?: object): UtilityProcessLike } }
      | string
    const up = typeof electron === 'object' ? electron.utilityProcess : undefined
    if (!up) return null
    return () => {
      const child = up.fork(entry, [], { serviceName: 'ClearChat TTS', stdio: 'inherit' })
      let exited = false
      return {
        kind: 'utilityProcess',
        post: (msg) => {
          if (!exited) child.postMessage(msg)
        },
        onMessage: (cb) => child.on('message', (m) => cb(m as TtsWorkerResponse)),
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
export function defaultTtsWorkerSpawner(): TtsWorkerSpawner {
  const built = builtWorkerEntry()
  if (process.versions.electron && process.type === 'browser' && built) {
    const sp = utilitySpawner(built)
    if (sp) return sp
  }
  if (built && existsSync(built)) return ttsForkSpawner(built)
  const src = sourceWorkerEntry()
  if (src) return ttsForkSpawner(src.entry, ['--import', src.hooks])
  return () => {
    throw new Error('entry do processo do motor local de fala não encontrado nesta instalação')
  }
}

// ---------------- host ----------------

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: unknown) => void
  /** Pedido abandonado pelo chamador (abort): a resposta é descartada quando chegar. */
  abandoned: boolean
}

export interface TtsWorkerHostOptions {
  spawn?: TtsWorkerSpawner
  /** Ociosidade até desligar o processo (padrão `TTS_WORKER_IDLE_MS`; 0 = nunca). */
  idleMs?: number
}

/** Tradução de um erro do worker (código → `TtsError` `config` legível). */
function workerError(e: unknown): unknown {
  const code = (e as { workerCode?: string }).workerCode
  if (!code) return e
  const msg = errText(e)
  switch (code) {
    case 'aborted':
      return abortError()
    case 'runtime':
      return new TtsError(
        'config',
        `motor local de fala não está pronto — o runtime ONNX (onnxruntime-node) não pôde ser carregado nesta instalação (${msg})`,
        { backend: 'local', cause: e }
      )
    case 'model':
      return new TtsError(
        'config',
        `modelo do Kokoro inválido ou corrompido — baixe novamente em Configurações → Áudio (${msg})`,
        { backend: 'local', cause: e }
      )
    case 'espeak-missing':
    case 'espeak':
    case 'input':
      return new TtsError('config', msg, { backend: 'local', cause: e })
    default:
      return new TtsError('config', `falha no motor local de fala: ${msg}`, {
        backend: 'local',
        cause: e
      })
  }
}

/**
 * Processo do motor local de fala com fila de pedidos: `probe`, `synthesize` (sessão ONNX em cache
 * dentro do worker — no máximo uma), `unload`, `terminate`. Abort do chamador rejeita na hora com
 * `AbortError` e avisa o worker (`cancel` — pula se ainda não começou; a inferência em curso não é
 * interrompível e a resposta é descartada). Crash do processo → `TtsError` `config` legível nos
 * pendentes e o próximo pedido inicia um processo novo. Ocioso por `idleMs` → processo encerrado.
 */
export class TtsWorkerHost {
  readonly #spawn: TtsWorkerSpawner
  readonly #idleMs: number
  readonly #log: boolean
  #ch: TtsWorkerChannel | null = null
  #gen = 0
  #seq = 0
  #pending = new Map<number, Pending>()
  #idleTimer: ReturnType<typeof setTimeout> | null = null
  /** Quantos processos já foram iniciados (diagnóstico/testes). */
  spawnCount = 0

  constructor(opts: TtsWorkerHostOptions = {}) {
    this.#spawn = opts.spawn ?? defaultTtsWorkerSpawner()
    this.#idleMs = opts.idleMs ?? TTS_WORKER_IDLE_MS
    this.#log = !opts.spawn // só o host padrão (o do app) registra nos logs
  }

  get running(): boolean {
    return this.#ch !== null
  }

  /** Pedidos aguardando resposta (diagnóstico/testes). */
  get pendingCount(): number {
    return this.#pending.size
  }

  #ensure(): TtsWorkerChannel {
    if (this.#ch) return this.#ch
    const gen = ++this.#gen
    let ch: TtsWorkerChannel
    try {
      ch = this.#spawn()
    } catch (e) {
      throw new TtsError(
        'config',
        `motor local de fala não está pronto — o processo do motor não pôde ser iniciado (${errText(e)})`,
        { backend: 'local', cause: e }
      )
    }
    this.spawnCount++
    this.#ch = ch
    ch.hold?.(false)
    if (this.#log)
      console.log(`[clearchat] TTS local: processo do motor iniciado (${ch.kind ?? '?'})`)
    ch.onMessage((msg) => {
      if (gen !== this.#gen) return
      this.#onMessage(msg)
    })
    ch.onExit((code) => {
      if (gen !== this.#gen) return // processo antigo (terminado de propósito) — já tratado
      this.#gen++
      this.#ch = null
      this.#clearIdle()
      this.#rejectAll(
        new TtsError(
          'config',
          `o motor local de fala parou inesperadamente (${code === null ? 'sinal' : `código ${code}`}) — tente de novo; se repetir, baixe o modelo do Kokoro novamente em Configurações → Áudio ou use o backend de API`,
          { backend: 'local' }
        )
      )
    })
    return ch
  }

  #onMessage(msg: TtsWorkerResponse): void {
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

  /** Envia um pedido e espera a resposta (abort → `AbortError` imediato + `cancel` ao worker). */
  request<T>(cmd: TtsWorkerCommand, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(abortError())
    let ch: TtsWorkerChannel
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
        // pula a síntese se ela ainda está na fila do worker (a resposta, se vier, é descartada)
        try {
          if (this.#ch === ch) ch.post({ id: ++this.#seq, type: 'cancel', target: id })
        } catch {
          /* processo saindo */
        }
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.#pending.set(id, entry)
      ch.hold?.(true)
      try {
        ch.post({ ...cmd, id } as TtsWorkerRequest)
      } catch (e) {
        this.#pending.delete(id)
        entry.reject(e)
      }
    })
  }

  /** O onnxruntime-node carrega no processo do motor? (nunca lança — falha = `available: false`). */
  async probe(): Promise<TtsWorkerProbeResult> {
    try {
      return await this.request<TtsWorkerProbeResult>({ type: 'probe' })
    } catch (e) {
      return { available: false, reason: errText(e) }
    }
  }

  /** Sintetiza no processo do motor (erros → `TtsError` `config` legível; abort → `AbortError`). */
  async synthesize(
    input: { modelPath: string; voicePath: string; text: string },
    signal?: AbortSignal
  ): Promise<TtsWorkerSynthResult> {
    try {
      return await this.request<TtsWorkerSynthResult>({ type: 'synthesize', ...input }, signal)
    } catch (e) {
      throw workerError(e)
    }
  }

  /** Solta a sessão ONNX: encerra o processo ocioso; em uso, só pede ao worker para soltar o cache. */
  unload(): void {
    if (!this.#ch) return
    if (this.#pending.size) {
      void this.request({ type: 'unload' }).catch(() => undefined)
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

// ---------------- instância compartilhada (o app tem um processo de TTS) ----------------

let shared: TtsWorkerHost | null = null

/** O host compartilhado do processo (criado na primeira chamada). */
export function sharedTtsWorkerHost(): TtsWorkerHost {
  return (shared ??= new TtsWorkerHost())
}

/** Encerra o processo compartilhado (saída do app). */
export function shutdownTtsWorker(): void {
  shared?.terminate()
}

/** Troca o host compartilhado (testes). */
export function setSharedTtsWorkerHost(host: TtsWorkerHost | null): void {
  shared?.terminate()
  shared = host
}
