// Orquestração do web_search (pura, sem Electron): UM buscador por pesquisa — o primeiro habilitado
// na ordem configurada; se ele FALHAR (sem chave, chave inválida, cota/limite, captcha/bloqueio,
// rede, resposta vazia/inválida) tenta o próximo. Nunca mistura resultados de buscadores.
// Os "fetchers" são injetados (web.ts liga os reais; os testes passam mocks).
import { LIMITS } from '@shared/limits'
import {
  buildEngineRequest,
  DEFAULT_ENGINES,
  ENGINE_DEFAULT_BASE,
  ENGINE_META,
  isApiEngine,
  type ApiEngineId,
  type EngineHttpRequest,
  type EngineOptions,
  type SearchEngineId
} from '@shared/webSearchSettings'
import { parseDdgHtml, type SearchResult } from './ddg'
import { isBraveBlocked, parseBraveHtml } from './brave'
import { API_PARSERS, classifyHttp, type EngineFailure } from './searchApis'
import { abortError, fail, ok, type ToolResult } from './util'

export interface SearchPage {
  html: string
  /** Código HTTP da resposta principal, se conhecido. */
  status?: number
}

export interface HttpResponse {
  status: number
  text: string
}

export interface SearchBackends {
  /** HTML de https://html.duckduckgo.com/html/ (lança em erro HTTP/rede). */
  ddg: (query: string, method: 'POST' | 'GET', signal: AbortSignal) => Promise<string>
  /** HTML (renderizado) de https://search.brave.com/search?q=… */
  brave: (query: string, signal: AbortSignal) => Promise<SearchPage>
  /** HTTP das APIs (Exa, Tavily, Brave Search API). Lança só em erro de rede/timeout. */
  http?: (req: EngineHttpRequest, signal: AbortSignal) => Promise<HttpResponse>
  /** Base de cada API (padrão: ENGINE_DEFAULT_BASE; testes/E2E trocam). */
  bases?: Partial<Record<ApiEngineId, string>>
}

/** Um buscador da pesquisa (habilitado, na ordem), com a chave quando exige. */
export interface PlanEntry {
  id: SearchEngineId
  options?: EngineOptions
  key?: string
}

/** Plano padrão (sem config): DuckDuckGo → Brave (site). */
export const DEFAULT_PLAN: PlanEntry[] = DEFAULT_ENGINES.filter((e) => e.enabled).map((e) => ({
  id: e.id,
  options: e.options
}))

export type DdgOutcome =
  | { kind: 'results'; results: SearchResult[] }
  | { kind: 'empty' } // página "sem resultados" legítima
  | { kind: 'blocked' } // captcha / anomaly
  | { kind: 'error'; message: string } // HTTP / rede
  | { kind: 'suspect' } // 0 resultados sem a marca de "sem resultados" (layout mudou / bloqueio)

/** Resultado de UM buscador: resultados, "sem resultados" legítimo (não faz fallback) ou falha. */
export type EngineOutcome =
  | { kind: 'results'; results: SearchResult[]; answer?: string }
  | { kind: 'empty' }
  | ({ kind: 'fail' } & EngineFailure)

export function isDdgBlocked(html: string): boolean {
  return /anomaly-modal|anomaly\.js|bots use DuckDuckGo|captcha/i.test(html)
}

export async function searchDdg(
  query: string,
  fetchDdg: SearchBackends['ddg'],
  signal: AbortSignal
): Promise<DdgOutcome> {
  let blocked = false
  let suspect = false
  let lastErr = ''
  for (const method of ['POST', 'GET'] as const) {
    try {
      const html = await fetchDdg(query, method, signal)
      const results = parseDdgHtml(html)
      if (results.length) return { kind: 'results', results }
      if (isDdgBlocked(html)) blocked = true
      else if (/no-results|Nenhum resultado|No results/i.test(html)) return { kind: 'empty' }
      else suspect = true
    } catch (e) {
      if (signal.aborted) throw abortError()
      lastErr = (e as Error).message
    }
  }
  if (blocked) return { kind: 'blocked' }
  if (suspect) return { kind: 'suspect' }
  return { kind: 'error', message: lastErr || 'falha desconhecida' }
}

async function runDdg(
  query: string,
  b: SearchBackends,
  signal: AbortSignal
): Promise<EngineOutcome> {
  const o = await searchDdg(query, b.ddg, signal)
  if (o.kind === 'results' || o.kind === 'empty') return o
  if (o.kind === 'blocked')
    return { kind: 'fail', category: 'blocked', message: 'verificação anti-robô (captcha)' }
  if (o.kind === 'suspect')
    return { kind: 'fail', category: 'empty', message: 'nenhum resultado (possível bloqueio)' }
  return {
    kind: 'fail',
    category: /^HTTP \d/.test(o.message) ? 'http' : 'network',
    message: o.message
  }
}

async function runBraveSite(
  query: string,
  b: SearchBackends,
  signal: AbortSignal
): Promise<EngineOutcome> {
  try {
    const page = await b.brave(query, signal)
    const results = parseBraveHtml(page.html)
    if (results.length) return { kind: 'results', results }
    if (isBraveBlocked(page.html, page.status))
      return {
        kind: 'fail',
        category: 'blocked',
        message: `verificação anti-robô / limite de requisições${page.status ? ` (HTTP ${page.status})` : ''}`
      }
    if (page.status && page.status >= 400)
      return { kind: 'fail', category: 'http', message: `HTTP ${page.status}` }
    return { kind: 'empty' }
  } catch (e) {
    if (signal.aborted || (e as Error).name === 'AbortError') throw abortError()
    return { kind: 'fail', category: 'network', message: (e as Error).message }
  }
}

async function runApi(
  id: ApiEngineId,
  entry: PlanEntry,
  query: string,
  b: SearchBackends,
  signal: AbortSignal
): Promise<EngineOutcome> {
  if (!entry.key) return { kind: 'fail', category: 'no-key', message: 'sem chave de API' }
  if (!b.http) return { kind: 'fail', category: 'network', message: 'HTTP indisponível' }
  const req = buildEngineRequest(
    id,
    query,
    entry.key,
    entry.options ?? {},
    b.bases?.[id] || ENGINE_DEFAULT_BASE[id]
  )
  let res: HttpResponse
  try {
    res = await b.http(req, signal)
  } catch (e) {
    if (signal.aborted || (e as Error).name === 'AbortError') throw abortError()
    const m = (e as Error).message
    return { kind: 'fail', category: 'network', message: `erro de rede: ${m}` }
  }
  if (res.status < 200 || res.status >= 300)
    return { kind: 'fail', ...classifyHttp(res.status, res.text) }
  let json: unknown
  try {
    json = res.text.trim() ? JSON.parse(res.text) : null
  } catch {
    json = undefined
  }
  const parsed = json == null ? null : API_PARSERS[id](json)
  if (!parsed)
    return { kind: 'fail', category: 'empty', message: 'resposta vazia ou em formato inesperado' }
  if (!parsed.results.length)
    return parsed.answer ? { kind: 'results', ...parsed } : { kind: 'empty' }
  return { kind: 'results', ...parsed }
}

/** Roda UM buscador (sem fallback). Abort propaga como AbortError. */
export function runEngine(
  entry: PlanEntry,
  query: string,
  backends: SearchBackends,
  signal: AbortSignal
): Promise<EngineOutcome> {
  if (entry.id === 'ddg') return runDdg(query, backends, signal)
  if (entry.id === 'brave-site') return runBraveSite(query, backends, signal)
  if (isApiEngine(entry.id)) return runApi(entry.id, entry, query, backends, signal)
  return Promise.resolve({ kind: 'fail', category: 'http', message: 'buscador desconhecido' })
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n).trimEnd()}…` : s)

export function formatResults(
  header: string,
  results: SearchResult[],
  opts: { max?: number; answer?: string } = {}
): string {
  const out = results
    .slice(0, Math.min(opts.max ?? LIMITS.webMaxResults, LIMITS.webMaxResultsCap))
    .map((r, i) => {
      const snip = r.snippet ? clip(r.snippet, LIMITS.webSnippetChars) : ''
      const line = r.date ? (snip ? `${r.date} — ${snip}` : r.date) : snip
      return `${i + 1}. ${clip(r.title, 200)}\n   ${r.url}${line ? `\n   ${line}` : ''}`
    })
    .join('\n\n')
  const answer = opts.answer ? `Resposta resumida: ${clip(opts.answer, 600)}\n\n` : ''
  return `${header}:\n\n${answer}${out}`.trimEnd()
}

const label = (id: SearchEngineId): string => ENGINE_META[id].outputLabel

/** " (após falha em DuckDuckGo: captcha; Exa: HTTP 429)" — vazio se ninguém falhou antes. */
function failNote(failures: { id: SearchEngineId; f: EngineFailure }[]): string {
  if (!failures.length) return ''
  return ` (após falha em ${failures.map((x) => `${label(x.id)}: ${x.f.message}`).join('; ')})`
}

/**
 * Pesquisa com fallback: tenta os buscadores do `plan` em ordem e devolve o PRIMEIRO que responder
 * (resultados ou "sem resultados" legítimo). A 1ª linha diz quem respondeu e quem falhou antes.
 * Todos falhando → erro legível citando cada um. Retorna o texto completo (o chamador aplica o teto).
 */
export async function runWebSearch(
  query: string,
  backends: SearchBackends,
  signal: AbortSignal,
  plan: PlanEntry[] = DEFAULT_PLAN
): Promise<ToolResult> {
  if (!plan.length)
    return fail(
      'Erro: nenhum buscador habilitado. Habilite ao menos um em Configurações → Pesquisa na web.'
    )
  const failures: { id: SearchEngineId; f: EngineFailure }[] = []
  for (const entry of plan) {
    if (signal.aborted) throw abortError()
    const o = await runEngine(entry, query, backends, signal)
    if (o.kind === 'results') {
      const header = `Resultados de ${label(entry.id)} para "${query}"${failNote(failures)}`
      return ok(
        formatResults(header, o.results, {
          max: entry.options?.maxResults,
          answer: o.answer
        })
      )
    }
    if (o.kind === 'empty')
      return ok(`Nenhum resultado de ${label(entry.id)} para "${query}"${failNote(failures)}.`)
    failures.push({ id: entry.id, f: { category: o.category, message: o.message } })
  }
  const detail = failures.map((x) => `${label(x.id)}: ${x.f.message}`).join('; ')
  const allBlocked = failures.every((x) => x.f.category === 'blocked')
  const what =
    failures.length === 1
      ? allBlocked
        ? 'a busca foi bloqueada'
        : 'a pesquisa falhou'
      : allBlocked
        ? `a busca foi bloqueada pelos ${failures.length} buscadores habilitados`
        : `a pesquisa falhou nos ${failures.length} buscadores habilitados`
  return fail(
    `Erro: ${what} — ${detail}. Tente novamente mais tarde, ajuste os buscadores em Configurações → Pesquisa na web ou use browse_url.`
  )
}

// ---------------- intervalo mínimo GLOBAL entre pesquisas ----------------

export { normalizeSearchInterval, SEARCH_INTERVAL_SETTING } from '@shared/webSearchSettings'

/** Sleep abortável (rejeita com AbortError e limpa o timer). */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError())
    const onAbort = (): void => {
      clearTimeout(t)
      reject(abortError())
    }
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export interface SearchGateOptions {
  /** Intervalo atual em ms (relido a cada pesquisa: mudar a config vale na hora). */
  intervalMs: () => number
  now?: () => number
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
}

/**
 * Espaça o INÍCIO das pesquisas: fila FIFO (um por vez decide sua vez) + timestamp da última.
 * Quem chega antes do intervalo espera o restante; chamadas simultâneas saem a 0, I, 2I…
 * A fila só é segurada durante a espera (nunca durante a requisição de rede). Abort na fila ou
 * na espera sai sem consumir a vez (o timestamp só muda quando a pesquisa realmente começa).
 */
export class SearchGate {
  private last = -Infinity
  private busy = false
  private readonly queue: (() => void)[] = []
  private readonly now: () => number
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>
  private readonly opts: SearchGateOptions

  constructor(opts: SearchGateOptions) {
    this.opts = opts
    this.now = opts.now ?? Date.now
    this.sleep = opts.sleep ?? abortableSleep
  }

  /** Espera a vez; retorna quantos ms esperou (fila + intervalo). */
  async acquire(signal: AbortSignal, onWait?: (remainingMs: number) => void): Promise<number> {
    const t0 = this.now()
    await this.lock(signal)
    try {
      for (;;) {
        if (signal.aborted) throw abortError()
        const wait = this.last + this.opts.intervalMs() - this.now()
        if (wait <= 0) break
        onWait?.(wait)
        await this.sleep(wait, signal)
      }
      this.last = this.now()
      return this.last - t0
    } finally {
      this.unlock()
    }
  }

  private lock(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(abortError())
    if (!this.busy) {
      this.busy = true
      return Promise.resolve()
    }
    return new Promise((resolve, reject) => {
      const grant = (): void => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      }
      const onAbort = (): void => {
        const i = this.queue.indexOf(grant)
        if (i >= 0) this.queue.splice(i, 1)
        reject(abortError())
      }
      signal.addEventListener('abort', onAbort, { once: true })
      this.queue.push(grant)
    })
  }

  private unlock(): void {
    const next = this.queue.shift()
    if (next) next()
    else this.busy = false
  }
}

export const fmtSecs = (ms: number): string =>
  (ms / 1000).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })

/** Acrescenta a nota de espera ao fim da 1ª linha do resultado. */
export function withWaitNote(text: string, waitedMs: number): string {
  if (waitedMs < 100) return text
  const note = ` [aguardou ${fmtSecs(waitedMs)} s pelo intervalo entre pesquisas]`
  const i = text.indexOf('\n')
  return i < 0 ? text + note : text.slice(0, i) + note + text.slice(i)
}

/**
 * web_search com o intervalo global: UMA pesquisa = UMA vez no `gate`, qualquer que seja o número
 * de buscadores tentados — os fallbacks da MESMA chamada rodam na hora, sem esperar outro intervalo.
 */
export async function runGatedWebSearch(
  query: string,
  backends: SearchBackends,
  signal: AbortSignal,
  gate: SearchGate,
  onWait?: (remainingMs: number) => void,
  plan: PlanEntry[] = DEFAULT_PLAN
): Promise<ToolResult> {
  const waited = await gate.acquire(signal, onWait)
  const r = await runWebSearch(query, backends, signal, plan)
  return { ...r, content: withWaitNote(r.content, waited) }
}
