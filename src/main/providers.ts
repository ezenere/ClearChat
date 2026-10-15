// providers.listModels / providers.test — GET {baseUrl}/models (mapeia campos do OpenRouter).
import { isOpenRouter } from '@shared/defaults'
import type { ProviderTestInput, ProviderTestResult } from '@shared/ipc'
import type { ModelInfo, Provider } from '@shared/types'
import { buildHeaders } from './agent/request'
import { readableError } from './agent/llm'

const CACHE_MS = 5 * 60_000
const cache = new Map<string, { at: number; key: string; models: ModelInfo[] }>()

const num = (v: unknown): number | undefined => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN
  return Number.isFinite(n) ? n : undefined
}

export function mapModel(m: Record<string, unknown>): ModelInfo | null {
  const id = typeof m.id === 'string' ? m.id : null
  if (!id) return null
  const info: ModelInfo = { id }
  if (typeof m.name === 'string' && m.name) info.name = m.name
  const ctx =
    num(m.context_length) ??
    num((m.top_provider as Record<string, unknown> | undefined)?.context_length) ??
    num(m.context_window) ??
    num(m.max_context_length)
  if (ctx !== undefined) info.contextLength = ctx
  const pricing = m.pricing as Record<string, unknown> | undefined
  if (pricing) {
    const p = num(pricing.prompt)
    const c = num(pricing.completion)
    if (p !== undefined && p >= 0) info.promptPrice = p
    if (c !== undefined && c >= 0) info.completionPrice = c
  }
  const arch = m.architecture as Record<string, unknown> | undefined
  if (arch && Array.isArray(arch.input_modalities)) {
    info.inputModalities = (arch.input_modalities as unknown[]).filter(
      (x): x is string => typeof x === 'string'
    )
  }
  if (Array.isArray(m.supported_parameters)) {
    info.supportsTools = (m.supported_parameters as unknown[]).includes('tools')
  }
  return info
}

async function fetchModels(
  p: Pick<Provider, 'baseUrl' | 'apiKey' | 'headers'>
): Promise<ModelInfo[]> {
  const base = p.baseUrl.replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(base)) throw new Error('Base URL inválida (use http:// ou https://).')
  const headers = buildHeaders({ id: '', name: '', createdAt: 0, ...p, headers: p.headers ?? {} })
  delete headers['Content-Type']
  let res: Response
  try {
    res = await fetch(`${base}/models`, { headers, signal: AbortSignal.timeout(20_000) })
  } catch (e) {
    const cause = (e as { cause?: { message?: string } }).cause
    throw new Error(
      `Falha de rede: ${(e as Error).message}${cause?.message ? ` (${cause.message})` : ''}`,
      { cause: e }
    )
  }
  const text = await res.text()
  if (!res.ok) throw new Error(readableError(res.status, res.statusText, text))
  let j: unknown
  try {
    j = JSON.parse(text)
  } catch {
    throw new Error('Resposta de /models não é JSON.')
  }
  const list = Array.isArray(j)
    ? j
    : Array.isArray((j as { data?: unknown }).data)
      ? (j as { data: unknown[] }).data
      : Array.isArray((j as { models?: unknown }).models)
        ? (j as { models: unknown[] }).models
        : null
  if (!list) throw new Error('Formato inesperado da resposta de /models.')
  return list
    .map((m) => (m && typeof m === 'object' ? mapModel(m as Record<string, unknown>) : null))
    .filter((m): m is ModelInfo => !!m)
    .sort((a, b) => a.id.localeCompare(b.id))
}

export async function listModels(provider: Provider): Promise<ModelInfo[]> {
  const key = `${provider.baseUrl}|${provider.apiKey}|${JSON.stringify(provider.headers)}`
  const c = cache.get(provider.id)
  if (c && c.key === key && Date.now() - c.at < CACHE_MS) return c.models
  const models = await fetchModels(provider)
  cache.set(provider.id, { at: Date.now(), key, models })
  return models
}

export function invalidateModels(providerId: string): void {
  cache.delete(providerId)
}

export async function testProvider(p: ProviderTestInput): Promise<ProviderTestResult> {
  try {
    const base = (p.baseUrl ?? '').trim().replace(/\/+$/, '')
    const input = { baseUrl: base, apiKey: (p.apiKey ?? '').trim(), headers: p.headers ?? {} }
    const models = await fetchModels(input)
    // /models do OpenRouter é público: valida a key em /key.
    if (isOpenRouter(base)) {
      if (!input.apiKey)
        return { ok: false, error: 'Informe a API key.', modelCount: models.length }
      const headers = buildHeaders({ id: '', name: '', createdAt: 0, ...input })
      delete headers['Content-Type']
      const res = await fetch(`${base}/key`, { headers, signal: AbortSignal.timeout(20_000) })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        return {
          ok: false,
          error: readableError(res.status, res.statusText, text),
          modelCount: models.length
        }
      }
    }
    return { ok: true, modelCount: models.length }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}
