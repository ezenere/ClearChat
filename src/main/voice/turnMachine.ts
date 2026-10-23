// Máquina de estados do turno da chamada de voz (função pura, sem Electron/UI/IPC — testada em
// `e2e/voiceCall.test.ts`). O renderer é o "sensor" (captura, silêncio, reprodução) e reporta os
// eventos pelos canais `voice:call:*`; o main é o dono do turno: decide quando a transcrição final
// vira mensagem do usuário (mesmo caminho do composer) e quando uma fala falada vira o PRÓXIMO
// turno (fila de turnos de voz, máx. 1 pendente).
//
// Fluxo (meia-duplex, turnos por silêncio):
//   listening → speechEnded → transcribing → turnArrived(texto) → thinking
//   thinking → responseDone → listening (ou o turno pendente sai já, vira thinking)
//   speaking = áudio do assistente tocando/por tocar (utterances emitidas + sentenças na síntese)
//   barge-in (fala durante a reprodução) → para a fala; o texto da resposta continua no histórico.
import type { VoiceCallPhase } from '@shared/voice'

/** Estados de sessão que significam "o agente ainda responde" (espelha `isBusy` do store). */
export function isBusyStatus(status: string | undefined): boolean {
  return (
    status === 'running' ||
    status === 'awaiting_approval' ||
    status === 'awaiting_input' ||
    status === 'awaiting_retry' ||
    status === 'waiting'
  )
}

export class VoiceTurnMachine {
  readonly #onSend: (text: string) => void
  #active = false
  /** O agente está no meio de um turno (geração + tools; aprovação/ask_user contam). */
  #responseInFlight = false
  /** Transcrição final da fala em andamento (silêncio já disparou). */
  #transcribing = false
  /** O usuário está falando agora (a UI mostra "Ouvindo…"). */
  #userSpeaking = false
  /** Utterance emitida e ainda não confirmada como tocada (playback-idle). */
  #audioActive = false
  /** Sentenças cortadas ainda não emitidas (síntese em voo/na fila — display "Falando…"). */
  #synthPending = 0
  /** Fala já transcrita aguardando o próximo turno (máx. 1 — falas seguintes se acumulam). */
  #pendingText = ''

  constructor(onSend: (text: string) => void) {
    this.#onSend = onSend
  }

  /** Entra na chamada (com o agente já ocupado ou não). */
  start(initialBusy: boolean): void {
    this.#active = true
    this.#responseInFlight = !!initialBusy
    this.#transcribing = false
    this.#userSpeaking = false
    this.#audioActive = false
    this.#synthPending = 0
    this.#pendingText = ''
  }

  /** Sai da chamada (tudo volta ao repouso; o turno em voo segue normalmente no histórico). */
  stop(): void {
    this.#active = false
    this.#responseInFlight = false
    this.#transcribing = false
    this.#userSpeaking = false
    this.#audioActive = false
    this.#synthPending = 0
    this.#pendingText = ''
  }

  get active(): boolean {
    return this.#active
  }

  get responseInFlight(): boolean {
    return this.#responseInFlight
  }

  get pendingText(): string {
    return this.#pendingText
  }

  /** Fase mostrada na UI ("Ouvindo…/Transcrevendo…/Pensando…/Falando…"). */
  get phase(): VoiceCallPhase {
    if (this.#transcribing) return 'transcribing'
    if (this.#userSpeaking) return 'listening'
    if (this.#audioActive || this.#synthPending > 0) return 'speaking'
    if (this.#responseInFlight) return 'thinking'
    return 'listening'
  }

  /** O usuário começou a falar. */
  speechBegan(): void {
    if (!this.#active) return
    this.#userSpeaking = true
    this.#transcribing = false
  }

  /** O silêncio encerrou a fala: a transcrição final está em andamento. */
  speechEnded(): void {
    if (!this.#active) return
    this.#userSpeaking = false
    this.#transcribing = true
  }

  /**
   * Transcrição final chegou. Vazia = fala sem texto (de volta a ouvir). Com texto: envia já
   * quando o agente está livre; caso contrário vira o PRÓXIMO turno (máx. 1 pendente — falas
   * seguintes se acumulam nele).
   */
  turnArrived(text: string): void {
    if (!this.#active) return
    this.#transcribing = false
    this.#userSpeaking = false
    const t = text.trim()
    if (!t) return
    if (this.#responseInFlight) {
      this.#pendingText = this.#pendingText ? `${this.#pendingText} ${t}` : t
      return
    }
    this.#responseInFlight = true
    this.#onSend(t)
  }

  /** O turno do agente terminou (sessão ociosa): o turno pendente, se houver, sai já. */
  responseDone(): void {
    if (!this.#active) return
    this.#responseInFlight = false
    this.#flushPending()
  }

  /**
   * Uma mensagem do usuário entrou na sessão (turno falado, digitado ou drenado da fila): o
   * agente vai responder — vale para a UI ("Pensando…") e para a fila de turnos de voz.
   */
  responseBegan(): void {
    if (!this.#active) return
    this.#responseInFlight = true
  }

  /** O envio da mensagem falhou (fila/recusa externa): o turno volta ao repouso, sem pendente. */
  sendFailed(): void {
    this.#responseInFlight = false
    this.#transcribing = false
  }

  /** Uma sentença foi cortada e entrou na fila de síntese (display "Falando…"). */
  synthEnqueued(): void {
    if (!this.#active) return
    this.#synthPending++
  }

  /** Uma utterance foi emitida ao renderer (a síntese dela terminou). */
  utteranceEmitted(): void {
    if (!this.#active) return
    this.#synthPending = Math.max(0, this.#synthPending - 1)
    this.#audioActive = true
  }

  /**
   * A síntese de UMA sentença falhou e ela foi pulada (o resto da fila segue). Sem áudio tocando e
   * sem mais nada na fila, nenhum `playbackIdle` virá do renderer — o próximo turno pendente sai já.
   */
  synthSkipped(): void {
    if (!this.#active) return
    this.#synthPending = Math.max(0, this.#synthPending - 1)
    if (!this.#synthPending && !this.#audioActive) this.#flushPending()
  }

  /**
   * A fila de síntese foi descartada inteira (falha de TTS, barge-in ou stop): as sentenças
   * pendentes nunca viram utterance — sem isso a fase ficaria "Falando…" para sempre.
   */
  synthCleared(): void {
    if (!this.#active) return
    this.#synthPending = 0
  }

  /** A fila de reprodução do renderer esvaziou (tudo emitido já tocou). */
  playbackIdle(): void {
    if (!this.#active) return
    this.#audioActive = false
    this.#flushPending()
  }

  /** Barge-in: o usuário falou durante a reprodução — a fala do assistente é cancelada. */
  bargeIn(): void {
    if (!this.#active) return
    this.#audioActive = false
    this.#synthPending = 0
    this.#userSpeaking = true
  }

  #flushPending(): void {
    if (!this.#pendingText || this.#responseInFlight) return
    const t = this.#pendingText
    this.#pendingText = ''
    this.#responseInFlight = true
    this.#onSend(t)
  }
}
