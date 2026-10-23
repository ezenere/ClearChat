// Motores LOCAIS de voz — custo e prontidão (SPEC → "Áudio → Runtime local de STT" e "Serviço de
// TTS → Processo do motor local"): threads (whisper/onnxruntime), parâmetros baratos das parciais
// (contexto do encoder, teto de tokens), limpeza do texto do whisper, silêncio pulado, cadência
// adaptativa, uma inferência por vez (`skipIfBusy` — o motor só fica livre quando o WORKER responde,
// não quando o chamador aborta), cancelamento da fila do worker REAL, Kokoro (WAV 24 kHz não
// silencioso, opções da sessão ONNX) e o catálogo de vozes (int8/Chatterbox aposentados: fora das
// listas, sem download, aviso para quem só tem o int8).
// Integração real: `CLEARCHAT_STT_REAL_MODEL=<ggml-*.bin>` (fila/cancelamento + parcial barata com
// o whisper de verdade) e `CLEARCHAT_TTS_REAL_BASEDIR=<userData com o Kokoro fp32>` — skip por
// padrão (nada baixa em CI). Rodar: npm run test:unit
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  catalogFileName,
  findCatalogEntry,
  LOCAL_MODEL_CATALOG
} from '../src/main/voice/catalog.ts'
import {
  downloadLocalModel,
  isListedLocalModel,
  listLocalModels,
  modelsDir
} from '../src/main/voice/models.ts'
import { encodeWav } from '../src/main/voice/wav.ts'
import {
  createSttLocalBackend,
  hasSpeech,
  partialAudioCtx,
  partialMaxTokens,
  STT_PARTIAL_AUDIO_CTX_MARGIN,
  sttLocalThreads,
  sttPartialThreads,
  WHISPER_FULL_AUDIO_CTX,
  type LoadedSttEngine,
  type SttEngineTranscribeOptions
} from '../src/main/voice/sttLocal.ts'
import { cleanWhisperText } from '../src/main/voice/sttText.ts'
import { forkSpawner, SttBusyError, SttWorkerHost } from '../src/main/voice/sttWorkerHost.ts'
import {
  floatToPcm16,
  kokoroSessionOptions,
  kokoroSynthesizePcm,
  kokoroThreads,
  KOKORO_SAMPLE_RATE,
  type KokoroSession
} from '../src/main/voice/kokoroCore.ts'
import {
  createKokoroEngine,
  KOKORO_MODEL_IDS,
  KOKORO_RETIRED_MODEL_NOTE
} from '../src/main/voice/ttsLocal.ts'
import { STT_LOCAL_PARTIAL_MAX_MODEL_BYTES } from '../src/shared/voice.ts'

const root = process.cwd()

// ---------------- threads ----------------

test('threads do whisper: final = metade dos núcleos (teto 8); parcial = um quarto (teto 4)', () => {
  const cases: [number, number, number][] = [
    [1, 1, 1],
    [2, 1, 1],
    [4, 2, 1],
    [8, 4, 2],
    [12, 6, 3],
    [16, 8, 4],
    [32, 8, 4],
    [64, 8, 4]
  ]
  for (const [cores, final, partial] of cases) {
    assert.equal(sttLocalThreads(cores), final, `final com ${cores} núcleos`)
    assert.equal(sttPartialThreads(cores), partial, `parcial com ${cores} núcleos`)
  }
})

test('threads do Kokoro: metade dos núcleos (teto 4), 1 inter-op, sem spin', () => {
  assert.deepEqual(
    [1, 2, 4, 8, 32].map((c) => kokoroThreads(c)),
    [1, 1, 2, 4, 4]
  )
  const o = kokoroSessionOptions(32)
  assert.equal(o.intraOpNumThreads, 4)
  assert.equal(o.interOpNumThreads, 1)
  assert.deepEqual(o.executionProviders, ['cpu'])
  assert.equal(o.extra.session['intra_op.allow_spinning'], '0')
  assert.equal(o.extra.session['inter_op.allow_spinning'], '0')
})

// ---------------- parciais baratas ----------------

test('parcial: contexto do encoder ~ duração da janela + margem (teto 30 s) e teto de tokens', () => {
  assert.equal(partialAudioCtx(16_000), 50 + STT_PARTIAL_AUDIO_CTX_MARGIN) // 1 s
  assert.equal(partialAudioCtx(16_000 * 10), 500 + STT_PARTIAL_AUDIO_CTX_MARGIN) // 10 s
  assert.equal(partialAudioCtx(16_000 * 40), WHISPER_FULL_AUDIO_CTX)
  assert.ok(partialAudioCtx(16_000 * 2) < WHISPER_FULL_AUDIO_CTX / 2, 'janela curta ≪ 30 s')
  assert.equal(partialMaxTokens(16_000), 12 + 16)
  assert.equal(partialMaxTokens(16_000 * 10), 120 + 16)
})

test('cleanWhisperText: tira anotações de não-fala e créditos de legenda; fala intacta', () => {
  assert.equal(cleanWhisperText('[MÚSICA DE FUNDO]'), '')
  assert.equal(cleanWhisperText(' [música] '), '')
  assert.equal(cleanWhisperText('[MÚSICA] Ontem eu fui no mercado.'), 'Ontem eu fui no mercado.')
  assert.equal(cleanWhisperText('Oi (risos) tudo bem?'), 'Oi tudo bem?')
  assert.equal(cleanWhisperText('(Música)'), '')
  assert.equal(cleanWhisperText('♪ ♪'), '')
  assert.equal(cleanWhisperText('Legendas pela comunidade Amara.org'), '')
  // parênteses de verdade ficam
  assert.equal(cleanWhisperText('Use a função (map) aqui.'), 'Use a função (map) aqui.')
  assert.equal(cleanWhisperText('Que horas são em Lisboa?'), 'Que horas são em Lisboa?')
  assert.equal(cleanWhisperText('Certo [aplausos], vamos lá.'), 'Certo, vamos lá.')
})

test('hasSpeech: silêncio/ruído baixo → false; um quadro de fala → true', () => {
  const n = 16_000
  assert.equal(hasSpeech(new Float32Array(n)), false)
  const hiss = new Float32Array(n).map((_, i) => (i % 2 ? 0.004 : -0.004)) // ≈ −48 dBFS
  assert.equal(hasSpeech(hiss), false)
  const voiced = new Float32Array(n)
  for (let i = 8000; i < 8320; i++) voiced[i] = Math.sin(i / 5) * 0.2
  assert.equal(hasSpeech(voiced), true)
})

// ---------------- backend local: cadência adaptativa + silêncio ----------------

async function baseWithTiny(): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), 'lve-stt-'))
  await mkdir(modelsDir(base), { recursive: true })
  const file = catalogFileName(findCatalogEntry('ggml-tiny')!)!
  await writeFile(join(modelsDir(base), file), new Uint8Array([0x6c, 0x6d, 0x67, 0x67, 0, 0]))
  return base
}

const speechWav = (seconds: number): Uint8Array => {
  const n = Math.round(seconds * 16_000)
  const f = new Float32Array(n)
  for (let i = 0; i < n; i++) f[i] = Math.sin(i / 7) * 0.3
  return encodeWav(floatToPcm16(f), 16_000)
}

test('backend local: parcial com cadência adaptativa (motor lento pula), silêncio pulado, final nunca pulada', async (t) => {
  const base = await baseWithTiny()
  t.after(() => rm(base, { recursive: true, force: true }))
  let clock = 1_000
  const calls: SttEngineTranscribeOptions[] = []
  const loader = async (): Promise<LoadedSttEngine> => ({
    async transcribe(_samples, opts) {
      calls.push(opts)
      return { text: 'ok', inferMs: 500 }
    }
  })
  const backend = createSttLocalBackend({
    baseDir: base,
    selection: { engine: 'whisper.cpp', model: 'ggml-tiny' },
    loadEngine: loader,
    engineCache: new Map(),
    now: () => clock
  })
  const partial = { audio: speechWav(1), mimeType: 'audio/wav', fileName: 'partial' }
  const final = { audio: speechWav(1), mimeType: 'audio/wav', fileName: 'audio' }
  await backend.transcribe(partial, {})
  assert.equal(
    calls.at(-1)?.partial,
    true,
    'parcial marcada para o motor (contexto/threads baratos)'
  )
  clock += 200 // ocioso 200 ms < custo 500 ms → pula
  await assert.rejects(backend.transcribe(partial, {}), (e: unknown) => e instanceof SttBusyError)
  // a final nunca é pulada pela cadência e não vai como parcial
  await backend.transcribe(final, {})
  assert.equal(calls.at(-1)?.partial, undefined)
  clock += 400 // agora 600 ms ociosa ≥ 500 → sai
  await backend.transcribe(partial, {})
  assert.equal(calls.length, 3)
  // purpose explícito também vale
  clock += 10_000
  await backend.transcribe({ ...final }, { purpose: 'partial' })
  assert.equal(calls.at(-1)?.partial, true)
  // janela só de silêncio: pulada sem chamar o motor
  clock += 10_000
  const silent = {
    audio: encodeWav(new Uint8Array(32_000), 16_000),
    mimeType: 'audio/wav',
    fileName: 'partial'
  }
  await assert.rejects(backend.transcribe(silent, {}), (e: unknown) => e instanceof SttBusyError)
  assert.equal(calls.length, 4)
  // a final com silêncio vai (a final decide; nada é pulado)
  await backend.transcribe({ ...silent, fileName: 'audio' }, {})
  assert.equal(calls.length, 5)
})

// ---------------- host: uma inferência por vez ----------------

const fakeHost = (): SttWorkerHost =>
  new SttWorkerHost({ spawn: forkSpawner(join(root, 'e2e/fakes/sttWorkerFake.mjs')), idleMs: 0 })

test('host: parcial com skipIfBusy não entra na fila; o motor só fica livre quando o worker responde (abort não libera)', async (t) => {
  const host = fakeHost()
  t.after(() => host.terminate())
  const s = new Float32Array(1600)
  const ac = new AbortController()
  const slow = host.transcribe('/m/tiny.bin', s, {
    language: 'slow',
    nThreads: 1,
    signal: ac.signal
  })
  assert.equal(host.busy, 1)
  await assert.rejects(
    host.transcribe('/m/tiny.bin', s, { language: 'pt', nThreads: 1, skipIfBusy: true }),
    (e: unknown) => e instanceof SttBusyError
  )
  // o chamador desiste: rejeita na hora, mas o worker ainda está calculando → segue ocupado
  ac.abort()
  await assert.rejects(slow, { name: 'AbortError' })
  assert.equal(host.busy, 1)
  await assert.rejects(
    host.transcribe('/m/tiny.bin', s, { language: 'pt', nThreads: 1, skipIfBusy: true }),
    (e: unknown) => e instanceof SttBusyError
  )
  // a final (sem skipIfBusy) entra na fila normalmente
  const fin = await host.transcribe('/m/tiny.bin', s, { language: 'pt', nThreads: 1 })
  assert.match(fin.text, /n:1600/)
  for (let i = 0; i < 50 && host.busy; i++) await new Promise((r) => setTimeout(r, 20))
  assert.equal(host.busy, 0, 'livre depois da resposta do worker')
  const ok = await host.transcribe('/m/tiny.bin', s, {
    language: 'pt',
    nThreads: 1,
    skipIfBusy: true,
    audioCtx: 400,
    maxTokens: 30
  })
  assert.match(ok.text, /n:1600/)
})

const realModel = process.env.CLEARCHAT_STT_REAL_MODEL?.trim()

test(
  'worker REAL: pedido abortado na fila sai sem rodar; parcial barata (contexto reduzido) transcreve (requer CLEARCHAT_STT_REAL_MODEL)',
  { skip: realModel ? false : 'sem CLEARCHAT_STT_REAL_MODEL (modelo não deve baixar em CI)' },
  async (t) => {
    const host = new SttWorkerHost({
      spawn: forkSpawner(join(root, 'src/main/voice/sttWorker.ts'), [
        '--import',
        join(root, 'e2e/ts-hooks.mjs')
      ]),
      idleMs: 0
    })
    t.after(() => host.terminate())
    const speech = new Float32Array(16_000 * 8)
    for (let i = 0; i < speech.length; i++) speech[i] = Math.sin(i / 9) * 0.2 * Math.sin(i / 4000)
    // aquece (carga do modelo)
    await host.transcribe(realModel!, speech.subarray(0, 16_000), { language: 'pt', nThreads: 2 })
    // 1º roda; 2º..5º ficam na fila e são abortados — não podem custar inferência
    const first = host.transcribe(realModel!, speech, { language: 'pt', nThreads: 2 })
    const queued = Array.from({ length: 4 }, () => {
      const ac = new AbortController()
      const p = host
        .transcribe(realModel!, speech, { language: 'pt', nThreads: 2, signal: ac.signal })
        .then(
          () => null,
          (e: unknown) => e
        )
      return { ac, p }
    })
    for (const q of queued) q.ac.abort()
    const t0 = Date.now()
    const r1 = await first
    for (const q of queued) assert.equal(((await q.p) as Error | null)?.name, 'AbortError')
    // a fila esvazia logo depois do 1º (os cancelados nunca rodam)
    for (let i = 0; i < 100 && host.busy; i++) await new Promise((r) => setTimeout(r, 10))
    assert.equal(host.busy, 0, 'cancelados saíram da fila sem inferência')
    assert.ok(Date.now() - t0 < r1.inferMs * 2 + 500, 'nenhuma inferência extra depois do 1º')
    // parcial barata: contexto reduzido + teto de tokens (só não pode falhar)
    const p = await host.transcribe(realModel!, speech.subarray(0, 32_000), {
      language: 'pt',
      nThreads: 2,
      audioCtx: partialAudioCtx(32_000),
      maxTokens: partialMaxTokens(32_000)
    })
    assert.equal(typeof p.text, 'string')
    assert.ok(!/\[/.test(p.text), 'anotações de não-fala limpas')
  }
)

// ---------------- Kokoro ----------------

test('Kokoro: núcleo devolve PCM16 não silencioso a 24 kHz e o WAV tem o cabeçalho certo', async () => {
  // sessão falsa: 0,5 s de seno a 220 Hz (o decoder real devolve float a 24 kHz)
  const session: KokoroSession = {
    async run(feeds) {
      assert.equal(feeds.input_ids.type, 'int64')
      assert.deepEqual(feeds.style.dims, [1, 256])
      const n = KOKORO_SAMPLE_RATE / 2
      const data = new Float32Array(n)
      for (let i = 0; i < n; i++)
        data[i] = Math.sin((2 * Math.PI * 220 * i) / KOKORO_SAMPLE_RATE) * 0.5
      return { waveform: { data } }
    }
  }
  const out = await kokoroSynthesizePcm({
    text: 'Olá, tudo bem?',
    styles: new Float32Array(510 * 256).fill(0.01),
    session,
    run: async () => 'oˈla'
  })
  assert.equal(out.pcm.length, KOKORO_SAMPLE_RATE) // 0,5 s × 2 bytes
  const dv = new DataView(out.pcm.buffer)
  let acc = 0
  for (let i = 0; i < out.pcm.length / 2; i++) acc += dv.getInt16(i * 2, true) ** 2
  const rms = Math.sqrt(acc / (out.pcm.length / 2))
  assert.ok(rms > 10_000, `PCM não silencioso (rms ${rms.toFixed(0)})`)
  const wav = encodeWav(out.pcm, KOKORO_SAMPLE_RATE)
  const h = new DataView(wav.buffer)
  const tag = (o: number): string => String.fromCharCode(...wav.subarray(o, o + 4))
  assert.equal(tag(0), 'RIFF')
  assert.equal(h.getUint32(4, true), 36 + out.pcm.length)
  assert.equal(tag(8), 'WAVE')
  assert.equal(tag(12), 'fmt ')
  assert.equal(h.getUint16(20, true), 1, 'PCM')
  assert.equal(h.getUint16(22, true), 1, 'mono')
  assert.equal(h.getUint32(24, true), 24_000)
  assert.equal(h.getUint32(28, true), 48_000, 'byteRate')
  assert.equal(h.getUint16(32, true), 2, 'blockAlign')
  assert.equal(h.getUint16(34, true), 16)
  assert.equal(tag(36), 'data')
  assert.equal(h.getUint32(40, true), out.pcm.length)
})

const realTtsBase = process.env.CLEARCHAT_TTS_REAL_BASEDIR?.trim()

test(
  'Kokoro REAL (fp32, processo do motor): WAV 24 kHz não silencioso e mais rápido que tempo real (requer CLEARCHAT_TTS_REAL_BASEDIR)',
  { skip: realTtsBase ? false : 'sem CLEARCHAT_TTS_REAL_BASEDIR (pesos não devem baixar em CI)' },
  async () => {
    const engine = createKokoroEngine({ baseDir: realTtsBase! })
    try {
      await engine.synthesize({ text: 'Olá.', voice: 'pf_dora', format: 'wav' }) // aquece
      const t0 = Date.now()
      const r = await engine.synthesize({
        text: 'Claro, posso ajudar com isso agora mesmo, é bem simples.',
        voice: 'pf_dora',
        format: 'wav'
      })
      const ms = Date.now() - t0
      assert.equal(r.model, 'kokoro-onnx')
      const h = new DataView(r.audio.buffer, r.audio.byteOffset)
      assert.equal(h.getUint32(24, true), 24_000)
      const n = (r.audio.length - 44) / 2
      let acc = 0
      for (let i = 0; i < n; i++) acc += h.getInt16(44 + i * 2, true) ** 2
      assert.ok(Math.sqrt(acc / n) > 300, 'não silencioso')
      const dur = n / 24_000
      assert.ok(ms / 1000 / dur < 0.5, `RTF ${(ms / 1000 / dur).toFixed(2)} ≥ 0,5`)
    } finally {
      await engine.release()
    }
  }
)

// ---------------- catálogo: vozes lentas demais para chamada saem ----------------

test('catálogo: Kokoro int8 e Chatterbox aposentados; o motor só usa a fp32', () => {
  for (const id of ['kokoro-onnx-q8', 'chatterbox-pt-br-t3', 'chatterbox-pt-br-s3gen'])
    assert.ok(findCatalogEntry(id)?.retired, `${id} aposentado`)
  for (const e of LOCAL_MODEL_CATALOG.filter((x) => x.kind === 'tts' && x.engine === 'kokoro'))
    if (e.id !== 'kokoro-onnx-q8') assert.equal(e.retired, undefined, `${e.id} segue no catálogo`)
  assert.deepEqual(KOKORO_MODEL_IDS, ['kokoro-onnx'])
  // parciais: o teto de tamanho está entre o base e o small
  assert.ok(findCatalogEntry('ggml-base')!.sizeBytes <= STT_LOCAL_PARTIAL_MAX_MODEL_BYTES)
  assert.ok(findCatalogEntry('ggml-small')!.sizeBytes > STT_LOCAL_PARTIAL_MAX_MODEL_BYTES)
})

test('aposentados: fora da lista sem arquivo, listados com arquivo (para remover), sem download; só o int8 instalado → aviso para baixar a fp32', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'lve-tts-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  const dir = modelsDir(base)
  await mkdir(dir, { recursive: true })
  const before = await listLocalModels(base)
  assert.ok(
    !before.filter(isListedLocalModel).some((m) => m.entry.retired),
    'nada aposentado listado'
  )
  await assert.rejects(downloadLocalModel(base, 'kokoro-onnx-q8'), /não está mais disponível/)
  // usuário antigo: int8 + voz instalados
  const manifest: Record<string, unknown> = {}
  for (const id of ['kokoro-onnx-q8', 'kokoro-voice-pf-dora']) {
    const e = findCatalogEntry(id)!
    const file = catalogFileName(e)!
    await writeFile(join(dir, file), new Uint8Array(16))
    manifest[id] = { version: e.version, file, sha256: null, size: 16, installedAt: '' }
  }
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest))
  const after = (await listLocalModels(base)).filter(isListedLocalModel)
  const q8 = after.find((m) => m.entry.id === 'kokoro-onnx-q8')
  assert.equal(q8?.state, 'installed', 'int8 ainda listado (para o usuário remover)')
  const engine = createKokoroEngine({
    baseDir: base,
    run: async () => 'oˈla',
    createSession: async () => {
      throw new Error('não deveria carregar o int8')
    }
  })
  await assert.rejects(
    engine.synthesize({ text: 'oi', voice: 'pf_dora', format: 'wav' }),
    (e: unknown) => e instanceof Error && e.message.includes(KOKORO_RETIRED_MODEL_NOTE)
  )
})
