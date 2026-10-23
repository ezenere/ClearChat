// Motor local de STT (SPEC → "Áudio → Runtime local de STT"): implementa `SttLocalBackend`
// (`src/main/voice/stt.ts`) sobre os modelos do catálogo instalados por `voice/models.ts`.
// Sem Electron, sem UI, sem IPC (o `baseDir` = userData chega por `resolveSttModelsBaseDir`,
// injetável) e com o carregamento do motor preguiçoso e cacheado (uma vez por modelo).
//
// Engines (decisão medida no spike — SPEC → "Áudio → Runtime local de STT"):
// - `whisper.cpp` (ggml `.bin` do catálogo): `@napi-rs/whisper` (Node-API pré-compilado, MIT) —
//   transcrição final e parciais em janelas (a sessão dispara a cada `STT_PARTIAL_INTERVAL_MS`;
//   `onNewSegment` do binding não dispara na 0.0.4 — medido — então parciais por callback ficam
//   para engines de streaming). A inferência roda num PROCESSO à parte (`sttWorker.ts` via
//   `sttWorkerHost.ts` — `utilityProcess` no app): `Whisper.full()` é síncrono e, no main,
//   congelava o app inteiro durante a transcrição.
// - `vosk`: extração do `.zip` em `models/<id>/` implementada e verificada (`zip.ts`), executada
//   na primeira transcrição; o motor de inferência (libvosk) ainda NÃO está plugado nesta versão —
//   erro legível por engine. A abordagem medida no spike (vosk-koffi, streaming real) fica
//   documentada como recomendação.
// - `nemotron` (GGUF): sem motor nesta versão (exigiria runtime llama.cpp) — idem.
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { availableParallelism } from 'node:os'
import { join } from 'node:path'
import type { SttLocalConfig, SttLocalEngine } from '@shared/voice'
import { abortError } from '../tools/util'
import {
  catalogFileName,
  findCatalogEntry,
  LOCAL_MODEL_CATALOG,
  type LocalModelCatalogEntry
} from './catalog'
import { modelsDir, resolveLocalModelPath } from './models'
import {
  languageParam,
  SttError,
  type SttLocalBackend,
  type TranscribeAudioInput,
  type TranscribeResult
} from './stt'
import { sharedSttWorkerHost, type SttWorkerHost } from './sttWorkerHost'
import { extractZipToDir } from './zip'

// ---------------- engines suportadas ----------------

// ---------------- probe do runtime (binding nativo carregável?) ----------------

/** Resultado do probe do runtime de um engine. */
export interface SttRuntimeProbe {
  available: boolean
  /** Motivo legível quando indisponível. */
  reason: string | null
}

let whisperProbe: SttRuntimeProbe | null = null
let whisperProbing: Promise<SttRuntimeProbe> | null = null

/**
 * Confere (uma vez por execução — memoizado) que o binding do whisper.cpp (`@napi-rs/whisper`)
 * carrega DE VERDADE no processo onde a inferência roda (o worker). Nunca lança: falha vira
 * `{ available: false, reason }`. Os canais de IPC esperam isto antes de derivar "pronto".
 */
export function probeWhisperRuntime(host?: SttWorkerHost): Promise<SttRuntimeProbe> {
  if (whisperProbe) return Promise.resolve(whisperProbe)
  if (!whisperProbing) {
    whisperProbing = (host ?? sharedSttWorkerHost())
      .probe()
      .then((r) => {
        whisperProbe = {
          available: r.available,
          reason: r.available
            ? null
            : `o motor whisper.cpp não pôde ser carregado nesta instalação (${r.reason ?? 'motivo desconhecido'})`
        }
        return whisperProbe
      })
      .finally(() => {
        whisperProbing = null
      })
  }
  return whisperProbing
}

/** Define/zera o resultado memoizado do probe (testes; null = ainda não sondado). */
export function setWhisperRuntimeProbe(probe: SttRuntimeProbe | null): void {
  whisperProbe = probe
}

/** Último probe do whisper.cpp (null = ainda não sondado). */
export function whisperRuntimeProbe(): SttRuntimeProbe | null {
  return whisperProbe
}

/**
 * O runtime desta versão consegue carregar o engine? Síncrona — usada por `deriveHasLocalReady`
 * ("pronto = modelo instalado + runtime carregável") e pelo próprio backend. `whisper.cpp` vale
 * enquanto o probe (`probeWhisperRuntime`, memoizado) não disser o contrário: os caminhos de IPC
 * aguardam o probe antes de perguntar, então no app a resposta já reflete o binding real.
 */
export function isSttEngineRuntimeAvailable(engine: SttLocalEngine): boolean {
  return engine === 'whisper.cpp' && whisperProbe?.available !== false
}

/** Motivo legível de o runtime do engine estar indisponível (null = disponível/desconhecido). */
export function sttEngineUnavailableReason(engine: SttLocalEngine): string | null {
  if (engine !== 'whisper.cpp') return null
  return whisperProbe?.available === false ? whisperProbe.reason : null
}

/** Erro por engine quando o runtime de inferência não existe nesta versão (honesto e legível). */
export function engineUnavailableError(engine: SttLocalEngine): SttError {
  const hint =
    engine === 'vosk'
      ? "o modelo Vosk é extraído e verificado por este runtime, mas o motor de inferência (libvosk) ainda não está plugado nesta versão — use o engine 'whisper.cpp' ou o modo API"
      : engine === 'whisper.cpp'
        ? `${sttEngineUnavailableReason(engine) ?? 'o motor whisper.cpp não pôde ser carregado nesta instalação'} — use o modo API`
        : `o engine '${engine}' ainda não tem motor de inferência nesta versão — use o engine 'whisper.cpp' ou o modo API`
  return new SttError('config', `motor local de transcrição não está pronto — ${hint}`, {
    backend: 'local'
  })
}

// ---------------- baseDir (userData) ----------------

let baseDirOverride: string | null = null

/**
 * Define a pasta base dos modelos (`<userData>`, pai de `models/`). Testes e integração podem
 * chamar; sem isto, `resolveSttModelsBaseDir` tenta `CLEARCHAT_USER_DATA` (testes isolados do
 * app) e o Electron (`app.getPath('userData')`) — fora disso, null (motor "não pronto").
 */
export function setSttLocalBaseDir(dir: string | null): void {
  baseDirOverride = dir
}

/** `<userData>` dos modelos locais (null quando não há como resolver — ex.: Node puro de teste). */
export function resolveSttModelsBaseDir(): string | null {
  if (baseDirOverride !== null) return baseDirOverride
  const env = process.env.CLEARCHAT_USER_DATA?.trim()
  if (env) return env
  try {
    // Electron main: `require('electron')` devolve a API; no Node puro devolve o caminho do
    // binário (string) — daí o guard. Sem import estático para o módulo continuar sem Electron
    // (`__filename` só existe no CJS do build; no ESM dos testes o createRequire resolve pelo cwd).
    const base = typeof __filename === 'string' ? __filename : join(process.cwd(), 'stt-local.js')
    const electron = createRequire(base)('electron') as
      { app?: { getPath(name: string): string } } | string
    const app = typeof electron === 'object' ? electron.app : undefined
    const dir = app?.getPath?.('userData')
    return typeof dir === 'string' && dir ? dir : null
  } catch {
    return null
  }
}

// ---------------- wav PCM16 → Float32 mono ----------------

export interface DecodedWav {
  /** Amostras mono em [-1, 1]. */
  samples: Float32Array
  sampleRate: number
}

/**
 * Decodifica wav PCM16 (cabeçalho RIFF com chunks variados — o ffmpeg grava `LIST`) para Float32
 * mono (canais mixados na média). Comprimido/`bits != 16` → erro legível (a sessão sempre envia
 * wav PCM16 mono 16 kHz de `encodeWav`).
 */
export function decodeWavToMonoFloat32(wav: Uint8Array): DecodedWav {
  const dv = new DataView(wav.buffer, wav.byteOffset, wav.byteLength)
  const ascii = (o: number, n: number): string => String.fromCharCode(...wav.subarray(o, o + n))
  if (wav.byteLength < 44 || ascii(0, 4) !== 'RIFF' || ascii(8, 4) !== 'WAVE')
    throw new Error('áudio local espera wav RIFF/WAVE (PCM16)')
  let pos = 12
  let fmt: { channels: number; sampleRate: number; bits: number } | null = null
  let data: { off: number; size: number } | null = null
  while (pos + 8 <= wav.byteLength) {
    const id = ascii(pos, 4)
    const size = dv.getUint32(pos + 4, true)
    const body = pos + 8
    if (id === 'fmt ') {
      if (body + 16 > wav.byteLength) break
      fmt = {
        channels: dv.getUint16(body + 2, true),
        sampleRate: dv.getUint32(body + 4, true),
        bits: dv.getUint16(body + 14, true)
      }
    } else if (id === 'data') {
      data = { off: body, size: Math.min(size, wav.byteLength - body) }
    }
    pos = body + size + (size % 2)
  }
  if (!fmt || !data) throw new Error('wav inválido: chunk "fmt "/"data" ausente')
  if (fmt.bits !== 16 || !fmt.channels || !fmt.sampleRate)
    throw new Error(
      `áudio local espera wav PCM16 (recebido ${fmt.bits} bits, ${fmt.channels} canais)`
    )
  const frames = Math.floor(data.size / 2 / fmt.channels)
  const out = new Float32Array(frames)
  for (let i = 0; i < frames; i++) {
    let acc = 0
    for (let c = 0; c < fmt.channels; c++)
      acc += dv.getInt16(data.off + (i * fmt.channels + c) * 2, true)
    out[i] = acc / fmt.channels / 32768
  }
  return { samples: out, sampleRate: fmt.sampleRate }
}

// ---------------- engine carregada (injetável para testes) ----------------

export interface SttEngineTranscribeOptions {
  language?: string
  /** Cancelamento (o worker descarta o resultado; o chamador recebe `AbortError` na hora). */
  signal?: AbortSignal
  /** Texto incremental enquanto o engine consome o áudio (engines de streaming). */
  onPartial?: (text: string) => void
}

/** Motor de inferência carregado para um modelo (o binding real fica atrás deste formato). */
export interface LoadedSttEngine {
  transcribe(samples: Float32Array, opts: SttEngineTranscribeOptions): Promise<{ text: string }>
}

/** Carrega o engine para o modelo (caminho do arquivo do catálogo); assíncrono e cacheável. */
export type SttEngineLoader = (modelPath: string) => Promise<LoadedSttEngine>

/** Threads da inferência local (deixa um núcleo para o resto do app; teto de 8 — medido). */
export function sttLocalThreads(): number {
  return Math.max(1, Math.min(8, availableParallelism() - 1))
}

/**
 * Loader padrão: o whisper.cpp roda no processo do worker (`sttWorkerHost.ts`) — o main só
 * despacha as amostras e espera a resposta (o event loop nunca bloqueia na inferência). A carga do
 * modelo acontece no worker, no primeiro `transcribe` (cache lá dentro, um modelo por vez).
 */
export async function loadWhisperEngine(
  modelPath: string,
  host: SttWorkerHost = sharedSttWorkerHost()
): Promise<LoadedSttEngine> {
  return {
    async transcribe(samples, opts) {
      const r = await host.transcribe(modelPath, samples, {
        language: languageParam(opts.language),
        nThreads: sttLocalThreads(),
        signal: opts.signal
      })
      return { text: r.text }
    }
  }
}

/**
 * Libera o modelo `modelPath` (ou qualquer um) do processo do worker e do cache de engines — ao
 * remover um modelo ou trocar a seleção (no máximo um modelo carregado).
 */
export function releaseSttModel(modelPath?: string): void {
  for (const key of [...sharedEngineCache.keys()])
    if (!modelPath || key === modelPath) sharedEngineCache.delete(key)
  sharedSttWorkerHost().unload(modelPath)
}

// ---------------- resolução do modelo ----------------

function catalogEntries(
  catalog: readonly LocalModelCatalogEntry[],
  engine: SttLocalEngine
): LocalModelCatalogEntry[] {
  return catalog.filter((e) => e.kind === 'stt' && e.engine === engine)
}

/**
 * Entrada do catálogo a carregar: a escolhida em `sttSettings.local.model` quando existe; sem
 * escolha, a primeira do engine com arquivo instalado em disco (a "escolha do runtime"), senão a
 * primeira do engine. Ausente/incompatível → erro legível.
 */
function resolveModelEntry(
  baseDir: string,
  selection: Pick<SttLocalConfig, 'engine' | 'model'>,
  catalog: readonly LocalModelCatalogEntry[]
): LocalModelCatalogEntry {
  const wanted = selection.model.trim()
  if (wanted) {
    const entry = findCatalogEntry(wanted, catalog)
    if (!entry)
      throw new SttError('config', `modelo local desconhecido: ${wanted}`, { backend: 'local' })
    if (entry.engine !== selection.engine)
      throw new SttError(
        'config',
        `modelo local ${wanted} é do engine '${entry.engine}', mas o engine escolhido é '${selection.engine}'`,
        { backend: 'local' }
      )
    return entry
  }
  const entries = catalogEntries(catalog, selection.engine)
  const fileOf = (e: LocalModelCatalogEntry): string | null => {
    const f = catalogFileName(e)
    return f ? join(modelsDir(baseDir), f) : null
  }
  const installed = entries.find((e) => {
    const p = fileOf(e)
    return p && existsSync(p)
  })
  const entry = installed ?? entries[0]
  if (!entry)
    throw new SttError(
      'config',
      `nenhum modelo local no catálogo para o engine '${selection.engine}'`,
      {
        backend: 'local'
      }
    )
  return entry
}

// ---------------- Vosk: extração do .zip ----------------

/** Arquivos mínimos de um modelo Vosk extraído (Kaldi) — a verificação da extração. */
const VOSK_MODEL_FILES = ['final.mdl', 'Gr.fst', 'HCLr.fst', 'mfcc.conf', 'ivector/final.ie']

/**
 * Confere que `dir` tem cara de modelo Vosk extraído (arquivos Kaldi presentes). Idempotente;
 * false quando falta algo (extração pendente/corrompida).
 */
export function verifyVoskModelDir(dir: string): boolean {
  return VOSK_MODEL_FILES.every((f) => existsSync(join(dir, f)))
}

/**
 * Garante o modelo Vosk `id` extraído em `<baseDir>/models/<id>/` (a instalação baixa o `.zip`;
 * ver `voice/models.ts`): extrai com `zip.ts` (store+deflate, CRC-32, caminhos seguros) e verifica
 * os arquivos Kaldi. Já extraído → devolve o caminho sem tocar em nada. `.zip` ausente → erro
 * legível ("baixe em Configurações").
 */
export async function ensureVoskModelExtracted(baseDir: string, id: string): Promise<string> {
  const entry = findCatalogEntry(id)
  if (!entry || entry.engine !== 'vosk') throw new Error(`modelo Vosk desconhecido: ${id}`)
  const zipName = catalogFileName(entry)
  if (!zipName) throw new Error(`modelo ${id} não tem arquivo definido (placeholder sem download)`)
  const dir = join(modelsDir(baseDir), id)
  if (verifyVoskModelDir(dir)) return dir
  const zipPath = join(modelsDir(baseDir), zipName)
  if (!existsSync(zipPath))
    throw new Error(`modelo local não instalado: ${zipName} não está em ${modelsDir(baseDir)}`)
  await extractZipToDir(zipPath, modelsDir(baseDir), { expectedRoot: id })
  if (!verifyVoskModelDir(dir))
    throw new Error(`extração do modelo ${id} incompleta (arquivos Kaldi ausentes)`)
  return dir
}

// ---------------- backend ----------------

export interface CreateSttLocalBackendOptions {
  /** Pasta base dos modelos (pai de `models/`); padrão `resolveSttModelsBaseDir()`. */
  baseDir?: string | null
  /** Engine/modelo escolhidos em `sttSettings.local`; null = nenhum (nunca pronto). */
  selection: Pick<SttLocalConfig, 'engine' | 'model'> | null
  /** Catálogo a considerar (padrão `LOCAL_MODEL_CATALOG`; injetável para testes). */
  catalog?: readonly LocalModelCatalogEntry[]
  /** Loader do motor (padrão `loadWhisperEngine`; injetável para testes). */
  loadEngine?: SttEngineLoader
  /**
   * Cache de engines carregadas por caminho de modelo (lazy, uma vez). Padrão: mapa do módulo —
   * o modelo não recarrega entre sessões de ditado. Testes passam um mapa novo para isolar.
   */
  engineCache?: Map<string, Promise<LoadedSttEngine>>
}

const sharedEngineCache = new Map<string, Promise<LoadedSttEngine>>()

/**
 * Teto de tamanho do modelo para parciais locais por janelas: até o `ggml-base` (~148 MB) a
 * janela volta em centenas de ms; do `small` para cima cada parcial custa segundos de CPU e
 * atrasaria a final (o worker é serial) — a sessão então só faz a transcrição final.
 */
export const STT_LOCAL_PARTIAL_MAX_MODEL_BYTES = 160_000_000

/**
 * `SttLocalBackend` para os modelos do catálogo: `ready` = engine com runtime + arquivo do modelo
 * em disco (checagem barata e síncrona); `transcribe` decodifica o wav, carrega o modelo uma vez
 * (lazy) e transcreve localmente (baseUrl `'local'`, `model` = id do modelo do catálogo). Erros
 * legíveis (`SttError` `config`) quando falta modelo/runtime ou o arquivo está corrompido.
 */
export function createSttLocalBackend(opts: CreateSttLocalBackendOptions): SttLocalBackend {
  const baseDir = opts.baseDir !== undefined ? opts.baseDir : resolveSttModelsBaseDir()
  const catalog = opts.catalog ?? LOCAL_MODEL_CATALOG
  const cache = opts.engineCache ?? sharedEngineCache
  const loadEngine = opts.loadEngine ?? loadWhisperEngine

  const modelFileExists = (): boolean => {
    if (!baseDir || !opts.selection) return false
    if (!isSttEngineRuntimeAvailable(opts.selection.engine)) return false
    try {
      const entry = resolveModelEntry(baseDir, opts.selection, catalog)
      const file = catalogFileName(entry)
      return !!file && existsSync(join(modelsDir(baseDir), file))
    } catch {
      return false
    }
  }

  const partialsAllowed = (): boolean => {
    if (!baseDir || !opts.selection) return false
    try {
      return (
        resolveModelEntry(baseDir, opts.selection, catalog).sizeBytes <=
        STT_LOCAL_PARTIAL_MAX_MODEL_BYTES
      )
    } catch {
      return false
    }
  }

  return {
    get ready(): boolean {
      return modelFileExists()
    },
    get partials(): boolean {
      return partialsAllowed()
    },
    async transcribe(
      input: TranscribeAudioInput,
      callOpts: {
        language?: string
        timeoutMs?: number
        signal?: AbortSignal
        onPartial?: (text: string) => void
      }
    ): Promise<TranscribeResult> {
      if (callOpts.signal?.aborted) throw abortError()
      const t0 = Date.now()
      if (!baseDir)
        throw new SttError(
          'config',
          'motor local de transcrição não está pronto — pasta de modelos locais indisponível',
          { backend: 'local' }
        )
      const selection = opts.selection
      if (!selection)
        throw new SttError(
          'config',
          'motor local de transcrição não está pronto — nenhum modelo local configurado',
          { backend: 'local' }
        )
      const entry = resolveModelEntry(baseDir, selection, catalog)
      if (entry.engine === 'vosk') {
        // a extração/verificação do .zip roda aqui (pronta para quando o motor Vosk entrar):
        // falha de extração é anotada no erro honesto do engine que não tem runtime nesta versão
        try {
          await ensureVoskModelExtracted(baseDir, entry.id)
        } catch (e) {
          throw new SttError(
            'config',
            `motor local de transcrição não está pronto — ${e instanceof Error ? e.message : String(e)}`,
            { backend: 'local', cause: e }
          )
        }
        throw engineUnavailableError('vosk')
      }
      const sttEngine = entry.engine as SttLocalEngine
      if (!isSttEngineRuntimeAvailable(sttEngine)) throw engineUnavailableError(sttEngine)
      const modelPath = await resolveLocalModelPath(baseDir, entry.id, { catalog })
      if (!existsSync(modelPath))
        throw new SttError(
          'config',
          `motor local de transcrição não está pronto — modelo ${entry.id} não instalado (baixe em Configurações → Áudio)`,
          { backend: 'local' }
        )
      const { samples } = decodeWavToMonoFloat32(input.audio)
      if (callOpts.signal?.aborted) throw abortError()
      let pending = cache.get(modelPath)
      if (!pending) {
        pending = loadEngine(modelPath)
        cache.set(modelPath, pending)
        pending.catch(() => cache.delete(modelPath))
      }
      const engine = await pending
      if (callOpts.signal?.aborted) throw abortError()
      const { text } = await engine.transcribe(samples, {
        language: languageParam(callOpts.language) ?? undefined,
        signal: callOpts.signal,
        onPartial: callOpts.onPartial
      })
      return { text, model: entry.id, baseUrl: 'local', ms: Date.now() - t0 }
    }
  }
}
