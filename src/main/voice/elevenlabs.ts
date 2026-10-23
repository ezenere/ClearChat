// ElevenLabs direto (provedor de voz `kind: 'elevenlabs'`) — a parte REST: configuração efetiva
// (modelo/voz/endereço), erros legíveis, síntese `POST /v1/text-to-speech/{voice_id}[/stream]` em
// PCM 24 kHz (clipes, "Testar voz" e o caminho por sentença quando o modelo não serve no
// WebSocket), listagem de modelos/vozes (`GET /v1/models`, `GET /v1/voices` — também usada pela
// descoberta de modelos/vozes das Configurações) e o "Testar conexão" do provedor. O WebSocket de
// entrada em streaming (chamada de voz) vive em `elevenlabsStream.ts`. Sem Electron/UI/IPC; `fetch`
// é o global (testes mockam/usam o servidor fake de `e2e/fakes/elevenlabsFake.mjs`). A chave fica
// no main: só vai no header `xi-api-key` (ou no 1º frame do WebSocket) — nunca num resultado.
// Ver SPEC.md → "Áudio → ElevenLabs direto".
import type { TtsEndpointConfig } from '@shared/voice'
import { connectionErrorText } from '@shared/network'
import { abortError } from '../tools/util'
import {
  TtsError,
  TTS_DEFAULT_TIMEOUT_MS,
  type TtsStreamResult,
  type TtsSynthesizeOptions,
  type TtsSynthesizeResult
} from './tts'
import { concatBytes, encodeWav, Pcm16MonoAligner } from './wav'

// ---------------- configuração ----------------

/** Base padrão da API (sem `/v1` — os caminhos acrescentam a versão). */
export const ELEVENLABS_DEFAULT_BASE_URL = 'https://api.elevenlabs.io'

/** Modelo padrão: Flash v2.5 (a menor latência; multilíngue, inclui português). */
export const ELEVENLABS_DEFAULT_MODEL = 'eleven_flash_v2_5'

/** Voz padrão quando nenhuma foi escolhida ("Sarah", premade). */
export const ELEVENLABS_DEFAULT_VOICE_ID = 'EXAVITQu4vr4xnSDxMaL'

/** Formato pedido em REST e no WebSocket (PCM16 LE mono, 24 kHz — o que o player da chamada toca). */
export const ELEVENLABS_OUTPUT_FORMAT = 'pcm_24000'
export const ELEVENLABS_SAMPLE_RATE = 24_000

/** Modelos sugeridos (o campo aceita qualquer `model_id`). */
export const ELEVENLABS_MODELS = [
  'eleven_flash_v2_5',
  'eleven_turbo_v2_5',
  'eleven_multilingual_v2',
  'eleven_v3'
] as const

/**
 * Vozes premade (nome → `voice_id`) para quem digita o nome em vez do id (a descoberta lista as
 * vozes da conta por `GET /v1/voices`). Ids públicos da biblioteca padrão da ElevenLabs.
 */
export const ELEVENLABS_PREMADE_VOICES: Readonly<Record<string, string>> = {
  aria: '9BWtsMINqrJLrRacOk9x',
  roger: 'CwhRBWXzGAHq8TQ4Fs17',
  sarah: 'EXAVITQu4vr4xnSDxMaL',
  laura: 'FGY2WhTYpPnrIDTdsKH5',
  charlie: 'IKne3meq5aSn9XLyUdCD',
  george: 'JBFqnCBsd6RMkjVDRZzb',
  callum: 'N2lVS1w4EtoT3dr4eOWO',
  river: 'SAz9YHcvj6GT2YYXdXww',
  liam: 'TX3LPaxmHKxFdv7VOQHJ',
  charlotte: 'XB0fDUnXU5powFXDhCwa',
  alice: 'Xb7hH8MSUJpSbSDYk0k2',
  matilda: 'XrExE9yKIg1WjnnlVkGX',
  will: 'bIHbv24MWmeRgasZH58o',
  jessica: 'cgSgspJ2msm6clMCkdW9',
  eric: 'cjVigY5qzO86Huf0OWal',
  chris: 'iP95p4xoKVk53GoZ742B',
  brian: 'nPczCjzI2devNBz1zQrb',
  daniel: 'onwK4e9ZLuTAKqWW03F9',
  lily: 'pFZP5JQG7iQjIQuC4Bku',
  bill: 'pqHfZKP75CvOlQylNhV4',
  rachel: '21m00Tcm4TlvDq8ikWAM',
  adam: 'pNInz6obpgDQGcFmaJgB',
  harry: 'SOYHLrjzK2X1ezoPC6cr',
  bella: 'hpp4J3VqNfWAUOO0d1Us'
}

/**
 * O endpoint de síntese é a ElevenLabs direta? Provedor salvo do tipo `elevenlabs`
 * (`providerKind`, resolvido no main) ou host `*.elevenlabs.io` num endpoint avulso.
 */
export function isElevenLabsEndpoint(
  api: Pick<TtsEndpointConfig, 'baseUrl'> & { providerKind?: string | null }
): boolean {
  if (api.providerKind === 'elevenlabs') return true
  if (api.providerKind) return false
  try {
    const host = new URL(api.baseUrl.trim()).hostname.toLowerCase()
    return host === 'elevenlabs.io' || host.endsWith('.elevenlabs.io')
  } catch {
    return false
  }
}

/**
 * `model_id` da ElevenLabs: vazio → Flash v2.5; o formato do OpenRouter
 * (`elevenlabs/eleven-flash-v2.5`) é convertido (`eleven_flash_v2_5`).
 */
export function elevenLabsModelId(model: string | null | undefined): string {
  let m = (model ?? '').trim()
  if (!m) return ELEVENLABS_DEFAULT_MODEL
  if (m.toLowerCase().startsWith('elevenlabs/')) m = m.slice('elevenlabs/'.length)
  if (/^eleven[-_]/i.test(m)) m = m.toLowerCase().replace(/[-.]/g, '_')
  return m
}

/** `voice_id`: id (20 alfanuméricos) como está; nome premade ("Sarah") → id; vazio → Sarah. */
export function elevenLabsVoiceId(voice: string | null | undefined): string {
  const v = (voice ?? '').trim()
  if (!v) return ELEVENLABS_DEFAULT_VOICE_ID
  const byName = ELEVENLABS_PREMADE_VOICES[v.toLowerCase()]
  if (byName) return byName
  return v
}

/**
 * O modelo serve no WebSocket de entrada em streaming? A documentação (2026-10) diz que o
 * `stream-input`/`multi-stream-input` NÃO aceita `eleven_v3`/`eleven_v4*` — esses ficam no REST
 * por sentença (`/stream`).
 */
export function elevenLabsWsSupportsModel(modelId: string): boolean {
  return !/^eleven_v[34]/i.test(modelId)
}

/**
 * Só os modelos v2.5 (Flash/Turbo) aceitam `language_code` (os outros respondem erro quando ele
 * vem). Com ele o português é forçado (normalização de números/datas em pt).
 */
export function elevenLabsLanguageCode(modelId: string, language = 'pt'): string | null {
  return /_v2_5$/i.test(modelId) ? language : null
}

/** Configuração efetiva de uma síntese ElevenLabs (a partir de `ttsSettings.api` resolvida). */
export interface ElevenLabsConfig {
  /** Base REST sem `/` final (ex.: 'https://api.elevenlabs.io'). */
  baseUrl: string
  apiKey: string
  modelId: string
  voiceId: string
  languageCode: string | null
}

/** `ttsSettings.api` → configuração ElevenLabs (erro `config` legível sem chave). */
export function elevenLabsConfig(api: TtsEndpointConfig): ElevenLabsConfig {
  const baseUrl = elevenLabsBase(api.baseUrl)
  const apiKey = api.apiKey.trim()
  if (!apiKey)
    throw new TtsError('config', 'informe a chave da ElevenLabs (Provedores → ElevenLabs)', {
      backend: 'api'
    })
  const modelId = elevenLabsModelId(api.model)
  return {
    baseUrl,
    apiKey,
    modelId,
    voiceId: elevenLabsVoiceId(api.voice),
    languageCode: elevenLabsLanguageCode(modelId)
  }
}

/** Base REST normalizada: vazia → a oficial; `/v1` final removido (os caminhos já o têm). */
export function elevenLabsBase(raw: string | null | undefined): string {
  let b = (raw ?? '').trim().replace(/\/+$/, '')
  if (!b) b = ELEVENLABS_DEFAULT_BASE_URL
  return b.replace(/\/v1$/i, '')
}

// ---------------- erros ----------------

/** Texto do erro num corpo da ElevenLabs (`detail.message`, `detail` string, `message`, `error`). */
export function elevenLabsErrorDetail(raw: string): { message: string; status: string } {
  let message = ''
  let status = ''
  try {
    const j = JSON.parse(raw) as Record<string, unknown>
    const d = j.detail
    if (d && typeof d === 'object' && !Array.isArray(d)) {
      const o = d as Record<string, unknown>
      message = typeof o.message === 'string' ? o.message : ''
      status = typeof o.status === 'string' ? o.status : typeof o.code === 'string' ? o.code : ''
    } else if (typeof d === 'string') message = d
    else if (Array.isArray(d)) message = JSON.stringify(d)
    if (!message && typeof j.message === 'string') message = j.message
    if (!status && typeof j.error === 'string') status = j.error
    if (!message && status) message = status
  } catch {
    message = /<html/i.test(raw) ? '' : raw
  }
  message = message.replace(/\s+/g, ' ').trim()
  if (message.length > 200) message = `${message.slice(0, 200)}…`
  return { message, status }
}

/**
 * Classifica um erro da ElevenLabs (HTTP, frame de erro do WebSocket ou motivo do fechamento):
 * chave inválida/sem permissão → `auth`; cota/créditos/limite de concorrência → `quota`; voz
 * inexistente → `http` com texto próprio; demais → `http`.
 */
export function elevenLabsError(
  input: { status?: number; message?: string; code?: string },
  where = 'ElevenLabs'
): TtsError {
  const msg = (input.message ?? '').trim()
  const code = (input.code ?? '').trim()
  const hay = `${code} ${msg}`.toLowerCase()
  const tail = msg ? ` — ${msg}` : code ? ` — ${code}` : ''
  const st = input.status
  const httpTag = st ? ` (HTTP ${st})` : ''
  if (
    st === 401 ||
    st === 403 ||
    /invalid_api_key|invalid api key|unauthori[sz]ed|missing_permissions|permission|api key/.test(
      hay
    )
  )
    return new TtsError('auth', `chave da ElevenLabs inválida ou sem permissão${httpTag}${tail}`, {
      backend: 'api',
      status: st
    })
  if (
    st === 402 ||
    st === 429 ||
    /quota|credits|insufficient|too_many_concurrent|concurrent|rate.?limit|limit_reached/.test(hay)
  )
    return new TtsError(
      'quota',
      `cota/limite da ElevenLabs atingido (créditos ou requisições simultâneas)${httpTag}${tail}`,
      { backend: 'api', status: st }
    )
  if (/voice_not_found|voice.*(not found|does not exist)|invalid.*voice/.test(hay))
    return new TtsError(
      'http',
      `voz não encontrada na ElevenLabs — confira o voice_id em Configurações → Áudio${tail}`,
      { backend: 'api', status: st }
    )
  if (/model.*(not found|does not exist|not supported|invalid)|model_not_found/.test(hay))
    return new TtsError('http', `modelo não aceito pela ElevenLabs${httpTag}${tail}`, {
      backend: 'api',
      status: st
    })
  return new TtsError('http', `erro da ElevenLabs em ${where}${httpTag}${tail}`, {
    backend: 'api',
    status: st
  })
}

// ---------------- REST ----------------

/** Headers de uma chamada REST (a chave só no `xi-api-key`). */
export function elevenLabsHeaders(
  apiKey: string,
  accept = 'application/json'
): Record<string, string> {
  const h: Record<string, string> = { Accept: accept }
  if (apiKey) h['xi-api-key'] = apiKey
  return h
}

/** Resposta 2xx da síntese REST (corpo ainda não lido) + contexto de erro/tempo. */
interface ElevenLabsSpeech {
  res: Response
  url: string
  t0: number
  timeout: AbortSignal
  timeoutMs: number
}

function restFailure(
  e: unknown,
  opts: TtsSynthesizeOptions,
  r: { timeout: AbortSignal; timeoutMs: number; url: string }
): unknown {
  if (opts.signal?.aborted) return abortError()
  if (e instanceof TtsError) return e
  if (r.timeout.aborted)
    return new TtsError(
      'timeout',
      `tempo esgotado na síntese da ElevenLabs (${r.timeoutMs / 1000} s)`,
      { backend: 'api', cause: e }
    )
  return new TtsError(
    'network',
    `erro de rede ao falar com a ElevenLabs (${safeUrl(r.url)}): ${connectionErrorText(e)}`,
    { backend: 'api', cause: e }
  )
}

/** URL sem a query (nunca há chave nela, mas mensagens ficam curtas). */
const safeUrl = (u: string): string => u.replace(/\?.*$/, '')

/**
 * `POST {base}/v1/text-to-speech/{voice_id}/stream?output_format=pcm_24000` com
 * `{ text, model_id, language_code? }`. 2xx → corpo PCM progressivo (não lido).
 */
async function requestElevenLabsSpeech(
  text: string,
  cfg: ElevenLabsConfig,
  opts: TtsSynthesizeOptions
): Promise<ElevenLabsSpeech> {
  const url =
    `${cfg.baseUrl}/v1/text-to-speech/${encodeURIComponent(cfg.voiceId)}/stream` +
    `?output_format=${ELEVENLABS_OUTPUT_FORMAT}`
  const timeoutMs = opts.timeoutMs ?? TTS_DEFAULT_TIMEOUT_MS
  const timeout = AbortSignal.timeout(timeoutMs)
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout
  const body: Record<string, unknown> = { text, model_id: cfg.modelId }
  if (cfg.languageCode) body.language_code = cfg.languageCode
  const ctx = { timeout, timeoutMs, url }
  const t0 = Date.now()
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { ...elevenLabsHeaders(cfg.apiKey, 'audio/*'), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal
    })
  } catch (e) {
    throw restFailure(e, opts, ctx)
  }
  if (res.status < 200 || res.status >= 300) {
    let raw: string
    try {
      raw = await res.text()
    } catch (e) {
      throw restFailure(e, opts, ctx)
    }
    const d = elevenLabsErrorDetail(raw)
    throw elevenLabsError({ status: res.status, message: d.message, code: d.status }, 'síntese')
  }
  const ct = (res.headers.get('content-type') ?? '').toLowerCase()
  if (ct.includes('application/json')) {
    const raw = await res.text().catch(() => '')
    const d = elevenLabsErrorDetail(raw)
    throw new TtsError(
      'http',
      `resposta da ElevenLabs sem áudio (HTTP ${res.status})${d.message ? ` — ${d.message}` : ''}`,
      { backend: 'api', status: res.status }
    )
  }
  return { res, url, t0, timeout, timeoutMs }
}

/** Síntese REST completa → WAV 24 kHz (clipes/"Testar voz" — a mesma voz da chamada). */
export async function synthesizeElevenLabs(
  text: string,
  api: TtsEndpointConfig,
  opts: TtsSynthesizeOptions = {}
): Promise<TtsSynthesizeResult> {
  const cfg = elevenLabsConfig(api)
  const sp = await requestElevenLabsSpeech(text, cfg, opts)
  let raw: Uint8Array
  try {
    raw = new Uint8Array(await sp.res.arrayBuffer())
  } catch (e) {
    throw restFailure(e, opts, sp)
  }
  const mono = new Pcm16MonoAligner(1).push(raw)
  if (!mono.length)
    throw new TtsError('http', 'resposta da ElevenLabs sem áudio (PCM vazio)', {
      backend: 'api',
      status: sp.res.status
    })
  return {
    audio: encodeWav(mono, ELEVENLABS_SAMPLE_RATE),
    mime: 'audio/wav',
    model: cfg.modelId,
    backend: 'api',
    ms: Date.now() - sp.t0
  }
}

/** Síntese REST em streaming (PCM progressivo) — o mesmo contrato de `synthesizeStream`. */
export async function synthesizeElevenLabsStream(
  text: string,
  api: TtsEndpointConfig,
  opts: TtsSynthesizeOptions = {}
): Promise<TtsStreamResult> {
  const cfg = elevenLabsConfig(api)
  const sp = await requestElevenLabsSpeech(text, cfg, opts)
  const body = sp.res.body
  if (!body) {
    const raw = new Uint8Array(await sp.res.arrayBuffer().catch(() => new ArrayBuffer(0)))
    const mono = new Pcm16MonoAligner(1).push(raw)
    if (!mono.length)
      throw new TtsError('http', 'resposta da ElevenLabs sem áudio (PCM vazio)', {
        backend: 'api',
        status: sp.res.status
      })
    return {
      streaming: false,
      result: {
        audio: encodeWav(mono, ELEVENLABS_SAMPLE_RATE),
        mime: 'audio/wav',
        model: cfg.modelId,
        backend: 'api',
        ms: Date.now() - sp.t0
      }
    }
  }
  async function* chunks(): AsyncGenerator<Uint8Array> {
    const reader = body!.getReader()
    const aligner = new Pcm16MonoAligner(1)
    let total = 0
    try {
      for (;;) {
        let r: ReadableStreamReadResult<Uint8Array>
        try {
          r = await reader.read()
        } catch (e) {
          throw restFailure(e, opts, sp)
        }
        if (r.done) break
        const out = aligner.push(r.value)
        if (out.length) {
          total += out.length
          yield out
        }
      }
      if (!total)
        throw new TtsError('http', 'resposta da ElevenLabs sem áudio (PCM vazio)', {
          backend: 'api',
          status: sp.res.status
        })
    } finally {
      reader.cancel().catch(() => undefined)
    }
  }
  return {
    streaming: true,
    sampleRate: ELEVENLABS_SAMPLE_RATE,
    model: cfg.modelId,
    backend: 'api',
    t0: sp.t0,
    chunks: chunks()
  }
}

/** Junta pedaços PCM num WAV 24 kHz (utilitário de testes/benchmark). */
export const elevenLabsPcmToWav = (parts: readonly Uint8Array[]): Uint8Array =>
  encodeWav(concatBytes(parts), ELEVENLABS_SAMPLE_RATE)

// ---------------- descoberta (modelos/vozes) + "Testar conexão" ----------------

/** Modelo da ElevenLabs como a UI precisa (`GET /v1/models`). */
export interface ElevenLabsModel {
  id: string
  name: string
  description?: string
  /** Faz TTS (`can_do_text_to_speech`). */
  tts: boolean
  /** Idiomas (`languages[].language_id`). */
  languages: string[]
  /** Serve no WebSocket de entrada em streaming (ver `elevenLabsWsSupportsModel`). */
  websocket: boolean
}

/** Voz da conta (`GET /v1/voices`). */
export interface ElevenLabsVoice {
  id: string
  name: string
  category?: string
  /** `labels` (sotaque, gênero, idade…), quando vierem. */
  labels?: Record<string, string>
  previewUrl?: string
}

/** Entrada mínima para as listagens (provedor salvo ou endpoint avulso). */
export interface ElevenLabsAccess {
  baseUrl: string
  apiKey: string
  headers?: Record<string, string>
}

async function getElevenLabsJson(access: ElevenLabsAccess, path: string): Promise<unknown> {
  const base = elevenLabsBase(access.baseUrl)
  if (!/^https?:\/\//i.test(base)) throw new Error('Base URL inválida (use http:// ou https://).')
  if (!access.apiKey.trim()) throw new Error('Informe a API key da ElevenLabs.')
  const url = `${base}${path}`
  let res: Response
  try {
    res = await fetch(url, {
      headers: { ...(access.headers ?? {}), ...elevenLabsHeaders(access.apiKey.trim()) },
      signal: AbortSignal.timeout(20_000)
    })
  } catch (e) {
    throw new Error(`Falha de rede ao falar com a ElevenLabs: ${connectionErrorText(e)}`, {
      cause: e
    })
  }
  const text = await res.text()
  if (!res.ok) {
    const d = elevenLabsErrorDetail(text)
    const err = elevenLabsError({ status: res.status, message: d.message, code: d.status }, path)
    throw new Error(err.message.charAt(0).toUpperCase() + err.message.slice(1), { cause: err })
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`Resposta de ${path} da ElevenLabs não é JSON.`)
  }
}

/** `GET /v1/models` → modelos (só os de TTS por padrão), na ordem da API. */
export async function listElevenLabsModels(
  access: ElevenLabsAccess,
  opts: { ttsOnly?: boolean } = {}
): Promise<ElevenLabsModel[]> {
  const j = await getElevenLabsJson(access, '/v1/models')
  const list = Array.isArray(j)
    ? j
    : Array.isArray((j as { models?: unknown }).models)
      ? (j as { models: unknown[] }).models
      : null
  if (!list) throw new Error('Formato inesperado da resposta de /v1/models da ElevenLabs.')
  const out: ElevenLabsModel[] = []
  for (const m of list) {
    if (!m || typeof m !== 'object') continue
    const o = m as Record<string, unknown>
    const id = typeof o.model_id === 'string' ? o.model_id : ''
    if (!id) continue
    const tts = o.can_do_text_to_speech !== false
    if (opts.ttsOnly !== false && !tts) continue
    const languages = Array.isArray(o.languages)
      ? (o.languages as unknown[])
          .map((l) =>
            l && typeof l === 'object' ? (l as Record<string, unknown>).language_id : null
          )
          .filter((x): x is string => typeof x === 'string')
      : []
    out.push({
      id,
      name: typeof o.name === 'string' && o.name ? o.name : id,
      ...(typeof o.description === 'string' && o.description ? { description: o.description } : {}),
      tts,
      languages,
      websocket: elevenLabsWsSupportsModel(id)
    })
  }
  return out
}

/** `GET /v1/voices` → vozes da conta (premade + clonadas/da biblioteca adicionadas). */
export async function listElevenLabsVoices(access: ElevenLabsAccess): Promise<ElevenLabsVoice[]> {
  const j = await getElevenLabsJson(access, '/v1/voices')
  const list = Array.isArray((j as { voices?: unknown }).voices)
    ? (j as { voices: unknown[] }).voices
    : Array.isArray(j)
      ? (j as unknown[])
      : null
  if (!list) throw new Error('Formato inesperado da resposta de /v1/voices da ElevenLabs.')
  const out: ElevenLabsVoice[] = []
  for (const v of list) {
    if (!v || typeof v !== 'object') continue
    const o = v as Record<string, unknown>
    const id = typeof o.voice_id === 'string' ? o.voice_id : ''
    if (!id) continue
    const labels =
      o.labels && typeof o.labels === 'object' && !Array.isArray(o.labels)
        ? Object.fromEntries(
            Object.entries(o.labels as Record<string, unknown>).filter(
              (e): e is [string, string] => typeof e[1] === 'string'
            )
          )
        : undefined
    out.push({
      id,
      name: typeof o.name === 'string' && o.name ? o.name : id,
      ...(typeof o.category === 'string' ? { category: o.category } : {}),
      ...(labels && Object.keys(labels).length ? { labels } : {}),
      ...(typeof o.preview_url === 'string' ? { previewUrl: o.preview_url } : {})
    })
  }
  return out
}

/**
 * "Testar conexão" de um provedor `elevenlabs`: `GET /v1/models` com a chave (valida a chave e
 * conta os modelos de TTS). Erro → mensagem legível em pt-BR (nunca com a chave).
 */
export async function testElevenLabsAccess(
  access: ElevenLabsAccess
): Promise<{ ok: boolean; error?: string; modelCount?: number }> {
  try {
    const models = await listElevenLabsModels(access)
    return { ok: true, modelCount: models.length }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}
