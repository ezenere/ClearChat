// "Modo avançado (GPU local)" — vozes de clonagem em `<userData>/gpu-voices/<id>/` (fora do
// runtime: "Remover runtime" não apaga as vozes do usuário). Cada voz = `voice.wav` (ou `source.*`
// que o servidor converte na 1ª vez) + `meta.json` { name, source: 'cc0'|'user', transcript,
// license?, attribution?, createdAt, durationS? }. Sem Electron; fetch injetável.
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { GPU_CC0_VOICES, type GpuCc0Voice } from '@shared/gpuVoice'

export interface GpuStoredVoice {
  id: string
  name: string
  source: 'cc0' | 'user'
  transcript: string | null
  durationS: number | null
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
export const USER_VOICE_MIN_S = 3
export const USER_VOICE_MAX_S = 30

/** Cabeçalho WAV PCM → formato e duração (null = não é WAV PCM legível). */
export function parseWavInfo(
  buf: Uint8Array
): { sampleRate: number; channels: number; bits: number; durationS: number } | null {
  if (buf.length < 44) return null
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const tag = (o: number): string => String.fromCharCode(buf[o], buf[o + 1], buf[o + 2], buf[o + 3])
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null
  let off = 12
  let fmt: { sampleRate: number; channels: number; bits: number; format: number } | null = null
  while (off + 8 <= buf.length) {
    const id = tag(off)
    const size = dv.getUint32(off + 4, true)
    if (id === 'fmt ' && off + 24 <= buf.length) {
      fmt = {
        format: dv.getUint16(off + 8, true),
        channels: dv.getUint16(off + 10, true),
        sampleRate: dv.getUint32(off + 12, true),
        bits: dv.getUint16(off + 22, true)
      }
    } else if (id === 'data') {
      if (!fmt || !fmt.sampleRate || !fmt.channels || !fmt.bits) return null
      // format 1 = PCM; 0xFFFE = extensible (PCM dentro)
      if (fmt.format !== 1 && fmt.format !== 0xfffe && fmt.format !== 3) return null
      const len = Math.min(size, buf.length - off - 8)
      const durationS = len / (fmt.sampleRate * fmt.channels * (fmt.bits / 8))
      return { sampleRate: fmt.sampleRate, channels: fmt.channels, bits: fmt.bits, durationS }
    }
    off += 8 + size + (size % 2)
  }
  return null
}

/** Formato pelo conteúdo (o renderer manda WAV; webm/ogg/mp3 também aceitos — o servidor converte). */
export function sniffAudio(buf: Uint8Array): 'wav' | 'webm' | 'ogg' | 'mp3' | null {
  const s = (a: number, b: number): string => String.fromCharCode(...buf.subarray(a, b))
  if (buf.length < 12) return null
  if (s(0, 4) === 'RIFF' && s(8, 12) === 'WAVE') return 'wav'
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return 'webm'
  if (s(0, 4) === 'OggS') return 'ogg'
  if (s(0, 3) === 'ID3' || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)) return 'mp3'
  return null
}

export class GpuVoiceStore {
  readonly root: string
  private readonly fetchImpl: typeof fetch

  constructor(root: string, fetchImpl: typeof fetch = fetch) {
    this.root = root
    this.fetchImpl = fetchImpl
  }

  private async writeMeta(dir: string, meta: Record<string, unknown>): Promise<void> {
    const tmp = join(dir, `meta.json.${randomUUID().slice(0, 8)}.tmp`)
    await writeFile(tmp, JSON.stringify(meta, null, 2))
    await rename(tmp, join(dir, 'meta.json'))
  }

  async list(): Promise<GpuStoredVoice[]> {
    let names: string[]
    try {
      names = await readdir(this.root)
    } catch {
      return []
    }
    const out: GpuStoredVoice[] = []
    for (const id of names.sort()) {
      if (!SAFE_ID.test(id)) continue
      const dir = join(this.root, id)
      let meta: Record<string, unknown>
      try {
        meta = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8')) as Record<string, unknown>
      } catch {
        continue
      }
      const hasAudio =
        existsSync(join(dir, 'voice.wav')) ||
        (await readdir(dir).catch(() => [] as string[])).some((f) => f.startsWith('source.'))
      if (!hasAudio) continue
      const t =
        (typeof meta.transcript === 'string' && meta.transcript.trim()) ||
        (typeof meta.transcriptAuto === 'string' && meta.transcriptAuto.trim()) ||
        null
      out.push({
        id,
        name: typeof meta.name === 'string' && meta.name.trim() ? meta.name.trim() : id,
        source: meta.source === 'cc0' ? 'cc0' : 'user',
        transcript: t || null,
        durationS: typeof meta.durationS === 'number' ? meta.durationS : null
      })
    }
    return out
  }

  /**
   * Voz do usuário: WAV PCM (o renderer decodifica para 24 kHz mono 16-bit) de 3–30 s — webm/ogg/mp3
   * também ficam (convertidos pelo servidor). Nome ≤ 60 chars; transcrição opcional ≤ 1000 chars.
   */
  async addUser(input: {
    name: unknown
    audio: unknown
    transcript?: unknown
  }): Promise<{ id: string }> {
    const name = typeof input.name === 'string' ? input.name.trim().slice(0, 60) : ''
    if (!name) throw new Error('Dê um nome para a voz.')
    const audio =
      input.audio instanceof ArrayBuffer
        ? new Uint8Array(input.audio)
        : input.audio instanceof Uint8Array
          ? input.audio
          : null
    if (!audio || !audio.length) throw new Error('Áudio da voz vazio.')
    if (audio.length > 20 * 2 ** 20) throw new Error('Áudio da voz grande demais (máx. 20 MB).')
    const kind = sniffAudio(audio)
    if (!kind) throw new Error('Formato de áudio não reconhecido (use WAV, WebM, Ogg ou MP3).')
    let durationS: number | null = null
    if (kind === 'wav') {
      const info = parseWavInfo(audio)
      if (!info) throw new Error('WAV inválido (esperado PCM).')
      durationS = Math.round(info.durationS * 100) / 100
      if (info.durationS < USER_VOICE_MIN_S)
        throw new Error(
          `Amostra curta demais (${info.durationS.toFixed(1)} s): grave de 6 a 10 s de fala.`
        )
      if (info.durationS > USER_VOICE_MAX_S)
        throw new Error(
          `Amostra longa demais (${info.durationS.toFixed(0)} s): use de 6 a 10 s de fala.`
        )
    }
    const transcript =
      typeof input.transcript === 'string' && input.transcript.trim()
        ? input.transcript.replace(/\s+/g, ' ').trim().slice(0, 1000)
        : null
    const id = `user-${randomBytes(4).toString('hex')}`
    const dir = join(this.root, id)
    await mkdir(dir, { recursive: true })
    // WAV 24 kHz mono 16-bit já é o formato dos motores → voice.wav direto; o resto o servidor converte
    const info = kind === 'wav' ? parseWavInfo(audio) : null
    const ready = !!info && info.sampleRate === 24000 && info.channels === 1 && info.bits === 16
    await writeFile(join(dir, ready ? 'voice.wav' : `source.${kind}`), audio)
    await this.writeMeta(dir, {
      name,
      source: 'user',
      transcript,
      createdAt: new Date().toISOString(),
      durationS
    })
    return { id }
  }

  async remove(id: unknown): Promise<void> {
    if (typeof id !== 'string' || !SAFE_ID.test(id)) throw new Error('Voz inválida.')
    await rm(join(this.root, id), { recursive: true, force: true })
  }

  async setAutoTranscript(id: string, text: string): Promise<void> {
    if (!SAFE_ID.test(id)) return
    const dir = join(this.root, id)
    try {
      const meta = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8')) as Record<
        string,
        unknown
      >
      await this.writeMeta(dir, { ...meta, transcriptAuto: text })
    } catch {
      /* voz sumiu */
    }
  }

  /** Baixa uma referência CC0 pt-BR (commit fixado, sha256 conferido). Já baixada → só devolve. */
  async downloadCc0(id?: unknown, signal?: AbortSignal): Promise<{ id: string }> {
    const v: GpuCc0Voice | undefined =
      typeof id === 'string' && id ? GPU_CC0_VOICES.find((x) => x.id === id) : GPU_CC0_VOICES[0]
    if (!v) throw new Error(`Voz CC0 desconhecida: ${String(id)}.`)
    const dir = join(this.root, v.id)
    if (existsSync(join(dir, 'meta.json')) && existsSync(join(dir, 'source.mp3')))
      return { id: v.id }
    let res: Response
    try {
      res = await this.fetchImpl(v.url, { signal, headers: { 'User-Agent': 'ClearChat' } })
    } catch (e) {
      throw new Error(
        `Falha de rede ao baixar a voz CC0: ${e instanceof Error ? e.message : String(e)}`,
        { cause: e }
      )
    }
    if (!res.ok) throw new Error(`Download da voz CC0 falhou (HTTP ${res.status}).`)
    const buf = new Uint8Array(await res.arrayBuffer())
    const sha = createHash('sha256').update(buf).digest('hex')
    if (buf.length !== v.size || sha !== v.sha256)
      throw new Error('A voz CC0 baixada não confere (checksum) — tente de novo.')
    await mkdir(dir, { recursive: true })
    const part = join(dir, `source.mp3.${randomUUID().slice(0, 8)}.part`)
    await writeFile(part, buf)
    await rename(part, join(dir, 'source.mp3'))
    await this.writeMeta(dir, {
      name: v.name,
      source: 'cc0',
      transcript: v.transcript,
      license: v.license,
      attribution: v.attribution,
      url: v.url,
      createdAt: new Date().toISOString()
    })
    return { id: v.id }
  }
}
