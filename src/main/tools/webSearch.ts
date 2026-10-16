// Orquestração do web_search (pura, sem Electron): DuckDuckGo HTML → fallback Brave Search.
// Os "fetchers" são injetados (web.ts liga os reais; os testes passam mocks).
import { LIMITS } from '@shared/limits'
import { parseDdgHtml, type SearchResult } from './ddg'
import { isBraveBlocked, parseBraveHtml } from './brave'
import { abortError, fail, ok, type ToolResult } from './util'

export interface SearchPage {
  html: string
  /** Código HTTP da resposta principal, se conhecido. */
  status?: number
}

export interface SearchBackends {
  /** HTML de https://html.duckduckgo.com/html/ (lança em erro HTTP/rede). */
  ddg: (query: string, method: 'POST' | 'GET', signal: AbortSignal) => Promise<string>
  /** HTML (renderizado) de https://search.brave.com/search?q=… */
  brave: (query: string, signal: AbortSignal) => Promise<SearchPage>
}

export type DdgOutcome =
  | { kind: 'results'; results: SearchResult[] }
  | { kind: 'empty' } // página "sem resultados" legítima
  | { kind: 'blocked' } // captcha / anomaly
  | { kind: 'error'; message: string } // HTTP / rede
  | { kind: 'suspect' } // 0 resultados sem a marca de "sem resultados" (layout mudou / bloqueio)

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

function ddgReason(o: DdgOutcome): string {
  if (o.kind === 'blocked') return 'DuckDuckGo bloqueou'
  if (o.kind === 'error') return `DuckDuckGo falhou: ${o.message}`
  return 'DuckDuckGo não retornou resultados'
}

function ddgDetail(o: DdgOutcome): string {
  if (o.kind === 'blocked') return 'DuckDuckGo: verificação anti-robô (captcha)'
  if (o.kind === 'error') return `DuckDuckGo: ${o.message}`
  return 'DuckDuckGo: nenhum resultado (possível bloqueio)'
}

export function formatResults(query: string, via: string, results: SearchResult[]): string {
  const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n).trimEnd()}…` : s)
  const out = results
    .slice(0, LIMITS.webMaxResults)
    .map(
      (r, i) =>
        `${i + 1}. ${clip(r.title, 200)}\n   ${r.url}${r.snippet ? `\n   ${clip(r.snippet, LIMITS.webSnippetChars)}` : ''}`
    )
    .join('\n\n')
  return `Resultados para "${query}" (${via}):\n\n${out}`
}

/**
 * DuckDuckGo (POST, depois GET). Se bloquear, falhar (HTTP/rede) ou vier vazio sem a página de
 * "sem resultados" → Brave Search. "Sem resultados" legítimo do DDG não dispara o fallback.
 * Retorna o texto completo (o chamador aplica o teto de saída).
 */
export async function runWebSearch(
  query: string,
  backends: SearchBackends,
  signal: AbortSignal
): Promise<ToolResult> {
  const ddg = await searchDdg(query, backends.ddg, signal)
  if (ddg.kind === 'results') return ok(formatResults(query, 'via DuckDuckGo', ddg.results))
  if (ddg.kind === 'empty') return ok(`Nenhum resultado para "${query}" (DuckDuckGo).`)
  if (signal.aborted) throw abortError()

  let braveErr: string
  try {
    const page = await backends.brave(query, signal)
    const results = parseBraveHtml(page.html)
    if (results.length)
      return ok(formatResults(query, `via Brave Search; ${ddgReason(ddg)}`, results))
    if (isBraveBlocked(page.html, page.status))
      braveErr = `Brave Search: verificação anti-robô / limite de requisições${page.status ? ` (HTTP ${page.status})` : ''}`
    else if (page.status && page.status >= 400) braveErr = `Brave Search: HTTP ${page.status}`
    else return ok(`Nenhum resultado para "${query}" (via Brave Search; ${ddgReason(ddg)}).`)
  } catch (e) {
    if (signal.aborted || (e as Error).name === 'AbortError') throw abortError()
    braveErr = `Brave Search: ${(e as Error).message}`
  }
  const both = ddg.kind === 'blocked' && braveErr.includes('anti-robô')
  return fail(
    `Erro: ${both ? 'a busca foi bloqueada pelos dois buscadores' : 'a pesquisa falhou nos dois buscadores'} — ${ddgDetail(ddg)}; ${braveErr}. Tente novamente mais tarde ou use browse_url.`
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
 * web_search com o intervalo global: espera a vez no `gate` (só a pesquisa ao DuckDuckGo entra na
 * fila; o fallback Brave da MESMA chamada roda na hora — outro buscador) e anota a espera.
 */
export async function runGatedWebSearch(
  query: string,
  backends: SearchBackends,
  signal: AbortSignal,
  gate: SearchGate,
  onWait?: (remainingMs: number) => void
): Promise<ToolResult> {
  const waited = await gate.acquire(signal, onWait)
  const r = await runWebSearch(query, backends, signal)
  return { ...r, content: withWaitNote(r.content, waited) }
}
