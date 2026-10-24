// ElevenLabs direta (`src/main/voice/elevenlabs.ts` + `elevenlabsStream.ts`) contra o servidor FAKE
// (`e2e/fakes/elevenlabsFake.mjs` — sem rede, sem chave real): tipo de provedor `elevenlabs`
// (registro, fora dos seletores de chat, "Testar conexão" com fetch mockado), REST → WAV,
// WebSocket multi-contexto (texto em streaming palavra a palavra, flush, PCM → pedaços da
// chamada pelo `TtsStreamRelay`, barge-in, erros de chave/cota/voz, reconexão depois de ociosidade,
// reenvio depois de queda, limite de concorrência, latência) e os ganchos `ttsFeed` da chamada.
// Rodar: node --import ./e2e/ts-hooks.mjs --test e2e/elevenlabs.test.ts
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent, ChatConfig } from '@shared/types'
import {
  DEFAULT_AUDIO_INPUT,
  DEFAULT_STT_SETTINGS,
  DEFAULT_TTS_SETTINGS,
  DEFAULT_VOICE_CALL_DEFAULTS,
  normalizeTtsSettings,
  ttsCallTransport,
  type TtsSettings
} from '@shared/voice'
import {
  inferProviderKind,
  isChatProvider,
  isChatProviderKind,
  PROVIDER_KIND_DEFAULT_URL,
  PROVIDER_KIND_LABEL,
  PROVIDER_KINDS,
  providerKind
} from '@shared/providerKinds'
import type {
  VoiceCallTimelineEvent,
  VoiceCallUtteranceChunkEvent,
  VoiceCallUtteranceEvent
} from '@shared/ipc'
import {
  ELEVENLABS_DEFAULT_MODEL,
  ELEVENLABS_DEFAULT_VOICE_ID,
  elevenLabsBase,
  elevenLabsConfig,
  elevenLabsLanguageCode,
  elevenLabsModelId,
  elevenLabsVoiceId,
  elevenLabsWsSupportsModel,
  isElevenLabsEndpoint,
  listElevenLabsModels,
  listElevenLabsVoices
} from '../src/main/voice/elevenlabs.ts'
import {
  ElevenLabsCallTts,
  ElevenLabsSocket,
  elevenLabsCallOptions,
  elevenLabsWsUrl,
  type ElevenLabsLatency,
  type ElevenLabsSocketOptions,
  type TtsTextFeed
} from '../src/main/voice/elevenlabsStream.ts'
import { synthesize, synthesizeStream, TtsError } from '../src/main/voice/tts.ts'
import { TtsStreamRelay } from '../src/main/voice/ttsStreamRelay.ts'
import { VoiceCallManager } from '../src/main/voice/call.ts'
import { adapterFor } from '../src/main/agent/adapters/index.ts'
import { startElevenLabsFake } from './fakes/elevenlabsFake.mjs'

// main/voice.ts e providers.ts puxam o banco (electron `app`): stub + userData temporário, com
// import dinâmico (os imports estáticos sobem antes do hook)
const TMP = mkdtempSync(join(process.env.CLEARCHAT_TEST_TMP || tmpdir(), 'clearchat-el-'))
process.env.CLEARCHAT_TEST_USERDATA = TMP
const ELECTRON_STUB =
  'data:text/javascript,' +
  encodeURIComponent(`
export const app = { getPath: () => process.env.CLEARCHAT_TEST_USERDATA, getVersion: () => '0.0.0', isPackaged: false }
export default { app }
`)
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === 'electron') return { url: ELECTRON_STUB, shortCircuit: true }
    return next(spec, ctx)
  }
})
let dbLoaded = false
const voiceMod = async (): Promise<typeof import('../src/main/voice.ts')> => {
  dbLoaded = true
  return import('../src/main/voice.ts')
}
const repoMod = async (): Promise<typeof import('../src/main/repo.ts')> => {
  dbLoaded = true
  return import('../src/main/repo.ts')
}
const testProvider = async (
  ...a: Parameters<typeof import('../src/main/providers.ts').testProvider>
): ReturnType<typeof import('../src/main/providers.ts').testProvider> =>
  (await import('../src/main/providers.ts')).testProvider(...a)
after(async () => {
  if (dbLoaded) (await import('../src/main/db.ts')).closeDb()
  rmSync(TMP, { recursive: true, force: true })
})

const KEY = 'test-key'
const SARAH = 'EXAVITQu4vr4xnSDxMaL'
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
async function waitFor<T>(
  fn: () => T | null | undefined | false,
  ms = 3000,
  what = ''
): Promise<T> {
  const t0 = Date.now()
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}`)
    await sleep(5)
  }
}

type Fake = Awaited<ReturnType<typeof startElevenLabsFake>>

const ttsSettings = (baseUrl: string, over: Partial<TtsSettings['api']> = {}): TtsSettings => {
  const s = normalizeTtsSettings({
    backend: 'api',
    api: {
      providerId: 'p-el',
      baseUrl,
      apiKey: KEY,
      model: 'eleven_flash_v2_5',
      voice: SARAH,
      ...over
    }
  })
  // como o `getVoiceSettings` resolve o provedor (base/chave/tipo não são gravados nas settings)
  return {
    ...s,
    api: { ...s.api, baseUrl, apiKey: KEY, ...over, providerKind: 'elevenlabs' }
  }
}

const socketOpts = (
  fake: Fake,
  over: Partial<ElevenLabsSocketOptions> = {}
): ElevenLabsSocketOptions => ({
  ...elevenLabsCallOptions(ttsSettings(fake.url))!,
  ...over
})

async function collect(chunks: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = []
  for await (const c of chunks) parts.push(c)
  return Buffer.concat(parts)
}

/** Bytes de PCM que o fake gera para `text` (240 amostras/char × 2 bytes). */
const pcmBytes = (text: string): number => text.trim().length * 240 * 2

// ---------------- configuração ----------------

test('config: modelo (OpenRouter → id nativo, vazio → Flash v2.5), voz por nome premade, base sem /v1', () => {
  assert.equal(elevenLabsModelId(''), ELEVENLABS_DEFAULT_MODEL)
  assert.equal(elevenLabsModelId('elevenlabs/eleven-flash-v2.5'), 'eleven_flash_v2_5')
  assert.equal(elevenLabsModelId('eleven_turbo_v2_5'), 'eleven_turbo_v2_5')
  assert.equal(elevenLabsModelId('eleven-multilingual-v2'), 'eleven_multilingual_v2')
  assert.equal(elevenLabsVoiceId('Sarah'), SARAH)
  assert.equal(elevenLabsVoiceId('george'), 'JBFqnCBsd6RMkjVDRZzb')
  assert.equal(
    elevenLabsVoiceId('abcDEF1234567890wxyz'),
    'abcDEF1234567890wxyz',
    'id passa como está'
  )
  assert.equal(elevenLabsVoiceId(null), ELEVENLABS_DEFAULT_VOICE_ID)
  assert.equal(elevenLabsBase('https://api.elevenlabs.io/v1/'), 'https://api.elevenlabs.io')
  assert.equal(elevenLabsBase(''), 'https://api.elevenlabs.io')
  assert.equal(elevenLabsWsSupportsModel('eleven_flash_v2_5'), true)
  assert.equal(elevenLabsWsSupportsModel('eleven_v3'), false, 'v3 não serve no WebSocket')
  assert.equal(elevenLabsWsSupportsModel('eleven_v4_turbo'), false)
  assert.equal(elevenLabsLanguageCode('eleven_flash_v2_5'), 'pt')
  assert.equal(
    elevenLabsLanguageCode('eleven_multilingual_v2'),
    null,
    'só v2.5 aceita language_code'
  )
})

test('config: detecção por providerKind ou host; sem chave → TtsError config; opções do WS só com modelo de WS', () => {
  assert.equal(
    isElevenLabsEndpoint({ baseUrl: 'http://127.0.0.1:1', providerKind: 'elevenlabs' }),
    true
  )
  assert.equal(isElevenLabsEndpoint({ baseUrl: 'https://api.elevenlabs.io' }), true)
  assert.equal(isElevenLabsEndpoint({ baseUrl: 'https://openrouter.ai/api/v1' }), false)
  assert.equal(
    isElevenLabsEndpoint({ baseUrl: 'https://api.elevenlabs.io', providerKind: 'openai' }),
    false,
    'tipo explícito vence o host'
  )
  assert.throws(
    () => elevenLabsConfig({ ...ttsSettings('https://api.elevenlabs.io').api, apiKey: '' }),
    (e: unknown) => e instanceof TtsError && e.kind === 'config'
  )
  assert.ok(elevenLabsCallOptions(ttsSettings('https://api.elevenlabs.io')))
  assert.equal(
    elevenLabsCallOptions(ttsSettings('https://api.elevenlabs.io', { model: 'eleven_v3' })),
    null
  )
  assert.equal(elevenLabsCallOptions({ ...ttsSettings('https://x'), backend: 'local' }), null)
  assert.equal(elevenLabsCallOptions(DEFAULT_TTS_SETTINGS), null)
})

test('"Streaming por WebSocket": desligado força HTTP por frase; o indicador da UI espelha o main', () => {
  const on = ttsSettings('https://api.elevenlabs.io')
  assert.equal(on.api.elevenLabsWs, undefined, 'ausente = ligado (não grava o padrão)')
  assert.ok(elevenLabsCallOptions(on))
  const off = ttsSettings('https://api.elevenlabs.io', { elevenLabsWs: false })
  assert.equal(off.api.elevenLabsWs, false, 'o false explícito sobrevive ao normalizador')
  assert.equal(elevenLabsCallOptions(off), null)
  // lixo/true não gravam nada (padrão = ligado)
  assert.equal(
    normalizeTtsSettings({ backend: 'api', api: { elevenLabsWs: 'não' } }).api.elevenLabsWs,
    undefined
  )
  // indicador puro (@shared/voice) = a mesma decisão
  assert.deepEqual(ttsCallTransport(on.api, 'elevenlabs'), { ws: true, reason: null, toggle: true })
  assert.deepEqual(ttsCallTransport(off.api, 'elevenlabs'), {
    ws: false,
    reason: 'desligado por você',
    toggle: true
  })
  const v4 = ttsCallTransport({ model: 'eleven_v4_turbo' }, 'elevenlabs')
  assert.deepEqual(v4, { ws: false, reason: 'o v4 Turbo não suporta WebSocket', toggle: false })
  assert.equal(
    elevenLabsCallOptions(ttsSettings('https://api.elevenlabs.io', { model: 'eleven_v4_turbo' })),
    null
  )
  assert.match(ttsCallTransport({ model: 'x' }, 'openrouter').reason ?? '', /OpenRouter/)
  assert.equal(ttsCallTransport({ model: 'x' }, 'openai').ws, false)
})

test('WS URL: multi-stream-input, pcm_24000, model/language/inactivity — a chave NUNCA vai na URL', () => {
  const cfg = elevenLabsCallOptions(ttsSettings('https://api.elevenlabs.io'))!
  const url = elevenLabsWsUrl(cfg)
  const u = new URL(url)
  assert.equal(u.protocol, 'wss:')
  assert.equal(u.pathname, `/v1/text-to-speech/${SARAH}/multi-stream-input`)
  assert.equal(u.searchParams.get('model_id'), 'eleven_flash_v2_5')
  assert.equal(u.searchParams.get('output_format'), 'pcm_24000')
  assert.equal(u.searchParams.get('language_code'), 'pt')
  assert.equal(u.searchParams.get('inactivity_timeout'), '180')
  assert.ok(!url.includes(KEY))
  assert.equal(new URL(elevenLabsWsUrl({ ...cfg, baseUrl: 'http://127.0.0.1:9' })).protocol, 'ws:')
})

// ---------------- tipo de provedor ----------------

test('provedor `elevenlabs`: registrado (rótulo/URL padrão/inferência), só voz — fora do chat', () => {
  assert.ok((PROVIDER_KINDS as readonly string[]).includes('elevenlabs'))
  assert.equal(PROVIDER_KIND_DEFAULT_URL.elevenlabs, 'https://api.elevenlabs.io')
  assert.match(PROVIDER_KIND_LABEL.elevenlabs, /ElevenLabs/)
  assert.equal(inferProviderKind('https://api.elevenlabs.io'), 'elevenlabs')
  assert.equal(providerKind({ baseUrl: 'https://x', kind: 'elevenlabs' }), 'elevenlabs')
  assert.equal(isChatProviderKind('elevenlabs'), false)
  assert.equal(isChatProvider({ baseUrl: 'https://api.elevenlabs.io', kind: 'elevenlabs' }), false)
  assert.equal(
    isChatProvider({ baseUrl: 'https://openrouter.ai/api/v1', kind: 'openrouter' }),
    true
  )
  const a = adapterFor('elevenlabs')
  assert.deepEqual(a.getHeaders({ apiKey: 'k', headers: {} }), { 'xi-api-key': 'k' })
  assert.throws(() => a.chatUrl('https://api.elevenlabs.io'), /provedor de voz/)
})

test('provedor `elevenlabs`: providerKind + chave só nos serviços do main — a visão do renderer não tem a chave', async () => {
  const { withTtsProviderKind, getVoiceSettings, getVoiceSettingsView, setVoiceSetting } =
    await voiceMod()
  const api = { ...DEFAULT_TTS_SETTINGS.api, providerId: 'p1' }
  const out = withTtsProviderKind(api, () => ({
    baseUrl: 'https://api.elevenlabs.io',
    kind: 'elevenlabs'
  }))
  assert.equal(out.providerKind, 'elevenlabs')
  assert.equal(
    withTtsProviderKind({ ...api, providerId: null }, () => null).providerKind,
    undefined
  )
  // provedor salvo de verdade (banco temporário)
  const { providersRepo } = await repoMod()
  const p = providersRepo.create({
    name: 'ElevenLabs',
    kind: 'elevenlabs',
    baseUrl: 'https://api.elevenlabs.io',
    apiKey: 'sk_el_segredo_123',
    headers: {}
  })
  assert.equal(p.kind, 'elevenlabs')
  setVoiceSetting('ttsSettings', {
    backend: 'api',
    api: { providerId: p.id, baseUrl: '', apiKey: '', model: 'eleven_flash_v2_5', voice: 'Sarah' }
  })
  const eff = getVoiceSettings().tts
  assert.equal(eff.api.providerKind, 'elevenlabs')
  assert.equal(eff.api.apiKey, 'sk_el_segredo_123', 'o serviço do main recebe a chave do provedor')
  assert.ok(elevenLabsCallOptions(eff), 'chamada usa o WebSocket')
  const view = JSON.stringify(getVoiceSettingsView())
  assert.ok(!view.includes('sk_el_segredo'), 'a visão do renderer nunca tem a chave')
  assert.ok(!view.includes('providerKind'), 'nem o campo resolvido')
})

test('"Testar conexão" (fetch mockado): GET /v1/models com xi-api-key; 401 legível; sem chave pede a chave', async () => {
  const orig = globalThis.fetch
  const calls: { url: string; headers: Record<string, string> }[] = []
  try {
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>
      calls.push({ url: String(url), headers })
      if (headers['xi-api-key'] !== 'sk_ok')
        return new Response(
          JSON.stringify({ detail: { status: 'invalid_api_key', message: 'Invalid API key' } }),
          {
            status: 401,
            headers: { 'content-type': 'application/json' }
          }
        )
      return new Response(
        JSON.stringify([
          { model_id: 'eleven_flash_v2_5', name: 'Flash', can_do_text_to_speech: true },
          { model_id: 'eleven_v3', name: 'v3', can_do_text_to_speech: true },
          { model_id: 'scribe_v1', name: 'Scribe', can_do_text_to_speech: false }
        ]),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    }) as typeof fetch
    const ok = await testProvider({
      kind: 'elevenlabs',
      baseUrl: 'https://api.elevenlabs.io',
      apiKey: 'sk_ok'
    })
    assert.deepEqual(ok, { ok: true, modelCount: 2 })
    assert.equal(calls[0].url, 'https://api.elevenlabs.io/v1/models')
    assert.equal(calls[0].headers['xi-api-key'], 'sk_ok')
    assert.ok(!('Authorization' in calls[0].headers))
    const bad = await testProvider({
      kind: 'elevenlabs',
      baseUrl: 'https://api.elevenlabs.io',
      apiKey: 'sk_bad'
    })
    assert.equal(bad.ok, false)
    assert.match(bad.error ?? '', /chave da ElevenLabs inválida/i)
    assert.ok(!(bad.error ?? '').includes('sk_bad'), 'a chave nunca aparece no erro')
    const none = await testProvider({
      kind: 'elevenlabs',
      baseUrl: 'https://api.elevenlabs.io',
      apiKey: ''
    })
    assert.equal(none.ok, false)
    assert.match(none.error ?? '', /API key/)
  } finally {
    globalThis.fetch = orig
  }
})

// ---------------- REST (clipes / "Testar voz") ----------------

test('REST: synthesize → WAV 24 kHz (POST /v1/text-to-speech/{voz}/stream, pcm_24000, model_id, language_code, xi-api-key)', async () => {
  const fake = await startElevenLabsFake()
  try {
    const r = await synthesize({ text: 'Olá, isto é um teste.', settings: ttsSettings(fake.url) })
    assert.equal(r.mime, 'audio/wav')
    assert.equal(r.model, 'eleven_flash_v2_5')
    assert.equal(Buffer.from(r.audio.slice(0, 4)).toString(), 'RIFF')
    assert.equal(Buffer.from(r.audio).readUInt32LE(24), 24000, 'taxa no cabeçalho WAV')
    assert.equal(r.audio.length - 44, pcmBytes('Olá, isto é um teste.'))
    const req = fake.requests.find((q) => q.method === 'POST')!
    assert.equal(req.path, `/v1/text-to-speech/${SARAH}/stream`)
    assert.equal(req.query.output_format, 'pcm_24000')
    assert.equal(req.headers['xi-api-key'], KEY)
    assert.deepEqual(JSON.parse(req.body), {
      text: 'Olá, isto é um teste.',
      model_id: 'eleven_flash_v2_5',
      language_code: 'pt'
    })
    assert.ok(!JSON.stringify(r).includes(KEY), 'resultado sem a chave')
    // streaming (caminho por sentença quando o modelo não serve no WebSocket)
    const s = await synthesizeStream({
      text: 'Frase longa de teste.',
      settings: ttsSettings(fake.url, { model: 'eleven_v3' })
    })
    assert.ok(s.streaming)
    if (s.streaming)
      assert.equal((await collect(s.chunks)).length, pcmBytes('Frase longa de teste.'))
    assert.deepEqual(fake.protocolErrors, [])
  } finally {
    await fake.close()
  }
})

test('REST: erros legíveis — chave (auth), voz inexistente, cota', async () => {
  const fake = await startElevenLabsFake()
  try {
    await assert.rejects(
      synthesize({ text: 'oi', settings: ttsSettings(fake.url, { apiKey: 'errada' }) }),
      (e: unknown) =>
        e instanceof TtsError &&
        e.kind === 'auth' &&
        /chave da ElevenLabs/.test(e.message) &&
        !e.message.includes('errada')
    )
    await assert.rejects(
      synthesize({
        text: 'oi',
        settings: ttsSettings(fake.url, { voice: 'zzzzzzzzzzzzzzzzzzzz' })
      }),
      (e: unknown) => e instanceof TtsError && /voz não encontrada/.test(e.message)
    )
    fake.state.mode = 'quota'
    await assert.rejects(
      synthesize({ text: 'oi', settings: ttsSettings(fake.url) }),
      (e: unknown) => e instanceof TtsError && e.kind === 'quota'
    )
  } finally {
    await fake.close()
  }
})

test('REST: listagens de modelos (só TTS, flag websocket) e vozes da conta', async () => {
  const fake = await startElevenLabsFake()
  try {
    const models = await listElevenLabsModels({ baseUrl: fake.url, apiKey: KEY })
    assert.deepEqual(
      models.map((m) => [m.id, m.websocket]),
      [
        ['eleven_flash_v2_5', true],
        ['eleven_multilingual_v2', true],
        ['eleven_v3', false]
      ]
    )
    assert.deepEqual(models[0].languages, ['pt'])
    const voices = await listElevenLabsVoices({ baseUrl: fake.url, apiKey: KEY })
    assert.deepEqual(
      voices.map((v) => v.name),
      ['Sarah', 'George']
    )
    assert.equal(voices[0].id, SARAH)
  } finally {
    await fake.close()
  }
})

// ---------------- WebSocket ----------------

test('WS: texto em streaming palavra a palavra → flush → PCM; protocolo validado pelo fake', async () => {
  const fake = await startElevenLabsFake()
  const lat: ElevenLabsLatency[] = []
  const el = new ElevenLabsCallTts({
    config: () => socketOpts(fake),
    onLatency: (l) => lat.push(l)
  })
  try {
    el.begin()
    await waitFor(() => fake.connections.length === 1, 2000, 'pré-abertura no begin')
    el.partial('Olá me')
    el.partial('Olá meu amigo, tu')
    el.partial('Olá meu amigo, tudo be')
    el.cut('Olá meu amigo, tudo bem?')
    const s = el.synth('Olá meu amigo, tudo bem?')
    // o corte faz flush SEM fechar (a próxima sentença continuaria no mesmo contexto); o fim da
    // resposta fecha
    await waitFor(() => fake.flushCount === 1, 2000, 'flush')
    assert.ok(!fake.connections[0].frames.some((f) => f.close_context), 'sem close no corte')
    el.end()
    const pcm = await collect(s.chunks)
    assert.equal(pcm.length, pcmBytes('Olá meu amigo, tudo bem?'))
    const frames = fake.connections[0].frames
    assert.equal(frames[0].text, ' ', 'init com espaço')
    assert.equal(frames[0].context_id, 'c1')
    assert.deepEqual(frames[0].generation_config, { chunk_length_schedule: [120, 160, 250, 290] })
    assert.equal(frames[0].xi_api_key, KEY, 'chave no 1º frame (campo documentado)')
    assert.equal(fake.connections[0].headerKey, KEY, 'e no header xi-api-key')
    assert.deepEqual(
      frames.slice(1).map((f) => [f.text ?? null, f.flush ?? false, f.close_context ?? false]),
      [
        ['Olá ', false, false],
        ['meu amigo, ', false, false],
        ['tudo ', false, false],
        ['bem? ', true, false],
        [null, false, true]
      ]
    )
    assert.ok(
      frames.slice(1).every((f) => f.xi_api_key === undefined),
      'a chave só no 1º frame'
    )
    assert.ok(!fake.connections[0].url.includes(KEY))
    assert.equal(lat.length, 1)
    assert.ok(lat[0].turnMs != null && lat[0].turnMs >= 0)
    assert.ok(lat[0].firstTextToAudioMs >= 15, 'inclui o atraso do 1º áudio do fake (20 ms)')
    assert.deepEqual(fake.protocolErrors, [])
  } finally {
    el.close()
    await fake.close()
  }
})

test('WS: frase longa gera áudio ANTES do corte (chunk_length_schedule); sentença sem ganchos também funciona', async () => {
  const fake = await startElevenLabsFake()
  const el = new ElevenLabsCallTts({ config: () => socketOpts(fake) })
  try {
    el.begin()
    const long =
      'Esta é uma frase bem comprida, que passa dos cento e vinte caracteres do primeiro limiar ' +
      'do chunk_length_schedule antes de'
    el.partial(long)
    await waitFor(() => el.socket?.liveCount === 1 && fake.connections[0]?.frames.length >= 2, 2000)
    // o fake gerou o 1º trecho com ≥ 120 chars (sem flush)
    await waitFor(() => (el.segmenter?.alignedUnits ?? 0) > 50, 2000, 'áudio antes do corte')
    assert.equal(fake.flushCount, 0)
    el.cut(`${long} terminar.`)
    el.end()
    const pcm = await collect(el.synth(`${long} terminar.`).chunks)
    // o fake gera o 1º trecho e o resto em separado (o espaço da emenda não vira áudio)
    assert.ok(Math.abs(pcm.length - pcmBytes(`${long} terminar.`)) <= 480, `${pcm.length}`)
    // sem partial/cut (ex.: frase retida que volta): synth abre o contexto com o texto inteiro
    const pcm2 = await collect(el.synth('Outra frase.').chunks)
    assert.equal(pcm2.length, pcmBytes('Outra frase.'))
    assert.equal(fake.connections.length, 1, 'um socket só para o turno')
    assert.deepEqual(fake.protocolErrors, [])
  } finally {
    el.close()
    await fake.close()
  }
})

test('WS → TtsStreamRelay: começo (pré-buffer) + pedaços em voice:call:utterance-chunk até o done', async () => {
  const fake = await startElevenLabsFake({ chunkSamples: 1200 })
  const el = new ElevenLabsCallTts({ config: () => socketOpts(fake) })
  const utts: VoiceCallUtteranceEvent[] = []
  const chunks: VoiceCallUtteranceChunkEvent[] = []
  const relay = new TtsStreamRelay({
    emitUtterance: (u) => utts.push(u),
    emitChunk: (c) => chunks.push(c)
  })
  try {
    const text = 'Uma resposta com tamanho suficiente para passar do pré-buffer de duzentos ms.'
    el.cut(text)
    el.end()
    const head = await relay.synth(new AbortController().signal, async (s) => el.synth(text, s))
    assert.equal(head.mime, 'audio/pcm;rate=24000')
    relay.emitUtterance({ id: 'u1', audio: head.audio, mime: head.mime })
    await waitFor(() => chunks.some((c) => c.done), 3000, 'done')
    assert.equal(utts[0].streaming, true)
    const total = head.audio.length + chunks.reduce((a, c) => a + c.pcm.length, 0)
    assert.equal(total, pcmBytes(text))
    assert.equal(chunks.at(-1)!.error, undefined)
  } finally {
    el.close()
    await fake.close()
  }
})

test('WS: barge-in (reset) derruba o socket que está gerando — nada mais chega; o próximo turno reconecta', async () => {
  const fake = await startElevenLabsFake({ chunkSamples: 480, chunkDelayMs: 15 })
  const el = new ElevenLabsCallTts({ config: () => socketOpts(fake) })
  const utts: VoiceCallUtteranceEvent[] = []
  const chunks: VoiceCallUtteranceChunkEvent[] = []
  const relay = new TtsStreamRelay({
    emitUtterance: (u) => utts.push(u),
    emitChunk: (c) => chunks.push(c),
    prebufferMs: 20
  })
  try {
    const text =
      'Uma resposta bem longa que vai ser interrompida pelo usuário no meio da fala dela.'
    el.begin()
    el.cut(text)
    const head = await relay.synth(new AbortController().signal, async (s) => el.synth(text, s))
    relay.emitUtterance({ id: 'u1', audio: head.audio, mime: head.mime })
    await waitFor(() => chunks.length >= 2, 2000)
    // barge-in: a chamada limpa a síntese (feed.reset) e o ipc aborta os streams do relay
    el.reset()
    relay.abortAll()
    const n = chunks.length
    assert.ok(chunks.at(-1)!.done, 'stream encerrado no renderer')
    await waitFor(() => fake.connections[0].closed, 2000, 'socket derrubado')
    await sleep(80)
    assert.equal(chunks.length, n, 'nenhum pedaço depois do barge-in')
    const received = head.audio.length + chunks.reduce((a, c) => a + c.pcm.length, 0)
    assert.ok(received < pcmBytes(text), 'o áudio pendente caiu fora')
    // próximo turno: reconecta
    el.begin()
    const pcm = await collect(el.synth('Certo.').chunks)
    assert.equal(pcm.length, pcmBytes('Certo.'))
    assert.equal(fake.connections.length, 2)
  } finally {
    el.close()
    await fake.close()
  }
})

test('WS: contexto ainda sem flush é descartado com close_context (sem derrubar o socket)', async () => {
  const fake = await startElevenLabsFake()
  const el = new ElevenLabsCallTts({ config: () => socketOpts(fake) })
  try {
    el.begin()
    el.partial('Ainda pensando no que dizer ')
    await waitFor(() => fake.connections[0]?.frames.length >= 2, 2000)
    el.reset()
    await waitFor(() => fake.connections[0].frames.some((f) => f.close_context === true), 2000)
    assert.equal(fake.connections[0].closed, false, 'socket continua aberto (nada gerando)')
    assert.equal(fake.flushCount, 0)
  } finally {
    el.close()
    await fake.close()
  }
})

test('WS: chave inválida → TtsError auth legível (sem a chave na mensagem)', async () => {
  const fake = await startElevenLabsFake()
  const el = new ElevenLabsCallTts({ config: () => socketOpts(fake, { apiKey: 'chave-errada' }) })
  try {
    await assert.rejects(collect(el.synth('Olá.').chunks), (e: unknown) => {
      assert.ok(e instanceof TtsError)
      assert.equal(e.kind, 'auth')
      assert.match(e.message, /chave da ElevenLabs/)
      assert.ok(!e.message.includes('chave-errada'))
      return true
    })
  } finally {
    el.close()
    await fake.close()
  }
})

test('WS: cota esgotada → TtsError quota; voz inexistente (handshake recusado) → diagnóstico REST "voz não encontrada"', async () => {
  const fake = await startElevenLabsFake({ mode: 'quota' })
  try {
    const el = new ElevenLabsCallTts({ config: () => socketOpts(fake) })
    await assert.rejects(
      collect(el.synth('Olá.').chunks),
      (e: unknown) => e instanceof TtsError && e.kind === 'quota'
    )
    el.close()
    fake.state.mode = 'rejectUpgrade'
    const el2 = new ElevenLabsCallTts({
      config: () => socketOpts(fake, { voiceId: 'naoexiste12345678901' })
    })
    await assert.rejects(
      collect(el2.synth('Olá.').chunks),
      (e: unknown) => e instanceof TtsError && /voz não encontrada/.test(e.message)
    )
    el2.close()
    fake.state.mode = 'ok'
    const el3 = new ElevenLabsCallTts({
      config: () => socketOpts(fake, { voiceId: 'naoexiste12345678901' })
    })
    await assert.rejects(
      collect(el3.synth('Olá.').chunks),
      (e: unknown) => e instanceof TtsError && /voz não encontrada/.test(e.message),
      'frame de erro voice_not_found do servidor'
    )
    el3.close()
  } finally {
    await fake.close()
  }
})

test('WS: socket fechado por ociosidade → a próxima fala reconecta sozinha', async () => {
  const fake = await startElevenLabsFake({ idleCloseMs: 60 })
  const el = new ElevenLabsCallTts({ config: () => socketOpts(fake) })
  try {
    el.begin()
    await waitFor(() => fake.connections[0]?.closed, 2000, 'fechou por ociosidade')
    const pcm = await collect(el.synth('Voltei.').chunks)
    assert.equal(pcm.length, pcmBytes('Voltei.'))
    assert.equal(fake.connections.length, 2)
  } finally {
    el.close()
    await fake.close()
  }
})

test('WS: queda no meio (antes do áudio) → reenvio do contexto num socket novo', async () => {
  const fake = await startElevenLabsFake({ dropOnFirstFlush: true })
  const el = new ElevenLabsCallTts({ config: () => socketOpts(fake) })
  try {
    el.partial('Uma frase que vai ')
    el.cut('Uma frase que vai cair e voltar.')
    el.end()
    const pcm = await collect(el.synth('Uma frase que vai cair e voltar.').chunks)
    assert.equal(pcm.length, pcmBytes('Uma frase que vai cair e voltar.'))
    assert.equal(fake.connections.length, 2)
    const replay = fake.connections[1].frames
    assert.equal(replay[0].text, ' ')
    assert.equal(replay[1].text, 'Uma frase que vai cair e voltar. ')
    assert.equal(replay[1].flush, true)
    assert.deepEqual(fake.protocolErrors, [])
  } finally {
    el.close()
    await fake.close()
  }
})

test('WS: no máximo 2 contextos gerando ao mesmo tempo (contextos avulsos esperam a vez, na ordem)', async () => {
  const fake = await startElevenLabsFake({ chunkDelayMs: 10 })
  const el = new ElevenLabsCallTts({ config: () => socketOpts(fake) })
  try {
    // sem cut (nova tentativa depois de falha): cada synth abre um contexto avulso
    const texts = ['Primeira frase.', 'Segunda frase.', 'Terceira frase.', 'Quarta frase.']
    const streams = texts.map((t) => el.synth(t))
    for (let i = 0; i < texts.length; i++)
      assert.equal((await collect(streams[i].chunks)).length, pcmBytes(texts[i]))
    assert.ok(fake.maxActive <= 2, `maxActive=${fake.maxActive}`)
    assert.deepEqual(fake.protocolErrors, [])
  } finally {
    el.close()
    await fake.close()
  }
})

test('WS: socket direto — tempo esgotado sem áudio vira TtsError timeout', async () => {
  const fake = await startElevenLabsFake({ firstAudioDelayMs: 500 })
  const sock = new ElevenLabsSocket(socketOpts(fake, { audioTimeoutMs: 80 }))
  try {
    const ctx = sock.context()
    ctx.finish('Demora.')
    await assert.rejects(
      collect(ctx.stream().chunks),
      (e: unknown) => e instanceof TtsError && e.kind === 'timeout'
    )
  } finally {
    sock.close()
    await fake.close()
  }
})

// ---------------- encaixe com a chamada (ganchos ttsFeed) ----------------

test('chamada: ttsFeed recebe begin → partial (sentença incompleta) → cut antes do synth → reset no barge-in → close no stop', async () => {
  const log: string[] = []
  const feed: TtsTextFeed = {
    begin: () => log.push('begin'),
    partial: (t) => log.push(`partial:${t}`),
    cut: (t) => log.push(`cut:${t}`),
    reset: () => log.push('reset'),
    close: () => log.push('close')
  }
  const listeners: ((e: AgentEvent) => void)[] = []
  const synthCalls: string[] = []
  const m = new VoiceCallManager({
    sendTurn: () => {},
    synth: async (text) => {
      synthCalls.push(text)
      log.push(`synth:${text}`)
      return { audio: new TextEncoder().encode(text), mime: 'audio/wav' }
    },
    emitState: () => {},
    emitUtterance: () => {},
    emitUtteranceCancel: () => {},
    emitTimeline: () => {},
    logEval: () => {},
    clip: async () => null,
    sessionInfo: () => ({ chatId: 'c1', depth: 0, busy: false }),
    chatConfig: () => ({}) as ChatConfig,
    settings: () => ({
      defaults: { ...DEFAULT_VOICE_CALL_DEFAULTS, fillers: { enabled: false, prompt: null } },
      audioInput: DEFAULT_AUDIO_INPUT,
      stt: DEFAULT_STT_SETTINGS,
      tts: DEFAULT_TTS_SETTINGS
    }),
    onEvent: (cb) => {
      listeners.push(cb)
      return () => {}
    },
    ttsFeed: () => feed
  })
  const emit = (e: AgentEvent): void => listeners.forEach((l) => l(e))
  m.start('s1')
  assert.deepEqual(log, ['begin'], 'início da chamada pré-abre')
  emit({
    type: 'message-added',
    message: { id: 'm1', sessionId: 's1', message: { role: 'user', content: 'oi' } }
  } as unknown as AgentEvent)
  emit({ type: 'draft', sessionId: 's1', draft: { content: 'Olá, tudo' } } as unknown as AgentEvent)
  emit({
    type: 'draft',
    sessionId: 's1',
    draft: { content: 'Olá, tudo bem? Eu es' }
  } as unknown as AgentEvent)
  await waitFor(() => synthCalls.length === 1)
  assert.deepEqual(log, [
    'begin',
    'begin',
    'partial:Olá, tudo',
    'cut:Olá, tudo bem?',
    'synth:Olá, tudo bem?',
    'partial:Eu es'
  ])
  log.length = 0
  m.bargeIn({ playedIds: [] })
  assert.ok(log.includes('reset'), 'barge-in limpa o preparado')
  log.length = 0
  m.stop()
  assert.ok(log.includes('close'), 'stop fecha a conexão')
})

test('chamada: sem ttsFeed (outros backends) nada muda; feed que lança não derruba a chamada', async () => {
  const listeners: ((e: AgentEvent) => void)[] = []
  const synthCalls: string[] = []
  const m = new VoiceCallManager({
    sendTurn: () => {},
    synth: async (text) => {
      synthCalls.push(text)
      return { audio: new Uint8Array([1]), mime: 'audio/wav' }
    },
    emitState: () => {},
    emitUtterance: () => {},
    emitUtteranceCancel: () => {},
    emitTimeline: () => {},
    logEval: () => {},
    clip: async () => null,
    sessionInfo: () => ({ chatId: 'c1', depth: 0, busy: false }),
    chatConfig: () => ({}) as ChatConfig,
    settings: () => ({
      defaults: { ...DEFAULT_VOICE_CALL_DEFAULTS, fillers: { enabled: false, prompt: null } },
      audioInput: DEFAULT_AUDIO_INPUT,
      stt: DEFAULT_STT_SETTINGS,
      tts: DEFAULT_TTS_SETTINGS
    }),
    onEvent: (cb) => {
      listeners.push(cb)
      return () => {}
    },
    ttsFeed: () => {
      throw new Error('feed quebrado')
    }
  })
  const warn = console.warn
  console.warn = () => {}
  try {
    m.start('s1')
    listeners.forEach((l) =>
      l({
        type: 'message-added',
        message: { id: 'm1', sessionId: 's1', message: { role: 'user', content: 'oi' } }
      } as unknown as AgentEvent)
    )
    listeners.forEach((l) =>
      l({
        type: 'draft',
        sessionId: 's1',
        draft: { content: 'Tudo certo. Pode' }
      } as unknown as AgentEvent)
    )
    await waitFor(() => synthCalls.length === 1)
    assert.deepEqual(synthCalls, ['Tudo certo.'])
    m.stop()
  } finally {
    console.warn = warn
  }
})

// ---------------- ponta a ponta: chamada + relay + WebSocket fake ----------------

test('ponta a ponta: deltas do LLM → socket (palavra a palavra) → PCM no relay, uma utterance por sentença', async () => {
  const fake = await startElevenLabsFake({ chunkSamples: 1200 })
  const el = new ElevenLabsCallTts({ config: () => socketOpts(fake) })
  const utts: VoiceCallUtteranceEvent[] = []
  const chunks: VoiceCallUtteranceChunkEvent[] = []
  const relay = new TtsStreamRelay({
    emitUtterance: (u) => utts.push(u),
    emitChunk: (c) => chunks.push(c),
    prebufferMs: 50
  })
  const listeners: ((e: AgentEvent) => void)[] = []
  const timeline: VoiceCallTimelineEvent[] = []
  const m = new VoiceCallManager({
    sendTurn: () => {},
    synth: (text, signal) => relay.synth(signal, async (s) => el.synth(text, s)),
    emitState: () => {},
    emitUtterance: (u) => relay.emitUtterance(u),
    emitUtteranceCancel: () => {},
    emitTimeline: (e) => timeline.push(e),
    logEval: () => {},
    clip: async () => null,
    sessionInfo: () => ({ chatId: 'c1', depth: 0, busy: false }),
    chatConfig: () => ({}) as ChatConfig,
    settings: () => ({
      defaults: { ...DEFAULT_VOICE_CALL_DEFAULTS, fillers: { enabled: false, prompt: null } },
      audioInput: DEFAULT_AUDIO_INPUT,
      stt: DEFAULT_STT_SETTINGS,
      tts: ttsSettings(fake.url)
    }),
    onEvent: (cb) => {
      listeners.push(cb)
      return () => {}
    },
    ttsFeed: () => el
  })
  const emit = (e: AgentEvent): void => listeners.forEach((l) => l(e))
  try {
    m.start('s1')
    emit({
      type: 'message-added',
      message: { id: 'm1', sessionId: 's1', message: { role: 'user', content: 'me conta' } }
    } as unknown as AgentEvent)
    const answer =
      'Claro, posso te contar uma coisa interessante. O céu é azul por causa do espalhamento da luz.'
    let acc = ''
    for (const w of answer.split(/(?<= )/)) {
      acc += w
      emit({ type: 'draft', sessionId: 's1', draft: { content: acc } } as unknown as AgentEvent)
      await sleep(2)
    }
    emit({
      type: 'message-added',
      message: { id: 'm2', sessionId: 's1', message: { role: 'assistant', content: answer } }
    } as unknown as AgentEvent)
    // o turno do agente terminou: o contexto da resposta fecha (a última frase termina)
    emit({
      type: 'session-updated',
      session: { id: 's1', status: 'idle' }
    } as unknown as AgentEvent)
    await waitFor(
      () =>
        utts.length >= 2 &&
        chunks.filter((c) => c.done).length >= utts.filter((u) => u.streaming).length,
      4000,
      'utterances'
    )
    await sleep(50)
    const sentences = timeline.filter((e) => e.kind === 'sentence-emitted').map((e) => e.text ?? '')
    assert.equal(utts.length, sentences.length, 'uma utterance por sentença')
    assert.equal(sentences.join(' '), answer)
    const bytesFor = (id: string, head: Uint8Array, mime: string): number =>
      (mime.startsWith('audio/wav') ? head.length - 44 : head.length) +
      chunks.filter((c) => c.id === id).reduce((a, c) => a + c.pcm.length, 0)
    const total = utts.reduce((a, u) => a + bytesFor(u.id, u.audio, u.mime), 0)
    assert.equal(
      total,
      sentences.reduce((a, t) => a + pcmBytes(t), 0),
      'todo o PCM de cada sentença'
    )
    const textFrames = fake.connections
      .flatMap((c) => c.frames)
      .filter((f) => typeof f.text === 'string' && f.text !== ' ')
    assert.ok(textFrames.length > sentences.length + 1, 'texto entrou aos pedaços (antes do corte)')
    assert.equal(fake.connections.length, 1)
    // UM contexto para a resposta inteira (prosódia contínua), um flush por sentença
    const ctxIds = new Set(fake.connections[0].frames.map((f) => f.context_id).filter(Boolean))
    assert.equal(ctxIds.size, 1, `contextos: ${[...ctxIds].join(',')}`)
    assert.equal(fake.flushCount, sentences.length)
    // a 1ª frase NÃO cortou na vírgula ("Claro, posso…" ficou inteira)
    assert.match(sentences[0], /^Claro, posso te contar uma coisa interessante\.$/)
    assert.deepEqual(fake.protocolErrors, [])
    m.stop()
  } finally {
    el.close()
    await fake.close()
  }
})

test('chamada: créditos da ElevenLabs acabam NO MEIO da sentença (frame quota_exceeded) → a chamada encerra com o motivo, sem stream/socket pendurado', async () => {
  const { classifyVoiceError } = await import('../src/main/voice/callErrors.ts')
  const fake = await startElevenLabsFake({ mode: 'quotaMid' })
  const listeners: ((e: AgentEvent) => void)[] = []
  const states: { active: boolean; error: string | null }[] = []
  const el = new ElevenLabsCallTts({ config: () => socketOpts(fake) })
  let m: VoiceCallManager | null = null
  const relay = new TtsStreamRelay({
    emitUtterance: () => {},
    emitChunk: () => {},
    onStreamError: (e) => void m?.voiceApiError('tts', e)
  })
  let ended = 0
  m = new VoiceCallManager({
    sendTurn: () => {},
    synth: (text, signal) => relay.synth(signal, async (s) => el.synth(text, s)),
    emitState: (s) => states.push({ active: s.active, error: s.error }),
    emitUtterance: (u) => relay.emitUtterance(u),
    emitUtteranceCancel: () => {},
    emitTimeline: () => {},
    logEval: () => {},
    clip: async () => null,
    sessionInfo: () => ({ chatId: 'c1', depth: 0, busy: false }),
    chatConfig: () => ({}) as ChatConfig,
    settings: () => ({
      defaults: { ...DEFAULT_VOICE_CALL_DEFAULTS, fillers: { enabled: false, prompt: null } },
      audioInput: DEFAULT_AUDIO_INPUT,
      stt: DEFAULT_STT_SETTINGS,
      tts: DEFAULT_TTS_SETTINGS
    }),
    onEvent: (cb) => {
      listeners.push(cb)
      return () => {}
    },
    ttsFeed: () => el,
    classifyError: (e, source) => classifyVoiceError(e, source, 'ElevenLabs'),
    onCallEnded: () => {
      ended++
      relay.abortAll()
    }
  })
  try {
    const emit = (e: AgentEvent): void => listeners.forEach((l) => l(e))
    m.start('s1')
    emit({
      type: 'message-added',
      message: { id: 'm1', sessionId: 's1', message: { role: 'user', content: 'oi' } }
    } as unknown as AgentEvent)
    emit({
      type: 'message-added',
      message: {
        id: 'a1',
        sessionId: 's1',
        message: { role: 'assistant', content: 'Olá, tudo bem por aí com você hoje?' },
        meta: {}
      }
    } as unknown as AgentEvent)
    await waitFor(() => !m!.state().active, 5000)
    assert.match(m.state().error ?? '', /créditos da ElevenLabs esgotados/)
    assert.equal(ended, 1, 'o fim da chamada derruba os streams')
    assert.equal(relay.liveCount, 0, 'nenhum stream de TTS pendurado')
    assert.ok(
      states.some((s) => !s.active && /créditos/.test(s.error ?? '')),
      'o estado inativo com o motivo foi emitido ao renderer'
    )
  } finally {
    el.close()
    await fake.close()
  }
})
