// Sessão de transcrição (`src/main/voice/session.ts`, sem Electron): `encodeWav` (cabeçalho
// RIFF PCM16 mono, round-trip de amostras) e a sessão — parciais melhor-esforço no intervalo
// (pedaço com sobreposição, evento `{ text, isFinal, ms }`), abort da request em voo quando a
// seguinte dispara, expiração de resultado velho, `livePartials: false`/modo 'local' nunca chamam
// a API, `stop` = transcrição final via `transcribeWithFallback` (backend/fellBack; vazio sem rede),
// `cancel` nunca transcreve, sessão única com erro legível e erros de API (parcial engole, final
// propaga). fetch mockado como em `e2e/stt.test.ts`; relógio injetado (sem esperas).
// Rodar: npm run test:unit
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  activeTranscribeSession,
  encodeWav,
  startTranscribeSession,
  VOICE_SAMPLE_RATE
} from '../src/main/voice/session.ts'
import { STT_PARTIAL_INTERVAL_MS, type SttLocalBackend } from '../src/main/voice/stt.ts'
import type { TranscribeResult } from '../src/main/voice/stt.ts'
import { DEFAULT_STT_SETTINGS, type SttSettings } from '../src/shared/voice.ts'

// ---------------- helpers ----------------

const sttSettings = (over: Partial<SttSettings> = {}): SttSettings => ({
  ...DEFAULT_STT_SETTINGS,
  ...over,
  api: { ...DEFAULT_STT_SETTINGS.api, apiKey: 'sk-test', ...(over.api ?? {}) }
})

const bytes = (n: number, fill = 1): Uint8Array => new Uint8Array(n).fill(fill)

interface FetchSpy {
  calls: { url: string; init: RequestInit }[]
  restore: () => void
}

function mockFetch(impl: (url: string, init: RequestInit) => Promise<Response>): FetchSpy {
  const calls: FetchSpy['calls'] = []
  const orig = globalThis.fetch
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const i = init ?? {}
    calls.push({ url: String(url), init: i })
    return impl(String(url), i)
  }) as typeof fetch
  return {
    calls,
    restore: () => {
      globalThis.fetch = orig
    }
  }
}

const jsonRes = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status })

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** fetch que ignora o abort e resolve depois de `ms` (simula resultado velho que chega atrasado). */
const delayedFetch = (ms: number, text: string) => async (): Promise<Response> => {
  await sleep(ms)
  return jsonRes(200, { text })
}

function fakeLocal(impl: () => Promise<TranscribeResult>): {
  calls: Uint8Array[]
  backend: SttLocalBackend
} {
  const calls: Uint8Array[] = []
  const backend: SttLocalBackend = {
    ready: true,
    async transcribe(input) {
      calls.push(input.audio)
      return impl()
    }
  }
  return { calls, backend }
}

/** PCM de 16 bits com amostras conhecidas (little-endian). */
function pcm16(...samples: number[]): Uint8Array {
  const out = new Uint8Array(samples.length * 2)
  const dv = new DataView(out.buffer)
  samples.forEach((s, i) => dv.setInt16(i * 2, s, true))
  return out
}

async function fileBytes(init: RequestInit): Promise<Uint8Array> {
  const body = init.body as FormData
  const file = body.get('file')
  assert.ok(file instanceof Blob, 'request com campo "file"')
  return new Uint8Array(await file.arrayBuffer())
}

function wavPcm(wav: Uint8Array): Uint8Array {
  const dv = new DataView(wav.buffer, wav.byteOffset, wav.byteLength)
  assert.equal(String.fromCharCode(...wav.subarray(0, 4)), 'RIFF')
  assert.equal(String.fromCharCode(...wav.subarray(8, 12)), 'WAVE')
  assert.equal(dv.getUint32(4, true), 36 + wav.length - 44)
  assert.equal(dv.getUint32(40, true), wav.length - 44)
  return wav.subarray(44)
}

interface Clock {
  now: () => number
  advance: (ms: number) => void
}
const clock = (): Clock => {
  let t = 1_000_000
  return { now: () => t, advance: (ms) => (t += ms) }
}

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i])

// ---------------- encodeWav ----------------

test('encodeWav: cabeçalho RIFF/WAVE PCM 16-bit mono correto e round-trip das amostras', () => {
  const pcm = pcm16(0, 1, -1, 12345, -32768, 32767)
  const wav = encodeWav(pcm, VOICE_SAMPLE_RATE)
  const dv = new DataView(wav.buffer)
  assert.equal(wav.length, 44 + pcm.length)
  assert.equal(String.fromCharCode(...wav.subarray(0, 4)), 'RIFF')
  assert.equal(dv.getUint32(4, true), 36 + pcm.length) // tamanho do RIFF
  assert.equal(String.fromCharCode(...wav.subarray(8, 12)), 'WAVE')
  assert.equal(String.fromCharCode(...wav.subarray(12, 16)), 'fmt ')
  assert.equal(dv.getUint32(16, true), 16) // tamanho do fmt
  assert.equal(dv.getUint16(20, true), 1) // PCM
  assert.equal(dv.getUint16(22, true), 1) // mono
  assert.equal(dv.getUint32(24, true), VOICE_SAMPLE_RATE)
  assert.equal(dv.getUint32(28, true), VOICE_SAMPLE_RATE * 2) // byteRate
  assert.equal(dv.getUint16(32, true), 2) // blockAlign
  assert.equal(dv.getUint16(34, true), 16) // bits por amostra
  assert.equal(String.fromCharCode(...wav.subarray(36, 40)), 'data')
  assert.equal(dv.getUint32(40, true), pcm.length)
  // round-trip byte a byte
  assert.ok(sameBytes(wav.subarray(44), pcm))
})

test('encodeWav: pcm vazio → wav de 44 bytes; sampleRate entra no byteRate; inválidos lançam', () => {
  const empty = encodeWav(new Uint8Array(0), 48_000)
  assert.equal(empty.length, 44)
  assert.equal(new DataView(empty.buffer).getUint32(40, true), 0)
  assert.equal(new DataView(empty.buffer).getUint32(28, true), 96_000)
  assert.throws(() => encodeWav(new Uint8Array(3), 16_000), /ímpar/)
  assert.throws(() => encodeWav(new Uint8Array(2), 0), /sampleRate inválido/)
  assert.throws(() => encodeWav(new Uint8Array(2), 1.5), /sampleRate inválido/)
})

// ---------------- parciais melhor-esforço ----------------

test('parciais: disparam no intervalo, pedaço com sobreposição e evento { text, isFinal: false, ms }', async (t) => {
  const texts = ['parcial um', 'parcial dois']
  const m = mockFetch(async () => jsonRes(200, { text: texts.shift() ?? '?' }))
  t.after(m.restore)
  const c = clock()
  const events: { sessionId: string; text: string; isFinal: boolean; ms: number }[] = []
  const A = bytes(20_000, 1)
  const B = bytes(8_000, 2)
  const C = bytes(5_000, 3)
  const D = bytes(7_000, 4)
  const s = startTranscribeSession(
    { settings: sttSettings(), language: 'pt-BR' },
    { now: c.now, onPartial: (e) => events.push(e) }
  )
  t.after(() => s.cancel())

  s.push(A, VOICE_SAMPLE_RATE)
  assert.equal(m.calls.length, 0, 'intervalo ainda não decorreu')
  c.advance(STT_PARTIAL_INTERVAL_MS)
  s.push(B, VOICE_SAMPLE_RATE)
  await sleep(0)
  assert.equal(m.calls.length, 1)
  // 1ª parcial: o acumulado inteiro (covered = 0)
  assert.ok(sameBytes(wavPcm(await fileBytes(m.calls[0].init)), new Uint8Array([...A, ...B])))
  assert.equal((m.calls[0].init.body as FormData).get('language'), 'pt')

  s.push(C, VOICE_SAMPLE_RATE)
  assert.equal(m.calls.length, 1, 'não dispara antes do intervalo')
  c.advance(STT_PARTIAL_INTERVAL_MS)
  s.push(D, VOICE_SAMPLE_RATE)
  await sleep(0)
  assert.equal(m.calls.length, 2)
  // 2ª parcial: recua STT_PARTIAL_OVERLAP_MS (300 ms = 9600 bytes) do fim da anterior
  const total = new Uint8Array([...A, ...B, ...C, ...D])
  const expected = total.subarray(A.length + B.length - 9_600)
  assert.ok(sameBytes(wavPcm(await fileBytes(m.calls[1].init)), expected))

  assert.equal(events.length, 2)
  assert.equal(events[0].text, 'parcial um')
  assert.equal(events[1].text, 'parcial um parcial dois')
  for (const e of events) {
    assert.equal(e.isFinal, false)
    assert.equal(e.sessionId, s.id)
    assert.equal(typeof e.ms, 'number')
  }
  // o wav enviado é PCM16 mono 16 kHz
  const wav = await fileBytes(m.calls[0].init)
  assert.equal(new DataView(wav.buffer, wav.byteOffset).getUint32(24, true), VOICE_SAMPLE_RATE)
})

test('parciais: a request em voo é abortada quando a seguinte dispara (nunca há fila)', async (t) => {
  const m = mockFetch(async (_url, init) => {
    if (m.calls.length === 1)
      return new Promise<Response>((_res, rej) => {
        const abort = (): void => rej(new DOMException('This operation was aborted', 'AbortError'))
        if (init.signal?.aborted) return abort()
        init.signal?.addEventListener('abort', abort, { once: true })
      })
    return jsonRes(200, { text: 'segunda' })
  })
  t.after(m.restore)
  const c = clock()
  const events: string[] = []
  const s = startTranscribeSession(
    { settings: sttSettings() },
    { now: c.now, onPartial: (e) => events.push(e.text) }
  )
  t.after(() => s.cancel())

  s.push(bytes(16_000), VOICE_SAMPLE_RATE)
  c.advance(STT_PARTIAL_INTERVAL_MS)
  s.push(bytes(16_000), VOICE_SAMPLE_RATE)
  assert.equal(m.calls.length, 1)
  assert.equal(m.calls[0].init.signal?.aborted, false)

  c.advance(STT_PARTIAL_INTERVAL_MS)
  s.push(bytes(16_000), VOICE_SAMPLE_RATE)
  assert.equal(m.calls.length, 2)
  assert.equal(m.calls[0].init.signal?.aborted, true, 'a anterior (em voo) foi abortada')
  await sleep(0)
  assert.deepEqual(events, ['segunda'])
})

test('parciais: resultado velho expira (chega depois de outro disparo e é descartado)', async (t) => {
  let n = 0
  const m = mockFetch(async () => {
    n++
    return n === 1 ? delayedFetch(30, 'VELHO')() : delayedFetch(5, 'NOVO')()
  })
  t.after(m.restore)
  const c = clock()
  const events: string[] = []
  const s = startTranscribeSession(
    { settings: sttSettings() },
    { now: c.now, onPartial: (e) => events.push(e.text) }
  )
  t.after(() => s.cancel())

  s.push(bytes(8_000), VOICE_SAMPLE_RATE)
  c.advance(STT_PARTIAL_INTERVAL_MS)
  s.push(bytes(8_000), VOICE_SAMPLE_RATE) // 1ª dispara (resolve em 30 ms)
  c.advance(STT_PARTIAL_INTERVAL_MS)
  s.push(bytes(8_000), VOICE_SAMPLE_RATE) // 2ª dispara e aborta a 1ª (que mesmo assim responde)
  await sleep(60)
  assert.deepEqual(events, ['NOVO'], 'a parcial velha expirou; nada de "VELHO" no texto')
})

test('parciais: livePartials false e modo "local" nunca chamam a API', async (t) => {
  const m = mockFetch(async () => jsonRes(200, { text: 'x' }))
  t.after(m.restore)
  for (const settings of [sttSettings({ livePartials: false }), sttSettings({ mode: 'local' })]) {
    const c = clock()
    const s = startTranscribeSession({ settings }, { now: c.now })
    s.push(bytes(8_000), VOICE_SAMPLE_RATE)
    c.advance(STT_PARTIAL_INTERVAL_MS * 3)
    s.push(bytes(8_000), VOICE_SAMPLE_RATE)
    s.push(bytes(8_000), VOICE_SAMPLE_RATE)
    await sleep(0)
    s.cancel()
    assert.equal(m.calls.length, 0, 'nenhuma chamada de parcial')
  }
})

// ---------------- stop / cancel ----------------

test('stop: transcreve o buffer inteiro como final e devolve backend/fellBack', async (t) => {
  const texts = ['parcial', 'final']
  const m = mockFetch(async () => jsonRes(200, { text: texts.shift() ?? '?' }))
  t.after(m.restore)
  const c = clock()
  const s = startTranscribeSession({ settings: sttSettings(), language: 'pt-BR' }, { now: c.now })
  const A = bytes(20_000, 7)
  const B = bytes(10_000, 8)
  s.push(A, VOICE_SAMPLE_RATE)
  c.advance(STT_PARTIAL_INTERVAL_MS)
  s.push(B, VOICE_SAMPLE_RATE)
  await sleep(0)
  assert.equal(m.calls.length, 1, 'uma parcial antes do stop')

  const r = await s.stop()
  assert.deepEqual(
    { text: r.text, backend: r.backend, fellBack: r.fellBack },
    { text: 'final', backend: 'api', fellBack: false }
  )
  assert.equal(typeof r.ms, 'number')
  assert.equal(m.calls.length, 2, 'só a final depois do stop')
  // a final vai com o buffer INTEIRO (wav PCM16 mono 16 kHz)
  assert.ok(sameBytes(wavPcm(await fileBytes(m.calls[1].init)), new Uint8Array([...A, ...B])))
  assert.equal((m.calls[1].init.body as FormData).get('model'), 'whisper-large-v3-turbo')
  assert.equal(activeTranscribeSession(), null, 'sessão encerrada libera a global')
})

test('stop: hybrid com motor local injetado cai no local em falha de disponibilidade (fellBack)', async (t) => {
  const m = mockFetch(async () => {
    throw new TypeError('fetch failed')
  })
  t.after(m.restore)
  const local = fakeLocal(() =>
    Promise.resolve({ text: 'local', model: 'whisper.cpp', baseUrl: 'local', ms: 1 })
  )
  const s = startTranscribeSession(
    { settings: sttSettings({ mode: 'hybrid' }) },
    { now: clock().now, local: local.backend }
  )
  s.push(bytes(4_000), VOICE_SAMPLE_RATE)
  const r = await s.stop()
  assert.deepEqual(
    { text: r.text, backend: r.backend, fellBack: r.fellBack },
    { text: 'local', backend: 'local', fellBack: true }
  )
  assert.ok(r.fallbackReason, 'motivo do fallback anotado')
  assert.equal(m.calls.length, 1, 'a API foi tentada primeiro')
  assert.equal(local.calls.length, 1)
  assert.ok(
    sameBytes(wavPcm(local.calls[0]), bytes(4_000)),
    'o local recebeu o buffer inteiro (wav)'
  )
})

test('stop: modo "local" com motor pronto transcreve local (a API nunca é chamada); sem motor → erro legível', async (t) => {
  const m = mockFetch(async () => jsonRes(200, { text: 'não deve chegar aqui' }))
  t.after(m.restore)
  const local = fakeLocal(() =>
    Promise.resolve({ text: 'do motor', model: 'whisper.cpp', baseUrl: 'local', ms: 1 })
  )
  const s = startTranscribeSession(
    { settings: sttSettings({ mode: 'local' }) },
    { now: clock().now, local: local.backend }
  )
  s.push(bytes(4_000), VOICE_SAMPLE_RATE)
  const r = await s.stop()
  assert.deepEqual(
    { text: r.text, backend: r.backend, fellBack: r.fellBack },
    { text: 'do motor', backend: 'local', fellBack: false }
  )
  assert.equal(m.calls.length, 0, 'modo local nunca vaza áudio para a API')

  const s2 = startTranscribeSession({ settings: sttSettings({ mode: 'local' }) })
  s2.push(bytes(4_000), VOICE_SAMPLE_RATE)
  await assert.rejects(() => s2.stop(), /motor local de transcrição não está pronto/)
})

test('stop: sem áudio → texto vazio sem rede; cancel nunca transcreve e encerra a sessão', async (t) => {
  const m = mockFetch(async () => jsonRes(200, { text: 'x' }))
  t.after(m.restore)
  const s = startTranscribeSession({ settings: sttSettings() })
  const r = await s.stop()
  assert.deepEqual(
    { text: r.text, backend: r.backend, fellBack: r.fellBack },
    { text: '', backend: 'api', fellBack: false }
  )
  assert.equal(m.calls.length, 0, 'stop vazio não vai à rede')

  const s2 = startTranscribeSession({ settings: sttSettings() }, { now: clock().now })
  s2.push(bytes(8_000), VOICE_SAMPLE_RATE)
  s2.cancel()
  s2.cancel() // idempotente
  await sleep(0)
  assert.equal(m.calls.length, 0, 'cancel nunca transcreve')
  assert.throws(() => s2.push(bytes(2), VOICE_SAMPLE_RATE), /não está mais ativa/)
  await assert.rejects(() => s2.stop(), /não está mais ativa/)
  assert.equal(activeTranscribeSession(), null)
})

test('sessão única: iniciar outra com uma ativa é erro legível; cancel/start seguem', () => {
  const s1 = startTranscribeSession({ settings: sttSettings() })
  assert.throws(() => startTranscribeSession({ settings: sttSettings() }), /Já há uma transcrição/)
  s1.cancel()
  const s2 = startTranscribeSession({ settings: sttSettings() })
  assert.notEqual(s2.id, s1.id)
  s2.cancel()
  assert.equal(activeTranscribeSession(), null)
})

test('push: sampleRate diferente de 16 kHz e tamanho ímpar são erros legíveis', () => {
  const s = startTranscribeSession({ settings: sttSettings() })
  try {
    assert.throws(() => s.push(bytes(2), 48_000), /16000 Hz/)
    assert.throws(() => s.push(new Uint8Array(3)), /ímpar/)
    assert.throws(() => s.push('x' as unknown as Uint8Array), /Uint8Array/)
  } finally {
    s.cancel()
  }
})

test('erros de API: parcial engole (melhor-esforço) e a sessão segue; o final propaga legível', async (t) => {
  const m = mockFetch(async () => jsonRes(500, { error: { message: 'quebrou' } }))
  t.after(m.restore)
  const c = clock()
  const events: string[] = []
  const s = startTranscribeSession(
    { settings: sttSettings() },
    { now: c.now, onPartial: (e) => events.push(e.text) }
  )
  s.push(bytes(8_000), VOICE_SAMPLE_RATE)
  c.advance(STT_PARTIAL_INTERVAL_MS)
  s.push(bytes(8_000), VOICE_SAMPLE_RATE) // 1ª parcial falha (500) — engolida
  await sleep(0)
  c.advance(STT_PARTIAL_INTERVAL_MS)
  s.push(bytes(8_000), VOICE_SAMPLE_RATE) // 2ª dispara mesmo assim
  await sleep(0)
  assert.equal(m.calls.length, 2, 'a falha da parcial não interrompe a sessão')
  assert.deepEqual(events, [])
  await assert.rejects(() => s.stop(), /HTTP 500/)
})
