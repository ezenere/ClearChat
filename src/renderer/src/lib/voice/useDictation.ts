// Ditado por voz (renderer): orquestra a sessão de transcrição (`window.api.voice`) sobre a captura
// (`usePushToTalk` → `AudioCapture`) e as parciais ao vivo (`onVoicePartial`). Um fluxo por vez:
// clique/tecla do PTT inicia, `stop()` (ou soltar a tecla/silêncio) transcreve e devolve o texto
// final via `onFinal` (o envio é sempre manual — este hook nunca envia mensagem).
//
// A sessão de transcrição é criada de forma preguiçosa no PRIMEIRO CHUNK de áudio (clique e tecla
// do PTT seguem o mesmo caminho): uma captura que falha ao abrir (permissão, microfone ausente)
// nunca deixa sessão órfã no main. Os chunks esperam a sessão numa cadeia de promises (push em
// ordem) e o `stop` espera a cadeia antes de transcrever. A finalização tem um TOKEN: "Cancelar"
// (ou desmontar o composer, ou a UI do ditado ficar bloqueada) durante o "Transcrevendo…" cancela
// a sessão no main e o texto NÃO entra no rascunho.
//
// Build de desenvolvimento com `VITE_CLEAR_MOCK=1`: sem captura (não há microfone no mock) — o
// binding `voice` do mock emite as parciais e devolve o texto fixo; o `Waveform` simula os níveis
// e `window.__clearMockMic` (definido pelo cenário do mock) simula falhas do microfone.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { AudioInputSettings } from '@shared/voice'
import type { VoiceApi } from '@shared/ipc'
import { api, errorMessage } from '../api'
import { useStore } from '../../store'
import { usePushToTalk, type StopReason } from '../audio/usePushToTalk'
import { captureErrorText, MIC_FALLBACK_NOTICE, MIC_LOST_TEXT } from './dictation'
import { loadVoiceSettings, saveVoiceSetting, useVoiceSettings } from './voiceSettings'

export type { StopReason } from '../audio/usePushToTalk'

/** Estado do ditado na UI (um por vez). */
export type DictationState = 'idle' | 'starting' | 'recording' | 'stopping'

const MOCK = import.meta.env.VITE_CLEAR_MOCK === '1'

export interface UseDictationOptions {
  /** Texto final transcrito (rascunho normal editável). Nunca é enviado automaticamente. */
  onFinal: (text: string) => void
  /**
   * UI do ditado escondida/bloqueada (chamada de voz, pergunta/retry pendente, host offline,
   * Configurações abertas): a tecla do PTT fica desligada e uma gravação em curso é CANCELADA.
   */
  suspended?: boolean
}

export interface DictationControls {
  state: DictationState
  /** Nível RMS ao vivo (0..1) para o `Waveform`. */
  level: number
  /** Parcial ao vivo acumulada (melhor-esforço); '' = nenhuma. Nunca entra no texto editável. */
  partial: string
  /** Erro legível (permissão negada, mic indisponível, STT fora do ar); null = sem erro. */
  error: string | null
  /** Dispensa o erro (inclui o da captura) e o aviso. */
  clearError: () => void
  /** Aviso não bloqueante (microfone salvo ausente → padrão; mic perdido; parciais desligadas). */
  notice: string | null
  clearNotice: () => void
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
  /** Cancela e descarta (nada vai para o rascunho) — inclusive durante o "Transcrevendo…". */
  cancel: () => Promise<void>
}

/** Mock de UI: falhas simuladas do microfone (`window.__clearMockMic`, definido pelo cenário). */
function mockMicOpen(deviceId: string | null): boolean {
  const mode = (window as unknown as { __clearMockMic?: string }).__clearMockMic ?? 'ok'
  const fail = (name: string, message: string): Error => Object.assign(new Error(message), { name })
  if (mode === 'denied') throw fail('NotAllowedError', 'Permission denied')
  if (mode === 'none') throw fail('NotFoundError', 'Requested device not found')
  if (mode === 'busy') throw fail('NotReadableError', 'Could not start audio source')
  // microfone salvo que sumiu: a captura real cai no padrão (OverconstrainedError → padrão)
  return mode === 'missing' && !!deviceId
}

export function useDictation(options: UseDictationOptions): DictationControls {
  const voice: VoiceApi | undefined = api.voice
  const settings = useVoiceSettings((s) => s.view.audioInput)
  const [partial, setPartial] = useState('')
  const [errorState, setErrorState] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [finalizing, setFinalizing] = useState(false)
  const [starting, setStarting] = useState(false)
  const [mockRecording, setMockRecording] = useState(false)
  const suspended = !!options.suspended

  const optionsRef = useRef(options)
  const settingsRef = useRef(settings)
  const voiceRef = useRef(voice)
  /** A UI ficou bloqueada: soltar a tecla (efeito do PTT) também descarta, não transcreve. */
  const suspendedRef = useRef(suspended)
  // layout effect: atualiza antes da limpeza (passiva) do efeito da tecla do PTT no mesmo commit
  useLayoutEffect(() => {
    suspendedRef.current = suspended
  }, [suspended])
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
  /** Finalização em voo ("Transcrevendo…"): `cancelled` = o texto final é descartado. */
  const finalizeRef = useRef<{ id: string; cancelled: boolean } | null>(null)
  /** Geração do fluxo atual: `stop`/`cancel` invalidam um `start` em voo. */
  const genRef = useRef(0)
  const mountedRef = useRef(true)
  const mockTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ---- settings de entrada (recarrega ao fechar as Configurações — a tela Áudio grava por lá) ----
  const settingsOpen = useStore((s) => s.settingsOpen)
  const reload = useCallback((): void => {
    void loadVoiceSettings()
  }, [])
  useEffect(() => {
    if (!settingsOpen) reload()
  }, [settingsOpen, reload])

  const updateSettings = useCallback(async (patch: Partial<AudioInputSettings>) => {
    try {
      await saveVoiceSetting('audioInput', { ...settingsRef.current, ...patch })
    } catch (err) {
      setErrorState(`Não foi possível salvar o microfone: ${errorMessage(err)}`)
    }
  }, [])

  // ---- sessão de transcrição (criação preguiçosa no 1º chunk; uma por vez) ----
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

  /** Descarta a finalização em voo (texto final não entra no rascunho) e cancela a sessão no main. */
  const abortFinalize = useCallback((): boolean => {
    const fin = finalizeRef.current
    if (!fin || fin.cancelled) return false
    fin.cancelled = true
    void voiceRef.current?.transcribe.cancel(fin.id).catch(() => {})
    if (mountedRef.current) setFinalizing(false)
    return true
  }, [])

  // ---- parciais ao vivo (só da sessão atual) + aviso de parciais desligadas ----
  useEffect(() => {
    const off = api.onVoicePartial
    if (!off) return
    return off((e) => {
      if (e.sessionId !== sessionIdRef.current || e.isFinal) return
      if (e.error) setNotice(e.error)
      if (e.text) setPartial(e.text)
    })
  }, [])

  // ---- fim da captura (qualquer motivo): transcreve o final ou descarta (cancel) ----
  const handleStopped = useCallback(async (reason: StopReason): Promise<void> => {
    // o flag de cancelamento é consumido aqui (um cancel tardio não pode poluir o fluxo seguinte)
    const doCancel =
      cancelRef.current ||
      reason === 'unmount' ||
      (reason === 'ptt-release' && suspendedRef.current) ||
      !mountedRef.current
    cancelRef.current = false
    if (mockTimerRef.current) clearTimeout(mockTimerRef.current)
    mockTimerRef.current = null
    const pending = sessionPromiseRef.current
    sessionPromiseRef.current = null
    const id = pending ? await pending : sessionIdRef.current
    sessionIdRef.current = null
    if (mountedRef.current) setPartial('')
    if (reason === 'device-lost' && mountedRef.current) setNotice(MIC_LOST_TEXT)
    const v = voiceRef.current
    if (!id || !v) return
    if (doCancel) {
      await v.transcribe.cancel(id).catch(() => {})
      return
    }
    const token = { id, cancelled: false }
    finalizeRef.current = token
    setFinalizing(true)
    try {
      await pushChainRef.current
      if (token.cancelled) return
      const result = await v.transcribe.stop(id)
      // "Cancelar" (ou desmontagem/bloqueio) durante o "Transcrevendo…": descarta o texto
      if (token.cancelled || !mountedRef.current) return
      if (result.text) optionsRef.current.onFinal(result.text)
    } catch (err) {
      if (!token.cancelled && mountedRef.current) setErrorState(errorMessage(err))
    } finally {
      if (finalizeRef.current === token) finalizeRef.current = null
      if (!token.cancelled && mountedRef.current) setFinalizing(false)
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
    onStopped: (reason) => void handleStopped(reason),
    onFallback: () => setNotice(MIC_FALLBACK_NOTICE),
    suspended
  })

  const pttStop = ptt.stop
  const pttStart = ptt.start
  const pttState = ptt.state
  const pttClearError = ptt.clearError

  const error = errorState ?? ptt.error

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
    if (state !== 'idle' || suspendedRef.current) return
    const gen = ++genRef.current
    setErrorState(null)
    pttClearError()
    setNotice(null)
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
      const all = await loadVoiceSettings()
      settingsRef.current = all.audioInput
      if (gen !== genRef.current) return // stop/cancel enquanto carregava
      if (MOCK) {
        if (mockMicOpen(settingsRef.current.deviceId)) setNotice(MIC_FALLBACK_NOTICE)
        setMockRecording(true)
        // sem chunks no mock: a sessão nasce já (equivale ao 1º chunk da captura real)
        void ensureSession()
        if ((window as unknown as { __clearMockMic?: string }).__clearMockMic === 'lost') {
          mockTimerRef.current = setTimeout(() => {
            setMockRecording(false)
            void handleStopped('device-lost')
          }, 1500)
        }
      } else {
        // a sessão de transcrição só nasce no 1º chunk (falha ao abrir o mic = nada no main)
        await pttStart(settingsRef.current)
      }
    } catch (err) {
      await dropSession()
      setErrorState(captureErrorText(err as Error))
    } finally {
      setStarting(false)
    }
  }, [state, ensureSession, dropSession, pttStart, pttClearError, handleStopped])

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
    if (sessionPromiseRef.current && pttState === 'idle') await handleStopped('manual')
  }, [mockRecording, handleStopped, pttStop, pttState])

  const cancel = useCallback(async (): Promise<void> => {
    genRef.current++
    setPartial('')
    // "Transcrevendo…": o token descarta o texto e a sessão é cancelada no main
    if (abortFinalize()) return
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
  }, [mockRecording, handleStopped, dropSession, pttStop, pttState, starting, abortFinalize])

  // UI bloqueada no meio da gravação (pergunta/retry, chamada, host offline): descarta
  const cancelLatest = useRef(cancel)
  useEffect(() => {
    cancelLatest.current = cancel
  }, [cancel])
  useEffect(() => {
    if (suspended && state !== 'idle') void cancelLatest.current()
  }, [suspended, state])

  // Desmontagem (troca de chat no meio da gravação/transcrição): descarta tudo — nunca paga uma
  // transcrição que não teria onde entrar. A captura é liberada pelo próprio `usePushToTalk`
  // (motivo 'unmount' → `handleStopped` cancela a sessão).
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (mockTimerRef.current) clearTimeout(mockTimerRef.current)
      const fin = finalizeRef.current
      if (fin && !fin.cancelled) {
        fin.cancelled = true
        void voiceRef.current?.transcribe.cancel(fin.id).catch(() => {})
      }
      void dropSession()
    }
  }, [dropSession])

  const clearError = useCallback(() => {
    setErrorState(null)
    pttClearError()
    setNotice(null)
  }, [pttClearError])
  const clearNotice = useCallback(() => setNotice(null), [])

  return useMemo(
    () => ({
      state,
      level: ptt.level,
      partial,
      error,
      clearError,
      notice,
      clearNotice,
      settings,
      updateSettings,
      reload,
      available: !!voice,
      start,
      stop,
      cancel
    }),
    [
      state,
      ptt.level,
      partial,
      error,
      clearError,
      notice,
      clearNotice,
      settings,
      updateSettings,
      reload,
      voice,
      start,
      stop,
      cancel
    ]
  )
}
