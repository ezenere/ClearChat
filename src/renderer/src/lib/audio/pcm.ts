// DSP puro da captura de áudio (sem DOM/Web Audio): reamostragem, conversão PCM16 e RMS de quadro.
// Funções puras e testáveis — cobertas por `e2e/audio.test.ts`. A captura (`capture.ts`) usa estas
// funções para entregar chunks PCM16 mono a 16 kHz, independentemente da taxa do AudioContext.

/** Lóbulos do sinc (por lado, em períodos da taxa de SAÍDA) do filtro anti-aliasing do downsample. */
const SINC_LOBES = 8
/** Corte do passa-baixa em fração da Nyquist de saída (folga de transição antes da Nyquist). */
const CUTOFF_FRACTION = 0.9

/**
 * Reamostra um sinal mono (Float32) de `fromRate` para `toRate`.
 *
 * **Downsample** (ex.: 48/44,1 kHz → 16 kHz): filtro passa-baixa sinc janelado (Hann) com corte em
 * ~90% da Nyquist de saída, avaliado direto nas posições de saída — conteúdo acima de `toRate/2`
 * é atenuado em vez de dobrar para a banda de voz (a decimação linear de antes deixava passar o
 * aliasing). O ganho DC é unitário (pesos normalizados, inclusive nas bordas do chunk). **Upsample**
 * (raro — microfone a 8 kHz): interpolação linear (não há aliasing a evitar).
 *
 * Tamanho da saída exato: `round(n · toRate / fromRate)` (48 kHz: 4800 → 1600; 44,1 kHz: 4410 →
 * 1600). Cada chunk é filtrado sozinho (bordas com pesos renormalizados — desprezível a cada ~100 ms;
 * a captura prefere um AudioContext já a 16 kHz, quando o Chromium reamostra com filtro próprio).
 * Taxas não positivas/NaN lançam erro; entrada vazia devolve `Float32Array` vazio.
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
  if (step < 1) {
    // upsample: interpolação linear
    for (let i = 0; i < outLength; i++) {
      const pos = Math.min(i * step, last)
      const i0 = Math.floor(pos)
      const i1 = Math.min(i0 + 1, last)
      const frac = pos - i0
      out[i] = input[i0] + (input[i1] - input[i0]) * frac
    }
    return out
  }
  // downsample: sinc janelado com corte em CUTOFF_FRACTION · (toRate/2), em amostras de entrada
  const fc = (CUTOFF_FRACTION * 0.5) / step // ciclos por amostra de entrada
  const half = Math.ceil(SINC_LOBES * step)
  for (let i = 0; i < outLength; i++) {
    const center = i * step
    const k0 = Math.max(0, Math.ceil(center - half))
    const k1 = Math.min(last, Math.floor(center + half))
    let acc = 0
    let wsum = 0
    for (let k = k0; k <= k1; k++) {
      const x = k - center
      const sinc = x === 0 ? 1 : Math.sin(2 * Math.PI * fc * x) / (2 * Math.PI * fc * x)
      const w = sinc * (0.5 + 0.5 * Math.cos((Math.PI * x) / half))
      acc += input[k] * w
      wsum += w
    }
    out[i] = wsum !== 0 ? acc / wsum : input[Math.min(last, Math.round(center))]
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
