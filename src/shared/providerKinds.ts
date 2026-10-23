// Tipos de provider (adaptadores). Ver SPEC.md → "Adaptadores de provider".
// - 'openai'     → OpenAI-compatible genérico: POST {baseUrl}/chat/completions, GET {baseUrl}/models.
// - 'openrouter' → OpenAI-compatible + extras do OpenRouter (usage.include, reasoning, cache_control,
//                   input_modalities no /models, file-parser de PDF para qualquer modelo, /key).
// - 'anthropic'  → API nativa da Anthropic: POST {baseUrl}/messages (x-api-key + anthropic-version),
//                   GET {baseUrl}/models (capabilities.image_input / pdf_input). PDF via bloco `document`.
// - 'elevenlabs' → provedor de VOZ (não é de chat): ElevenLabs direta — TTS REST/WebSocket
//                   (`/v1/text-to-speech/…`), header `xi-api-key`, "Testar conexão" = GET /v1/models.
//                   Não aparece nos seletores de modelo de chat (`isChatProvider`).
import type { Provider } from './types'

export const PROVIDER_KINDS = ['openai', 'openrouter', 'anthropic', 'elevenlabs'] as const
export type ProviderKind = (typeof PROVIDER_KINDS)[number]

export const PROVIDER_KIND_LABEL: Record<ProviderKind, string> = {
  openai: 'OpenAI-compatible (genérico)',
  openrouter: 'OpenRouter',
  anthropic: 'Anthropic (API nativa)',
  elevenlabs: 'ElevenLabs (voz)'
}

export const PROVIDER_KIND_DEFAULT_URL: Record<ProviderKind, string> = {
  openai: 'https://api.openai.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  anthropic: 'https://api.anthropic.com/v1',
  elevenlabs: 'https://api.elevenlabs.io'
}

/** O que cada tipo serve: chat (LLM) e/ou voz (TTS/STT). */
export type ProviderCapability = 'chat' | 'tts' | 'stt'
export const PROVIDER_KIND_CAPABILITIES: Record<ProviderKind, readonly ProviderCapability[]> = {
  openai: ['chat', 'tts', 'stt'],
  openrouter: ['chat', 'tts', 'stt'],
  anthropic: ['chat'],
  elevenlabs: ['tts'] // STT (Scribe) direto ainda não implementado
}

/** O tipo serve como provedor de chat (aparece nos seletores de modelo)? */
export const isChatProviderKind = (kind: ProviderKind): boolean =>
  PROVIDER_KIND_CAPABILITIES[kind].includes('chat')

export const ANTHROPIC_VERSION = '2023-06-01'

export const isProviderKind = (v: unknown): v is ProviderKind =>
  typeof v === 'string' && (PROVIDER_KINDS as readonly string[]).includes(v)

/** Tipo inferido pela base URL (migração de providers antigos / sugestão no formulário). */
export function inferProviderKind(baseUrl: string): ProviderKind {
  const u = (baseUrl ?? '').toLowerCase()
  if (u.includes('openrouter.ai')) return 'openrouter'
  if (u.includes('api.anthropic.com')) return 'anthropic'
  if (u.includes('elevenlabs.io')) return 'elevenlabs'
  return 'openai'
}

/** Tipo efetivo do provider (campo `kind`, ou inferido pela URL se ausente/inválido). */
export function providerKind(p: Pick<Provider, 'baseUrl'> & { kind?: unknown }): ProviderKind {
  return isProviderKind(p.kind) ? p.kind : inferProviderKind(p.baseUrl)
}

/** O provider serve para chat (LLM)? Provedores só de voz (ElevenLabs) ficam fora dos seletores. */
export const isChatProvider = (p: Pick<Provider, 'baseUrl'> & { kind?: unknown }): boolean =>
  isChatProviderKind(providerKind(p))
