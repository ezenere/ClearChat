// Porta de fala do usuário na chamada de voz (política pura, sem DOM — testada em
// `e2e/voiceCall.test.ts`): decide quando uma fala começa (`'start'`) e termina (`'end'`) a
// partir do RMS dos quadros da captura contínua. A fala começa no primeiro quadro acima do
// limiar e termina após `silenceMs` de silêncio CONTÍNUO (reuso da lógica de `SilenceDetector`).
// Quem usa: `useVoiceCall` (abre/fecha a sessão de transcrição por fala) e o barge-in
// (`'start'` enquanto o assistente fala).
import { SilenceDetector, DEFAULT_SILENCE_THRESHOLD } from '../audio/silence'

export type UtteranceGateEvent = 'start' | 'end' | null

export interface UtteranceGateConfig {
  /** RMS ≥ limiar conta como fala (padrão `DEFAULT_SILENCE_THRESHOLD` — 0,01 ≈ −40 dBFS). */
  threshold: number
  /** Ms de silêncio contínuo que encerram a fala (> 0; resolver com `resolveTurnSilenceMs`). */
  silenceMs: number
}

/**
 * Um utterance por vez: `'start'` no primeiro quadro audível (o quadro já entra na gravação),
 * `'end'` quando o silêncio acumula `silenceMs`. Entre fala e fala, `push` devolve `null`.
 * `reset()` descarta uma fala em curso sem disparar `'end'` (ex.: mudo/parada da chamada).
 */
export class UtteranceGate {
  readonly threshold: number
  readonly silenceMs: number
  #silence: SilenceDetector
  #speaking = false

  constructor(config: UtteranceGateConfig) {
    const t = config.threshold
    this.threshold = Number.isFinite(t) && t >= 0 ? t : DEFAULT_SILENCE_THRESHOLD
    const ms = config.silenceMs
    this.silenceMs = Number.isFinite(ms) && ms > 0 ? ms : 0
    this.#silence = new SilenceDetector({ threshold: this.threshold, silenceMs: this.silenceMs })
  }

  get speaking(): boolean {
    return this.#speaking
  }

  /** Registra um quadro (RMS 0..1 + duração em ms) e devolve o evento de fronteira da fala. */
  push(rms: number, frameMs: number): UtteranceGateEvent {
    if (!this.#speaking) {
      if (!(rms >= this.threshold)) return null
      this.#speaking = true
      this.#silence.reset()
      // o quadro que abriu a fala já conta (limiar atingido = não-silêncio)
      this.#silence.push(rms, frameMs)
      return 'start'
    }
    if (this.#silence.push(rms, frameMs)) {
      this.#speaking = false
      this.#silence.reset()
      return 'end'
    }
    return null
  }

  /** Descarta a fala em curso (sem `'end'`) — ex.: mudo, parada da chamada, captura reiniciada. */
  reset(): void {
    this.#speaking = false
    this.#silence.reset()
  }
}
