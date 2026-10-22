// Ditado por voz (renderer): orquestra a sessão de transcrição (`window.api.voice`) sobre a captura
// (`usePushToTalk` → `AudioCapture`) e as parciais ao vivo (`onVoicePartial`). Um fluxo por vez:
// clique/tecla do PTT inicia, `stop()` (ou soltar a tecla/silêncio) transcreve e devolve o texto
// final via `onFinal` (o envio é sempre manual — este hook nunca envia mensagem).
//
// A sessão de transcrição é criada de forma preguiçosa no primeiro chunk (a tecla do PTT inicia a
// captura dentro do `usePushToTalk`, sem passar pelo `start()` daqui); os chunks esperam a sessão
// numa cadeia de promises (push em ordem) e o `stop` espera a cadeia antes de transcrever.
//
// Build de desenvolvimento com `VITE_CLEAR_MOCK=1`: sem captura (não há microfone no mock) — o
// binding `voice` do mock emite as parciais e devolve o texto fixo; o `Waveform` simula os níveis.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AudioInputSettings } from '@shared/voice'
import { DEFAULT_AUDIO_INPUT } from '@shared/voice'
import type { VoiceApi } from '@shared/ipc'
import { api, errorMessage } from '../api'
import { useStore } from '../../store'
import { usePushToTalk, type StopReason } from '../audio/usePushToTalk'
import { captureErrorText } from './dictation'

export type { StopReason } from '../audio/usePushToTalk'

/** Estado do ditado na UI (um por vez). */
export type DictationState = 'idle' | 'starting' | 'recording' | 'stopping'

const MOCK = import.meta.env.VITE_CLEAR_MOCK === '1'

export interface UseDictationOptions {
  /** Texto final transcrito (rascunho normal editável). Nunca é enviado automaticamente. */
  onFinal: (text: string) => void
}

export interface DictationControls {
  state: DictationState
  /** Nível RMS ao vivo (0..1) para o `Waveform`. */
  level: number
  /** Parcial ao vivo acumulada (melhor-esforço); '' = nenhuma. */
  partial: string
  clearPartial: () => void
  /** Erro legível (permissão negada, mic indisponível, STT fora do ar); null = sem erro. */
  error: string | null
  clearError: () => void
  /** Settings de entrada de áudio usadas na próxima gravação (padrões enquanto carrega). */
  settings: AudioInputSettings
  /** Grava um patch de `audioInput` (ex.: microfone do menu) e atualiza o estado local. */
  updateSettings: (patch: Partial<AudioInputSettings>) => Promise<void>
  /** Recarrega `audioInput` do main (chamado quando as Configurações fecham). */
  reload: () => void
  /** `window.api.voice` existe (sem ele o botão de microfone não aparece). */
  available: boolean
  start: () => Promise<void>
  /** Para e transcreve (texto final → `onFinal`). */
  stop: () => Promise<void>
  /** Cancela e descarta (nada vai para o rascunho). */
  cancel: () => Promise<void>
}

export function useDictation(options: UseDictationOptions): DictationControls {
  const voice: VoiceApi | undefined = api.voice
  const [settings, setSettings] = useState<AudioInputSettings>(DEFAULT_AUDIO_INPUT)
  const [partial, setPartial] = useState('')
  const [errorState, setErrorState] = useState<string | null>(null)
  const [finalizing, setFinalizing] = useState(false)
  const [starting, setStarting] = useState(false)
  const [mockRecording, setMockRecording] = useState(false)

  const optionsRef = useRef(options)
  const settingsRef = useRef(settings)
  const voiceRef = useRef(voice)
  useEffect(() => {
    optionsRef.current = options
    settingsRef.current = settings
    voiceRef.current = voice
  })
  /** Sessão atual (promise de criação + id resolvido) — uma por vez. */
  const sessionPromiseRef = useRef<Promise<string | null> | null>(null)
  const sessionIdRef = useRef<string | null>(null)
  const pushChainRef = useRef<Promise<void>>(Promise.resolve())
  const cancelRef = useRef(false)
  /** Geração do fluxo atual: `stop`/`cancel` invalidam um `start` em voo. */
  const genRef = useRef(0)

  // ---- settings de entrada (recarrega ao fechar as Configurações — a tela Áudio grava por lá) ----
  const settingsOpen = useStore((s) => s.settingsOpen)
  const reload = useCallback((): void => {
    const v = voiceRef.current
    if (!v) return
    void v.settings
      .get()
      .then((all) => setSettings(all.audioInput))
      .catch(() => {
        // sem settings segue o padrão (DEFAULT_AUDIO_INPUT)
      })
  }, [])
  useEffect(() => {
    if (!settingsOpen) reload()
  }, [settingsOpen, reload])

  const updateSettings = useCallback(async (patch: Partial<AudioInputSettings>) => {
    const v = voiceRef.current
    if (!v) return
    try {
      const saved = await v.settings.set('audioInput', { ...settingsRef.current, ...patch })
      setSettings(saved)
    } catch (err) {
      setErrorState(errorMessage(err))
    }
  }, [])

  // ---- sessão de transcrição (criação preguiçosa; uma por vez) ----
  const ensureSession = useCallback((): Promise<string | null> => {
    sessionPromiseRef.current ??= (async () => {
      const v = voiceRef.current
      if (!v) return null
      try {
        const id = await v.transcribe.start(settingsRef.current.language)
        sessionIdRef.current = id
        return id
      } catch (err) {
        setErrorState(errorMessage(err))
        return null
      }
    })()
    return sessionPromiseRef.current
  }, [])

  const dropSession = useCallback(async (): Promise<void> => {
    const pending = sessionPromiseRef.current
    sessionPromiseRef.current = null
    const id = pending ? await pending : sessionIdRef.current
    sessionIdRef.current = null
    if (id) await voiceRef.current?.transcribe.cancel(id).catch(() => {})
  }, [])

  // ---- parciais ao vivo (só da sessão atual) ----
  useEffect(() => {
    const off = api.onVoicePartial
    if (!off) return
    return off((e) => {
      if (e.sessionId !== sessionIdRef.current || e.isFinal) return
      setPartial(e.text)
    })
  }, [])

  // ---- fim da captura (qualquer motivo): transcreve o final ou descarta (cancel) ----
  const handleStopped = useCallback(async (reason: StopReason): Promise<void> => {
    void reason
    // o flag de cancelamento é consumido aqui (um cancel tardio não pode poluir o fluxo seguinte)
    const doCancel = cancelRef.current
    cancelRef.current = false
    const pending = sessionPromiseRef.current
    sessionPromiseRef.current = null
    const id = pending ? await pending : sessionIdRef.current
    sessionIdRef.current = null
    setPartial('')
    const v = voiceRef.current
    if (!id || !v) return
    if (doCancel) {
      await v.transcribe.cancel(id).catch(() => {})
      return
    }
    setFinalizing(true)
    try {
      await pushChainRef.current
      const result = await v.transcribe.stop(id)
      if (result.text) optionsRef.current.onFinal(result.text)
    } catch (err) {
      setErrorState(errorMessage(err))
    } finally {
      setFinalizing(false)
    }
  }, [])

  // ---- captura (real): chunks PCM16 → push em ordem na sessão ----
  const onPcmChunk = useCallback(
    (chunk: Int16Array): void => {
      const bytes = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
      pushChainRef.current = pushChainRef.current
        .then(async () => {
          const v = voiceRef.current
          const id = await ensureSession()
          if (!v || !id) return
          await v.transcribe.push(id, bytes)
        })
        .catch(() => {
          // falha de push: a sessão/finalização reporta o erro; evita unhandled rejection
        })
    },
    [ensureSession]
  )

  const ptt = usePushToTalk(MOCK ? { ...settings, pttEnabled: false } : settings, {
    onPcmChunk,
    onStopped: (reason) => void handleStopped(reason)
  })

  const pttStop = ptt.stop
  const pttStart = ptt.start
  const pttState = ptt.state

  const error = errorState ?? (ptt.error ? captureErrorText(ptt.error) : null)

  const captureActive = MOCK ? mockRecording : pttState === 'recording'
  const captureStopping = MOCK ? false : pttState === 'stopping'
  const state: DictationState =
    captureStopping || finalizing
      ? 'stopping'
      : captureActive
        ? 'recording'
        : starting
          ? 'starting'
          : 'idle'

  const start = useCallback(async (): Promise<void> => {
    if (state !== 'idle') return
    const gen = ++genRef.current
    setErrorState(null)
    setPartial('')
    cancelRef.current = false
    const v = voiceRef.current
    if (!v) {
      setErrorState('API de voz indisponível neste build.')
      return
    }
    setStarting(true)
    try {
      // settings FRESH nesta gravação (a tela Configurações → Áudio pode ter mudado tudo)
      try {
        const all = await v.settings.get()
        settingsRef.current = all.audioInput
        setSettings(all.audioInput)
      } catch {
        // sem settings segue as do estado (padrões)
      }
      if (gen !== genRef.current) return // stop/cancel enquanto carregava
      await ensureSession()
      if (gen !== genRef.current) {
        await dropSession()
        return
      }
      if (MOCK) setMockRecording(true)
      else await pttStart(settingsRef.current)
    } catch (err) {
      await dropSession()
      setErrorState(
        err instanceof Error && err.message.startsWith('AudioCapture')
          ? captureErrorText(err.message)
          : errorMessage(err)
      )
    } finally {
      setStarting(false)
    }
  }, [state, ensureSession, dropSession, pttStart])

  const stop = useCallback(async (): Promise<void> => {
    genRef.current++
    if (MOCK) {
      if (!mockRecording) return
      setMockRecording(false)
      await handleStopped('manual')
      return
    }
    await pttStop()
    // a captura ainda não existia (onStopped não rodou): encerra a sessão aqui
    if (sessionPromiseRef.current) await handleStopped('manual')
  }, [mockRecording, handleStopped, pttStop])

  const cancel = useCallback(async (): Promise<void> => {
    genRef.current++
    if (MOCK) {
      if (!mockRecording) {
        await dropSession()
        return
      }
      cancelRef.current = true
      setMockRecording(false)
      await handleStopped('manual')
      return
    }
    if (pttState === 'idle' && !starting) {
      await dropSession()
      return
    }
    cancelRef.current = true
    await pttStop()
    // onStopped não chegou a rodar (a captura ainda não existia): descarta aqui
    if (sessionPromiseRef.current) {
      cancelRef.current = false
      await dropSession()
    }
  }, [mockRecording, handleStopped, dropSession, pttStop, pttState, starting])

  return useMemo(
    () => ({
      state,
      level: ptt.level,
      partial,
      clearPartial: () => setPartial(''),
      error,
      clearError: () => setErrorState(null),
      settings,
      updateSettings,
      reload,
      available: !!voice,
      start,
      stop,
      cancel
    }),
    [state, ptt.level, partial, error, settings, updateSettings, reload, voice, start, stop, cancel]
  )
}
