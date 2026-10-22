// Gerenciador de componentes locais de áudio (`src/main/voice/catalog.ts` + `models.ts`, sem
// Electron): validação do catálogo (URLs https, campos obrigatórios, sem GPL, nomes reais das
// URLs), manifest (round-trip, escrita atômica, corrompido → backup + vazio), download com fetch
// mockado (progresso, arquivo final + manifest, sha256 errado rejeita e limpa, cancel no meio
// limpa, HTTP 500 e stream truncado falham limpos, idempotência) e remove/resolve.
// NUNCA há download real: fetch mockado em todos os casos; diretórios temporários por teste.
// Rodar: node --import ./e2e/ts-hooks.mjs --test e2e/voiceModels.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  LOCAL_MODEL_CATALOG,
  catalogFileName,
  expectedMagic,
  findCatalogEntry,
  type LocalModelCatalogEntry
} from '../src/main/voice/catalog.ts'
import {
  downloadLocalModel,
  listLocalModels,
  modelsDir,
  readManifest,
  removeLocalModel,
  resolveLocalModelPath,
  verifyModelFile,
  writeManifest,
  type ManifestEntry
} from '../src/main/voice/models.ts'

const TMP = mkdtempSync(join(process.env.CLEARCHAT_TEST_TMP || tmpdir(), 'clearchat-voice-models-'))

// ---------------- helpers ----------------

let caseN = 0
/** baseDir novo por teste (é o userData injetado; o gerenciador usa `<baseDir>/models/`). */
const newBase = (): string => join(TMP, `case-${++caseN}`)

const sha256Hex = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex')

/** Payload com os magic bytes de ggml (whisper.cpp) + corpo conhecido. */
function payload(bodyLen = 12): Uint8Array {
  return new Uint8Array([
    0x6c,
    0x6d,
    0x67,
    0x67,
    ...Array.from({ length: bodyLen }, (_, i) => i + 1)
  ])
}

const mkEntry = (over: Partial<LocalModelCatalogEntry> = {}): LocalModelCatalogEntry => ({
  id: 'test-model',
  kind: 'stt',
  engine: 'whisper.cpp',
  name: 'Modelo de teste',
  description: 'modelo sintético para os testes',
  languages: ['mul'],
  version: '7',
  sizeBytes: 16,
  sha256Oficial: null,
  url: 'https://example.test/ggml-test.bin',
  license: 'MIT',
  ...over
})

/** Entrada sintética coerente: tamanho e sha256 do payload real. */
const mkEntryFor = (
  data: Uint8Array,
  over: Partial<LocalModelCatalogEntry> = {}
): ReturnType<typeof mkEntry> =>
  mkEntry({
    sizeBytes: data.length,
    sha256Oficial: sha256Hex(data),
    ...over
  })

interface FetchCase {
  calls: string[]
  fetch: (url: string, init: RequestInit) => Promise<Response>
}

/** fetch mockado: devolve o corpo em chunks (progresso em várias chamadas) com content-length. */
function mockFetchChunks(chunks: Uint8Array[]): FetchCase {
  const calls: string[] = []
  return {
    calls,
    fetch: async (url) => {
      calls.push(url)
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          for (const ch of chunks) c.enqueue(ch)
          c.close()
        }
      })
      const total = chunks.reduce((n, c) => n + c.byteLength, 0)
      return new Response(body, { headers: { 'content-length': String(total) } })
    }
  }
}

/** fetch mockado com um stream que emite um chunk e nunca fecha (para o cancel no meio). */
function mockFetchHangs(first: Uint8Array): FetchCase {
  const calls: string[] = []
  return {
    calls,
    fetch: async (url) => {
      calls.push(url)
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(first)
          // nunca fecha: o abort do chamador precisa encerrar o processo de download
        }
      })
      return new Response(body)
    }
  }
}

const manifestEntry = (
  id: string,
  file: string,
  size: number,
  sha256: string | null = null
): ManifestEntry => ({ version: '1', file, sha256, size, installedAt: '2026-10-22T00:00:00.000Z' })

const filesIn = (base: string): string[] =>
  existsSync(modelsDir(base)) ? readdirSync(modelsDir(base)).sort() : []

// ---------------- catálogo ----------------

test('catálogo: campos obrigatórios preenchidos, URLs https, sha256 de 64 hex ou null, sem GPL', () => {
  const ids = new Set<string>()
  for (const e of LOCAL_MODEL_CATALOG) {
    assert.ok(e.id && !ids.has(e.id), `id único e não vazio: ${e.id}`)
    ids.add(e.id)
    assert.ok(e.kind === 'stt' || e.kind === 'tts', e.id)
    assert.ok(typeof e.name === 'string' && e.name.trim(), e.id)
    assert.ok(typeof e.description === 'string' && e.description.trim(), e.id)
    assert.ok(Array.isArray(e.languages) && e.languages.every((l) => typeof l === 'string'), e.id)
    assert.ok(typeof e.version === 'string' && e.version.trim(), e.id)
    assert.ok(Number.isInteger(e.sizeBytes) && e.sizeBytes >= 0, e.id)
    if (e.sha256Oficial !== null) {
      assert.match(e.sha256Oficial, /^[0-9a-f]{64}$/, e.id)
    }
    if (e.url !== null) {
      assert.ok(e.url.startsWith('https://'), `URL https: ${e.url}`)
    }
    assert.ok(typeof e.license === 'string' && e.license.trim(), e.id)
    // GPL ficaria viral no app: nenhum componente GPL no catálogo
    assert.ok(!/GPL/i.test(e.license), `licença sem GPL: ${e.id} → ${e.license}`)
    if (e.notes !== undefined) assert.ok(typeof e.notes === 'string', e.id)
  }
  // os motores batem com o kind
  for (const e of LOCAL_MODEL_CATALOG) {
    const engines =
      e.kind === 'stt' ? ['whisper.cpp', 'vosk', 'nemotron'] : ['kokoro', 'chatterbox']
    assert.ok(engines.includes(e.engine), `${e.id}: engine ${e.engine} coerente com ${e.kind}`)
  }
})

test('catálogo: entradas esperadas com as URLs/nomes reais conferidos nas fontes (2026-10-22)', () => {
  const urls: Record<string, string> = {
    'ggml-tiny': 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin',
    'ggml-base': 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin',
    'ggml-small': 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin',
    'ggml-large-v3-turbo':
      'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin',
    'vosk-model-small-pt-0.3': 'https://alphacephei.com/vosk/models/vosk-model-small-pt-0.3.zip',
    'nemotron-3.5-asr-streaming-0.6b':
      'https://huggingface.co/nvidia/nemotron-3.5-asr-streaming-0.6b/resolve/main/nemotron-3.5-asr-streaming-0.6b.q8_0.gguf',
    'kokoro-onnx':
      'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/onnx/model.onnx',
    'kokoro-onnx-q8':
      'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/onnx/model_quantized.onnx',
    'kokoro-voice-pf-dora':
      'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices/pf_dora.bin',
    'kokoro-voice-pm-alex':
      'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices/pm_alex.bin',
    'kokoro-voice-pm-santa':
      'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices/pm_santa.bin',
    'chatterbox-pt-br-t3':
      'https://huggingface.co/ResembleAI/Chatterbox-Multilingual-pt-br/resolve/main/t3_pt_br.safetensors',
    'chatterbox-pt-br-s3gen':
      'https://huggingface.co/ResembleAI/Chatterbox-Multilingual-pt-br/resolve/main/s3gen_v3.safetensors'
  }
  for (const [id, url] of Object.entries(urls)) {
    const e = findCatalogEntry(id)
    assert.ok(e, `entrada existe: ${id}`)
    assert.equal(e.url, url, id)
    assert.ok(e.sizeBytes > 0, id)
    // whisper.cpp/Nemotron têm sha256 publicado pelo host (HF LFS); Vosk não publica → null
    if (id.startsWith('vosk')) assert.equal(e.sha256Oficial, null, id)
    else assert.match(e.sha256Oficial ?? '', /^[0-9a-f]{64}$/, id)
  }
  // Vosk pt-BR (Apache-2.0) presente; o vosk-model-pt-fb (GPL-3.0) fica de fora por licença
  assert.ok(findCatalogEntry('vosk-model-small-pt-0.3'))
  assert.ok(!LOCAL_MODEL_CATALOG.some((e) => /pt-fb/.test(e.id) || /pt-fb/.test(e.url ?? '')))
  // TTS preenchidos na fatia de TTS: Kokoro (modelo + vozes pt-BR) e o fine-tune pt-BR do
  // Chatterbox — todos com URL real, tamanho exato e sha256 (lfs.oid) do host
  for (const id of [
    'kokoro-onnx',
    'kokoro-onnx-q8',
    'kokoro-voice-pf-dora',
    'kokoro-voice-pm-alex',
    'kokoro-voice-pm-santa',
    'chatterbox-pt-br-t3',
    'chatterbox-pt-br-s3gen'
  ]) {
    const e = findCatalogEntry(id)
    assert.ok(e, id)
    assert.equal(e.kind, 'tts', id)
    assert.ok(e.url, `${id} tem download`)
    assert.ok(e.sizeBytes > 0, id)
    assert.match(e.sha256Oficial ?? '', /^[0-9a-f]{64}$/, id)
  }
  // nenhuma entrada TTS virou placeholder (todas baixáveis)
  assert.ok(!LOCAL_MODEL_CATALOG.some((e) => e.kind === 'tts' && !e.url))
  // o id de voz padrão (pf_dora) existe como artefato do Kokoro
  assert.ok(findCatalogEntry('kokoro-voice-pf-dora'))
})

test('catálogo: magic bytes derivados do formato (ggml, GGUF, zip) e nome de arquivo da URL', () => {
  const ggml = findCatalogEntry('ggml-tiny')!
  assert.equal(catalogFileName(ggml), 'ggml-tiny.bin')
  assert.deepEqual([...expectedMagic(ggml)!], [0x6c, 0x6d, 0x67, 0x67])
  const gguf = findCatalogEntry('nemotron-3.5-asr-streaming-0.6b')!
  assert.deepEqual([...expectedMagic(gguf)!], [0x47, 0x47, 0x55, 0x46])
  const zip = findCatalogEntry('vosk-model-small-pt-0.3')!
  assert.deepEqual([...expectedMagic(zip)!], [0x50, 0x4b, 0x03, 0x04])
  assert.equal(catalogFileName(mkEntry({ url: null })), null)
  // TTS (.onnx/.safetensors/voices .bin) não têm magic de ggml — verificação por tamanho+sha256
  for (const id of ['kokoro-onnx', 'kokoro-voice-pf-dora', 'chatterbox-pt-br-t3']) {
    assert.equal(expectedMagic(findCatalogEntry(id)!), null, id)
  }
  // o .bin de voz do Kokoro NÃO é ggml (o .bin do whisper é)
  assert.equal(catalogFileName(findCatalogEntry('kokoro-voice-pf-dora')!), 'pf_dora.bin')
})

// ---------------- manifest ----------------

test('manifest: round-trip, escrita atômica e idempotência', async () => {
  const base = newBase()
  assert.deepEqual(await readManifest(base), {})
  const manifest = {
    a: manifestEntry('a', 'a.bin', 10, sha256Hex(new Uint8Array(10))),
    b: manifestEntry('b', 'b.zip', 20)
  }
  await writeManifest(base, manifest)
  assert.deepEqual(await readManifest(base), manifest)
  // escrita idempotente e ordenada (mesmo conteúdo)
  await writeManifest(base, manifest)
  assert.deepEqual(await readManifest(base), manifest)
  assert.deepEqual(filesIn(base), ['manifest.json'])
  await writeManifest(base, manifest)
  assert.deepEqual(filesIn(base), ['manifest.json'], 'sem sobras de .tmp')
  assert.deepEqual(
    JSON.parse(readFileSync(join(modelsDir(base), 'manifest.json'), 'utf8')),
    manifest
  )
})

test('manifest: ausente/JSON inválido/lixo → backup em manifest.json.bak e vazio; entradas inválidas descartadas', async () => {
  const base = newBase()
  // ausente → vazio, sem backup
  assert.deepEqual(await readManifest(base), {})
  assert.deepEqual(filesIn(base), [])
  // JSON inválido → renomeado para .bak e vazio
  mkdirSync(modelsDir(base), { recursive: true })
  const path = join(modelsDir(base), 'manifest.json')
  writeFileSync(path, '{ não é json')
  assert.deepEqual(await readManifest(base), {})
  assert.equal(readFileSync(path + '.bak', 'utf8'), '{ não é json')
  assert.ok(!existsSync(path), 'o manifest corrompido sai do caminho')
  // JSON válido mas não-objeto → backup + vazio
  writeFileSync(path, '[1,2,3]')
  assert.deepEqual(await readManifest(base), {})
  assert.equal(readFileSync(path + '.bak', 'utf8'), '[1,2,3]')
  // entradas parcialmente inválidas: só a válida sobra (file com separador é descartado)
  writeFileSync(
    path,
    JSON.stringify({
      ok: manifestEntry('ok', 'ok.bin', 5),
      semFile: { version: '1', size: 3 },
      fileRuim: { file: '../evil.bin', size: 3, version: '1', sha256: null, installedAt: '' },
      sizeRuim: { file: 'x.bin', size: -1, version: '1', sha256: null, installedAt: '' },
      lixo: 'x'
    })
  )
  const manifest = await readManifest(base)
  assert.deepEqual(Object.keys(manifest), ['ok'])
  assert.deepEqual(manifest.ok, manifestEntry('ok', 'ok.bin', 5))
})

// ---------------- download ----------------

test('download: progresso em chunks, arquivo final, manifest e estados', async () => {
  const base = newBase()
  const data = payload(12)
  const entry = mkEntryFor(data)
  const chunks = [data.slice(0, 4), data.slice(4, 9), data.slice(9)]
  const { calls, fetch } = mockFetchChunks(chunks)
  const progress: [number, number][] = []
  const info = await downloadLocalModel(base, entry.id, {
    catalog: [entry],
    fetch,
    onProgress: (bytes, total) => progress.push([bytes, total])
  })
  assert.deepEqual(calls, ['https://example.test/ggml-test.bin'])
  assert.deepEqual(
    progress,
    [
      [4, data.length],
      [9, data.length],
      [16, data.length]
    ],
    'progresso acumulativo por chunk com o total esperado'
  )
  const path = join(modelsDir(base), 'ggml-test.bin')
  assert.deepEqual([...readFileSync(path)], [...data], 'arquivo final byte a byte')
  assert.deepEqual(filesIn(base), ['ggml-test.bin', 'manifest.json'], 'sem .part sobrando')
  const m = (await readManifest(base))[entry.id]
  assert.ok(m)
  assert.equal(m.version, '7')
  assert.equal(m.file, 'ggml-test.bin')
  assert.equal(m.sha256, sha256Hex(data))
  assert.equal(m.size, data.length)
  assert.ok(!Number.isNaN(Date.parse(m.installedAt)), 'installedAt é data ISO')
  // estados e caminhos
  const [info2] = await listLocalModels(base, { catalog: [entry] })
  assert.equal(info2.state, 'installed')
  assert.equal(info2.path, path)
  assert.equal(info2.installedBytes, data.length)
  assert.deepEqual(info2.manifest, m)
  assert.equal(info.state, 'installed')
  assert.equal(await resolveLocalModelPath(base, entry.id, { catalog: [entry] }), path)
  // verificação profunda devolve o sha256 calculado
  assert.equal(await verifyModelFile(path, entry), sha256Hex(data))
})

test('download: sha256 oficial errado → rejeita, limpa o .part e nada é instalado/registrado', async () => {
  const base = newBase()
  const data = payload(12)
  const entry = mkEntryFor(data, { sha256Oficial: '0'.repeat(64) })
  const { fetch } = mockFetchChunks([data])
  await assert.rejects(
    downloadLocalModel(base, entry.id, { catalog: [entry], fetch }),
    /verificação falhou: sha256/
  )
  assert.deepEqual(filesIn(base), [], 'sem arquivo final nem .part')
  assert.deepEqual(await readManifest(base), {})
  assert.equal((await listLocalModels(base, { catalog: [entry] }))[0].state, 'notInstalled')
})

test('download: tamanho errado (stream truncado) → rejeita e limpa', async () => {
  const base = newBase()
  const data = payload(12)
  const entry = mkEntryFor(data)
  const truncated = data.slice(0, 8)
  const { fetch } = mockFetchChunks([truncated])
  await assert.rejects(
    downloadLocalModel(base, entry.id, { catalog: [entry], fetch }),
    /verificação falhou: tamanho/
  )
  assert.deepEqual(filesIn(base), [])
  assert.deepEqual(await readManifest(base), {})
})

test('download: magic bytes errados → rejeita e limpa (regra de verificação sem depender só do hash)', async () => {
  const base = newBase()
  const data = new Uint8Array(16).fill(7) // sem os magic bytes de ggml
  const entry = mkEntryFor(data, { sha256Oficial: null, sizeBytes: data.length })
  const { fetch } = mockFetchChunks([data])
  await assert.rejects(
    downloadLocalModel(base, entry.id, { catalog: [entry], fetch }),
    /verificação falhou: magic/
  )
  assert.deepEqual(filesIn(base), [])
})

test('download: cancel no meio → AbortError e o .part é limpo; cancel antes de começar não baixa', async () => {
  const base = newBase()
  const data = payload(12)
  const entry = mkEntryFor(data)
  const { calls, fetch } = mockFetchHangs(data.slice(0, 4))
  const ctrl = new AbortController()
  await assert.rejects(
    downloadLocalModel(base, entry.id, {
      catalog: [entry],
      fetch,
      signal: ctrl.signal,
      onProgress: () => ctrl.abort()
    }),
    (e: unknown) => (e as Error).name === 'AbortError'
  )
  assert.deepEqual(filesIn(base), [], 'nem .part nem arquivo final')
  assert.deepEqual(await readManifest(base), {})
  assert.equal(calls.length, 1)
  // abort já vindo pronto → nem chega a baixar
  const ctrl2 = new AbortController()
  ctrl2.abort()
  const hanging = mockFetchHangs(data.slice(0, 4))
  await assert.rejects(
    downloadLocalModel(base, entry.id, {
      catalog: [entry],
      fetch: hanging.fetch,
      signal: ctrl2.signal
    }),
    (e: unknown) => (e as Error).name === 'AbortError'
  )
  assert.equal(hanging.calls.length, 0, 'fetch nem é chamado com o abort pronto')
  assert.deepEqual(filesIn(base), [])
})

test('download: HTTP 500 → erro legível e nada instalado', async () => {
  const base = newBase()
  const entry = mkEntryFor(payload(12))
  const { fetch } = {
    calls: [] as string[],
    fetch: async (): Promise<Response> => new Response('boom', { status: 500 })
  }
  await assert.rejects(
    downloadLocalModel(base, entry.id, { catalog: [entry], fetch }),
    /download falhou: HTTP 500/
  )
  assert.deepEqual(filesIn(base), [])
  assert.deepEqual(await readManifest(base), {})
})

test('download: idempotente (instalado não rebaixa) e rebaixa quando corrompido', async () => {
  const base = newBase()
  const data = payload(12)
  const entry = mkEntryFor(data)
  const { calls, fetch } = mockFetchChunks([data])
  await downloadLocalModel(base, entry.id, { catalog: [entry], fetch })
  const again = await downloadLocalModel(base, entry.id, { catalog: [entry], fetch })
  assert.equal(calls.length, 1, 'segunda chamada não baixa de novo')
  assert.equal(again.state, 'installed')
  // corrompe o arquivo instalado → estado corrupt → download de novo substitui
  const path = join(modelsDir(base), 'ggml-test.bin')
  writeFileSync(path, Buffer.from(data.slice(0, 6)))
  const [corrupt] = await listLocalModels(base, { catalog: [entry] })
  assert.equal(corrupt.state, 'corrupt')
  await downloadLocalModel(base, entry.id, { catalog: [entry], fetch })
  assert.equal(calls.length, 2, 'corrompido baixa de novo')
  assert.deepEqual([...readFileSync(path)], [...data])
  assert.equal((await listLocalModels(base, { catalog: [entry] }))[0].state, 'installed')
})

test('download: id desconhecido e placeholder sem URL → erro legível', async () => {
  const base = newBase()
  const entry = mkEntryFor(payload(12))
  const placeholder = mkEntry({ id: 'placeholder', url: null, sizeBytes: 0 })
  const { fetch } = mockFetchChunks([payload(12)])
  await assert.rejects(
    downloadLocalModel(base, 'nao-existe', { catalog: [entry, placeholder], fetch }),
    /modelo desconhecido/
  )
  await assert.rejects(
    downloadLocalModel(base, 'placeholder', { catalog: [entry, placeholder], fetch }),
    /não tem download disponível ainda \(preenchido na fatia de TTS\)/
  )
  assert.equal(placeholder.url, null)
  assert.deepEqual(filesIn(base), [])
})

// ---------------- estados da lista ----------------

test('list: arquivo órfão, registro sem arquivo e tamanho divergente → corrupt', async () => {
  const base = newBase()
  const data = payload(12)
  const entry = mkEntryFor(data)
  mkdirSync(modelsDir(base), { recursive: true })
  // arquivo sem registro
  writeFileSync(join(modelsDir(base), 'ggml-test.bin'), Buffer.from(data))
  assert.equal((await listLocalModels(base, { catalog: [entry] }))[0].state, 'corrupt')
  // registro sem arquivo
  await writeManifest(base, {
    [entry.id]: manifestEntry(entry.id, 'ggml-test.bin', data.length, sha256Hex(data))
  })
  rmSync(join(modelsDir(base), 'ggml-test.bin'))
  const [semArquivo] = await listLocalModels(base, { catalog: [entry] })
  assert.equal(semArquivo.state, 'corrupt')
  assert.equal(semArquivo.path, null)
  assert.equal(semArquivo.installedBytes, null)
  // arquivo com tamanho diferente do registro → corrupt
  writeFileSync(join(modelsDir(base), 'ggml-test.bin'), Buffer.from(data.slice(0, 6)))
  const [tamanho] = await listLocalModels(base, { catalog: [entry] })
  assert.equal(tamanho.state, 'corrupt')
  // manifest de entrada com nome de arquivo inseguro não vira caminho
  await writeManifest(base, {
    [entry.id]: { ...manifestEntry(entry.id, 'x', data.length), file: '../evil.bin' as string }
  })
  assert.deepEqual(Object.keys(await readManifest(base)), [], 'entrada insegura descartada no read')
})

// ---------------- remove/resolve ----------------

test('remove: apaga arquivo e registro, idempotente; resolve: caminho e erros legíveis', async () => {
  const base = newBase()
  const data = payload(12)
  const entry = mkEntryFor(data)
  const { fetch } = mockFetchChunks([data])
  await downloadLocalModel(base, entry.id, { catalog: [entry], fetch })
  const path = join(modelsDir(base), 'ggml-test.bin')
  assert.equal(await resolveLocalModelPath(base, entry.id, { catalog: [entry] }), path)
  await removeLocalModel(base, entry.id, { catalog: [entry] })
  assert.ok(!existsSync(path))
  assert.deepEqual(await readManifest(base), {})
  assert.equal((await listLocalModels(base, { catalog: [entry] }))[0].state, 'notInstalled')
  // idempotente: remover de novo não quebra nem regrava
  await removeLocalModel(base, entry.id, { catalog: [entry] })
  await removeLocalModel(base, 'id-fora-do-catalogo')
  assert.deepEqual(await readManifest(base), {})
  // remove também o .part órfão (o manifest.json vazio persiste — escrita atômica só do objeto)
  writeFileSync(join(modelsDir(base), 'ggml-test.bin.part'), Buffer.from(data))
  await removeLocalModel(base, entry.id, { catalog: [entry] })
  assert.deepEqual(filesIn(base), ['manifest.json'])
  assert.deepEqual(await readManifest(base), {})
  // limpa id fora do catálogo que o manifest registra
  await writeManifest(base, { antigo: manifestEntry('antigo', 'antigo.bin', 3) })
  writeFileSync(join(modelsDir(base), 'antigo.bin'), Buffer.from([1, 2, 3]))
  await removeLocalModel(base, 'antigo')
  assert.deepEqual(filesIn(base), ['manifest.json'])
  assert.deepEqual(await readManifest(base), {})
  // resolve: id desconhecido e placeholder sem download (entrada sintética com url: null)
  await assert.rejects(
    resolveLocalModelPath(base, 'nao-existe', { catalog: [entry] }),
    /desconhecido/
  )
  await assert.rejects(
    resolveLocalModelPath(base, 'placeholder', {
      catalog: [entry, mkEntry({ id: 'placeholder', url: null, sizeBytes: 0 })]
    }),
    /placeholder sem download/
  )
})

test('verifyModelFile: sha256 oficial certo devolve o digest; errado rejeita', async () => {
  const base = newBase()
  const data = payload(12)
  const entry = mkEntryFor(data)
  const { fetch } = mockFetchChunks([data])
  await downloadLocalModel(base, entry.id, { catalog: [entry], fetch })
  const path = join(modelsDir(base), 'ggml-test.bin')
  assert.equal(await verifyModelFile(path, entry), sha256Hex(data))
  const wrong = mkEntryFor(data, { sha256Oficial: 'f'.repeat(64) })
  await assert.rejects(verifyModelFile(path, wrong), /sha256 do arquivo difere/)
  const bigSize = mkEntryFor(data, { sizeBytes: data.length + 1 })
  await assert.rejects(verifyModelFile(path, bigSize), /tamanho/)
})

// limpa o temporário ao final (os casos usam subpastas próprias)
process.on('exit', () => {
  try {
    rmSync(TMP, { recursive: true, force: true })
  } catch {
    // melhor esforço
  }
})
