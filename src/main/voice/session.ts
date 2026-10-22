// Sessão de transcrição de voz (main, SEM Electron — testável): acumula o PCM16 mono 16 kHz do
// microfone, dispara parciais **melhor-esforço** a cada `STT_PARTIAL_INTERVAL_MS` (pedaços do
// acumulado com sobreposição de `STT_PARTIAL_OVERLAP_MS`; a request em voo é abortada quando a
// seguinte dispara e resultados velhos expiram — nunca há fila, regra de latência do design) e
// transcreve o buffer inteiro em `stop()` (final, via `transcribeWithFallback` quando há motor
// local injetado). `cancel()` descarta tudo sem transcrever. Uma sessão global por vez (erro
// legível ao iniciar outra). `encodeWav` monta o wav PCM enviado à API (`transcribeAudio` usa
// `audio/wav` nas parciais e no final). Ver SPEC.md → "Áudio → Sessão de transcrição".
import type { VoicePartialEvent, VoiceTranscribeResult } from '@shared/ipc'
import type { SttSettings } from '@shared/voice'
import { abortError } from '../tools/util'
import {
  chooseSttBackend,
  STT_PARTIAL_INTERVAL_MS,
  STT_PARTIAL_OVERLAP_MS,
  transcribeAudio,
  transcribeWithFallback,
  type SttLocalBackend
} from './stt'

/** PCM16 mono a esta taxa (Hz): o formato do buffer da sessão e do wav enviado à API. */
export const VOICE_SAMPLE_RATE = 16_000
/** PCM16 mono: 2 bytes por amostra → bytes por ms. */
const BYTES_PER_MS = (VOICE_SAMPLE_RATE * 2) / 1000
/** Sobreposição entre pedaços consecutivos das parciais, em bytes de PCM. */
const OVERLAP_BYTES = Math.round(STT_PARTIAL_OVERLAP_MS * BYTES_PER_MS)

// ---------------- wav PCM (puro) ----------------

/**
 * WAV RIFF little-endian, PCM 16-bit mono (cabeçalho de 44 bytes) a partir do PCM16 cru.
 * É o formato enviado à API (`transcribeAudio` → `audio/wav`), nas parciais e no final.
 */
export function encodeWav(pcm16: Uint8Array, sampleRate: number): Uint8Array {
  if (!(pcm16 instanceof Uint8Array)) throw new Error('encodeWav: pcm16 deve ser Uint8Array.')
  if (pcm16.length % 2) throw new Error('encodeWav: PCM16 com tamanho ímpar (2 bytes por amostra).')
  if (!Number.isInteger(sampleRate) || sampleRate <= 0)
    throw new Error(`encodeWav: sampleRate inválido (${sampleRate}).`)
  const out = new Uint8Array(44 + pcm16.length)
  const dv = new DataView(out.buffer)
  const ascii = (offset: number, s: string): void => {
    for (let i = 0; i < s.length; i++) out[offset + i] = s.charCodeAt(i)
  }
  ascii(0, 'RIFF')
  dv.setUint32(4, 36 + pcm16.length, true) // tamanho do RIFF
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  dv.setUint32(16, 16, true) // tamanho do subchunk fmt
  dv.setUint16(20, 1, true) // formato PCM
  dv.setUint16(22, 1, true) // mono
  dv.setUint32(24, sampleRate, true)
  dv.setUint32(28, sampleRate * 2, true) // byteRate (blockAlign × sampleRate)
  dv.setUint16(32, 2, true) // blockAlign (mono × 16 bits)
  dv.setUint16(34, 16, true) // bits por amostra
  ascii(36, 'data')
  dv.setUint32(40, pcm16.length, true)
  out.set(pcm16, 44)
  return out
}

// ---------------- sessão ----------------

export interface TranscribeSessionDeps {
  /** Relógio (testes); padrão `Date.now`. */
  now?: () => number
  /** Motor local injetado (fatia de modelos locais); sem ele, o modo 'local' falha legível. */
  local?: SttLocalBackend
  /** Recebe as parciais ao vivo (o IPC repassa em `voice:partial`). */
  onPartial?: (e: VoicePartialEvent) => void
}

export interface StartTranscribeOptions {
  /** Configuração de transcrição REAL (com a chave — nunca sai do main). */
  settings: SttSettings
  /** Idioma do áudio ('pt-BR' → 'pt' na API); ausente/vazio = detecção automática. */
  language?: string
}

export interface TranscribeSession {
  readonly id: string
  /** Acumula PCM16 mono little-endian a 16 kHz; `sampleRate` informado precisa casar. */
  push(chunk: Uint8Array, sampleRate?: number): void
  /** Encerra a captura e transcreve o buffer inteiro (final; `purpose: 'final'`). */
  stop(): Promise<VoiceTranscribeResult>
  /** Descarta tudo sem transcrever (idempotente). */
  cancel(): void
}

interface SessionState {
  id: string
  opts: StartTranscribeOptions
  now: () => number
  local?: SttLocalBackend
  onPartial?: (e: VoicePartialEvent) => void
  chunks: Uint8Array[]
  totalBytes: number
  /** Bytes já cobertos pelas parciais aceitas (o próximo pedaço recua `OVERLAP_BYTES`). */
  coveredBytes: number
  partialText: string
  /** Geração da última request disparada (resultados de gerações antigas expiram). */
  seq: number
  inFlight: { seq: number; controller: AbortController } | null
  lastFireAt: number
  status: 'active' | 'stopping' | 'ended' | 'cancelled'
  finalController: AbortController | null
}

interface SessionInternal {
  state: SessionState
  session: TranscribeSession
}

let current: SessionInternal | null = null

/** A sessão ativa (única por vez) — usada pelo IPC para validar o id de push/stop/cancel. */
export function activeTranscribeSession(): TranscribeSession | null {
  return current?.session ?? null
}

const notActive = (): Error =>
  new Error('A transcrição não está mais ativa (encerrada ou cancelada).')

function sliceBuffer(state: SessionState, start: number, end: number): Uint8Array {
  const out = new Uint8Array(end - start)
  let chunkStart = 0
  let written = 0
  for (const c of state.chunks) {
    const chunkEnd = chunkStart + c.length
    if (chunkEnd > start && chunkStart < end) {
      const from = Math.max(start, chunkStart) - chunkStart
      const to = Math.min(end, chunkEnd) - chunkStart
      out.set(c.subarray(from, to), written)
      written += to - from
    }
    chunkStart = chunkEnd
  }
  return out
}

const joinText = (a: string, b: string): string => [a, b].filter((x) => x.trim()).join(' ')

/**
 * Dispara a parcial quando o intervalo decorreu e há áudio novo: pedaço `[covered − sobreposição,
 * agora]` como wav, `purpose: 'partial'` via `chooseSttBackend` com `hasLocalReady: false` (o motor
 * local é outra fatia; no modo 'local' a parcial NÃO vai para a API). Melhor-esforço: aborta a
 * request em voo (a seguinte recobre o pedaço dela), resultados velhos expiram e erros de parcial
 * nunca interrompem a sessão.
 */
function maybeFirePartial(state: SessionState): void {
  if (state.status !== 'active') return
  const { settings } = state.opts
  if (!settings.livePartials) return
  if (chooseSttBackend(settings, { hasLocalReady: false, purpose: 'partial' }) !== 'api') return
  const now = state.now()
  if (now - state.lastFireAt < STT_PARTIAL_INTERVAL_MS) return
  const pieceEnd = state.totalBytes
  const pieceStart = Math.max(0, state.coveredBytes - OVERLAP_BYTES)
  if (pieceEnd - pieceStart <= 0) return

  state.lastFireAt = now
  state.inFlight?.controller.abort()
  const seq = ++state.seq
  const controller = new AbortController()
  state.inFlight = { seq, controller }
  const audio = sliceBuffer(state, pieceStart, pieceEnd)
  void transcribeAudio(
    {
      audio: encodeWav(audio, VOICE_SAMPLE_RATE),
      mimeType: 'audio/wav',
      fileName: 'partial'
    },
    { settings, language: state.opts.language, signal: controller.signal }
  )
    .then((r) => {
      // resultado velho (request abortada/superseded) expira; nunca entra na fila
      if (state.status !== 'active' || state.seq !== seq) return
      state.partialText = joinText(state.partialText, r.text)
      state.coveredBytes = pieceEnd
      state.onPartial?.({ sessionId: state.id, text: state.partialText, isFinal: false, ms: r.ms })
    })
    .catch(() => {
      /* melhor-esforço: abort/erro de parcial não interrompe a sessão (a final decide) */
    })
    .finally(() => {
      if (state.inFlight?.seq === seq) state.inFlight = null
    })
}

/**
 * Cria a sessão de transcrição (global, uma por vez). `push` acumula PCM16 mono 16 kHz; parciais
 * melhor-esforço saem por `onPartial`; `stop()` transcreve o buffer final (com fallback quando há
 * `local` injetado) e `cancel()` descarta tudo sem transcrever. Já há sessão → erro legível.
 */
export function startTranscribeSession(
  opts: StartTranscribeOptions,
  deps: TranscribeSessionDeps = {}
): TranscribeSession {
  if (current)
    throw new Error('Já há uma transcrição em andamento — pare ou cancele antes de iniciar outra.')
  const state: SessionState = {
    id: crypto.randomUUID(),
    opts,
    now: deps.now ?? Date.now,
    local: deps.local,
    onPartial: deps.onPartial,
    chunks: [],
    totalBytes: 0,
    coveredBytes: 0,
    partialText: '',
    seq: 0,
    inFlight: null,
    lastFireAt: (deps.now ?? Date.now)(),
    status: 'active',
    finalController: null
  }

  const end = (): void => {
    if (state.status !== 'cancelled') state.status = 'ended'
    if (current?.state === state) current = null
  }

  const session: TranscribeSession = {
    get id(): string {
      return state.id
    },
    push(chunk: Uint8Array, sampleRate?: number): void {
      if (state.status !== 'active') throw notActive()
      if (!(chunk instanceof Uint8Array))
        throw new Error('Áudio PCM inválido (esperado Uint8Array).')
      if (chunk.length % 2)
        throw new Error('Áudio PCM16 inválido (número ímpar de bytes — 2 bytes por amostra).')
      if (sampleRate !== undefined && sampleRate !== VOICE_SAMPLE_RATE)
        throw new Error(
          `A captura deve vir em PCM16 mono a ${VOICE_SAMPLE_RATE} Hz (recebido ${sampleRate} Hz).`
        )
      if (!chunk.length) return
      state.chunks.push(chunk)
      state.totalBytes += chunk.length
      maybeFirePartial(state)
    },
    async stop(): Promise<VoiceTranscribeResult> {
      if (state.status !== 'active') throw notActive()
      state.status = 'stopping'
      state.inFlight?.controller.abort()
      state.inFlight = null
      try {
        if (!state.totalBytes) {
          // nada capturado → texto vazio sem rede ("parar" sem falar não deve falhar)
          const backend = chooseSttBackend(state.opts.settings, {
            hasLocalReady: state.local?.ready === true
          })
          const local = state.opts.settings.local
          return {
            text: '',
            model:
              backend === 'local'
                ? local?.model || local?.engine || 'local'
                : state.opts.settings.api.model,
            baseUrl:
              backend === 'local'
                ? 'local'
                : state.opts.settings.api.baseUrl.trim().replace(/\/+$/, ''),
            ms: 0,
            backend,
            fellBack: false
          }
        }
        const controller = new AbortController()
        state.finalController = controller
        return await transcribeWithFallback(
          {
            audio: encodeWav(sliceBuffer(state, 0, state.totalBytes), VOICE_SAMPLE_RATE),
            mimeType: 'audio/wav',
            fileName: 'audio'
          },
          {
            settings: state.opts.settings,
            language: state.opts.language,
            local: state.local,
            signal: controller.signal
          }
        )
      } catch (e) {
        if (state.finalController?.signal.aborted) throw abortError()
        throw e
      } finally {
        end()
      }
    },
    cancel(): void {
      if (state.status === 'ended' || state.status === 'cancelled') return
      state.finalController?.abort()
      state.inFlight?.controller.abort()
      state.inFlight = null
      state.chunks = []
      state.totalBytes = 0
      state.coveredBytes = 0
      state.partialText = ''
      state.status = 'cancelled'
      end()
    }
  }

  current = { state, session }
  return session
}
