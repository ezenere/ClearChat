// Parse das respostas das APIs de busca (Exa, Tavily, Brave Search API) e classificação das falhas
// HTTP — puro, sem Electron. As requests vêm de buildEngineRequest (@shared/webSearchSettings).
import type { ApiEngineId } from '@shared/webSearchSettings'
import { decodeEntities, type SearchResult } from './ddg'

export interface ApiParsed {
  results: SearchResult[]
  /** Resposta resumida do próprio buscador (Tavily `answer`), se veio. */
  answer?: string
}

/** Categoria de falha de um buscador (todas disparam o fallback para o próximo). */
export type FailCategory = 'no-key' | 'auth' | 'quota' | 'blocked' | 'network' | 'http' | 'empty'

export interface EngineFailure {
  category: FailCategory
  /** Motivo curto (pt-BR), ex.: "chave inválida ou sem permissão (HTTP 401)". */
  message: string
}

const clean = (s: unknown): string =>
  typeof s === 'string'
    ? decodeEntities(s.replace(/<[^>]*>/g, ''))
        .replace(/\s+/g, ' ')
        .trim()
    : ''

/** ISO / RFC 2822 → AAAA-MM-DD; texto que não é data (ex.: "2 days ago") volta curto. */
export function shortDate(v: unknown): string | undefined {
  if (typeof v !== 'string' || !v.trim()) return undefined
  const s = v.trim()
  const iso = /^(\d{4}-\d{2}-\d{2})/.exec(s)
  if (iso) return iso[1]
  const t = Date.parse(s)
  if (Number.isFinite(t) && /\d{4}/.test(s)) return new Date(t).toISOString().slice(0, 10)
  return s.length > 30 ? undefined : s
}

/** Junta trechos até ~limite (o formatador corta de novo). */
function joinSnippets(parts: unknown[], limit = 600): string {
  let out = ''
  for (const p of parts) {
    const t = clean(p)
    if (!t || out.includes(t)) continue
    out = out ? `${out} … ${t}` : t
    if (out.length >= limit) break
  }
  return out
}

const isUrl = (u: unknown): u is string => typeof u === 'string' && /^https?:\/\//i.test(u)

function dedupe(rs: SearchResult[]): SearchResult[] {
  const out: SearchResult[] = []
  for (const r of rs) if (r.url && !out.some((x) => x.url === r.url)) out.push(r)
  return out
}

/** POST https://api.exa.ai/search → `results[]` { title, url, publishedDate, highlights[], text?, summary? }. */
export function parseExaJson(json: unknown): ApiParsed | null {
  const rs = (json as { results?: unknown })?.results
  if (!Array.isArray(rs)) return null
  return {
    results: dedupe(
      rs
        .filter((r) => r && isUrl(r.url))
        .map((r) => ({
          title: clean(r.title) || r.url,
          url: r.url,
          snippet: joinSnippets([
            ...(Array.isArray(r.highlights) ? r.highlights : []),
            r.summary,
            typeof r.text === 'string' ? r.text.slice(0, 600) : ''
          ]),
          date: shortDate(r.publishedDate)
        }))
    )
  }
}

/** POST https://api.tavily.com/search → `results[]` { title, url, content, published_date? } + `answer?`. */
export function parseTavilyJson(json: unknown): ApiParsed | null {
  const o = json as { results?: unknown; answer?: unknown }
  if (!Array.isArray(o?.results)) return null
  const answer = clean(o.answer)
  return {
    results: dedupe(
      o.results
        .filter((r) => r && isUrl(r.url))
        .map((r) => ({
          title: clean(r.title) || r.url,
          url: r.url,
          snippet: clean(r.content),
          date: shortDate(r.published_date)
        }))
    ),
    ...(answer ? { answer } : {})
  }
}

/**
 * GET https://api.search.brave.com/res/v1/web/search → `web.results[]` { title, url, description
 * (com <strong>), page_age?, age?, extra_snippets? }. Sem `web` (só "mixed"/outros) = 0 resultados.
 */
export function parseBraveApiJson(json: unknown): ApiParsed | null {
  const o = json as { type?: unknown; web?: { results?: unknown }; query?: unknown }
  if (!o || typeof o !== 'object' || (o.type !== undefined && o.type !== 'search')) return null
  if (!o.web && !o.query) return null
  const rs = Array.isArray(o.web?.results) ? (o.web.results as Record<string, unknown>[]) : []
  return {
    results: dedupe(
      rs
        .filter((r) => r && isUrl(r.url))
        .map((r) => ({
          title: clean(r.title) || (r.url as string),
          url: r.url as string,
          snippet: joinSnippets([
            r.description,
            ...(Array.isArray(r.extra_snippets) ? r.extra_snippets : [])
          ]),
          date: shortDate(r.page_age) ?? shortDate(r.age)
        }))
    )
  }
}

export const API_PARSERS: Record<ApiEngineId, (json: unknown) => ApiParsed | null> = {
  exa: parseExaJson,
  tavily: parseTavilyJson,
  'brave-api': parseBraveApiJson
}

/** Mensagem de erro do corpo (Exa `error`, Tavily `detail`, Brave `error.detail`…), curta. */
export function errorDetail(text: string): string {
  let msg: string
  try {
    const j = JSON.parse(text) as Record<string, unknown>
    const e = j.error
    const cand =
      (e && typeof e === 'object' ? (e as Record<string, unknown>).detail : e) ??
      j.detail ??
      j.message
    msg =
      typeof cand === 'string'
        ? cand
        : cand && typeof cand === 'object'
          ? String(
              (cand as Record<string, unknown>).error ??
                (cand as Record<string, unknown>).msg ??
                JSON.stringify(cand)
            )
          : ''
  } catch {
    msg = /<html/i.test(text) ? '' : text
  }
  msg = msg.replace(/\s+/g, ' ').trim()
  return msg.length > 120 ? `${msg.slice(0, 120)}…` : msg
}

/**
 * Falha HTTP → categoria + motivo curto. 401/403 (e o 422 de token inválido do Brave) = chave;
 * 402/429/432/433 = limite de uso/cota; o resto = HTTP genérico.
 */
export function classifyHttp(status: number, text: string): EngineFailure {
  const detail = errorDetail(text)
  const tail = detail ? ` — ${detail}` : ''
  if (status === 401 || status === 403 || (status === 422 && /TOKEN_INVALID|token/i.test(text)))
    return {
      category: 'auth',
      message: `chave de API inválida ou sem permissão (HTTP ${status})${tail}`
    }
  if (status === 402 || status === 429 || status === 432 || status === 433)
    return { category: 'quota', message: `limite de uso/cota atingido (HTTP ${status})${tail}` }
  return { category: 'http', message: `HTTP ${status}${tail}` }
}
