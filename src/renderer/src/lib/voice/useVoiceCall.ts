// Chamada de voz (renderer): o "sensor" do turno — captura contínua (`AudioCapture`, constraints
// com `echoCancellation: true`), fala do usuário por janelas (`UtteranceGate`: início/fim por
// silêncio, base em `audioInput.silenceStopMs` via `resolveTurnSilenceMs`), uma sessão de
// transcrição por fala (`voice:transcribe:*`, serializadas numa cadeia) e a reprodução da resposta
// (`UtteranceQueue`, utterances `voice:call:utterance` na ordem, sem sobreposição).
//
// Os eventos de fronteira vão ao main pelos canais `voice:call:*` (o main é o dono do turno e do
// envio): `speech-begin`/`speech-end` → `turn(text)` com a transcrição final. Fala do usuário
// durante a reprodução: curta (≤ `BACKCHANNEL_MAX_MS`) = backchannel (só registra — não cancela
// nem vira turno); longa = barge-in (cancela a fala do assistente, como sempre). Pausas na fala
// do usuário viram observações de interjeição (`interjectionObserved` — a política decide no main).
// Mudo = captura pausada (microfone liberado). Build de dev com `VITE_CLEAR_MOCK=1`: sem captura
// (o mock `voice` emite os estados/utterances e o `Waveform` simula os níveis; `__clearMockMic`
// simula falhas do microfone).
//
// O estado de runtime (nível, erro, volume, clipes) é publicado em `useVoiceCallRuntime` — o dock
// vive na coluna do composer e só lê de lá. Falha ao abrir o microfone ENCERRA a chamada; como o
// dock some junto, o motivo vai para um toast (visível em qualquer tela).
import { useCallback, useEffect, useRef } from 'react'
import type { VoiceCallTimelineEvent } from '@shared/ipc'
import {
  DEFAULT_INTERJECTION_POLICY,
  resolveVoiceCallConfig,
  type InterjectionPolicy
} from '@shared/voice'
import { INTERJECTION_TAIL_CHARS, InterjectionWatcher, PlaybackHold } from '@shared/voicePolicy'
import { DEFAULT_SILENCE_THRESHOLD } from '../audio/silence'
import { AudioCapture } from '../audio/capture'
import { api, errorMessage } from '../api'
import { useStore } from '../../store'
import { captureErrorText, MIC_FALLBACK_NOTICE } from './dictation'
import { UtteranceGate } from './utteranceGate'
import { UtteranceQueue } from './utteranceQueue'
import { useVoiceCallRuntime } from './voiceCallRuntime'
import { loadVoiceSettings } from './voiceSettings'

const MOCK = import.meta.env.VITE_CLEAR_MOCK === '1'
/** Duração do quadro de nível RMS (ms) — `AudioCapture` emite ~30 Hz (`DEFAULT_LEVEL_MS`). */
const FRAME_MS = 33
/** Pre-roll da fala (chunks PCM mantidos antes do início) — não corta o onset (~300 ms). */
const PREROLL_MAX = 3

const setLevel = (level: number): void => useVoiceCallRuntime.setState({ level })
const setError = (error: string | null): void => useVoiceCallRuntime.setState({ error })

/** Mock de UI: falha simulada do microfone (`window.__clearMockMic`, definido pelo cenário). */
function mockMicMode(): string {
  return (window as unknown as { __clearMockMic?: string }).__clearMockMic ?? 'ok'
}

/** Recarrega o estado dos clipes de interjeição/filler da voz atual. */
async function refreshClips(): Promise<void> {
  const v = api.voice
  if (!v) return
  try {
    const m = await v.tts.clips.list()
    useVoiceCallRuntime.setState({ clips: m && m.clips.length > 0 ? 'ok' : 'missing' })
  } catch {
    useVoiceCallRuntime.setState({ clips: 'unknown' })
  }
}

/**
 * Controller da chamada (montado UMA vez — `VoiceCallController` em `App`): captura, porta de fala,
 * transcrição e reprodução. Publica nível/erro/volume/clipes e as ações em `useVoiceCallRuntime`.
 */
export function useVoiceCall(): void {
  const active = useStore((s) => s.voiceCall.active)
  const turnSilenceMs = useStore((s) => s.voiceCall.turnSilenceMs)
  const muted = useStore((s) => s.voiceCall.muted)
  const volume = useVoiceCallRuntime((s) => s.volume)

  const queueRef = useRef<UtteranceQueue | null>(null)
  const gateRef = useRef<UtteranceGate | null>(null)
  const captureRef = useRef<AudioCapture | null>(null)
  const sessionRef = useRef<string | null>(null)
  const sessionPendingRef = useRef<Promise<string | null> | null>(null)
  /** Toda a lógica de sessão (push/stop/turn) serializada — sessões nunca se cruzam. */
  const chainRef = useRef<Promise<void>>(Promise.resolve())
  /** Fala em curso (utterance aberto): chunks vão para a sessão; senão ficam no pre-roll. */
  const speakingRef = useRef(false)
  const prerollRef = useRef<Uint8Array[]>([])
  /** Política de interjeições resolvida (persona→chat→global) do chat da chamada. */
  const policyRef = useRef<InterjectionPolicy>(DEFAULT_INTERJECTION_POLICY)
  /** Detector de pausas na fala do usuário (observações → política de interjeições no main). */
  const watcherRef = useRef<InterjectionWatcher | null>(null)
  /** Fala do usuário durante a reprodução: backchannel (curta) × barge-in (longa). */
  const holdRef = useRef<PlaybackHold | null>(null)
  /** Cauda da transcrição parcial ao vivo (escolhe a classe da interjeição). */
  const partialRef = useRef('')

  const voice = api.voice

  // ---- sessão de transcrição da fala atual (uma por utterance) ----
  const ensureSession = useCallback((): Promise<string | null> => {
    sessionPendingRef.current ??= (async () => {
      const v = api.voice
      if (!v) return null
      try {
        const id = await v.transcribe.start()
        sessionRef.current = id
        return id
      } catch (err) {
        setError(errorMessage(err))
        return null
      }
    })()
    return sessionPendingRef.current
  }, [])

  const pushChunk = useCallback(
    (bytes: Uint8Array): void => {
      chainRef.current = chainRef.current
        .then(async () => {
          const v = api.voice
          if (!v || !speakingRef.current) return
          const id = await ensureSession()
          if (!v || !id) return
          await v.transcribe.push(id, bytes)
        })
        .catch(() => {
          // falha de push: a finalização da fala reporta o erro (evita unhandled rejection)
        })
    },
    [ensureSession]
  )

  /** Fim da fala: `speech-end` + transcrição final → `voice:call:turn` (texto pode ser vazio). */
  const endUtterance = useCallback((): void => {
    void api.voice?.call.speechEnd().catch(() => {})
    chainRef.current = chainRef.current
      .then(async () => {
        const v = api.voice
        if (!v) return
        const pending = sessionPendingRef.current
        sessionPendingRef.current = null
        const id = pending ? await pending : sessionRef.current
        sessionRef.current = null
        if (!id) {
          await v.call.turn({ text: '' }).catch(() => {})
          return
        }
        try {
          const result = await v.transcribe.stop(id)
          await v.call.turn({ text: result.text })
        } catch (err) {
          setError(errorMessage(err))
          await v.call.turn({ text: '' }).catch(() => {})
        }
      })
      .catch(() => {})
  }, [])

  const dropSession = useCallback((): void => {
    chainRef.current = chainRef.current
      .then(async () => {
        const v = api.voice
        const pending = sessionPendingRef.current
        sessionPendingRef.current = null
        const id = pending ? await pending : sessionRef.current
        sessionRef.current = null
        if (v && id) await v.transcribe.cancel(id).catch(() => {})
      })
      .catch(() => {})
  }, [])

  // ---- chamada nova: limpa o erro anterior e confere os clipes (CTA "Gerar clipes" no dock) ----
  useEffect(() => {
    if (!active) return
    setError(null)
    void refreshClips()
  }, [active])

  // ---- reprodução das utterances (na ordem; `idle` → playback-idle ao main) ----
  const volumeRef = useRef(volume)
  useEffect(() => {
    volumeRef.current = volume
  }, [volume])
  // parciais ao vivo: a cauda do texto escolhe a classe da interjeição (SPEC → "Interjeições")
  useEffect(() => {
    const off = api.onVoicePartial?.((e) => {
      partialRef.current = typeof e.text === 'string' ? e.text : ''
    })
    return () => off?.()
  }, [])
  useEffect(() => {
    if (!active || !voice) return
    const queue = new UtteranceQueue({
      onState: (state) => {
        if (state === 'idle') void api.voice?.call.playbackIdle().catch(() => {})
      },
      // início/fim de cada reprodução entra na timeline da chamada (métricas decisão→áudio)
      onItem: ({ item, phase }) => {
        const kind: VoiceCallTimelineEvent['kind'] =
          item.kind === 'sentence'
            ? phase === 'start'
              ? 'sentence-start'
              : 'sentence-end'
            : phase === 'start'
              ? 'clip-start'
              : 'clip-end'
        useStore.getState().pushVoiceCallTimeline({ ts: Date.now(), kind, id: item.id })
      }
    })
    queueRef.current = queue
    queue.setVolume(volumeRef.current)
    const off = api.onVoiceCallUtterance?.((e) => queue.enqueue(e))
    // filler interrompido pela 1ª sentença (ou reset/stop): cancela SÓ essa utterance
    const offCancel = api.onVoiceCallUtteranceCancel?.((e) => queue.drop(e.id))
    return () => {
      off?.()
      offCancel?.()
      queue.cancel()
      queueRef.current = null
    }
  }, [active, voice])

  // ---- captura contínua + porta de fala (turnos por silêncio) ----
  useEffect(() => {
    if (!active || !voice) return
    const gate = new UtteranceGate({
      threshold: DEFAULT_SILENCE_THRESHOLD,
      silenceMs: turnSilenceMs
    })
    gateRef.current = gate

    // atos de fala curta: pausas viram observações de interjeição; fala durante a reprodução é
    // backchannel (curta) ou barge-in (longa) — `InterjectionWatcher`/`PlaybackHold` puros
    const watcher = new InterjectionWatcher(DEFAULT_INTERJECTION_POLICY.minPauseMs)
    const hold = new PlaybackHold()
    watcherRef.current = watcher
    holdRef.current = hold
    // política resolvida do chat da chamada (persona→chat→global) — habilita e define minPauseMs
    let disposed = false
    void loadVoiceSettings()
      .then((all) => {
        if (disposed) return
        const chatCfg =
          useStore.getState().chats.find((c) => c.id === useStore.getState().voiceCall.chatId)
            ?.config.voice ?? null
        const resolved = resolveVoiceCallConfig(chatCfg, all.voiceCallDefaults)
        policyRef.current = resolved.interjections
        watcherRef.current = new InterjectionWatcher(resolved.interjections.minPauseMs)
      })
      .catch(() => void 0)

    const onLevel = (rms: number): void => {
      setLevel(rms)
      const ev = gate.push(rms, FRAME_MS)
      if (ev === 'start') {
        const queue = queueRef.current
        const queueBusy = queue?.state === 'playing' || (queue?.pending ?? 0) > 0
        const mainSpeaking = useStore.getState().voiceCall.phase === 'speaking'
        if (queue && (queueBusy || mainSpeaking)) {
          // fala do usuário durante a reprodução: backchannel (curta) × barge-in (longa) —
          // nada é cancelado até a fala detectada passar de `BACKCHANNEL_MAX_MS`
          hold.start(rms, FRAME_MS, DEFAULT_SILENCE_THRESHOLD)
        } else {
          void api.voice?.call.speechBegin().catch(() => {})
        }
        speakingRef.current = true
        for (const bytes of prerollRef.current.splice(0)) pushChunk(bytes)
        watcherRef.current?.reset()
        return
      }
      if (ev === 'end') {
        speakingRef.current = false
        prerollRef.current = []
        const holdMs = hold.speechMs
        const kind = hold.end()
        if (kind === 'backchannel') {
          // backchannel do usuário ("uhum", "sim"): NÃO cancela a resposta nem vira turno
          dropSession()
          void api.voice?.call.backchannel({ ms: holdMs }).catch(() => {})
        } else {
          endUtterance()
        }
        watcherRef.current?.reset()
        return
      }
      if (hold.open) {
        if (hold.frame(rms, FRAME_MS, DEFAULT_SILENCE_THRESHOLD) === 'barge-in') {
          // barge-in real (fala longa): cancela a fala do assistente (texto segue no histórico)
          queueRef.current?.cancel()
          void api.voice?.call.bargeIn().catch(() => {})
        }
        return
      }
      if (!speakingRef.current) return
      const obs = watcherRef.current?.push(rms, FRAME_MS, DEFAULT_SILENCE_THRESHOLD, Date.now())
      if (obs) {
        // pausa na fala do usuário virou observação → a política decide (main) e a timeline registra
        useStore.getState().pushVoiceCallTimeline({
          ts: Date.now(),
          kind: 'pause',
          pauseMs: obs.pauseMs,
          speechMs: obs.speechMs
        })
        if (policyRef.current.enabled) {
          void api.voice?.call
            .interjectionObserved({
              speechMs: obs.speechMs,
              pauseMs: obs.pauseMs,
              tail: partialRef.current.slice(-INTERJECTION_TAIL_CHARS),
              observedAt: obs.observedAt
            })
            .catch(() => {})
        }
      }
    }
    const onPcm = (chunk: Int16Array): void => {
      const bytes = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
      if (speakingRef.current) {
        pushChunk(bytes)
        return
      }
      const preroll = prerollRef.current
      preroll.push(bytes)
      if (preroll.length > PREROLL_MAX) preroll.shift()
    }

    /** A chamada acabou porque o microfone falhou: o dock some junto, então o motivo vira toast. */
    const failCall = (message: string): void => {
      setError(message)
      useStore.getState().toast(`Chamada de voz encerrada: ${message}`, 'error')
      void useStore.getState().stopVoiceCall()
    }

    if (MOCK) {
      // sem microfone no mock: os estados/utterances vêm do binding `voice` simulado
      const mode = mockMicMode()
      if (!muted && (mode === 'denied' || mode === 'none' || mode === 'busy')) {
        const name =
          mode === 'denied'
            ? 'NotAllowedError'
            : mode === 'none'
              ? 'NotFoundError'
              : 'NotReadableError'
        failCall(captureErrorText({ name, message: '' }))
      }
      return () => {
        disposed = true
        gateRef.current = null
      }
    }

    const startCapture = async (): Promise<void> => {
      // settings frescas (microfone) ANTES de abrir — a limpeza do efeito pode chegar no meio
      const all = await loadVoiceSettings()
      if (disposed) return
      const capture = new AudioCapture({ silence: false })
      captureRef.current = capture
      capture.on('level', onLevel)
      capture.on('pcm', onPcm)
      capture.on('error', (e) => setError(captureErrorText(e)))
      capture.on('ended', () => {
        // microfone desconectado: encerra a chamada (o main volta ao repouso) e avisa
        if (captureRef.current !== capture) return
        captureRef.current = null
        failCall('o microfone foi desconectado.')
      })
      try {
        await capture.start(all.audioInput.deviceId)
        if (disposed) {
          void capture.stop().catch(() => {})
          return
        }
        if (capture.fellBack) useStore.getState().toast(MIC_FALLBACK_NOTICE, 'info')
      } catch (cause) {
        if (captureRef.current === capture) captureRef.current = null
        // limpeza do efeito (mudo, troca de silêncio, fim da chamada) interrompeu o start: normal
        if (disposed) return
        failCall(captureErrorText(cause as Error))
      }
    }
    if (!muted) void startCapture()

    return () => {
      disposed = true
      gateRef.current = null
      speakingRef.current = false
      prerollRef.current = []
      gate.reset()
      hold.reset()
      watcherRef.current = null
      holdRef.current = null
      dropSession()
      const capture = captureRef.current
      captureRef.current = null
      if (capture) void capture.stop().catch(() => {})
    }
  }, [active, voice, turnSilenceMs, muted, pushChunk, endUtterance, dropSession])

  const toggleMute = useCallback(async (): Promise<void> => {
    const next = !useStore.getState().voiceCall.muted
    if (next) {
      // captura pausada: microfone liberado; a fala em curso é descartada
      speakingRef.current = false
      prerollRef.current = []
      gateRef.current?.reset()
      holdRef.current?.reset()
      dropSession()
      const capture = captureRef.current
      captureRef.current = null
      if (capture) await capture.stop().catch(() => {})
    }
    // (des)mudo: a captura liga/desliga pelo efeito acima, que reage a `voiceCall.muted`
    await useStore.getState().setVoiceCallMuted(next)
    setLevel(0)
  }, [dropSession])

  const setVolume = useCallback((v: number): void => {
    const value = Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1
    useVoiceCallRuntime.setState({ volume: value })
    queueRef.current?.setVolume(value)
  }, [])

  const clearError = useCallback((): void => setError(null), [])

  /** "Gerar clipes" do dock: mesmos clipes de Configurações → Áudio (voz atual), com progresso. */
  const generateClips = useCallback(async (): Promise<void> => {
    const v = api.voice
    if (!v) return
    useVoiceCallRuntime.setState({ clips: 'generating', clipsProgress: { done: 0, total: 0 } })
    const off = api.onVoiceTtsClipsProgress?.((e) =>
      useVoiceCallRuntime.setState({ clipsProgress: { done: e.done, total: e.total } })
    )
    try {
      const m = await v.tts.clips.generate()
      useVoiceCallRuntime.setState({ clips: m.clips.length > 0 ? 'ok' : 'missing' })
    } catch (err) {
      useVoiceCallRuntime.setState({ clips: 'missing' })
      setError(`Não foi possível gerar os clipes de voz: ${errorMessage(err)}`)
    } finally {
      off?.()
      useVoiceCallRuntime.setState({ clipsProgress: null })
    }
  }, [])

  useEffect(() => {
    useVoiceCallRuntime.setState({ toggleMute, setVolume, clearError, generateClips })
  }, [toggleMute, setVolume, clearError, generateClips])
}
