// Chamada de voz (renderer): o "sensor" do turno — captura contínua (`AudioCapture`, constraints
// com `echoCancellation: true`), fala do usuário com FIM DE TURNO ADAPTATIVO (`AdaptiveTurnGate`:
// aos ~250 ms de pausa pede a transcrição especulativa — `voice:transcribe:speculate` — e o
// veredito de `classifyUtteranceEnd` define o silêncio que fecha a vez: pergunta/comando ~600 ms,
// afirmação ~1200 ms, frase inacabada ~1500 ms; sem especulação, o silêncio fixo), uma sessão de
// transcrição por fala (`voice:transcribe:*`, serializadas numa cadeia; a especulativa vira a
// final quando o usuário não voltou a falar) e a reprodução da resposta (`UtteranceQueue`).
//
// Os eventos de fronteira vão ao main pelos canais `voice:call:*` (o main é o dono do turno e do
// envio): `speech-begin`/`speech-end` → `turn(text)` com a transcrição final. Fala do usuário
// enquanto uma FRASE da resposta toca: curta (≤ `BACKCHANNEL_MAX_MS`) = backchannel (só registra);
// longa = barge-in (cancela a fala com fade e manda as frases ouvidas — o main trunca o histórico).
// Fala com só clipes tocando (preâmbulo/interjeição) ou nada ouvido ainda: os clipes saem na hora
// (fade curto, sem sobrepor o usuário) e o main decide o turno continuado. Pausas na fala viram
// observações de interjeição DEPOIS do veredito (`interjectionObserved` com `end` — pergunta/
// comando nunca ganham backchannel).
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
  DEFAULT_TURN_TIMING,
  resolveVoiceCallConfig,
  type TurnTiming,
  type InterjectionPolicy
} from '@shared/voice'
import {
  INTERJECTION_MAX_AGE_MS,
  INTERJECTION_TAIL_CHARS,
  InterjectionWatcher,
  PlaybackHold
} from '@shared/voicePolicy'
import { AdaptiveTurnGate, classifyUtteranceEnd, type UtteranceEnd } from '@shared/voiceTurn'
import { DEFAULT_SILENCE_THRESHOLD } from '../audio/silence'
import { AudioCapture } from '../audio/capture'
import { api, errorMessage } from '../api'
import { useStore } from '../../store'
import { captureErrorText, MIC_FALLBACK_NOTICE } from './dictation'
import { UtteranceQueue } from './utteranceQueue'
import { useVoiceCallRuntime, type VoiceCallRuntime } from './voiceCallRuntime'
import { loadVoiceSettings } from './voiceSettings'

const MOCK = import.meta.env.VITE_CLEAR_MOCK === '1'
/** Duração do quadro de nível RMS (ms) — `AudioCapture` emite ~30 Hz (`DEFAULT_LEVEL_MS`). */
const FRAME_MS = 33
/** Pre-roll da fala (chunks PCM mantidos antes do início) — não corta o onset (~300 ms). */
const PREROLL_MAX = 3
/** Fade (ms) do preâmbulo/frase cortados pelo usuário e da interjeição (mais curto — sem sobrepor). */
const FADE_MS = 80
const INTERJECTION_FADE_MS = 40

const setLevel = (level: number): void => useVoiceCallRuntime.setState({ level })
const setError = (error: string | null): void => useVoiceCallRuntime.setState({ error })
const setLive = (text: string, state: VoiceCallRuntime['live']['state']): void =>
  useVoiceCallRuntime.setState({ live: { text: text.trim(), state: text.trim() ? state : null } })
/** PCM16 mono 16 kHz: bytes → ms de áudio. */
const BYTES_PER_MS = 32
/** Parcial "em dia": cobre a fala até (quase) o começo da pausa — a cauda serve de veredito. */
const FRESH_PARTIAL_SLACK_MS = 250

/** Motivo de um ato de fala curta não tocado, decidido no renderer (vai à timeline do painel). */
function pushSkip(reason: string, speechMs: number, pauseMs: number, text: string): void {
  useStore.getState().pushVoiceCallTimeline({
    ts: Date.now(),
    kind: 'decision',
    class: 'NONE',
    played: false,
    speechMs,
    pauseMs,
    text: text.slice(-80),
    reason
  })
}

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
    // cache de definição antiga (frases/pool mudaram) conta como ausente: "Gerar clipes" de novo
    useVoiceCallRuntime.setState({ clips: m && m.clips.length > 0 && !m.stale ? 'ok' : 'missing' })
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
  // chave estável (o objeto do estado muda a cada evento — a captura não pode reiniciar à toa)
  const timingKey = useStore((s) => JSON.stringify(s.voiceCall.turnTiming ?? DEFAULT_TURN_TIMING))
  const muted = useStore((s) => s.voiceCall.muted)
  const volume = useVoiceCallRuntime((s) => s.volume)

  const queueRef = useRef<UtteranceQueue | null>(null)
  const gateRef = useRef<AdaptiveTurnGate | null>(null)
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
  /** Cauda da transcrição parcial ao vivo DA FALA ATUAL (escolhe a classe da interjeição). */
  const partialRef = useRef('')
  /** Áudio coberto pela última parcial da fala atual (ms desde o início da sessão; null = nenhuma). */
  const partialCoveredRef = useRef<number | null>(null)
  /** Áudio já enviado à sessão da fala atual (ms) — compara com a cobertura da parcial. */
  const pushedMsRef = useRef(0)
  /** Especulação da pausa atual (geração do gate + texto + veredito; null = nenhuma válida). */
  const specRef = useRef<{ seq: number; text: string; end: UtteranceEnd } | null>(null)
  /** Frases da resposta atual que começaram a tocar (barge-in: o histórico fica só com elas). */
  const startedRef = useRef<Set<string>>(new Set())

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
      pushedMsRef.current += bytes.length / BYTES_PER_MS
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

  /**
   * Fim da fala: `speech-end` + transcrição final → `voice:call:turn` (texto pode ser vazio).
   * `reuseSpeculative`: o usuário não falou depois da última especulação — ela vira a final.
   */
  const endUtterance = useCallback((reuseSpeculative = false): void => {
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
          // a parcial que já cobre a fala inteira vira a final (latência: sem request)
          const result = await v.transcribe.stop(id, { reuseSpeculative, reusePartial: true })
          // a barra mostra o texto que foi enviado (até a próxima fala)
          setLive(result.text, 'final')
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
      // só a sessão da fala ATUAL (o ditado e falas anteriores têm outras sessões)
      if (!e.sessionId || e.sessionId !== sessionRef.current) return
      if (e.error && !e.text) return
      partialRef.current = typeof e.text === 'string' ? e.text : ''
      partialCoveredRef.current = typeof e.coveredMs === 'number' ? e.coveredMs : null
      if (useStore.getState().voiceCall.active && speakingRef.current)
        setLive(partialRef.current, 'partial')
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
        if (phase === 'start' && (item.kind ?? 'sentence') === 'sentence')
          startedRef.current.add(item.id)
        const kind: VoiceCallTimelineEvent['kind'] =
          item.kind === 'sentence'
            ? phase === 'start'
              ? 'sentence-start'
              : 'sentence-end'
            : phase === 'start'
              ? 'clip-start'
              : 'clip-end'
        useStore.getState().pushVoiceCallTimeline({ ts: Date.now(), kind, id: item.id })
      },
      // utterance que não tocou (CSP/codec/autoplay): na timeline e no erro da barra — nunca calada
      onError: ({ item, reason }) => {
        useStore.getState().pushVoiceCallTimeline({
          ts: Date.now(),
          kind: 'playback-error',
          id: item.id,
          class: item.kind ?? 'sentence',
          reason
        })
        const what =
          item.kind === 'filler'
            ? 'o preâmbulo'
            : item.kind === 'interjection'
              ? 'a interjeição'
              : 'uma frase da resposta'
        // clipe (preâmbulo/interjeição) não é essencial: pula com o registro no painel; frase da
        // resposta que não toca encerra a chamada (nunca uma resposta muda)
        if (item.kind === 'filler' || item.kind === 'interjection') {
          setError(`Não foi possível tocar ${what}: ${reason}`)
          return
        }
        useStore
          .getState()
          .toast(`Chamada encerrada: não foi possível tocar ${what} (${reason})`, 'error')
        void useStore.getState().stopVoiceCall()
      }
    })
    queueRef.current = queue
    queue.setVolume(volumeRef.current)
    const off = api.onVoiceCallUtterance?.((e) => queue.enqueue(e))
    // filler interrompido pela 1ª sentença (ou reset/stop): cancela SÓ essa utterance
    // clipe interrompido (o usuário voltou a falar, turno novo, stop): sai com fade curto
    const offCancel = api.onVoiceCallUtteranceCancel?.((e) => queue.drop(e.id, FADE_MS))
    // resposta nova (fase "Pensando…"/"Transcrevendo…"): as frases ouvidas recomeçam do zero
    let lastPhase = useStore.getState().voiceCall.phase
    const offPhase = useStore.subscribe((st) => {
      const ph = st.voiceCall.phase
      if (ph === lastPhase) return
      lastPhase = ph
      if (ph === 'thinking' || ph === 'transcribing') startedRef.current = new Set()
    })
    // TTS em streaming (PCM progressivo): os pedaços seguintes de cada sentença
    const offChunk = api.onVoiceCallUtteranceChunk?.((e) => queue.pushChunk(e))
    return () => {
      off?.()
      offCancel?.()
      offPhase()
      offChunk?.()
      queue.cancel()
      queueRef.current = null
    }
  }, [active, voice])

  // ---- captura contínua + porta de fala (fim de turno adaptativo) ----
  useEffect(() => {
    if (!active || !voice) return
    const timing: TurnTiming = (() => {
      try {
        return { ...DEFAULT_TURN_TIMING, ...(JSON.parse(timingKey) as Partial<TurnTiming>) }
      } catch {
        return DEFAULT_TURN_TIMING
      }
    })()
    const gate = new AdaptiveTurnGate(timing, DEFAULT_SILENCE_THRESHOLD)
    gateRef.current = gate
    specRef.current = null

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
        const st = useStore.getState()
        const chat = st.chats.find((c) => c.id === st.voiceCall.chatId)
        const presetId = chat?.config.presetId
        const persona = presetId
          ? (st.presets.find((p) => p.id === presetId)?.config.voice ?? null)
          : null
        const resolved = resolveVoiceCallConfig(
          chat?.config.voice ?? null,
          all.voiceCallDefaults,
          persona
        )
        policyRef.current = resolved.interjections
        watcherRef.current = new InterjectionWatcher(resolved.interjections.minPauseMs)
      })
      .catch(() => void 0)

    /** Geração da especulação pedida na pausa atual (-1 = nenhuma válida — a fala voltou). */
    let askedSeq = -1
    /** Observação de pausa esperando o veredito da especulação (backchannel só depois dele). */
    let pendingObs: { speechMs: number } | null = null

    /**
     * Veredito pela parcial ao vivo, só quando ela está EM DIA com a fala (cobre até ~o começo da
     * pausa) — sem request; null = a parcial está atrasada (não dá para saber se a fala acabou).
     */
    const freshPartialEnd = (): UtteranceEnd | null => {
      const covered = partialCoveredRef.current
      const pauseStart = pushedMsRef.current - gate.pauseMs
      const fresh =
        !!partialRef.current.trim() &&
        covered != null &&
        covered >= pauseStart - FRESH_PARTIAL_SLACK_MS
      return fresh ? classifyUtteranceEnd(partialRef.current) : null
    }

    /** Manda a observação de interjeição ao main (com o veredito, quando há). */
    const sendObservation = (speechMs: number, end: UtteranceEnd | null): void => {
      if (!policyRef.current.enabled) return
      const spec = specRef.current?.text
      const tail = (spec || partialRef.current).slice(-INTERJECTION_TAIL_CHARS)
      if (!end && !spec) {
        // sem veredito (especulação pela API ainda não voltou) e sem parcial em dia: não há como
        // saber se a fala acabou — um "Aham." aqui sairia no fim da pergunta, antes da resposta
        end = freshPartialEnd()
        if (!end) {
          pushSkip('no-verdict', speechMs, gate.pauseMs, tail)
          return
        }
      }
      void api.voice?.call
        .interjectionObserved({
          speechMs,
          pauseMs: gate.pauseMs,
          tail,
          observedAt: Date.now(),
          end
        })
        .catch(() => {})
    }

    /** Fecha a fala (silêncio cumprido): backchannel retido, ou transcrição final → turno. */
    const closeUtterance = (): void => {
      speakingRef.current = false
      prerollRef.current = []
      pendingObs = null
      const holdMs = hold.speechMs
      const kind = hold.end()
      specRef.current = null
      if (kind === 'backchannel') {
        // backchannel do usuário ("uhum", "sim"): NÃO cancela a resposta nem vira turno
        dropSession()
        void api.voice?.call.backchannel({ ms: holdMs }).catch(() => {})
      } else {
        // a especulação da pausa que fechou o turno cobre toda a fala: vira a final
        // a especulação pedida nesta pausa cobre toda a fala (o usuário não voltou a falar): ela
        // vira a final — MESMO ainda em voo (especulação pela API é lenta: o turno fecha no
        // silêncio fixo e a final espera a especulação em vez de subir o áudio de novo)
        endUtterance(askedSeq === gate.specSeq && askedSeq > 0)
      }
      watcherRef.current?.reset()
    }

    /** Pausa cruzou ~250 ms: transcrição especulativa (na ordem dos pushes) → veredito. */
    const speculate = (seq: number): void => {
      askedSeq = seq
      chainRef.current = chainRef.current
        .then(async () => {
          const v = api.voice
          const pending = sessionPendingRef.current
          const id = pending ? await pending : sessionRef.current
          if (!v || !id) {
            onVerdict(seq, null)
            return
          }
          // não espera aqui: os pushes seguintes (e o stop) continuam na ordem
          void v.transcribe
            .speculate(id)
            .then((r) => onVerdict(seq, r ? r.text : null))
            .catch(() => onVerdict(seq, null))
        })
        .catch(() => {})
    }

    const onVerdict = (seq: number, text: string | null): void => {
      if (disposed || gateRef.current !== gate || seq !== gate.specSeq || !gate.speaking) return
      const end: UtteranceEnd = text == null ? 'unknown' : classifyUtteranceEnd(text)
      if (text != null) {
        specRef.current = { seq, text, end }
        setLive(text, 'speculative')
      }
      useStore.getState().pushVoiceCallTimeline({
        ts: Date.now(),
        kind: 'turn-verdict',
        pauseMs: gate.pauseMs,
        text: (text ?? '').slice(-80),
        reason: end
      })
      // observação de pausa que esperava o veredito: pergunta/comando não ganham backchannel; o
      // veredito que chega tarde demais (pausa já longa — API lenta) não vira "Aham." atrasado
      if (pendingObs && !hold.open) {
        const o = pendingObs
        pendingObs = null
        if (gate.pauseMs > policyRef.current.minPauseMs + INTERJECTION_MAX_AGE_MS)
          pushSkip('late-verdict', o.speechMs, gate.pauseMs, text ?? '')
        else sendObservation(o.speechMs, text == null ? null : end)
      }
      if (gate.setVerdict(seq, end) === 'end') closeUtterance()
    }

    const onLevel = (rms: number): void => {
      setLevel(rms)
      const ev = gate.push(rms, FRAME_MS)
      if (rms >= DEFAULT_SILENCE_THRESHOLD) {
        // o usuário (voltou a) falar: interjeição tocando sai na hora (sem sobrepor a fala dele)
        const queue = queueRef.current
        const cur = queue?.current ?? null
        if (cur?.kind === 'interjection') queue?.drop(cur.id, INTERJECTION_FADE_MS)
      }
      if (ev === 'resume') {
        specRef.current = null // a especulação ficou velha (a fala continuou)
        askedSeq = -1
        // a observação da pausa esperava um veredito que não chegou a tempo: registra o motivo
        if (pendingObs && policyRef.current.enabled)
          pushSkip('no-verdict', pendingObs.speechMs, 0, partialRef.current)
        pendingObs = null
      }
      if (ev === 'start') {
        const queue = queueRef.current
        const cur = queue?.current ?? null
        const sentencePlaying = !!cur && (cur.kind ?? 'sentence') === 'sentence'
        const mainSpeaking = useStore.getState().voiceCall.phase === 'speaking'
        const heard = startedRef.current.size > 0
        if (queue && (sentencePlaying || (heard && mainSpeaking))) {
          // fala do usuário durante a resposta já ouvida: backchannel (curta) × barge-in (longa) —
          // nada é cancelado até a fala detectada passar de `BACKCHANNEL_MAX_MS`
          hold.start(rms, FRAME_MS, DEFAULT_SILENCE_THRESHOLD)
        } else {
          // nada da resposta foi ouvido (só preâmbulo/interjeição, ou frases ainda na fila): tudo
          // sai com fade e o main decide o turno continuado
          const dropped = queue ? [...(cur ? [cur.id] : []), ...queue.queuedIds] : []
          if (dropped.length) queue?.cancel(FADE_MS)
          void api.voice?.call.speechBegin({ dropped }).catch(() => {})
        }
        // fala nova: a parcial/cobertura da fala anterior não vale mais (cauda velha escolhia a
        // classe errada ou barrava o backchannel como "pergunta")
        partialRef.current = ''
        partialCoveredRef.current = null
        pushedMsRef.current = 0
        askedSeq = -1
        setLive('', null)
        speakingRef.current = true
        specRef.current = null
        pendingObs = null
        for (const bytes of prerollRef.current.splice(0)) pushChunk(bytes)
        watcherRef.current?.reset()
        return
      }
      if (ev === 'speculate') {
        // fala retida durante a reprodução (backchannel × barge-in): sem especulação — silêncio fixo
        if (hold.open) {
          if (gate.setVerdict(gate.specSeq, 'unknown') === 'end') closeUtterance()
        } else speculate(gate.specSeq)
        return
      }
      if (ev === 'end') {
        closeUtterance()
        return
      }
      if (hold.open) {
        if (hold.frame(rms, FRAME_MS, DEFAULT_SILENCE_THRESHOLD) === 'barge-in') {
          // barge-in real (fala longa): cancela a fala do assistente com fade; o main para o turno
          // e deixa no histórico só as frases que começaram a tocar
          queueRef.current?.cancel(FADE_MS)
          const playedIds = [...startedRef.current]
          void api.voice?.call.bargeIn({ playedIds }).catch(() => {})
          // daqui em diante é uma fala normal do usuário: fim de turno adaptativo (especulação) e
          // observações de pausa voltam a valer (antes a fala inteira seguia "retida" — silêncio
          // fixo e nenhuma interjeição até o fim dela)
          hold.reset()
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
        // backchannel só depois do veredito da pausa (pergunta/comando não ganham "Aham.")
        const verdict = gate.verdict
        const partialEnd = verdict && verdict !== 'unknown' ? null : freshPartialEnd()
        if (verdict && verdict !== 'unknown') sendObservation(obs.speechMs, verdict)
        else if (partialEnd) sendObservation(obs.speechMs, partialEnd)
        else if (verdict === 'unknown' || !timing.adaptive) sendObservation(obs.speechMs, null)
        else pendingObs = { speechMs: obs.speechMs }
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
  }, [active, voice, timingKey, muted, pushChunk, endUtterance, dropSession])

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
