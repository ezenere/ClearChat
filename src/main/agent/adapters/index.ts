// Adaptadores por tipo de provider (ver SPEC.md → "Adaptadores de provider").
// Cada adaptador define o TRANSPORTE: endpoint de chat, headers e headers do /models. O body é
// montado por buildRequest (request.ts: OpenAI-compatible ou buildAnthropicBody), o parse do
// stream por streamChat (llm.ts, despachando por BuiltRequest.kind) e o /models por providers.ts.
import { providerKind, type ProviderKind } from '@shared/providerKinds'
import type { Provider } from '@shared/types'
import { anthropicHeaders, messagesUrl } from './anthropic'
import { buildHeaders, chatCompletionsUrl } from './openai'

export interface ProviderAdapter {
  kind: ProviderKind
  /** URL do endpoint de chat (streaming). */
  chatUrl(baseUrl: string): string
  /** Headers da chamada de chat (auth + assinatura de app + provider.headers). */
  headers(
    provider: Pick<Provider, 'apiKey' | 'headers'>,
    signature?: Record<string, string>
  ): Record<string, string>
  /** Headers de GETs (/models, /key): sem content-type. */
  getHeaders(provider: Pick<Provider, 'apiKey' | 'headers'>): Record<string, string>
}

const withoutContentType = (h: Record<string, string>): Record<string, string> => {
  const out = { ...h }
  for (const k of Object.keys(out)) if (k.toLowerCase() === 'content-type') delete out[k]
  return out
}

const openaiLike = (kind: ProviderKind): ProviderAdapter => ({
  kind,
  chatUrl: chatCompletionsUrl,
  headers: buildHeaders,
  getHeaders: (p) => withoutContentType(buildHeaders(p))
})

const ADAPTERS: Record<ProviderKind, ProviderAdapter> = {
  openai: openaiLike('openai'),
  openrouter: openaiLike('openrouter'),
  anthropic: {
    kind: 'anthropic',
    chatUrl: messagesUrl,
    headers: anthropicHeaders,
    getHeaders: (p) => withoutContentType(anthropicHeaders(p))
  },
  // provedor só de VOZ (TTS/STT — `voice/elevenlabs*.ts`): nunca serve de chat; os headers servem
  // para os GETs da API dela (`xi-api-key`)
  elevenlabs: {
    kind: 'elevenlabs',
    chatUrl: () => {
      throw new Error(
        'A ElevenLabs é um provedor de voz (fala/transcrição), não de chat — escolha outro provedor para o modelo.'
      )
    },
    headers: (p) => elevenLabsAuthHeaders(p),
    getHeaders: (p) => elevenLabsAuthHeaders(p)
  }
}

function elevenLabsAuthHeaders(p: Pick<Provider, 'apiKey' | 'headers'>): Record<string, string> {
  const h: Record<string, string> = { ...(p.headers ?? {}) }
  if (p.apiKey) h['xi-api-key'] = p.apiKey
  return h
}

export function adapterFor(
  p: ProviderKind | (Pick<Provider, 'baseUrl'> & { kind?: unknown })
): ProviderAdapter {
  return ADAPTERS[typeof p === 'string' ? p : providerKind(p)]
}

export { buildHeaders, chatCompletionsUrl }
