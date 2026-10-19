// Cliente WebSocket do sync (docs/SYNC_PROTOCOL.md §10): hello/welcome, requisições com `id` →
// `ack`/`error`, ping/pong, reconexão com backoff exponencial + jitter total, códigos de fechamento.
// Usa o WebSocket global (Node ≥ 22 / Electron). Sem Electron.

export class WsRequestError extends Error {
  readonly code: string
  readonly details: Record<string, unknown>
  constructor(message: string, code: string, details: Record<string, unknown> = {}) {
    super(message)
    this.code = code
    this.details = details
  }
}

export type WsState = 'idle' | 'connecting' | 'online' | 'offline' | 'stopped'

export interface RealtimeOptions {
  url: () => string
  /** Campos do hello (token fresco, cursor, janelas ativas, inscrições). */
  hello: () => Promise<Record<string, unknown>>
  onWelcome: (w: Record<string, unknown>) => void
  onEvent: (frame: Record<string, unknown>) => void
  onState: (s: WsState, info?: { code?: number; reason?: string }) => void
  /** 4401: renovar o token (true = reconectar já). */
  onUnauthorized: () => Promise<boolean>
  /** 4403 (revogado/conta), 4001 (protocolo), 4409 (outra instância): parar. */
  onFatal: (code: number, reason: string) => void
  /** Constantes (testes encurtam). */
  timing?: Partial<typeof DEFAULT_TIMING>
}

export const DEFAULT_TIMING = {
  pingMs: 15_000,
  pongTimeoutMs: 10_000,
  backoffBaseMs: 1_000,
  backoffMaxMs: 30_000,
  stableMs: 60_000,
  requestTimeoutMs: 30_000
}

interface Pending {
  resolve: (v: Record<string, unknown>) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const FATAL = new Set([4001, 4403, 4409])

export class RealtimeClient {
  private ws: WebSocket | null = null
  private state: WsState = 'idle'
  private seq = 0
  private pending = new Map<string, Pending>()
  private attempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private pongTimer: ReturnType<typeof setTimeout> | null = null
  private stableTimer: ReturnType<typeof setTimeout> | null = null
  private stopped = true
  private t: typeof DEFAULT_TIMING

  private opts: RealtimeOptions

  constructor(opts: RealtimeOptions) {
    this.opts = opts
    this.t = { ...DEFAULT_TIMING, ...(opts.timing ?? {}) }
  }

  get online(): boolean {
    return this.state === 'online'
  }

  getState(): WsState {
    return this.state
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.attempt = 0
    this.connect()
  }

  stop(): void {
    this.stopped = true
    this.clearTimers()
    const ws = this.ws
    this.ws = null
    if (ws) {
      try {
        ws.close(1000, 'bye')
      } catch {
        /* */
      }
    }
    this.failPending('Conexão encerrada.')
    this.setState('stopped')
  }

  /** Reconecta agora (ex.: depois de um refresh do token ou "Sincronizar agora"). */
  reconnectNow(): void {
    if (this.stopped) return
    if (this.state === 'online' || this.state === 'connecting') return
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.connect()
  }

  /** Derruba a conexão atual e reconecta (sem backoff). */
  restart(): void {
    if (this.stopped) return
    const ws = this.ws
    this.ws = null
    this.clearTimers()
    if (ws) {
      try {
        ws.close(4000, 'restart')
      } catch {
        /* */
      }
    }
    this.failPending('Conexão reiniciada.')
    this.connect()
  }

  private setState(s: WsState, info?: { code?: number; reason?: string }): void {
    if (this.state === s && !info) return
    this.state = s
    this.opts.onState(s, info)
  }

  private clearTimers(): void {
    for (const t of [this.reconnectTimer, this.pongTimer, this.stableTimer]) if (t) clearTimeout(t)
    if (this.pingTimer) clearInterval(this.pingTimer)
    this.reconnectTimer = this.pongTimer = this.stableTimer = null
    this.pingTimer = null
  }

  private failPending(msg: string): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(new WsRequestError(msg, 'disconnected'))
    }
    this.pending.clear()
  }

  private connect(): void {
    if (this.stopped) return
    this.setState('connecting')
    let ws: WebSocket
    try {
      ws = new WebSocket(this.opts.url())
    } catch (e) {
      console.warn('[clearchat:sync] ws', (e as Error).message)
      this.scheduleReconnect()
      return
    }
    this.ws = ws
    let welcomed = false
    ws.onopen = () => {
      void (async () => {
        try {
          const hello = await this.opts.hello()
          if (this.ws !== ws) return
          const w = await this.request('hello', { protocol: 1, ...hello }, 15_000)
          if (this.ws !== ws) return
          welcomed = true
          this.setState('online')
          this.startPing(ws)
          this.stableTimer = setTimeout(() => (this.attempt = 0), this.t.stableMs)
          this.opts.onWelcome(w)
        } catch (e) {
          if (this.ws !== ws) return
          console.warn('[clearchat:sync] hello falhou:', (e as Error).message)
          try {
            ws.close(4000, 'hello failed')
          } catch {
            /* */
          }
        }
      })()
    }
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return
      let f: Record<string, unknown>
      try {
        f = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data))
      } catch {
        return
      }
      this.onFrame(f)
    }
    ws.onclose = (ev) => {
      if (this.ws !== ws) return
      this.ws = null
      this.clearTimers()
      this.failPending('Conexão perdida.')
      const code = ev.code
      const reason = ev.reason ?? ''
      if (FATAL.has(code)) {
        this.stopped = true
        this.setState('stopped', { code, reason })
        this.opts.onFatal(code, reason)
        return
      }
      this.setState('offline', { code, reason })
      if (code === 4401) {
        void this.opts.onUnauthorized().then((ok) => {
          if (ok) this.connect()
          else this.scheduleReconnect()
        })
        return
      }
      if (welcomed) this.attempt = Math.min(this.attempt, 1)
      this.scheduleReconnect()
    }
    ws.onerror = () => {
      /* onclose segue */
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return
    const cap = Math.min(this.t.backoffMaxMs, this.t.backoffBaseMs * 2 ** this.attempt)
    const delay = Math.random() * cap
    this.attempt = Math.min(this.attempt + 1, 16)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
  }

  private startPing(ws: WebSocket): void {
    this.pingTimer = setInterval(() => {
      if (this.ws !== ws) return
      this.sendRaw({ t: 'ping', ts: Date.now() })
      if (this.pongTimer) return
      this.pongTimer = setTimeout(() => {
        // sem pong: reconecta
        if (this.ws !== ws) return
        console.warn('[clearchat:sync] sem pong — reconectando')
        try {
          ws.close(4000, 'pong timeout')
        } catch {
          /* */
        }
      }, this.t.pongTimeoutMs)
    }, this.t.pingMs)
  }

  private onFrame(f: Record<string, unknown>): void {
    const t = f.t as string
    if (t === 'pong') {
      if (this.pongTimer) clearTimeout(this.pongTimer)
      this.pongTimer = null
      return
    }
    const re = f.re as string | undefined
    if (re && (t === 'ack' || t === 'error' || t === 'welcome')) {
      const p = this.pending.get(re)
      if (p) {
        this.pending.delete(re)
        clearTimeout(p.timer)
        if (t === 'error')
          p.reject(
            new WsRequestError(
              String(f.message ?? f.code ?? 'erro'),
              String(f.code ?? 'error'),
              (f.details ?? {}) as Record<string, unknown>
            )
          )
        else p.resolve(f)
      }
      return
    }
    this.opts.onEvent(f)
  }

  private sendRaw(f: Record<string, unknown>): boolean {
    const ws = this.ws
    if (!ws || ws.readyState !== 1) return false
    try {
      ws.send(JSON.stringify(f))
      return true
    } catch {
      return false
    }
  }

  /** Frame sem resposta (ex.: stream.event). */
  send(t: string, fields: Record<string, unknown>): boolean {
    if (this.state !== 'online') return false
    return this.sendRaw({ t, ...fields })
  }

  /** Requisição com `id` → ack (campos) ou erro WsRequestError. */
  request(
    t: string,
    fields: Record<string, unknown> = {},
    timeoutMs = this.t.requestTimeoutMs
  ): Promise<Record<string, unknown>> {
    if (t !== 'hello' && this.state !== 'online')
      return Promise.reject(new WsRequestError('Sem conexão com o servidor.', 'disconnected'))
    const id = String(++this.seq)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new WsRequestError('O servidor não respondeu a tempo.', 'timeout'))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      if (!this.sendRaw({ t, id, ...fields })) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new WsRequestError('Sem conexão com o servidor.', 'disconnected'))
      }
    })
  }
}
