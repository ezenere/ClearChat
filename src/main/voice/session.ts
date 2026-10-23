// Sessão de transcrição de voz (main, SEM Electron — testável): acumula o PCM16 mono 16 kHz do
// microfone, dispara parciais **melhor-esforço** a cada `STT_PARTIAL_INTERVAL_MS` (pedaços do
// acumulado com sobreposição de `STT_PARTIAL_OVERLAP_MS`, janela máxima `STT_PARTIAL_WINDOW_MS`;
// nunca com outra parcial em voo — sem fila e sem abortar-e-reenviar) e transcreve o buffer
// inteiro em `stop()` (final, via `transcribeWithFallback`; silêncio final longo aparado; acima
// do limite de upload da API vai em segmentos). `cancel()` descarta tudo sem transcrever. Uma
// sessão ATIVA por vez, com autocura: iniciar outra substitui a anterior; sessões de um renderer
// que recarregou/caiu são descartadas por `cancelTranscribeSessions(owner)`; sem PCM por 60 s a
// sessão se cancela. `encodeWav` monta o wav PCM enviado à API. Ver SPEC.md → "Áudio → Sessão de
// transcrição".
import type { VoicePartialEvent, VoiceTranscribeResult } from '@shared/ipc'
import type { SttLocalConfig, SttSettings } from '@shared/voice'
import { abortError } from '../tools/util'
import type { LocalModelInfo } from './models'
import {
  chooseSttBackend,
  isSttFallbackable,
  STT_PARTIAL_INTERVAL_MS,
  STT_PARTIAL_OVERLAP_MS,
  SttError,
  transcribeAudio,
  transcribeWithFallback,
  type SttFallbackResult,
  type SttLocalBackend,
  type TranscribeAudioInput
} from './stt'
import {
  createSttLocalBackend,
  engineUnavailableError,
  isSttEngineRuntimeAvailable,
  resolveSttModelsBaseDir
} from './sttLocal'
import { encodeWav } from './wav'

/** PCM16 mono a esta taxa (Hz): o formato do buffer da sessão e do wav enviado à API. */
export const VOICE_SAMPLE_RATE = 16_000
/** PCM16 mono: 2 bytes por amostra → bytes por ms. */
const BYTES_PER_MS = (VOICE_SAMPLE_RATE * 2) / 1000
/** Sobreposição entre pedaços consecutivos das parciais, em bytes de PCM. */
const OVERLAP_BYTES = Math.round(STT_PARTIAL_OVERLAP_MS * BYTES_PER_MS)

// ---------------- wav PCM (puro) ----------------

// `encodeWav` vive em `wav.ts` (sem dependências — usado também pelo processo do motor de TTS);
// reexportado aqui para os chamadores existentes.
export { encodeWav }

// ---------------- sessão ----------------

/**
 * `hasLocalReady` da sessão: há modelo de STT **instalado** para o engine escolhido em
 * `sttSettings.local` **e** o runtime deste engine é carregável nesta versão ("pronto = modelo
 * instalado + runtime", SPEC → "Áudio → Runtime local de STT")? Pura — o estado em disco vem de
 * `listLocalModels` (`'installed'` conta; `'corrupt'`/`'downloading'`/`'notInstalled'` não) e o
 * runtime de `isSttEngineRuntimeAvailable` (hoje só `whisper.cpp`; `vosk`/`nemotron` → false). A
 * semântica é por ENGINE (o modelo concreto a carregar é escolhido pelo runtime — ver
 * `resolveModelEntry` em `voice/sttLocal.ts`); `installed` em `sttSettings.local`/`ttsSettings.local`
 * é só um espelho da UI — a verdade é sempre o disco (SPEC → "Áudio → Componentes locais").
 */
export function deriveHasLocalReady(
  local: Pick<SttLocalConfig, 'engine'> | null,
  models: readonly LocalModelInfo[]
): boolean {
  if (!local) return false
  if (!isSttEngineRuntimeAvailable(local.engine)) return false
  return models.some(
    (m) => m.entry.kind === 'stt' && m.entry.engine === local.engine && m.state === 'installed'
  )
}

/**
 * Erro honesto quando o backend local é o escolhido mas não dá para transcrever: sem modelo
 * escolhido, engine sem motor de inferência nesta versão (os arquivos podem estar instalados — ver
 * `engineUnavailableError`), nada instalado para o engine ou arquivo ausente/corrompido. Todos os
 * casos mantêm a frase-âncora "motor local de transcrição não está pronto"; `kind: 'config'`
 * (nunca cai em fallback) e o conselho é usar o modo API.
 */
function localRuntimeError(
  local: Pick<SttLocalConfig, 'engine' | 'model'> | null,
  modelReady: boolean
): SttError {
  if (!local)
    return new SttError(
      'config',
      'motor local de transcrição não está pronto — nenhum modelo local configurado (escolha/baixe um modelo em Configurações → Áudio) ou use o modo API',
      { backend: 'local' }
    )
  if (!isSttEngineRuntimeAvailable(local.engine)) return engineUnavailableError(local.engine)
  return new SttError(
    'config',
    modelReady
      ? 'motor local de transcrição não está pronto — o arquivo do modelo local está ausente/corrompido (reinstale em Configurações → Áudio) ou use o modo API'
      : `motor local de transcrição não está pronto — nenhum modelo local instalado para o engine '${local.engine}' (baixe em Configurações → Áudio) ou use o modo API`,
    { backend: 'local' }
  )
}

/** Nota curta (pt-BR) do porquê não há fallback local (anexada ao erro da API no modo hybrid). */
function localFallbackNote(
  local: Pick<SttLocalConfig, 'engine'> | null,
  modelReady: boolean
): string {
  if (!local) return 'nenhum modelo local configurado'
  if (!isSttEngineRuntimeAvailable(local.engine))
    return `o engine '${local.engine}' ainda não tem motor de inferência nesta versão`
  if (!modelReady) return `nenhum modelo local instalado para o engine '${local.engine}'`
  return 'o modelo local não está pronto (arquivo ausente/corrompido — reinstale em Configurações → Áudio)'
}

export interface TranscribeSessionDeps {
  /** Relógio (testes); padrão `Date.now`. */
  now?: () => number
  /**
   * Motor local injetado; sem ele, a sessão cria o runtime padrão (`voice/sttLocal.ts`) para o
   * `settings.local` atual (modo 'local' sem motor pronto falha legível).
   */
  local?: SttLocalBackend
  /**
   * Modelo local instalado para o engine escolhido (`deriveHasLocalReady`); padrão false. O
   * backend local só está "pronto" (`hasLocalReady` de `chooseSttBackend`) quando isto E o runtime
   * (`local.ready`) valem — sem runtime, as parciais seguem pela API melhor-esforço e as
   * transcrições que exigem o motor local falham com erro `config` honesto.
   */
  hasLocalReady?: boolean
  /** Recebe as parciais ao vivo (o IPC repassa em `voice:partial`). */
  onPartial?: (e: VoicePartialEvent) => void
  /**
   * Dono da sessão (o IPC passa o id do `webContents` que a iniciou): `cancelTranscribeSessions`
   * descarta as sessões de um dono que recarregou/caiu/fechou.
   */
  ownerId?: number | string
  /** Sem PCM por este tempo → a sessão se cancela sozinha (padrão `STT_SESSION_IDLE_MS`; 0 = nunca). */
  idleTimeoutMs?: number
  /** Teto de áudio aceito por sessão em ms (padrão `STT_SESSION_MAX_MS`). */
  maxAudioMs?: number
  /** Teto do wav por request da final na API (padrão `STT_API_MAX_UPLOAD_BYTES`; testes). */
  apiMaxUploadBytes?: number
}

/** Sem PCM por 60 s com a sessão ativa = renderer sumiu/travou → cancelamento automático. */
export const STT_SESSION_IDLE_MS = 60_000
/** Janela máxima de áudio de uma parcial (~10 s): parciais nunca crescem com a gravação. */
export const STT_PARTIAL_WINDOW_MS = 10_000
/** Teto de áudio de uma sessão (30 min ≈ 57,6 MB de PCM); o excedente é descartado com aviso. */
export const STT_SESSION_MAX_MS = 30 * 60_000
/**
 * Limite de upload das APIs OpenAI-compatíveis (Groq/OpenAI: 25 MB por arquivo) com folga: a final
 * maior que isto vai em segmentos (cortados no trecho mais silencioso perto da fronteira) e os
 * textos são concatenados.
 */
export const STT_API_MAX_UPLOAD_BYTES = 24 * 1024 * 1024
/** Silêncio final acima disto é aparado antes da final (o whisper alucina em silêncio longo). */
export const STT_TRAILING_SILENCE_MS = 1_500
/** Quanto do silêncio final fica depois de aparar. */
const TRAILING_SILENCE_KEEP_MS = 400
/** RMS (PCM16) abaixo disto conta como silêncio (≈ −46 dBFS — conservador). */
const SILENCE_RMS = 164

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
  /**
   * Encerra a captura e transcreve o buffer inteiro (final; `purpose: 'final'`). Com
   * `reuseSpeculative` (o renderer garante que o usuário não voltou a falar depois da última
   * especulação) e uma especulação REUSÁVEL (mesmo backend da final), a transcrição especulativa
   * vira a final — sem 2ª chamada de STT.
   */
  stop(opts?: { reuseSpeculative?: boolean }): Promise<VoiceTranscribeResult>
  /**
   * Transcrição ESPECULATIVA de tudo o que já foi capturado, sem encerrar (fim de turno adaptativo
   * da chamada de voz): motor local quando pronto (modo local/híbrido); API só com `allowApi`
   * (modo api/híbrido sem motor). null = indisponível (o chamador usa o silêncio fixo).
   */
  speculate(opts?: { allowApi?: boolean }): Promise<VoiceSpeculativeResult | null>
  /** Descarta tudo sem transcrever (idempotente). */
  cancel(): void
}

/** Resultado de `speculate()`. */
export interface VoiceSpeculativeResult {
  text: string
  ms: number
  backend: 'api' | 'local'
  /** Pode virar a final (`stop({ reuseSpeculative })`) — mesmo backend que a final usaria. */
  reusable: boolean
}

interface SpeculationState {
  /** Bytes de PCM cobertos (o buffer inteiro no momento da especulação). */
  bytes: number
  backend: 'api' | 'local'
  reusable: boolean
  controller: AbortController
  promise: Promise<VoiceSpeculativeResult | null>
  /** Resultado (null = falhou/abortou). */
  result: VoiceSpeculativeResult | null
  done: boolean
}

interface SessionState {
  id: string
  opts: StartTranscribeOptions
  now: () => number
  local?: SttLocalBackend
  /** Modelo instalado para o engine escolhido (ver `deriveHasLocalReady`). */
  hasLocalReady: boolean
  onPartial?: (e: VoicePartialEvent) => void
  ownerId?: number | string
  chunks: Uint8Array[]
  totalBytes: number
  maxBytes: number
  /** O teto de áudio foi atingido (aviso emitido uma vez). */
  truncated: boolean
  /** Bytes já cobertos pelas parciais aceitas (o próximo pedaço recua `OVERLAP_BYTES`). */
  coveredBytes: number
  partialText: string
  /** Geração da última request disparada (resultados de gerações antigas expiram). */
  seq: number
  inFlight: { seq: number; controller: AbortController } | null
  lastFireAt: number
  /** Parciais desligadas no resto da sessão (auth/cota/config — o erro saiu uma vez). */
  partialsOff: boolean
  status: 'active' | 'stopping' | 'ended' | 'cancelled'
  finalController: AbortController | null
  idleMs: number
  idleTimer: ReturnType<typeof setTimeout> | null
  apiMaxUploadBytes: number
  /** Última transcrição especulativa (fim de turno adaptativo) — null = nenhuma. */
  spec: SpeculationState | null
}

interface SessionInternal {
  state: SessionState
  session: TranscribeSession
}

/** A sessão que recebe áudio (no máximo uma). */
let current: SessionInternal | null = null
/** Sessões vivas (a ativa + as que ainda transcrevem a final depois do `stop`). */
const live = new Set<SessionInternal>()

/** A sessão ativa (única por vez) — usada pelo IPC para validar o id de push/stop/cancel. */
export function activeTranscribeSession(): TranscribeSession | null {
  return current?.session ?? null
}

/** Sessão viva (ativa ou terminando a final) pelo id — o `stop` de uma sessão substituída ainda vale. */
export function findTranscribeSession(id: string): TranscribeSession | null {
  for (const s of live) if (s.state.id === id) return s.session
  return null
}

/**
 * Descarta (cancel — sem transcrever; a final em voo é abortada) as sessões vivas do dono
 * `ownerId` — ou todas, sem argumento. O IPC chama quando o renderer recarrega, cai ou a janela
 * fecha: a sessão do renderer que sumiu nunca mais recebe `stop`/`cancel`. Devolve quantas.
 */
export function cancelTranscribeSessions(ownerId?: number | string): number {
  let n = 0
  for (const s of [...live]) {
    if (ownerId !== undefined && s.state.ownerId !== ownerId) continue
    s.session.cancel()
    n++
  }
  return n
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

/** Erros de parcial que não melhoram tentando de novo (chave/cota/config) — desligam as parciais. */
const isPartialFatal = (e: unknown): boolean =>
  e instanceof SttError && (e.kind === 'auth' || e.kind === 'quota' || e.kind === 'config')

// ---------------- PCM: silêncio e segmentação (puros) ----------------

/** RMS (em unidades PCM16) de `[start, end)` amostras do PCM16 LE. */
function rmsOf(dv: DataView, start: number, end: number): number {
  let acc = 0
  for (let i = start; i < end; i++) {
    const v = dv.getInt16(i * 2, true)
    acc += v * v
  }
  return end > start ? Math.sqrt(acc / (end - start)) : 0
}

/**
 * Apara o silêncio no FIM do PCM16 mono quando ele passa de `STT_TRAILING_SILENCE_MS` (deixa
 * `TRAILING_SILENCE_KEEP_MS`): o auto-stop por silêncio grava segundos de nada no fim e o whisper
 * tende a alucinar ("Obrigado.") nesse trecho. Silêncio = quadros de 20 ms com RMS < ≈ −46 dBFS.
 */
export function trimTrailingSilence(pcm: Uint8Array, sampleRate = VOICE_SAMPLE_RATE): Uint8Array {
  const samples = pcm.length >> 1
  const frame = Math.max(1, Math.round(sampleRate / 50))
  const dv = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength)
  let end = samples
  while (end > 0) {
    const start = Math.max(0, end - frame)
    if (rmsOf(dv, start, end) >= SILENCE_RMS) break
    end = start
  }
  const silent = samples - end
  if (silent * 1000 < STT_TRAILING_SILENCE_MS * sampleRate) return pcm
  const keep = Math.round((TRAILING_SILENCE_KEEP_MS * sampleRate) / 1000)
  return pcm.subarray(0, Math.min(samples, end + keep) * 2)
}

/**
 * Corta o PCM16 em segmentos de no máximo `maxBytes` (pares), cada corte no quadro de 100 ms mais
 * silencioso dos últimos ~20 s antes da fronteira (para não partir palavras). Puro.
 */
export function splitPcmForUpload(
  pcm: Uint8Array,
  maxBytes: number,
  sampleRate = VOICE_SAMPLE_RATE
): Uint8Array[] {
  const max = Math.max(2, maxBytes - (maxBytes % 2))
  if (pcm.length <= max) return [pcm]
  const dv = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength)
  const frame = Math.max(1, Math.round(sampleRate / 10))
  const searchSamples = Math.min(Math.floor(max / 4), 20 * sampleRate)
  const out: Uint8Array[] = []
  let start = 0 // em amostras
  const total = pcm.length >> 1
  while ((total - start) * 2 > max) {
    const limit = start + (max >> 1)
    let best = limit
    let bestRms = Infinity
    for (
      let end = limit;
      end - frame >= limit - searchSamples && end - frame > start;
      end -= frame
    ) {
      const r = rmsOf(dv, end - frame, end)
      if (r < bestRms) {
        bestRms = r
        best = end - (frame >> 1)
      }
    }
    out.push(pcm.subarray(start * 2, best * 2))
    start = best
  }
  out.push(pcm.subarray(start * 2))
  return out
}

function emitPartial(state: SessionState, ms: number, error?: string): void {
  state.onPartial?.({
    sessionId: state.id,
    text: state.partialText,
    isFinal: false,
    ms,
    ...(error ? { error } : {})
  })
}

/**
 * Dispara a parcial quando o intervalo decorreu e há áudio novo: pedaço `[covered − sobreposição,
 * agora]` (no máximo `STT_PARTIAL_WINDOW_MS`) como wav, `purpose: 'partial'` via
 * `chooseSttBackend` com o runtime local pronto. Pela **API** (melhor-esforço) ou pelo **motor
 * local em janelas** (whisper.cpp até o `base` — `local.partials`). Sem motor pronto, parciais
 * locais não existem (o modo 'local' nunca vaza para a API). Melhor-esforço SEM fila: **nunca**
 * dispara com outra em voo (a seguinte recobre o pedaço dela quando a anterior voltar), resultados
 * velhos expiram e erros de parcial nunca interrompem a sessão — auth/cota/config desligam as
 * parciais pelo resto da sessão com UM aviso (`VoicePartialEvent.error`).
 */
function maybeFirePartial(state: SessionState): void {
  if (state.status !== 'active' || state.partialsOff || state.inFlight) return
  // especulação em voo usa o mesmo motor: a parcial espera (a especulação é mais urgente)
  if (state.spec && !state.spec.done) return
  const { settings } = state.opts
  if (!settings.livePartials) return
  // pronto = modelo instalado (hasLocalReady) E motor de inferência disponível (local.ready) — sem
  // runtime, as parciais continuam melhor-esforço na API (modo 'local' nunca vaza para a API)
  const localReady = state.hasLocalReady && state.local?.ready === true
  const chosen = chooseSttBackend(settings, { hasLocalReady: localReady, purpose: 'partial' })
  if (chosen === 'local' && (!localReady || state.local?.partials === false)) return
  const now = state.now()
  if (now - state.lastFireAt < STT_PARTIAL_INTERVAL_MS) return
  const pieceEnd = state.totalBytes
  const windowBytes = Math.round(STT_PARTIAL_WINDOW_MS * BYTES_PER_MS)
  const pieceStart = Math.max(0, state.coveredBytes - OVERLAP_BYTES, pieceEnd - windowBytes)
  if (pieceEnd - pieceStart <= 0) return

  state.lastFireAt = now
  const seq = ++state.seq
  const controller = new AbortController()
  state.inFlight = { seq, controller }
  const audio = sliceBuffer(state, pieceStart, pieceEnd)
  const input = {
    audio: encodeWav(audio, VOICE_SAMPLE_RATE),
    mimeType: 'audio/wav',
    fileName: 'partial'
  }
  const partial: Promise<{ text: string; ms: number }> =
    chosen === 'local'
      ? state.local!.transcribe(input, {
          language: state.opts.language,
          signal: controller.signal
        })
      : transcribeAudio(input, {
          settings,
          language: state.opts.language,
          signal: controller.signal
        })
  void partial
    .then((r) => {
      // resultado velho (sessão encerrada/abortada) expira; nunca entra na fila
      if (state.status !== 'active' || state.seq !== seq) return
      state.partialText = joinText(state.partialText, r.text)
      state.coveredBytes = pieceEnd
      emitPartial(state, r.ms)
    })
    .catch((e) => {
      // melhor-esforço: abort/erro de parcial não interrompe a sessão (a final decide); erro que
      // não melhora tentando de novo desliga as parciais (sem reenvio em loop) com um aviso
      if (controller.signal.aborted || state.status !== 'active') return
      if (isPartialFatal(e)) {
        state.partialsOff = true
        emitPartial(
          state,
          0,
          `Parciais ao vivo desligadas nesta gravação: ${e instanceof Error ? e.message : String(e)}`
        )
      }
    })
    .finally(() => {
      if (state.inFlight?.seq === seq) state.inFlight = null
    })
}

/**
 * Transcrição especulativa do buffer inteiro (fim de turno adaptativo): backend local quando o
 * motor está pronto (modos local/híbrido), API só com `allowApi` (modo api, ou híbrido sem motor);
 * senão null. Mesma especulação reaproveitada quando não chegou áudio novo; a anterior em voo é
 * abortada; a parcial em voo é abortada (mesmo motor — a especulação é mais urgente). Reusável como
 * final quando o backend é o mesmo que a final usaria (`chooseSttBackend` final). Nunca rejeita por
 * falha de STT (resolve null — o chamador cai no silêncio fixo).
 */
function startSpeculation(
  state: SessionState,
  allowApi: boolean
): Promise<VoiceSpeculativeResult | null> {
  const { settings } = state.opts
  const localReady = state.hasLocalReady && state.local?.ready === true
  let backend: 'local' | 'api' | null = null
  if (settings.mode === 'local') backend = localReady ? 'local' : null
  else if (settings.mode === 'hybrid') backend = localReady ? 'local' : allowApi ? 'api' : null
  else backend = allowApi ? 'api' : null
  if (!backend) return Promise.resolve(null)
  const prev = state.spec
  if (prev && prev.bytes === state.totalBytes && !prev.controller.signal.aborted)
    return prev.promise
  prev?.controller.abort()
  if (backend === 'local') {
    state.inFlight?.controller.abort()
    state.inFlight = null
  }
  const pcm = trimTrailingSilence(sliceBuffer(state, 0, state.totalBytes))
  if (!pcm.length || pcm.length + 44 > state.apiMaxUploadBytes) return Promise.resolve(null)
  const finalBackend = chooseSttBackend(settings, { hasLocalReady: localReady })
  const controller = new AbortController()
  const input = {
    audio: encodeWav(pcm, VOICE_SAMPLE_RATE),
    mimeType: 'audio/wav',
    fileName: 'audio'
  }
  const run: Promise<{ text: string; ms: number }> =
    backend === 'local'
      ? state.local!.transcribe(input, { language: state.opts.language, signal: controller.signal })
      : transcribeAudio(input, {
          settings,
          language: state.opts.language,
          signal: controller.signal
        })
  const spec: SpeculationState = {
    bytes: state.totalBytes,
    backend,
    reusable: finalBackend === backend,
    controller,
    promise: Promise.resolve(null),
    result: null,
    done: false
  }
  spec.promise = run
    .then((r) => {
      if (controller.signal.aborted) return null
      spec.result = { text: r.text.trim(), ms: r.ms, backend, reusable: spec.reusable }
      return spec.result
    })
    .catch(() => null)
    .finally(() => {
      spec.done = true
    })
  state.spec = spec
  return spec.promise
}

function clearIdle(state: SessionState): void {
  if (state.idleTimer) clearTimeout(state.idleTimer)
  state.idleTimer = null
}

function armIdle(state: SessionState, session: TranscribeSession): void {
  clearIdle(state)
  if (!state.idleMs || state.status !== 'active') return
  state.idleTimer = setTimeout(() => {
    state.idleTimer = null
    if (state.status !== 'active') return
    console.warn(
      `[clearchat] transcrição ${state.id} sem áudio há ${Math.round(state.idleMs / 1000)} s — cancelada`
    )
    session.cancel()
  }, state.idleMs)
  state.idleTimer.unref?.()
}

/** Transcreve a final em segmentos que cabem no upload da API e concatena (sequencial). */
async function transcribeFinal(
  state: SessionState,
  pcm: Uint8Array,
  signal: AbortSignal
): Promise<SttFallbackResult> {
  const maxPcm = state.apiMaxUploadBytes - 44
  const segments = splitPcmForUpload(pcm, maxPcm)
  const opts = {
    settings: state.opts.settings,
    language: state.opts.language,
    local: state.local,
    signal
  }
  const toInput = (seg: Uint8Array, i: number): TranscribeAudioInput => ({
    audio: encodeWav(seg, VOICE_SAMPLE_RATE),
    mimeType: 'audio/wav',
    fileName: segments.length > 1 ? `audio-${i + 1}` : 'audio'
  })
  if (segments.length === 1) return transcribeWithFallback(toInput(segments[0], 0), opts)
  const parts: SttFallbackResult[] = []
  for (let i = 0; i < segments.length; i++) {
    if (signal.aborted) throw abortError()
    parts.push(await transcribeWithFallback(toInput(segments[i], i), opts))
  }
  const last = parts[parts.length - 1]
  const fell = parts.find((p) => p.fellBack)
  return {
    ...last,
    text: parts
      .map((p) => p.text.trim())
      .filter(Boolean)
      .join(' '),
    ms: parts.reduce((a, p) => a + p.ms, 0),
    fellBack: !!fell,
    ...(fell?.fallbackReason ? { fallbackReason: fell.fallbackReason } : {})
  }
}

/**
 * Cria a sessão de transcrição (uma ativa por vez). `push` acumula PCM16 mono 16 kHz; parciais
 * melhor-esforço saem por `onPartial`; `stop()` transcreve o buffer final (com fallback quando há
 * `local` injetado) e `cancel()` descarta tudo sem transcrever. **Autocura**: uma sessão ativa
 * anterior é cancelada e substituída (o renderer que a abriu desistiu dela — recarregou, caiu ou
 * perdeu o id); uma anterior que já está transcrevendo a final (`stop` em voo) segue até o fim.
 * Sem PCM por `idleTimeoutMs` (60 s) a sessão se cancela sozinha.
 */
export function startTranscribeSession(
  opts: StartTranscribeOptions,
  deps: TranscribeSessionDeps = {}
): TranscribeSession {
  if (current) {
    const prev = current
    current = null
    if (prev.state.status === 'active') {
      console.warn(`[clearchat] transcrição ${prev.state.id} substituída por uma nova — cancelada`)
      prev.session.cancel()
    }
  }
  const maxAudioMs = deps.maxAudioMs ?? STT_SESSION_MAX_MS
  const state: SessionState = {
    id: crypto.randomUUID(),
    opts,
    now: deps.now ?? Date.now,
    // sem injeção (produção/testes de integração): o runtime local padrão para o engine/modelo
    // escolhidos em `settings.local` (`voice/sttLocal.ts`; baseDir = userData, lazy)
    local:
      deps.local ??
      createSttLocalBackend({
        baseDir: resolveSttModelsBaseDir(),
        selection: opts.settings.local
      }),
    hasLocalReady: deps.hasLocalReady === true,
    onPartial: deps.onPartial,
    ownerId: deps.ownerId,
    chunks: [],
    totalBytes: 0,
    maxBytes: Math.max(0, Math.round(maxAudioMs * BYTES_PER_MS)) & ~1,
    truncated: false,
    coveredBytes: 0,
    partialText: '',
    seq: 0,
    inFlight: null,
    lastFireAt: (deps.now ?? Date.now)(),
    partialsOff: false,
    status: 'active',
    finalController: null,
    idleMs: deps.idleTimeoutMs ?? STT_SESSION_IDLE_MS,
    idleTimer: null,
    apiMaxUploadBytes: Math.max(1024, deps.apiMaxUploadBytes ?? STT_API_MAX_UPLOAD_BYTES),
    spec: null
  }

  const end = (): void => {
    if (state.status !== 'cancelled') state.status = 'ended'
    clearIdle(state)
    if (current?.state === state) current = null
    live.delete(internal)
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
      armIdle(state, session)
      if (!chunk.length) return
      const room = state.maxBytes - state.totalBytes
      if (room <= 0 || chunk.length > room) {
        if (room > 0) {
          state.chunks.push(chunk.slice(0, room))
          state.totalBytes += room
        }
        if (!state.truncated) {
          state.truncated = true
          emitPartial(
            state,
            0,
            `Gravação atingiu o limite de ${Math.round(state.maxBytes / BYTES_PER_MS / 60_000)} min — o áudio depois disso não será transcrito; pare para transcrever.`
          )
        }
        return
      }
      state.chunks.push(chunk)
      state.totalBytes += chunk.length
      maybeFirePartial(state)
    },
    speculate(opts?: { allowApi?: boolean }): Promise<VoiceSpeculativeResult | null> {
      if (state.status !== 'active') return Promise.reject(notActive())
      return startSpeculation(state, !!opts?.allowApi)
    },
    async stop(opts?: { reuseSpeculative?: boolean }): Promise<VoiceTranscribeResult> {
      if (state.status !== 'active') throw notActive()
      state.status = 'stopping'
      clearIdle(state)
      if (current?.state === state) current = null // a vaga de captura já fica livre
      state.inFlight?.controller.abort()
      state.inFlight = null
      const spec = state.spec
      if (opts?.reuseSpeculative && spec?.reusable) {
        // o usuário não voltou a falar depois da especulação: ela É a final (sem 2ª chamada)
        const r = await spec.promise.catch(() => null)
        if (r && (state.status as string) !== 'cancelled') {
          end()
          const local = state.opts.settings.local
          return {
            text: r.text,
            model:
              r.backend === 'local'
                ? local?.model || local?.engine || 'local'
                : state.opts.settings.api.model,
            baseUrl:
              r.backend === 'local'
                ? 'local'
                : state.opts.settings.api.baseUrl.trim().replace(/\/+$/, ''),
            ms: r.ms,
            backend: r.backend,
            fellBack: false,
            speculative: true
          }
        }
      }
      spec?.controller.abort()
      try {
        const pcm = trimTrailingSilence(sliceBuffer(state, 0, state.totalBytes))
        if (!pcm.length) {
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
        const runtimeReady = state.local?.ready === true
        // sem motor pronto, o backend local não tem como transcrever: erro `config` honesto (o
        // modelo pode estar instalado) em vez de falha genérica no fim
        if (
          !runtimeReady &&
          chooseSttBackend(state.opts.settings, { hasLocalReady: false }) === 'local'
        )
          throw localRuntimeError(state.opts.settings.local, state.hasLocalReady)
        return await transcribeFinal(state, pcm, controller.signal)
      } catch (e) {
        if (state.finalController?.signal.aborted || (state.status as string) === 'cancelled')
          throw abortError()
        // hybrid com o fallback local bloqueado (modelo/engine/runtime): a anotação conta a
        // verdade junto do erro da API em vez de deixar o fallback "sumir" em silêncio
        if (
          state.opts.settings.mode === 'hybrid' &&
          state.opts.settings.local &&
          state.local?.ready !== true &&
          isSttFallbackable(e)
        ) {
          const msg = e instanceof Error ? e.message : String(e)
          throw new SttError(
            'config',
            `${msg} — sem fallback local: ${localFallbackNote(state.opts.settings.local, state.hasLocalReady)}`,
            { backend: 'local', cause: e }
          )
        }
        throw e
      } finally {
        end()
      }
    },
    cancel(): void {
      if (state.status === 'ended' || state.status === 'cancelled') return
      state.finalController?.abort()
      state.spec?.controller.abort()
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

  const internal: SessionInternal = { state, session }
  current = internal
  live.add(internal)
  armIdle(state, session)
  return session
}
