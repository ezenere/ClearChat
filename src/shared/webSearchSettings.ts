// Configuração GLOBAL do web_search: buscadores (ordem = prioridade, liga/desliga, opções), chaves de
// API (só no main; o renderer recebe a máscara) e o intervalo mínimo entre pesquisas.
// Puro (main, renderer e testes). Ver SPEC.md → web_search.
import { LIMITS } from './limits'
import { STT_SETTINGS_SETTING, TTS_SETTINGS_SETTING } from './voice'

// ---------------- intervalo mínimo entre pesquisas ----------------

/** Setting genérico (settings:get/set), em segundos. Lido pelo main a cada pesquisa (tools/web.ts). */
export const SEARCH_INTERVAL_SETTING = 'webSearchMinIntervalSec'
export const SEARCH_INTERVAL_DEFAULT_S = 5
export const SEARCH_INTERVAL_MAX_S = 60

/** Número de 0 a 60 (1 casa decimal); ausente/inválido → padrão (5). */
export function normalizeSearchInterval(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN
  if (!Number.isFinite(n)) return SEARCH_INTERVAL_DEFAULT_S
  return Math.min(SEARCH_INTERVAL_MAX_S, Math.max(0, Math.round(n * 10) / 10))
}

// ---------------- buscadores ----------------

export type SearchEngineId = 'ddg' | 'brave-site' | 'brave-api' | 'exa' | 'tavily'
/** Buscadores que exigem chave de API. */
export type ApiEngineId = 'brave-api' | 'exa' | 'tavily'
export type TavilyDepth = 'basic' | 'advanced'

export interface EngineOptions {
  /** Resultados pedidos à API (1–10). Só buscadores com API. */
  maxResults?: number
  /** Tavily: search_depth. */
  depth?: TavilyDepth
}

export interface EngineConfig {
  id: SearchEngineId
  enabled: boolean
  options: EngineOptions
}

export interface EngineMeta {
  id: SearchEngineId
  /** Nome na UI. */
  label: string
  /** Nome na saída da tool ("Resultados de <x> para …"). */
  outputLabel: string
  needsKey: boolean
  description: string
  site: string
  docs?: string
  /** Placeholder do campo de chave. */
  keyHint?: string
}

export const ENGINE_META: Record<SearchEngineId, EngineMeta> = {
  ddg: {
    id: 'ddg',
    label: 'DuckDuckGo',
    outputLabel: 'DuckDuckGo',
    needsKey: false,
    description: 'HTML do DuckDuckGo. Buscas seguidas podem pedir captcha.',
    site: 'https://duckduckgo.com/'
  },
  'brave-site': {
    id: 'brave-site',
    label: 'Brave (site)',
    outputLabel: 'Brave Search (site)',
    needsKey: false,
    description: 'Página de resultados do search.brave.com, num navegador oculto.',
    site: 'https://search.brave.com/'
  },
  'brave-api': {
    id: 'brave-api',
    label: 'Brave Search API',
    outputLabel: 'Brave Search API',
    needsKey: true,
    description: 'API oficial de busca web do Brave (/res/v1/web/search).',
    site: 'https://brave.com/search/api/',
    docs: 'https://api-dashboard.search.brave.com/app/documentation/web-search/get-started',
    keyHint: 'BSA…'
  },
  exa: {
    id: 'exa',
    label: 'Exa',
    outputLabel: 'Exa',
    needsKey: true,
    description: 'Busca neural, com os trechos mais relevantes de cada página.',
    site: 'https://exa.ai/',
    docs: 'https://exa.ai/docs/reference/search',
    keyHint: 'chave da Exa'
  },
  tavily: {
    id: 'tavily',
    label: 'Tavily',
    outputLabel: 'Tavily',
    needsKey: true,
    description: 'Busca feita para agentes de IA, com trechos de cada página.',
    site: 'https://tavily.com/',
    docs: 'https://docs.tavily.com/documentation/api-reference/endpoint/search',
    keyHint: 'tvly-…'
  }
}

export const ENGINE_IDS: SearchEngineId[] = ['ddg', 'brave-site', 'brave-api', 'exa', 'tavily']
export const API_ENGINE_IDS: ApiEngineId[] = ['brave-api', 'exa', 'tavily']
export const isApiEngine = (id: SearchEngineId): id is ApiEngineId => ENGINE_META[id].needsKey

export const SEARCH_RESULTS_MIN = 1
export const SEARCH_RESULTS_MAX = LIMITS.webMaxResultsCap
export const TAVILY_DEPTH_DEFAULT: TavilyDepth = 'advanced'

/** Ordem/estado padrão (instalação nova ou migrada): o comportamento de antes — DuckDuckGo →
 * Brave (site) — e as três APIs desligadas até ter chave. */
export const DEFAULT_ENGINES: EngineConfig[] = ENGINE_IDS.map((id) => ({
  id,
  enabled: !ENGINE_META[id].needsKey,
  options: defaultOptions(id)
}))

/** Setting com a lista ordenada de buscadores (EngineConfig[]). */
export const SEARCH_ENGINES_SETTING = 'webSearchEngines'
/** Setting com as chaves ({ [ApiEngineId]: string }) — NUNCA sai do main por settings:get. */
export const SEARCH_KEYS_SETTING = 'webSearchApiKeys'
/**
 * Settings que o settings:get/set genérico do renderer não pode ler nem escrever (a chave real
 * nunca sai do main por aqui; os domínios dedicados — `webSearch:*` e `voice:settings:*` — devolvem
 * máscaras e só gravam por cima do valor mascarado sem apagar a chave). Os grupos `sttSettings` e
 * `ttsSettings` guardam `api.apiKey` no JSON (`src/shared/voice.ts`).
 */
export const PROTECTED_SETTINGS: readonly string[] = [
  SEARCH_KEYS_SETTING,
  STT_SETTINGS_SETTING,
  TTS_SETTINGS_SETTING
]

export function defaultOptions(id: SearchEngineId): EngineOptions {
  if (!isApiEngine(id)) return {}
  return id === 'tavily'
    ? { maxResults: LIMITS.webMaxResults, depth: TAVILY_DEPTH_DEFAULT }
    : { maxResults: LIMITS.webMaxResults }
}

export function normalizeOptions(id: SearchEngineId, v: unknown): EngineOptions {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  const d = defaultOptions(id)
  if (!isApiEngine(id)) return d
  const n = typeof o.maxResults === 'number' ? o.maxResults : Number(o.maxResults)
  const out: EngineOptions = {
    maxResults: Number.isFinite(n)
      ? Math.min(SEARCH_RESULTS_MAX, Math.max(SEARCH_RESULTS_MIN, Math.round(n)))
      : d.maxResults
  }
  if (id === 'tavily') out.depth = o.depth === 'basic' || o.depth === 'advanced' ? o.depth : d.depth
  return out
}

/**
 * Lista ordenada e completa a partir do valor salvo (qualquer formato; idempotente): ids
 * desconhecidos e repetidos saem, os que faltam entram no fim (estado padrão), opções normalizadas.
 * Buscador que exige chave sem chave salva fica DESLIGADO (`hasKey`).
 */
export function normalizeEngines(
  v: unknown,
  hasKey: (id: ApiEngineId) => boolean = () => false
): EngineConfig[] {
  const raw = Array.isArray(v) ? v : []
  const seen = new Set<SearchEngineId>()
  const out: EngineConfig[] = []
  const push = (id: SearchEngineId, enabled: boolean, options: unknown): void => {
    seen.add(id)
    out.push({
      id,
      enabled: enabled && (!isApiEngine(id) || hasKey(id)),
      options: normalizeOptions(id, options)
    })
  }
  for (const e of raw) {
    const id = (e && typeof e === 'object' ? (e as { id?: unknown }).id : e) as SearchEngineId
    if (typeof id !== 'string' || !(id in ENGINE_META) || seen.has(id)) continue
    const en = e && typeof e === 'object' ? (e as { enabled?: unknown }).enabled : undefined
    push(
      id,
      typeof en === 'boolean' ? en : !ENGINE_META[id].needsKey,
      (e as { options?: unknown })?.options
    )
  }
  for (const d of DEFAULT_ENGINES) if (!seen.has(d.id)) push(d.id, d.enabled, d.options)
  return out
}

/** Chaves salvas (só strings não vazias de buscadores com API). */
export function normalizeKeys(v: unknown): Partial<Record<ApiEngineId, string>> {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  const out: Partial<Record<ApiEngineId, string>> = {}
  for (const id of API_ENGINE_IDS) {
    const k = o[id]
    if (typeof k === 'string' && k.trim()) out[id] = k.trim()
  }
  return out
}

/** "tvly-…abcd" / "sk-…abcd" / "…abcd" (chaves curtas: só "••••"). */
export function maskKey(key: string | null | undefined): string | null {
  const k = (key ?? '').trim()
  if (!k) return null
  if (k.length < 10) return '••••'
  const prefix = /^[A-Za-z]{2,5}[-_]/.exec(k)?.[0] ?? ''
  return `${prefix}…${k.slice(-4)}`
}

// ---------------- requests das APIs (fonte única: main envia, (i) da UI mostra) ----------------

export const ENGINE_DEFAULT_BASE: Record<SearchEngineId, string> = {
  ddg: 'https://html.duckduckgo.com/html/',
  'brave-site': 'https://search.brave.com/search',
  'brave-api': 'https://api.search.brave.com',
  exa: 'https://api.exa.ai',
  tavily: 'https://api.tavily.com'
}

/** Variável de ambiente que troca a base de um buscador (testes / proxies): CLEARCHAT_SEARCH_BASE_EXA… */
export const engineBaseEnv = (id: SearchEngineId): string =>
  `CLEARCHAT_SEARCH_BASE_${id.replace('-', '_').toUpperCase()}`

export interface EngineHttpRequest {
  method: 'GET' | 'POST'
  url: string
  headers: Record<string, string>
  body?: string
}

/** Request exata de uma pesquisa numa API (a chave vai em claro — para a (i), passe um marcador). */
export function buildEngineRequest(
  id: ApiEngineId,
  query: string,
  key: string,
  options: EngineOptions,
  base: string = ENGINE_DEFAULT_BASE[id]
): EngineHttpRequest {
  const b = base.replace(/\/+$/, '')
  const o = normalizeOptions(id, options)
  if (id === 'brave-api') {
    const qs = new URLSearchParams({ q: query, count: String(o.maxResults) })
    return {
      method: 'GET',
      url: `${b}/res/v1/web/search?${qs.toString()}`,
      headers: {
        Accept: 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': key
      }
    }
  }
  if (id === 'exa')
    return {
      method: 'POST',
      url: `${b}/search`,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ query, numResults: o.maxResults, contents: { highlights: true } })
    }
  return {
    method: 'POST',
    url: `${b}/search`,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ query, search_depth: o.depth, max_results: o.maxResults })
  }
}

/** Move o item `from` para a posição `to` (arrastar ou ↑/↓); índices fora da lista → cópia igual. */
export function moveEngine<T>(list: T[], from: number, to: number): T[] {
  const out = list.slice()
  if (from < 0 || from >= out.length || to < 0 || to >= out.length || from === to) return out
  const [it] = out.splice(from, 1)
  out.splice(to, 0, it)
  return out
}

/** Request da API como texto para a (i): chave e consulta trocadas por marcadores. */
export function describeEngineRequest(id: ApiEngineId, options: EngineOptions): string {
  const Q = '{consulta}'
  const req = buildEngineRequest(id, Q, '{sua chave}', options)
  const url = req.url.replace(encodeURIComponent(Q), Q)
  const headers = Object.entries(req.headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n')
  const body = req.body ? `\n\n${JSON.stringify(JSON.parse(req.body), null, 2)}` : ''
  return `${req.method} ${url}\n${headers}${body}`
}
