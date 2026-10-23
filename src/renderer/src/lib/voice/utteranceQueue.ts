// Fila de utterances da chamada de voz (renderer): toca os bytes wav/mp3 das sentenças na ordem,
// SEM sobreposição, com estados `idle`/`playing`. Barge-in = `cancel()` (pausa o atual e descarta
// a fila). O player é injetável (testes usam fake; a fábrica padrão é `new Audio` com blob URL,
// liberado ao terminar). Utterances em streaming (`streaming: true`, `audio/pcm;rate=N` — TTS de API
// com PCM progressivo) tocam pela Web Audio conforme os pedaços chegam (`pushChunk`).
// Ver SPEC.md → "Áudio → Chamada de voz (meia-duplex)" e "Serviço de TTS → Streaming na chamada".
import type { VoiceCallUtteranceChunkEvent, VoiceCallUtteranceEvent } from '@shared/ipc'

export type UtteranceState = 'idle' | 'playing'

/** Player de uma utterance (o mínimo que a fila precisa — `new Audio` satisfaz). */
export interface UtterancePlayer {
  play(): void | Promise<void>
  pause(): void
  /** O áudio terminou (toque completo). */
  onended: (() => void) | null
  /** Falha ao carregar/tocar (a fila segue para a próxima); `reason` legível quando conhecido. */
  onerror: ((reason?: string) => void) | null
  /** Volume 0..1 (a fila propaga `setVolume`). */
  volume: number
  /** Libera recursos (blob URL etc.) — chamado ao terminar/cancelar. */
  dispose?(): void
}

/**
 * Pedaços PCM16 de uma utterance em streaming: o começo (`audio` do evento) + o que chegar por
 * `voice:call:utterance-chunk`. Quem assina recebe o que já chegou e depois o resto, ao vivo.
 */
export class PcmStreamSource {
  readonly sampleRate: number
  #chunks: Uint8Array[] = []
  #ended = false
  #listener: { chunk: (pcm: Uint8Array) => void; end: () => void } | null = null

  constructor(sampleRate: number, first?: Uint8Array) {
    this.sampleRate = sampleRate
    if (first?.length) this.#chunks.push(first)
  }

  get ended(): boolean {
    return this.#ended
  }

  push(pcm: Uint8Array): void {
    if (this.#ended || !pcm.length) return
    this.#chunks.push(pcm)
    this.#listener?.chunk(pcm)
  }

  end(): void {
    if (this.#ended) return
    this.#ended = true
    this.#listener?.end()
  }

  /** Assina (um ouvinte): repassa o que já chegou e segue ao vivo; devolve o cancelamento. */
  subscribe(chunk: (pcm: Uint8Array) => void, end: () => void): () => void {
    this.#listener = { chunk, end }
    for (const c of this.#chunks) chunk(c)
    if (this.#ended) end()
    return () => {
      if (this.#listener?.chunk === chunk) this.#listener = null
    }
  }
}

/** Taxa do `audio/pcm;rate=N` (null = não é PCM cru). */
export function pcmRateOf(mime: string): number | null {
  const m = /^audio\/pcm\b.*?\brate=(\d+)/i.exec(mime)
  const n = m ? Number(m[1]) : NaN
  return Number.isInteger(n) && n > 0 ? n : null
}

/**
 * Fábrica de player por utterance (bytes + mime → player pronto para `play`). Utterance em
 * streaming chega com o `stream` (PCM16 aos pedaços) — `audio` é só o começo.
 */
export type PlayerFactory = (
  audio: Uint8Array,
  mime: string,
  stream?: PcmStreamSource
) => UtterancePlayer

/** Player padrão: blob URL + `new Audio` (sem dependências; liberado no `dispose`). */
class DomAudioPlayer implements UtterancePlayer {
  onended: (() => void) | null = null
  onerror: ((reason?: string) => void) | null = null
  readonly #el: HTMLAudioElement
  readonly #url: string

  constructor(audio: Uint8Array, mime: string) {
    // cópia exata: o buffer de origem pode ser uma visão maior (bytes do IPC)
    const copy = audio.slice()
    this.#url = URL.createObjectURL(new Blob([copy], { type: mime }))
    this.#el = new Audio(this.#url)
    this.#el.onended = () => this.onended?.()
    this.#el.onerror = () => {
      const err = this.#el.error
      this.onerror?.(
        err ? `erro de mídia ${err.code}${err.message ? `: ${err.message}` : ''}` : 'erro de mídia'
      )
    }
  }

  get volume(): number {
    return this.#el.volume
  }

  set volume(v: number) {
    this.#el.volume = v
  }

  /** Devolve a promise do `<audio>`: rejeição (autoplay/decodificação) chega à fila, que avança. */
  play(): Promise<void> {
    return this.#el.play()
  }

  pause(): void {
    this.#el.pause()
  }

  dispose(): void {
    this.#el.pause()
    this.#el.onended = null
    this.#el.onerror = null
    URL.revokeObjectURL(this.#url)
  }
}

/** Antecedência do agendamento na Web Audio (s) — absorve o jitter entre pedaços. */
const PCM_LEAD_S = 0.03
/** Rampa de entrada (ms) no começo da utterance e depois de um buraco (underrun) — sem estalo. */
export const PCM_FADE_IN_MS = 5

// ---------------- partes puras do player PCM (testadas em e2e/voiceCallFix.test.ts) ----------------

/** PCM16 LE (bytes, tamanho par) → amostras float −1..1. */
export function pcm16ToFloat(pcm: Uint8Array): Float32Array {
  const n = pcm.length >> 1
  const view = new DataView(pcm.buffer, pcm.byteOffset, n * 2)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = view.getInt16(i * 2, true) / 0x8000
  return out
}

/** Rampa linear de entrada nas primeiras `frames` amostras (no lugar). */
export function applyFadeIn(samples: Float32Array, frames: number): void {
  const n = Math.min(samples.length, Math.max(0, Math.floor(frames)))
  for (let i = 0; i < n; i++) samples[i] *= (i + 1) / (n + 1)
}

/**
 * Reamostrador linear CONTÍNUO entre pedaços (só usado quando o AudioContext não pôde abrir na
 * taxa do stream): guarda a última amostra e a fase, então reamostrar pedaço a pedaço dá
 * exatamente o mesmo que reamostrar o stream inteiro — sem costura nas fronteiras.
 */
export class PcmStreamResampler {
  readonly #step: number
  #pos = 0
  #prev: number | null = null

  constructor(fromRate: number, toRate: number) {
    this.#step = fromRate / toRate
  }

  push(input: Float32Array): Float32Array {
    const n = input.length
    if (!n) return new Float32Array(0)
    // sequência virtual [prev, ...input]: o índice -1 é a última amostra do pedaço anterior
    const at = (i: number): number => (i < 0 ? (this.#prev ?? input[0]) : input[i])
    const out: number[] = []
    let p = this.#pos
    for (;;) {
      const i0 = Math.floor(p)
      const frac = p - i0
      if (frac === 0) {
        if (i0 > n - 1) break
        out.push(at(i0))
      } else {
        if (i0 + 1 > n - 1) break
        out.push(at(i0) + (at(i0 + 1) - at(i0)) * frac)
      }
      p += this.#step
    }
    this.#pos = p - n
    this.#prev = input[n - 1]
    return Float32Array.from(out)
  }
}

/**
 * Relógio de agendamento em QUADROS inteiros da taxa do contexto: cada pedaço começa exatamente
 * onde o anterior terminou (sem lacuna nem sobreposição); atrasou (underrun) → recomeça
 * `leadS` à frente do relógio, avisando (`gap`) para o chamador suavizar a entrada.
 */
export class PcmScheduleClock {
  readonly rate: number
  #next: number | null = null

  constructor(rate: number) {
    this.rate = rate
  }

  place(frames: number, nowS: number, leadS = PCM_LEAD_S): { startFrame: number; gap: boolean } {
    const earliest = Math.ceil((nowS + leadS) * this.rate)
    const first = this.#next == null
    const gap = !first && (this.#next as number) < Math.ceil(nowS * this.rate)
    const startFrame = first || gap ? earliest : (this.#next as number)
    this.#next = startFrame + frames
    return { startFrame, gap }
  }

  get nextFrame(): number | null {
    return this.#next
  }
}

/**
 * Um AudioContext por taxa do stream (`new AudioContext({ sampleRate })`): o PCM de 24 kHz do TTS
 * agendado em pedaços num contexto de 48 kHz era reamostrado NÓ A NÓ e cada fronteira de pedaço
 * (~28 ms) ganhava um degrau de até ~0,6 da escala cheia — o "pzzz/rrrr" na fala da chamada. Na
 * taxa do stream os pedaços se emendam amostra a amostra; o navegador reamostra a saída inteira
 * de uma vez para o dispositivo. Taxa recusada → o contexto padrão + `PcmStreamResampler`.
 */
const audioContexts = new Map<number, AudioContext>()
function audioContextFor(rate: number): AudioContext {
  let ctx = audioContexts.get(rate)
  if (!ctx || ctx.state === 'closed') {
    try {
      ctx = new AudioContext({ sampleRate: rate, latencyHint: 'interactive' })
    } catch {
      ctx = audioContexts.get(0)
      if (!ctx || ctx.state === 'closed') {
        ctx = new AudioContext({ latencyHint: 'interactive' })
        audioContexts.set(0, ctx)
      }
    }
    audioContexts.set(rate, ctx)
  }
  return ctx
}

/**
 * Player de PCM16 em streaming pela Web Audio: cada pedaço vira um `AudioBufferSourceNode`
 * agendado em quadros inteiros, emendado no anterior (`PcmScheduleClock`), num contexto na taxa do
 * stream (sem reamostragem por nó — ver `audioContextFor`); rampa de 5 ms no começo e depois de um
 * underrun; termina quando o stream acabou e o último trecho tocou. Volume por `GainNode`.
 */
export class WebAudioPcmPlayer implements UtterancePlayer {
  onended: (() => void) | null = null
  onerror: ((reason?: string) => void) | null = null
  readonly #source: PcmStreamSource
  #ctx: AudioContext | null = null
  #gain: GainNode | null = null
  #volume = 1
  #clock: PcmScheduleClock | null = null
  #resampler: PcmStreamResampler | null = null
  #nodes = new Set<AudioBufferSourceNode>()
  #unsubscribe: (() => void) | null = null
  #streamEnded = false
  #finished = false
  #stopped = false

  readonly #contextFor: (rate: number) => AudioContext

  /** `contextFor` injetável (testes renderizam o agendamento num contexto falso). */
  constructor(
    source: PcmStreamSource,
    contextFor: (rate: number) => AudioContext = audioContextFor
  ) {
    this.#source = source
    this.#contextFor = contextFor
  }

  get volume(): number {
    return this.#volume
  }

  set volume(v: number) {
    this.#volume = v
    if (this.#gain) this.#gain.gain.value = v
  }

  async play(): Promise<void> {
    const ctx = this.#contextFor(this.#source.sampleRate)
    this.#ctx = ctx
    this.#clock = new PcmScheduleClock(ctx.sampleRate)
    this.#resampler =
      ctx.sampleRate === this.#source.sampleRate
        ? null
        : new PcmStreamResampler(this.#source.sampleRate, ctx.sampleRate)
    const gain = ctx.createGain()
    gain.gain.value = this.#volume
    gain.connect(ctx.destination)
    this.#gain = gain
    if (ctx.state === 'suspended') await ctx.resume()
    if (this.#stopped) return
    this.#unsubscribe = this.#source.subscribe(
      (pcm) => this.#schedule(pcm),
      () => {
        this.#streamEnded = true
        this.#check()
      }
    )
  }

  #schedule(pcm: Uint8Array): void {
    const ctx = this.#ctx
    const gain = this.#gain
    const clock = this.#clock
    if (!ctx || !gain || !clock || this.#stopped) return
    let samples = pcm16ToFloat(pcm)
    if (this.#resampler) samples = this.#resampler.push(samples)
    if (!samples.length) return
    // contíguo em quadros inteiros enquanto o próximo pedaço chega antes da hora; atrasou
    // (underrun) → recomeça um pouco à frente, com rampa de entrada (sem estalo)
    const first = clock.nextFrame == null
    const { startFrame, gap } = clock.place(samples.length, ctx.currentTime)
    if (first || gap) applyFadeIn(samples, (PCM_FADE_IN_MS / 1000) * ctx.sampleRate)
    const buffer = ctx.createBuffer(1, samples.length, ctx.sampleRate)
    buffer.getChannelData(0).set(samples)
    const node = ctx.createBufferSource()
    node.buffer = buffer
    node.connect(gain)
    node.start(startFrame / ctx.sampleRate)
    this.#nodes.add(node)
    node.onended = () => {
      this.#nodes.delete(node)
      this.#check()
    }
  }

  #check(): void {
    if (this.#finished || this.#stopped || !this.#streamEnded || this.#nodes.size) return
    this.#finished = true
    this.onended?.()
  }

  pause(): void {
    this.#stopped = true
    this.#unsubscribe?.()
    this.#unsubscribe = null
    for (const node of this.#nodes) {
      node.onended = null
      try {
        node.stop()
      } catch {
        /* ainda não começou / já parou */
      }
    }
    this.#nodes.clear()
  }

  dispose(): void {
    this.pause()
    this.#gain?.disconnect()
    this.#gain = null
  }
}

/** Ganho relativo da utterance (`gain` 0..1; ausente/lixo = 1). */
function gainOf(u: VoiceCallUtteranceEvent | null): number {
  const g = u?.gain
  return typeof g === 'number' && Number.isFinite(g) ? Math.min(1, Math.max(0, g)) : 1
}

/**
 * Para um player: na hora (`fadeMs` 0) ou com rampa linear de volume até 0 em `fadeMs` (passos de
 * ~10 ms) — clipe/frase interrompidos nunca cortam seco no meio da palavra.
 */
function stopPlayer(player: UtterancePlayer, fadeMs: number): void {
  const finish = (): void => {
    try {
      player.pause()
    } catch {
      /* player já parado */
    }
    player.dispose?.()
  }
  if (!(fadeMs > 0) || typeof setInterval !== 'function') return finish()
  const start = player.volume
  const steps = Math.max(1, Math.round(fadeMs / 10))
  let i = 0
  const timer = setInterval(() => {
    i++
    try {
      player.volume = Math.max(0, start * (1 - i / steps))
    } catch {
      /* player sem volume ajustável */
    }
    if (i >= steps) {
      clearInterval(timer)
      finish()
    }
  }, fadeMs / steps)
}

export function domPlayerFactory(
  audio: Uint8Array,
  mime: string,
  stream?: PcmStreamSource
): UtterancePlayer {
  const rate = pcmRateOf(mime)
  if (rate !== null) {
    // PCM cru: streaming (pedaços chegando) ou um bloco só, fechado
    let source = stream
    if (!source) {
      source = new PcmStreamSource(rate, audio)
      source.end()
    }
    return new WebAudioPcmPlayer(source)
  }
  return new DomAudioPlayer(audio, mime)
}

export interface UtteranceQueueOptions {
  /** Fábrica de players (padrão `domPlayerFactory`). */
  playerFactory?: PlayerFactory
  /** Mudança de estado ('idle' = fila vazia e nada tocando; 'playing' = há áudio em curso). */
  onState?: (state: UtteranceState) => void
  /** Início/fim da reprodução de cada utterance (timeline da chamada — cancelas não emitem 'end'). */
  onItem?: (e: { item: VoiceCallUtteranceEvent; phase: 'start' | 'end' }) => void
  /**
   * A utterance NÃO tocou (bytes ilegíveis, `play()` rejeitado — autoplay/CSP/codec —, erro de
   * mídia): a fila segue para a próxima, mas o motivo chega aqui (nunca falha calada).
   */
  onError?: (e: { item: VoiceCallUtteranceEvent; reason: string }) => void
}

/**
 * Fila de reprodução (uma por chamada). `enqueue` aceita qualquer ordem de chegada e toca
 * estritamente na ordem; `cancel()` (barge-in) pausa o que estiver tocando e descarta o resto —
 * o texto da resposta segue completo no histórico. `state`/`pending` alimentam a UI.
 */
export class UtteranceQueue {
  #factory: PlayerFactory
  #onState: ((state: UtteranceState) => void) | undefined
  #onItem: ((e: { item: VoiceCallUtteranceEvent; phase: 'start' | 'end' }) => void) | undefined
  #onError: ((e: { item: VoiceCallUtteranceEvent; reason: string }) => void) | undefined
  #queue: VoiceCallUtteranceEvent[] = []
  /** Pedaços das utterances em streaming (por id), da chegada até o fim do stream. */
  #streams = new Map<string, PcmStreamSource>()
  #current: UtterancePlayer | null = null
  #currentItem: VoiceCallUtteranceEvent | null = null
  #state: UtteranceState = 'idle'
  #volume = 1

  constructor(options: UtteranceQueueOptions = {}) {
    this.#factory = options.playerFactory ?? domPlayerFactory
    this.#onState = options.onState
    this.#onItem = options.onItem
    this.#onError = options.onError
  }

  get state(): UtteranceState {
    return this.#state
  }

  /** Utterances aguardando (não inclui a que está tocando). */
  get pending(): number {
    return this.#queue.length
  }

  /** A utterance tocando agora (null = nada). */
  get current(): VoiceCallUtteranceEvent | null {
    return this.#currentItem
  }

  /** Ids das utterances aguardando (na ordem; sem a que está tocando). */
  get queuedIds(): string[] {
    return this.#queue.map((u) => u.id)
  }

  /** Volume 0..1 (propagado ao player atual e aos seguintes). */
  get volume(): number {
    return this.#volume
  }

  setVolume(volume: number): void {
    this.#volume = Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : 1
    if (this.#current) this.#current.volume = this.#volume * gainOf(this.#currentItem)
  }

  /** Enfileira uma utterance (bytes completos) — toca na ordem, sem sobreposição. */
  enqueue(utterance: VoiceCallUtteranceEvent): void {
    const rate = utterance.streaming ? pcmRateOf(utterance.mime) : null
    if (rate !== null) this.#streams.set(utterance.id, new PcmStreamSource(rate, utterance.audio))
    this.#queue.push(utterance)
    void this.#pump()
  }

  /**
   * Próximo pedaço de uma utterance em streaming (`voice:call:utterance-chunk`): na fila ou
   * tocando, o áudio é acrescentado; `done` fecha o stream. Id desconhecido (cancelada) = ignorado.
   */
  pushChunk(e: VoiceCallUtteranceChunkEvent): void {
    const source = this.#streams.get(e.id)
    if (!source) return
    if (e.pcm?.length) source.push(e.pcm)
    // a fonte fica no mapa até a utterance terminar de tocar (ou ser descartada): o player dela
    // pode nem ter começado ainda
    if (e.done) source.end()
  }

  /**
   * Barge-in/parada: pausa o atual e descarta a fila (nada mais toca até o próximo enqueue).
   * `fadeMs` > 0 = o atual sai com rampa de volume (sem corte seco no meio da palavra).
   */
  cancel(fadeMs = 0): void {
    this.#queue = []
    this.#streams.clear()
    const cur = this.#current
    this.#current = null
    this.#currentItem = null
    if (cur) stopPlayer(cur, fadeMs)
    this.#setState('idle')
  }

  /**
   * Cancela UMA utterance pelo id (ex.: filler interrompido pela 1ª sentença da resposta): na
   * fila → só descarta; tocando → pausa/limpa e avança para a seguinte. Id desconhecido = sem efeito.
   */
  drop(id: string, fadeMs = 0): void {
    this.#queue = this.#queue.filter((u) => u.id !== id)
    this.#streams.delete(id)
    if (this.#currentItem?.id !== id) return
    const cur = this.#current
    this.#current = null
    this.#currentItem = null
    if (cur) stopPlayer(cur, fadeMs)
    if (!this.#queue.length) this.#setState('idle')
    else void this.#pump()
  }

  async #pump(): Promise<void> {
    if (this.#current) return
    const next = this.#queue.shift()
    if (!next) return
    this.#setState('playing')
    let player: UtterancePlayer | null = null
    let settled = false
    let started = false
    const done = (): void => {
      if (settled) return
      settled = true
      // só age se este player ainda for o atual (cancel()/drop() + enqueue novo tornam o done
      // velho: o play() interrompido rejeita depois e não pode derrubar quem está tocando agora)
      if (this.#current !== player) return
      this.#current = null
      this.#currentItem = null
      this.#streams.delete(next.id)
      player?.dispose?.()
      if (started) this.#onItem?.({ item: next, phase: 'end' })
      if (!this.#queue.length) this.#setState('idle')
      void this.#pump()
    }
    const fail = (reason: string): void => {
      // só se ainda é a utterance atual (play() interrompido por cancel/drop não é falha)
      if (!settled && this.#current === player) this.#onError?.({ item: next, reason })
      done()
    }
    try {
      player = this.#factory(next.audio, next.mime, this.#streams.get(next.id))
    } catch (e) {
      // bytes ilegíveis: pula para a próxima (player/current continuam null → done avança)
      this.#onError?.({
        item: next,
        reason: `áudio ilegível: ${e instanceof Error ? e.message : String(e)}`
      })
      done()
      return
    }
    this.#current = player
    this.#currentItem = next
    player.volume = this.#volume * gainOf(next)
    player.onended = done
    player.onerror = (reason?: string) => fail(reason || 'erro ao tocar')
    started = true
    this.#onItem?.({ item: next, phase: 'start' })
    try {
      await player.play()
    } catch (e) {
      fail(`play() recusado: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`)
    }
  }

  #setState(state: UtteranceState): void {
    if (this.#state === state) return
    this.#state = state
    this.#onState?.(state)
  }
}
