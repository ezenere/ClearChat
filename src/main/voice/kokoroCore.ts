// Núcleo PURO do motor local Kokoro (sem nada do app): fonemização pt-BR pelo `espeak-ng` do
// SISTEMA (o mesmo G2P do misaki — `EspeakG2P` — que gerou os fonemas de treino das vozes pt-BR do
// Kokoro), vocabulário/ids, a chamada da sessão ONNX e o PCM16 de saída. Roda no processo do motor
// (`ttsWorker.ts` — o `session.run` do onnxruntime-node é síncrono e travaria o event loop do main)
// e, com sessão injetada, no motor em processo dos testes (`ttsLocal.ts`). Erros saem como
// `KokoroCoreError` com código + mensagem legível pt-BR (o host traduz em `TtsError`).
// O pipeline é o do `hexgrad/kokoro` (`model.py`): fonemas → ids por caractere (chars fora do
// vocabulário caem) → `[0, *ids, 0]` → estilo `voice[min(ids, 509)]` → `waveform` a 24 kHz.
import { spawn } from 'node:child_process'

/** Taxa de amostragem do Kokoro v1.0 (o decoder devolve 24 kHz). */
export const KOKORO_SAMPLE_RATE = 24_000

/** Categoria de um erro do núcleo (o host traduz em `TtsError` `config`). */
export type KokoroCoreErrorCode =
  /** espeak-ng ausente no sistema. */
  | 'espeak-missing'
  /** espeak-ng falhou/estourou o tempo. */
  | 'espeak'
  /** Texto sem fonemas / fora do vocabulário / áudio vazio. */
  | 'input'
  /** Runtime ONNX não carrega. */
  | 'runtime'
  /** Modelo ONNX inválido/corrompido. */
  | 'model'
  /** Pedido cancelado antes da inferência. */
  | 'aborted'
  /** Demais falhas. */
  | 'internal'

/** Erro do núcleo com código (mensagem pt-BR legível). */
export class KokoroCoreError extends Error {
  readonly code: KokoroCoreErrorCode
  constructor(code: KokoroCoreErrorCode, message: string, cause?: unknown) {
    super(message, { cause })
    this.name = 'KokoroCoreError'
    this.code = code
  }
}

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

// ---------------- sessão ONNX (forma mínima) ----------------

/** Tensor mínimo do runtime ONNX (injetável — a implementação padrão é a `onnxruntime-node`). */
export interface KokoroTensor {
  type: 'int64' | 'float32'
  data: BigInt64Array | Float32Array
  dims: number[]
}

/** Sessão ONNX mínima do modelo Kokoro (injetável). */
export interface KokoroSession {
  run(feeds: Record<string, KokoroTensor>): Promise<{ waveform: { data: Float32Array } }>
  /** Libera a sessão nativa (opcional — a padrão chama `InferenceSession.release`). */
  release?(): Promise<void>
}

/**
 * Threads da inferência do Kokoro (onnxruntime `intraOpNumThreads`): metade dos núcleos lógicos,
 * teto de 4. Medido (Ryzen 9 9950X, fp32, frase de 56 chars): padrão do onnxruntime (todos os
 * núcleos, com spin) 359 ms de parede e 10,8 s de CPU; 4 threads sem spin 331 ms e 0,95 s de CPU;
 * 8 threads só ~13% mais rápido com ~30% mais CPU. No int8 o padrão chegava a 39 s de CPU por frase.
 */
export function kokoroThreads(cores: number): number {
  return Math.max(1, Math.min(4, Math.floor(cores / 2)))
}

/**
 * Opções da `InferenceSession` do Kokoro: CPU, `kokoroThreads` intra-op, 1 inter-op e SEM spin
 * das threads ociosas (o spin queimava núcleos inteiros entre as frases da chamada).
 */
export function kokoroSessionOptions(cores: number): {
  executionProviders: string[]
  intraOpNumThreads: number
  interOpNumThreads: number
  graphOptimizationLevel: 'all'
  extra: { session: Record<string, string> }
} {
  return {
    executionProviders: ['cpu'],
    intraOpNumThreads: kokoroThreads(cores),
    interOpNumThreads: 1,
    graphOptimizationLevel: 'all',
    extra: { session: { 'intra_op.allow_spinning': '0', 'inter_op.allow_spinning': '0' } }
  }
}

// ---------------- espeak-ng ----------------

/** Como instalar o espeak-ng nesta plataforma (texto da mensagem de erro). */
export function espeakInstallHint(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'darwin') return 'instale com o Homebrew: `brew install espeak-ng`'
  if (platform === 'win32')
    return 'instale o espeak-ng para Windows (github.com/espeak-ng/espeak-ng/releases) e deixe o espeak-ng.exe no PATH'
  return 'instale o pacote "espeak-ng" pelo gerenciador de pacotes da sua distribuição (ex.: `sudo apt install espeak-ng`, `sudo dnf install espeak-ng` ou `sudo pacman -S espeak-ng`)'
}

/** Mensagem legível de espeak-ng ausente (com a dica da plataforma). */
export function espeakMissingMessage(platform: NodeJS.Platform = process.platform): string {
  return `espeak-ng não encontrado no sistema — o motor local Kokoro usa o espeak-ng para a fonemização pt-BR (${espeakInstallHint(platform)})`
}

/** Runner de comandos (o espeak-ng) — injetável nos testes. */
export type CommandRunner = (command: string, args: string[]) => Promise<string>

/**
 * Runner padrão do espeak-ng (CLI do sistema — o app não embute o espeak-ng, que é GPL): falha vira
 * `KokoroCoreError` `espeak-missing` (ENOENT) ou `espeak` (código ≠ 0 / tempo esgotado).
 */
export async function runEspeak(command: string, args: string[]): Promise<string> {
  try {
    return await spawnCapture(command, args)
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { killed?: boolean; stderr?: string }
    if (err.code === 'ENOENT')
      throw new KokoroCoreError('espeak-missing', espeakMissingMessage(), e)
    const detail = (err.stderr ?? '').toString().replace(/\s+/g, ' ').trim().slice(0, 160)
    throw new KokoroCoreError(
      'espeak',
      err.killed
        ? 'tempo esgotado na fonemização (espeak-ng)'
        : `falha na fonemização (espeak-ng)${detail ? ` — ${detail}` : ''}`,
      e
    )
  }
}

const ESPEAK_TIMEOUT_MS = 15_000
const ESPEAK_MAX_OUTPUT = 1 << 20

/**
 * Executa um comando sem shell, com stdin FECHADO (o espeak-ng lê o stdin quando não recebe texto —
 * nunca pode ficar esperando), timeout e teto de saída. Devolve o stdout.
 */
function spawnCapture(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch (e) {
      reject(e)
      return
    }
    const out: Buffer[] = []
    const err: Buffer[] = []
    let size = 0
    let killed = false
    const timer = setTimeout(() => {
      killed = true
      child.kill('SIGKILL')
    }, ESPEAK_TIMEOUT_MS)
    child.stdout?.on('data', (b: Buffer) => {
      size += b.length
      if (size > ESPEAK_MAX_OUTPUT) {
        killed = true
        child.kill('SIGKILL')
        return
      }
      out.push(b)
    })
    child.stderr?.on('data', (b: Buffer) => {
      if (err.length < 16) err.push(b)
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0 && !killed) resolve(Buffer.concat(out).toString('utf8'))
      else
        reject(
          Object.assign(new Error(`${command} saiu com código ${code}`), {
            killed,
            stderr: Buffer.concat(err).toString('utf8')
          })
        )
    })
  })
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
    // `--` encerra as opções: texto começando com '-' ("- item", "-f/arquivo", "-w…") nunca vira
    // opção do espeak-ng (antes: frase descartada, arquivo arbitrário lido ou espera no stdin)
    const frag = mapEspeakPhonemes(
      await run('espeak-ng', ['-v', 'pt-br', '-q', '--ipa=3', '--', part])
    )
    ps += ps && !/\s$/.test(ps) ? ` ${frag}` : frag
  }
  return ps.trim().replace(/«/g, '(').replace(/»/g, ')')
}

// ---------------- síntese ----------------

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

/** Entrada da síntese no núcleo. */
export interface KokoroSynthInput {
  text: string
  /** Banco de estilos da voz (510 linhas × 256 dims fp32 — o `.bin` do voice pack). */
  styles: Float32Array
  session: KokoroSession
  run: CommandRunner
  /** Cancelado? (checado antes da inferência) — true → `KokoroCoreError` `aborted`. */
  aborted?: () => boolean
}

/** Resultado da síntese no núcleo: PCM16 mono a `KOKORO_SAMPLE_RATE` + tempos. */
export interface KokoroSynthOutput {
  pcm: Uint8Array
  /** Fonemização (espeak-ng). */
  phonemeMs: number
  /** Inferência ONNX. */
  inferMs: number
}

/** Bytes do voice pack (`<voz>.bin`) → banco de estilos Float32 (cópia alinhada). */
export function voiceStyles(raw: Uint8Array): Float32Array {
  const n = raw.byteLength >> 2
  const copy = new Uint8Array(n * 4)
  copy.set(raw.subarray(0, n * 4))
  return new Float32Array(copy.buffer)
}

/**
 * Texto → PCM16 com o pipeline do Kokoro: fonemas (espeak-ng + misaki) → ids → estilo
 * `styles[min(nº de tokens, 509)]` → `session.run` → float → PCM16. Erros → `KokoroCoreError`.
 */
export async function kokoroSynthesizePcm(input: KokoroSynthInput): Promise<KokoroSynthOutput> {
  const t0 = Date.now()
  const phonemes = (await phonemizeText(input.text, input.run)).trim()
  if (!phonemes) throw new KokoroCoreError('input', 'o texto não produziu fonemas para sintetizar')
  const ids = kokoroInputIds(phonemes)
  if (!ids.length)
    throw new KokoroCoreError('input', 'os fonemas do texto estão fora do vocabulário do Kokoro')
  const row = Math.min(ids.length, KOKORO_MAX_TOKENS)
  const style = input.styles.slice(row * 256, row * 256 + 256)
  if (style.length !== 256)
    throw new KokoroCoreError('model', 'voice pack do Kokoro inválido (banco de estilos curto)')
  const t1 = Date.now()
  if (input.aborted?.()) throw new KokoroCoreError('aborted', 'cancelado')
  const { waveform } = await input.session.run({
    input_ids: {
      type: 'int64',
      data: BigInt64Array.from([0n, ...ids.map((i) => BigInt(i)), 0n]),
      dims: [1, ids.length + 2]
    },
    style: { type: 'float32', data: style, dims: [1, 256] },
    speed: { type: 'float32', data: Float32Array.from([1]), dims: [1] }
  })
  const t2 = Date.now()
  const pcm = floatToPcm16(waveform.data)
  if (!pcm.length) throw new KokoroCoreError('input', 'o motor local devolveu áudio vazio')
  return { pcm, phonemeMs: t1 - t0, inferMs: t2 - t1 }
}
