// Tipos de provider (adaptadores). Ver SPEC.md → "Adaptadores de provider".
// - 'openai'     → OpenAI-compatible genérico: POST {baseUrl}/chat/completions, GET {baseUrl}/models.
// - 'openrouter' → OpenAI-compatible + extras do OpenRouter (usage.include, reasoning, cache_control,
//                   input_modalities no /models, file-parser de PDF para qualquer modelo, /key).
// - 'anthropic'  → API nativa da Anthropic: POST {baseUrl}/messages (x-api-key + anthropic-version),
//                   GET {baseUrl}/models (capabilities.image_input / pdf_input). PDF via bloco `document`.
import type { Provider } from './types'

export const PROVIDER_KINDS = ['openai', 'openrouter', 'anthropic'] as const
export type ProviderKind = (typeof PROVIDER_KINDS)[number]

export const PROVIDER_KIND_LABEL: Record<ProviderKind, string> = {
  openai: 'OpenAI-compatible (genérico)',
  openrouter: 'OpenRouter',
  anthropic: 'Anthropic (API nativa)'
}

export const PROVIDER_KIND_DEFAULT_URL: Record<ProviderKind, string> = {
  openai: 'https://api.openai.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  anthropic: 'https://api.anthropic.com/v1'
}

export const ANTHROPIC_VERSION = '2023-06-01'

export const isProviderKind = (v: unknown): v is ProviderKind =>
  typeof v === 'string' && (PROVIDER_KINDS as readonly string[]).includes(v)

/** Tipo inferido pela base URL (migração de providers antigos / sugestão no formulário). */
export function inferProviderKind(baseUrl: string): ProviderKind {
  const u = (baseUrl ?? '').toLowerCase()
  if (u.includes('openrouter.ai')) return 'openrouter'
  if (u.includes('api.anthropic.com')) return 'anthropic'
  return 'openai'
}

/** Tipo efetivo do provider (campo `kind`, ou inferido pela URL se ausente/inválido). */
export function providerKind(p: Pick<Provider, 'baseUrl'> & { kind?: unknown }): ProviderKind {
  return isProviderKind(p.kind) ? p.kind : inferProviderKind(p.baseUrl)
}
