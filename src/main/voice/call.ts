// Chamada de voz meia-duplex (Feature B) — o dono do turno no main, SEM Electron/UI/IPC (a fiação
// fica em `src/main/ipc.ts`; o renderer é o "sensor": captura contínua, fim de turno adaptativo e a
// reprodução). Ver SPEC.md → "Áudio → Chamada de voz (meia-duplex)".
//
// Um turno de voz = fala do usuário → transcrição final (sessão `voice:transcribe:*` do renderer;
// a especulativa reaproveitada quando o usuário não voltou a falar) → `turn(text)` envia pelo MESMO
// caminho do composer (`sendTurn` = runner.send — fila/⚡ respeitadas; o histórico é idêntico ao de
// um turno de texto) → preâmbulo curto (filler) → resposta em streaming → TTS POR SENTENÇA (a 1ª
// frase também corta na vírgula; bytes na ordem, sem sobreposição; a 1ª frase espera o preâmbulo
// terminar — nunca corta no meio da palavra) → próxima escuta.
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
import type { Chat, ChatConfig, Session, StoredMessage, AgentEvent } from '@shared/types'
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
import { CLIP_PHRASES, type ClipClass } from './clips'
import type { VoiceEvalEvent } from './evalLog'
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
  /** Envia a transcrição final como mensagem do usuário (mesmo caminho do composer). */
  sendTurn(sessionId: string, text: string): void
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
}

/** Turno do usuário em andamento (o que o histórico tem dele). */
interface TurnInfo {
  text: string
  userMessageId: string | null
  toolsRan: boolean
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
  // ---- feed do texto do assistente (por passo do loop; monotônico contra rewinds de retry) ----
  #lastContent = ''
  #feed = ''
  /** A resposta em andamento não é mais falada (barge-in/turno continuado). */
  #speakCancelled = false
  // ---- pipeline de síntese (serial; sentenças na ordem, sem sobreposição) ----
  #synthQueue: { text: string; gen: number; key: number }[] = []
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

  constructor(deps: VoiceCallDeps) {
    this.#deps = deps
    this.#machine = new VoiceTurnMachine((text) => {
      if (this.#sessionId) {
        // antes do envio: o `message-added` do usuário pode chegar DENTRO do sendTurn (síncrono)
        // e completar o id da mensagem
        this.#turn = { text, userMessageId: null, toolsRan: false }
        const before = this.#turn
        this.#deps.sendTurn(this.#sessionId, text)
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
    this.#turnSilenceMs = resolveTurnSilenceMs(defaults.turn, audioInput)
    this.#turnTiming = resolveTurnTiming(defaults.turn)
    this.#turn = null
    this.#carry = null
    this.#resetResponse()
    this.#machine.start(info.busy)
    this.#emitState()
    return this.state()
  }

  /** Sai da chamada (descarta fala pendente e para a fala do assistente). */
  stop(): VoiceCallState {
    if (!this.#sessionId) return this.state()
    this.#speakCancelled = true
    this.#clearSynth()
    this.#resetFiller(true)
    this.#cancelInterject()
    this.#machine.stop()
    this.#sessionId = null
    this.#chatId = null
    this.#muted = false
    this.#error = null
    this.#turn = null
    this.#carry = null
    this.#emitState()
    return this.state()
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
    // assistente calado: sem interjeição sobre a fala do assistente ou sobre a resposta em curso
    if (this.#playbackActive || this.#agentSpoke) return
    if (this.#machine.phase !== 'listening') return
    const resolved = this.#resolved()
    const now = this.#now()
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
      if (decision.reason === 'turn-end') {
        // registro do "não interrompe a pergunta" (calibração)
        this.#emitTimeline({
          ts: now,
          kind: 'decision',
          class: 'NONE',
          played: false,
          speechMs: obs.speechMs,
          pauseMs: obs.pauseMs,
          text: obs.tail,
          reason: 'turn-end'
        })
      }
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
      error: this.#error
    }
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
    return this.#resolved()
  }

  #resolved(): ResolvedVoiceCall {
    return this.#resolvedFor(this.#chatId)
  }

  #resolvedFor(chatId: string | null): ResolvedVoiceCall {
    const cfg = chatId ? this.#deps.chatConfig(chatId) : null
    return resolveVoiceCallConfig(cfg?.voice ?? null, this.#deps.settings().defaults)
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
    const sessionId = this.#sessionId
    if (!sessionId) return
    if (e.type === 'draft') {
      if (e.sessionId === sessionId && e.draft) this.#feedContent(e.draft.content)
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
        this.#flushMessage(typeof m.message.content === 'string' ? m.message.content : '', m.id)
      }
      return
    }
    if (e.type === 'session-updated' && e.session.id === sessionId) {
      if (!isBusyStatus(e.session.status)) this.#machine.responseDone()
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
        // 1º pedaço da resposta: a vírgula também corta (o TTS começa antes)
        ...(this.#sentencesThisTurn === 0 ? { commaCutMin: FIRST_CHUNK_COMMA_MIN } : {})
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
    this.#machine.synthEnqueued()
    this.#synthQueue.push({ text, gen: this.#synthGen, key })
    void this.#pumpSynth()
  }

  #clearSynth(): void {
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
        let audio: Uint8Array
        let mime: string
        try {
          const r = await this.#deps.synth(item.text, abort.signal)
          audio = r.audio
          mime = r.mime
        } catch (e) {
          if (abort.signal.aborted) continue // descartada (barge-in/stop): segue a fila
          // falha de TTS numa sentença: mostra o erro na UI e PULA só ela — o resto da resposta
          // continua sendo falado (o texto inteiro segue no histórico)
          this.#error = e instanceof Error ? e.message : String(e)
          this.#machine.synthSkipped()
          this.#emitState()
          continue
        }
        if (this.#synthAbort === abort) this.#synthAbort = null
        if (item.gen !== this.#synthGen) continue // descartada enquanto sintetizava
        this.#uttSeq++
        // 1ª frase pronta: o preâmbulo não sai mais (se já está tocando, a frase ESPERA ele terminar
        // na fila do renderer — nunca corta no meio da palavra)
        this.#filler.spokenThisTurn = true
        if (this.#fillerTimer) {
          clearTimeout(this.#fillerTimer)
          this.#fillerTimer = null
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
    }
  }

  #resetResponse(): void {
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
    if (short || !resolved.fillers.enabled) return
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
    const blocked = this.#playbackActive || this.#agentSpoke || this.#machine.phase !== 'listening'
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
