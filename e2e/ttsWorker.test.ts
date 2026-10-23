// Processo do motor local de TTS (`src/main/voice/ttsWorkerHost.ts` + `ttsWorker.ts`) e streaming
// da fala da chamada (`ttsStreamRelay.ts` + `UtteranceQueue.pushChunk` no renderer). O host fala o
// protocolo com um worker FALSO (`e2e/fakes/ttsWorkerFake.mjs` — sem onnxruntime) para cobrir
// resposta, crash (erro legível + respawn), abort (rejeita na hora + `cancel` ao worker), erros por
// código e ociosidade; o motor Kokoro (`createKokoroEngine`) passa pelo host; o worker REAL sonda o
// onnxruntime-node num processo à parte. Síntese real com modelo (event loop livre) em
// `CLEARCHAT_TTS_REAL_BASEDIR=<userData com models/ do Kokoro>` (skip por padrão).
// Rodar: npm run test:unit
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { catalogFileName, findCatalogEntry } from '../src/main/voice/catalog.ts'
import { TtsError, type TtsPcmStream, type TtsStreamResult } from '../src/main/voice/tts.ts'
import {
  createKokoroEngine,
  probeOnnxRuntime,
  resetTtsRuntimeProbes
} from '../src/main/voice/ttsLocal.ts'
import { TtsWorkerHost, ttsForkSpawner } from '../src/main/voice/ttsWorkerHost.ts'
import { TtsStreamRelay } from '../src/main/voice/ttsStreamRelay.ts'
import {
  PcmStreamSource,
  pcmRateOf,
  UtteranceQueue,
  type UtterancePlayer
} from '../src/renderer/src/lib/voice/utteranceQueue.ts'
import type { VoiceCallUtteranceChunkEvent, VoiceCallUtteranceEvent } from '../src/shared/ipc.ts'

const root = process.cwd()
const fakeHost = (idleMs = 0): TtsWorkerHost =>
  new TtsWorkerHost({ spawn: ttsForkSpawner(join(root, 'e2e/fakes/ttsWorkerFake.mjs')), idleMs })
const text = (a: Uint8Array): string => new TextDecoder().decode(a)
const pidOf = (a: Uint8Array): string => /pid:(\d+)/.exec(text(a))?.[1] ?? '?'
const req = (
  t: string,
  modelPath = '/m/model.onnx'
): { modelPath: string; voicePath: string; text: string } => ({
  modelPath,
  voicePath: '/m/pf_dora.bin',
  text: t
})

// ---------------- host + worker falso ----------------

test('tts host: sintetiza no processo à parte (Uint8Array intacto) e reaproveita o processo', async (t) => {
  const host = fakeHost()
  t.after(() => host.terminate())
  const a = await host.synthesize(req('oi'))
  const b = await host.synthesize(req('tudo bem'))
  assert.ok(a.audio instanceof Uint8Array)
  assert.match(text(b.audio), /t:tudo bem/)
  assert.equal(pidOf(a.audio), pidOf(b.audio))
  assert.notEqual(pidOf(a.audio), String(process.pid), 'não roda no processo do chamador')
  assert.equal(host.spawnCount, 1)
  assert.equal((await host.probe()).available, true)
})

test('tts host: crash → TtsError legível nos pendentes; o próximo pedido recria o processo', async (t) => {
  const host = fakeHost()
  t.after(() => host.terminate())
  const ok = await host.synthesize(req('antes'))
  await assert.rejects(
    () => host.synthesize(req('crash')),
    (e: unknown) =>
      e instanceof TtsError &&
      e.kind === 'config' &&
      e.backend === 'local' &&
      /motor local de fala parou inesperadamente \(código 3\)/.test(e.message)
  )
  assert.equal(host.running, false)
  const again = await host.synthesize(req('depois'))
  assert.notEqual(pidOf(again.audio), pidOf(ok.audio), 'processo novo')
  assert.equal(host.spawnCount, 2)
})

test('tts host: abort rejeita na hora; pedido ainda na fila é pulado no worker (cancel)', async (t) => {
  const host = fakeHost()
  t.after(() => host.terminate())
  const ac = new AbortController()
  const slow = host.synthesize(req('slow 1')) // ocupa o worker por 150 ms (bloqueio síncrono)
  const queued = host.synthesize(req('slow 2'), ac.signal) // fica na fila do worker
  const t0 = Date.now()
  setTimeout(() => ac.abort(), 10)
  await assert.rejects(queued, (e: Error) => e.name === 'AbortError')
  assert.ok(Date.now() - t0 < 120, 'não esperou a síntese')
  await slow
  // o pedido abortado não rodou (o worker recebeu o cancel antes da vez dele): o seguinte sai rápido
  const t1 = Date.now()
  const r = await host.synthesize(req('rápido'))
  assert.match(text(r.audio), /rápido/)
  assert.ok(
    Date.now() - t1 < 140,
    `o "slow 2" cancelado não ocupou o worker (${Date.now() - t1} ms)`
  )
  assert.equal(host.spawnCount, 1)
  assert.equal(host.pendingCount, 0)
})

test('tts host: erros do worker viram TtsError por código (modelo / runtime / espeak-ng)', async (t) => {
  const host = fakeHost()
  t.after(() => host.terminate())
  await assert.rejects(
    () => host.synthesize(req('oi', '/m/bad.onnx')),
    /modelo do Kokoro inválido ou corrompido/
  )
  await assert.rejects(
    () => host.synthesize(req('oi', '/m/noruntime.onnx')),
    /runtime ONNX \(onnxruntime-node\) não pôde ser carregado nesta instalação \(sem \.node\)/
  )
  await assert.rejects(
    () => host.synthesize(req('noespeak')),
    (e: unknown) => e instanceof TtsError && /espeak-ng não encontrado/.test(e.message)
  )
})

test('tts host: spawner que falha → erro legível; probe → indisponível; ocioso desliga sozinho', async (t) => {
  const broken = new TtsWorkerHost({
    spawn: () => {
      throw new Error('sem entry')
    }
  })
  await assert.rejects(
    () => broken.synthesize(req('oi')),
    /processo do motor não pôde ser iniciado \(sem entry\)/
  )
  const p = await broken.probe()
  assert.equal(p.available, false)
  const host = fakeHost(40)
  t.after(() => host.terminate())
  await host.synthesize(req('oi'))
  assert.equal(host.running, true)
  await new Promise((r) => setTimeout(r, 120))
  assert.equal(host.running, false)
  // unload com o processo ocioso encerra o processo; o próximo pedido recria
  await host.synthesize(req('oi'))
  host.unload()
  assert.equal(host.running, false)
})

test('kokoro engine: síntese vai para o processo do motor (modelo/voz resolvidos no main) e o probe também', async (t) => {
  const base = mkdtempSync(join(tmpdir(), 'kokoro-worker-'))
  const host = fakeHost()
  t.after(() => {
    host.terminate()
    rmSync(base, { recursive: true, force: true })
  })
  const dir = join(base, 'models')
  mkdirSync(dir, { recursive: true })
  const manifest: Record<string, unknown> = {}
  for (const id of ['kokoro-onnx', 'kokoro-voice-pf-dora']) {
    const file = catalogFileName(findCatalogEntry(id)!)!
    writeFileSync(join(dir, file), new Uint8Array(2048))
    manifest[id] = { version: '1', file, sha256: null, size: 2048, installedAt: '' }
  }
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest))
  const engine = createKokoroEngine({ baseDir: base, host })
  const r = await engine.synthesize({ text: 'olá', voice: 'pf_dora', format: 'wav' })
  assert.equal(r.model, 'kokoro-onnx')
  assert.equal(r.mime, 'audio/wav')
  assert.match(text(r.audio), /t:olá/)
  assert.notEqual(pidOf(r.audio), String(process.pid))
  await assert.rejects(
    engine.synthesize({ text: 'x', voice: 'xx', format: 'wav' }),
    /voz "xx" desconhecida/
  )
  await assert.rejects(
    engine.synthesize({ text: 'x', voice: 'pm_alex', format: 'wav' }),
    /voz pm_alex não instalado/
  )
  resetTtsRuntimeProbes()
  assert.deepEqual(await probeOnnxRuntime(host), { available: true, reason: null })
  resetTtsRuntimeProbes()
  await engine.release()
  assert.equal(host.running, false, 'release solta a sessão (processo ocioso encerrado)')
})

// ---------------- worker REAL ----------------

test('worker REAL: o onnxruntime-node carrega no processo à parte (probe)', async (t) => {
  const host = new TtsWorkerHost({
    spawn: ttsForkSpawner(join(root, 'src/main/voice/ttsWorker.ts'), [
      '--import',
      join(root, 'e2e/ts-hooks.mjs')
    ])
  })
  t.after(() => host.terminate())
  assert.deepEqual(await host.probe(), { available: true, reason: null })
})

const realBase = process.env.CLEARCHAT_TTS_REAL_BASEDIR?.trim()

test(
  'worker REAL + Kokoro: síntese fora do event loop (requer CLEARCHAT_TTS_REAL_BASEDIR)',
  { skip: realBase ? false : 'sem CLEARCHAT_TTS_REAL_BASEDIR (pesos não devem baixar em CI)' },
  async (t) => {
    const host = new TtsWorkerHost({
      spawn: ttsForkSpawner(join(root, 'src/main/voice/ttsWorker.ts'), [
        '--import',
        join(root, 'e2e/ts-hooks.mjs')
      ])
    })
    t.after(() => host.terminate())
    const engine = createKokoroEngine({ baseDir: realBase!, host })
    await engine.synthesize({ text: 'Oi.', voice: 'pf_dora', format: 'wav' }) // carga da sessão
    const h = monitorEventLoopDelay({ resolution: 1 })
    h.enable()
    const r = await engine.synthesize({
      text: 'Claro! Posso te ajudar com isso agora mesmo, vamos ver juntos o que dá para fazer.',
      voice: 'pf_dora',
      format: 'wav'
    })
    await new Promise((res) => setTimeout(res, 30))
    h.disable()
    const maxLag = h.max / 1e6
    console.log(
      `      [real] síntese ${r.ms} ms (${r.model}), lag máx. do event loop ${maxLag.toFixed(1)} ms`
    )
    assert.ok(r.audio.length > 44 * 100)
    assert.ok(maxLag < 50, `event loop livre (lag máx. ${maxLag.toFixed(1)} ms)`)
  }
)

// ---------------- streaming da fala da chamada (relay no main → fila no renderer) ----------------

/** Stream PCM controlado pelo teste (pedaços entregues sob demanda). */
function controlledStream(sampleRate = 1000): {
  result: TtsPcmStream
  push(bytes: number): void
  end(): void
  fail(e: Error): void
  returned: () => boolean
} {
  const queue: (Uint8Array | null | Error)[] = []
  let wake: (() => void) | null = null
  let ret = false
  const put = (x: Uint8Array | null | Error): void => {
    queue.push(x)
    wake?.()
  }
  async function* gen(): AsyncGenerator<Uint8Array> {
    try {
      for (;;) {
        while (!queue.length) await new Promise<void>((r) => (wake = r))
        const x = queue.shift()!
        if (x === null) return
        if (x instanceof Error) throw x
        yield x
      }
    } finally {
      ret = true
    }
  }
  return {
    result: {
      streaming: true,
      sampleRate,
      model: 'm',
      backend: 'api',
      t0: Date.now(),
      chunks: gen()
    },
    push: (n) => put(new Uint8Array(n).fill(n & 0xff)),
    end: () => put(null),
    fail: (e) => put(e),
    returned: () => ret
  }
}
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5))

test('relay: resolve com ~200 ms de áudio, marca a utterance como streaming e despeja o resto em ordem', async () => {
  const utts: VoiceCallUtteranceEvent[] = []
  const chunks: VoiceCallUtteranceChunkEvent[] = []
  const relay = new TtsStreamRelay({
    emitUtterance: (u) => utts.push(u),
    emitChunk: (c) => chunks.push(c)
  })
  const s = controlledStream(1000) // 1000 Hz → 200 ms = 400 bytes
  let resolved = false
  const p = relay.synth(new AbortController().signal, async () => s.result as TtsStreamResult)
  void p.then(() => (resolved = true))
  s.push(100)
  await tick()
  assert.equal(resolved, false, 'ainda abaixo do pré-buffer')
  s.push(300)
  const head = await p
  assert.equal(head.mime, 'audio/pcm;rate=1000')
  assert.equal(head.audio.length, 400)
  s.push(50) // chega antes da emissão: fica guardado
  await tick()
  assert.equal(chunks.length, 0)
  relay.emitUtterance({ id: 'u1', audio: head.audio, mime: head.mime, kind: 'sentence' })
  assert.equal(utts[0].streaming, true)
  assert.equal(chunks.length, 1)
  s.push(60)
  s.end()
  await tick()
  assert.deepEqual(
    chunks.map((c) => [c.id, c.pcm.length, c.done]),
    [
      ['u1', 50, false],
      ['u1', 60, false],
      ['u1', 0, true]
    ]
  )
  assert.equal(relay.liveCount, 0)
  // utterance que não veio do relay (clipe/wav) passa intacta
  relay.emitUtterance({ id: 'f1', audio: new Uint8Array([1]), mime: 'audio/wav', kind: 'filler' })
  assert.equal(utts[1].streaming, undefined)
})

test('relay: sentença inteira dentro do pré-buffer → WAV completo; sem streaming → bytes completos', async () => {
  const relay = new TtsStreamRelay({ emitUtterance: () => {}, emitChunk: () => {} })
  const s = controlledStream(1000)
  const p = relay.synth(new AbortController().signal, async () => s.result)
  s.push(100)
  s.end()
  const r = await p
  assert.equal(r.mime, 'audio/wav')
  assert.equal(r.audio.length, 44 + 100)
  const full = await relay.synth(new AbortController().signal, async () => ({
    streaming: false,
    result: { audio: new Uint8Array([9]), mime: 'audio/wav', model: 'k', backend: 'local', ms: 1 }
  }))
  assert.deepEqual([...full.audio], [9])
  assert.equal(relay.liveCount, 0)
})

test('relay: abortAll (barge-in) e signal da chamada derrubam o download; erro no meio fecha com error', async () => {
  const chunks: VoiceCallUtteranceChunkEvent[] = []
  const relay = new TtsStreamRelay({ emitUtterance: () => {}, emitChunk: (c) => chunks.push(c) })
  // emitida e abortada por barge-in
  const a = controlledStream(1000)
  const pa = relay.synth(new AbortController().signal, async () => a.result)
  a.push(400)
  const ha = await pa
  relay.emitUtterance({ id: 'u1', audio: ha.audio, mime: ha.mime })
  relay.abortAll()
  assert.deepEqual(chunks.at(-1), {
    id: 'u1',
    pcm: new Uint8Array(0),
    done: true,
    error: 'cancelado'
  })
  assert.equal(relay.liveCount, 0)
  // descartada pela chamada antes de emitir (signal abortado): nada vai ao renderer
  const ac = new AbortController()
  let seenSignal: AbortSignal | null = null
  const b = controlledStream(1000)
  const pb = relay.synth(ac.signal, async (sig) => {
    seenSignal = sig
    return b.result
  })
  b.push(400)
  await pb
  const before = chunks.length
  ac.abort()
  assert.equal(seenSignal!.aborted, true, 'o download recebe o abort')
  assert.equal(relay.liveCount, 0)
  assert.equal(chunks.length, before)
  // erro de rede no meio: fecha com done + error (o que chegou toca)
  const c = controlledStream(1000)
  const pc = relay.synth(new AbortController().signal, async () => c.result)
  c.push(400)
  const hc = await pc
  relay.emitUtterance({ id: 'u3', audio: hc.audio, mime: hc.mime })
  c.fail(new Error('conexão caiu'))
  await tick()
  assert.deepEqual(chunks.at(-1), {
    id: 'u3',
    pcm: new Uint8Array(0),
    done: true,
    error: 'conexão caiu'
  })
})

class FakeStreamPlayer implements UtterancePlayer {
  onended: (() => void) | null = null
  onerror: (() => void) | null = null
  volume = 1
  got: number[] = []
  readonly source: PcmStreamSource | undefined
  readonly audio: Uint8Array
  constructor(source: PcmStreamSource | undefined, audio: Uint8Array) {
    this.source = source
    this.audio = audio
  }
  play(): void {
    if (!this.source) {
      this.got.push(this.audio.length)
      queueMicrotask(() => this.onended?.())
      return
    }
    this.source.subscribe(
      (pcm) => this.got.push(pcm.length),
      () => queueMicrotask(() => this.onended?.())
    )
  }
  pause(): void {
    this.got.push(-1)
  }
}

test('fila do renderer: utterance em streaming recebe os pedaços (na fila ou tocando) e termina no done', async () => {
  assert.equal(pcmRateOf('audio/pcm;rate=24000'), 24000)
  assert.equal(pcmRateOf('audio/wav'), null)
  const players: FakeStreamPlayer[] = []
  const states: string[] = []
  const q = new UtteranceQueue({
    playerFactory: (audio, _mime, stream) => {
      const p = new FakeStreamPlayer(stream, audio)
      players.push(p)
      return p
    },
    onState: (s) => states.push(s)
  })
  q.enqueue({ id: 'w', audio: new Uint8Array(10), mime: 'audio/wav' })
  q.enqueue({ id: 's', audio: new Uint8Array(4), mime: 'audio/pcm;rate=24000', streaming: true })
  // chega enquanto 's' ainda espera na fila
  q.pushChunk({ id: 's', pcm: new Uint8Array(6), done: false })
  await tick()
  assert.equal(players.length, 2, 'wav tocou e o stream começou')
  q.pushChunk({ id: 's', pcm: new Uint8Array(8), done: false })
  q.pushChunk({ id: 'desconhecida', pcm: new Uint8Array(2), done: true }) // ignorada
  assert.equal(q.state, 'playing')
  q.pushChunk({ id: 's', pcm: new Uint8Array(0), done: true })
  await tick()
  assert.deepEqual(players[1].got, [4, 6, 8])
  assert.equal(q.state, 'idle')
  // stream que terminou ANTES de tocar (fila ocupada) toca inteiro
  q.enqueue({ id: 'w2', audio: new Uint8Array(1), mime: 'audio/wav' })
  q.enqueue({ id: 's2', audio: new Uint8Array(2), mime: 'audio/pcm;rate=24000', streaming: true })
  q.pushChunk({ id: 's2', pcm: new Uint8Array(4), done: true })
  await tick()
  assert.deepEqual(players[3].got, [2, 4])
  // barge-in descarta os streams: pedaço atrasado é ignorado
  q.enqueue({ id: 's3', audio: new Uint8Array(2), mime: 'audio/pcm;rate=24000', streaming: true })
  q.cancel()
  q.pushChunk({ id: 's3', pcm: new Uint8Array(4), done: true })
  assert.equal(q.state, 'idle')
})
