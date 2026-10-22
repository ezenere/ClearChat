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
import { splitSentences } from './sentences'
import { VoiceTurnMachine, isBusyStatus } from './turnMachine'

/** Utterance falada (evento `voice:call:utterance`) — bytes completos de uma sentença. */
export interface VoiceCallUtterance {
  id: string
  audio: Uint8Array
  mime: string
}

export interface VoiceCallSessionInfo {
  chatId: string
  depth: number
  busy: boolean
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

  constructor(deps: VoiceCallDeps) {
    this.#deps = deps
    this.#machine = new VoiceTurnMachine((text) => {
      if (this.#sessionId) this.#deps.sendTurn(this.#sessionId, text)
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
    const resolved = this.#resolved()
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

  /** O usuário começou a falar (durante a reprodução = barge-in, tratado pelo renderer). */
  speechBegin(): VoiceCallState {
    if (!this.#sessionId) return this.state()
    this.#machine.speechBegan()
    this.#emitState()
    return this.state()
  }

  /** O silêncio encerrou a fala: a transcrição final está em andamento. */
  speechEnd(): VoiceCallState {
    if (!this.#sessionId) return this.state()
    this.#machine.speechEnded()
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
    this.#machine.playbackIdle()
    this.#emitState()
    return this.state()
  }

  /** Barge-in: o usuário falou durante a reprodução — cancela a fala do assistente. */
  bargeIn(): VoiceCallState {
    if (!this.#sessionId) return this.state()
    this.#speakCancelled = true
    this.#clearSynth()
    this.#machine.bargeIn()
    this.#emitState()
    return this.state()
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
    const cfg = this.#chatId ? this.#deps.chatConfig(this.#chatId) : null
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
        // fim da resposta sem pontuação: o resto inteiro vira uma utterance
        if (final) this.#queueSentence(this.#feed.trim())
        this.#feed = ''
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
          // falha de TTS: para a fala (o texto segue no histórico) e mostra o erro na UI
          this.#error = e instanceof Error ? e.message : String(e)
          this.#clearSynth()
          this.#emitState()
          return
        }
        if (item.gen !== this.#synthGen) continue // descartada enquanto sintetizava
        this.#uttSeq++
        this.#machine.utteranceEmitted()
        this.#deps.emitUtterance({ id: `u${this.#uttSeq}`, audio, mime })
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
  }

  #emitState(): void {
    this.#deps.emitState(this.state())
  }
}
