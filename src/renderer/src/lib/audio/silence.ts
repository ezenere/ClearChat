// Política pura de auto-stop por silêncio (sem DOM): `SilenceDetector` decide quando o usuário
// parou de falar com base no RMS dos quadros. Testado em `e2e/audio.test.ts`.
// A ligação com as settings (`AudioInputSettings.silenceStopMs`) é feita em `usePushToTalk.ts`.

/** Limiar padrão de silêncio: RMS 0,01 ≈ −40 dBFS — abaixo disso considera-se ruído de fundo. */
export const DEFAULT_SILENCE_THRESHOLD = 0.01

export interface SilenceDetectorConfig {
  /** RMS abaixo do qual o quadro conta como silêncio (0..1; estritamente menor que o limiar). */
  threshold: number
  /** Ms de silêncio *contínuo* que disparam o fim; 0 = ignora o limite (nunca dispara). */
  silenceMs: number
}

/**
 * Detector de silêncio: acumula a duração dos quadros com RMS abaixo do limiar e dispara quando
 * o total contínuo atinge `silenceMs`. Qualquer quadro acima do limiar zera o acumulado.
 *
 * - `silenceMs: 0` (ou negativo) = limite ignorado: `push` nunca devolve `true`.
 * - `reset()` zera o acumulado (ex.: ao iniciar uma nova captura).
 * - Configuração inválida (NaN/fora da faixa) cai nos padrões documentados.
 */
export class SilenceDetector {
  readonly threshold: number
  readonly silenceMs: number
  #silentMs = 0

  constructor(config: Partial<SilenceDetectorConfig> = {}) {
    const threshold = config.threshold
    this.threshold =
      Number.isFinite(threshold) && (threshold as number) >= 0
        ? (threshold as number)
        : DEFAULT_SILENCE_THRESHOLD
    const silenceMs = config.silenceMs
    this.silenceMs =
      Number.isFinite(silenceMs) && (silenceMs as number) > 0 ? (silenceMs as number) : 0
  }

  /** Ms de silêncio contínuo acumulados até agora. */
  get silentMs(): number {
    return this.#silentMs
  }

  /**
   * Registra um quadro (`rms` na faixa 0..1, `frameMs` a duração dele em ms) e devolve `true`
   * quando o silêncio contínuo atingiu `silenceMs` (fim da fala). Durações inválidas contam 0.
   */
  push(rms: number, frameMs: number): boolean {
    if (this.silenceMs <= 0) return false
    const dt = Number.isFinite(frameMs) && frameMs > 0 ? frameMs : 0
    if (rms < this.threshold) this.#silentMs += dt
    else this.#silentMs = 0
    return this.#silentMs >= this.silenceMs
  }

  /** Zera o acumulado de silêncio (a configuração permanece). */
  reset(): void {
    this.#silentMs = 0
  }
}
