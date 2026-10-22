// DSP puro da captura de áudio (sem DOM/Web Audio): reamostragem, conversão PCM16 e RMS de quadro.
// Funções puras e testáveis — cobertas por `e2e/audio.test.ts`. A captura (`capture.ts`) usa estas
// funções para entregar chunks PCM16 mono a 16 kHz, independentemente da taxa do AudioContext.

/**
 * Reamostra um sinal mono (Float32) de `fromRate` para `toRate` por interpolação linear.
 *
 * É o *downsample* pedido pelo contrato (saída PCM a 16 kHz a partir da taxa do AudioContext,
 * tipicamente 44,1/48 kHz). A interpolação linear é simples e suficiente para fala; a fase é
 * reiniciada por chunk (descontinuidade desprezível a cada ~100 ms). Taxas não positivas/NaN
 * lançam erro; entrada vazia devolve `Float32Array` vazio.
 */
export function resampleMono(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (!Number.isFinite(fromRate) || fromRate <= 0 || !Number.isFinite(toRate) || toRate <= 0) {
    throw new Error(`resampleMono: taxas inválidas (${fromRate} → ${toRate})`)
  }
  if (input.length === 0) return new Float32Array(0)
  if (fromRate === toRate) return input.slice()
  const outLength = Math.max(1, Math.round((input.length * toRate) / fromRate))
  const out = new Float32Array(outLength)
  const step = fromRate / toRate
  const last = input.length - 1
  for (let i = 0; i < outLength; i++) {
    const pos = Math.min(i * step, last)
    const i0 = Math.floor(pos)
    const i1 = Math.min(i0 + 1, last)
    const frac = pos - i0
    out[i] = input[i0] + (input[i1] - input[i0]) * frac
  }
  return out
}

/**
 * Converte amostras Float32 (−1..1) em PCM16 (Int16Array, little-endian na serialização futura).
 * Valores fora da faixa são aparados; −1 vira −32768 e 1 vira 32767 (faixa cheia).
 */
export function floatToPcm16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length)
  for (let i = 0; i < input.length; i++) {
    const s = input[i]
    const c = s > 1 ? 1 : s < -1 ? -1 : s
    out[i] = c < 0 ? Math.round(c * 32768) : Math.round(c * 32767)
  }
  return out
}

/** RMS (valor médio quadrático) de um quadro de amostras, na faixa 0..1. Quadro vazio → 0. */
export function frameRms(input: Float32Array): number {
  if (input.length === 0) return 0
  let sum = 0
  for (let i = 0; i < input.length; i++) sum += input[i] * input[i]
  return Math.sqrt(sum / input.length)
}

/** Junta pedaços de Float32Array em um único buffer (não altera os pedaços). */
export function concatFloat32(parts: readonly Float32Array[]): Float32Array {
  let total = 0
  for (const p of parts) total += p.length
  const out = new Float32Array(total)
  let offset = 0
  for (const p of parts) {
    out.set(p, offset)
    offset += p.length
  }
  return out
}
