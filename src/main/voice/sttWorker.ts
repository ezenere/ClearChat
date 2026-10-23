// Processo do motor local de STT (whisper.cpp via `@napi-rs/whisper`). Roda FORA do main do
// Electron — `utilityProcess` no app, `child_process.fork` nos testes/scripts em Node puro — porque
// `Whisper.full()` é síncrono e bloquearia o event loop do main durante toda a inferência (centenas
// de ms no tiny, segundos nos modelos maiores). Um crash nativo aqui derruba só este processo: o host
// (`sttWorkerHost.ts`) rejeita os pedidos pendentes com erro legível e o próximo pedido o recria.
//
// Autocontido: só importa tipos do protocolo (`sttWorkerProtocol.ts`) e carrega o binding nativo de
// forma preguiçosa. Mantém no máximo UM modelo carregado (trocar de modelo descarta o anterior).
// Ver SPEC → "Áudio → Runtime local de STT".
import { cleanWhisperText } from './sttText'
import type {
  SttWorkerProbeResult,
  SttWorkerErrorCode,
  SttWorkerRequest,
  SttWorkerResponse,
  SttWorkerTranscribeResult
} from './sttWorkerProtocol'

type WhisperModule = typeof import('@napi-rs/whisper')
type WhisperInstance = InstanceType<WhisperModule['Whisper']>

interface ParentPortLike {
  on(event: 'message', cb: (e: { data: unknown }) => void): void
  postMessage(msg: unknown): void
}

// Electron `utilityProcess` expõe `process.parentPort`; o `child_process.fork` do Node usa IPC
// (`process.send`/`process.on('message')`).
const parentPort = (process as unknown as { parentPort?: ParentPortLike }).parentPort

function send(msg: SttWorkerResponse): void {
  if (parentPort) parentPort.postMessage(msg)
  else process.send?.(msg)
}

function onRequest(cb: (msg: SttWorkerRequest) => void): void {
  if (parentPort) parentPort.on('message', (e) => cb(e.data as SttWorkerRequest))
  else process.on('message', (m) => cb(m as SttWorkerRequest))
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

let modPromise: Promise<WhisperModule> | null = null
function loadModule(): Promise<WhisperModule> {
  if (!modPromise) {
    // CJS (build do app/utilityProcess): `require` direto — resolve dentro do app.asar e cai no
    // `.node` desempacotado; ESM (testes em Node puro): import dinâmico
    const load: Promise<unknown> =
      typeof require === 'function'
        ? // eslint-disable-next-line @typescript-eslint/no-require-imports
          Promise.resolve().then(() => require('@napi-rs/whisper') as unknown)
        : import('@napi-rs/whisper')
    modPromise = load.then((m) => {
      // CJS importado como ESM pode vir embrulhado em `default`
      const mod = ((m as { default?: WhisperModule }).default ?? m) as WhisperModule
      if (typeof mod.Whisper !== 'function')
        throw new Error('binding @napi-rs/whisper sem a classe Whisper')
      return mod
    })
    modPromise.catch(() => {
      modPromise = null
    })
  }
  return modPromise
}

let loaded: { path: string; whisper: WhisperInstance } | null = null

class WorkerError extends Error {
  readonly code: SttWorkerErrorCode
  constructor(code: SttWorkerErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

async function probe(): Promise<SttWorkerProbeResult> {
  try {
    await loadModule()
    return { available: true, reason: null }
  } catch (e) {
    return { available: false, reason: errText(e) }
  }
}

async function transcribe(
  req: Extract<SttWorkerRequest, { type: 'transcribe' }>
): Promise<SttWorkerTranscribeResult> {
  let mod: WhisperModule
  try {
    mod = await loadModule()
  } catch (e) {
    throw new WorkerError('runtime', errText(e))
  }
  let loadMs = 0
  if (!loaded || loaded.path !== req.modelPath) {
    loaded = null // no máximo um modelo: solta o anterior antes de carregar o novo
    const t0 = Date.now()
    try {
      loaded = { path: req.modelPath, whisper: new mod.Whisper(req.modelPath) }
    } catch (e) {
      throw new WorkerError('model', errText(e))
    }
    loadMs = Date.now() - t0
  }
  if (!(req.samples instanceof Float32Array))
    throw new WorkerError('internal', 'amostras inválidas (esperado Float32Array)')
  const params = new mod.WhisperFullParams(mod.WhisperSamplingStrategy.Greedy)
  params.nThreads = Math.max(1, Math.floor(req.nThreads) || 1)
  params.noTimestamps = true
  params.printProgress = false
  params.printRealtime = false
  if (req.language) params.language = req.language
  else params.detectLanguage = true
  // parciais: contexto do encoder ~ duração da janela (o whisper sempre codifica 30 s de mel) e
  // teto de tokens (contexto curto às vezes entra em laço de repetição)
  const fullCtx = loaded.whisper.modelNAudioCtx || 1500
  const ctx = Math.floor(req.audioCtx ?? 0)
  if (ctx > 0 && ctx < fullCtx) params.audioCtx = ctx
  const maxTokens = Math.floor(req.maxTokens ?? 0)
  if (maxTokens > 0) params.maxTokens = maxTokens
  const t1 = Date.now()
  let text: string
  try {
    // síncrono — por isso este processo existe (o main segue livre)
    text = loaded.whisper.full(params, req.samples)
  } catch (e) {
    throw new WorkerError('internal', errText(e))
  }
  return { text: cleanWhisperText(text), inferMs: Date.now() - t1, loadMs }
}

// Pedidos em série numa fila explícita (o whisper é síncrono de qualquer forma; a fila evita
// reentrância na carga). O host já manda UMA transcrição por vez (as outras esperam lá e saem sem
// custo quando abortadas); entre um pedido e o próximo o worker volta ao event loop.
const queue: SttWorkerRequest[] = []
let draining = false

function respondError(id: number, e: unknown): void {
  send({
    id,
    ok: false,
    code: e instanceof WorkerError ? e.code : 'internal',
    message: errText(e)
  })
}

async function handle(req: SttWorkerRequest): Promise<void> {
  try {
    if (req.type === 'probe') send({ id: req.id, ok: true, value: await probe() })
    else if (req.type === 'transcribe') send({ id: req.id, ok: true, value: await transcribe(req) })
    else if (req.type === 'unload') {
      loaded = null
      send({ id: req.id, ok: true, value: null })
    } else
      respondError((req as { id: number }).id, new WorkerError('internal', 'pedido desconhecido'))
  } catch (e) {
    respondError(req.id, e)
  }
}

function drain(): void {
  if (draining) return
  draining = true
  setImmediate(() => {
    const next = queue.shift()
    if (!next) {
      draining = false
      return
    }
    void handle(next).finally(() => {
      draining = false
      if (queue.length) drain()
    })
  })
}

onRequest((req) => {
  if (!req || typeof req !== 'object' || typeof req.id !== 'number') return
  queue.push(req)
  drain()
})

// O processo vive enquanto houver canal com o main; se o pai morrer (fork do Node), sai junto.
process.on('disconnect', () => process.exit(0))
