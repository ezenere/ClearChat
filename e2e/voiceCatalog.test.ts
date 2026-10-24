// Descoberta de modelos/vozes de STT/TTS (Configurações → Áudio): parsers puros
// (`src/shared/voiceCatalog.ts` — OpenRouter `/models?output_modalities=…`, ElevenLabs `/v1/models`
// + `/v1/voices`, OpenAI-compatível `/models`), correção de apelidos, `listVoiceCatalog` com fetch
// mockado (só provedores cadastrados; URLs/headers por família, cache de 10 min, erros legíveis,
// chave nunca na visão) e prévias só de URLs conhecidas. Rodar: npm run test:unit
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CALL_TTS_EXCLUDED_OPENROUTER,
  CALL_TTS_MODELS_ELEVENLABS,
  CALL_TTS_MODELS_OPENROUTER,
  CALL_TTS_RECOMMENDED,
  callTtsWarning,
  curateVoiceModels,
  describeVoice,
  formatLatency,
  isCallTtsModel,
  orderVoicesForPt,
  parseElevenLabsModels,
  parseElevenLabsVoices,
  parseOpenAiAudioModels,
  parseOpenRouterAudioModels,
  providerSupportsVoice,
  resolveModelAlias,
  voiceProviderSupport,
  VOICE_CATALOG_CACHE_MS
} from '../src/shared/voiceCatalog.ts'
import {
  fetchVoicePreview,
  listVoiceCatalog,
  resetVoiceCatalogCache,
  type VoiceCatalogDeps,
  type VoiceCatalogProvider
} from '../src/main/voice/voiceCatalog.ts'

// ---------------- dados (recortes reais, 2026-10-23) ----------------

const ELEVEN = ['george', 'sarah', 'adam', 'alice', 'bella']
const OR_SPEECH = {
  data: [
    {
      id: 'elevenlabs/eleven-flash-v2.5',
      name: 'ElevenLabs: Eleven Flash v2.5',
      description: 'Ultra-low latency. Second sentence here.',
      architecture: { modality: 'text->speech', output_modalities: ['speech'] },
      pricing: { prompt: '0.00004', completion: '0' },
      supported_voices: ELEVEN
    },
    {
      id: 'microsoft/mai-voice-2',
      name: 'Microsoft AI: MAI-Voice-2',
      architecture: { output_modalities: ['speech'] },
      pricing: { prompt: '0.000022', completion: '0' },
      supported_voices: ['en-US-Harper:MAI-Voice-2', 'es-MX-Valeria:MAI-Voice-2']
    },
    {
      id: 'fish-audio/s1',
      name: 'Fish Audio: S1',
      architecture: { output_modalities: ['speech'] },
      pricing: { prompt: '0.000015', completion: '0' },
      supported_voices: []
    },
    // modelo de texto que vazasse na lista é filtrado pela modalidade
    { id: 'openai/gpt-5', name: 'GPT-5', architecture: { output_modalities: ['text'] } }
  ]
}
const OR_TRANSCRIPTION = {
  data: [
    {
      id: 'openai/whisper-large-v3-turbo',
      name: 'OpenAI: Whisper Large V3 Turbo',
      architecture: { output_modalities: ['transcription'] },
      pricing: { prompt: '0.00000333', completion: '0' },
      supported_voices: []
    },
    {
      id: 'elevenlabs/scribe-v2',
      name: 'ElevenLabs: Scribe v2',
      architecture: { output_modalities: ['transcription'] },
      pricing: { prompt: '0.0000611111111111', completion: '0' }
    }
  ]
}
const EL_MODELS = [
  {
    model_id: 'eleven_flash_v2_5',
    name: 'Eleven Flash v2.5',
    description: 'Our ultra low latency model.',
    can_do_text_to_speech: true,
    languages: [
      { language_id: 'pt', name: 'Portuguese' },
      { language_id: 'en', name: 'English' }
    ]
  },
  { model_id: 'eleven_english_sts_v2', name: 'STS', can_do_text_to_speech: false }
]
const EL_VOICES = {
  voices: [
    {
      voice_id: 'EXAVITQu4vr4xnSDxMaL',
      name: 'Sarah - Mature, Reassuring',
      labels: { gender: 'female', accent: 'american' },
      preview_url: 'https://storage.googleapis.com/x/sarah.mp3',
      verified_languages: [
        { language: 'en', locale: 'en-US' },
        {
          language: 'pt',
          locale: 'pt-BR',
          preview_url: 'https://storage.googleapis.com/x/sarah-pt.mp3'
        }
      ]
    },
    {
      voice_id: 'JBFqnCBsd6RMkjVDRZzb',
      name: 'George',
      labels: { gender: 'male', accent: 'british' },
      preview_url: 'http://inseguro/george.mp3'
    }
  ]
}

// ---------------- família do provedor ----------------

test('voiceProviderSupport: OpenRouter, ElevenLabs (kind ou host), genérico e Anthropic sem áudio', () => {
  assert.equal(voiceProviderSupport({ baseUrl: 'https://openrouter.ai/api/v1' }), 'openrouter')
  assert.equal(
    voiceProviderSupport({ baseUrl: 'https://api.elevenlabs.io', kind: 'elevenlabs' }),
    'elevenlabs'
  )
  assert.equal(voiceProviderSupport({ baseUrl: 'https://api.elevenlabs.io/v1' }), 'elevenlabs')
  assert.equal(voiceProviderSupport({ baseUrl: 'https://api.groq.com/openai/v1' }), 'openai')
  assert.equal(voiceProviderSupport({ baseUrl: 'https://api.anthropic.com/v1' }), null)
  // ElevenLabs direto: só fala (o STT é OpenAI-compatível)
  assert.equal(providerSupportsVoice({ baseUrl: 'https://api.elevenlabs.io' }, 'tts'), true)
  assert.equal(providerSupportsVoice({ baseUrl: 'https://api.elevenlabs.io' }, 'stt'), false)
  assert.equal(providerSupportsVoice({ baseUrl: 'https://api.anthropic.com/v1' }, 'tts'), false)
})

// ---------------- parsers ----------------

test('OpenRouter (speech): modelos de fala com vozes por modelo, preço por caractere e filtro de modalidade', () => {
  const { models, voices } = parseOpenRouterAudioModels(OR_SPEECH, 'tts')
  assert.deepEqual(
    models.map((m) => m.id),
    ['elevenlabs/eleven-flash-v2.5', 'fish-audio/s1', 'microsoft/mai-voice-2']
  )
  const flash = models.find((m) => m.id === 'elevenlabs/eleven-flash-v2.5')!
  assert.deepEqual(flash.voiceIds, ELEVEN)
  assert.equal(flash.priceHint, 'US$ 40 / 1M caracteres')
  assert.equal(flash.description, 'Ultra-low latency.')
  const sarah = voices.find((v) => v.id === 'sarah')!
  assert.deepEqual(
    { gender: sarah.gender, accent: sarah.accent, label: sarah.label },
    { gender: 'female', accent: 'americano', label: 'Sarah' }
  )
  const harper = voices.find((v) => v.id === 'en-US-Harper:MAI-Voice-2')!
  assert.deepEqual(
    { label: harper.label, language: harper.language },
    { label: 'Harper', language: 'en-US' }
  )
})

test('OpenRouter (transcription): modelos de STT sem vozes e preço por minuto', () => {
  const { models, voices } = parseOpenRouterAudioModels(OR_TRANSCRIPTION, 'stt')
  assert.deepEqual(
    models.map((m) => m.id),
    ['elevenlabs/scribe-v2', 'openai/whisper-large-v3-turbo']
  )
  assert.equal(voices.length, 0)
  assert.equal(
    models.find((m) => m.id === 'openai/whisper-large-v3-turbo')!.priceHint,
    'US$ 0.0002 / min'
  )
  assert.equal(models[0].voiceIds, undefined)
  assert.throws(() => parseOpenRouterAudioModels({ nope: 1 }, 'stt'), /Formato inesperado/)
})

test('ElevenLabs: /v1/models só os de TTS; /v1/voices com rótulo curto, gênero, sotaque e prévia pt (https)', () => {
  const models = parseElevenLabsModels(EL_MODELS)
  assert.deepEqual(
    models.map((m) => [m.id, m.label, m.priceHint]),
    [['eleven_flash_v2_5', 'Eleven Flash v2.5', '2 idiomas']]
  )
  const voices = parseElevenLabsVoices(EL_VOICES)
  assert.deepEqual(voices[1], {
    id: 'EXAVITQu4vr4xnSDxMaL',
    label: 'Sarah',
    language: 'pt-BR',
    gender: 'female',
    accent: 'american',
    previewUrl: 'https://storage.googleapis.com/x/sarah-pt.mp3'
  })
  // prévia http (não https) é descartada
  assert.equal(voices[0].label, 'George')
  assert.equal(voices[0].previewUrl, null)
})

test('OpenAI-compatível: heurística whisper/transcribe (STT) e tts/speech (TTS) no /models', () => {
  const j = {
    data: [
      { id: 'whisper-large-v3-turbo' },
      { id: 'llama-3.3-70b-versatile' },
      { id: 'distil-whisper-large-v3-en' },
      { id: 'playai-tts' },
      { id: 'gpt-4o-mini-tts' },
      { id: 'gpt-4o-transcribe' }
    ]
  }
  assert.deepEqual(
    parseOpenAiAudioModels(j, 'stt').models.map((m) => m.id),
    ['distil-whisper-large-v3-en', 'gpt-4o-transcribe', 'whisper-large-v3-turbo']
  )
  const t = parseOpenAiAudioModels(j, 'tts')
  assert.deepEqual(
    t.models.map((m) => m.id),
    ['gpt-4o-mini-tts', 'playai-tts']
  )
  assert.equal(t.total, 6)
})

test('describeVoice: Deepgram, Kokoro e id sem padrão', () => {
  assert.deepEqual(describeVoice('aura-2-thalia-en'), {
    id: 'aura-2-thalia-en',
    label: 'Thalia',
    language: 'en'
  })
  assert.deepEqual(describeVoice('pf_dora', 'hexgrad/kokoro-82m'), {
    id: 'pf_dora',
    label: 'Dora',
    language: 'pt-BR',
    gender: 'female'
  })
  assert.equal(describeVoice('voice_3150').label, 'Voice 3150')
  // nome do ElevenLabs num modelo que não é do ElevenLabs não ganha os metadados dele
  assert.equal(describeVoice('george', 'google/gemini-tts').gender, undefined)
})

// ---------------- apelidos ----------------

test('resolveModelAlias: id sem prefixo do OpenRouter, _/. trocados e ambiguidade', () => {
  const or = ['openai/whisper-large-v3-turbo', 'openai/whisper-large-v3', 'elevenlabs/scribe-v2']
  assert.deepEqual(resolveModelAlias('whisper-large-v3-turbo', or), {
    id: 'openai/whisper-large-v3-turbo',
    corrected: true
  })
  assert.deepEqual(resolveModelAlias('openai/whisper-large-v3', or), {
    id: 'openai/whisper-large-v3',
    corrected: false
  })
  assert.deepEqual(resolveModelAlias('scribe_v2', or), {
    id: 'elevenlabs/scribe-v2',
    corrected: true
  })
  assert.equal(resolveModelAlias('nova-3', or), null)
  // ElevenLabs direto: o id do OpenRouter vira o model_id dele
  assert.deepEqual(resolveModelAlias('elevenlabs/eleven-flash-v2.5', ['eleven_flash_v2_5']), {
    id: 'eleven_flash_v2_5',
    corrected: true
  })
  // dois candidatos → sem correção automática
  assert.equal(resolveModelAlias('whisper', ['a/whisper', 'b/whisper']), null)
})

// ---------------- curadoria da chamada (TTS remoto) ----------------

const orModel = (
  id: string,
  voiceIds: string[] = []
): { id: string; label: string; voiceIds: string[] } => ({
  id,
  label: id,
  voiceIds
})

test('curadoria: a lista medida é coerente (≤ ~0,9 s, recomendados aprovados, sem sobreposição)', () => {
  for (const [id, c] of Object.entries(CALL_TTS_MODELS_OPENROUTER)) {
    assert.ok(c.firstAudioMs <= 900, `${id}: ${c.firstAudioMs} ms`)
    assert.ok(!(id in CALL_TTS_EXCLUDED_OPENROUTER), `${id} aprovado e reprovado`)
  }
  for (const c of Object.values(CALL_TTS_MODELS_ELEVENLABS)) assert.ok(c.firstAudioMs <= 900)
  assert.ok(CALL_TTS_RECOMMENDED.openrouter.model in CALL_TTS_MODELS_OPENROUTER)
  assert.ok(CALL_TTS_RECOMMENDED.elevenlabs.model in CALL_TTS_MODELS_ELEVENLABS)
  // os lentos medidos ficaram de fora
  for (const id of [
    'elevenlabs/eleven-v4-turbo',
    'elevenlabs/eleven-multilingual-v2',
    'google/gemini-3.8-flash-tts'
  ])
    assert.equal(isCallTtsModel('openrouter', id), false, id)
  assert.equal(isCallTtsModel('elevenlabs', 'eleven_multilingual_v2'), false)
  assert.equal(isCallTtsModel('elevenlabs', 'eleven_turbo_v2_5'), true)
  // família não curada (servidor próprio OpenAI-compatível): tudo vale
  assert.equal(isCallTtsModel('openai', 'qualquer-tts'), true)
})

test('curateVoiceModels (OpenRouter TTS): só os aprovados que o provedor listou; o resto (e o novo desconhecido) vai para hidden; recomendado 1º, depois por latência', () => {
  const listed = [
    orModel('google/gemini-3.8-flash-tts', ['Kore']),
    orModel('microsoft/mai-voice-2.1-flash', ['pt-BR-Luana:MAI-Voice-2.1-Flash']),
    orModel('fish-audio/s1'),
    orModel('elevenlabs/eleven-v4-turbo', ['sarah']),
    orModel('acme/tts-novo-2027', ['x']),
    orModel('elevenlabs/eleven-flash-v2.5', ['sarah', 'george'])
  ]
  const r = curateVoiceModels(listed, 'tts', 'openrouter')
  assert.equal(r.curated, true)
  assert.deepEqual(
    r.models.map((m) => m.id),
    ['elevenlabs/eleven-flash-v2.5', 'fish-audio/s1', 'microsoft/mai-voice-2.1-flash']
  )
  assert.equal(r.models[0].latencyMs, 479)
  assert.deepEqual(r.models[0].ptVoices, ['sarah'])
  assert.deepEqual(r.models[0].voiceIds, ['sarah', 'george'])
  assert.deepEqual(
    r.hidden.map((m) => [m.id, m.slow, m.latencyMs]),
    [
      ['google/gemini-3.8-flash-tts', true, 2457],
      ['elevenlabs/eleven-v4-turbo', true, 1013],
      ['acme/tts-novo-2027', true, null]
    ]
  )
  // aprovado que o provedor NÃO listou não é inventado
  assert.ok(!r.models.some((m) => m.id === 'x-ai/grok-voice-tts-1.0'))
})

test('curateVoiceModels (ElevenLabs direto): Flash/Turbo v2.5 e v4 Turbo sempre (mesmo sem listagem); Multilingual escondido com a medição do OpenRouter', () => {
  const none = curateVoiceModels([], 'tts', 'elevenlabs')
  assert.deepEqual(
    none.models.map((m) => [m.id, m.label, m.latencyMs]),
    [
      ['eleven_flash_v2_5', 'Eleven Flash v2.5', 279],
      ['eleven_v4_turbo', 'Eleven v4 Turbo', 287],
      ['eleven_turbo_v2_5', 'Eleven Turbo v2.5', 311]
    ]
  )
  const r = curateVoiceModels(
    parseElevenLabsModels([
      ...EL_MODELS,
      { model_id: 'eleven_multilingual_v2', name: 'Multilingual v2' }
    ]),
    'tts',
    'elevenlabs'
  )
  assert.deepEqual(
    r.models.map((m) => m.id),
    ['eleven_flash_v2_5', 'eleven_v4_turbo', 'eleven_turbo_v2_5']
  )
  assert.equal(r.models[0].description, 'Our ultra low latency model.')
  assert.deepEqual(
    r.hidden.map((m) => [m.id, m.latencyMs]),
    [['eleven_multilingual_v2', 1079]]
  )
})

test('curateVoiceModels: STT marca os lentos sem esconder nada; OpenAI-compatível sem curadoria', () => {
  const stt = curateVoiceModels(
    [orModel('openai/whisper-large-v3-turbo'), orModel('google/gemini-3.5-transcribe')],
    'stt',
    'openrouter'
  )
  assert.equal(stt.curated, false)
  assert.deepEqual(
    stt.models.map((m) => [m.id, m.slow ?? false, m.latencyMs ?? null]),
    [
      ['openai/whisper-large-v3-turbo', false, null],
      ['google/gemini-3.5-transcribe', true, 2300]
    ]
  )
  assert.equal(stt.hidden.length, 0)
  const gen = curateVoiceModels([orModel('tts-1'), orModel('kokoro')], 'tts', 'openai')
  assert.equal(gen.curated, false)
  assert.deepEqual(
    gen.models.map((m) => m.id),
    ['tts-1', 'kokoro']
  )
})

test('callTtsWarning: modelo salvo escondido → aviso por motivo (com a latência medida); aprovado/genérico → nada', () => {
  assert.equal(callTtsWarning('openrouter', 'elevenlabs/eleven-flash-v2.5'), null)
  assert.equal(callTtsWarning('openai', 'tts-1'), null)
  assert.equal(callTtsWarning('openrouter', ''), null)
  assert.equal(
    callTtsWarning('openrouter', 'elevenlabs/eleven-v4-turbo'),
    'Modelo lento para chamada (medido: ~1,0 s até o 1º áudio) — escolha um da lista.'
  )
  assert.match(callTtsWarning('openrouter', 'elevenlabs/eleven-turbo-v2') ?? '', /sem pt-BR/)
  assert.match(callTtsWarning('openrouter', 'minimax/speech-2.8-turbo') ?? '', /pcm/)
  assert.match(callTtsWarning('openrouter', 'fish-audio/s2.1-pro-free:free') ?? '', /garantia/)
  assert.equal(
    callTtsWarning('openrouter', 'acme/tts-novo-2027'),
    'Modelo lento para chamada — escolha um da lista.'
  )
  assert.match(callTtsWarning('elevenlabs', 'eleven_multilingual_v2') ?? '', /lento.*~1,1 s/)
  assert.equal(formatLatency(474), '~0,5 s')
  assert.equal(formatLatency(2300), '~2,3 s')
})

test('orderVoicesForPt: recomendadas do modelo primeiro (marcadas), depois pt-BR, pt, multilíngue e o resto', () => {
  const vs = [
    describeVoice('en-US-Harper:MAI-Voice-2.1-Flash'),
    describeVoice('pt-PT-Rui:MAI-Voice-2.1-Flash'),
    describeVoice('george', 'elevenlabs/x'),
    describeVoice('pt-BR-Caio:MAI-Voice-2.1-Flash'),
    describeVoice('pt-BR-Luana:MAI-Voice-2.1-Flash'),
    describeVoice('es-MX-Valeria:MAI-Voice-2.1-Flash')
  ]
  const out = orderVoicesForPt(vs, ['pt-BR-Luana:MAI-Voice-2.1-Flash', 'nao-listada'])
  assert.deepEqual(
    out.map((v) => v.label),
    ['Luana', 'Caio', 'Rui', 'George', 'Harper', 'Valeria']
  )
  assert.equal(out[0].recommended, true)
  assert.equal(out[1].recommended, undefined)
  // sem recomendadas: só a ordem por idioma; a entrada não é mutada
  assert.deepEqual(
    orderVoicesForPt(vs).map((v) => v.label),
    ['Caio', 'Luana', 'Rui', 'George', 'Harper', 'Valeria']
  )
  assert.equal(vs[4].recommended, undefined)
})

// ---------------- listVoiceCatalog (fetch mockado) ----------------

type Call = { url: string; headers: Record<string, string> }
function mockFetch(routes: (url: string) => { status?: number; body: unknown } | Error): {
  fetch: typeof fetch
  calls: Call[]
} {
  const calls: Call[] = []
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, headers: { ...((init?.headers as Record<string, string>) ?? {}) } })
    const r = routes(url)
    if (r instanceof Error) throw r
    return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: { 'content-type': 'application/json' }
    })
  }) as typeof fetch
  return { fetch: f, calls }
}

const PROVIDERS: Record<string, VoiceCatalogProvider> = {
  or: {
    id: 'or',
    kind: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey: 'sk-or-SECRET-1'
  },
  el: { id: 'el', kind: 'elevenlabs', baseUrl: 'https://api.elevenlabs.io', apiKey: 'xi-SECRET-2' },
  el1: {
    id: 'el1',
    kind: 'elevenlabs',
    baseUrl: 'https://api.elevenlabs.io/v1/',
    apiKey: 'xi-SECRET-2'
  },
  gq: {
    id: 'gq',
    kind: 'openai',
    baseUrl: 'https://api.groq.com/openai/v1',
    apiKey: 'gsk-SECRET-3'
  },
  an: {
    id: 'an',
    kind: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    apiKey: 'sk-ant-SECRET-4'
  },
  nokey: { id: 'nokey', kind: 'elevenlabs', baseUrl: 'https://api.elevenlabs.io', apiKey: '' },
  // servidor local OpenAI-compatível cadastrado em Provedores (localhost, sem chave)
  loc: { id: 'loc', kind: 'openai', baseUrl: 'http://localhost:9000/v1', apiKey: '' },
  ftp: { id: 'ftp', kind: 'openai', baseUrl: 'ftp://x/v1', apiKey: 'k' }
}
const deps = (f: typeof fetch, now = () => 1_000_000): VoiceCatalogDeps => ({
  provider: (id) => PROVIDERS[id] ?? null,
  fetch: f,
  now
})
const noSecrets = (v: unknown): void =>
  assert.ok(!/SECRET/.test(JSON.stringify(v)), 'chave na visão')

test('listVoiceCatalog (OpenRouter): GET /models?output_modalities=speech|transcription, sem chave na visão', async () => {
  resetVoiceCatalogCache()
  const m = mockFetch((url) =>
    url.includes('output_modalities=speech') ? { body: OR_SPEECH } : { body: OR_TRANSCRIPTION }
  )
  const tts = await listVoiceCatalog({ capability: 'tts', providerId: 'or' }, deps(m.fetch))
  assert.equal(m.calls[0].url, 'https://openrouter.ai/api/v1/models?output_modalities=speech')
  assert.equal(tts.source, 'openrouter')
  assert.equal(tts.error, null)
  assert.ok(tts.models.some((x) => x.id === 'elevenlabs/eleven-flash-v2.5'))
  assert.ok(tts.voices.some((x) => x.id === 'sarah'))
  // curadoria: MAI-Voice-2 (lento) escondido, Fish S1 aprovado; STT não é curado
  assert.equal(tts.curated, true)
  assert.deepEqual(
    tts.models.map((x) => x.id),
    ['elevenlabs/eleven-flash-v2.5', 'fish-audio/s1']
  )
  assert.deepEqual(
    tts.hiddenModels?.map((x) => x.id),
    ['microsoft/mai-voice-2']
  )
  noSecrets(tts)
  const stt = await listVoiceCatalog({ capability: 'stt', providerId: 'or' }, deps(m.fetch))
  assert.equal(
    m.calls[1].url,
    'https://openrouter.ai/api/v1/models?output_modalities=transcription'
  )
  assert.deepEqual(
    stt.models.map((x) => x.id),
    ['elevenlabs/scribe-v2', 'openai/whisper-large-v3-turbo']
  )
  assert.equal(stt.curated, undefined)
})

test('listVoiceCatalog: cache de 10 min por provedor; refresh e expiração refazem; falha não fica em cache', async () => {
  resetVoiceCatalogCache()
  let t = 5_000_000
  const m = mockFetch(() => ({ body: OR_SPEECH }))
  const d = deps(m.fetch, () => t)
  await listVoiceCatalog({ capability: 'tts', providerId: 'or' }, d)
  await listVoiceCatalog({ capability: 'tts', providerId: 'or' }, d)
  assert.equal(m.calls.length, 1)
  await listVoiceCatalog({ capability: 'tts', providerId: 'or', refresh: true }, d)
  assert.equal(m.calls.length, 2)
  t += VOICE_CATALOG_CACHE_MS + 1
  await listVoiceCatalog({ capability: 'tts', providerId: 'or' }, d)
  assert.equal(m.calls.length, 3)
  // falha → lista embutida + erro legível; a próxima tenta de novo
  resetVoiceCatalogCache()
  const bad = mockFetch(() => new Error('getaddrinfo ENOTFOUND openrouter.ai'))
  const v = await listVoiceCatalog({ capability: 'tts', providerId: 'or' }, deps(bad.fetch))
  assert.equal(v.source, 'static')
  assert.match(v.error ?? '', /falha de rede ao listar/)
  // lista embutida = a curada (sem os lentos), com as vozes pt-BR dos outros modelos
  assert.deepEqual(v.models.map((x) => x.id).sort(), Object.keys(CALL_TTS_MODELS_OPENROUTER).sort())
  assert.ok(v.voices.some((x) => x.id === 'sarah'))
  assert.ok(v.voices.some((x) => x.id === 'pf_dora' && x.language === 'pt-BR'))
  await listVoiceCatalog({ capability: 'tts', providerId: 'or' }, deps(bad.fetch))
  assert.equal(bad.calls.length, 2)
})

test('listVoiceCatalog (ElevenLabs direto): /v1/models + /v1/voices com xi-api-key (base com ou sem /v1)', async () => {
  for (const id of ['el', 'el1']) {
    resetVoiceCatalogCache()
    const m = mockFetch((url) =>
      url.endsWith('/v1/models') ? { body: EL_MODELS } : { body: EL_VOICES }
    )
    const v = await listVoiceCatalog({ capability: 'tts', providerId: id }, deps(m.fetch))
    assert.deepEqual(m.calls.map((c) => c.url).sort(), [
      'https://api.elevenlabs.io/v1/models',
      'https://api.elevenlabs.io/v1/voices'
    ])
    for (const c of m.calls) {
      assert.equal(c.headers['xi-api-key'], 'xi-SECRET-2')
      assert.equal(c.headers.Authorization, undefined)
    }
    assert.equal(v.source, 'elevenlabs')
    // lista curada: Flash/Turbo v2.5 sempre (o nome do Flash veio da listagem)
    assert.deepEqual(
      v.models.map((x) => x.id),
      ['eleven_flash_v2_5', 'eleven_v4_turbo', 'eleven_turbo_v2_5']
    )
    assert.equal(v.models[0].label, 'Eleven Flash v2.5')
    assert.equal(v.curated, true)
    assert.equal(v.voices.length, 2)
    noSecrets(v)
  }
  // STT pelo ElevenLabs direto: não suportado (sem request)
  const m = mockFetch(() => ({ body: [] }))
  const stt = await listVoiceCatalog({ capability: 'stt', providerId: 'el' }, deps(m.fetch))
  assert.equal(m.calls.length, 0)
  assert.match(stt.hint ?? '', /só serve a fala/)
  // sem chave: erro legível sem request
  const nk = await listVoiceCatalog({ capability: 'tts', providerId: 'nokey' }, deps(m.fetch))
  assert.match(nk.error ?? '', /sem chave/)
  assert.equal(m.calls.length, 0)
})

test('listVoiceCatalog (ElevenLabs): /v1/models sem permissão não é erro (lista curada); 401 das vozes é', async () => {
  resetVoiceCatalogCache()
  // a chave real do usuário não tinha `models_read`: os modelos curados aparecem mesmo assim
  const m = mockFetch((url) =>
    url.endsWith('/models')
      ? {
          status: 401,
          body: { detail: { status: 'missing_permissions', message: 'missing models_read' } }
        }
      : { body: EL_VOICES }
  )
  const v = await listVoiceCatalog({ capability: 'tts', providerId: 'el' }, deps(m.fetch))
  assert.equal(v.error, null)
  assert.deepEqual(
    v.models.map((x) => x.id),
    ['eleven_flash_v2_5', 'eleven_v4_turbo', 'eleven_turbo_v2_5']
  )
  assert.equal(v.voices.length, 2)
  resetVoiceCatalogCache()
  const bad = mockFetch((url) =>
    url.endsWith('/voices')
      ? { status: 401, body: { detail: { status: 'invalid_api_key', message: 'Invalid API key' } } }
      : { body: EL_MODELS }
  )
  const w = await listVoiceCatalog({ capability: 'tts', providerId: 'el' }, deps(bad.fetch))
  assert.match(
    w.error ?? '',
    /vozes: chave de API inválida ou sem permissão para listar \(HTTP 401\) — Invalid API key/
  )
  assert.equal(w.freeText, true)
  assert.equal(w.models.length, 3)
})

test('listVoiceCatalog (genérico + servidor local sem chave): Bearer só com chave, heurística e dica', async () => {
  resetVoiceCatalogCache()
  const m = mockFetch(() => ({ body: { data: [{ id: 'llama' }, { id: 'whisper-1' }] } }))
  const gq = await listVoiceCatalog({ capability: 'stt', providerId: 'gq' }, deps(m.fetch))
  assert.equal(m.calls[0].url, 'https://api.groq.com/openai/v1/models')
  assert.equal(m.calls[0].headers.Authorization, 'Bearer gsk-SECRET-3')
  assert.deepEqual(
    gq.models.map((x) => x.id),
    ['whisper-1']
  )
  assert.equal(gq.freeText, true)
  const local = await listVoiceCatalog({ capability: 'tts', providerId: 'loc' }, deps(m.fetch))
  assert.equal(m.calls[1].url, 'http://localhost:9000/v1/models')
  assert.equal(m.calls[1].headers.Authorization, undefined, 'sem chave → sem Authorization')
  assert.match(local.hint ?? '', /nenhum parece de fala/)
  assert.ok(local.voices.some((x) => x.id === 'alloy'))
  noSecrets(local)
  // 404 do /models → texto livre com erro legível
  resetVoiceCatalogCache()
  const nf = mockFetch(() => ({ status: 404, body: 'Not Found' }))
  const v = await listVoiceCatalog({ capability: 'stt', providerId: 'loc' }, deps(nf.fetch))
  assert.match(v.error ?? '', /não tem esta listagem \(HTTP 404\)/)
  assert.equal(v.freeText, true)
})

test('listVoiceCatalog: Anthropic sem áudio, provedor apagado, sem provedor e endpoint inválido', async () => {
  const m = mockFetch(() => ({ body: {} }))
  const an = await listVoiceCatalog({ capability: 'tts', providerId: 'an' }, deps(m.fetch))
  assert.match(an.hint ?? '', /não tem API de áudio/)
  const gone = await listVoiceCatalog({ capability: 'tts', providerId: 'sumiu' }, deps(m.fetch))
  assert.match(gone.error ?? '', /não existe mais/)
  // sem provedor (pedido inválido — não há mais endpoint fora de Provedores)
  const none = await listVoiceCatalog(
    { capability: 'stt', providerId: '' },
    { provider: () => PROVIDERS.gq, fetch: m.fetch }
  )
  assert.match(none.hint ?? '', /escolha um provedor/)
  assert.equal(none.error, null)
  const bad = await listVoiceCatalog({ capability: 'stt', providerId: 'ftp' }, deps(m.fetch))
  assert.match(bad.error ?? '', /endpoint inválido/)
  assert.equal(m.calls.length, 0)
})

test('fetchVoicePreview: só baixa prévias publicadas por uma listagem (https), com MIME de áudio', async () => {
  resetVoiceCatalogCache()
  await assert.rejects(
    fetchVoicePreview('https://storage.googleapis.com/x/sarah-pt.mp3'),
    /prévia de voz desconhecida/
  )
  const m = mockFetch((url) =>
    url.endsWith('/v1/models') ? { body: EL_MODELS } : { body: EL_VOICES }
  )
  await listVoiceCatalog({ capability: 'tts', providerId: 'el' }, deps(m.fetch))
  const audio = new Uint8Array([0x49, 0x44, 0x33, 1, 2, 3])
  const f = (async () =>
    new Response(audio, { headers: { 'content-type': 'audio/mpeg' } })) as unknown as typeof fetch
  const r = await fetchVoicePreview('https://storage.googleapis.com/x/sarah-pt.mp3', { fetch: f })
  assert.equal(r.mime, 'audio/mpeg')
  assert.deepEqual([...r.audio], [...audio])
  await assert.rejects(
    fetchVoicePreview('http://inseguro/george.mp3', { fetch: f }),
    /desconhecida/
  )
  await assert.rejects(fetchVoicePreview('file:///etc/passwd', { fetch: f }), /desconhecida/)
})
