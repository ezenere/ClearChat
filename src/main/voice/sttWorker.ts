// Processo do motor local de STT (whisper.cpp via `@napi-rs/whisper`). Roda FORA do main do
// Electron — `utilityProcess` no app, `child_process.fork` nos testes/scripts em Node puro — porque
// `Whisper.full()` é síncrono e bloquearia o event loop do main durante toda a inferência (centenas
// de ms no tiny, segundos nos modelos maiores). Um crash nativo aqui derruba só este processo: o host
// (`sttWorkerHost.ts`) rejeita os pedidos pendentes com erro legível e o próximo pedido o recria.
//
// Autocontido: só importa tipos do protocolo (`sttWorkerProtocol.ts`) e carrega o binding nativo de
// forma preguiçosa. Mantém no máximo UM modelo carregado (trocar de modelo descarta o anterior).
// Ver SPEC → "Áudio → Runtime local de STT".
import type {
  SttWorkerProbeResult,
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
  readonly code: 'runtime' | 'model' | 'internal'
  constructor(code: 'runtime' | 'model' | 'internal', message: string) {
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
  const t1 = Date.now()
  let text: string
  try {
    // síncrono — por isso este processo existe (o main segue livre)
    text = loaded.whisper.full(params, req.samples)
  } catch (e) {
    throw new WorkerError('internal', errText(e))
  }
  return { text: text.trim(), inferMs: Date.now() - t1, loadMs }
}

// Pedidos em série (o whisper é síncrono de qualquer forma; a fila evita reentrância na carga).
let chain: Promise<void> = Promise.resolve()

onRequest((req) => {
  if (!req || typeof req !== 'object' || typeof req.id !== 'number') return
  chain = chain.then(async () => {
    try {
      if (req.type === 'probe') send({ id: req.id, ok: true, value: await probe() })
      else if (req.type === 'transcribe')
        send({ id: req.id, ok: true, value: await transcribe(req) })
      else if (req.type === 'unload') {
        loaded = null
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
    }
  })
})

// O processo vive enquanto houver canal com o main; se o pai morrer (fork do Node), sai junto.
process.on('disconnect', () => process.exit(0))
