// Processo do motor local de TTS (Kokoro: onnxruntime-node + fonemização pelo espeak-ng). Roda FORA
// do main do Electron — `utilityProcess` no app, `child_process.fork` nos testes/scripts em Node
// puro — porque o `session.run` do onnxruntime-node 1.30 é síncrono (roda dentro de um
// `setImmediate`) e travava o event loop do main por toda a síntese (0,4–2,7 s por frase: IPC,
// timers e o streaming do chat congelados). Um crash nativo aqui derruba só este processo: o host
// (`ttsWorkerHost.ts`) rejeita os pendentes com erro legível e o próximo pedido o recria.
//
// Autocontido: só importa os módulos puros `kokoroCore.ts`/`wav.ts` e os tipos do protocolo; o
// binding nativo carrega de forma preguiçosa. No máximo UMA sessão ONNX carregada.
// Ver SPEC → "Áudio → Serviço de TTS → Processo do motor local".
import { readFile } from 'node:fs/promises'
import type { InferenceSession, Tensor } from 'onnxruntime-node'
import {
  KokoroCoreError,
  KOKORO_SAMPLE_RATE,
  kokoroSynthesizePcm,
  runEspeak,
  voiceStyles,
  type KokoroSession
} from './kokoroCore'
import { encodeWav } from './wav'
import type {
  TtsWorkerErrorCode,
  TtsWorkerProbeResult,
  TtsWorkerRequest,
  TtsWorkerResponse,
  TtsWorkerSynthResult
} from './ttsWorkerProtocol'

type OrtModule = typeof import('onnxruntime-node')

interface ParentPortLike {
  on(event: 'message', cb: (e: { data: unknown }) => void): void
  postMessage(msg: unknown): void
}

// Electron `utilityProcess` expõe `process.parentPort`; o `child_process.fork` do Node usa IPC.
const parentPort = (process as unknown as { parentPort?: ParentPortLike }).parentPort

function send(msg: TtsWorkerResponse): void {
  if (parentPort) parentPort.postMessage(msg)
  else process.send?.(msg)
}

function onRequest(cb: (msg: TtsWorkerRequest) => void): void {
  if (parentPort) parentPort.on('message', (e) => cb(e.data as TtsWorkerRequest))
  else process.on('message', (m) => cb(m as TtsWorkerRequest))
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

class WorkerError extends Error {
  readonly code: TtsWorkerErrorCode
  constructor(code: TtsWorkerErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

let ortPromise: Promise<OrtModule> | null = null
function loadOrt(): Promise<OrtModule> {
  if (!ortPromise) {
    // CJS (build do app/utilityProcess): `require` direto — resolve dentro do app.asar e cai no
    // `.node` desempacotado; ESM (testes em Node puro): import dinâmico
    const load: Promise<unknown> =
      typeof require === 'function'
        ? // eslint-disable-next-line @typescript-eslint/no-require-imports
          Promise.resolve().then(() => require('onnxruntime-node') as unknown)
        : import('onnxruntime-node')
    ortPromise = load.then((m) => {
      const mod = (
        (m as { default?: OrtModule }).default?.InferenceSession
          ? (m as { default: OrtModule }).default
          : m
      ) as OrtModule
      if (typeof mod.InferenceSession?.create !== 'function')
        throw new Error('onnxruntime-node sem InferenceSession')
      return mod
    })
    ortPromise.catch(() => {
      ortPromise = null
    })
  }
  return ortPromise
}

async function probe(): Promise<TtsWorkerProbeResult> {
  try {
    await loadOrt()
    return { available: true, reason: null }
  } catch (e) {
    return { available: false, reason: errText(e) }
  }
}

let loaded: { path: string; session: InferenceSession; wrapped: KokoroSession } | null = null
const voices = new Map<string, Float32Array>()

async function releaseSession(): Promise<void> {
  const cur = loaded
  loaded = null
  if (cur) await cur.session.release().catch(() => undefined)
}

async function sessionFor(modelPath: string): Promise<{ session: KokoroSession; loadMs: number }> {
  if (loaded?.path === modelPath) return { session: loaded.wrapped, loadMs: 0 }
  let ort: OrtModule
  try {
    ort = await loadOrt()
  } catch (e) {
    throw new WorkerError('runtime', errText(e))
  }
  await releaseSession() // no máximo uma sessão: solta a anterior antes de carregar a nova
  const t0 = Date.now()
  let session: InferenceSession
  try {
    session = await ort.InferenceSession.create(modelPath, { executionProviders: ['cpu'] })
  } catch (e) {
    throw new WorkerError('model', errText(e))
  }
  const wrapped: KokoroSession = {
    async run(feeds) {
      const ortFeeds: Record<string, Tensor> = {}
      for (const [name, t] of Object.entries(feeds))
        ortFeeds[name] = new ort.Tensor(t.type, t.data, t.dims)
      const out = await session.run(ortFeeds)
      return { waveform: out.waveform as unknown as { data: Float32Array } }
    }
  }
  loaded = { path: modelPath, session, wrapped }
  return { session: wrapped, loadMs: Date.now() - t0 }
}

async function stylesFor(voicePath: string): Promise<Float32Array> {
  let s = voices.get(voicePath)
  if (!s) {
    try {
      s = voiceStyles(await readFile(voicePath))
    } catch (e) {
      throw new WorkerError('model', `voice pack ilegível (${errText(e)})`)
    }
    voices.set(voicePath, s)
  }
  return s
}

/** Pedidos cancelados pelo host (marcados na chegada da mensagem, antes da vez deles na fila). */
const cancelled = new Set<number>()
/** Último pedido já processado (os ids chegam em ordem): cancelar um antigo não deixa resto no Set. */
let lastDone = 0

async function synthesize(
  req: Extract<TtsWorkerRequest, { type: 'synthesize' }>
): Promise<TtsWorkerSynthResult> {
  if (typeof req.text !== 'string' || !req.text.trim())
    throw new WorkerError('input', 'texto para a síntese de fala está vazio')
  const [{ session, loadMs }, styles] = await Promise.all([
    sessionFor(req.modelPath),
    stylesFor(req.voicePath)
  ])
  try {
    const out = await kokoroSynthesizePcm({
      text: req.text,
      styles,
      session,
      run: runEspeak,
      aborted: () => cancelled.has(req.id)
    })
    return {
      audio: encodeWav(out.pcm, KOKORO_SAMPLE_RATE),
      sampleRate: KOKORO_SAMPLE_RATE,
      phonemeMs: out.phonemeMs,
      inferMs: out.inferMs,
      loadMs
    }
  } catch (e) {
    if (e instanceof KokoroCoreError) throw new WorkerError(e.code, e.message)
    throw e
  }
}

// Pedidos em série (a inferência é síncrona de qualquer forma; a fila evita reentrância na carga).
let chain: Promise<void> = Promise.resolve()

onRequest((req) => {
  if (!req || typeof req !== 'object' || typeof req.id !== 'number') return
  // cancelamento entra na hora (fora da fila): o pedido alvo, se ainda não rodou, sai `aborted`
  if (req.type === 'cancel') {
    if (typeof req.target === 'number' && req.target > lastDone) cancelled.add(req.target)
    return
  }
  chain = chain.then(async () => {
    try {
      if (cancelled.has(req.id)) throw new WorkerError('aborted', 'cancelado')
      if (req.type === 'probe') send({ id: req.id, ok: true, value: await probe() })
      else if (req.type === 'synthesize')
        send({ id: req.id, ok: true, value: await synthesize(req) })
      else if (req.type === 'unload') {
        await releaseSession()
        voices.clear()
        send({ id: req.id, ok: true, value: null })
      } else
        send({
          id: (req as { id: number }).id,
          ok: false,
          code: 'internal',
          message: 'pedido desconhecido'
        })
    } catch (e) {
      send({
        id: req.id,
        ok: false,
        code: e instanceof WorkerError ? e.code : 'internal',
        message: errText(e)
      })
    } finally {
      cancelled.delete(req.id)
      lastDone = Math.max(lastDone, req.id)
    }
  })
})

// O processo vive enquanto houver canal com o main; se o pai morrer (fork do Node), sai junto.
process.on('disconnect', () => process.exit(0))
