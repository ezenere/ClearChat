// Runtime local de STT (`src/main/voice/sttLocal.ts`, `src/main/voice/zip.ts`): extração de zip
// (fixture gerada aqui mesmo — store+deflate, CRC, caminhos seguros), decodificação de wav,
// backend local com engine MOCKADO (ready, lazy/cache de modelo, idioma, onPartial, erros
// legíveis) e a extração/erro honesto do Vosk. Integração real com modelo grande fica em
// `CLEARCHAT_STT_REAL_MODEL=<caminho do ggml-*.bin>` (skip por padrão — nada baixa em CI).
// Rodar: npm run test:unit  ·  real: CLEARCHAT_STT_REAL_MODEL=… npm run test:unit
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { findCatalogEntry, LOCAL_MODEL_CATALOG } from '../src/main/voice/catalog.ts'
import { modelsDir } from '../src/main/voice/models.ts'
import { encodeWav } from '../src/main/voice/session.ts'
import type { SttLocalBackend, TranscribeAudioInput } from '../src/main/voice/stt.ts'
import {
  createSttLocalBackend,
  decodeWavToMonoFloat32,
  ensureVoskModelExtracted,
  isSttEngineRuntimeAvailable,
  verifyVoskModelDir,
  type LoadedSttEngine
} from '../src/main/voice/sttLocal.ts'
import { shutdownSttWorker } from '../src/main/voice/sttWorkerHost.ts'
import { crc32, extractZipToDir, readZipEntries, safeEntrySegments } from '../src/main/voice/zip.ts'

// ---------------- fixture zip (writer mínimo para o teste) ----------------

interface ZipFixEntry {
  name: string
  data?: Uint8Array
  method?: 0 | 8 | 12
  corruptCrc?: boolean
  /** Tamanho descomprimido DECLARADO (padrão: o real) — para o teste de zip-bomb. */
  declaredSize?: number
}

function makeZip(entries: ZipFixEntry[]): Uint8Array {
  const chunks: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const e of entries) {
    const data = e.data ?? new Uint8Array(0)
    const method = e.method ?? 8
    const comp = method === 8 ? new Uint8Array(deflateRawSync(data)) : data
    const name = Buffer.from(e.name, 'utf8')
    const crc = crc32(data) ^ (e.corruptCrc ? 1 : 0)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(crc >>> 0, 14)
    local.writeUInt32LE(comp.length, 18)
    local.writeUInt32LE(e.declaredSize ?? data.length, 22)
    local.writeUInt16LE(name.length, 26)
    chunks.push(local, name, Buffer.from(comp))
    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0)
    cd.writeUInt16LE(20, 4)
    cd.writeUInt16LE(20, 6)
    cd.writeUInt16LE(method, 10)
    cd.writeUInt32LE(crc >>> 0, 16)
    cd.writeUInt32LE(comp.length, 20)
    cd.writeUInt32LE(e.declaredSize ?? data.length, 24)
    cd.writeUInt16LE(name.length, 28)
    cd.writeUInt32LE(offset, 42)
    central.push(cd, name)
    offset += 30 + name.length + comp.length
  }
  const cdBuf = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cdBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return new Uint8Array(Buffer.concat([...chunks, cdBuf, eocd]))
}

const te = new TextEncoder()
const td = new TextDecoder()

async function tmpDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix))
}

// ---------------- zip.ts ----------------

test('crc32: vetor conhecido ("123456789" → 0xCBF43926) e encadeamento com seed', () => {
  assert.equal(crc32(te.encode('123456789')) >>> 0, 0xcbf43926)
  const parts = [te.encode('1234'), te.encode('56789')]
  let seed = 0
  for (const p of parts) seed = crc32(p, seed)
  assert.equal(seed >>> 0, 0xcbf43926)
})

test('extractZipToDir: store + deflate, bytes idênticos, contagem e raiz comum', async (t) => {
  const dir = await tmpDir('stt-zip-')
  t.after(() => rm(dir, { recursive: true, force: true }))
  const zip = makeZip([
    { name: 'modelo/README', data: te.encode('ola'), method: 0 },
    { name: 'modelo/final.mdl', data: new Uint8Array(5000).fill(7), method: 8 },
    { name: 'modelo/ivector/final.ie', data: new Uint8Array(2048).fill(9), method: 8 }
  ])
  const r = await extractZipToDir(zip, dir)
  assert.deepEqual(
    { files: r.files, bytes: r.bytes, rootDir: r.rootDir },
    { files: 3, bytes: 3 + 5000 + 2048, rootDir: 'modelo' }
  )
  assert.equal(td.decode(await readFile(join(dir, 'modelo/README'))), 'ola')
  assert.deepEqual(
    new Uint8Array(await readFile(join(dir, 'modelo/final.mdl'))),
    new Uint8Array(5000).fill(7)
  )
  assert.ok((await readFile(join(dir, 'modelo/ivector/final.ie'))).length === 2048)
})

test('extractZipToDir: expectedRoot, zip-slip, método desconhecido, CRC, vazio e truncado', async (t) => {
  const dir = await tmpDir('stt-zip-')
  t.after(() => rm(dir, { recursive: true, force: true }))

  await assert.rejects(
    () =>
      extractZipToDir(makeZip([{ name: 'outro/a.txt', data: te.encode('x') }]), dir, {
        expectedRoot: 'modelo'
      }),
    /fora da pasta esperada/
  )
  await assert.rejects(
    () => extractZipToDir(makeZip([{ name: '../evil.txt', data: te.encode('x') }]), dir),
    /caminho inseguro/
  )
  await assert.rejects(
    () => extractZipToDir(makeZip([{ name: '/abs.txt', data: te.encode('x') }]), dir),
    /caminho inseguro/
  )
  await assert.rejects(
    () => extractZipToDir(makeZip([{ name: 'modelo/a', data: te.encode('x'), method: 12 }]), dir),
    /método de compressão 12/
  )
  await assert.rejects(
    () =>
      extractZipToDir(makeZip([{ name: 'modelo/a', data: te.encode('x'), corruptCrc: true }]), dir),
    /CRC-32 divergente/
  )
  await assert.rejects(() => extractZipToDir(makeZip([]), dir), /zip vazio/)
  await assert.rejects(
    () => extractZipToDir(new Uint8Array([80, 75, 5, 6].concat(new Array(30).fill(0))), dir),
    /EOCD|vazio/
  )
  // nada escapou do destino
  await assert.rejects(readFile(join(dir, '..', 'evil.txt')))
})

test('extractZipToDir: entry que infla além do tamanho declarado (zip-bomb) para no teto', async (t) => {
  const dir = await tmpDir('zip-bomb-')
  t.after(() => rm(dir, { recursive: true, force: true }))
  const zipPath = join(dir, 'bomb.zip')
  // 8 MB de zeros declarados como 1 KB: o inflate para em 1 KB + 1 em vez de alocar tudo
  await writeFile(
    zipPath,
    makeZip([{ name: 'm/big.bin', data: new Uint8Array(8 * 1024 * 1024), declaredSize: 1024 }])
  )
  await assert.rejects(
    () => extractZipToDir(zipPath, join(dir, 'out')),
    /descomprime além do tamanho declarado \(1024 bytes\)/
  )
})

test('readZipEntries/safeEntrySegments: campos parseados e nomes perigosos rejeitados', () => {
  const zip = makeZip([
    { name: 'a/b.txt', data: te.encode('abc'), method: 8 },
    { name: 'a/dir/', data: new Uint8Array(0), method: 0 }
  ])
  const entries = readZipEntries(zip)
  assert.equal(entries.length, 2)
  assert.deepEqual(
    { name: entries[0].name, method: entries[0].method, uncomp: entries[0].uncompressedSize },
    { name: 'a/b.txt', method: 8, uncomp: 3 }
  )
  assert.equal(entries[1].isDirectory, true)
  assert.deepEqual(safeEntrySegments('a\\b.txt'), ['a', 'b.txt'])
  for (const bad of ['../x', 'a/../../x', '/x', 'C:/x', '']) {
    assert.throws(() => safeEntrySegments(bad), /caminho inseguro|vazio/, bad)
  }
})

// ---------------- wav → Float32 ----------------

test('decodeWavToMonoFloat32: round-trip com encodeWav, mixdown de canais e erros legíveis', () => {
  const pcm = new Int16Array([0, 16384, -16384, 32767, -32768, 1])
  const wav = encodeWav(new Uint8Array(pcm.buffer.slice(0)), 16_000)
  const { samples, sampleRate } = decodeWavToMonoFloat32(wav)
  assert.equal(sampleRate, 16_000)
  assert.equal(samples.length, 6)
  for (let i = 0; i < 6; i++) assert.ok(Math.abs(samples[i] - pcm[i] / 32768) < 1e-6)

  // estéreo: média dos canais
  const stereoPcm = new Int16Array([1000, -1000, 3000, 1000])
  const stereo = new Uint8Array(44 + stereoPcm.byteLength)
  const dv = new DataView(stereo.buffer)
  const ascii = (o: number, s: string): void => {
    for (let i = 0; i < s.length; i++) stereo[o + i] = s.charCodeAt(i)
  }
  ascii(0, 'RIFF')
  dv.setUint32(4, 36 + stereoPcm.byteLength, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  dv.setUint32(16, 16, true)
  dv.setUint16(20, 1, true)
  dv.setUint16(22, 2, true)
  dv.setUint32(24, 16_000, true)
  dv.setUint32(28, 16_000 * 4, true)
  dv.setUint16(32, 4, true)
  dv.setUint16(34, 16, true)
  ascii(36, 'data')
  dv.setUint32(40, stereoPcm.byteLength, true)
  stereo.set(new Uint8Array(stereoPcm.buffer), 44)
  const st = decodeWavToMonoFloat32(stereo)
  assert.equal(st.samples.length, 2)
  assert.ok(Math.abs(st.samples[0]) < 1e-6) // (1000 + -1000) / 2
  assert.ok(Math.abs(st.samples[1] - 2000 / 32768) < 1e-6) // (3000 + 1000) / 2

  assert.throws(() => decodeWavToMonoFloat32(new Uint8Array(80)), /RIFF/)
  const bits8 = new Uint8Array(wav)
  new DataView(bits8.buffer).setUint16(34, 8, true)
  assert.throws(() => decodeWavToMonoFloat32(bits8), /PCM16/)
})

// ---------------- engine + backend (mockado) ----------------

const wavInput = (pcm: Int16Array): TranscribeAudioInput => ({
  audio: encodeWav(new Uint8Array(pcm.buffer.slice(0)), 16_000),
  mimeType: 'audio/wav',
  fileName: 'audio'
})
const tinyPcm = (): Int16Array => new Int16Array(3200).fill(100)

async function tmpBaseDirWith(name: string, content: Uint8Array): Promise<string> {
  const dir = await tmpDir('stt-rt-')
  await mkdir(modelsDir(dir), { recursive: true })
  await writeFile(join(modelsDir(dir), name), content)
  return dir
}

interface FakeEngineCalls {
  loads: string[]
  samples: Float32Array[]
  languages: (string | undefined)[]
  texts: string[]
}

function fakeLoader(
  calls: FakeEngineCalls,
  text = 'texto do motor'
): (modelPath: string) => Promise<LoadedSttEngine> {
  return async (modelPath) => {
    calls.loads.push(modelPath)
    return {
      async transcribe(samples, opts) {
        calls.samples.push(samples)
        calls.languages.push(opts.language)
        opts.onPartial?.('parcial')
        return { text }
      }
    }
  }
}

test('isSttEngineRuntimeAvailable: só whisper.cpp tem runtime nesta versão', () => {
  assert.equal(isSttEngineRuntimeAvailable('whisper.cpp'), true)
  assert.equal(isSttEngineRuntimeAvailable('vosk'), false)
  assert.equal(isSttEngineRuntimeAvailable('nemotron'), false)
})

test('backend.ready: baseDir/selection/arquivo/engine — modelo de TTS nunca vale', async (t) => {
  const dir = await tmpBaseDirWith('ggml-tiny.bin', new Uint8Array([0x6c, 0x6d, 0x67, 0x67]))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const mk = (over: Partial<Parameters<typeof createSttLocalBackend>[0]> = {}): SttLocalBackend =>
    createSttLocalBackend({
      baseDir: dir,
      selection: { engine: 'whisper.cpp', model: 'ggml-tiny' },
      loadEngine: async () => ({ transcribe: async () => ({ text: '' }) }),
      engineCache: new Map(),
      ...over
    })
  assert.equal(mk().ready, true)
  assert.equal(mk({ selection: null }).ready, false)
  assert.equal(mk({ baseDir: null }).ready, false)
  assert.equal(mk({ selection: { engine: 'whisper.cpp', model: 'ggml-base' } }).ready, false)
  assert.equal(mk({ selection: { engine: 'vosk', model: 'vosk-model-small-pt-0.3' } }).ready, false)
  const ttsId = LOCAL_MODEL_CATALOG.find((e) => e.kind === 'tts')!.id
  assert.equal(mk({ selection: { engine: 'whisper.cpp', model: ttsId } }).ready, false)
  // sem modelo escolhido: resolve pelo instalado em disco
  assert.equal(mk({ selection: { engine: 'whisper.cpp', model: '' } }).ready, true)
})

test('backend.transcribe: lazy/uma vez, resultado, idioma pt-BR→pt e onPartial repassado', async (t) => {
  const dir = await tmpBaseDirWith('ggml-tiny.bin', new Uint8Array([1, 2, 3, 4]))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const calls: FakeEngineCalls = { loads: [], samples: [], languages: [], texts: [] }
  const backend = createSttLocalBackend({
    baseDir: dir,
    selection: { engine: 'whisper.cpp', model: 'ggml-tiny' },
    loadEngine: fakeLoader(calls, 'olá mundo'),
    engineCache: new Map()
  })
  const partials: string[] = []
  for (let i = 0; i < 2; i++) {
    const r = await backend.transcribe(wavInput(tinyPcm()), {
      language: 'pt-BR',
      onPartial: (t2) => partials.push(t2)
    })
    assert.deepEqual(
      { text: r.text, model: r.model, baseUrl: r.baseUrl },
      { text: 'olá mundo', model: 'ggml-tiny', baseUrl: 'local' }
    )
    assert.equal(typeof r.ms, 'number')
  }
  assert.equal(calls.loads.length, 1, 'modelo carregado uma vez (cache)')
  assert.equal(calls.samples.length, 2)
  assert.equal(calls.samples[0].length, 3200)
  assert.deepEqual(calls.languages, ['pt', 'pt'])
  assert.deepEqual(partials, ['parcial', 'parcial'])
})

test('backend.transcribe: erros legíveis — sem modelo, modelo desconhecido, engine divergente, arquivo ausente, wav ruim', async (t) => {
  const dir = await tmpBaseDirWith('ggml-tiny.bin', new Uint8Array([1, 2, 3, 4]))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const loader = fakeLoader({ loads: [], samples: [], languages: [], texts: [] })
  const input = wavInput(tinyPcm())

  await assert.rejects(
    () =>
      createSttLocalBackend({ baseDir: dir, selection: null, loadEngine: loader }).transcribe(
        input,
        {}
      ),
    /nenhum modelo local configurado/
  )
  await assert.rejects(
    () =>
      createSttLocalBackend({
        baseDir: dir,
        selection: { engine: 'whisper.cpp', model: 'nao-existe' },
        loadEngine: loader
      }).transcribe(input, {}),
    /modelo local desconhecido/
  )
  await assert.rejects(
    () =>
      createSttLocalBackend({
        baseDir: dir,
        selection: { engine: 'whisper.cpp', model: 'vosk-model-small-pt-0.3' },
        loadEngine: loader
      }).transcribe(input, {}),
    /é do engine 'vosk'/
  )
  await assert.rejects(
    () =>
      createSttLocalBackend({
        baseDir: dir,
        selection: { engine: 'whisper.cpp', model: 'ggml-base' },
        loadEngine: loader
      }).transcribe(input, {}),
    /não instalado/
  )
  const ok = createSttLocalBackend({
    baseDir: dir,
    selection: { engine: 'whisper.cpp', model: 'ggml-tiny' },
    loadEngine: loader
  })
  await assert.rejects(
    () => ok.transcribe({ audio: new Uint8Array(10), mimeType: 'audio/wav' }, {}),
    /wav RIFF/
  )
})

test('backend.transcribe: abort prévio vira AbortError; falha do loader não fica em cache', async (t) => {
  const dir = await tmpBaseDirWith('ggml-tiny.bin', new Uint8Array([1, 2, 3, 4]))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const ac = new AbortController()
  ac.abort()
  const cache = new Map<string, Promise<LoadedSttEngine>>()
  let loads = 0
  const backend = createSttLocalBackend({
    baseDir: dir,
    selection: { engine: 'whisper.cpp', model: 'ggml-tiny' },
    loadEngine: async () => {
      loads++
      if (loads === 1) throw new Error('quebrou o carregamento')
      return { transcribe: async () => ({ text: 'ok' }) }
    },
    engineCache: cache
  })
  await assert.rejects(
    () => backend.transcribe(wavInput(tinyPcm()), { signal: ac.signal }),
    (e: Error) => e.name === 'AbortError'
  )
  await assert.rejects(() => backend.transcribe(wavInput(tinyPcm()), {}), /quebrou o carregamento/)
  assert.equal(cache.size, 0, 'falha de load não fica cacheada')
  const r = await backend.transcribe(wavInput(tinyPcm()), {})
  assert.equal(r.text, 'ok')
  assert.equal(loads, 2)
})

// ---------------- Vosk: extração + erro honesto ----------------

/** Zip de modelo Vosk com os arquivos Kaldi mínimos que `verifyVoskModelDir` confere. */
function voskFixtureZip(id: string): Uint8Array {
  return makeZip([
    { name: `${id}/README`, data: te.encode('fixture'), method: 0 },
    { name: `${id}/final.mdl`, data: new Uint8Array(64).fill(1), method: 8 },
    { name: `${id}/Gr.fst`, data: new Uint8Array(32).fill(2), method: 8 },
    { name: `${id}/HCLr.fst`, data: new Uint8Array(32).fill(3), method: 8 },
    { name: `${id}/mfcc.conf`, data: te.encode('--sample-frequency=16000'), method: 0 },
    { name: `${id}/ivector/`, method: 0 },
    { name: `${id}/ivector/final.ie`, data: new Uint8Array(48).fill(4), method: 8 }
  ])
}

test('ensureVoskModelExtracted: extrai/verifica em models/<id>/, é idempotente e exige o zip', async (t) => {
  const dir = await tmpDir('stt-vosk-')
  t.after(() => rm(dir, { recursive: true, force: true }))
  const id = 'vosk-model-small-pt-0.3'
  await mkdir(modelsDir(dir), { recursive: true })

  await assert.rejects(() => ensureVoskModelExtracted(dir, id), /não instalado/)

  await writeFile(join(modelsDir(dir), `${id}.zip`), voskFixtureZip(id))
  const out = await ensureVoskModelExtracted(dir, id)
  assert.equal(out, join(modelsDir(dir), id))
  assert.equal(verifyVoskModelDir(out), true)
  assert.equal(td.decode(await readFile(join(out, 'mfcc.conf'))), '--sample-frequency=16000')

  // idempotente: destrói um arquivo → regrava na próxima chamada
  await rm(join(out, 'final.mdl'))
  assert.equal(verifyVoskModelDir(out), false)
  await ensureVoskModelExtracted(dir, id)
  assert.equal(verifyVoskModelDir(out), true)

  await assert.rejects(() => ensureVoskModelExtracted(dir, 'modelo-inexistente'), /desconhecido/)
})

test('backend engine vosk: extrai o zip e falha com o erro honesto do motor (libvosk) ausente', async (t) => {
  const dir = await tmpDir('stt-vosk-')
  t.after(() => rm(dir, { recursive: true, force: true }))
  const id = 'vosk-model-small-pt-0.3'
  await mkdir(modelsDir(dir), { recursive: true })
  await writeFile(join(modelsDir(dir), `${id}.zip`), voskFixtureZip(id))
  const backend = createSttLocalBackend({
    baseDir: dir,
    selection: { engine: 'vosk', model: id },
    loadEngine: async () => ({ transcribe: async () => ({ text: '' }) }),
    engineCache: new Map()
  })
  assert.equal(backend.ready, false, 'vosk não tem runtime carregável nesta versão')
  await assert.rejects(
    () => backend.transcribe(wavInput(tinyPcm()), {}),
    /libvosk.*não está plugado/
  )
  assert.equal(
    verifyVoskModelDir(join(modelsDir(dir), id)),
    true,
    'a extração aconteceu mesmo assim'
  )
})

test('backend engine nemotron: erro honesto de engine sem motor (GGUF/llama.cpp é futura)', async (t) => {
  const dir = await tmpDir('stt-nemo-')
  t.after(() => rm(dir, { recursive: true, force: true }))
  const backend = createSttLocalBackend({
    baseDir: dir,
    selection: { engine: 'nemotron', model: 'nemotron-3.5-asr-streaming-0.6b' },
    loadEngine: async () => ({ transcribe: async () => ({ text: '' }) })
  })
  await assert.rejects(() => backend.transcribe(wavInput(tinyPcm()), {}), /ainda não tem motor/)
})

// ---------------- integração REAL (skip por padrão) ----------------

const realModel = process.env.CLEARCHAT_STT_REAL_MODEL?.trim()

test(
  'integração REAL: ggml do catálogo transcreve áudio sintético (requer CLEARCHAT_STT_REAL_MODEL)',
  { skip: realModel ? false : 'sem CLEARCHAT_STT_REAL_MODEL (modelo não deve baixar em CI)' },
  async (t) => {
    const entry =
      LOCAL_MODEL_CATALOG.find(
        (e) => e.id === (process.env.CLEARCHAT_STT_REAL_ID ?? 'ggml-tiny')
      ) ?? findCatalogEntry('ggml-tiny')!
    assert.ok(entry?.url, 'entrada do catálogo com arquivo')
    const dir = await tmpDir('stt-real-')
    t.after(() => rm(dir, { recursive: true, force: true }))
    await mkdir(modelsDir(dir), { recursive: true })
    await symlink(realModel!, join(modelsDir(dir), entry.url!.split('/').pop()!))
    t.after(() => shutdownSttWorker())
    const backend = createSttLocalBackend({
      baseDir: dir,
      selection: { engine: 'whisper.cpp', model: entry.id }
    })
    assert.equal(backend.ready, true)
    // ~0,5 s de "fala": seno modulado (o whisper devolve texto vazio para tom puro — sem crash)
    const pcm = new Int16Array(8000)
    for (let i = 0; i < pcm.length; i++)
      pcm[i] = Math.round(Math.sin((2 * Math.PI * 220 * i) / 16_000) * 8000)
    const r = await backend.transcribe(wavInput(pcm), { language: 'pt-BR' })
    assert.equal(typeof r.text, 'string')
    assert.equal(r.baseUrl, 'local')
    console.log(`      [real] ${r.ms} ms | texto: ${JSON.stringify(r.text)}`)
  }
)
