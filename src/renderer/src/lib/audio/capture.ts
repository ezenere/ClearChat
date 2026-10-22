// Captura de áudio no renderer (Web Audio nativo, sem IPC no loop de áudio): `AudioCapture`
// abre o microfone, coleta PCM pelo AudioWorklet (`captureWorklet.ts`, empacotado via `?worker&url`)
// e emite três fluxos de eventos: nível RMS por quadro (~30 Hz), chunks de PCM16 mono a 16 kHz
// (downsample da taxa do AudioContext, função pura em `pcm.ts`) e silêncio detectado
// (política pura em `silence.ts`).
//
// Nota de build (verificado em out/renderer): `new URL('./captureWorklet.ts', import.meta.url)`
// embute o TypeScript cru como data URL `video/mp2t` (inválido); `?worker&url` emite o asset
// `.js` compilado e funciona no build e no dev. Fallback Blob URL está fora de questão sem mexer
// na CSP (`script-src 'self'` em src/renderer/index.html) e não é necessário.
import workletUrl from './captureWorklet.ts?worker&url'
import { concatFloat32, floatToPcm16, frameRms, resampleMono } from './pcm'
import { SilenceDetector, type SilenceDetectorConfig } from './silence'

/** Nome do processador registrado no worklet — precisa casar com `PROCESSOR_NAME` em captureWorklet.ts. */
export const CAPTURE_PROCESSOR_NAME = 'clearchat-capture'

/** Constraints padrão do microfone: cancelamento de eco e supressão de ruído ON, AGC OFF (voz
 *  natural para STT; sobrescreva via `AudioCaptureOptions.constraints`). */
export const DEFAULT_AUDIO_TRACK_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: false
}

/** Taxa padrão dos chunks PCM de saída (mono) — o contrato do STT fala em 16 kHz. */
export const DEFAULT_PCM_SAMPLE_RATE = 16000
/** Duração padrão de cada chunk PCM emitido. */
export const DEFAULT_CHUNK_MS = 100
/** Duração padrão do quadro de nível RMS (~33 ms ≈ 30 Hz). */
export const DEFAULT_LEVEL_MS = 33

export interface AudioCaptureOptions {
  /** Constraints de `getUserMedia` (mescladas sobre `DEFAULT_AUDIO_TRACK_CONSTRAINTS`). */
  constraints?: MediaTrackConstraints
  /** Taxa dos chunks PCM emitidos (padrão 16000). */
  sampleRate?: number
  /** Duração de cada chunk PCM em ms (padrão 100). */
  chunkMs?: number
  /** Duração do quadro de nível RMS em ms (padrão 33 ≈ 30 Hz). */
  levelMs?: number
  /** Configuração do detector de silêncio (`false` desliga); sem `silenceMs` o limite fica
   *  ignorado (0) e o evento não dispara — quem define a duração é o consumidor (ex.: o hook). */
  silence?: Partial<SilenceDetectorConfig> | false
}

export interface CaptureEventMap {
  /** Nível RMS do quadro (0..1), a ~30 Hz. */
  level: (level: number) => void
  /** Chunk de PCM16 mono na taxa configurada (padrão 16 kHz). */
  pcm: (chunk: Int16Array) => void
  /** Silêncio contínuo atingiu a duração configurada (uma vez por ocorrência). */
  silence: () => void
  /** Erro em tempo de execução (a captura continua rodando salvo indicação). */
  error: (error: Error) => void
  /** A captura terminou por conta própria (faixa de áudio encerrada — ex.: microfone desconectado). */
  ended: () => void
}

export type CaptureState = 'idle' | 'starting' | 'running' | 'stopping'

/** Buffer circular simples: acumula pedaços e devolve janelas fixas de N amostras. */
class SampleWindow {
  #parts: Float32Array[] = []
  #length = 0

  get length(): number {
    return this.#length
  }

  push(samples: Float32Array): void {
    if (samples.length === 0) return
    this.#parts.push(samples)
    this.#length += samples.length
  }

  /** Retira exatamente `n` amostras (ou `null` se ainda não há janela completa). */
  take(n: number): Float32Array | null {
    if (this.#length < n) return null
    const all = concatFloat32(this.#parts)
    const head = all.slice(0, n)
    const rest = all.slice(n)
    this.#parts = rest.length > 0 ? [rest] : []
    this.#length = rest.length
    return head
  }

  clear(): void {
    this.#parts = []
    this.#length = 0
  }
}

/**
 * Captura de áudio reutilizável (renderer puro). Uso típico:
 *
 * ```ts
 * const capture = new AudioCapture({ silence: { silenceMs: 5000 } })
 * capture.on('level', (rms) => { ... })
 * capture.on('pcm', (chunk) => { ... })
 * capture.on('silence', () => void capture.stop())
 * await capture.start(null) // null = microfone padrão do sistema
 * ```
 *
 * `start()` rejeita se já houver captura em andamento; `stop()` é idempotente. O detector de
 * silêncio emite o evento `silence` uma vez por ocorrência (e rearma quando a fala volta).
 */
export class AudioCapture {
  readonly #options: AudioCaptureOptions
  readonly #listeners = new Map<keyof CaptureEventMap, Set<(...args: never[]) => void>>()
  #state: CaptureState = 'idle'
  #deviceId: string | null = null
  #stream: MediaStream | null = null
  #context: AudioContext | null = null
  #source: MediaStreamAudioSourceNode | null = null
  #node: AudioWorkletNode | null = null
  #mute: GainNode | null = null
  #detector: SilenceDetector | null = null
  #silenceNotified = false
  #pcmOutRate = DEFAULT_PCM_SAMPLE_RATE
  #chunkSamples = 0
  #frameSamples = 0
  #frameMs = 0
  #chunks = new SampleWindow()
  #frames = new SampleWindow()

  constructor(options: AudioCaptureOptions = {}) {
    this.#options = options
  }

  /** Estado atual da captura. */
  get state(): CaptureState {
    return this.#state
  }

  /** Dispositivo em uso (null = padrão do sistema). */
  get deviceId(): string | null {
    return this.#deviceId
  }

  /** Taxa de amostragem real do AudioContext (a de saída PCM é `options.sampleRate`). */
  get contextSampleRate(): number | null {
    return this.#context?.sampleRate ?? null
  }

  /** Assina um evento; devolve a função de cancelamento. */
  on<K extends keyof CaptureEventMap>(type: K, listener: CaptureEventMap[K]): () => void {
    const set = this.#listeners.get(type) ?? new Set<(...args: never[]) => void>()
    set.add(listener as (...args: never[]) => void)
    this.#listeners.set(type, set)
    return () => {
      set.delete(listener as (...args: never[]) => void)
    }
  }

  /**
   * Abre o microfone (`deviceId` null = padrão do sistema) e inicia a emissão de eventos.
   * Rejeita com erro legível se a captura já estiver ativa, se `getUserMedia` falhar
   * (permissão negada) ou se o AudioWorklet não carregar.
   */
  async start(deviceId: string | null): Promise<void> {
    if (this.#state !== 'idle') {
      throw new Error('AudioCapture: captura já em andamento (use stop() antes)')
    }
    this.#state = 'starting'
    try {
      const mediaDevices = navigator.mediaDevices
      if (!mediaDevices?.getUserMedia) {
        throw new Error('AudioCapture: captura de áudio indisponível neste contexto')
      }
      const constraints: MediaTrackConstraints = {
        ...DEFAULT_AUDIO_TRACK_CONSTRAINTS,
        ...this.#options.constraints
      }
      if (deviceId) constraints.deviceId = { exact: deviceId }
      const stream = await mediaDevices.getUserMedia({ audio: constraints, video: false })
      const context = new AudioContext({ latencyHint: 'interactive' })
      try {
        if (!context.audioWorklet) {
          throw new Error('AudioWorklet indisponível no runtime')
        }
        await context.audioWorklet.addModule(workletUrl)
      } catch (cause) {
        await context.close()
        stream.getTracks().forEach((t) => t.stop())
        throw new Error(
          `AudioCapture: falha ao carregar o worklet de captura (${cause instanceof Error ? cause.message : String(cause)})`,
          { cause }
        )
      }
      const source = context.createMediaStreamSource(stream)
      const node = new AudioWorkletNode(context, CAPTURE_PROCESSOR_NAME, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1]
      })
      // Interrupção por stop() durante o start assíncrono (ex.: tecla do PTT solta na janela de
      // permissão): o start aborta e libera o que acabou de abrir, sem derrubar o chamador.
      const abort = (): Error => {
        void context.close().catch(() => {})
        stream.getTracks().forEach((t) => t.stop())
        return new Error('AudioCapture: start interrompido por stop()')
      }
      if (this.#state !== 'starting') throw abort()
      // O nó precisa chegar ao destination para ser "puxado"; o ganho mudo evita eco.
      const mute = context.createGain()
      mute.gain.value = 0
      source.connect(node)
      node.connect(mute)
      mute.connect(context.destination)
      await context.resume()
      if (this.#state !== 'starting') {
        source.disconnect()
        node.disconnect()
        mute.disconnect()
        throw abort()
      }

      this.#stream = stream
      this.#context = context
      this.#source = source
      this.#node = node
      this.#mute = mute
      this.#deviceId = deviceId
      this.#pcmOutRate = this.#options.sampleRate ?? DEFAULT_PCM_SAMPLE_RATE
      const chunkMs = this.#options.chunkMs ?? DEFAULT_CHUNK_MS
      const levelMs = this.#options.levelMs ?? DEFAULT_LEVEL_MS
      this.#chunkSamples = Math.max(1, Math.round((context.sampleRate * chunkMs) / 1000))
      this.#frameSamples = Math.max(1, Math.round((context.sampleRate * levelMs) / 1000))
      this.#frameMs = (this.#frameSamples / context.sampleRate) * 1000
      this.#chunks.clear()
      this.#frames.clear()
      this.#silenceNotified = false
      const silence = this.#options.silence
      this.#detector = silence === false ? null : new SilenceDetector(silence ?? {})
      node.port.onmessage = (event: MessageEvent) => {
        this.#handleSamples(event.data?.samples as Float32Array)
      }
      // `track.stop()` não dispara 'ended'; este handler cobre só a perda externa do microfone.
      for (const track of stream.getTracks()) {
        track.addEventListener('ended', () => {
          void this.stop().then(() => this.#emit('ended'))
        })
      }
      this.#state = 'running'
    } catch (cause) {
      this.#teardown()
      this.#state = 'idle'
      throw cause instanceof Error ? cause : new Error(String(cause))
    }
  }

  /** Encerra a captura e libera o microfone. Idempotente (chamar parado não faz nada). */
  async stop(): Promise<void> {
    if (this.#state === 'idle') return
    this.#state = 'stopping'
    const context = this.#context
    this.#teardown()
    try {
      await context?.close()
    } catch {
      // contexto já fechado — nada a fazer
    }
    this.#state = 'idle'
  }

  #teardown(): void {
    if (this.#node) this.#node.port.onmessage = null
    this.#node?.disconnect()
    this.#source?.disconnect()
    this.#mute?.disconnect()
    this.#stream?.getTracks().forEach((t) => t.stop())
    this.#stream = null
    this.#context = null
    this.#source = null
    this.#node = null
    this.#mute = null
    this.#detector = null
    this.#chunks.clear()
    this.#frames.clear()
  }

  #handleSamples(samples: Float32Array): void {
    if (!(samples instanceof Float32Array) || samples.length === 0) return
    this.#chunks.push(samples)
    this.#frames.push(samples)
    // Nível RMS por quadro (~30 Hz) + política de silêncio.
    let frame = this.#frames.take(this.#frameSamples)
    while (frame) {
      const rms = frameRms(frame)
      this.#emit('level', rms)
      if (this.#detector) {
        const silent = this.#detector.push(rms, this.#frameMs)
        if (silent && !this.#silenceNotified) {
          this.#silenceNotified = true
          this.#emit('silence')
        } else if (!silent) {
          this.#silenceNotified = false
        }
      }
      frame = this.#frames.take(this.#frameSamples)
    }
    // Chunks PCM16 na taxa de saída (downsample da taxa do AudioContext).
    let chunk = this.#chunks.take(this.#chunkSamples)
    while (chunk) {
      const resampled = resampleMono(
        chunk,
        this.#context?.sampleRate ?? this.#pcmOutRate,
        this.#pcmOutRate
      )
      this.#emit('pcm', floatToPcm16(resampled))
      chunk = this.#chunks.take(this.#chunkSamples)
    }
  }

  #emit<K extends keyof CaptureEventMap>(type: K, ...args: Parameters<CaptureEventMap[K]>): void {
    for (const listener of this.#listeners.get(type) ?? []) {
      try {
        ;(listener as (...a: Parameters<CaptureEventMap[K]>) => void)(...args)
      } catch (cause) {
        // Listener com erro não pode derrubar o loop de mensagens do worklet.
        if (type !== 'error') {
          this.#emit('error', cause instanceof Error ? cause : new Error(String(cause)))
        }
      }
    }
  }
}
