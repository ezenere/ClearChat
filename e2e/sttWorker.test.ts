// Processo do motor local de STT (`src/main/voice/sttWorkerHost.ts` + `sttWorker.ts`): o host fala
// o protocolo com um worker FALSO (`e2e/fakes/sttWorkerFake.mjs` — sem binding nativo) para cobrir
// resposta, crash (erro legível + respawn), abort (rejeita na hora, resposta descartada), troca de
// modelo (reinicia o processo) e erros por código; e sonda o worker REAL (carrega o
// `@napi-rs/whisper` num processo à parte). Integração real com modelo (event loop livre durante a
// inferência) em `CLEARCHAT_STT_REAL_MODEL=<ggml-*.bin>` (skip por padrão).
// Rodar: npm run test:unit
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { forkSpawner, SttWorkerHost } from '../src/main/voice/sttWorkerHost.ts'
import { SttError } from '../src/main/voice/stt.ts'
import { decodeWavToMonoFloat32 } from '../src/main/voice/sttLocal.ts'
import { encodeWav } from '../src/main/voice/session.ts'

const root = process.cwd()
const fakeHost = (idleMs = 0): SttWorkerHost =>
  new SttWorkerHost({ spawn: forkSpawner(join(root, 'e2e/fakes/sttWorkerFake.mjs')), idleMs })

const samples = (n: number, first = 0): Float32Array => {
  const s = new Float32Array(n)
  s[0] = first
  return s
}
const pidOf = (text: string): string => /pid:(\d+)/.exec(text)?.[1] ?? '?'

test('host: transcreve no processo à parte (Float32Array intacto) e reaproveita o processo', async (t) => {
  const host = fakeHost()
  t.after(() => host.terminate())
  const a = await host.transcribe('/m/tiny.bin', samples(1600), { language: 'pt', nThreads: 2 })
  const b = await host.transcribe('/m/tiny.bin', samples(3200), { language: 'pt', nThreads: 2 })
  assert.match(a.text, /n:1600 m:\/m\/tiny\.bin/)
  assert.match(b.text, /n:3200/)
  assert.equal(pidOf(a.text), pidOf(b.text), 'mesmo processo (modelo em cache lá dentro)')
  assert.notEqual(pidOf(a.text), String(process.pid), 'não roda no processo do chamador')
  assert.equal(host.spawnCount, 1)
  assert.equal((await host.probe()).available, true)
})

test('host: crash do processo → SttError legível nos pendentes; o próximo pedido recria o processo', async (t) => {
  const host = fakeHost()
  t.after(() => host.terminate())
  const ok = await host.transcribe('/m/tiny.bin', samples(10), { language: null, nThreads: 1 })
  await assert.rejects(
    () => host.transcribe('/m/tiny.bin', samples(10, 9), { language: null, nThreads: 1 }),
    (e: unknown) =>
      e instanceof SttError &&
      e.kind === 'config' &&
      e.backend === 'local' &&
      /parou inesperadamente \(código 3\)/.test(e.message)
  )
  assert.equal(host.running, false)
  const again = await host.transcribe('/m/tiny.bin', samples(10), { language: null, nThreads: 1 })
  assert.notEqual(pidOf(again.text), pidOf(ok.text), 'processo novo')
  assert.equal(host.spawnCount, 2)
})

test('host: abort rejeita na hora com AbortError; a resposta atrasada é descartada', async (t) => {
  const host = fakeHost()
  t.after(() => host.terminate())
  const ac = new AbortController()
  const p = host.transcribe('/m/tiny.bin', samples(10), {
    language: 'slow',
    nThreads: 1,
    signal: ac.signal
  })
  const t0 = Date.now()
  setTimeout(() => ac.abort(), 10)
  await assert.rejects(p, (e: Error) => e.name === 'AbortError')
  assert.ok(Date.now() - t0 < 120, 'não esperou a inferência terminar')
  // o processo segue usável (a resposta velha chega e é ignorada)
  const r = await host.transcribe('/m/tiny.bin', samples(5), { language: null, nThreads: 1 })
  assert.match(r.text, /n:5/)
  assert.equal(host.spawnCount, 1)
})

test('host: trocar de modelo com o processo ocioso reinicia o processo (um modelo por vez)', async (t) => {
  const host = fakeHost()
  t.after(() => host.terminate())
  const a = await host.transcribe('/m/tiny.bin', samples(1), { language: null, nThreads: 1 })
  assert.equal(host.loadedModel, '/m/tiny.bin')
  const b = await host.transcribe('/m/base.bin', samples(1), { language: null, nThreads: 1 })
  assert.notEqual(pidOf(a.text), pidOf(b.text), 'modelo novo = processo novo (RAM devolvida)')
  host.unload('/m/outro.bin') // outro modelo: nada muda
  assert.equal(host.running, true)
  host.unload('/m/base.bin') // o carregado: processo encerrado
  assert.equal(host.running, false)
  assert.equal(host.loadedModel, null)
})

test('host: erros do worker viram SttError por código (modelo corrompido / runtime ausente)', async (t) => {
  const host = fakeHost()
  t.after(() => host.terminate())
  await assert.rejects(
    () => host.transcribe('/m/bad.bin', samples(1), { language: null, nThreads: 1 }),
    /modelo local inválido ou corrompido/
  )
  await assert.rejects(
    () => host.transcribe('/m/noruntime.bin', samples(1), { language: null, nThreads: 1 }),
    /motor whisper.cpp não pôde ser carregado nesta instalação \(sem \.node\)/
  )
})

test('host: spawner que falha → erro legível (nunca lança fora da promise); probe → indisponível', async () => {
  const host = new SttWorkerHost({
    spawn: () => {
      throw new Error('sem entry')
    }
  })
  await assert.rejects(
    () => host.transcribe('/m/tiny.bin', samples(1), { language: null, nThreads: 1 }),
    /processo do motor não pôde ser iniciado \(sem entry\)/
  )
  const p = await host.probe()
  assert.equal(p.available, false)
  assert.match(p.reason ?? '', /sem entry/)
})

test('host: processo ocioso desliga sozinho depois de idleMs', async (t) => {
  const host = fakeHost(40)
  t.after(() => host.terminate())
  await host.transcribe('/m/tiny.bin', samples(1), { language: null, nThreads: 1 })
  assert.equal(host.running, true)
  await new Promise((r) => setTimeout(r, 120))
  assert.equal(host.running, false)
})

const nativeSupported =
  (process.platform === 'linux' && process.arch === 'x64') || process.platform === 'darwin'

test(
  'worker REAL: o binding @napi-rs/whisper carrega no processo à parte (probe)',
  {
    skip: nativeSupported
      ? false
      : `sem pré-build do whisper para ${process.platform}-${process.arch}`
  },
  async (t) => {
    const host = new SttWorkerHost({
      spawn: forkSpawner(join(root, 'src/main/voice/sttWorker.ts'), [
        '--import',
        join(root, 'e2e/ts-hooks.mjs')
      ])
    })
    t.after(() => host.terminate())
    const p = await host.probe()
    assert.deepEqual(p, { available: true, reason: null })
  }
)

const realModel = process.env.CLEARCHAT_STT_REAL_MODEL?.trim()

test(
  'worker REAL + modelo: inferência fora do event loop (requer CLEARCHAT_STT_REAL_MODEL)',
  { skip: realModel ? false : 'sem CLEARCHAT_STT_REAL_MODEL (modelo não deve baixar em CI)' },
  async (t) => {
    const host = new SttWorkerHost({
      spawn: forkSpawner(join(root, 'src/main/voice/sttWorker.ts'), [
        '--import',
        join(root, 'e2e/ts-hooks.mjs')
      ])
    })
    t.after(() => host.terminate())
    // 8 s de seno modulado (o texto não importa — a medida é o event loop do chamador)
    const pcm = new Int16Array(16_000 * 8)
    for (let i = 0; i < pcm.length; i++)
      pcm[i] = Math.round(Math.sin((2 * Math.PI * 220 * i) / 16_000) * 6000)
    const { samples: f32 } = decodeWavToMonoFloat32(encodeWav(new Uint8Array(pcm.buffer), 16_000))
    const h = monitorEventLoopDelay({ resolution: 5 })
    h.enable()
    const r = await host.transcribe(realModel!, f32, { language: 'pt', nThreads: 4 })
    await new Promise((res) => setTimeout(res, 40)) // o atraso de um bloqueio aparece no tick seguinte
    h.disable()
    const maxLag = h.max / 1e6
    console.log(
      `      [real] load ${r.loadMs} ms, infer ${r.inferMs} ms, lag máx. do event loop ${maxLag.toFixed(1)} ms`
    )
    assert.ok(maxLag < 100, `event loop ficou livre (lag máx. ${maxLag.toFixed(1)} ms)`)
  }
)
