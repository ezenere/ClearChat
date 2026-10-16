// web_search (DuckDuckGo HTML → fallback Brave Search; lógica pura em webSearch.ts) e
// browse_url (BrowserWindow oculta).
import { BrowserWindow, session as electronSession } from 'electron'
import { isBraveBlocked } from './brave'
import {
  fmtSecs,
  normalizeSearchInterval,
  runGatedWebSearch,
  SEARCH_INTERVAL_SETTING,
  SearchGate,
  type SearchPage
} from './webSearch'
import { settingsRepo } from '../repo'
import { LIMITS } from '@shared/limits'
import {
  abortError,
  fail,
  fmtNum,
  maxOutputOf,
  ok,
  optNumber,
  requireString,
  truncate,
  type ToolContext,
  type ToolResult
} from './util'

const UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0'

async function ddgFetch(
  query: string,
  method: 'POST' | 'GET',
  signal: AbortSignal
): Promise<string> {
  const base = 'https://html.duckduckgo.com/html/'
  const timeout = AbortSignal.timeout(20_000)
  const sig = AbortSignal.any([signal, timeout])
  const res =
    method === 'POST'
      ? await fetch(base, {
          method: 'POST',
          headers: {
            'User-Agent': UA,
            'Content-Type': 'application/x-www-form-urlencoded',
            Referer: 'https://html.duckduckgo.com/',
            'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8'
          },
          body: new URLSearchParams({ q: query, b: '' }).toString(),
          signal: sig
        })
      : await fetch(`${base}?q=${encodeURIComponent(query)}`, {
          headers: { 'User-Agent': UA, 'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8' },
          signal: sig
        })
  const text = await res.text()
  if (!res.ok && res.status !== 202) throw new Error(`HTTP ${res.status}`)
  return text
}

/** Intervalo mínimo GLOBAL entre pesquisas (todos os chats/sessões/subagentes do processo). */
const searchGate = new SearchGate({
  intervalMs: () => normalizeSearchInterval(settingsRepo.get(SEARCH_INTERVAL_SETTING)) * 1000
})

export async function webSearch(
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  const query = requireString(args, 'query').trim()
  let waited = false
  const r = await runGatedWebSearch(
    query,
    { ddg: ddgFetch, brave: braveFetch },
    ctx.signal,
    searchGate,
    (ms) => {
      waited = true
      ctx.onOutput?.(`Aguardando intervalo entre pesquisas… (${fmtSecs(ms)} s)`)
    }
  )
  if (waited) ctx.onOutput?.('Pesquisando…')
  return r.status === 'error' ? r : ok(truncate(r.content, maxOutputOf(ctx)))
}

/**
 * Brave Search: `fetch` simples recebe 429 + página "needs JavaScript / captcha"; a página carregada
 * numa BrowserWindow oculta (UA de Chrome, sem "Electron") vem completa (SSR). Devolve o HTML
 * renderizado — o parse é puro (brave.ts).
 */
export async function braveFetch(query: string, signal: AbortSignal): Promise<SearchPage> {
  const url = `https://search.brave.com/search?q=${encodeURIComponent(query)}`
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: {
      session: browseSession(),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      images: false,
      spellcheck: false
    }
  })
  const wc = win.webContents
  wc.setAudioMuted(true)
  wc.setWindowOpenHandler(() => ({ action: 'deny' }))
  const timers: NodeJS.Timeout[] = []
  const sleep = (ms: number): Promise<void> => new Promise((r) => timers.push(setTimeout(r, ms)))
  let onAbort: (() => void) | null = null
  const aborted = new Promise<never>((_res, rej) => {
    onAbort = () => rej(abortError())
    signal.addEventListener('abort', onAbort, { once: true })
  })
  aborted.catch(() => {})
  let status: number | undefined
  wc.on('did-navigate', (_e, _u, code) => {
    if (code > 0) status = code
  })
  const html = (): Promise<string> =>
    Promise.race([
      wc.executeJavaScript('document.documentElement.outerHTML', true) as Promise<string>,
      sleep(5000).then(() => {
        throw new Error('timeout ao ler a página')
      }),
      aborted
    ])
  try {
    if (signal.aborted) throw abortError()
    const loaded = new Promise<'loaded'>((res, rej) => {
      wc.once('did-finish-load', () => res('loaded'))
      wc.on('did-fail-load', (_e, code, desc, _u, isMain) => {
        if (isMain && code !== -3) rej(new Error(`falha ao carregar (${code} ${desc})`))
      })
    })
    loaded.catch(() => {})
    void wc.loadURL(url, { userAgent: cleanUserAgent(wc.getUserAgent()) }).catch(() => {})
    const first = await Promise.race([
      loaded,
      sleep(BRAVE_TIMEOUT).then(() => 'timeout' as const),
      aborted
    ])
    let page = await html()
    // SSR: os resultados já vêm no load; se não vieram (hidratação lenta), espera um pouco.
    if (!/data-type="web"/.test(page) && !isBraveBlocked(page, status)) {
      await Promise.race([sleep(SETTLE_MS), aborted])
      page = await html()
    }
    if (first === 'timeout' && !/data-type="web"/.test(page))
      throw new Error(`timeout de ${BRAVE_TIMEOUT / 1000}s`)
    return { html: page, status }
  } finally {
    timers.forEach(clearTimeout)
    if (onAbort) signal.removeEventListener('abort', onAbort)
    if (!win.isDestroyed()) win.destroy()
  }
}

const BRAVE_TIMEOUT = 20_000

/** UA do Chromium sem os marcadores do Electron/app (sites tratam "Electron" como robô). */
function cleanUserAgent(ua: string): string {
  return ua.replace(/ Electron\/\S+/, '').replace(/ clearchat\/\S+/i, '')
}

// ---------------- browse_url ----------------

const BROWSE_TIMEOUT = 25_000
const SETTLE_MS = 1500

const EXTRACT_JS = `(() => {
  const clean = (s) => (s || '').replace(/[ \\t]+/g, ' ').replace(/\\n{3,}/g, '\\n\\n').trim();
  const root = document.querySelector('main, article, [role=main]') || document.body;
  const text = clean(document.body ? document.body.innerText : '');
  const seen = new Set();
  const links = [];
  for (const a of Array.from((root || document).querySelectorAll('a[href]'))) {
    const href = a.href;
    const t = clean(a.innerText || a.getAttribute('aria-label') || a.title || '').slice(0, 120);
    if (!/^https?:/.test(href) || !t || seen.has(href)) continue;
    seen.add(href);
    links.push({ text: t, href });
    if (links.length >= ${LIMITS.browseMaxLinks}) break;
  }
  return { title: document.title || '', url: location.href, text, links };
})()`

export interface PageData {
  title: string
  url: string
  text: string
  links: { text: string; href: string }[]
}

/** Texto extraído por sessão + URL (paginação via offset sem recarregar a página). */
const pageCache = new Map<string, { at: number; data: PageData; timedOut: boolean }>()

function cacheGet(key: string): { data: PageData; timedOut: boolean } | null {
  const now = Date.now()
  for (const [k, v] of pageCache) if (now - v.at > LIMITS.browseCacheMs) pageCache.delete(k)
  return pageCache.get(key) ?? null
}

/** Página `offset…offset+pageChars` do texto extraído, com cabeçalho "caracteres X–Y de Z". */
export function formatPage(
  data: PageData,
  offset: number,
  pageChars: number,
  timedOut: boolean,
  fromCache: boolean
): string {
  const text = data.text || '(página sem texto visível)'
  const total = text.length
  const start = Math.min(Math.max(0, Math.floor(offset)), total)
  const end = Math.min(total, start + pageChars)
  const page = text.slice(start, end)
  const range =
    start === 0 && end >= total
      ? `[texto completo: ${fmtNum(total)} caracteres]`
      : `[caracteres ${fmtNum(start + 1)}–${fmtNum(end)} de ${fmtNum(total)}${end < total ? ` — continue com offset=${end}` : ' — fim do texto'}]`
  const warn = timedOut
    ? `\n[aviso: a página não terminou de carregar em ${BROWSE_TIMEOUT / 1000}s; conteúdo parcial]`
    : ''
  const cached = fromCache ? ' (do cache, sem recarregar)' : ''
  const links =
    start === 0 && data.links.length
      ? `\n\n## Links\n${data.links.map((l) => `- [${l.text}](${l.href})`).join('\n')}`
      : ''
  return `# ${data.title || '(sem título)'}\nURL: ${data.url}${warn}\n${range}${cached}\n\n${page}${links}`
}

export async function browseUrl(
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  const raw = requireString(args, 'url').trim()
  const offset = Math.max(0, Math.floor(optNumber(args, 'offset') ?? 0))
  const pageChars = Math.max(
    1000,
    Math.min(LIMITS.browsePageChars, maxOutputOf(ctx) - LIMITS.browseMaxLinks * 160)
  )
  let url: URL
  try {
    url = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`)
  } catch {
    return fail(`Erro: URL inválida: ${raw}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return fail('Erro: apenas URLs http/https são permitidas.')
  }
  if (ctx.signal.aborted) throw abortError()
  const cacheKey = `${ctx.cacheKey ?? ''}|${url.toString()}`
  if (offset > 0) {
    const hit = cacheGet(cacheKey)
    if (hit)
      return ok(
        truncate(formatPage(hit.data, offset, pageChars, hit.timedOut, true), maxOutputOf(ctx))
      )
  }

  const ses = browseSession()
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: {
      session: ses,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      images: false,
      spellcheck: false
    }
  })
  const wc = win.webContents
  wc.setAudioMuted(true)
  wc.setWindowOpenHandler(() => ({ action: 'deny' }))

  const timers: NodeJS.Timeout[] = []
  const sleep = (ms: number): Promise<void> => new Promise((r) => timers.push(setTimeout(r, ms)))
  let onAbort: (() => void) | null = null
  const aborted = new Promise<never>((_res, rej) => {
    onAbort = () => rej(abortError())
    ctx.signal.addEventListener('abort', onAbort, { once: true })
  })
  aborted.catch(() => {})
  try {
    const loaded = new Promise<'loaded'>((res, rej) => {
      wc.once('did-finish-load', () => res('loaded'))
      wc.on('did-fail-load', (_e, code, desc, _u, isMain) => {
        if (isMain && code !== -3) rej(new Error(`falha ao carregar (${code} ${desc})`))
      })
    })
    loaded.catch(() => {})
    const ua = cleanUserAgent(wc.getUserAgent())
    void wc.loadURL(url.toString(), { userAgent: ua }).catch(() => {})
    const first = await Promise.race([
      loaded,
      sleep(BROWSE_TIMEOUT).then(() => 'timeout' as const),
      aborted
    ])
    const timedOut = first === 'timeout'
    if (!timedOut) await Promise.race([sleep(SETTLE_MS), aborted])
    const data = await Promise.race([
      wc.executeJavaScript(EXTRACT_JS, true) as Promise<PageData>,
      sleep(5000).then(() => {
        throw new Error(
          timedOut ? `timeout de ${BROWSE_TIMEOUT / 1000}s` : 'timeout ao extrair conteúdo'
        )
      }),
      aborted
    ])
    pageCache.set(cacheKey, { at: Date.now(), data, timedOut })
    return ok(truncate(formatPage(data, offset, pageChars, timedOut, false), maxOutputOf(ctx)))
  } catch (e) {
    if ((e as Error).name === 'AbortError' || ctx.signal.aborted) throw abortError()
    return fail(`Erro ao abrir ${url.toString()}: ${(e as Error).message}`)
  } finally {
    timers.forEach(clearTimeout)
    if (onAbort) ctx.signal.removeEventListener('abort', onAbort)
    if (!win.isDestroyed()) win.destroy()
  }
}

let browseSes: Electron.Session | null = null
function browseSession(): Electron.Session {
  if (browseSes) return browseSes
  const ses = electronSession.fromPartition('clearchat-browse') // em memória (não persistente)
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
  ses.on('will-download', (e) => e.preventDefault())
  browseSes = ses
  return ses
}
