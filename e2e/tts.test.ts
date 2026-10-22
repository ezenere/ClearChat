// Síntese de fala (TTS, `src/main/voice/tts.ts` + `ttsLocal.ts`): cliente OpenAI-compatível
// `/audio/speech` com fetch mockado (payload JSON `{ model, voice, input, response_format }`,
// bytes de áudio na resposta), erros legíveis (401 chave, 429 cota, 500 com corpo resumido, rede,
// timeout, abort, config), despacho para o motor local (injetado) e os helpers puros de fonemas do
// Kokoro (mapeamento do espeak-ng → vocabulário). O spike real do Kokoro está reportado na SPEC —
// aqui nada roda ONNX nem baixa pesos.
// Rodar: npm run test:unit
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  kokoroInputIds,
  KOKORO_VOCAB,
  mapEspeakPhonemes,
  ESPEAK_E2M
} from '../src/main/voice/ttsLocal.ts'
import {
  synthesize,
  TTS_DEFAULT_TIMEOUT_MS,
  TTS_TEST_PHRASE,
  TtsError,
  type TtsLocalBackend,
  type TtsLocalInput,
  type TtsLocalResult
} from '../src/main/voice/tts.ts'
import {
  DEFAULT_TTS_SETTINGS,
  normalizeTtsSettings,
  type TtsSettings
} from '../src/shared/voice.ts'

// ---------------- helpers ----------------

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

const localSettings = (): TtsSettings =>
  normalizeTtsSettings({
    backend: 'local',
    local: { engine: 'kokoro', voice: 'pf_dora', installed: true }
  })

/** fetch mockado: captura a chamada e devolve o corpo com o status/content-type pedidos. */
function mockFetch(
  respond: (
    url: string,
    init?: RequestInit
  ) => { status?: number; body: Uint8Array | string; contentType?: string }
): { calls: { url: string; init?: RequestInit }[]; fetch: typeof fetch } {
  const calls: { url: string; init?: RequestInit }[] = []
  return {
    calls,
    fetch: (async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), init })
      const r = respond(String(url), init)
      return new Response(
        new Uint8Array(typeof r.body === 'string' ? new TextEncoder().encode(r.body) : r.body),
        {
          status: r.status ?? 200,
          headers: { 'content-type': r.contentType ?? 'audio/wav' }
        }
      )
    }) as typeof fetch
  }
}

/** fetch mockado que "pendura" até o signal abortar (como o nativo: rejeita com AbortError). */
function hangingFetch(): typeof fetch {
  return ((url: unknown, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () =>
        reject(new DOMException('aborted', 'AbortError'))
      )
    })) as typeof fetch
}

async function withFetch<T>(f: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const orig = globalThis.fetch
  globalThis.fetch = f
  try {
    return await fn()
  } finally {
    globalThis.fetch = orig
  }
}

/** Motor local fake (registra as chamadas e devolve bytes fixos). */
function fakeEngine(over: Partial<TtsLocalResult> = {}): {
  backend: TtsLocalBackend
  calls: TtsLocalInput[]
} {
  const calls: TtsLocalInput[] = []
  return {
    calls,
    backend: {
      engine: 'kokoro',
      async synthesize(input) {
        calls.push(input)
        return {
          audio: new Uint8Array([0, 1, 2, 3]),
          mime: 'audio/wav',
          model: 'kokoro-onnx',
          ms: 7,
          ...over
        }
      }
    }
  }
}

// ---------------- cliente da API ----------------

test('tts api: payload JSON correto (model/voice/input/response_format) e bytes devolvidos', async () => {
  const audio = new Uint8Array([1, 2, 3, 4, 5])
  const { calls, fetch } = mockFetch(() => ({ body: audio }))
  const r = await withFetch(fetch, () =>
    synthesize({ text: 'Olá!', settings: apiSettings(), format: 'mp3' })
  )
  assert.equal(calls.length, 1)
  const { url, init } = calls[0]
  assert.equal(url, 'https://tts.example/v1/audio/speech')
  assert.equal(init?.method, 'POST')
  const headers = init?.headers as Record<string, string>
  assert.equal(headers['Content-Type'], 'application/json')
  assert.equal(headers.Authorization, 'Bearer sk-test')
  assert.deepEqual(JSON.parse(String(init?.body)), {
    model: 'tts-model',
    input: 'Olá!',
    response_format: 'mp3',
    voice: 'alloy'
  })
  assert.deepEqual([...r.audio], [1, 2, 3, 4, 5])
  assert.equal(r.mime, 'audio/mpeg')
  assert.equal(r.model, 'tts-model')
  assert.equal(r.backend, 'api')
  assert.ok(r.ms >= 0)
})

test('tts api: formato padrão wav, voz nula omitida, baseUrl com barra e chave vazia sem Authorization', async () => {
  const { calls, fetch } = mockFetch(() => ({ body: new Uint8Array([9]) }))
  await withFetch(fetch, () =>
    synthesize({
      text: 'oi',
      settings: apiSettings({ baseUrl: 'https://x.test/v1/', voice: null, apiKey: '' })
    })
  )
  assert.equal(calls[0].url, 'https://x.test/v1/audio/speech')
  const headers = calls[0].init?.headers as Record<string, string>
  assert.equal(headers.Authorization, undefined)
  const body = JSON.parse(String(calls[0].init?.body))
  assert.equal(body.response_format, 'wav')
  assert.equal('voice' in body, false)
})

test('tts api: erros legíveis — 401 auth, 429 quota, 500 http com corpo resumido, 400 com detail', async () => {
  const cases: { status: number; body: string; kind: string; re: RegExp }[] = [
    {
      status: 401,
      body: '{"error":{"message":"bad key"}}',
      kind: 'auth',
      re: /chave de API inválida/
    },
    {
      status: 429,
      body: '{"error":{"message":"rate limit"}}',
      kind: 'quota',
      re: /limite de uso\/cota/
    },
    {
      status: 500,
      body: '{"error":{"message":"explodiu"}}',
      kind: 'http',
      re: /HTTP 500 .*explodiu/
    },
    { status: 400, body: '{"detail":"voz desconhecida"}', kind: 'http', re: /voz desconhecida/ }
  ]
  for (const c of cases) {
    const { fetch } = mockFetch(() => ({
      status: c.status,
      body: c.body,
      contentType: 'application/json'
    }))
    await withFetch(fetch, async () => {
      await assert.rejects(synthesize({ text: 'oi', settings: apiSettings() }), (e: unknown) => {
        assert.ok(e instanceof TtsError, `instância de TtsError (${c.status})`)
        assert.equal(e.kind, c.kind)
        assert.equal(e.status, c.status)
        assert.equal(e.backend, 'api')
        assert.match(e.message, c.re)
        return true
      })
    })
  }
})

test('tts api: resposta 2xx sem áudio (JSON ou corpo vazio) → erro http legível', async () => {
  const json = mockFetch(() => ({ body: '{"ok":true}', contentType: 'application/json' }))
  await withFetch(json.fetch, () =>
    assert.rejects(synthesize({ text: 'oi', settings: apiSettings() }), /resposta da API sem áudio/)
  )
  const empty = mockFetch(() => ({ body: new Uint8Array(0) }))
  await withFetch(empty.fetch, () =>
    assert.rejects(synthesize({ text: 'oi', settings: apiSettings() }), /corpo vazio/)
  )
})

test('tts api: rede, timeout e abort (AbortError nunca vira TtsError)', async () => {
  const failing = ((url: unknown) => {
    void url
    return Promise.reject(new TypeError('fetch failed'))
  }) as typeof fetch
  await withFetch(failing, () =>
    assert.rejects(
      synthesize({ text: 'oi', settings: apiSettings() }),
      (e: unknown) => e instanceof TtsError && e.kind === 'network'
    )
  )
  // timeout: fetch pendurado + timeoutMs curtíssimo
  await withFetch(hangingFetch(), () =>
    assert.rejects(
      synthesize({ text: 'oi', settings: apiSettings() }, { timeoutMs: 20 }),
      (e: unknown) => e instanceof TtsError && e.kind === 'timeout'
    )
  )
  // abort do chamador: AbortError cru (nunca TtsError)
  const controller = new AbortController()
  await withFetch(hangingFetch(), async () => {
    const p = synthesize({ text: 'oi', settings: apiSettings() }, { signal: controller.signal })
    setTimeout(() => controller.abort(), 10)
    await assert.rejects(p, (e: unknown) => (e as Error).name === 'AbortError')
  })
})

test('tts api: config — sem baseUrl, sem modelo e texto vazio', async () => {
  await assert.rejects(
    synthesize({ text: 'oi', settings: apiSettings({ baseUrl: '' }) }),
    (e: unknown) => e instanceof TtsError && e.kind === 'config' && /endereço/.test(e.message)
  )
  await assert.rejects(
    synthesize({ text: 'oi', settings: apiSettings({ model: '' }) }),
    (e: unknown) => e instanceof TtsError && e.kind === 'config' && /modelo/.test(e.message)
  )
  await assert.rejects(
    synthesize({ text: '   ', settings: apiSettings() }),
    (e: unknown) => e instanceof TtsError && e.kind === 'config' && /vazio/.test(e.message)
  )
})

// ---------------- motor local ----------------

test('tts local: despacha para o motor injetado com voz/formato e devolve backend local', async () => {
  const { backend, calls } = fakeEngine({ model: 'kokoro-onnx-q8' })
  const r = await synthesize(
    { text: 'Uhum.', settings: localSettings(), format: 'wav' },
    { local: backend }
  )
  assert.equal(calls.length, 1)
  assert.equal(calls[0].text, 'Uhum.')
  assert.equal(calls[0].voice, 'pf_dora')
  assert.equal(calls[0].format, 'wav')
  assert.equal(r.backend, 'local')
  assert.equal(r.model, 'kokoro-onnx-q8')
  assert.equal(r.mime, 'audio/wav')
  assert.deepEqual([...r.audio], [0, 1, 2, 3])
})

test('tts local: sem motor → config legível; backend local sem `local` nas settings → config', async () => {
  await assert.rejects(
    synthesize({ text: 'oi', settings: localSettings() }),
    (e: unknown) => e instanceof TtsError && e.kind === 'config' && /motor local/.test(e.message)
  )
  const { backend } = fakeEngine()
  const semLocal = normalizeTtsSettings({ backend: 'local', local: null })
  await assert.rejects(
    synthesize({ text: 'oi', settings: semLocal }, { local: backend }),
    (e: unknown) => e instanceof TtsError && e.kind === 'config'
  )
})

test('tts: frase de demonstração definida e timeout padrão de 60 s', () => {
  assert.ok(TTS_TEST_PHRASE.trim().length > 0)
  assert.equal(TTS_DEFAULT_TIMEOUT_MS, 60_000)
  assert.equal(DEFAULT_TTS_SETTINGS.backend, 'local')
})

// ---------------- fonemas do Kokoro (helpers puros) ----------------

test('mapEspeakPhonemes: ties (ZWJ/U+0361), dífonos do misaki, hífens e NFD', () => {
  // tie ^ (ZWJ do --ipa=3): t^ʃ vira ʧ (mapeamento do misaki EspeakG2P)
  assert.equal(mapEspeakPhonemes('t\u200dʃi'), 'ʧi')
  assert.equal(mapEspeakPhonemes('t\u0361ʃi'), 'ʧi')
  for (const [from, to] of ESPEAK_E2M) {
    assert.equal(mapEspeakPhonemes(from), to, `dífono ${from} → ${to}`)
  }
  // ties/hífens sobrando somem
  assert.equal(mapEspeakPhonemes('a^b-c'), 'abc')
  // 'ũ' pré-composto vira u + til combinante (o vocabulário é por caractere)
  assert.equal(mapEspeakPhonemes('ũ'), 'u\u0303')
  // equivalência com a saída real do espeak-ng pt-br (validada no spike)
  assert.equal(mapEspeakPhonemes('ol\u02c8a, \u02c8ist\u0283i'), 'ol\u02c8a, \u02c8ist\u0283i')
})

test('kokoroInputIds: vocabulário char-level, chars desconhecidos caem, truncamento em 509', () => {
  // vocabulário de referência (tokenizer.json da conversão ONNX)
  assert.equal(KOKORO_VOCAB['$'], 0)
  assert.equal(KOKORO_VOCAB.a, 43)
  assert.equal(KOKORO_VOCAB['\u02c8'], 156) // estresse primário
  assert.equal(KOKORO_VOCAB['\u02a7'], 133) // ʧ
  assert.equal(Object.keys(KOKORO_VOCAB).length, 115)
  // ids por caractere, na ordem; desconhecidos descartados (como o vocab.get do model.py)
  assert.deepEqual(kokoroInputIds('ab'), [43, 44])
  assert.deepEqual(kokoroInputIds('a\u4e16b'), [43, 44])
  assert.deepEqual(kokoroInputIds(''), [])
  // o pad das bordas ([0, *ids, 0]) é aplicado pelo motor — aqui não entra
  assert.deepEqual(kokoroInputIds('a'), [43])
  // truncamento
  assert.equal(kokoroInputIds('a'.repeat(600)).length, 509)
})
