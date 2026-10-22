// Clipes de interjeição/filler (`src/main/voice/clips.ts`): nomes de arquivo pela whitelist de
// classes, manifest por voz (id da voz, engine, modelo, hash da definição), cache reutilizado
// quando a definição não muda, regeneração quando a voz muda (diretório novo), `resolveClip` para
// a Feature B e defesa contra ids de voz/nomes inseguros. A síntese usa um motor local FAKE (nada
// de ONNX nem rede — o pipeline real está reportado na SPEC).
// Rodar: npm run test:unit
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CLIP_CLASSES,
  CLIP_PHRASES,
  CLIP_VARIANTS,
  clipFileName,
  clipVoiceId,
  clipsDir,
  clipsHash,
  generateClips,
  loadClips,
  removeClips,
  resolveClip
} from '../src/main/voice/clips.ts'
import type { TtsLocalBackend, TtsLocalInput, TtsLocalResult } from '../src/main/voice/tts.ts'
import { normalizeTtsSettings, type TtsSettings } from '../src/shared/voice.ts'

// ---------------- helpers ----------------

const newBase = (): string => mkdtempSync(join(tmpdir(), 'clearchat-clips-'))

const localSettings = (voice = 'pf_dora'): TtsSettings =>
  normalizeTtsSettings({
    backend: 'local',
    local: { engine: 'kokoro', voice, installed: true }
  })

const apiSettings = (over: Partial<TtsSettings['api']> = {}): TtsSettings =>
  normalizeTtsSettings({
    backend: 'api',
    api: {
      providerId: null,
      baseUrl: 'https://tts.example/v1',
      apiKey: 'sk-test',
      model: 'tts-model',
      voice: 'alloy',
      ...over
    }
  })

/** Motor local fake: cada chamada vira um "wav" com o tamanho pedido, e conta chamadas. */
function fakeEngine(): { backend: TtsLocalBackend; calls: TtsLocalInput[] } {
  const calls: TtsLocalInput[] = []
  return {
    calls,
    backend: {
      engine: 'kokoro',
      async synthesize(input: TtsLocalInput): Promise<TtsLocalResult> {
        calls.push(input)
        return {
          audio: new Uint8Array([82, 73, 70, 70, calls.length]),
          mime: 'audio/wav',
          model: 'kokoro-onnx',
          ms: 1
        }
      }
    }
  }
}

const totalClips = CLIP_CLASSES.length * CLIP_VARIANTS

// ---------------- nomes e ids (whitelist/segurança) ----------------

test('clipFileName: whitelist de classes e variantes 1..3; fora disso → erro legível', () => {
  for (const cls of CLIP_CLASSES) {
    for (let n = 1; n <= CLIP_VARIANTS; n++) {
      assert.equal(clipFileName(cls, n), `${cls}_${n}.wav`)
    }
  }
  assert.throws(() => clipFileName('EXEC', 1), /classe de clipe desconhecida/)
  assert.throws(() => clipFileName('../../evil', 1), /classe de clipe desconhecida/)
  assert.throws(() => clipFileName('ACK', 0), /variante de clipe inválida/)
  assert.throws(() => clipFileName('ACK', 4), /variante de clipe inválida/)
  assert.throws(() => clipFileName('ACK', 1.5), /variante de clipe inválida/)
})

test('clipVoiceId: engine+voz por trás de um segmento seguro (sem separadores de caminho)', () => {
  assert.equal(clipVoiceId(localSettings('pf_dora')), 'local-kokoro-pf_dora')
  assert.equal(clipVoiceId(apiSettings({ voice: 'alloy' })), 'api-alloy')
  assert.equal(clipVoiceId(apiSettings({ voice: null })), 'api-padrao')
  // voz maliciosa/livre nunca vira caminho
  for (const evil of ['../../etc/passwd', 'a/b', '..', 'x'.repeat(200)]) {
    const id = clipVoiceId(apiSettings({ voice: evil }))
    assert.ok(!id.includes('/') && !id.includes('..'), `id seguro: ${id}`)
    assert.ok(clipsDir('/tmp/x', id), `clipsDir aceita o id derivado: ${id}`)
  }
  // id cru inseguro é recusado pelo clipsDir (defesa de load/resolve)
  assert.equal(clipsDir('/tmp/x', '../../evil'), null)
  assert.equal(clipsDir('/tmp/x', 'a/b'), null)
})

// ---------------- geração + manifest ----------------

test('generateClips: 15 clipes na whitelist, manifest com voz/engine/hash e progresso', async () => {
  const base = newBase()
  const { backend, calls } = fakeEngine()
  const progress: { id: string; done: number; total: number }[] = []
  const manifest = await generateClips({
    baseDir: base,
    settings: localSettings('pf_dora'),
    local: backend,
    onProgress: (e) => progress.push(e)
  })
  assert.equal(calls.length, totalClips)
  assert.equal(manifest.voiceId, 'local-kokoro-pf_dora')
  assert.equal(manifest.backend, 'local')
  assert.equal(manifest.engine, 'kokoro')
  assert.equal(manifest.model, 'pf_dora')
  assert.match(manifest.hash, /^[0-9a-f]{64}$/)
  assert.match(manifest.generatedAt, /^\d{4}-\d{2}-\d{2}T/)
  assert.equal(manifest.clips.length, totalClips)
  // cada clipe: id/file/texto coerentes com o catálogo de frases
  for (const c of manifest.clips) {
    assert.equal(c.id, `${c.class}_${c.n}`)
    assert.equal(c.file, clipFileName(c.class, c.n))
    assert.equal(c.text, CLIP_PHRASES[c.class][c.n - 1])
  }
  // progresso 1..15 com o id do clipe
  assert.equal(progress.length, totalClips)
  assert.deepEqual(
    progress.map((p) => p.done),
    Array.from({ length: totalClips }, (_, i) => i + 1)
  )
  assert.ok(progress.every((p) => p.total === totalClips))
  assert.equal(progress[0].id, 'ACK_1')
  // arquivos em <base>/voice-clips/<voiceId>/<CLASSE>_<n>.wav + manifest.json (sem .part sobrando)
  const dir = clipsDir(base, manifest.voiceId)!
  const files = readdirSync(dir).sort()
  assert.equal(files.filter((f) => f.endsWith('.part')).length, 0)
  assert.ok(files.includes('manifest.json'))
  for (const c of manifest.clips) assert.ok(existsSync(join(dir, c.file)), c.file)
  // manifest em disco = o devolvido (e o texto das frases está lá)
  const onDisk = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'))
  assert.deepEqual(onDisk, manifest)
  rmSync(base, { recursive: true, force: true })
})

test('generateClips: cache reutilizado quando a definição não muda (não ressintetiza)', async () => {
  const base = newBase()
  const { backend, calls } = fakeEngine()
  const first = await generateClips({ baseDir: base, settings: localSettings(), local: backend })
  const second = await generateClips({ baseDir: base, settings: localSettings(), local: backend })
  assert.equal(calls.length, totalClips, 'segunda chamada não ressintetiza')
  assert.deepEqual(second, first)
  rmSync(base, { recursive: true, force: true })
})

test('generateClips: regenera quando a VOZ muda (diretório novo por voz) e quando o hash muda', async () => {
  const base = newBase()
  const { backend, calls } = fakeEngine()
  const a = await generateClips({
    baseDir: base,
    settings: localSettings('pf_dora'),
    local: backend
  })
  const b = await generateClips({
    baseDir: base,
    settings: localSettings('pm_alex'),
    local: backend
  })
  assert.equal(a.voiceId, 'local-kokoro-pf_dora')
  assert.equal(b.voiceId, 'local-kokoro-pm_alex')
  assert.equal(calls.length, totalClips * 2, 'voz nova ressintetiza tudo')
  // os dois caches convivem (a voz antiga continua resolvível)
  assert.ok(await loadClips(base, a.voiceId))
  assert.ok(await loadClips(base, b.voiceId))
  assert.ok(await resolveClip(base, a.voiceId, 'ACK', 1))
  assert.ok(await resolveClip(base, b.voiceId, 'ACK', 1))
  // hash muda com a voz (mesmo texto/backend)
  assert.notEqual(a.hash, b.hash)
  rmSync(base, { recursive: true, force: true })
})

test('generateClips: hash da definição muda → regerar (cache invalidado)', async () => {
  const base = newBase()
  const calls: unknown[] = []
  const orig = globalThis.fetch
  globalThis.fetch = (async () => {
    calls.push(1)
    return new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { 'content-type': 'audio/wav' }
    })
  }) as typeof fetch
  try {
    const settings = apiSettings({ model: 'tts-model' })
    const first = await generateClips({ baseDir: base, settings })
    assert.equal(calls.length, totalClips)
    // mesmo voiceId (mesma voz), modelo diferente → hash diferente → ressintetiza
    const changed = apiSettings({ model: 'outro-modelo' })
    assert.equal(clipVoiceId(changed), clipVoiceId(settings))
    assert.notEqual(await clipsHash(changed), first.hash)
    const second = await generateClips({ baseDir: base, settings: changed })
    assert.equal(calls.length, totalClips * 2)
    assert.notEqual(second.model, first.model)
  } finally {
    globalThis.fetch = orig
    rmSync(base, { recursive: true, force: true })
  }
})

// ---------------- load/resolve ----------------

test('loadClips: manifest inválido/incompleto → null (o chamador regenera)', async () => {
  const base = newBase()
  const { backend } = fakeEngine()
  const m = await generateClips({ baseDir: base, settings: localSettings(), local: backend })
  const dir = clipsDir(base, m.voiceId)!
  // sem manifest → null
  rmSync(join(dir, 'manifest.json'))
  assert.equal(await loadClips(base, m.voiceId), null)
  // JSON inválido → null
  writeFileSync(join(dir, 'manifest.json'), '{ não é json')
  assert.equal(await loadClips(base, m.voiceId), null)
  // vozId trocado no manifest → null
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ ...m, voiceId: 'outra-voz' }))
  assert.equal(await loadClips(base, m.voiceId), null)
  // clipe fora da whitelist → null
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({
      ...m,
      clips: [{ id: 'EXEC_1', file: 'EXEC_1.wav', class: 'EXEC', n: 1, text: 'x' }]
    })
  )
  assert.equal(await loadClips(base, m.voiceId), null)
  // arquivo faltando → null (cache incompleto)
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(m))
  rmSync(join(dir, 'ACK_1.wav'))
  assert.equal(await loadClips(base, m.voiceId), null)
  // id de voz inseguro → null (sem traversal)
  assert.equal(await loadClips(base, '../../evil'), null)
  rmSync(base, { recursive: true, force: true })
})

test('resolveClip: caminho do wav por classe/variante; inválidos/ausentes → null', async () => {
  const base = newBase()
  const { backend } = fakeEngine()
  const m = await generateClips({ baseDir: base, settings: localSettings(), local: backend })
  const dir = clipsDir(base, m.voiceId)!
  assert.equal(await resolveClip(base, m.voiceId, 'FILLER', 3), join(dir, 'FILLER_3.wav'))
  assert.equal(await resolveClip(base, m.voiceId, 'ACK', 9), null)
  assert.equal(await resolveClip(base, m.voiceId, 'EXEC', 1), null)
  assert.equal(await resolveClip(base, '../../evil', 'ACK', 1), null)
  // classe conhecida mas nunca gerada (cache parcial) → null
  rmSync(join(dir, 'THINKING_2.wav'))
  assert.equal(await resolveClip(base, m.voiceId, 'THINKING', 2), null)
  rmSync(base, { recursive: true, force: true })
})

test('removeClips: apaga o cache da voz (idempotente) e ids inseguros ficam de fora', async () => {
  const base = newBase()
  const { backend } = fakeEngine()
  const m = await generateClips({ baseDir: base, settings: localSettings(), local: backend })
  await removeClips(base, m.voiceId)
  assert.equal(await loadClips(base, m.voiceId), null)
  await removeClips(base, m.voiceId) // idempotente
  await removeClips(base, '../../evil') // sem efeito (não apaga nada fora)
  assert.ok(existsSync(join(base, 'voice-clips')))
  rmSync(base, { recursive: true, force: true })
})

test('generateClips: abort no meio → rejeita e não deixa manifest', async () => {
  const base = newBase()
  const controller = new AbortController()
  const { backend, calls } = fakeEngine()
  const p = generateClips({
    baseDir: base,
    settings: localSettings(),
    local: backend,
    signal: controller.signal,
    onProgress: (e) => {
      if (e.done === 2) controller.abort()
    }
  })
  await assert.rejects(p, /cancelada/)
  assert.ok(calls.length < totalClips)
  const dir = clipsDir(base, clipVoiceId(localSettings()))!
  assert.ok(!existsSync(join(dir, 'manifest.json')), 'sem manifest após abort')
  rmSync(base, { recursive: true, force: true })
})

test('clipsHash: estável para a mesma definição e sensível a frases/voz/modelo', async () => {
  const h1 = await clipsHash(localSettings('pf_dora'))
  const h2 = await clipsHash(localSettings('pf_dora'))
  assert.equal(h1, h2)
  assert.notEqual(h1, await clipsHash(localSettings('pm_alex')))
  assert.notEqual(h1, await clipsHash(apiSettings()))
  assert.match(h1, /^[0-9a-f]{64}$/)
})

// catálogo de frases: 3 variantes por classe, sem vazias (o manifest depende disso)
test('CLIP_PHRASES: 3 variantes não vazias por classe (whitelist inteira)', () => {
  assert.equal(CLIP_CLASSES.length, 5)
  for (const cls of CLIP_CLASSES) {
    const phrases = CLIP_PHRASES[cls]
    assert.equal(phrases.length, CLIP_VARIANTS, cls)
    for (const p of phrases) assert.ok(p.trim().length > 0, `${cls}: ${p}`)
  }
  // fillers pós-turno do contrato
  assert.ok(CLIP_PHRASES.FILLER.some((p) => p.includes('minutinho')))
  assert.ok(CLIP_PHRASES.FILLER.some((p) => p.includes('calma')))
  assert.ok(CLIP_PHRASES.FILLER.some((p) => p.includes('instante')))
  // sanity: nenhum arquivo temporário criado na raiz do tmp por engano
  assert.ok(existsSync(tmpdir()))
})
