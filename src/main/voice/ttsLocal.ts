// Motor local de fala (TTS) do main — Kokoro-82M v1.0 em ONNX (`onnxruntime-node`) com os pesos do
// catálogo (`catalog.ts`, instalados pelo gerenciador de componentes) e fonemização pt-BR pelo
// `espeak-ng` do SISTEMA (o mesmo G2P do misaki — `EspeakG2P` — que gerou os fonemas de treino das
// vozes pt-BR do Kokoro; a conversa toda está validada no spike — ver SPEC → "Serviço de TTS").
// Sem Electron, sem UI, sem IPC; dependências injetáveis (runner do espeak-ng e sessão ONNX).
// O pipeline é o do `hexgrad/kokoro` (`model.py`): fonemas → ids por caractere (chars fora do
// vocabulário caem) → `[0, *ids, 0]` → estilo `voice[min(ids, 509)]` → `waveform` a 24 kHz.
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import type { Tensor as OrtTensor } from 'onnxruntime-node'
import type { TtsLocalEngine } from '@shared/voice'
import { abortError } from '../tools/util'
import { listLocalModels, resolveLocalModelPath, type LocalModelInfo } from './models'
import { encodeWav } from './session'
import { TtsError, type TtsLocalBackend, type TtsLocalInput, type TtsLocalResult } from './tts'

/** Taxa de amostragem do Kokoro v1.0 (o decoder devolve 24 kHz). */
export const KOKORO_SAMPLE_RATE = 24_000

/** Vozes pt-BR do Kokoro v1.0 (ids conferidos em `hexgrad/Kokoro-82M` VOICES.md). */
export interface KokoroVoiceInfo {
  /** Id da voz nas settings (`TtsSettings.local.voice`) e no nome do arquivo (`<id>.bin`). */
  id: string
  /** Rótulo de exibição. */
  label: string
  /** Entrada do catálogo com o voice pack (tensor de estilos 510×256 fp32). */
  catalogId: string
}

export const KOKORO_VOICES: readonly KokoroVoiceInfo[] = [
  { id: 'pf_dora', label: 'Dora (pt-BR, feminina)', catalogId: 'kokoro-voice-pf-dora' },
  { id: 'pm_alex', label: 'Alex (pt-BR, masculina)', catalogId: 'kokoro-voice-pm-alex' },
  { id: 'pm_santa', label: 'Santa (pt-BR, masculina)', catalogId: 'kokoro-voice-pm-santa' }
]

/** Modelos do motor no catálogo, em ordem de preferência (fp32 é o mais rápido em CPU). */
export const KOKORO_MODEL_IDS: readonly string[] = ['kokoro-onnx', 'kokoro-onnx-q8']

// ---------------- fonemas (misaki `EspeakG2P`, version=None) ----------------

/**
 * Mapeamento de dífonos do misaki (`misaki/espeak.py` → `EspeakG2P.e2m`): o espeak marca os
 * dífonos com o tie (U+200D na saída `--ipa=3`, aqui normalizado para '^') e o Kokoro espera os
 * símbolos colapsados ('t^ʃ' → 'ʧ'). Idêntico ao que gerou os fonemas de treino do pt-BR.
 */
export const ESPEAK_E2M: readonly (readonly [string, string])[] = [
  ['a^ɪ', 'I'],
  ['a^ʊ', 'W'],
  ['d^z', 'ʣ'],
  ['d^ʒ', 'ʤ'],
  ['e^ɪ', 'A'],
  ['o^ʊ', 'O'],
  ['ə^ʊ', 'Q'],
  ['s^s', 'S'],
  ['t^s', 'ʦ'],
  ['t^ʃ', 'ʧ'],
  ['ɔ^ɪ', 'Y']
]

/**
 * Pós-processamento puro da saída do espeak-ng (com tie '^') para o espaço de fonemas do Kokoro:
 * mapeia os dífonos (`ESPEAK_E2M`), remove ties/hífens sobrando e normaliza para NFD (o vocabulário
 * é por caractere e o espeak saída 'u' + U+0303, não 'ũ' pré-composto).
 */
export function mapEspeakPhonemes(raw: string): string {
  let ps = raw.replace(/\u200d/g, '^').replace(/\u0361/g, '^')
  for (const [from, to] of ESPEAK_E2M) ps = ps.split(from).join(to)
  return ps.split('^').join('').split('-').join('').normalize('NFD')
}

/**
 * Vocabulário de fonemas do Kokoro (char → id): `tokenizer.json` da conversão ONNX
 * (`onnx-community/Kokoro-82M-v1.0-ONNX`), idêntico ao `config['vocab']` do `hexgrad/Kokoro-82M`
 * mais o pad '$' → 0 (o token que `model.py` usa nas bordas de `input_ids`).
 */
export const KOKORO_VOCAB: Readonly<Record<string, number>> = {
  $: 0,
  ';': 1,
  ':': 2,
  ',': 3,
  '.': 4,
  '!': 5,
  '?': 6,
  '\u2014': 9,
  '\u2026': 10,
  '"': 11,
  '(': 12,
  ')': 13,
  '\u201c': 14,
  '\u201d': 15,
  ' ': 16,
  '\u0303': 17,
  '\u02a3': 18,
  '\u02a5': 19,
  '\u02a6': 20,
  '\u02a8': 21,
  '\u1d5d': 22,
  '\uab67': 23,
  A: 24,
  I: 25,
  O: 31,
  Q: 33,
  S: 35,
  T: 36,
  W: 39,
  Y: 41,
  '\u1d4a': 42,
  a: 43,
  b: 44,
  c: 45,
  d: 46,
  e: 47,
  f: 48,
  h: 50,
  i: 51,
  j: 52,
  k: 53,
  l: 54,
  m: 55,
  n: 56,
  o: 57,
  p: 58,
  q: 59,
  r: 60,
  s: 61,
  t: 62,
  u: 63,
  v: 64,
  w: 65,
  x: 66,
  y: 67,
  z: 68,
  '\u0251': 69,
  '\u0250': 70,
  '\u0252': 71,
  '\u00e6': 72,
  '\u03b2': 75,
  '\u0254': 76,
  '\u0255': 77,
  '\u00e7': 78,
  '\u0256': 80,
  '\u00f0': 81,
  '\u02a4': 82,
  '\u0259': 83,
  '\u025a': 85,
  '\u025b': 86,
  '\u025c': 87,
  '\u025f': 90,
  '\u0261': 92,
  '\u0265': 99,
  '\u0268': 101,
  '\u026a': 102,
  '\u029d': 103,
  '\u026f': 110,
  '\u0270': 111,
  '\u014b': 112,
  '\u0273': 113,
  '\u0272': 114,
  '\u0274': 115,
  '\u00f8': 116,
  '\u0278': 118,
  '\u03b8': 119,
  '\u0153': 120,
  '\u0279': 123,
  '\u027e': 125,
  '\u027b': 126,
  '\u0281': 128,
  '\u027d': 129,
  '\u0282': 130,
  '\u0283': 131,
  '\u0288': 132,
  '\u02a7': 133,
  '\u028a': 135,
  '\u028b': 136,
  '\u028c': 138,
  '\u0263': 139,
  '\u0264': 140,
  '\u03c7': 142,
  '\u028e': 143,
  '\u0292': 147,
  '\u0294': 148,
  '\u02c8': 156,
  '\u02cc': 157,
  '\u02d0': 158,
  '\u02b0': 162,
  '\u02b2': 164,
  '\u2193': 169,
  '\u2192': 171,
  '\u2197': 172,
  '\u2198': 173,
  '\u1d7b': 177
}

/** Teto de tokens por síntese (filas do banco de estilos: 510; o resto é truncado). */
export const KOKORO_MAX_TOKENS = 509

/**
 * Fonemas → `input_ids` do modelo (sem as bordas): chars fora do vocabulário são descartados
 * (como no `vocab.get(p)` do `model.py`) e o excesso é truncado em `KOKORO_MAX_TOKENS`.
 */
export function kokoroInputIds(phonemes: string): number[] {
  const ids: number[] = []
  for (const ch of phonemes.normalize('NFD')) {
    const id = KOKORO_VOCAB[ch]
    if (id !== undefined) ids.push(id)
  }
  return ids.slice(0, KOKORO_MAX_TOKENS)
}

// ---------------- motor ----------------

/** Tensor mínimo do runtime ONNX (injetável — a implementação padrão é a `onnxruntime-node`). */
export interface KokoroTensor {
  type: 'int64' | 'float32'
  data: BigInt64Array | Float32Array
  dims: number[]
}

/** Sessão ONNX mínima do modelo Kokoro (injetável). */
export interface KokoroSession {
  run(feeds: Record<string, KokoroTensor>): Promise<{ waveform: { data: Float32Array } }>
}

export interface KokoroEngineDeps {
  /** userData do app — os pesos ficam em `<baseDir>/models` (gerenciador de componentes). */
  baseDir: string
  /** Executa o espeak-ng (injetável). Padrão: `execFile` do sistema, com timeout de 15 s. */
  run?: (command: string, args: string[]) => Promise<string>
  /** Cria a sessão ONNX de um modelo (injetável). Padrão: `onnxruntime-node`. */
  createSession?: (modelPath: string) => Promise<KokoroSession>
}

/** Motor local Kokoro (implementação de `TtsLocalBackend`). */
export interface KokoroEngine extends TtsLocalBackend {
  engine: Extract<TtsLocalEngine, 'kokoro'>
  /** Vozes pt-BR com o estado de instalação em disco. */
  voices(): Promise<{ id: string; label: string; installed: boolean }[]>
}

const execFileAsync = promisify(execFile)

/** Runner padrão do espeak-ng (CLI do sistema — o app não embute o espeak-ng, que é GPL). */
async function defaultRun(command: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync(command, args, { timeout: 15_000, maxBuffer: 1 << 20 })
    return stdout
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { killed?: boolean; stderr?: string }
    if (err.code === 'ENOENT')
      throw new TtsError(
        'config',
        'espeak-ng não encontrado no sistema — o motor local Kokoro usa o espeak-ng para a fonemização pt-BR (instale o pacote "espeak-ng" do sistema, ex.: `pacman -S espeak-ng`)',
        { backend: 'local', cause: e }
      )
    const detail = (err.stderr ?? '').toString().replace(/\s+/g, ' ').trim().slice(0, 160)
    throw new TtsError(
      'config',
      err.killed
        ? 'tempo esgotado na fonemização (espeak-ng)'
        : `falha na fonemização (espeak-ng)${detail ? ` — ${detail}` : ''}`,
      { backend: 'local', cause: e }
    )
  }
}

/** Sessão ONNX padrão (`onnxruntime-node`, CPU). */
async function defaultCreateSession(modelPath: string): Promise<KokoroSession> {
  const ort = await import('onnxruntime-node')
  const session = await ort.InferenceSession.create(modelPath, { executionProviders: ['cpu'] })
  return {
    async run(feeds) {
      const ortFeeds: Record<string, OrtTensor> = {}
      for (const [name, t] of Object.entries(feeds)) {
        ortFeeds[name] = new ort.Tensor(t.type, t.data, t.dims)
      }
      const out = await session.run(ortFeeds)
      return { waveform: out.waveform as { data: Float32Array } }
    }
  }
}

/**
 * Fonemiza `text` em pt-BR com o espeak-ng (`--ipa=3`: estresse + ties) e o pós-processamento do
 * misaki. A pontuação é preservada (o CLI a perde): o texto é partido nas marcas e elas voltam
 * entre os fragmentos fonemizados — o mesmo resultado do `phonemizer` (preserve_punctuation).
 */
export async function phonemizeText(
  text: string,
  run: (command: string, args: string[]) => Promise<string>
): Promise<string> {
  // «» → “” e () → «» (como no misaki); no fim, « » viram ( ) de volta
  const prepared = text
    .replace(/«/g, '“')
    .replace(/»/g, '”')
    .replace(/\(/g, '«')
    .replace(/\)/g, '»')
  let ps = ''
  for (const part of prepared.split(/((?:[,.!?;:…—«»“”"(){}[\]])+)/)) {
    if (!part) continue
    if (/^[,.!?;:…—«»“”"(){}[\]]+$/.test(part)) {
      ps += part
      continue
    }
    const frag = mapEspeakPhonemes(await run('espeak-ng', ['-v', 'pt-br', '-q', '--ipa=3', part]))
    ps += ps && !/\s$/.test(ps) ? ` ${frag}` : frag
  }
  return ps.trim().replace(/«/g, '(').replace(/»/g, ')')
}

/**
 * Motor local Kokoro sobre os pesos do catálogo (`<userData>/models`): modelo `kokoro-onnx`
 * (fp32 — preferida por ser a mais rápida em CPU) ou `kokoro-onnx-q8`, voz `voices/<id>.bin`.
 * `synthesize` devolve wav 24 kHz mono (mp3 é do backend de API — erro legível aqui).
 */
export function createKokoroEngine(deps: KokoroEngineDeps): KokoroEngine {
  const run = deps.run ?? defaultRun
  const createSession = deps.createSession ?? defaultCreateSession
  const sessions = new Map<string, Promise<KokoroSession>>()

  const installedModels = async (): Promise<LocalModelInfo[]> => listLocalModels(deps.baseDir)

  const requireFile = async (catalogId: string, what: string): Promise<string> => {
    const info = (await installedModels()).find((m) => m.entry.id === catalogId)
    if (!info || info.state !== 'installed')
      throw new TtsError(
        'config',
        `${what} não instalado — baixe os arquivos do Kokoro em Configurações → Áudio`,
        { backend: 'local' }
      )
    return resolveLocalModelPath(deps.baseDir, catalogId)
  }

  const requireModel = async (): Promise<string> => {
    const models = await installedModels()
    for (const id of KOKORO_MODEL_IDS) {
      const m = models.find((x) => x.entry.id === id)
      if (m?.state === 'installed') return resolveLocalModelPath(deps.baseDir, id)
    }
    throw new TtsError(
      'config',
      'modelo do Kokoro não instalado — baixe o motor local em Configurações → Áudio',
      { backend: 'local' }
    )
  }

  const sessionFor = (modelPath: string): Promise<KokoroSession> => {
    let s = sessions.get(modelPath)
    if (!s) {
      s = createSession(modelPath)
      sessions.set(modelPath, s)
    }
    return s
  }

  return {
    engine: 'kokoro',
    async voices() {
      const models = await installedModels()
      return KOKORO_VOICES.map((v) => ({
        id: v.id,
        label: v.label,
        installed: models.some((m) => m.entry.id === v.catalogId && m.state === 'installed')
      }))
    },
    async synthesize(input: TtsLocalInput): Promise<TtsLocalResult> {
      if (input.format !== 'wav')
        throw new TtsError('config', 'o motor local gera áudio wav (mp3 é do backend de API)', {
          backend: 'local'
        })
      if (input.signal?.aborted) throw abortError()
      const voice = KOKORO_VOICES.find((v) => v.id === input.voice)
      if (!voice)
        throw new TtsError(
          'config',
          `voz "${input.voice}" desconhecida para o Kokoro (use: ${KOKORO_VOICES.map((v) => v.id).join(', ')})`,
          { backend: 'local' }
        )
      const t0 = Date.now()
      const [modelPath, voicePath] = await Promise.all([
        requireModel(),
        requireFile(voice.catalogId, `voz ${voice.id}`)
      ])
      const phonemes = (await phonemizeText(input.text, run)).trim()
      if (!phonemes)
        throw new TtsError('config', 'o texto não produziu fonemas para sintetizar', {
          backend: 'local'
        })
      const ids = kokoroInputIds(phonemes)
      if (!ids.length)
        throw new TtsError('config', 'os fonemas do texto estão fora do vocabulário do Kokoro', {
          backend: 'local'
        })
      // banco de estilos da voz: 510 linhas × 256 dims fp32; a linha = nº de tokens (máx. 509)
      const raw = await readFile(voicePath)
      const styles = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength >> 2)
      const row = Math.min(ids.length, KOKORO_MAX_TOKENS)
      const style = styles.slice(row * 256, row * 256 + 256)
      const session = await sessionFor(modelPath)
      if (input.signal?.aborted) throw abortError()
      const { waveform } = await session.run({
        input_ids: {
          type: 'int64',
          data: BigInt64Array.from([0n, ...ids.map((i) => BigInt(i)), 0n]),
          dims: [1, ids.length + 2]
        },
        style: { type: 'float32', data: style, dims: [1, 256] },
        speed: { type: 'float32', data: Float32Array.from([1]), dims: [1] }
      })
      if (input.signal?.aborted) throw abortError()
      const pcm = floatToPcm16(waveform.data)
      if (!pcm.length)
        throw new TtsError('config', 'o motor local devolveu áudio vazio', { backend: 'local' })
      return {
        audio: encodeWav(pcm, KOKORO_SAMPLE_RATE),
        mime: 'audio/wav',
        model: modelPath.endsWith('model_quantized.onnx') ? 'kokoro-onnx-q8' : 'kokoro-onnx',
        ms: Date.now() - t0
      }
    }
  }
}

/** Float32 [-1, 1] → PCM16 little-endian (clamp — o decoder pode passar de ±1 em picos). */
export function floatToPcm16(samples: Float32Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2)
  const view = new DataView(out.buffer)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(i * 2, Math.round(s * 0x7fff), true)
  }
  return out
}
