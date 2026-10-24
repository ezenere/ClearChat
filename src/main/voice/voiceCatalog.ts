// Descoberta de modelos/vozes de STT e TTS nos provedores cadastrados (canal `voice:catalog:list`)
// e prévias de voz publicadas pelo provedor (`voice:catalog:preview`). O main é dono da rede e das
// chaves: a chave do provedor só entra no header da listagem e nunca volta na visão. Cache de
// 10 min por capacidade+provedor+endpoint(+hash da chave). Sem Electron
// (dependências injetáveis — testes com fetch mockado). Ver SPEC.md → "Áudio → Provedor, modelo e
// voz (descoberta)".
import { createHash } from 'node:crypto'
import {
  CALL_TTS_MODELS_OPENROUTER,
  curateVoiceModels,
  describeVoice,
  ELEVENLABS_PREMADE_VOICES,
  OPENAI_TTS_VOICES,
  OPENROUTER_OUTPUT_MODALITY,
  parseElevenLabsModels,
  parseElevenLabsVoices,
  parseOpenAiAudioModels,
  parseOpenRouterAudioModels,
  providerSupportsVoice,
  VOICE_CATALOG_CACHE_MS,
  voiceProviderSupport,
  type VoiceCapability,
  type VoiceCatalogModel,
  type VoiceCatalogRequest,
  type VoiceCatalogView,
  type VoiceProviderSupport
} from '@shared/voiceCatalog'
import { connectionErrorText } from '@shared/network'

/** Provedor como o main o vê (com a chave — nunca sai daqui). */
export interface VoiceCatalogProvider {
  id: string
  name?: string
  kind?: unknown
  baseUrl: string
  apiKey: string
  headers?: Record<string, string>
}

export interface VoiceCatalogDeps {
  /** Provedor cadastrado pelo id (null = apagado). */
  provider: (id: string) => VoiceCatalogProvider | null
  fetch?: typeof fetch
  now?: () => number
  /** Timeout de cada GET (padrão 15 s). */
  timeoutMs?: number
}

const cache = new Map<string, VoiceCatalogView>()
/** Prévias de voz que o main publicou (só elas podem ser baixadas por `voice:catalog:preview`). */
const knownPreviews = new Set<string>()

/** Zera cache e prévias conhecidas (testes). */
export function resetVoiceCatalogCache(): void {
  cache.clear()
  knownPreviews.clear()
}

const keyHash = (k: string): string =>
  k ? createHash('sha256').update(k).digest('hex').slice(0, 12) : '-'

/** Base sem barra final; ElevenLabs: origem + `/v1` (aceita a base cadastrada com ou sem `/v1`). */
function apiBase(baseUrl: string, family: VoiceProviderSupport): string {
  const b = baseUrl.trim().replace(/\/+$/, '')
  if (family !== 'elevenlabs') return b
  return `${b.replace(/\/v\d+$/i, '')}/v1`
}

/** GET JSON com erro legível em pt-BR (rede, HTTP com corpo resumido, JSON inválido). */
async function getJson(
  url: string,
  headers: Record<string, string>,
  deps: VoiceCatalogDeps
): Promise<unknown> {
  const f = deps.fetch ?? fetch
  let res: Response
  try {
    res = await f(url, {
      headers: { Accept: 'application/json', ...headers },
      signal: AbortSignal.timeout(deps.timeoutMs ?? 15_000)
    })
  } catch (e) {
    throw new Error(`falha de rede ao listar em ${url}: ${connectionErrorText(e)}`, { cause: e })
  }
  const text = await res.text().catch(() => '')
  if (!res.ok) {
    let detail: string
    try {
      const j = JSON.parse(text) as Record<string, unknown>
      const e = j.error ?? j.detail ?? j.message
      const msg =
        e && typeof e === 'object'
          ? ((e as Record<string, unknown>).message ?? (e as Record<string, unknown>).status)
          : e
      detail = typeof msg === 'string' ? msg : ''
    } catch {
      detail = /<html/i.test(text) ? '' : text
    }
    detail = detail.replace(/\s+/g, ' ').trim().slice(0, 160)
    const what =
      res.status === 401 || res.status === 403
        ? 'chave de API inválida ou sem permissão para listar'
        : res.status === 404
          ? 'o endpoint não tem esta listagem'
          : 'falha ao listar'
    throw new Error(`${what} (HTTP ${res.status})${detail ? ` — ${detail}` : ''}`)
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`a listagem em ${url} não devolveu JSON`)
  }
}

/** Vozes premade do ElevenLabs (via OpenRouter) quando a listagem falha. */
const STATIC_ELEVEN_VOICES = Object.keys(ELEVENLABS_PREMADE_VOICES)

/** Tabela embutida do OpenRouter (listagem fora do ar): os modelos de áudio mais usados. */
function openRouterStatic(capability: VoiceCapability): VoiceCatalogModel[] {
  if (capability === 'stt')
    return [
      { id: 'openai/whisper-large-v3-turbo', label: 'OpenAI: Whisper Large V3 Turbo' },
      { id: 'openai/gpt-4o-mini-transcribe', label: 'OpenAI: GPT-4o Mini Transcribe' },
      { id: 'elevenlabs/scribe-v2', label: 'ElevenLabs: Scribe v2' },
      { id: 'deepgram/nova-3', label: 'Deepgram: Nova-3' }
    ]
  // TTS: a lista curada para a chamada (as vozes conhecidas de cada modelo)
  return Object.entries(CALL_TTS_MODELS_OPENROUTER).map(([id, c]) => ({
    id,
    label: id.startsWith('elevenlabs/') ? `ElevenLabs: ${id.slice(11)}` : id,
    voiceIds: id.startsWith('elevenlabs/') ? STATIC_ELEVEN_VOICES : c.ptVoices
  }))
}

/** Vozes da lista embutida do TTS (premade do ElevenLabs + as pt-BR dos outros modelos curados). */
function openRouterStaticVoices(): VoiceCatalogView['voices'] {
  const out = new Map<string, VoiceCatalogView['voices'][number]>()
  for (const v of STATIC_ELEVEN_VOICES) out.set(v, describeVoice(v, 'elevenlabs/'))
  for (const [id, c] of Object.entries(CALL_TTS_MODELS_OPENROUTER))
    for (const v of c.ptVoices) if (!out.has(v)) out.set(v, describeVoice(v, id))
  return [...out.values()]
}

function headersFor(
  family: VoiceProviderSupport,
  apiKey: string,
  extra: Record<string, string> = {}
): Record<string, string> {
  const h: Record<string, string> = { ...extra }
  const key = apiKey.trim()
  if (key) {
    if (family === 'elevenlabs') h['xi-api-key'] = key
    else h.Authorization = `Bearer ${key}`
  }
  return h
}

async function discover(
  capability: VoiceCapability,
  family: VoiceProviderSupport,
  baseUrl: string,
  apiKey: string,
  extra: Record<string, string> | undefined,
  deps: VoiceCatalogDeps
): Promise<Omit<VoiceCatalogView, 'capability' | 'providerId' | 'fetchedAt'>> {
  const base = apiBase(baseUrl, family)
  const headers = headersFor(family, apiKey, extra)
  if (family === 'openrouter') {
    // `/models` do OpenRouter é público; o filtro de modalidade traz os modelos de áudio
    try {
      const j = await getJson(
        `${base}/models?output_modalities=${OPENROUTER_OUTPUT_MODALITY[capability]}`,
        headers,
        deps
      )
      const { models, voices } = parseOpenRouterAudioModels(j, capability)
      return {
        source: 'openrouter',
        models,
        voices,
        freeText: false,
        error: null,
        hint: models.length ? null : 'o OpenRouter não listou modelos de áudio — digite o id'
      }
    } catch (e) {
      const models = openRouterStatic(capability)
      return {
        source: 'static',
        models,
        voices: capability === 'tts' ? openRouterStaticVoices() : [],
        freeText: true,
        error: (e as Error).message,
        hint: 'lista embutida (a listagem do OpenRouter falhou)'
      }
    }
  }
  if (family === 'elevenlabs') {
    if (capability === 'stt')
      return {
        source: 'none',
        models: [],
        voices: [],
        freeText: false,
        error: null,
        hint: 'o ElevenLabs direto só serve a fala (TTS) aqui — para transcrever, use o OpenRouter (elevenlabs/scribe-v2) ou outro provedor'
      }
    if (!apiKey.trim())
      return {
        source: 'elevenlabs',
        models: [],
        voices: [],
        freeText: true,
        error: 'o provedor do ElevenLabs está sem chave de API (Configurações → Provedores)',
        hint: null
      }
    const [m, v] = await Promise.allSettled([
      getJson(`${base}/models`, headers, deps),
      getJson(`${base}/voices`, headers, deps)
    ])
    const errors: string[] = []
    let models: VoiceCatalogModel[] = []
    let voices: VoiceCatalogView['voices'] = []
    // `/v1/models` só dá os nomes: a lista do seletor é a curada (Flash/Turbo v2.5 — ver
    // `curateVoiceModels`), então a falha dela (ex.: chave sem `models_read`) não é erro visível
    if (m.status === 'fulfilled') {
      try {
        models = parseElevenLabsModels(m.value)
      } catch {
        /* nomes da tabela curada */
      }
    }
    if (v.status === 'fulfilled') {
      try {
        voices = parseElevenLabsVoices(v.value)
      } catch (e) {
        errors.push((e as Error).message)
      }
    } else errors.push(`vozes: ${(v.reason as Error).message}`)
    for (const voice of voices) if (voice.previewUrl) knownPreviews.add(voice.previewUrl)
    return {
      source: 'elevenlabs',
      models,
      voices,
      freeText: errors.length > 0,
      error: errors.length ? errors.join(' · ') : null,
      hint: null
    }
  }
  // OpenAI-compatível genérico: GET {baseUrl}/models filtrado pela heurística do id
  const voices =
    capability === 'tts' ? OPENAI_TTS_VOICES.map((id) => ({ id, label: id, language: null })) : []
  try {
    const j = await getJson(`${base}/models`, headers, deps)
    const { models, total } = parseOpenAiAudioModels(j, capability)
    return {
      source: 'openai',
      models,
      voices,
      freeText: true,
      error: null,
      hint: models.length
        ? null
        : total
          ? `o endpoint listou ${total} modelos, nenhum parece de ${capability === 'stt' ? 'transcrição' : 'fala'} — digite o id`
          : 'o endpoint não listou modelos — digite o id'
    }
  } catch (e) {
    return {
      source: 'openai',
      models: [],
      voices,
      freeText: true,
      error: (e as Error).message,
      hint: 'digite o id do modelo (o endpoint não lista modelos)'
    }
  }
}

/**
 * Modelos (e vozes, no TTS) que o provedor cadastrado oferece para a capacidade. Nunca lança:
 * falhas viram `error` legível (com lista embutida quando existe). Resultado em cache por `VOICE_CATALOG_CACHE_MS` (falhas não ficam em
 * cache). A visão NUNCA carrega a chave.
 */
export async function listVoiceCatalog(
  req: VoiceCatalogRequest,
  deps: VoiceCatalogDeps
): Promise<VoiceCatalogView> {
  const now = deps.now ?? Date.now
  const capability: VoiceCapability = req.capability === 'stt' ? 'stt' : 'tts'
  const providerId = typeof req.providerId === 'string' ? req.providerId.trim() : ''
  const empty = (error: string | null, hint: string | null = null): VoiceCatalogView => ({
    capability,
    providerId,
    source: 'none',
    models: [],
    voices: [],
    freeText: true,
    error,
    hint,
    fetchedAt: now()
  })
  if (!providerId)
    return empty(null, 'escolha um provedor em Configurações → Áudio para listar os modelos')
  const p = deps.provider(providerId)
  if (!p) return empty('o provedor escolhido não existe mais (Configurações → Provedores)')
  const family = voiceProviderSupport(p)
  if (!family || !providerSupportsVoice(p, capability))
    return {
      ...empty(null, null),
      source: family ?? 'none',
      freeText: false,
      hint:
        family === 'elevenlabs'
          ? 'o ElevenLabs direto só serve a fala (TTS) aqui'
          : 'este provedor não tem API de áudio'
    }
  const { baseUrl, apiKey, headers: extra } = p
  if (!/^https?:\/\//i.test(baseUrl.trim()))
    return empty('endpoint inválido (use http:// ou https://)')
  const cacheKey = `${capability}|${providerId}|${voiceBaseUrlKeyOf(baseUrl)}|${keyHash(apiKey)}`
  const hit = cache.get(cacheKey)
  if (!req.refresh && hit && now() - hit.fetchedAt < VOICE_CATALOG_CACHE_MS) return hit
  const found = await discover(capability, family, baseUrl, apiKey, extra, deps)
  // curadoria da chamada: TTS do OpenRouter/ElevenLabs só com os modelos medidos rápidos com pt-BR
  const cur = curateVoiceModels(found.models, capability, family)
  const view: VoiceCatalogView = {
    capability,
    providerId,
    ...found,
    models: cur.models,
    ...(cur.curated ? { curated: true, hiddenModels: cur.hidden } : {}),
    fetchedAt: now()
  }
  if (!view.error) cache.set(cacheKey, view)
  else cache.delete(cacheKey)
  return view
}

const voiceBaseUrlKeyOf = (u: string): string => u.trim().replace(/\/+$/, '').toLowerCase()

/** Teto da prévia baixada (as do ElevenLabs têm ~50–200 KB). */
const PREVIEW_MAX_BYTES = 4 * 1024 * 1024

/**
 * Baixa uma prévia de voz publicada pelo provedor (`previewUrl` de uma listagem desta execução —
 * qualquer outra URL é recusada: o canal não vira um proxy de rede). O renderer toca os bytes
 * (a CSP da janela não deixa tocar URLs externas direto).
 */
export async function fetchVoicePreview(
  url: string,
  deps: Pick<VoiceCatalogDeps, 'fetch' | 'timeoutMs'> = {}
): Promise<{ audio: Uint8Array; mime: string }> {
  const u = typeof url === 'string' ? url.trim() : ''
  if (!u || !knownPreviews.has(u) || !/^https:\/\//i.test(u))
    throw new Error('prévia de voz desconhecida — atualize a lista de vozes')
  const f = deps.fetch ?? fetch
  let res: Response
  try {
    res = await f(u, { signal: AbortSignal.timeout(deps.timeoutMs ?? 15_000) })
  } catch (e) {
    throw new Error(`falha de rede ao baixar a prévia: ${connectionErrorText(e)}`, { cause: e })
  }
  if (!res.ok) throw new Error(`a prévia da voz não pôde ser baixada (HTTP ${res.status})`)
  const buf = new Uint8Array(await res.arrayBuffer())
  if (!buf.length || buf.length > PREVIEW_MAX_BYTES)
    throw new Error('a prévia da voz veio vazia ou grande demais')
  const ct = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
  return { audio: buf, mime: ct.startsWith('audio/') ? ct : 'audio/mpeg' }
}
