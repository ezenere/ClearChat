// Push-to-talk + auto-stop por silêncio (React): hook reutilizável sobre a captura (`capture.ts`).
// Recebe as `AudioInputSettings` do contrato (`src/shared/voice.ts`, sem alterá-lo) e expõe um
// estado ordeiro — um por vez: 'idle' | 'recording' | 'stopping' — com nível ao vivo para o
// `Waveform`. Consumido pelo ditado (`lib/voice/useDictation.ts`).
import { useCallback, useEffect, useRef, useState } from 'react'
import type { AudioInputSettings } from '@shared/voice'
import { captureErrorText } from '../voice/dictation'
import { AudioCapture } from './capture'
import { matchesHotkey, pttHotkeyProblem } from './hotkey'

export { matchesHotkey, parseHotkey, type Hotkey, type HotkeyEvent } from './hotkey'

/** Estado da captura do push-to-talk (um por vez). */
export type PushToTalkState = 'idle' | 'recording' | 'stopping'

/** Motivo do fim da captura (`unmount` = o componente saiu — quem consome deve DESCARTAR). */
export type StopReason = 'manual' | 'ptt-release' | 'silence' | 'device-lost' | 'unmount'

export interface UsePushToTalkOptions {
  /** Recebe os chunks de PCM16 (mono, 16 kHz) — o destino é a sessão de transcrição. */
  onPcmChunk?: (chunk: Int16Array) => void
  /** Chamado quando a captura termina (qualquer motivo). */
  onStopped?: (reason: StopReason) => void
  /** O microfone salvo não existe mais e a captura caiu no padrão do sistema. */
  onFallback?: () => void
  /**
   * Tecla do PTT suspensa (UI do ditado escondida/bloqueada: chamada de voz, pergunta/retry
   * pendente, host offline, Configurações abertas) — a tecla volta a ser uma tecla comum.
   */
  suspended?: boolean
  /** Limiar de silêncio (RMS); default documentado em `silence.ts` (`DEFAULT_SILENCE_THRESHOLD`). */
  silenceThreshold?: number
  /** Constraints extras do microfone (mescladas sobre `DEFAULT_AUDIO_TRACK_CONSTRAINTS`). */
  constraints?: MediaTrackConstraints
}

export interface PushToTalkControls {
  state: PushToTalkState
  /** Nível RMS ao vivo (0..1), para alimentar o `Waveform`. */
  level: number
  /** Último erro legível (permissão negada etc.); null sem erro. */
  error: string | null
  /** Dispensa o erro da captura. */
  clearError: () => void
  /** Inicia a captura (clique). Ignorado se já estiver gravando/parando. `settingsOverride`
   *  usa um valor fresco de `AudioInputSettings` nesta captura (sem esperar o re-render). */
  start: (settingsOverride?: AudioInputSettings) => Promise<void>
  /** Para a captura (motivo 'manual'). Idempotente. */
  stop: () => Promise<void>
  /** Clique: inicia se parado, para se gravando. */
  toggle: () => Promise<void>
}

/**
 * Push-to-talk sobre as settings de entrada de áudio:
 *
 * - **Clique**: `toggle()`/`start()`/`stop()` iniciam e encerram a captura.
 * - **Tecla do PTT** (`settings.pttKey`, ex.: 'Ctrl+Shift+Space'/'F8' — casamento em `matchesHotkey`):
 *   segurar inicia, soltar encerra. Só dispara com a janela em foco (listener no `window` +
 *   `document.hasFocus()`), e o `preventDefault` evita que a tecla caia no composer. Se a captura
 *   já estiver ativa por clique, a tecla não a encerra ao soltar.
 * - **Auto-stop por silêncio** (`settings.silenceStopMs`, quando `silenceStopEnabled`): o evento de
 *   silêncio da captura encerra a gravação; `silenceStopMs: 0` ignora o limite (nunca encerra).
 * - Microfone: `settings.deviceId` (null = padrão do sistema).
 */
export function usePushToTalk(
  settings: AudioInputSettings,
  options: UsePushToTalkOptions = {}
): PushToTalkControls {
  const [state, setState] = useState<PushToTalkState>('idle')
  const [level, setLevel] = useState(0)
  const [error, setError] = useState<string | null>(null)

  const captureRef = useRef<AudioCapture | null>(null)
  const busyRef = useRef(false)
  const pttHeldRef = useRef(false)
  const pttOwnsRef = useRef(false)
  const optionsRef = useRef(options)
  const startRef = useRef<(o?: AudioInputSettings) => Promise<void>>(async () => {})
  const stopRef = useRef<(reason: StopReason) => Promise<void>>(async () => {})

  const stopCapture = useCallback(async (reason: StopReason) => {
    const capture = captureRef.current
    if (!capture) return
    captureRef.current = null
    setState('stopping')
    try {
      await capture.stop()
    } catch {
      // liberação já feita — segue para o estado final
    }
    setLevel(0)
    setState('idle')
    optionsRef.current.onStopped?.(reason)
  }, [])

  const startCapture = useCallback(
    async (override?: AudioInputSettings) => {
      if (busyRef.current || captureRef.current) return
      busyRef.current = true
      setError(null)
      // settings desta captura: override do chamador (valor fresco) ou as props (hook)
      const s = override ?? settings
      const capture = new AudioCapture({
        constraints: optionsRef.current.constraints,
        silence:
          s.silenceStopEnabled && s.silenceStopMs > 0
            ? { silenceMs: s.silenceStopMs, threshold: optionsRef.current.silenceThreshold }
            : false
      })
      capture.on('level', (rms) => setLevel(rms))
      capture.on('pcm', (chunk) => optionsRef.current.onPcmChunk?.(chunk))
      capture.on('silence', () => void stopRef.current('silence'))
      capture.on('error', (e) => setError(captureErrorText(e)))
      capture.on('ended', () => {
        if (captureRef.current !== capture) return
        captureRef.current = null
        setLevel(0)
        setState('idle')
        optionsRef.current.onStopped?.('device-lost')
      })
      captureRef.current = capture
      try {
        await capture.start(s.deviceId)
        if (captureRef.current === capture) {
          setLevel(0)
          setState('recording')
          if (capture.fellBack) optionsRef.current.onFallback?.()
        }
      } catch (cause) {
        if (captureRef.current === capture) {
          captureRef.current = null
          setLevel(0)
          setState('idle')
          setError(captureErrorText(cause as Error))
        }
        // se o captureRef mudou, o stop() já cuidou do estado (start interrompido de propósito)
      } finally {
        busyRef.current = false
      }
    },
    [settings]
  )

  const toggle = useCallback(async () => {
    if (state === 'recording') await stopCapture('manual')
    else if (state === 'idle') await startCapture()
    // 'stopping': ignora o clique até a parada terminar
  }, [state, startCapture, stopCapture])

  // Callbacks mais recentes para os handlers de tecla/evitam stale closure.
  useEffect(() => {
    startRef.current = startCapture
    stopRef.current = stopCapture
    optionsRef.current = options
  }, [startCapture, stopCapture, options])

  // Tecla do PTT: segurar para falar (só com a janela em foco; listener no window).
  // tecla que digita sem modificador (gravada antes da validação) não vira PTT — engoliria a tecla
  const pttEnabled = settings.pttEnabled && !options.suspended
  const pttKey = settings.pttKey && !pttHotkeyProblem(settings.pttKey) ? settings.pttKey : null
  useEffect(() => {
    if (!pttEnabled || !pttKey) return
    const release = (): void => {
      if (!pttHeldRef.current) return
      pttHeldRef.current = false
      if (pttOwnsRef.current) {
        pttOwnsRef.current = false
        void stopRef.current('ptt-release')
      }
    }
    const down = (event: KeyboardEvent): void => {
      if (event.repeat || !document.hasFocus()) return
      if (!matchesHotkey(event, pttKey)) return
      event.preventDefault()
      if (pttHeldRef.current) return
      pttHeldRef.current = true
      // Só encerra ao soltar quem iniciou a captura (clique não é interrompido pelo PTT).
      if (!captureRef.current && !busyRef.current) {
        pttOwnsRef.current = true
        void startRef.current()
      }
    }
    const up = (event: KeyboardEvent): void => {
      if (!matchesHotkey(event, pttKey)) return
      event.preventDefault()
      release()
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', release)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', release)
      release()
    }
  }, [pttEnabled, pttKey])

  // Libera o microfone quando o componente desmonta (motivo 'unmount': quem consome descarta).
  useEffect(() => {
    return () => void stopRef.current('unmount')
  }, [])

  const clearError = useCallback(() => setError(null), [])

  return {
    state,
    level,
    error,
    clearError,
    start: startCapture,
    stop: () => stopCapture('manual'),
    toggle
  }
}
