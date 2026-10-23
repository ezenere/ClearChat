// WAV/PCM puros (sem dependências do app): o cabeçalho RIFF do PCM16 mono, o parse do content-type
// `audio/pcm;rate=N[;channels=C]` das APIs de fala e o alinhamento/mixdown de pedaços PCM16 que
// chegam da rede em tamanhos arbitrários. Usado pelo main (sessão de transcrição, cliente de TTS) e
// pelo processo do motor local de TTS (`ttsWorker.ts`) — por isso não importa nada do app.

/**
 * WAV RIFF little-endian, PCM 16-bit mono (cabeçalho de 44 bytes) a partir do PCM16 cru.
 * É o formato enviado à API de transcrição e o devolvido pelo motor local / adaptador PCM do TTS.
 */
export function encodeWav(pcm16: Uint8Array, sampleRate: number): Uint8Array {
  if (!(pcm16 instanceof Uint8Array)) throw new Error('encodeWav: pcm16 deve ser Uint8Array.')
  if (pcm16.length % 2) throw new Error('encodeWav: PCM16 com tamanho ímpar (2 bytes por amostra).')
  if (!Number.isInteger(sampleRate) || sampleRate <= 0)
    throw new Error(`encodeWav: sampleRate inválido (${sampleRate}).`)
  const out = new Uint8Array(44 + pcm16.length)
  const dv = new DataView(out.buffer)
  const ascii = (offset: number, s: string): void => {
    for (let i = 0; i < s.length; i++) out[offset + i] = s.charCodeAt(i)
  }
  ascii(0, 'RIFF')
  dv.setUint32(4, 36 + pcm16.length, true) // tamanho do RIFF
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  dv.setUint32(16, 16, true) // tamanho do subchunk fmt
  dv.setUint16(20, 1, true) // formato PCM
  dv.setUint16(22, 1, true) // mono
  dv.setUint32(24, sampleRate, true)
  dv.setUint32(28, sampleRate * 2, true) // byteRate (blockAlign × sampleRate)
  dv.setUint16(32, 2, true) // blockAlign (mono × 16 bits)
  dv.setUint16(34, 16, true) // bits por amostra
  ascii(36, 'data')
  dv.setUint32(40, pcm16.length, true)
  out.set(pcm16, 44)
  return out
}

/** Formato de um PCM16 cru anunciado no content-type. */
export interface PcmFormat {
  sampleRate: number
  channels: number
}

/**
 * `audio/pcm;rate=24000;channels=1` (ou `audio/l16;rate=…`) → `{ sampleRate, channels }`; outro
 * tipo (wav/mp3/json) ou sem `rate` válido → null. `channels` ausente = 1.
 */
export function parsePcmContentType(contentType: string | null | undefined): PcmFormat | null {
  const parts = (contentType ?? '')
    .toLowerCase()
    .split(';')
    .map((p) => p.trim())
  if (parts[0] !== 'audio/pcm' && parts[0] !== 'audio/l16') return null
  let sampleRate = 0
  let channels = 1
  for (const p of parts.slice(1)) {
    const [k, v] = p.split('=').map((x) => x.trim())
    const n = Number(v)
    if (k === 'rate' && Number.isInteger(n) && n > 0 && n <= 384_000) sampleRate = n
    else if (k === 'channels' && Number.isInteger(n) && n > 0 && n <= 8) channels = n
  }
  return sampleRate ? { sampleRate, channels } : null
}

/**
 * Alinha pedaços de PCM16 intercalado (`channels` canais) que chegam em tamanhos arbitrários da
 * rede e devolve PCM16 **mono** em quadros inteiros (o resto fica guardado para o próximo pedaço).
 * Multicanal vira mono pela média dos canais.
 */
export class Pcm16MonoAligner {
  readonly #frameBytes: number
  readonly #channels: number
  #carry: Uint8Array = new Uint8Array(0)

  constructor(channels = 1) {
    this.#channels = Math.max(1, Math.floor(channels) || 1)
    this.#frameBytes = 2 * this.#channels
  }

  /** Acrescenta bytes; devolve o PCM16 mono dos quadros completos (pode ser vazio). */
  push(chunk: Uint8Array): Uint8Array {
    let buf = chunk
    if (this.#carry.length) {
      buf = new Uint8Array(this.#carry.length + chunk.length)
      buf.set(this.#carry)
      buf.set(chunk, this.#carry.length)
    }
    const whole = buf.length - (buf.length % this.#frameBytes)
    this.#carry = buf.slice(whole)
    if (!whole) return new Uint8Array(0)
    if (this.#channels === 1) return buf.slice(0, whole)
    const frames = whole / this.#frameBytes
    const src = new DataView(buf.buffer, buf.byteOffset, whole)
    const out = new Uint8Array(frames * 2)
    const dst = new DataView(out.buffer)
    for (let f = 0; f < frames; f++) {
      let sum = 0
      for (let c = 0; c < this.#channels; c++)
        sum += src.getInt16(f * this.#frameBytes + c * 2, true)
      dst.setInt16(f * 2, Math.round(sum / this.#channels), true)
    }
    return out
  }

  /** Bytes que sobraram (quadro incompleto no fim do stream — descartados). */
  get leftover(): number {
    return this.#carry.length
  }
}

/** Concatena pedaços de bytes. */
export function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  let n = 0
  for (const c of chunks) n += c.length
  const out = new Uint8Array(n)
  let o = 0
  for (const c of chunks) {
    out.set(c, o)
    o += c.length
  }
  return out
}
