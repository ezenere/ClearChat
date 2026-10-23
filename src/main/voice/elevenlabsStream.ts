// ElevenLabs direto — WebSocket de entrada em streaming para a chamada de voz (main, sem Electron —
// testável com o servidor fake de `e2e/fakes/elevenlabsFake.mjs`).
//
// Protocolo (conferido na documentação oficial em 2026-10-23 — ver SPEC → "ElevenLabs direto"):
// `wss://api.elevenlabs.io/v1/text-to-speech/{voice_id}/multi-stream-input?model_id=…
// &output_format=pcm_24000&inactivity_timeout=…[&language_code=pt][&auto_mode=true]`, chave no
// header `xi-api-key` (e também em `xi_api_key` no 1º frame — campo documentado). Um socket por
// chamada, UM CONTEXTO POR SENTENÇA (multi-context): o contexto abre com
// `{ text: ' ', context_id, generation_config: { chunk_length_schedule } [, voice_settings] }`,
// recebe o texto em pedaços (`{ text, context_id }` — palavras inteiras, sempre terminando em
// espaço), fecha com `{ text: resto, context_id, flush: true }` + `{ context_id, close_context: true }`
// e o servidor devolve `{ audio: base64 PCM16 24 kHz, contextId, alignment? }` … `{ isFinal: true,
// contextId }`. Barge-in: `close_context` nos contextos que ainda não geraram e, se algum já estava
// gerando, o socket é derrubado (o `close_context` deixa o flush terminar — derrubar para tudo na
// hora); a próxima fala reconecta. O servidor fecha o socket ocioso depois de `inactivity_timeout`
// (pedimos 180 s, o máximo) — reconexão preguiçosa na próxima fala, e contexto que perdeu o socket
// antes de receber áudio é reenviado UMA vez num socket novo.
//
// `ElevenLabsCallTts` é o encaixe com a chamada (`TtsTextFeed`): `begin()` (turno novo — pré-abre o
// socket), `partial(texto)` (a sentença ainda incompleta cresce — vai ao contexto atual palavra a
// palavra, antes de a sentença fechar), `cut(sentença)` (o cortador fechou a sentença → flush do
// contexto já começa a gerar), `reset()` (barge-in/parar) e `synth(sentença, signal)` (o `synth` da
// chamada via `TtsStreamRelay` — pega o contexto daquela sentença e devolve o stream PCM).
import { abortError } from '../tools/util'
import { TtsError, type TtsPcmStream } from './tts'
import type { TtsSettings } from '@shared/voice'
import {
  ELEVENLABS_OUTPUT_FORMAT,
  ELEVENLABS_SAMPLE_RATE,
  elevenLabsConfig,
  elevenLabsError,
  elevenLabsErrorDetail,
  elevenLabsHeaders,
  elevenLabsWsSupportsModel,
  isElevenLabsEndpoint,
  type ElevenLabsConfig
} from './elevenlabs'
import { Pcm16MonoAligner } from './wav'

// ---------------- transporte (injetável) ----------------

/** O mínimo de um WebSocket (o global do Node/Electron serve; testes podem injetar outro). */
export interface WsLike {
  readonly readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  addEventListener(type: 'open', listener: () => void): void
  addEventListener(type: 'message', listener: (ev: { data: unknown }) => void): void
  addEventListener(type: 'close', listener: (ev: { code: number; reason: string }) => void): void
  addEventListener(type: 'error', listener: (ev: unknown) => void): void
}

/** Abre um WebSocket com headers (o global do Node aceita `{ headers }` no 2º argumento). */
export type WsFactory = (url: string, init: { headers: Record<string, string> }) => WsLike

const WS_OPEN = 1

const defaultWsFactory: WsFactory = (url, init) => {
  const Ctor = (globalThis as { WebSocket?: new (url: string, init: unknown) => WsLike }).WebSocket
  if (!Ctor)
    throw new TtsError('config', 'WebSocket indisponível neste runtime', { backend: 'api' })
  return new Ctor(url, init)
}

// ---------------- configuração ----------------

/**
 * `chunk_length_schedule` (chars acumulados antes de cada geração; 50–500). O padrão da
 * ElevenLabs é [120, 160, 250, 290]; aqui o 1º trecho sai com 50 chars (a frase longa começa a
 * falar antes de fechar) — cada sentença ainda termina com `flush`, então frase curta não espera.
 */
export const ELEVENLABS_CHUNK_SCHEDULE: readonly number[] = [50, 120, 160, 290]

/** Ociosidade antes de o servidor fechar o socket (máximo documentado: 180 s). */
export const ELEVENLABS_WS_INACTIVITY_S = 180

/** Tempo para o socket abrir. */
export const ELEVENLABS_WS_CONNECT_TIMEOUT_MS = 10_000

/** Sem áudio (nem `isFinal`) por este tempo depois do flush → `TtsError` 'timeout'. */
export const ELEVENLABS_WS_AUDIO_TIMEOUT_MS = 20_000

/** Contextos gerando ao mesmo tempo no socket (os demais esperam a vez — limite de concorrência). */
export const ELEVENLABS_WS_MAX_ACTIVE = 2

export interface ElevenLabsSocketOptions extends ElevenLabsConfig {
  chunkLengthSchedule?: readonly number[]
  /** `voice_settings` do 1º frame de cada contexto; null/ausente = as da voz salva na conta. */
  voiceSettings?: Record<string, unknown> | null
  /** `auto_mode=true` (a ElevenLabs gera ao receber frases completas, sem o schedule). */
  autoMode?: boolean
  inactivityTimeoutS?: number
  connectTimeoutMs?: number
  audioTimeoutMs?: number
  maxActive?: number
  wsFactory?: WsFactory
  /** Diagnóstico de falha antes de abrir (REST); padrão `diagnoseElevenLabs`. */
  diagnose?: (cfg: ElevenLabsConfig) => Promise<TtsError | null>
  now?: () => number
}

/** URL do WebSocket multi-contexto (http→ws, https→wss; a chave NUNCA vai na URL). */
export function elevenLabsWsUrl(
  cfg: Pick<ElevenLabsSocketOptions, 'baseUrl' | 'voiceId' | 'modelId' | 'languageCode'> & {
    autoMode?: boolean
    inactivityTimeoutS?: number
  }
): string {
  const u = new URL(cfg.baseUrl)
  u.protocol = u.protocol === 'http:' ? 'ws:' : 'wss:'
  u.pathname = `${u.pathname.replace(/\/+$/, '')}/v1/text-to-speech/${encodeURIComponent(cfg.voiceId)}/multi-stream-input`
  const q = new URLSearchParams()
  q.set('model_id', cfg.modelId)
  q.set('output_format', ELEVENLABS_OUTPUT_FORMAT)
  q.set('inactivity_timeout', String(cfg.inactivityTimeoutS ?? ELEVENLABS_WS_INACTIVITY_S))
  if (cfg.languageCode) q.set('language_code', cfg.languageCode)
  if (cfg.autoMode) q.set('auto_mode', 'true')
  u.search = q.toString()
  return u.toString()
}

/**
 * Falha antes do socket abrir (o handshake não expõe o status HTTP): `GET /v1/voices/{voice_id}`
 * diz se é a chave (401/403), a voz (404/400) ou cota (429/402). Rede/2xx → null (erro genérico).
 */
export async function diagnoseElevenLabs(cfg: ElevenLabsConfig): Promise<TtsError | null> {
  try {
    const res = await fetch(`${cfg.baseUrl}/v1/voices/${encodeURIComponent(cfg.voiceId)}`, {
      headers: elevenLabsHeaders(cfg.apiKey),
      signal: AbortSignal.timeout(8_000)
    })
    if (res.ok) {
      await res.arrayBuffer().catch(() => undefined)
      return null
    }
    const d = elevenLabsErrorDetail(await res.text().catch(() => ''))
    if (res.status === 404 || res.status === 400) {
      const e = elevenLabsError(
        { status: res.status, message: d.message || 'voice_not_found', code: d.status },
        'voz'
      )
      return e.kind === 'http'
        ? elevenLabsError({ message: `voice_not_found ${d.message}`.trim() }, 'voz')
        : e
    }
    return elevenLabsError({ status: res.status, message: d.message, code: d.status }, 'voz')
  } catch {
    return null
  }
}

/** Identidade da configuração (trocar voz/modelo/chave = socket novo). */
const configKey = (o: ElevenLabsSocketOptions): string =>
  JSON.stringify([
    o.baseUrl,
    o.apiKey,
    o.voiceId,
    o.modelId,
    o.languageCode,
    o.chunkLengthSchedule ?? null,
    o.voiceSettings ?? null,
    !!o.autoMode,
    o.inactivityTimeoutS ?? null
  ])

// ---------------- contexto (uma sentença) ----------------

type Waiter = () => void

/** Uma sentença no socket multi-contexto (texto entrando, PCM saindo). */
export class ElevenLabsContext {
  readonly id: string
  readonly #sock: ElevenLabsSocket
  /** Texto já entregue ao socket (para o reenvio depois de uma queda). */
  text = ''
  /** Recebeu `flush` (o servidor está gerando o resto). */
  flushed = false
  /** Recebeu o `isFinal` (todo o áudio chegou). */
  final = false
  aborted = false
  error: unknown = null
  /** Já está aberto no socket (fora da fila de concorrência). */
  started = false
  /** Reenvios depois de quedas (máx. 1). */
  retries = 0
  /** Momento do 1º texto entregue (latência 1º texto → 1º áudio). */
  firstTextAt: number | null = null
  flushAt: number | null = null
  firstAudioAt: number | null = null
  audioBytes = 0
  /** Frames esperando o contexto começar (fila de concorrência / socket conectando). */
  pendingFrames: Record<string, unknown>[] = []
  readonly #queue: Uint8Array[] = []
  #wake: Waiter | null = null
  readonly #aligner = new Pcm16MonoAligner(1)
  #timer: ReturnType<typeof setTimeout> | null = null
  /** Chamado no 1º áudio (instrumentação). */
  onFirstAudio: ((ctx: ElevenLabsContext) => void) | null = null

  constructor(id: string, sock: ElevenLabsSocket) {
    this.id = id
    this.#sock = sock
  }

  get done(): boolean {
    return this.final || this.aborted || this.error != null
  }

  /** Acrescenta texto (sem flush). Vazio/só espaços → nada. */
  send(text: string): void {
    if (this.done || this.flushed || !text) return
    this.text += text
    this.firstTextAt ??= this.#sock.now()
    this.#sock.frame(this, { text, context_id: this.id })
  }

  /** Último pedaço + `flush` (gera já) + `close_context` (o servidor manda o `isFinal`). */
  finish(tail = ''): void {
    if (this.done || this.flushed) return
    const t = tail && !/\s$/.test(tail) ? `${tail} ` : tail
    if (!this.text.trim() && !t.trim()) {
      // nada para falar: termina vazio (o stream acaba sem áudio → erro legível no consumidor)
      this.#fail(
        new TtsError('config', 'texto para a síntese de fala está vazio', { backend: 'api' })
      )
      return
    }
    this.text += t
    this.flushed = true
    this.firstTextAt ??= this.#sock.now()
    this.flushAt = this.#sock.now()
    this.#sock.frame(this, { text: t || ' ', context_id: this.id, flush: true })
    this.#sock.frame(this, { context_id: this.id, close_context: true })
    this.#arm()
  }

  /** Descarta o contexto (barge-in/sentença abandonada): áudio pendente cai fora. */
  abort(): void {
    if (this.done) return
    this.aborted = true
    this.#clearTimer()
    this.#queue.length = 0
    this.#sock.release(this, true)
    this.#notify()
  }

  /** Stream PCM16 mono 24 kHz do contexto (consumidor único). */
  stream(signal?: AbortSignal, model = ''): TtsPcmStream {
    const onAbort = (): void => this.abort()
    if (signal) {
      if (signal.aborted) this.abort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this
    async function* chunks(): AsyncGenerator<Uint8Array> {
      try {
        for (;;) {
          const next = self.#queue.shift()
          if (next) {
            yield next
            continue
          }
          if (self.aborted) throw abortError()
          if (self.error) throw self.error
          if (self.final) {
            if (!self.audioBytes)
              throw new TtsError('http', 'a ElevenLabs terminou a sentença sem áudio', {
                backend: 'api'
              })
            return
          }
          await new Promise<void>((r) => (self.#wake = r))
        }
      } finally {
        signal?.removeEventListener('abort', onAbort)
        if (!self.final) self.abort() // consumidor parou no meio
      }
    }
    return {
      streaming: true,
      sampleRate: ELEVENLABS_SAMPLE_RATE,
      model,
      backend: 'api',
      t0: this.firstTextAt ?? this.#sock.now(),
      chunks: chunks()
    }
  }

  // ---- entrada do socket ----

  /** @internal áudio base64 do servidor. */
  pushAudio(b64: string): void {
    if (this.done) return
    const bytes = Buffer.from(b64, 'base64')
    const pcm = this.#aligner.push(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length))
    if (!pcm.length) return
    if (this.firstAudioAt == null) {
      this.firstAudioAt = this.#sock.now()
      try {
        this.onFirstAudio?.(this)
      } catch {
        /* instrumentação nunca derruba o áudio */
      }
    }
    this.audioBytes += pcm.length
    this.#queue.push(pcm)
    if (this.flushed) this.#arm()
    this.#notify()
  }

  /** @internal `isFinal` do servidor. */
  markFinal(): void {
    if (this.done) return
    this.final = true
    this.#clearTimer()
    this.#sock.release(this, false)
    this.#notify()
  }

  /** @internal falha (erro do servidor, queda, tempo). */
  fail(e: unknown): void {
    this.#fail(e)
  }

  #fail(e: unknown): void {
    if (this.done) return
    this.error = e
    this.#clearTimer()
    this.#sock.release(this, false)
    this.#notify()
  }

  /** (Re)arma o tempo máximo sem áudio depois do flush. */
  #arm(): void {
    this.#clearTimer()
    const ms = this.#sock.audioTimeoutMs
    this.#timer = setTimeout(() => {
      this.#timer = null
      this.#fail(
        new TtsError('timeout', `sem áudio da ElevenLabs há ${Math.round(ms / 1000)} s`, {
          backend: 'api'
        })
      )
    }, ms)
    this.#timer.unref?.()
  }

  #clearTimer(): void {
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = null
  }

  #notify(): void {
    const w = this.#wake
    this.#wake = null
    w?.()
  }
}

// ---------------- socket multi-contexto ----------------

/** Um WebSocket `multi-stream-input` (conexão preguiçosa, reconexão, fila de concorrência). */
export class ElevenLabsSocket {
  readonly key: string
  readonly #o: ElevenLabsSocketOptions
  #ws: WsLike | null = null
  #state: 'idle' | 'connecting' | 'open' | 'closed' = 'idle'
  #everOpened = false
  #sentAuth = false
  #seq = 0
  #connectTimer: ReturnType<typeof setTimeout> | null = null
  /** Erro de protocolo recebido antes do fechamento (vale mais que o motivo do close). */
  #lastError: TtsError | null = null
  readonly #live = new Map<string, ElevenLabsContext>()
  /** Contextos esperando vaga (limite de concorrência), na ordem. */
  readonly #waiting: ElevenLabsContext[] = []
  /** Abertas no socket atual (o 1º frame — init — já saiu). */
  #activeCount = 0
  /** Conexões abertas (diagnóstico/testes). */
  connects = 0

  constructor(opts: ElevenLabsSocketOptions) {
    this.#o = opts
    this.key = configKey(opts)
  }

  get audioTimeoutMs(): number {
    return this.#o.audioTimeoutMs ?? ELEVENLABS_WS_AUDIO_TIMEOUT_MS
  }

  get state(): 'idle' | 'connecting' | 'open' | 'closed' {
    return this.#state
  }

  /** Contextos vivos (diagnóstico/testes). */
  get liveCount(): number {
    return this.#live.size
  }

  now(): number {
    return this.#o.now ? this.#o.now() : Date.now()
  }

  /** Pré-abre a conexão (economiza o handshake no 1º texto). */
  warm(): void {
    if (this.#state === 'idle' || this.#state === 'closed') this.#connect()
  }

  /** Contexto novo (uma sentença). */
  context(): ElevenLabsContext {
    const ctx = new ElevenLabsContext(`c${++this.#seq}`, this)
    this.#live.set(ctx.id, ctx)
    this.#waiting.push(ctx)
    this.#pumpWaiting()
    return ctx
  }

  /** Algum contexto está gerando (flush enviado, sem `isFinal`)? */
  get generating(): boolean {
    for (const c of this.#live.values()) if (c.flushed && !c.done && c.started) return true
    return false
  }

  /** Fecha tudo (sem erro para os contextos: são abortados). */
  close(): void {
    for (const c of [...this.#live.values()]) c.abort()
    this.#teardown(1000, 'encerrado')
  }

  // ---- usado pelos contextos ----

  /** @internal envia (ou guarda até o contexto começar) um frame do contexto. */
  frame(ctx: ElevenLabsContext, msg: Record<string, unknown>): void {
    if (!ctx.started || this.#state !== 'open') {
      ctx.pendingFrames.push(msg)
      if (this.#state === 'idle' || this.#state === 'closed') this.#connect()
      return
    }
    this.#sendRaw(msg)
  }

  /** @internal o contexto acabou (final/erro) ou foi abortado (`closeRemote` = avisar o servidor). */
  release(ctx: ElevenLabsContext, closeRemote: boolean): void {
    if (!this.#live.delete(ctx.id)) return
    const w = this.#waiting.indexOf(ctx)
    if (w >= 0) this.#waiting.splice(w, 1)
    if (ctx.started) {
      this.#activeCount = Math.max(0, this.#activeCount - 1)
      if (closeRemote && this.#state === 'open' && !ctx.final) {
        // descartado: o servidor para de gerar o que não foi "flushado" (o flush em curso termina —
        // o áudio que ainda chegar deste id é ignorado)
        this.#sendRaw({ context_id: ctx.id, close_context: true })
      }
    }
    this.#pumpWaiting()
  }

  // ---- interno ----

  #maxActive(): number {
    return Math.max(1, this.#o.maxActive ?? ELEVENLABS_WS_MAX_ACTIVE)
  }

  /** Abre os contextos que esperam vaga (com o socket aberto). */
  #pumpWaiting(): void {
    if (this.#state !== 'open') {
      if (this.#waiting.length && (this.#state === 'idle' || this.#state === 'closed'))
        this.#connect()
      return
    }
    while (this.#waiting.length && this.#activeCount < this.#maxActive()) {
      const ctx = this.#waiting.shift()!
      if (ctx.done) continue
      this.#start(ctx)
    }
  }

  /** 1º frame do contexto (init) + os frames guardados. */
  #start(ctx: ElevenLabsContext): void {
    ctx.started = true
    this.#activeCount++
    const init: Record<string, unknown> = {
      text: ' ',
      context_id: ctx.id,
      generation_config: {
        chunk_length_schedule: [...(this.#o.chunkLengthSchedule ?? ELEVENLABS_CHUNK_SCHEDULE)]
      }
    }
    if (this.#o.voiceSettings) init.voice_settings = this.#o.voiceSettings
    if (!this.#sentAuth) {
      // campo documentado do 1º frame (o header `xi-api-key` já autentica; redundância para
      // runtimes/proxies que não repassam headers no upgrade)
      init.xi_api_key = this.#o.apiKey
      this.#sentAuth = true
    }
    this.#sendRaw(init)
    const frames = ctx.pendingFrames
    ctx.pendingFrames = []
    for (const f of frames) this.#sendRaw(f)
  }

  #sendRaw(msg: Record<string, unknown>): void {
    try {
      this.#ws?.send(JSON.stringify(msg))
    } catch {
      /* socket caindo: o 'close' trata os contextos */
    }
  }

  #connect(): void {
    if (this.#state === 'connecting' || this.#state === 'open') return
    this.#state = 'connecting'
    this.#sentAuth = false
    this.#everOpened = false
    this.#lastError = null
    this.#activeCount = 0
    let ws: WsLike
    try {
      const url = elevenLabsWsUrl({ ...this.#o })
      ws = (this.#o.wsFactory ?? defaultWsFactory)(url, {
        headers: { 'xi-api-key': this.#o.apiKey }
      })
    } catch (e) {
      this.#state = 'closed'
      this.#failAll(
        e instanceof TtsError
          ? e
          : new TtsError('config', `endereço da ElevenLabs inválido: ${(e as Error).message}`, {
              backend: 'api',
              cause: e
            })
      )
      return
    }
    this.#ws = ws
    this.connects++
    const timeoutMs = this.#o.connectTimeoutMs ?? ELEVENLABS_WS_CONNECT_TIMEOUT_MS
    this.#connectTimer = setTimeout(() => {
      this.#connectTimer = null
      if (this.#ws !== ws || this.#state !== 'connecting') return
      this.#lastError = new TtsError(
        'timeout',
        `tempo esgotado ao conectar na ElevenLabs (${timeoutMs / 1000} s)`,
        { backend: 'api' }
      )
      try {
        ws.close()
      } catch {
        /* já caindo */
      }
      this.#onClose(ws, 1006, '')
    }, timeoutMs)
    this.#connectTimer.unref?.()
    ws.addEventListener('open', () => {
      if (this.#ws !== ws) return
      this.#clearConnectTimer()
      this.#state = 'open'
      this.#everOpened = true
      // contextos que já estavam abertos num socket anterior (reenvio) voltam para a fila
      this.#pumpWaiting()
    })
    ws.addEventListener('message', (ev) => {
      if (this.#ws !== ws) return
      this.#onMessage(ev.data)
    })
    ws.addEventListener('close', (ev) => this.#onClose(ws, ev?.code ?? 1006, ev?.reason ?? ''))
    ws.addEventListener('error', () => {
      /* o 'close' vem logo depois com o código */
    })
  }

  #onMessage(data: unknown): void {
    let j: Record<string, unknown>
    try {
      const s = typeof data === 'string' ? data : Buffer.from(data as ArrayBuffer).toString('utf8')
      j = JSON.parse(s) as Record<string, unknown>
    } catch {
      return
    }
    if (!j || typeof j !== 'object') return
    const cid =
      typeof j.contextId === 'string'
        ? j.contextId
        : typeof j.context_id === 'string'
          ? j.context_id
          : null
    const ctx = cid ? this.#live.get(cid) : undefined
    const hasAudio = typeof j.audio === 'string' && j.audio.length > 0
    const isFinal = j.isFinal === true || j.is_final === true
    if (hasAudio) ctx?.pushAudio(j.audio as string)
    if (isFinal) {
      ctx?.markFinal()
      return
    }
    if (hasAudio) return
    // frame de erro: `{ message, error, code }` (ou `detail`)
    const errText =
      typeof j.error === 'string'
        ? j.error
        : typeof j.message === 'string'
          ? j.message
          : j.detail
            ? elevenLabsErrorDetail(JSON.stringify(j)).message
            : ''
    if (!errText) return
    const err = elevenLabsError(
      {
        message: typeof j.message === 'string' ? j.message : errText,
        code: typeof j.error === 'string' ? j.error : typeof j.code === 'string' ? j.code : ''
      },
      'WebSocket'
    )
    if (ctx && (err.kind === 'http' || err.kind === 'config')) {
      ctx.fail(err)
      return
    }
    // auth/cota/erro sem contexto: vale para o socket inteiro
    this.#lastError = err
    this.#failAll(err)
    this.#teardown(1000, 'erro')
  }

  #onClose(ws: WsLike, code: number, reason: string): void {
    if (this.#ws !== ws) return
    this.#clearConnectTimer()
    this.#ws = null
    const wasOpen = this.#everOpened
    this.#state = 'closed'
    this.#sentAuth = false
    this.#activeCount = 0
    const pending = [...this.#live.values()].filter((c) => !c.done)
    if (!pending.length) return // ocioso (inactivity_timeout) ou fechado por nós: reconecta depois
    const err = this.#lastError ?? this.#closeError(code, reason, wasOpen)
    const fatal = err.kind === 'auth' || err.kind === 'quota' || err.kind === 'config'
    // abertos no socket que caiu e ainda sem áudio → reenvio (1×); ainda na fila de concorrência →
    // ficam na fila para o socket novo; o resto (ou erro fatal / handshake falho) → erro
    const retry = pending.filter(
      (c) => !fatal && wasOpen && c.started && !c.firstAudioAt && c.retries < 1
    )
    const keep = pending.filter((c) => !fatal && wasOpen && !c.started)
    const fail = pending.filter((c) => !retry.includes(c) && !keep.includes(c))
    for (const c of fail) {
      const w = this.#waiting.indexOf(c)
      if (w >= 0) this.#waiting.splice(w, 1)
    }
    if (!wasOpen && !this.#lastError) {
      // falha no handshake: o diagnóstico REST diz se foi chave/voz/cota
      void this.#diagnoseAndFail(fail, err)
    } else {
      for (const c of fail) c.fail(err)
    }
    if (retry.length) {
      // caiu antes do áudio (ex.: fechou por ociosidade na hora em que a fala começou): reenvia
      // o texto inteiro num socket novo (`text` já inclui o que ainda estava na fila)
      for (const c of retry) {
        c.retries++
        c.started = false
        const frames: Record<string, unknown>[] = []
        if (c.text)
          frames.push({ text: c.text, context_id: c.id, ...(c.flushed ? { flush: true } : {}) })
        if (c.flushed) frames.push({ context_id: c.id, close_context: true })
        c.pendingFrames = frames
        this.#waiting.unshift(c)
      }
    }
    if (retry.length || keep.length) this.#connect()
  }

  async #diagnoseAndFail(ctxs: ElevenLabsContext[], fallback: TtsError): Promise<void> {
    let err: TtsError | null
    try {
      err = await (this.#o.diagnose ?? diagnoseElevenLabs)(this.#o)
    } catch {
      err = null
    }
    for (const c of ctxs) c.fail(err ?? fallback)
  }

  #closeError(code: number, reason: string, wasOpen: boolean): TtsError {
    const r = (reason ?? '').trim()
    if (!wasOpen)
      return new TtsError(
        'network',
        `não foi possível abrir o WebSocket da ElevenLabs${r ? ` — ${r}` : ` (código ${code})`}`,
        { backend: 'api' }
      )
    if (r && code !== 1000) return elevenLabsError({ message: r, code: String(code) }, 'WebSocket')
    return new TtsError(
      'network',
      `a ElevenLabs fechou o WebSocket antes do fim do áudio (código ${code}${r ? ` — ${r}` : ''})`,
      { backend: 'api' }
    )
  }

  #failAll(err: unknown): void {
    for (const c of [...this.#live.values()]) c.fail(err)
    this.#waiting.length = 0
  }

  #teardown(code: number, reason: string): void {
    this.#clearConnectTimer()
    const ws = this.#ws
    this.#ws = null
    this.#state = 'closed'
    this.#sentAuth = false
    this.#activeCount = 0
    if (ws) {
      try {
        if (ws.readyState === WS_OPEN) ws.send(JSON.stringify({ close_socket: true }))
        ws.close(code, reason)
      } catch {
        /* já fechado */
      }
    }
  }

  #clearConnectTimer(): void {
    if (this.#connectTimer) clearTimeout(this.#connectTimer)
    this.#connectTimer = null
  }
}

// ---------------- encaixe com a chamada ----------------

/**
 * Ganchos de texto da chamada para um TTS de entrada em streaming (ver `VoiceCallDeps.ttsFeed`).
 * Todos são best-effort (nunca lançam): sem eles o `synth(sentença)` sozinho também funciona.
 */
export interface TtsTextFeed {
  /** Turno novo (ou início da chamada): pré-abre a conexão; descarta a sentença parcial anterior. */
  begin(): void
  /** Texto da sentença ainda incompleta (cresce a cada delta do LLM). */
  partial(text: string): void
  /** O cortador fechou esta sentença (vai virar `synth(text)` em seguida, na ordem). */
  cut(sentence: string): void
  /** Barge-in/parar/turno retido: descarta tudo o que ainda não tocou. */
  reset(): void
  /** Fim da chamada: fecha a conexão. */
  close(): void
}

/** Latência de uma sentença/turno no WebSocket. */
export interface ElevenLabsLatency {
  /** Contexto (sentença) que recebeu o 1º áudio. */
  contextId: string
  /** 1º texto entregue → 1º áudio da sentença (ms). */
  firstTextToAudioMs: number
  /** Flush → 1º áudio (ms; null = o áudio chegou antes do flush). */
  flushToAudioMs: number | null
  /** 1º texto do TURNO → 1º áudio do turno (só na 1ª sentença do turno; senão null). */
  turnMs: number | null
  /** Chars entregues no contexto até o 1º áudio. */
  chars: number
}

export interface ElevenLabsCallOptions {
  /** Config atual (lida a cada uso — Configurações podem mudar); null = desligado. */
  config(): ElevenLabsSocketOptions | null
  /** Instrumentação (1º texto → 1º áudio). */
  onLatency?(l: ElevenLabsLatency): void
}

/** O que foi entregue ao contexto da sentença em construção. */
interface PartialSentence {
  ctx: ElevenLabsContext
  sent: string
}

/**
 * Encaixe da chamada com o WebSocket da ElevenLabs: a sentença ainda incompleta vai ao contexto
 * palavra a palavra (`partial`), o corte faz o flush (`cut`) e o `synth(sentença)` pega o contexto
 * daquela sentença (ou abre um na hora, com o texto inteiro, quando os ganchos não vieram — ex.:
 * frases retidas que voltam). Ordem/concorrência/descartes são da chamada + `TtsStreamRelay`.
 */
export class ElevenLabsCallTts implements TtsTextFeed {
  readonly #o: ElevenLabsCallOptions
  #sock: ElevenLabsSocket | null = null
  #cur: PartialSentence | null = null
  /** Sentenças cortadas (com flush feito) esperando o `synth`, na ordem. */
  #ready: { text: string; ctx: ElevenLabsContext }[] = []
  /** Texto entregue além do corte (corte forçado no meio do que já foi): pular no próximo. */
  #carry = ''
  #turnFirstTextAt: number | null = null
  #turnReported = false

  constructor(opts: ElevenLabsCallOptions) {
    this.#o = opts
  }

  /** Socket atual (diagnóstico/testes). */
  get socket(): ElevenLabsSocket | null {
    return this.#sock
  }

  begin(): void {
    const sock = this.#socket()
    if (!sock) return
    this.#dropCurrent()
    this.#carry = ''
    this.#turnFirstTextAt = null
    this.#turnReported = false
    sock.warm()
  }

  partial(text: string): void {
    const sock = this.#socket()
    if (!sock) return
    const r = this.#stripCarry(text.replace(/^\s+/, ''), false)
    if (r == null) return
    // só palavras inteiras (o pedaço sempre termina em espaço — recomendação da ElevenLabs)
    const m = /^[\s\S]*\s/.exec(r)
    const words = m ? m[0] : ''
    if (!words.trim()) return
    if (!this.#cur) this.#cur = { ctx: this.#newContext(sock), sent: '' }
    const cur = this.#cur
    if (words.length > cur.sent.length && words.startsWith(cur.sent)) {
      cur.ctx.send(words.slice(cur.sent.length))
      cur.sent = words
    }
  }

  cut(sentence: string): void {
    const sock = this.#socket()
    if (!sock) return
    const s = sentence.trim()
    if (!s) return
    const body = this.#stripCarry(s, true)
    const cur = this.#cur
    this.#cur = null
    if (body == null) {
      // a sentença inteira já foi falada pelo contexto anterior (corte forçado): nada a enviar
      return
    }
    let ctx: ElevenLabsContext
    if (cur && !cur.ctx.done && body.startsWith(cur.sent)) {
      ctx = cur.ctx
      ctx.finish(body.slice(cur.sent.length))
    } else if (cur && !cur.ctx.done && cur.sent.startsWith(body)) {
      // corte forçado DENTRO do que já foi entregue: o resto entregue vira "carry"
      ctx = cur.ctx
      this.#carry = cur.sent.slice(body.length).trim()
      ctx.finish('')
    } else {
      cur?.ctx.abort()
      ctx = this.#newContext(sock)
      ctx.finish(body)
    }
    this.#ready.push({ text: s, ctx })
  }

  /**
   * `synth` da chamada (via `TtsStreamRelay.synth`): o contexto já cortado desta sentença, ou um
   * novo com o texto inteiro. Sentenças cortadas antes desta e nunca pedidas são descartadas.
   */
  synth(text: string, signal?: AbortSignal): TtsPcmStream {
    const s = text.trim()
    const sock = this.#socket()
    if (!sock)
      throw new TtsError('config', 'a ElevenLabs não está configurada para a fala', {
        backend: 'api'
      })
    if (!s)
      throw new TtsError('config', 'texto para a síntese de fala está vazio', { backend: 'api' })
    const i = this.#ready.findIndex((r) => r.text === s && !r.ctx.aborted && !r.ctx.error)
    let ctx: ElevenLabsContext
    if (i >= 0) {
      for (const skipped of this.#ready.splice(0, i)) skipped.ctx.abort()
      ctx = this.#ready.shift()!.ctx
    } else {
      ctx = this.#newContext(sock)
      ctx.finish(s)
    }
    return ctx.stream(signal, this.#o.config()?.modelId ?? '')
  }

  reset(): void {
    const sock = this.#sock
    this.#dropCurrent()
    for (const r of this.#ready) r.ctx.abort()
    this.#ready = []
    this.#carry = ''
    if (!sock) return
    // algum contexto ainda gerando (flush em curso não para com close_context): derruba o socket
    // — o próximo turno reconecta (begin pré-abre)
    if (sock.generating) {
      sock.close()
      this.#sock = null
    }
  }

  close(): void {
    this.#dropCurrent()
    for (const r of this.#ready) r.ctx.abort()
    this.#ready = []
    this.#sock?.close()
    this.#sock = null
  }

  // ---- interno ----

  /** Socket da config atual (config mudou → socket novo; desligado → fecha). */
  #socket(): ElevenLabsSocket | null {
    let cfg: ElevenLabsSocketOptions | null
    try {
      cfg = this.#o.config()
    } catch {
      cfg = null
    }
    if (!cfg) {
      if (this.#sock) this.close()
      return null
    }
    const key = configKey(cfg)
    if (this.#sock && this.#sock.key !== key) this.close()
    this.#sock ??= new ElevenLabsSocket(cfg)
    return this.#sock
  }

  #newContext(sock: ElevenLabsSocket): ElevenLabsContext {
    const ctx = sock.context()
    ctx.onFirstAudio = (c) => this.#reportLatency(c)
    // 1º texto do turno: o relógio do "1º texto → 1º áudio" do turno começa aqui (inclui a
    // conexão quando o socket ainda não estava aberto)
    this.#turnFirstTextAt ??= sock.now()
    return ctx
  }

  #reportLatency(c: ElevenLabsContext): void {
    const at = c.firstAudioAt ?? 0
    const turnMs =
      !this.#turnReported && this.#turnFirstTextAt != null ? at - this.#turnFirstTextAt : null
    this.#turnReported = true
    this.#o.onLatency?.({
      contextId: c.id,
      firstTextToAudioMs: at - (c.firstTextAt ?? at),
      flushToAudioMs: c.flushAt != null && c.flushAt <= at ? at - c.flushAt : null,
      turnMs,
      chars: c.text.length
    })
  }

  /**
   * Tira o "carry" (texto já falado por um corte forçado) do começo; null = o texto inteiro ainda
   * está dentro dele. `consume` (no corte) zera o carry; nos parciais ele fica até o corte.
   */
  #stripCarry(t: string, consume: boolean): string | null {
    const carry = this.#carry
    if (!carry) return t
    if (consume) this.#carry = ''
    if (t.startsWith(carry)) return t.slice(carry.length).replace(/^\s+/, '') || null
    if (carry.startsWith(t.trim())) return null
    this.#carry = '' // divergiu: esquece
    return t
  }

  #dropCurrent(): void {
    this.#cur?.ctx.abort()
    this.#cur = null
  }
}

/**
 * Opções do WebSocket para a fala atual — null quando a chamada NÃO deve usar o WebSocket da
 * ElevenLabs (backend local, outro provedor, sem chave, ou modelo que o WebSocket não aceita —
 * esses seguem o `synth` por sentença via REST `/stream`).
 */
export function elevenLabsCallOptions(
  tts: TtsSettings,
  extra: Partial<ElevenLabsSocketOptions> = {}
): ElevenLabsSocketOptions | null {
  if (tts.backend !== 'api' || !isElevenLabsEndpoint(tts.api)) return null
  let cfg: ElevenLabsConfig
  try {
    cfg = elevenLabsConfig(tts.api)
  } catch {
    return null // sem chave: o synth REST mostra o erro legível
  }
  if (!elevenLabsWsSupportsModel(cfg.modelId)) return null
  return { ...cfg, ...extra }
}
