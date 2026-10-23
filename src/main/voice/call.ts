// Chamada de voz meia-duplex (Feature B, primeira parte) — o dono do turno no main, SEM
// Electron/UI/IPC (a fiação fica em `src/main/ipc.ts`; o renderer é o "sensor": captura contínua,
// silêncio que encerra o turno e a reprodução). Ver SPEC.md → "Áudio → Chamada de voz (meia-duplex)".
//
// Um turno de voz = fala do usuário → transcrição final (sessão `voice:transcribe:*` do renderer)
// → `turn(text)` envia pelo MESMO caminho do composer (`sendTurn` = runner.send — fila/⚡
// respeitadas; o histórico é idêntico ao de um turno de texto) → resposta em streaming → TTS POR
// SENTENCA (bytes completos, na ordem, sem sobreposição) → próxima escuta.
//
// A fala do assistente vem dos eventos do runner (`onAgentEvent`): `draft` (conteúdo acumulado em
// streaming, com monotonicidade por passo) e `message-added` (flush autoritativo do passo). Erros
// persistidos (`meta.kind 'error'`) NÃO são falados. Barge-in descarta a fala pendente de síntese
// e aborta a síntese em voo; o texto da resposta continua completo no histórico.
import type { Chat, ChatConfig, Session, StoredMessage, AgentEvent } from '@shared/types'
import type { VoiceCallTimelineEvent } from '@shared/ipc'
import { isDisplayOnly } from '@shared/context'
import {
  DEFAULT_TURN_SILENCE_MS,
  resolveTurnSilenceMs,
  resolveVoiceCallConfig,
  type AudioInputSettings,
  type ResolvedVoiceCall,
  type SttSettings,
  type TtsSettings,
  type VoiceCallDefaults,
  type VoiceCallState
} from '@shared/voice'
import {
  EMPTY_FILLER_STATE,
  EVAL_TAIL_MAX_CHARS,
  FILLER_DELAY_MS,
  INTERJECTION_MAX_AGE_MS,
  decideInterjection,
  fillerShouldFire,
  pickClipVariant,
  type FillerState,
  type InterjectionObservation
} from '@shared/voicePolicy'
import type { ClipClass } from './clips'
import type { VoiceEvalEvent } from './evalLog'
import { splitSentences } from './sentences'
import { VoiceTurnMachine, isBusyStatus } from './turnMachine'

/** Utterance falada (evento `voice:call:utterance`) — bytes completos de uma sentença/clip. */
export interface VoiceCallUtterance {
  id: string
  audio: Uint8Array
  mime: string
  /** Origem do áudio (sentença da resposta, filler ou interjeição); ausente = 'sentence'. */
  kind?: 'sentence' | 'filler' | 'interjection'
}

export interface VoiceCallSessionInfo {
  chatId: string
  depth: number
  busy: boolean
}

/** Número finito ≥ 0 arredondado (lixo/negativo → 0; nunca NaN/Infinity na timeline). */
const finiteMs = (v: unknown): number => {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : 0
  return n > 0 ? n : 0
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
  /** Cancela uma utterance no renderer (canal `voice:call:utterance-cancel` — filler interrompido). */
  emitUtteranceCancel(id: string): void
  /** Evento da timeline da chamada (canal `voice:call:timeline` — UI/métricas/calibração). */
  emitTimeline(event: VoiceCallTimelineEvent): void
  /** Registra uma decisão no log de avaliação (`<userData>/voice-eval/*.jsonl` — calibração). */
  logEval(event: VoiceEvalEvent): void
  /**
   * Bytes de um clipe pré-gerado (`resolveClip` — SPEC → "Serviço de TTS (clipes)");
   * null = clipe ausente (filler/interjeição não tocam — nada é sintetizado no lugar).
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
  /** Relógio em ms (padrão `Date.now`; injetável para testes de expiração/cooldown). */
  now?: () => number
  /** PRNG determinístico (padrão `Math.random`; injetável para testes de variante/probabilidade). */
  rng?: () => number
  /** Espera do filler antes da 1ª sentença (padrão `FILLER_DELAY_MS` — 1200 ms). */
  fillerDelayMs?: number
}

export class VoiceCallManager {
  readonly #deps: VoiceCallDeps
  readonly #machine: VoiceTurnMachine
  #sessionId: string | null = null
  #chatId: string | null = null
  #muted = false
  #turnSilenceMs: number = DEFAULT_TURN_SILENCE_MS
  #error: string | null = null
  // ---- feed do texto do assistente (por passo do loop; monotônico contra rewinds de retry) ----
  #lastContent = ''
  #feed = ''
  /** Barge-in: a resposta em andamento não é mais falada (o texto segue no histórico). */
  #speakCancelled = false
  // ---- pipeline de síntese (serial; sentenças na ordem, sem sobreposição) ----
  #synthQueue: { text: string; gen: number }[] = []
  #synthGen = 0
  #synthRunning = false
  #synthAbort: AbortController | null = null
  #uttSeq = 0
  // ---- fillers pós-turno (1 por turno; cancelado pela 1ª sentença da resposta) ----
  #filler: FillerState = { ...EMPTY_FILLER_STATE }
  #fillerTimer: ReturnType<typeof setTimeout> | null = null
  #fillerUttId: string | null = null
  /** Geração do filler (async): reset/stop/barge-in descartam a carga de clip em voo. */
  #fillerGen = 0
  #lastFillerVariant: number | null = null
  /** Reprodução em curso no renderer (utterance emitida e fila ainda não vazia). */
  #playbackActive = false
  /** O agente já falou algo no turno em andamento (sentença emitida). */
  #agentSpoke = false
  // ---- interjeições na fala do usuário (fase 2) ----
  #lastInterjectAt: number | null = null
  #lastInterjectVariant: Partial<Record<string, number>> = {}
  /** Última interjeição emitida (id + classe) — cancelada no stop da chamada. */
  #interjectUtt: { id: string; cls: string; n: number } | null = null

  constructor(deps: VoiceCallDeps) {
    this.#deps = deps
    this.#machine = new VoiceTurnMachine((text) => {
      if (this.#sessionId) {
        this.#deps.sendTurn(this.#sessionId, text)
        this.#emitTimeline({
          ts: this.#now(),
          kind: 'turn-sent',
          text: text.slice(0, EVAL_TAIL_MAX_CHARS)
        })
        this.#armFiller() // turno do usuário disparado: o filler entra se a resposta demorar
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

  /** O usuário começou a falar (durante a reprodução = barge-in/backchannel, tratado pelo renderer). */
  speechBegin(): VoiceCallState {
    if (!this.#sessionId) return this.state()
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
   * composer); com resposta em voo fica como PRÓXIMO turno (máx. 1 pendente).
   */
  turn(text: string): VoiceCallState {
    if (!this.#sessionId) return this.state()
    this.#error = null
    this.#machine.turnArrived(typeof text === 'string' ? text : '')
    this.#emitState()
    return this.state()
  }

  /** A fila de reprodução do renderer esvaziou. */
  playbackIdle(): VoiceCallState {
    if (!this.#sessionId) return this.state()
    this.#playbackActive = false
    this.#machine.playbackIdle()
    // filler segurado enquanto um clipe tocava (ex.: interjeição): tenta de novo agora
    void this.#tryFiller()
    this.#emitState()
    return this.state()
  }

  /** Barge-in: o usuário falou durante a reprodução — cancela a fala do assistente. */
  bargeIn(): VoiceCallState {
    if (!this.#sessionId) return this.state()
    this.#emitTimeline({ ts: this.#now(), kind: 'barge-in' })
    this.#speakCancelled = true
    this.#clearSynth()
    this.#playbackActive = false
    this.#resetFiller(true) // quem falou é o usuário: sem filler no meio da fala dele
    this.#machine.bargeIn()
    this.#emitState()
    return this.state()
  }

  /**
   * Observação do detector de pausas na fala do usuário (SPEC → "Interjeições (regras)"): a
   * política pura (`decideInterjection`) decide classe + variante e o clipe é tocado pela mesma
   * fila de utterances — nunca durante a reprodução do assistente nem depois de a resposta
   * começar a falar. Em modo sombra (`interjections.shadow`) decide mas não toca.
   */
  interjectionObserved(input: {
    speechMs: number
    pauseMs: number
    tail: string
    observedAt: number
  }): void {
    if (!this.#sessionId) return
    // assistente calado: sem interjeição sobre a fala do assistente ou sobre a resposta em curso
    if (this.#playbackActive || this.#agentSpoke) return
    if (this.#machine.phase !== 'listening') return
    const resolved = this.#resolved()
    const now = this.#now()
    const obs: InterjectionObservation = {
      speechMs: finiteMs(input?.speechMs),
      pauseMs: finiteMs(input?.pauseMs),
      tail: typeof input?.tail === 'string' ? input.tail.slice(-EVAL_TAIL_MAX_CHARS) : '',
      observedAt: finiteMs(input?.observedAt) || now
    }
    const decision = decideInterjection(
      obs,
      resolved.interjections,
      {
        now,
        lastFiredAt: this.#lastInterjectAt,
        lastVariant: this.#lastInterjectVariant
      },
      () => this.#rng()
    )
    if (decision.class === 'NONE') return
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
        this.#resetResponse()
        this.#machine.responseBegan()
        this.#armFiller() // turno disparado também por mensagem digitada durante a chamada
        return
      }
      if (m.message.role === 'assistant' && !isDisplayOnly(m.meta)) {
        this.#flushMessage(typeof m.message.content === 'string' ? m.message.content : '')
      }
      return
    }
    if (e.type === 'session-updated' && e.session.id === sessionId) {
      if (!isBusyStatus(e.session.status)) this.#machine.responseDone()
      this.#emitState()
      return
    }
    if (e.type === 'tool-running' && e.sessionId === sessionId && e.running) {
      // tools em execução no turno: a espera tende a longa → o filler sai já (1 por turno)
      this.#filler.toolsRunning = true
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
  #flushMessage(content: string): void {
    if (content.length > this.#lastContent.length && content.startsWith(this.#lastContent)) {
      this.#pushFeed(content.slice(this.#lastContent.length), true)
    } else {
      this.#pushFeed('', true)
    }
    this.#lastContent = ''
    this.#feed = ''
  }

  #pushFeed(delta: string, final: boolean): void {
    this.#feed += delta
    for (;;) {
      const { sentences, rest } = splitSentences(this.#feed, { final })
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
    if (this.#speakCancelled || !text.trim()) return
    this.#machine.synthEnqueued()
    this.#synthQueue.push({ text, gen: this.#synthGen })
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
        if (item.gen !== this.#synthGen) continue // descartada enquanto sintetizava
        this.#uttSeq++
        this.#cancelFiller() // começo da resposta: o filler (se tocando) sai de cena
        this.#agentSpoke = true
        this.#playbackActive = true
        this.#machine.utteranceEmitted()
        const id = `u${this.#uttSeq}`
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
    this.#error = null
    this.#agentSpoke = false
    this.#resetFiller(true) // turno novo: o filler do turno anterior (se tocando) é cancelado
  }

  // ---------------- fillers pós-turno (regra v1 — SPEC → "Fillers") ----------------

  /**
   * Arma o filler do turno: se a 1ª sentença da resposta não começar a tocar em ~`FILLER_DELAY_MS`
   * (ou com tools em execução), toca UM clipe `FILLER` — no máximo 1 por turno e nunca depois da
   * 1ª fala do agente (`fillerShouldFire`, política pura em `@shared/voicePolicy`). Em modo sombra
   * (`interjections.shadow`) decide mas não toca (o registro é a fase 3 — eval log).
   */
  #armFiller(): void {
    this.#resetFiller(true)
    const resolved = this.#resolved()
    this.#filler = {
      turnStartedAt: this.#now(),
      toolsRunning: false,
      spokenThisTurn: false,
      usedThisTurn: false,
      responseInFlight: true,
      enabled: resolved.fillers.enabled
    }
    const delay = this.#deps.fillerDelayMs ?? FILLER_DELAY_MS
    this.#fillerTimer = setTimeout(() => this.#onFillerTimer(), delay)
  }

  /**
   * Timer do filler disparou: timers podem sair ~1 ms adiantados (Node) — o atraso ainda não
   * cumprido é reagendado; cumprido (ou com tool em execução), tenta disparar.
   */
  #onFillerTimer(): void {
    this.#fillerTimer = null
    const delay = this.#deps.fillerDelayMs ?? FILLER_DELAY_MS
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

  /** Tenta disparar o filler deste turno (idempotente — `usedThisTurn` segura 1 por turno). */
  async #tryFiller(): Promise<void> {
    if (!this.#sessionId) return
    const delay = this.#deps.fillerDelayMs ?? FILLER_DELAY_MS
    if (!fillerShouldFire(this.#filler, this.#now(), delay)) return
    // assistente audível (fila de turnos: resposta anterior ainda falando) — não interrompe
    if (this.#playbackActive) return
    this.#filler.usedThisTurn = true
    const decidedAt = this.#now()
    const base = this.#filler.toolsRunning ? 'tools' : 'delay'
    const gen = this.#fillerGen
    const resolved = this.#resolved()
    const variants = [1, 2, 3]
    const v0 = pickClipVariant(() => this.#rng(), this.#lastFillerVariant, variants.length)
    // rotação sem repetir a última; clipe ausente no cache tenta as demais variantes
    const order = [...variants.slice(v0 - 1), ...variants.slice(0, v0 - 1)]
    let clip: { audio: Uint8Array; mime: string } | null = null
    let n = v0
    for (const cand of order) {
      clip = await this.#deps.clip('FILLER', cand)
      n = cand
      if (clip) break
    }
    if (gen !== this.#fillerGen || !this.#sessionId) return // reset/stop durante a carga
    this.#lastFillerVariant = n
    // 1ª sentença chegou (ou a resposta caiu) durante a carga do clipe: não toca mais
    const blocked = this.#filler.spokenThisTurn || !this.#filler.responseInFlight
    const shadow = resolved.interjections.shadow
    const played = !!clip && !shadow && !blocked
    const reason = played
      ? base
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
      variant: n,
      played,
      shadow,
      speechMs: null,
      pauseMs: null,
      tail: null,
      latencyMs: Math.max(0, this.#now() - decidedAt),
      reason
    })
    if (!played || !clip) return
    this.#uttSeq++
    const id = `u${this.#uttSeq}`
    this.#fillerUttId = id
    this.#playbackActive = true
    this.#deps.emitUtterance({ id, audio: clip.audio, mime: clip.mime, kind: 'filler' })
    this.#emitTimeline({ ts: this.#now(), kind: 'clip-emitted', class: 'FILLER', id, variant: n })
  }

  /**
   * Interjeição decidida: carrega o clipe (`resolveClip`) e toca na mesma fila de utterances —
   * a decisão que chega > `INTERJECTION_MAX_AGE_MS` tarde demais é descartada (o momento da pausa
   * passou). Em modo sombra decide mas não toca.
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
    this.#deps.emitUtterance({ id, audio: clip.audio, mime: clip.mime, kind: 'interjection' })
    this.#emitTimeline({ ts: now, kind: 'clip-emitted', class: cls, id, variant })
  }

  /** 1ª utterance da resposta: o filler (se ainda tocando) é cancelado e não pode mais sair. */
  #cancelFiller(): void {
    this.#filler.spokenThisTurn = true
    if (this.#fillerTimer) {
      clearTimeout(this.#fillerTimer)
      this.#fillerTimer = null
    }
    const id = this.#fillerUttId
    this.#fillerUttId = null
    if (id) {
      this.#deps.emitUtteranceCancel(id)
      this.#emitTimeline({ ts: this.#now(), kind: 'clip-cancelled', class: 'FILLER', id })
    }
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

  /** Cancela a interjeição tocando (stop da chamada). */
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
