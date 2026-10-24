// Chamada de voz meia-duplex (Feature B) — o dono do turno no main, SEM Electron/UI/IPC (a fiação
// fica em `src/main/ipc.ts`; o renderer é o "sensor": captura contínua, fim de turno adaptativo e a
// reprodução). Ver SPEC.md → "Áudio → Chamada de voz (meia-duplex)".
//
// Um turno de voz = fala do usuário → transcrição final (sessão `voice:transcribe:*` do renderer;
// a especulativa reaproveitada quando o usuário não voltou a falar) → `turn(text)` envia pelo MESMO
// caminho do composer (`sendTurn` = runner.send — fila/⚡ respeitadas; o histórico é idêntico ao de
// um turno de texto) → preâmbulo curto (filler) → resposta em streaming → TTS POR SENTENÇA (a 1ª
// frase também corta na vírgula, exceto com o TTS de texto em streaming; bytes na ordem, sem
// sobreposição; a 1ª frase espera o preâmbulo terminar — nunca corta no meio da palavra) → próxima
// escuta.
//
// A fala do assistente vem dos eventos do runner (`onAgentEvent`): `draft` (conteúdo acumulado em
// streaming, com monotonicidade por passo) e `message-added` (flush autoritativo do passo). Erros
// persistidos (`meta.kind 'error'`) NÃO são falados. O histórico só guarda o que foi OUVIDO:
// - turno continuado (o usuário volta a falar antes de ouvir a resposta): a resposta fica retida,
//   o turno do agente é parado, o turno anterior sai do histórico e a fala anterior + a nova são
//   reenviadas como UM turno (com tools já executadas, o histórico delas fica e a fala nova vira o
//   próximo turno);
// - barge-in no meio da resposta: o turno é parado e o texto do assistente é truncado ao que foi
//   falado (`interrupted: true`); nada nunca falado fica (`amendTurn` → `amendVoiceTurn`).
import type {
  Chat,
  ChatConfig,
  Session,
  StoredMessage,
  AgentEvent,
  MessageMeta
} from '@shared/types'
import type { VoiceCallTimelineEvent } from '@shared/ipc'
import { isDisplayOnly } from '@shared/context'
import {
  DEFAULT_FILLER_DELAY_MS,
  DEFAULT_TURN_SILENCE_MS,
  DEFAULT_TURN_TIMING,
  resolveFillerPool,
  resolveTurnSilenceMs,
  resolveTurnTiming,
  resolveVoiceCallConfig,
  type AudioInputSettings,
  type FillerContext,
  type InterjectionClass,
  type ResolvedVoiceCall,
  type SttSettings,
  type TtsSettings,
  type TurnTiming,
  type VoiceCallConfig,
  type VoiceCallDefaults,
  type VoiceCallState
} from '@shared/voice'
import {
  EMPTY_FILLER_STATE,
  EVAL_TAIL_MAX_CHARS,
  FILLER_RECENT_WINDOW,
  INTERJECTION_MAX_AGE_MS,
  classifyFillerContext,
  decideInterjection,
  fillerShouldFire,
  fillerTooShort,
  pickFillerPhrase,
  type FillerState,
  type InterjectionObservation
} from '@shared/voicePolicy'
import { isBackchannelText, type UtteranceEnd } from '@shared/voiceTurn'
import {
  CALL_START_TEXT,
  callEndText,
  type VoiceCallEndedBy,
  type VoiceCallMark,
  type VoiceCallUsage,
  type VoiceMessageMeta
} from '@shared/voiceCallMarks'
import { CLIP_PHRASES, type ClipClass } from './clips'
import type { VoiceEvalEvent } from './evalLog'
import { classifyVoiceError, type VoiceFailure, type VoiceFailureSource } from './callErrors'
import type { TtsTextFeed } from './elevenlabsStream'
import { FIRST_CHUNK_COMMA_MIN, splitSentences } from './sentences'
import { VoiceTurnMachine, isBusyStatus } from './turnMachine'

/** Utterance falada (evento `voice:call:utterance`) — bytes completos de uma sentença/clip. */
export interface VoiceCallUtterance {
  id: string
  audio: Uint8Array
  mime: string
  /** Origem do áudio (sentença da resposta, filler ou interjeição); ausente = 'sentence'. */
  kind?: 'sentence' | 'filler' | 'interjection'
  /** Ganho relativo (0–1; ausente = 1) — interjeições tocam mais baixo. */
  gain?: number
}

export interface VoiceCallSessionInfo {
  chatId: string
  depth: number
  busy: boolean
}

/** Ajuste do histórico de um turno interrompido (ver `amendVoiceTurn` no runner). */
export interface VoiceCallAmend {
  userMessageId: string
  /** Turno continuado sem tools: a mensagem do usuário e tudo depois dela saem. */
  dropUser: boolean
  /**
   * Sentenças FALADAS por mensagem do assistente (id → sentenças, na ordem). Função = avaliada
   * DEPOIS de parar o turno (o passo em streaming só ganha id de mensagem no abort).
   */
  spoken: Record<string, string[]> | (() => Record<string, string[]>)
}

/** Número finito ≥ 0 arredondado (lixo/negativo → 0; nunca NaN/Infinity na timeline). */
const finiteMs = (v: unknown): number => {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : 0
  return n > 0 ? n : 0
}

/** Chama uma dependência opcional sem nunca derrubar a chamada (falha → `fallback`). */
function safeCall<T>(fn: () => T, fallback: T): T {
  try {
    return fn()
  } catch {
    return fallback
  }
}

const UTTERANCE_ENDS: readonly UtteranceEnd[] = ['complete', 'statement', 'unfinished', 'unknown']

/** Variantes de clipe por classe de interjeição (as frases geradas em `clips.ts`). */
const INTERJECTION_VARIANTS: Partial<Record<InterjectionClass, number>> = {
  ACK: CLIP_PHRASES.ACK.length,
  AGREEMENT: CLIP_PHRASES.AGREEMENT.length,
  ENCOURAGEMENT: CLIP_PHRASES.ENCOURAGEMENT.length,
  THINKING: CLIP_PHRASES.THINKING.length
}

/** Dependências injetadas (testes usam fakes; a fiação real está em `src/main/ipc.ts`). */
export interface VoiceCallDeps {
  /**
   * Envia a transcrição final como mensagem do usuário (mesmo caminho do composer). `meta` =
   * `{ voice }` da fala (chamada, duração, modelo da transcrição) gravado junto da mensagem.
   */
  sendTurn(sessionId: string, text: string, meta?: MessageMeta): void
  /** Síntese de uma sentença (bytes completos). Abort = descartada (barge-in/stop). */
  synth(text: string, signal: AbortSignal): Promise<{ audio: Uint8Array; mime: string }>
  /** Estado da chamada para o renderer (canal `voice:call:state`). */
  emitState(state: VoiceCallState): void
  /** Utterance falada para o renderer (canal `voice:call:utterance`). */
  emitUtterance(utterance: VoiceCallUtterance): void
  /** Cancela uma utterance no renderer (canal `voice:call:utterance-cancel` — com fade curto). */
  emitUtteranceCancel(id: string): void
  /** Evento da timeline da chamada (canal `voice:call:timeline` — UI/métricas/calibração). */
  emitTimeline(event: VoiceCallTimelineEvent): void
  /** Registra uma decisão no log de avaliação (`<userData>/voice-eval/*.jsonl` — calibração). */
  logEval(event: VoiceEvalEvent): void
  /**
   * Bytes de um clipe pré-gerado em dia com a definição atual (SPEC → "Serviço de TTS (clipes)");
   * null = clipe ausente/velho (filler/interjeição não tocam — nada é sintetizado no lugar).
   */
  clip(cls: ClipClass, n: number): Promise<{ audio: Uint8Array; mime: string } | null>
  /** Info da sessão (null = não existe). */
  sessionInfo(sessionId: string): VoiceCallSessionInfo | null
  /** Config do chat para resolver os overrides de request (persona snapshot já aplicada). */
  chatConfig(chatId: string): ChatConfig | null
  /**
   * Config de voz da persona de origem do chat (`presetId`, lida ao vivo): campos null do chat a
   * herdam (chat > persona > global). Ausente = sem camada de persona.
   */
  personaVoice?(chatId: string): VoiceCallConfig | null
  /**
   * A transcrição especulativa vai pela API (lenta — sem motor local para o veredito)? Então o
   * turno não espera o teto com ela pendente (`TurnTiming.pendingMs` = silêncio fixo) e a final
   * reaproveita a especulação em voo. Ausente = false.
   */
  slowSpeculation?(): boolean
  /**
   * Classifica uma falha de STT/TTS da chamada (fatal × transitória, motivo legível). Ausente =
   * `classifyVoiceError` com um rótulo genérico. null = cancelamento (não é falha).
   */
  classifyError?(e: unknown, source: VoiceFailureSource): VoiceFailure | null
  /** A chamada terminou (por qualquer motivo): o IPC derruba os streams de TTS em curso. */
  onCallEnded?(): void
  /** Settings de voz completas (lidas a cada uso — a tela de Configurações pode mudá-las). */
  settings(): {
    defaults: VoiceCallDefaults
    audioInput: AudioInputSettings
    stt: SttSettings
    tts: TtsSettings
  }
  /** Assina os eventos do runner (main → main). */
  onEvent(cb: (e: AgentEvent) => void): () => void
  /**
   * Para o turno do agente e ajusta o histórico ao que foi falado (`amendVoiceTurn` do runner).
   * Ausente = sem ajuste (testes antigos; o turno segue como antes).
   */
  amendTurn?(sessionId: string, amend: VoiceCallAmend): Promise<void>
  /** Relógio em ms (padrão `Date.now`; injetável para testes de expiração/cooldown). */
  now?: () => number
  /** PRNG determinístico (padrão `Math.random`; injetável para testes de variante/probabilidade). */
  rng?: () => number
  /** Espera do preâmbulo depois do turno (padrão `voiceCallDefaults.fillers.delayMs` — 250 ms). */
  fillerDelayMs?: number
  /**
   * [tts-feed] TTS de entrada em streaming (ElevenLabs WebSocket — `elevenlabsStream.ts`), lido a
   * cada uso; null/ausente = só o `synth` por sentença (os demais backends). Ganchos best-effort:
   * o texto da sentença incompleta vai ao TTS antes do corte e o corte já faz o flush; o `synth`
   * da sentença continua sendo chamado na ordem (ele pega o que o feed preparou); o fim da resposta
   * (`end`) fecha o contexto. Com feed, a 1ª frase NÃO corta na vírgula.
   */
  ttsFeed?: () => TtsTextFeed | null
  /**
   * Grava um marcador da chamada no histórico (mensagem só de exibição, `meta.kind 'voice-call'` —
   * nunca vai à API). Ausente = sem marcadores (testes antigos).
   */
  appendMarker?(sessionId: string, content: string, meta: MessageMeta): void
  /** Caminho ativo da sessão (soma o custo do LLM dos turnos da chamada no marcador de fim). */
  sessionMessages?(sessionId: string): StoredMessage[]
  /** Preço de lista da voz por caractere (US$; OpenRouter) — custo ≈ da fala. null = desconhecido. */
  ttsUnitPrice?(): number | null
  /** Id da chamada (padrão `crypto.randomUUID`). */
  newCallId?(): string
  /**
   * Espera máxima pelo fim da reprodução depois do `end_call` (ms; padrão 30 s): o renderer pode
   * não avisar o `playback-idle` (janela escondida/erro) — a chamada cai mesmo assim.
   */
  hangupMaxWaitMs?: number
}

/** Medição da chamada em andamento (vira `VoiceCallUsage` no marcador de fim). */
interface CallMeter {
  callId: string
  sessionId: string
  startedAt: number
  turns: number
  userSpeechMs: number
  stt: VoiceCallUsage['stt']
  tts: VoiceCallUsage['tts']
}

/** Transcrição final da chamada (o IPC repassa o resultado de `voice:transcribe:stop`). */
export interface VoiceCallTranscript {
  text: string
  model?: string
  backend?: 'api' | 'local'
  /** Áudio da fala (ms). */
  audioMs?: number
}

/** Turno do usuário em andamento (o que o histórico tem dele). */
interface TurnInfo {
  text: string
  userMessageId: string | null
  toolsRan: boolean
  /** `meta.voice` da fala que abriu o turno (turno continuado soma a duração). */
  voice?: VoiceMessageMeta
}

export class VoiceCallManager {
  readonly #deps: VoiceCallDeps
  readonly #machine: VoiceTurnMachine
  #sessionId: string | null = null
  #chatId: string | null = null
  #muted = false
  #turnSilenceMs: number = DEFAULT_TURN_SILENCE_MS
  #turnTiming: TurnTiming = DEFAULT_TURN_TIMING
  #error: string | null = null
  /** Motivo do fim da chamada por falha (fica no estado inativo até a próxima chamada). */
  #endedReason: string | null = null
  /** Fase "Preparando a GPU…" (texto do andamento; null = pronta — o renderer abre o microfone). */
  #preparing: string | null = null
  /** Uma falha transitória no meio de um stream já aconteceu (a segunda encerra a chamada). */
  #transientStrike = false
  // ---- feed do texto do assistente (por passo do loop; monotônico contra rewinds de retry) ----
  #lastContent = ''
  #feed = ''
  /** A resposta em andamento não é mais falada (barge-in/turno continuado). */
  #speakCancelled = false
  // ---- pipeline de síntese (serial; sentenças na ordem, sem sobreposição) ----
  #synthQueue: { text: string; gen: number; key: number; attempt: number }[] = []
  #synthGen = 0
  #synthRunning = false
  #synthAbort: AbortController | null = null
  #uttSeq = 0
  // ---- turno + o que foi falado (histórico só com o ouvido) ----
  #turn: TurnInfo | null = null
  /** Chave → texto de cada sentença cortada no turno (ordem = chave crescente). */
  #keyText = new Map<number, string>()
  #keySeq = 0
  /** Sentenças do passo atual (ainda sem mensagem persistida). */
  #stepKeys: number[] = []
  /** Mensagem do assistente → chaves das sentenças dela. */
  #msgKeys = new Map<string, number[]>()
  /** Utterance de sentença emitida → chave. */
  #uttKey = new Map<string, number>()
  /** Sentenças já cortadas neste turno (a 1ª também corta na vírgula). */
  #sentencesThisTurn = 0
  /**
   * Resposta retida: o usuário voltou a falar antes de ouvir qualquer frase — nada é falado até a
   * transcrição dizer se é continuação (texto) ou ruído (vazio → as frases retidas voltam).
   */
  #holdAnswer = false
  /** Frases não ouvidas guardadas durante a retenção (chave + texto, na ordem). */
  #heldTexts: { key: number; text: string }[] = []
  /**
   * O usuário voltou a falar com a transcrição da fala anterior ainda em voo: o texto dela não vira
   * turno sozinho — é carregado e unido ao da fala seguinte (`awaiting` = a transcrição em voo).
   */
  #carry: { awaiting: boolean; text: string } | null = null
  // ---- preâmbulo pós-turno (1 por turno; nunca cortado pela resposta) ----
  #filler: FillerState = { ...EMPTY_FILLER_STATE }
  #fillerTimer: ReturnType<typeof setTimeout> | null = null
  #fillerUttId: string | null = null
  /** Geração do filler (async): reset/stop/barge-in descartam a carga de clip em voo. */
  #fillerGen = 0
  /** Contexto do turno que escolhe a frase do pool. */
  #fillerContext: FillerContext = 'generic'
  /** Índices (0-based) do pool usados por último (nunca repete os últimos `FILLER_RECENT_WINDOW`). */
  #fillerRecent: number[] = []
  /** Reprodução em curso no renderer (utterance emitida e fila ainda não vazia). */
  #playbackActive = false
  /** O agente já tem frase emitida no turno em andamento. */
  #agentSpoke = false
  // ---- interjeições na fala do usuário ----
  #lastInterjectAt: number | null = null
  #lastInterjectVariant: Partial<Record<string, number>> = {}
  /** Última interjeição emitida (id + classe) — cancelada quando o usuário volta a falar/stop. */
  #interjectUtt: { id: string; cls: string; n: number } | null = null
  // ---- histórico e custos da chamada (marcadores, meta.voice) ----
  #meter: CallMeter | null = null
  /** Última transcrição final ainda não usada num turno (vira o `meta.voice` da fala). */
  #lastTranscript: VoiceCallTranscript | null = null
  /** Falas transcritas acumuladas para o próximo envio (fila/turno continuado unem várias). */
  #speechAcc: { audioMs: number; model?: string } = { audioMs: 0 }
  /** Marcador de fim esperando a sessão ficar ociosa (o turno do agente ainda rodava). */
  #pendingEnd: {
    sessionId: string
    write: () => void
    timer: ReturnType<typeof setTimeout>
  } | null = null
  // ---- end_call: desligar depois de a despedida tocar ----
  /** tool_call ids de `end_call` vistos nas respostas (o resultado ok arma o desligamento). */
  #endCallIds = new Set<string>()
  /** Desligamento pedido pelo agente (cai quando a resposta terminar de tocar). */
  #hangup: { reason: string | null; timer: ReturnType<typeof setTimeout> | null } | null = null

  constructor(deps: VoiceCallDeps) {
    this.#deps = deps
    this.#machine = new VoiceTurnMachine((text) => {
      if (this.#sessionId) {
        // antes do envio: o `message-added` do usuário pode chegar DENTRO do sendTurn (síncrono)
        // e completar o id da mensagem
        const voice = this.#takeSpeechMeta()
        this.#turn = { text, userMessageId: null, toolsRan: false, voice }
        const before = this.#turn
        if (this.#meter) this.#meter.turns++
        this.#deps.sendTurn(this.#sessionId, text, { voice })
        this.#emitTimeline({
          ts: this.#now(),
          kind: 'turn-sent',
          text: text.slice(0, EVAL_TAIL_MAX_CHARS)
        })
        // o preâmbulo entra logo (se a resposta não vier antes); o message-added já armou
        if (this.#turn === before) this.#armFiller(text)
      }
    })
    deps.onEvent((e) => this.#onAgentEvent(e))
  }

  // ---------------- API pública (canais `voice:call:*`) ----------------

  /** Entra na chamada da sessão (depth 0; uma chamada por vez). Erro legível → throw. */
  start(sessionId: string): VoiceCallState {
    if (this.#sessionId) throw new Error('Já existe uma chamada de voz ativa.')
    const info = this.#deps.sessionInfo(sessionId)
    if (!info) throw new Error('Sessão não encontrada.')
    if (info.depth > 0) throw new Error('A chamada de voz é só em sessões principais.')
    const { defaults, audioInput } = this.#deps.settings()
    // resolve com o chat da sessão (this.#chatId ainda não está setado aqui)
    const resolved = this.#resolvedFor(info.chatId)
    if (!resolved.enabled) throw new Error('Chamada de voz desativada para este chat.')
    this.#sessionId = sessionId
    this.#chatId = info.chatId
    this.#muted = false
    this.#error = null
    this.#endedReason = null
    this.#preparing = null
    this.#transientStrike = false
    this.#turnSilenceMs = resolveTurnSilenceMs(defaults.turn, audioInput)
    const timing = resolveTurnTiming(defaults.turn)
    this.#turnTiming = this.#deps.slowSpeculation?.()
      ? { ...timing, pendingMs: timing.fallbackMs }
      : timing
    this.#turn = null
    this.#carry = null
    this.#resetResponse()
    this.#machine.start(info.busy)
    this.#beginMeter(sessionId)
    this.#emitState()
    return this.state()
  }

  /**
   * Sai da chamada (descarta fala pendente e para a fala do assistente). `reason` = fim por falha
   * (fica em `state().error` com a chamada inativa — o renderer mostra "Chamada encerrada: …").
   */
  stop(
    reason?: string,
    opts?: {
      by?: VoiceCallEndedBy
      note?: string | null
      /** Grava o marcador de fim já, mesmo com o turno rodando (app fechando). */
      immediate?: boolean
    }
  ): VoiceCallState {
    if (!this.#sessionId) return this.state()
    this.#endedReason = typeof reason === 'string' && reason ? reason : null
    const by: VoiceCallEndedBy = opts?.by ?? (this.#endedReason ? 'error' : 'user')
    this.#cancelHangup(null)
    this.#endMeter(
      by,
      by === 'error' ? this.#endedReason : (opts?.note ?? null),
      opts?.immediate === true
    )
    this.#speakCancelled = true
    this.#clearSynth()
    this.#ttsFeedCall((f) => f.close()) // [tts-feed] fim da chamada: fecha a conexão
    this.#resetFiller(true)
    this.#cancelInterject()
    this.#machine.stop()
    this.#sessionId = null
    this.#chatId = null
    this.#muted = false
    this.#error = null
    this.#preparing = null
    this.#turn = null
    this.#carry = null
    try {
      this.#deps.onCallEnded?.()
    } catch {
      /* derrubar streams nunca impede o fim da chamada */
    }
    this.#emitState()
    return this.state()
  }

  /**
   * Falha de STT/TTS fora do pipeline de síntese (transcrição final que falhou mesmo depois da
   * nova tentativa, parcial/segmento com erro fatal, stream de TTS que caiu no meio): fatal →
   * encerra; transitória → uma "falta" (`retried: true` = a nova tentativa já falhou → encerra;
   * senão a 2ª falta seguida encerra). Devolve true quando a chamada foi encerrada.
   */
  voiceApiError(source: VoiceFailureSource, e: unknown, opts?: { retried?: boolean }): boolean {
    if (!this.#sessionId) return false
    const f = this.#classify(e, source)
    if (!f) return false
    if (f.fatal || opts?.retried || this.#transientStrike) {
      this.#endWithError(f)
      return true
    }
    this.#transientStrike = true
    this.#error = f.reason
    this.#emitTimeline({ ts: this.#now(), kind: 'playback-error', class: source, reason: f.detail })
    this.#emitState()
    return false
  }

  #classify(e: unknown, source: VoiceFailureSource): VoiceFailure | null {
    return this.#deps.classifyError
      ? this.#deps.classifyError(e, source)
      : classifyVoiceError(e, source, 'provedor de voz')
  }

  /**
   * Encerra a chamada por falha: para o turno do agente (o histórico fica só com o que foi
   * emitido para tocar — as regras de sempre), descarta a síntese/streams e deixa o motivo no
   * estado inativo.
   */
  #endWithError(f: VoiceFailure): void {
    if (!this.#sessionId) return
    console.warn(`[clearchat] chamada de voz encerrada: ${f.reason} — ${f.detail}`)
    const emitted = [...this.#uttKey.keys()]
    const unheard = this.#synthQueue.length > 0 || this.#keyText.size > emitted.length
    if (this.#turn?.userMessageId && (this.#machine.responseInFlight || unheard))
      this.#interruptAnswer(emitted)
    this.stop(f.reason)
  }

  /** Mudo do microfone (a captura é pausada no renderer; aqui só reflete no estado). */
  mute(muted: boolean): VoiceCallState {
    if (!this.#sessionId) return this.state()
    this.#muted = !!muted
    this.#emitState()
    return this.state()
  }

  /**
   * O usuário começou a falar FORA da reprodução de uma frase da resposta (o renderer já descartou,
   * com fade, os clipes e as frases ainda não tocadas — `dropped`). Com a resposta em voo e NADA
   * dela ouvido → candidata a turno continuado (resposta retida até a transcrição); com parte já
   * ouvida (pausa entre frases) → é barge-in: o histórico fica só com o que foi falado.
   */
  speechBegin(input?: { dropped?: string[] }): VoiceCallState {
    if (!this.#sessionId) return this.state()
    this.#cancelHangup('speech') // o usuário continuou falando: a chamada não cai
    // a interjeição/preâmbulo tocando sai de cena (o renderer já cortou com fade)
    this.#resetFiller(true)
    this.#cancelInterject()
    // a fala anterior ainda está transcrevendo (o silêncio fechou o turno no meio da frase): o
    // texto dela será unido ao desta fala em vez de virar turno sozinho
    if (this.#machine.phase === 'transcribing') {
      this.#carry = { awaiting: true, text: this.#carry?.text ?? '' }
    }
    const dropped = new Set(Array.isArray(input?.dropped) ? input!.dropped : [])
    const emitted = [...this.#uttKey.keys()]
    const played = emitted.filter((id) => !dropped.has(id))
    const unheard = emitted.length > played.length || this.#synthQueue.length > 0
    const answerPending = this.#machine.responseInFlight || this.#keyText.size > 0
    if (this.#turn && !played.length && answerPending) {
      // nada da resposta foi ouvido: retém (frases descartadas voltam se a fala for ruído)
      this.#beginHold(emitted)
    } else if (played.length && (unheard || this.#machine.responseInFlight)) {
      // parte da resposta ouvida, o resto não: barge-in (para o turno, trunca ao falado)
      this.#interruptAnswer(played)
    }
    this.#machine.speechBegan()
    this.#emitTimeline({ ts: this.#now(), kind: 'speech-start' })
    this.#emitState()
    return this.state()
  }

  /** O silêncio encerrou a fala: a transcrição final está em andamento. */
  speechEnd(): VoiceCallState {
    if (!this.#sessionId) return this.state()
    this.#machine.speechEnded()
    this.#emitTimeline({ ts: this.#now(), kind: 'speech-end' })
    this.#emitState()
    return this.state()
  }

  /**
   * Transcrição final da fala do usuário. Sem resposta em andamento envia já (pelo caminho do
   * composer); com resposta em voo fica como PRÓXIMO turno (máx. 1 pendente) — salvo o turno
   * CONTINUADO (resposta retida e ainda não ouvida): o turno anterior é refeito com a fala unida.
   */
  turn(text: string): VoiceCallState {
    if (!this.#sessionId) return this.state()
    this.#error = null
    let t = typeof text === 'string' ? text.trim() : ''
    // a fala com texto entra no `meta.voice` do próximo envio (duração/modelo da transcrição)
    const tr = this.#lastTranscript
    this.#lastTranscript = null
    if (t && tr) {
      this.#speechAcc.audioMs += Math.max(0, tr.audioMs ?? 0)
      if (tr.model) this.#speechAcc.model = tr.model
    }
    if (this.#carry?.awaiting) {
      // transcrição da fala que o usuário continuou: guardada para a próxima (nada é enviado)
      this.#carry = { awaiting: false, text: [this.#carry.text, t].filter(Boolean).join(' ') }
      this.#emitState()
      return this.state()
    }
    if (this.#carry) {
      t = [this.#carry.text, t].filter(Boolean).join(' ')
      this.#carry = null
      if (t)
        this.#emitTimeline({
          ts: this.#now(),
          kind: 'turn-continued',
          text: t.slice(0, EVAL_TAIL_MAX_CHARS),
          reason: 'carried'
        })
    }
    if (this.#holdAnswer) {
      if (!t || isBackchannelText(t)) {
        // ruído/sem texto/"uhum": a resposta retida volta a ser falada (não é conteúdo novo)
        this.#releaseHold()
        this.#machine.turnArrived('')
      } else {
        void this.#continueTurn(t)
      }
      this.#emitState()
      return this.state()
    }
    this.#machine.turnArrived(t)
    this.#emitState()
    return this.state()
  }

  /** A fila de reprodução do renderer esvaziou. */
  playbackIdle(): VoiceCallState {
    if (!this.#sessionId) return this.state()
    this.#playbackActive = false
    this.#fillerUttId = null
    this.#interjectUtt = null
    this.#machine.playbackIdle()
    // filler segurado enquanto um clipe tocava (ex.: interjeição): tenta de novo agora
    void this.#tryFiller()
    if (this.#checkHangup()) return this.state()
    this.#emitState()
    return this.state()
  }

  /**
   * Barge-in: o usuário falou (longo) durante a reprodução de uma frase — cancela a fala do
   * assistente, para o turno do agente e deixa no histórico só o que foi falado (`playedIds` =
   * utterances de sentença que começaram a tocar; ausente = as emitidas contam como ouvidas).
   */
  bargeIn(input?: { playedIds?: string[] }): VoiceCallState {
    if (!this.#sessionId) return this.state()
    this.#cancelHangup('barge-in')
    this.#emitTimeline({ ts: this.#now(), kind: 'barge-in' })
    const played = Array.isArray(input?.playedIds)
      ? input!.playedIds.filter((id) => this.#uttKey.has(id))
      : [...this.#uttKey.keys()]
    this.#playbackActive = false
    this.#resetFiller(true) // quem falou é o usuário: sem filler no meio da fala dele
    this.#interruptAnswer(played)
    this.#machine.bargeIn()
    this.#emitState()
    return this.state()
  }

  /**
   * Observação do detector de pausas na fala do usuário (SPEC → "Interjeições (regras)"): a
   * política pura (`decideInterjection`) decide classe + variante e o clipe é tocado pela mesma
   * fila de utterances — nunca durante a reprodução do assistente nem depois de a resposta
   * começar a falar, nem quando a fala soa completa (pergunta/comando — `end`). Em modo sombra
   * (`interjections.shadow`) decide mas não toca.
   */
  interjectionObserved(input: {
    speechMs: number
    pauseMs: number
    tail: string
    observedAt: number
    end?: string | null
  }): void {
    if (!this.#sessionId) return
    const now = this.#now()
    const skip = (reason: string): void =>
      this.#emitTimeline({
        ts: now,
        kind: 'decision',
        class: 'NONE',
        played: false,
        speechMs: finiteMs(input?.speechMs),
        pauseMs: finiteMs(input?.pauseMs),
        text: typeof input?.tail === 'string' ? input.tail.slice(-EVAL_TAIL_MAX_CHARS) : '',
        reason
      })
    // assistente calado: sem interjeição sobre a fala do assistente ou sobre a resposta em curso.
    // `#agentSpoke` só vale com a resposta EM VOO: depois que ela terminou, a próxima fala do
    // usuário volta a poder ganhar backchannel (antes ele ficava preso até a próxima mensagem do
    // usuário entrar no histórico — nenhuma interjeição depois da 1ª resposta)
    if (this.#playbackActive) return skip('assistant-audio')
    if (this.#agentSpoke && this.#machine.responseInFlight) return skip('answer-speaking')
    if (this.#machine.phase !== 'listening') return skip(`phase-${this.#machine.phase}`)
    const resolved = this.#resolved()
    const end = UTTERANCE_ENDS.includes(input?.end as UtteranceEnd)
      ? (input.end as UtteranceEnd)
      : null
    const obs: InterjectionObservation = {
      speechMs: finiteMs(input?.speechMs),
      pauseMs: finiteMs(input?.pauseMs),
      tail: typeof input?.tail === 'string' ? input.tail.slice(-EVAL_TAIL_MAX_CHARS) : '',
      observedAt: finiteMs(input?.observedAt) || now,
      end
    }
    const decision = decideInterjection(
      obs,
      resolved.interjections,
      {
        now,
        lastFiredAt: this.#lastInterjectAt,
        lastVariant: this.#lastInterjectVariant,
        variants: INTERJECTION_VARIANTS
      },
      () => this.#rng()
    )
    if (decision.class === 'NONE') {
      // todo "não" vai à timeline com o motivo (o painel explica por que nada tocou)
      skip(decision.reason)
      return
    }
    this.#lastInterjectAt = decision.decidedAt
    this.#lastInterjectVariant = {
      ...this.#lastInterjectVariant,
      [decision.class]: decision.variant
    }
    void this.#playInterjection(decision.class, decision.variant, decision.decidedAt, obs)
  }

  /**
   * Backchannel do usuário durante a reprodução (fala curta — não cancelou nada nem virou turno):
   * só registra na timeline (calibração das regras de barge-in).
   */
  backchannel(input: { ms: number }): void {
    if (!this.#sessionId) return
    this.#emitTimeline({ ts: this.#now(), kind: 'backchannel', speechMs: finiteMs(input?.ms) })
  }

  /**
   * Falha externa do turno (ex.: `gatedSend` recusou a mensagem): mostra o erro na UI e devolve o
   * turno ao repouso (sem isso a máquina ficaria em "Pensando…" para sempre).
   */
  reportError(error: string): VoiceCallState {
    if (!this.#sessionId) return this.state()
    this.#error = error
    this.#machine.sendFailed()
    this.#emitState()
    return this.state()
  }

  /** Estado atual (também emitido em cada transição). */
  state(): VoiceCallState {
    return {
      active: !!this.#sessionId,
      chatId: this.#chatId,
      sessionId: this.#sessionId,
      phase: this.#machine.phase,
      muted: this.#muted,
      turnSilenceMs: this.#turnSilenceMs,
      turnTiming: this.#turnTiming,
      pendingText: this.#machine.pendingText,
      error: this.#sessionId ? this.#error : this.#endedReason,
      // aditivo: só presente durante o preparo da GPU (estados sem GPU ficam iguais aos de antes)
      ...(this.#sessionId && this.#preparing ? { preparing: this.#preparing } : {}),
      // aditivo: id e início da chamada ativa (relógio da barra; marcadores no histórico)
      ...(this.#sessionId && this.#meter
        ? { callId: this.#meter.callId, startedAt: this.#meter.startedAt }
        : {})
    }
  }

  /**
   * Fase de preparo da GPU local (subida/aquecimento do servidor antes do microfone abrir):
   * `text` = andamento legível; null = pronta. Sem chamada ativa não faz nada.
   */
  setPreparing(text: string | null): VoiceCallState {
    if (!this.#sessionId) return this.state()
    const next = typeof text === 'string' && text.trim() ? text.trim() : null
    if (next !== this.#preparing) {
      this.#preparing = next
      this.#emitState()
    }
    return this.state()
  }

  /**
   * Overrides de request do turno em andamento (fonte registrada por `setVoiceCallSource`; o
   * runner aplica com `applyVoiceCallConfig`). Null = fora da chamada (turno de texto normal).
   */
  callContextFor(
    chat: Pick<Chat, 'id' | 'config'>,
    session: Pick<Session, 'id' | 'depth'>
  ): ResolvedVoiceCall | null {
    if (!this.#sessionId || session.id !== this.#sessionId) return null
    if (chat.id !== this.#chatId) return null
    const r = this.#resolved()
    return this.#meter
      ? {
          ...r,
          callId: this.#meter.callId,
          ...(this.#meter.tts.model ? { ttsModel: this.#meter.tts.model } : {})
        }
      : r
  }

  #resolved(): ResolvedVoiceCall {
    return this.#resolvedFor(this.#chatId)
  }

  #resolvedFor(chatId: string | null): ResolvedVoiceCall {
    const cfg = chatId ? this.#deps.chatConfig(chatId) : null
    const persona = chatId ? (this.#deps.personaVoice?.(chatId) ?? null) : null
    return resolveVoiceCallConfig(cfg?.voice ?? null, this.#deps.settings().defaults, persona)
  }

  // ---------------- turno continuado / barge-in (histórico só com o ouvido) ----------------

  /** Retém a resposta: frases emitidas-e-descartadas + fila + em voo voltam à memória (texto). */
  #beginHold(droppedIds: string[]): void {
    if (this.#holdAnswer) return
    this.#holdAnswer = true
    // nada foi ouvido: TODAS as frases do turno (descartadas no renderer, na fila, em síntese)
    for (const id of droppedIds) this.#uttKey.delete(id)
    this.#heldTexts = [...this.#keyText.keys()]
      .sort((a, b) => a - b)
      .map((key) => ({ key, text: this.#keyText.get(key) ?? '' }))
      .filter((h) => h.text.trim())
    this.#clearSynth()
    this.#agentSpoke = false
    this.#playbackActive = false
  }

  /** Fala sem texto (ruído): a resposta retida volta a ser falada, na ordem. */
  #releaseHold(): void {
    if (!this.#holdAnswer) return
    this.#holdAnswer = false
    const held = this.#heldTexts
    this.#heldTexts = []
    for (const h of held) this.#enqueueSynth(h.text, h.key)
  }

  /**
   * Turno continuado: o usuário voltou a falar antes de ouvir a resposta. Para o turno do agente,
   * tira do histórico o turno anterior (ou só as respostas não ouvidas, com tools já executadas) e
   * envia a fala anterior + a nova como UM turno.
   */
  async #continueTurn(text: string): Promise<void> {
    const sessionId = this.#sessionId
    const prev = this.#turn
    this.#holdAnswer = false
    this.#heldTexts = []
    this.#speakCancelled = true
    this.#clearSynth()
    this.#resetFiller(true)
    this.#machine.suspend()
    this.#machine.turnArrived(text) // vira o pendente (suspenso: nada sai antes do ajuste)
    const canMerge = !!prev?.userMessageId && !prev.toolsRan && !!this.#deps.amendTurn
    const merged = canMerge && prev ? `${prev.text.trim()} ${text}`.trim() : text
    // a fala anterior volta no turno unido: a duração dela soma no `meta.voice` do reenvio
    if (canMerge && prev?.voice?.durationMs) this.#speechAcc.audioMs += prev.voice.durationMs
    this.#machine.replacePending(merged)
    this.#emitTimeline({
      ts: this.#now(),
      kind: 'turn-continued',
      text: merged.slice(0, EVAL_TAIL_MAX_CHARS),
      reason: canMerge ? 'merged' : prev?.toolsRan ? 'tools-ran' : 'next-turn'
    })
    try {
      if (sessionId && prev?.userMessageId && this.#deps.amendTurn) {
        await this.#deps.amendTurn(sessionId, {
          userMessageId: prev.userMessageId,
          dropUser: canMerge,
          spoken: () => this.#spokenMap(new Set())
        })
        this.#emitTimeline({ ts: this.#now(), kind: 'turn-amended', reason: 'continued' })
      }
    } catch (e) {
      this.#error = e instanceof Error ? e.message : String(e)
    } finally {
      if (this.#sessionId === sessionId) {
        this.#machine.resume()
        this.#emitState()
      }
    }
  }

  /**
   * Interrompe a resposta no meio (barge-in): para a fala e o turno do agente e trunca o histórico
   * ao que foi falado (`played` = utterances de sentença ouvidas).
   */
  #interruptAnswer(played: string[]): void {
    this.#speakCancelled = true
    this.#holdAnswer = false
    this.#heldTexts = []
    this.#clearSynth()
    const sessionId = this.#sessionId
    const turn = this.#turn
    if (!sessionId || !turn?.userMessageId || !this.#deps.amendTurn) return
    const heard = new Set(played)
    const spoken = (): Record<string, string[]> => this.#spokenMap(heard)
    this.#machine.suspend()
    void this.#deps
      .amendTurn(sessionId, { userMessageId: turn.userMessageId, dropUser: false, spoken })
      .then(() => this.#emitTimeline({ ts: this.#now(), kind: 'turn-amended', reason: 'barge-in' }))
      .catch((e: unknown) => {
        this.#error = e instanceof Error ? e.message : String(e)
      })
      .finally(() => {
        if (this.#sessionId === sessionId) {
          this.#machine.resume()
          this.#emitState()
        }
      })
  }

  /** Sentenças ouvidas por mensagem do assistente (só as utterances em `played`). */
  #spokenMap(played: Set<string>): Record<string, string[]> {
    const heardKeys = new Set<number>()
    for (const [id, key] of this.#uttKey) if (played.has(id)) heardKeys.add(key)
    const out: Record<string, string[]> = {}
    for (const [msgId, keys] of this.#msgKeys) {
      out[msgId] = keys.filter((k) => heardKeys.has(k)).map((k) => this.#keyText.get(k) ?? '')
    }
    return out
  }

  // ---------------- eventos do runner (streaming/histórico) ----------------

  #onAgentEvent(e: AgentEvent): void {
    // marcador de fim adiado: grava quando a sessão da chamada encerrada fica ociosa
    const pend = this.#pendingEnd
    if (
      pend &&
      e.type === 'session-updated' &&
      e.session.id === pend.sessionId &&
      !isBusyStatus(e.session.status)
    )
      this.#flushPendingEnd()
    const sessionId = this.#sessionId
    if (!sessionId) return
    if (e.type === 'draft') {
      if (e.sessionId === sessionId && e.draft) {
        this.#feedContent(e.draft.content)
        this.#ttsFeedPartial() // [tts-feed] a sentença incompleta segue para o TTS
      }
      return
    }
    if (e.type === 'message-added') {
      const m: StoredMessage = e.message
      if (m.sessionId !== sessionId) return
      if (m.message.role === 'user') {
        // novo turno (falado, digitado ou drenado da fila): a próxima resposta volta a ser falada
        const text =
          typeof m.message.content === 'string'
            ? m.message.content
            : m.message.content
                .map((p) => (p.type === 'text' ? p.text : ''))
                .join(' ')
                .trim()
        this.#resetResponse()
        this.#turn = { text, userMessageId: m.id, toolsRan: false }
        this.#machine.responseBegan()
        this.#armFiller(text) // turno disparado também por mensagem digitada durante a chamada
        return
      }
      if (m.message.role === 'assistant' && !isDisplayOnly(m.meta)) {
        for (const tc of m.message.tool_calls ?? [])
          if (tc.function.name === 'end_call') this.#endCallIds.add(tc.id)
        this.#flushMessage(typeof m.message.content === 'string' ? m.message.content : '', m.id)
      } else if (
        m.message.role === 'tool' &&
        this.#endCallIds.has(m.message.tool_call_id) &&
        m.meta?.toolStatus === 'ok'
      ) {
        // o agente encerrou a chamada: cai quando a despedida terminar de tocar
        this.#endCallIds.delete(m.message.tool_call_id)
        this.#armHangup(m.message.tool_call_id)
      } else if (m.message.role === 'assistant' && m.meta?.kind === 'error') {
        // o turno do agente falhou de vez (erro persistido — o card de nova tentativa, quando há,
        // já foi dispensado): a chamada não fica "ativa" sem resposta
        const why =
          typeof m.meta.error === 'string' ? m.meta.error : String(m.message.content ?? '')
        this.#endWithError({
          fatal: true,
          reason: `o modelo falhou: ${why.slice(0, 160)}`,
          detail: why
        })
      }
      return
    }
    if (e.type === 'session-updated' && e.session.id === sessionId) {
      if (!isBusyStatus(e.session.status)) {
        this.#machine.responseDone()
        // [tts-feed] a resposta acabou: o contexto do TTS em streaming fecha (a última frase termina)
        this.#ttsFeedCall((f) => f.end?.())
        if (this.#checkHangup()) return
      }
      this.#emitState()
      return
    }
    if (e.type === 'tool-running' && e.sessionId === sessionId && e.running) {
      if (this.#turn) this.#turn.toolsRan = true
      // tools em execução no turno: a espera tende a longa → o preâmbulo sai já (1 por turno)
      this.#filler.toolsRunning = true
      if (this.#filler.turnStartedAt != null && this.#fillerContext === 'generic')
        this.#fillerContext = 'command'
      void this.#tryFiller()
    }
  }

  /**
   * Conteúdo acumulado do passo atual (draft). Crescimento = novo texto; rewind (retry de rede) é
   * ignorado (monotônico — nunca fala a mesma coisa duas vezes); conteúdo desconexo = passo novo.
   */
  #feedContent(content: string): void {
    if (content.length >= this.#lastContent.length && content.startsWith(this.#lastContent)) {
      const delta = content.slice(this.#lastContent.length)
      this.#lastContent = content
      if (delta) this.#pushFeed(delta, false)
      return
    }
    if (this.#lastContent.startsWith(content)) return // rewind: mantém a monotonicidade
    // passo novo (ex.: depois de tools): o conteúdo vem do zero
    this.#lastContent = content
    this.#pushFeed(content, false)
  }

  /** Flush autoritativo do passo (message-added): o que faltou do conteúdo + o rabo sem pontuação. */
  #flushMessage(content: string, messageId: string): void {
    if (content.length > this.#lastContent.length && content.startsWith(this.#lastContent)) {
      this.#pushFeed(content.slice(this.#lastContent.length), true)
    } else {
      this.#pushFeed('', true)
    }
    this.#lastContent = ''
    this.#feed = ''
    // as sentenças do passo pertencem a esta mensagem (histórico truncado ao falado)
    this.#msgKeys.set(messageId, [...(this.#msgKeys.get(messageId) ?? []), ...this.#stepKeys])
    this.#stepKeys = []
  }

  #pushFeed(delta: string, final: boolean): void {
    this.#feed += delta
    for (;;) {
      const { sentences, rest } = splitSentences(this.#feed, {
        final,
        // 1º pedaço da resposta: a vírgula também corta (o TTS por sentença começa antes) — NÃO
        // com o TTS de texto em streaming ([tts-feed], ElevenLabs por WebSocket): lá o texto já
        // gera antes do corte e a vírgula partia a 1ª frase em duas (prosódia quebrada no meio)
        ...(this.#sentencesThisTurn === 0 && !this.#hasTtsFeed()
          ? { commaCutMin: FIRST_CHUNK_COMMA_MIN }
          : {})
      })
      for (const s of sentences) this.#queueSentence(s)
      this.#feed = rest
      if (!this.#feed.trim()) {
        this.#feed = ''
        return
      }
      if (!sentences.length) {
        // fim da resposta sem pontuação: o resto inteiro vira uma utterance (só no flush final;
        // em streaming o rabo SEM fronteira fica no feed para o próximo delta — senão o texto
        // parcial se perdia quando um delta terminava exatamente numa marca)
        if (final) {
          this.#queueSentence(this.#feed.trim())
          this.#feed = ''
        }
        return
      }
      if (!final) return // em streaming o resto espera o próximo delta
    }
  }

  // ---------------- síntese por sentença (ordem garantida, sem sobreposição) ----------------

  #queueSentence(text: string): void {
    if (!text.trim()) return
    const key = ++this.#keySeq
    this.#keyText.set(key, text)
    this.#stepKeys.push(key)
    this.#sentencesThisTurn++
    if (this.#speakCancelled) return
    if (this.#holdAnswer) {
      this.#heldTexts.push({ key, text })
      return
    }
    this.#enqueueSynth(text, key)
  }

  #enqueueSynth(text: string, key: number): void {
    this.#ttsFeedCall((f) => f.cut(text)) // [tts-feed] corte → flush já (antes do synth na fila)
    this.#machine.synthEnqueued()
    this.#synthQueue.push({ text, gen: this.#synthGen, key, attempt: 0 })
    void this.#pumpSynth()
  }

  #clearSynth(): void {
    this.#ttsFeedCall((f) => f.reset()) // [tts-feed] barge-in/parar/retenção: descarta o preparado
    this.#synthGen++
    this.#synthQueue = []
    this.#synthAbort?.abort()
    this.#synthAbort = null
    this.#machine.synthCleared() // sentenças descartadas nunca viram utterance
  }

  async #pumpSynth(): Promise<void> {
    if (this.#synthRunning) return
    this.#synthRunning = true
    const runGen = this.#synthGen
    try {
      while (this.#synthQueue.length && runGen === this.#synthGen) {
        const item = this.#synthQueue.shift()!
        const abort = new AbortController()
        this.#synthAbort = abort
        // caracteres enviados à síntese (cada tentativa é cobrada pelo provedor)
        if (this.#meter) this.#meter.tts.chars += item.text.length
        let audio: Uint8Array
        let mime: string
        try {
          const r = await this.#deps.synth(item.text, abort.signal)
          audio = r.audio
          mime = r.mime
        } catch (e) {
          if (abort.signal.aborted) continue // descartada (barge-in/stop): segue a fila
          // falha de TTS numa sentença: nunca calada — transitória (rede, 5xx, 429 sem cota) tenta
          // de novo UMA vez; fatal (chave, créditos, voz/modelo inválido) ou a 2ª falha encerram a
          // chamada com o motivo (o histórico fica só com o que foi emitido para tocar)
          const f = this.#classify(e, 'tts')
          if (!f) continue
          if (!f.fatal && item.attempt === 0 && item.gen === this.#synthGen) {
            this.#emitTimeline({
              ts: this.#now(),
              kind: 'playback-error',
              class: 'tts-retry',
              reason: f.detail
            })
            this.#synthQueue.unshift({ ...item, attempt: 1 })
            continue
          }
          this.#machine.synthSkipped()
          this.#endWithError(f)
          return
        }
        if (this.#synthAbort === abort) this.#synthAbort = null
        if (item.gen !== this.#synthGen) continue // descartada enquanto sintetizava
        this.#transientStrike = false // sentença sintetizada: a falta transitória anterior caduca
        this.#uttSeq++
        // 1ª frase pronta: o preâmbulo não sai mais (se já está tocando, a frase ESPERA ele terminar
        // na fila do renderer — nunca corta no meio da palavra)
        this.#filler.spokenThisTurn = true
        if (this.#fillerTimer) {
          clearTimeout(this.#fillerTimer)
          this.#fillerTimer = null
          // a resposta ficou pronta antes da espera do preâmbulo: dispensado
          this.#emitTimeline({
            ts: this.#now(),
            kind: 'decision',
            class: 'FILLER',
            played: false,
            reason: 'fast-answer'
          })
        }
        this.#agentSpoke = true
        this.#playbackActive = true
        this.#machine.utteranceEmitted()
        const id = `u${this.#uttSeq}`
        this.#uttKey.set(id, item.key)
        this.#deps.emitUtterance({ id, audio, mime, kind: 'sentence' })
        this.#emitTimeline({
          ts: this.#now(),
          kind: 'sentence-emitted',
          id,
          text: item.text.slice(0, EVAL_TAIL_MAX_CHARS)
        })
      }
    } finally {
      this.#synthRunning = false
      // itens chegaram enquanto a fila foi descartada (ou pump cancelado): retoma
      if (this.#synthQueue.length) void this.#pumpSynth()
      else this.#checkHangup()
    }
  }

  // ---------------- [tts-feed] ganchos do TTS de entrada em streaming ----------------

  /** Chama o feed (se houver) sem nunca derrubar a chamada. */
  #ttsFeedCall(fn: (feed: TtsTextFeed) => void): void {
    try {
      const feed = this.#deps.ttsFeed?.() ?? null
      if (feed) fn(feed)
    } catch (e) {
      console.warn('[clearchat] voz: tts-feed falhou:', e instanceof Error ? e.message : e)
    }
  }

  /** Há TTS de texto em streaming nesta chamada? */
  #hasTtsFeed(): boolean {
    try {
      return !!this.#deps.ttsFeed?.()
    } catch {
      return false
    }
  }

  /** Sentença ainda incompleta → TTS (só com a resposta sendo falada). */
  #ttsFeedPartial(): void {
    if (this.#speakCancelled || this.#holdAnswer || !this.#feed.trim()) return
    const rest = this.#feed
    this.#ttsFeedCall((f) => f.partial(rest))
  }

  // ---------------- [/tts-feed] ----------------

  #resetResponse(): void {
    this.#ttsFeedCall((f) => f.begin()) // [tts-feed] turno novo: pré-abre a conexão
    this.#lastContent = ''
    this.#feed = ''
    this.#speakCancelled = false
    this.#holdAnswer = false
    this.#heldTexts = []
    this.#error = null
    this.#agentSpoke = false
    this.#keyText = new Map()
    this.#stepKeys = []
    this.#msgKeys = new Map()
    this.#uttKey = new Map()
    this.#sentencesThisTurn = 0
    this.#resetFiller(true) // turno novo: o filler do turno anterior (se tocando) é cancelado
  }

  // ---------------- preâmbulo pós-turno (regra v2 — SPEC → "Fillers") ----------------

  /** Espera do preâmbulo (deps → global → padrão; 0 = já). */
  #fillerDelay(): number {
    const d = this.#deps.fillerDelayMs ?? this.#deps.settings().defaults.fillers?.delayMs
    return typeof d === 'number' && Number.isFinite(d) && d >= 0 ? d : DEFAULT_FILLER_DELAY_MS
  }

  /**
   * Arma o preâmbulo do turno: depois de `delayMs` (padrão 250 ms) sem a 1ª frase da resposta
   * pronta — ou já, com tools em execução — toca UM clipe `FILLER` escolhido pelo contexto da fala
   * (pergunta/comando/correção/pedido longo), sem repetir os últimos usados. Fala curta demais
   * ("oi", "valeu") não ganha preâmbulo. Em modo sombra decide mas não toca.
   */
  #armFiller(text: string): void {
    this.#resetFiller(true)
    const resolved = this.#resolved()
    this.#fillerContext = classifyFillerContext(text)
    const short = fillerTooShort(text)
    this.#filler = {
      turnStartedAt: this.#now(),
      toolsRunning: false,
      spokenThisTurn: false,
      usedThisTurn: short,
      responseInFlight: true,
      enabled: resolved.fillers.enabled
    }
    if (short || !resolved.fillers.enabled) {
      // o painel explica por que não houve preâmbulo neste turno
      this.#emitTimeline({
        ts: this.#now(),
        kind: 'decision',
        class: 'FILLER',
        played: false,
        reason: !resolved.fillers.enabled ? 'disabled' : 'short-speech'
      })
      return
    }
    const delay = this.#fillerDelay()
    this.#fillerTimer = setTimeout(() => this.#onFillerTimer(), delay)
  }

  /**
   * Timer do filler disparou: timers podem sair ~1 ms adiantados (Node) — o atraso ainda não
   * cumprido é reagendado; cumprido (ou com tool em execução), tenta disparar.
   */
  #onFillerTimer(): void {
    this.#fillerTimer = null
    const delay = this.#fillerDelay()
    const started = this.#filler.turnStartedAt
    if (started != null && !this.#filler.toolsRunning) {
      const remaining = started + delay - this.#now()
      if (remaining > 0) {
        this.#fillerTimer = setTimeout(() => this.#onFillerTimer(), remaining)
        return
      }
    }
    void this.#tryFiller()
  }

  /** Tenta disparar o preâmbulo deste turno (idempotente — `usedThisTurn` segura 1 por turno). */
  async #tryFiller(): Promise<void> {
    if (!this.#sessionId) return
    if (!fillerShouldFire(this.#filler, this.#now(), this.#fillerDelay())) return
    // assistente audível (fila de turnos: resposta anterior ainda falando) — não interrompe
    if (this.#playbackActive) return
    this.#filler.usedThisTurn = true
    const decidedAt = this.#now()
    const ctx = this.#fillerContext
    const base = this.#filler.toolsRunning ? 'tools' : 'delay'
    const gen = this.#fillerGen
    const resolved = this.#resolved()
    const pool = resolveFillerPool(this.#deps.settings().defaults.fillers?.pool ?? null)
    // a frase do contexto fora das recentes; clipe ausente tenta outras (até 3)
    let clip: { audio: Uint8Array; mime: string } | null = null
    let idx: number | null = null
    const tried: number[] = []
    for (let attempt = 0; attempt < 3; attempt++) {
      const cand = pickFillerPhrase(pool, ctx, [...this.#fillerRecent, ...tried], () => this.#rng())
      if (cand == null || tried.includes(cand)) break
      tried.push(cand)
      idx = cand
      clip = await this.#deps.clip('FILLER', cand + 1)
      if (clip || gen !== this.#fillerGen) break
    }
    if (gen !== this.#fillerGen || !this.#sessionId) return // reset/stop durante a carga
    const n = idx != null ? idx + 1 : 0
    // 1ª frase chegou (ou a resposta caiu) durante a carga do clipe: não toca mais
    const blocked = this.#filler.spokenThisTurn || !this.#filler.responseInFlight
    const shadow = resolved.interjections.shadow
    const played = !!clip && !shadow && !blocked
    const reason = played
      ? `${base}/${ctx}`
      : !clip
        ? `${base}/no-clip`
        : blocked
          ? `${base}/spoken`
          : `${base}/shadow`
    this.#emitTimeline({
      ts: this.#now(),
      kind: 'decision',
      class: 'FILLER',
      variant: n,
      played,
      latencyMs: Math.max(0, this.#now() - decidedAt),
      reason
    })
    this.#deps.logEval({
      ts: this.#now(),
      kind: 'filler',
      class: 'FILLER',
      variant: Math.max(1, n),
      played,
      shadow,
      speechMs: null,
      pauseMs: null,
      tail: null,
      latencyMs: Math.max(0, this.#now() - decidedAt),
      reason
    })
    if (!played || !clip || idx == null) return
    this.#fillerRecent = [...this.#fillerRecent, idx].slice(-FILLER_RECENT_WINDOW)
    this.#uttSeq++
    const id = `u${this.#uttSeq}`
    this.#fillerUttId = id
    this.#playbackActive = true
    this.#deps.emitUtterance({ id, audio: clip.audio, mime: clip.mime, kind: 'filler' })
    this.#emitTimeline({ ts: this.#now(), kind: 'clip-emitted', class: 'FILLER', id, variant: n })
  }

  /**
   * Interjeição decidida: carrega o clipe e toca na mesma fila de utterances (ganho
   * `interjections.volume`) — a decisão que chega > `INTERJECTION_MAX_AGE_MS` tarde demais é
   * descartada (o momento da pausa passou). Em modo sombra decide mas não toca.
   */
  async #playInterjection(
    cls: string,
    variant: number,
    decidedAt: number,
    obs: InterjectionObservation
  ): Promise<void> {
    const resolved = this.#resolved()
    const clip = await this.#deps.clip(cls as ClipClass, variant)
    const now = this.#now()
    const latencyMs = Math.max(0, now - decidedAt)
    const stale = latencyMs > INTERJECTION_MAX_AGE_MS
    const shadow = resolved.interjections.shadow
    const blocked =
      this.#playbackActive ||
      (this.#agentSpoke && this.#machine.responseInFlight) ||
      this.#machine.phase !== 'listening'
    const played = !!clip && !shadow && !stale && !blocked && !!this.#sessionId
    const reason = played
      ? 'ok'
      : !this.#sessionId
        ? 'stopped'
        : !clip
          ? 'no-clip'
          : stale
            ? 'stale'
            : blocked
              ? 'blocked'
              : 'shadow'
    this.#emitTimeline({
      ts: now,
      kind: 'decision',
      class: cls,
      variant,
      played,
      latencyMs,
      speechMs: obs.speechMs,
      pauseMs: obs.pauseMs,
      text: obs.tail,
      reason
    })
    this.#deps.logEval({
      ts: now,
      kind: 'interjection',
      class: cls,
      variant,
      played,
      shadow,
      speechMs: obs.speechMs,
      pauseMs: obs.pauseMs,
      tail: obs.tail,
      latencyMs,
      reason
    })
    if (!played || !clip) return
    this.#uttSeq++
    const id = `u${this.#uttSeq}`
    this.#interjectUtt = { id, cls, n: variant }
    this.#playbackActive = true
    const gain = resolved.interjections.volume
    this.#deps.emitUtterance({
      id,
      audio: clip.audio,
      mime: clip.mime,
      kind: 'interjection',
      ...(typeof gain === 'number' && gain < 1 ? { gain } : {})
    })
    this.#emitTimeline({ ts: now, kind: 'clip-emitted', class: cls, id, variant })
  }

  /** Zera o filler do turno (timer/carga em voo); `cancelPlaying` cancela o clipe tocando. */
  #resetFiller(cancelPlaying: boolean): void {
    if (this.#fillerTimer) {
      clearTimeout(this.#fillerTimer)
      this.#fillerTimer = null
    }
    this.#fillerGen++
    this.#filler = { ...EMPTY_FILLER_STATE }
    const id = this.#fillerUttId
    this.#fillerUttId = null
    if (cancelPlaying && id) {
      this.#deps.emitUtteranceCancel(id)
      this.#emitTimeline({ ts: this.#now(), kind: 'clip-cancelled', class: 'FILLER', id })
    }
  }

  /** Cancela a interjeição tocando (usuário voltou a falar / stop da chamada). */
  #cancelInterject(): void {
    const u = this.#interjectUtt
    this.#interjectUtt = null
    if (u) {
      this.#deps.emitUtteranceCancel(u.id)
      this.#emitTimeline({ ts: this.#now(), kind: 'clip-cancelled', class: u.cls, id: u.id })
    }
  }

  // ---------------- histórico e custos (marcadores, meta.voice) ----------------

  /**
   * Transcrição final da fala do usuário (o IPC repassa `voice:transcribe:stop` do dono da
   * chamada, ANTES do `turn`): duração/modelo da fala e o tempo de fala da chamada.
   */
  noteTranscript(r: VoiceCallTranscript): void {
    if (!this.#sessionId || !this.#meter) return
    const audioMs = finiteMs(r?.audioMs)
    if (typeof r?.text === 'string' && r.text.trim()) this.#meter.userSpeechMs += audioMs
    if (r?.backend === 'local') this.#meter.stt.localRequests++
    this.#lastTranscript = {
      text: typeof r?.text === 'string' ? r.text : '',
      ...(typeof r?.model === 'string' && r.model ? { model: r.model } : {}),
      ...(r?.backend ? { backend: r.backend } : {}),
      audioMs
    }
  }

  /** Uma transcrição pela API durante a chamada (parcial/especulação/segmento/final). */
  noteSttApiUsage(u: { local?: boolean; audioMs?: number | null; cost?: number }): void {
    const m = this.#meter
    if (!this.#sessionId || !m) return
    if (u?.local) {
      m.stt.localRequests++
      return
    }
    m.stt.apiRequests++
    m.stt.apiAudioMs += finiteMs(u?.audioMs)
    if (typeof u?.cost === 'number' && Number.isFinite(u.cost) && u.cost >= 0) {
      m.stt.cost = (m.stt.cost ?? 0) + u.cost
      m.stt.costedRequests++
    }
  }

  /** Áudio de resposta gerado pela síntese (ms — o IPC mede PCM/WAV das frases emitidas). */
  noteTtsAudio(ms: number): void {
    if (!this.#sessionId || !this.#meter) return
    this.#meter.tts.audioMs += finiteMs(ms)
  }

  /** `meta.voice` da próxima mensagem do usuário (consome o acumulado das falas). */
  #takeSpeechMeta(): VoiceMessageMeta {
    const acc = this.#speechAcc
    this.#speechAcc = { audioMs: 0 }
    const v: VoiceMessageMeta = { source: 'call' }
    if (this.#meter) v.callId = this.#meter.callId
    if (acc.audioMs > 0) v.durationMs = Math.round(acc.audioMs)
    const model = acc.model ?? this.#meter?.stt.model
    if (model) v.sttModel = model
    return v
  }

  /** Começa a medição e grava o marcador de início. */
  #beginMeter(sessionId: string): void {
    this.#flushPendingEnd() // marcador de fim de uma chamada anterior ainda adiado: grava antes
    const { stt, tts } = this.#deps.settings()
    const callId = this.#deps.newCallId?.() ?? crypto.randomUUID()
    const startedAt = this.#now()
    const sttModel =
      stt.mode === 'local'
        ? stt.local?.model || stt.local?.engine
        : stt.mode === 'gpu'
          ? 'whisper (GPU local)'
          : stt.api?.model
    const ttsBackend: VoiceCallUsage['tts']['backend'] =
      tts.backend === 'gpu'
        ? 'gpu'
        : tts.backend === 'local'
          ? 'local'
          : tts.api?.providerKind === 'elevenlabs'
            ? 'elevenlabs'
            : 'api'
    const ttsModel =
      ttsBackend === 'gpu'
        ? (tts.gpu?.engine ?? 'GPU local')
        : ttsBackend === 'local'
          ? tts.local?.engine
          : tts.api?.model
    this.#meter = {
      callId,
      sessionId,
      startedAt,
      turns: 0,
      userSpeechMs: 0,
      stt: {
        mode: stt.mode,
        ...(sttModel ? { model: sttModel } : {}),
        apiRequests: 0,
        apiAudioMs: 0,
        localRequests: 0,
        costedRequests: 0
      },
      tts: { backend: ttsBackend, ...(ttsModel ? { model: ttsModel } : {}), chars: 0, audioMs: 0 }
    }
    this.#lastTranscript = null
    this.#speechAcc = { audioMs: 0 }
    this.#endCallIds = new Set()
    const mark: VoiceCallMark = { callId, phase: 'start', startedAt }
    this.#writeMarker(sessionId, CALL_START_TEXT, mark)
  }

  /** Fecha a medição e grava o marcador de fim (adiado enquanto o turno do agente roda). */
  #endMeter(by: VoiceCallEndedBy, reason: string | null, immediate = false): void {
    const m = this.#meter
    this.#meter = null
    if (!m) return
    const endedAt = this.#now()
    const write = (): void => {
      const usage: VoiceCallUsage = {
        turns: m.turns,
        userSpeechMs: Math.round(m.userSpeechMs),
        stt: { ...m.stt },
        tts: { ...m.tts },
        llm: this.#llmUsage(m.sessionId, m.callId)
      }
      if (m.tts.backend === 'api' && m.tts.chars > 0) {
        const price = safeCall(() => this.#deps.ttsUnitPrice?.() ?? null, null)
        if (typeof price === 'number' && Number.isFinite(price) && price >= 0) {
          usage.tts.cost = m.tts.chars * price
          usage.tts.estimated = true
        }
      }
      const mark: VoiceCallMark = {
        callId: m.callId,
        phase: 'end',
        startedAt: m.startedAt,
        endedAt,
        durationMs: Math.max(0, endedAt - m.startedAt),
        endedBy: by,
        ...(reason ? { reason: reason.slice(0, 300) } : {}),
        usage
      }
      this.#writeMarker(m.sessionId, callEndText(mark), mark)
    }
    const busy = !immediate && safeCall(() => !!this.#deps.sessionInfo(m.sessionId)?.busy, false)
    if (!busy) {
      write()
      return
    }
    // o turno do agente ainda roda (ex.: encerrou no meio da resposta): o marcador entra depois
    // dele — nunca no meio de um passo; no máximo 5 min de espera
    this.#flushPendingEnd()
    const timer = setTimeout(() => this.#flushPendingEnd(), 5 * 60_000)
    ;(timer as { unref?: () => void }).unref?.()
    this.#pendingEnd = { sessionId: m.sessionId, write, timer }
  }

  /** App fechando: o marcador de fim adiado (turno ainda rodando) é gravado já. */
  flushPendingMarkers(): void {
    this.#flushPendingEnd()
  }

  #flushPendingEnd(): void {
    const p = this.#pendingEnd
    if (!p) return
    this.#pendingEnd = null
    clearTimeout(p.timer)
    p.write()
  }

  /** Custo do LLM dos turnos da chamada (respostas com `meta.voice.callId`). */
  #llmUsage(sessionId: string, callId: string): VoiceCallUsage['llm'] {
    const out = { calls: 0, cost: 0, costed: 0 }
    const msgs = safeCall(
      () => this.#deps.sessionMessages?.(sessionId) ?? [],
      [] as StoredMessage[]
    )
    for (const m of msgs) {
      if (m.message.role !== 'assistant' || isDisplayOnly(m.meta)) continue
      if (m.meta?.voice?.callId !== callId) continue
      out.calls++
      const c = m.meta.usage?.cost
      if (typeof c === 'number' && Number.isFinite(c)) {
        out.cost += c
        out.costed++
      }
    }
    return out
  }

  #writeMarker(sessionId: string, content: string, mark: VoiceCallMark): void {
    try {
      this.#deps.appendMarker?.(sessionId, content, {
        synthetic: true,
        kind: 'voice-call',
        voiceCall: mark
      })
    } catch (e) {
      console.warn(
        '[clearchat] voz: marcador da chamada falhou:',
        e instanceof Error ? e.message : e
      )
    }
  }

  // ---------------- end_call: desligar depois de a despedida tocar ----------------

  /** O resultado ok de `end_call` chegou: a chamada cai quando a resposta terminar de tocar. */
  #armHangup(toolCallId: string): void {
    if (!this.#sessionId) return
    let reason: string | null = null
    try {
      const msgs = this.#deps.sessionMessages?.(this.#sessionId) ?? []
      for (const m of msgs) {
        const tc =
          m.message.role === 'assistant'
            ? m.message.tool_calls?.find((t) => t.id === toolCallId)
            : undefined
        if (!tc) continue
        const args = JSON.parse(tc.function.arguments || '{}') as { reason?: unknown }
        if (typeof args.reason === 'string' && args.reason.trim())
          reason = args.reason.trim().slice(0, 200)
      }
    } catch {
      reason = null
    }
    this.#hangup = { reason, timer: null }
    this.#emitTimeline({ ts: this.#now(), kind: 'hangup-armed', ...(reason ? { reason } : {}) })
    this.#checkHangup()
  }

  /** O usuário voltou a falar (barge-in/fala nova): o desligamento pedido pelo agente é cancelado. */
  #cancelHangup(why: string | null): void {
    const h = this.#hangup
    if (!h) return
    this.#hangup = null
    if (h.timer) clearTimeout(h.timer)
    if (why) this.#emitTimeline({ ts: this.#now(), kind: 'hangup-cancelled', reason: why })
  }

  /**
   * Desliga se o agente pediu e a despedida já tocou (resposta terminada, nada na síntese nem
   * tocando). Com a resposta terminada mas o áudio ainda tocando, arma a espera máxima. True =
   * a chamada caiu.
   */
  #checkHangup(): boolean {
    const h = this.#hangup
    if (!h || !this.#sessionId) return false
    if (this.#machine.responseInFlight) return false
    const audible =
      this.#playbackActive ||
      this.#synthRunning ||
      this.#synthQueue.length > 0 ||
      this.#machine.phase !== 'listening'
    if (audible) {
      if (!h.timer) {
        const wait = this.#deps.hangupMaxWaitMs ?? 30_000
        h.timer = setTimeout(() => {
          if (this.#hangup === h) this.#hangUpNow()
        }, wait)
        ;(h.timer as { unref?: () => void }).unref?.()
      }
      return false
    }
    this.#hangUpNow()
    return true
  }

  #hangUpNow(): void {
    const h = this.#hangup
    this.#hangup = null
    if (h?.timer) clearTimeout(h.timer)
    this.stop(undefined, { by: 'agent', note: h?.reason ?? null })
  }

  #now(): number {
    return this.#deps.now ? this.#deps.now() : Date.now()
  }

  #rng(): number {
    return this.#deps.rng ? this.#deps.rng() : Math.random()
  }

  #emitState(): void {
    this.#deps.emitState(this.state())
  }

  /** Registra um evento da timeline (só com chamada ativa). */
  #emitTimeline(event: VoiceCallTimelineEvent): void {
    if (!this.#sessionId) return
    this.#deps.emitTimeline(event)
  }
}
