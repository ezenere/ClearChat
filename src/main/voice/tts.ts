// Serviço de síntese de fala (TTS) do main — cliente do endpoint OpenAI-compatível
// `POST {baseUrl}/audio/speech` (JSON `{ model, voice, input, response_format }` → bytes de áudio)
// + despacho para o motor local (Kokoro) injetado como `TtsLocalBackend`. Sem Electron, sem UI,
// sem IPC (a fiação vem em `src/main/ipc.ts`) e sem rede/local embutidos: as dependências são
// injetáveis (testes usam fetch mockado e um motor fake). O main é dono da rede e das chaves: a
// `apiKey` nunca sai daqui. Contratos de config em `@shared/voice` (`TtsSettings`).
// Ver SPEC.md → "Áudio → Serviço de TTS (clipes)".
import type { TtsLocalEngine, TtsSettings } from '@shared/voice'
import { connectionErrorText } from '@shared/network'
import { abortError } from '../tools/util'

// ---------------- tipos ----------------

/** Formato do áudio sintetizado. */
export type TtsFormat = 'wav' | 'mp3'

/** Backend de síntese. */
export type TtsBackend = 'api' | 'local'

/** Entrada de uma síntese. */
export interface TtsSynthesizeInput {
  /** Texto a falar (pt-BR primeiro). */
  text: string
  /** Configuração de fala (escolhe backend/endpoint/voz). */
  settings: TtsSettings
  /** Formato do áudio (padrão 'wav'). */
  format?: TtsFormat
}

/** Resultado de uma síntese (bytes completos — sem streaming nesta fatia). */
export interface TtsSynthesizeResult {
  /** Bytes do áudio (wav/mp3). */
  audio: Uint8Array
  /** MIME do áudio ('audio/wav' | 'audio/mpeg'). */
  mime: string
  /** Modelo usado (`ttsSettings.api.model` ou o artefato do motor local). */
  model: string
  /** Backend que serviu a síntese. */
  backend: TtsBackend
  /** Duração da chamada em ms. */
  ms: number
}

/** Categoria do erro de síntese (mesma taxonomia do `SttError`). */
export type TtsErrorKind =
  | 'auth' // 401/403 — chave inválida/sem permissão
  | 'quota' // 429/402 — limite de uso/cota
  | 'http' // demais 4xx/5xx (ou resposta 2xx sem áudio)
  | 'network' // conexão — ECONNREFUSED/DNS/reset…
  | 'timeout' // tempo esgotado
  | 'config' // sem baseUrl/modelo ou motor local indisponível

/** Erro de síntese com categoria, status HTTP e backend de origem (mensagem legível em pt-BR). */
export class TtsError extends Error {
  readonly kind: TtsErrorKind
  readonly status?: number
  readonly backend: TtsBackend

  constructor(
    kind: TtsErrorKind,
    message: string,
    opts: { backend: TtsBackend; status?: number; cause?: unknown }
  ) {
    super(message, { cause: opts.cause })
    this.name = 'TtsError'
    this.kind = kind
    this.status = opts.status
    this.backend = opts.backend
  }
}

// ---------------- motor local (injetado) ----------------

/** Entrada de uma síntese local. */
export interface TtsLocalInput {
  text: string
  /** Voz do motor (`ttsSettings.local.voice`; ex.: 'pf_dora' no Kokoro). */
  voice: string
  format: TtsFormat
  signal?: AbortSignal
}

/** Resultado de uma síntese local (mesma forma do `TtsSynthesizeResult`, sem o backend). */
export interface TtsLocalResult {
  audio: Uint8Array
  mime: string
  model: string
  ms: number
}

/**
 * Motor local de síntese (injetado — o Kokoro vive em `ttsLocal.ts`). Falhas do motor devem vir
 * como `TtsError` legível (`config` quando falta modelo/voz/runtime).
 */
export interface TtsLocalBackend {
  /** Id do motor ('kokoro' | 'chatterbox'). */
  engine: TtsLocalEngine
  synthesize(input: TtsLocalInput): Promise<TtsLocalResult>
}

export interface TtsSynthesizeOptions {
  /** Motor local (backend 'local'); sem ele → `TtsError` `config` legível. */
  local?: TtsLocalBackend
  /** Timeout da request em ms (padrão `TTS_DEFAULT_TIMEOUT_MS`). */
  timeoutMs?: number
  /** Cancelamento pelo chamador — sai como `AbortError`. */
  signal?: AbortSignal
}

/** Timeout padrão da request de síntese (configurável por chamada). */
export const TTS_DEFAULT_TIMEOUT_MS = 60_000

/** Frase curta de demonstração do "Testar voz" (canal `voice:tts:test`). */
export const TTS_TEST_PHRASE = 'Olá, isto é um teste.'

const MIME_BY_FORMAT: Record<TtsFormat, string> = { wav: 'audio/wav', mp3: 'audio/mpeg' }
/** `response_format` pedido à API por formato do app. */
const RESPONSE_FORMAT: Record<TtsFormat, string> = { wav: 'wav', mp3: 'mp3' }

// ---------------- cliente da API ----------------

/** Mensagem de erro do corpo (formato OpenAI `error.message`, `detail`, `message`), curta. */
function errorDetail(raw: string): string {
  const msg = parsedErrorDetail(raw).replace(/\s+/g, ' ').trim()
  return msg.length > 160 ? `${msg.slice(0, 160)}…` : msg
}

function parsedErrorDetail(raw: string): string {
  try {
    const j = JSON.parse(raw) as Record<string, unknown>
    const e = j.error
    const cand =
      (e && typeof e === 'object'
        ? ((e as Record<string, unknown>).message ??
          (e as Record<string, unknown>).detail ??
          (e as Record<string, unknown>).msg)
        : e) ??
      j.detail ??
      j.message
    return typeof cand === 'string' ? cand : cand ? JSON.stringify(cand) : ''
  } catch {
    return /<html/i.test(raw) ? '' : raw
  }
}

function httpError(status: number, raw: string, url: string): TtsError {
  const detail = errorDetail(raw)
  const tail = detail ? ` — ${detail}` : ''
  if (status === 401 || status === 403)
    return new TtsError('auth', `chave de API inválida ou sem permissão (HTTP ${status})${tail}`, {
      backend: 'api',
      status
    })
  if (status === 402 || status === 429)
    return new TtsError(
      'quota',
      `limite de uso/cota da síntese de fala atingido (HTTP ${status})${tail}`,
      {
        backend: 'api',
        status
      }
    )
  return new TtsError('http', `HTTP ${status} na síntese de fala em ${url}${tail}`, {
    backend: 'api',
    status
  })
}

/**
 * Sintetiza `text` com a API OpenAI-compatível de `ttsSettings.api`: POST JSON em
 * `{baseUrl}/audio/speech` com `{ model, voice?, input, response_format }` e resposta = bytes de
 * áudio (wav/mp3). Chave no header `Authorization: Bearer …` quando há chave (servidores locais
 * compatíveis não exigem chave); a chave nunca é devolvida ao chamador. Erros → `TtsError`
 * legível (`kind`/`status`): `auth` (401/403), `quota` (429/402), `http` (demais 4xx/5xx e
 * resposta 2xx sem áudio), `network`, `timeout` (padrão 60 s) e `config` (sem baseUrl/modelo).
 * Abort do `signal` propaga como `AbortError`.
 */
export async function synthesize(
  input: TtsSynthesizeInput,
  opts: TtsSynthesizeOptions = {}
): Promise<TtsSynthesizeResult> {
  const text = input.text.trim()
  if (!text)
    throw new TtsError('config', 'texto para a síntese de fala está vazio', { backend: 'api' })
  const format: TtsFormat = input.format ?? 'wav'
  if (input.settings.backend === 'local') return synthesizeLocal(text, input.settings, format, opts)
  return synthesizeApi(text, input.settings, format, opts)
}

async function synthesizeLocal(
  text: string,
  settings: TtsSettings,
  format: TtsFormat,
  opts: TtsSynthesizeOptions
): Promise<TtsSynthesizeResult> {
  const local = opts.local
  if (!local)
    throw new TtsError('config', 'motor local de fala não está pronto', { backend: 'local' })
  if (!settings.local)
    throw new TtsError('config', 'nenhum motor local de fala configurado', { backend: 'local' })
  const voice = settings.local.voice.trim()
  const r = await local.synthesize({ text, voice, format, signal: opts.signal })
  return { ...r, backend: 'local' }
}

async function synthesizeApi(
  text: string,
  settings: TtsSettings,
  format: TtsFormat,
  opts: TtsSynthesizeOptions
): Promise<TtsSynthesizeResult> {
  const api = settings.api
  const baseUrl = api.baseUrl.trim().replace(/\/+$/, '')
  const model = api.model.trim()
  if (!baseUrl)
    throw new TtsError('config', 'endereço da API de síntese de fala não configurado', {
      backend: 'api'
    })
  if (!model)
    throw new TtsError('config', 'modelo de síntese de fala não configurado', { backend: 'api' })
  const key = api.apiKey.trim()
  const url = `${baseUrl}/audio/speech`
  const timeoutMs = opts.timeoutMs ?? TTS_DEFAULT_TIMEOUT_MS
  const timeout = AbortSignal.timeout(timeoutMs)
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout
  // JSON `{ model, voice, input, response_format }` (voz ausente = a voz padrão da API)
  const body: Record<string, string> = {
    model,
    input: text,
    response_format: RESPONSE_FORMAT[format]
  }
  const voice = (api.voice ?? '').trim()
  if (voice) body.voice = voice
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'audio/*'
  }
  if (key) headers.Authorization = `Bearer ${key}`

  const t0 = Date.now()
  let res: Response
  let raw: Uint8Array
  try {
    res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal })
    // o corpo também corre sob o timeout/abort: ler fora do try deixava o timeout no meio do
    // download escapar como erro cru (nunca virava `TtsError` 'timeout')
    raw = new Uint8Array(await res.arrayBuffer())
  } catch (e) {
    if (opts.signal?.aborted) throw abortError()
    if (timeout.aborted)
      throw new TtsError(
        'timeout',
        `tempo esgotado na síntese de fala (${timeoutMs / 1000} s) em ${url}`,
        { backend: 'api', cause: e }
      )
    throw new TtsError(
      'network',
      `erro de rede ao sintetizar fala em ${url}: ${connectionErrorText(e)}`,
      { backend: 'api', cause: e }
    )
  }
  if (res.status < 200 || res.status >= 300) {
    throw httpError(res.status, new TextDecoder().decode(raw), url)
  }
  // 2xx: a resposta é o áudio; corpo vazio/JSON é erro legível
  const contentType = (res.headers.get('content-type') ?? '').toLowerCase()
  if (!raw.length || contentType.includes('application/json'))
    throw new TtsError(
      'http',
      `resposta da API sem áudio (HTTP ${res.status}${raw.length ? ` veio ${contentType || 'JSON'}` : ' com corpo vazio'})`,
      { backend: 'api', status: res.status }
    )
  return {
    audio: raw,
    mime: MIME_BY_FORMAT[format],
    model,
    backend: 'api',
    ms: Date.now() - t0
  }
}
