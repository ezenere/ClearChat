// Adaptadores 'openai' (genérico) e 'openrouter': transporte OpenAI-compatible
// (POST {baseUrl}/chat/completions, Authorization: Bearer). O body é montado em request.ts.
import type { Provider } from '@shared/types'

/**
 * Headers: Content-Type, Authorization, assinatura de app (HTTP-Referer/X-Title, qualquer provider)
 * e por último provider.headers (sobrescrevem).
 */
export function buildHeaders(
  provider: Pick<Provider, 'apiKey' | 'headers'>,
  appSignature: Record<string, string> = {}
): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' }
  if (provider.apiKey) h['Authorization'] = `Bearer ${provider.apiKey}`
  Object.assign(h, appSignature)
  for (const [k, v] of Object.entries(provider.headers ?? {})) {
    if (typeof v === 'string') h[k] = v
  }
  return h
}

export function chatCompletionsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/chat/completions`
}
