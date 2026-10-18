// web_search com vários buscadores: parse das APIs (fixtures no formato real de Exa, Tavily e
// Brave Search API), requests montadas, classificação das falhas, ordem + fallback (um buscador por
// pesquisa), normalização/migração da config, máscara das chaves e intervalo (uma vez por pesquisa).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { SCHEMA } from '../src/main/dbSchema.ts'
import { migrateWebSearchEngines } from '../src/main/migrateWebSearch.ts'
import {
  classifyHttp,
  parseBraveApiJson,
  parseExaJson,
  parseTavilyJson,
  shortDate
} from '../src/main/tools/searchApis.ts'
import {
  runEngine,
  runGatedWebSearch,
  runWebSearch,
  SearchGate,
  type HttpResponse,
  type PlanEntry,
  type SearchBackends
} from '../src/main/tools/webSearch.ts'
import {
  buildEngineRequest,
  DEFAULT_ENGINES,
  describeEngineRequest,
  engineBaseEnv,
  maskKey,
  moveEngine,
  normalizeEngines,
  normalizeKeys,
  normalizeOptions,
  PROTECTED_SETTINGS,
  SEARCH_ENGINES_SETTING,
  SEARCH_KEYS_SETTING,
  type EngineHttpRequest
} from '../src/shared/webSearchSettings.ts'

const FX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/web')
const fx = (name: string): string => readFileSync(join(FX, name), 'utf8')
const json = (name: string): unknown => JSON.parse(fx(name))
const sig = (): AbortSignal => new AbortController().signal

const DDG_CAPTCHA = fx('ddg-captcha.html')

// ---------------- parse das APIs ----------------

test('Exa: highlights, data, título vazio → URL, duplicado e não-http fora', () => {
  const r = parseExaJson(json('exa-search.json'))!
  assert.equal(r.results.length, 3)
  assert.deepEqual(r.results[0], {
    title: 'TypeScript: Documentation - TypeScript 4.9',
    url: 'https://www.typescriptlang.org/docs/handbook/release-notes/typescript-4-9.html',
    snippet:
      "The new satisfies operator lets us validate that the type of an expression matches some type, without changing the resulting type of that expression. … We could try to catch that bleu typo by using a type annotation on palette, but we'd lose the information about each property.",
    date: '2022-11-15'
  })
  assert.match(r.results[1].snippet, /most specific inferred type & literal types/)
  assert.equal(r.results[2].title, 'https://2ality.com/2025/02/satisfies-operator.html')
  assert.equal(r.results[2].snippet, 'An explainer of the satisfies operator with examples.')
  assert.equal(r.results[2].date, undefined)
  assert.equal(r.answer, undefined)
  assert.equal(parseExaJson({ error: 'x' }), null)
  assert.deepEqual(parseExaJson({ results: [] }), { results: [] })
})

test('Tavily: content sem tags, published_date RFC 2822, answer', () => {
  const r = parseTavilyJson(json('tavily-search.json'))!
  assert.equal(r.results.length, 3)
  assert.equal(r.results[0].title, 'TypeScript: Documentation - TypeScript 4.9')
  assert.match(r.results[0].snippet, /^TypeScript 4\.9 introduces the new satisfies operator/)
  assert.equal(r.results[0].date, '2022-11-15')
  assert.equal(r.results[1].date, undefined)
  assert.match(r.answer!, /^The satisfies operator, added in TypeScript 4\.9/)
  assert.equal(parseTavilyJson({ detail: { error: 'x' } }), null)
})

test('Brave Search API: web.results (description com <strong>, extra_snippets, page_age/age); vídeos fora', () => {
  const r = parseBraveApiJson(json('brave-api-search.json'))!
  assert.equal(r.results.length, 2)
  assert.deepEqual(r.results[0].date, '2022-11-15')
  assert.match(
    r.results[0].snippet,
    /^The new satisfies operator lets us validate .* expression\. … We could try to catch that bleu typo .*we'd lose/
  )
  assert.ok(!r.results[0].snippet.includes('<'))
  assert.match(r.results[1].snippet, /conforms to a type & keep/)
  assert.equal(r.results[1].date, '2 days ago')
  assert.ok(!r.results.some((x) => /youtube/.test(x.url)))
  // sem `web` mas resposta de busca válida = 0 resultados; erro/JSON estranho = null
  assert.deepEqual(parseBraveApiJson({ type: 'search', query: { original: 'x' } }), {
    results: []
  })
  assert.equal(parseBraveApiJson(json('brave-api-error-422.json')), null)
  assert.equal(parseBraveApiJson({ foo: 1 }), null)
  assert.equal(shortDate('November 15, 2022'), '2022-11-15')
})

test('requests montadas (endpoint, headers, body) e (i) sem a chave', () => {
  const exa = buildEngineRequest('exa', 'q 1', 'exa-KEY', { maxResults: 5 })
  assert.equal(exa.method, 'POST')
  assert.equal(exa.url, 'https://api.exa.ai/search')
  assert.deepEqual(exa.headers, {
    'Content-Type': 'application/json',
    Authorization: 'Bearer exa-KEY'
  })
  assert.deepEqual(JSON.parse(exa.body!), {
    query: 'q 1',
    numResults: 5,
    contents: { highlights: true }
  })
  const tav = buildEngineRequest('tavily', 'q', 'tvly-K', {})
  assert.equal(tav.url, 'https://api.tavily.com/search')
  assert.equal(tav.headers.Authorization, 'Bearer tvly-K')
  assert.deepEqual(JSON.parse(tav.body!), { query: 'q', search_depth: 'advanced', max_results: 8 })
  const tavB = buildEngineRequest('tavily', 'q', 'k', { depth: 'basic', maxResults: 99 })
  assert.deepEqual(JSON.parse(tavB.body!), { query: 'q', search_depth: 'basic', max_results: 10 })
  const br = buildEngineRequest('brave-api', 'a b&c', 'BSA1', { maxResults: 3 }, 'http://x:1/')
  assert.equal(br.method, 'GET')
  assert.equal(br.url, 'http://x:1/res/v1/web/search?q=a+b%26c&count=3')
  assert.deepEqual(br.headers, {
    Accept: 'application/json',
    'Accept-Encoding': 'gzip',
    'X-Subscription-Token': 'BSA1'
  })
  assert.equal(br.body, undefined)
  const info = describeEngineRequest('brave-api', {})
  assert.match(
    info,
    /^GET https:\/\/api\.search\.brave\.com\/res\/v1\/web\/search\?q=\{consulta\}&count=8\n/
  )
  assert.match(info, /X-Subscription-Token: \{sua chave\}/)
  assert.match(describeEngineRequest('exa', {}), /"highlights": true/)
  assert.equal(engineBaseEnv('brave-api'), 'CLEARCHAT_SEARCH_BASE_BRAVE_API')
  assert.equal(engineBaseEnv('exa'), 'CLEARCHAT_SEARCH_BASE_EXA')
})

test('classificação das falhas HTTP (chave, cota, genérico) com detalhe curto do corpo', () => {
  assert.deepEqual(classifyHttp(401, fx('exa-error-401.json')), {
    category: 'auth',
    message: 'chave de API inválida ou sem permissão (HTTP 401) — Invalid API key'
  })
  const b = classifyHttp(422, fx('brave-api-error-422.json'))
  assert.equal(b.category, 'auth')
  assert.match(b.message, /HTTP 422\) — The provided subscription token is invalid\./)
  const t = classifyHttp(432, fx('tavily-error-432.json'))
  assert.equal(t.category, 'quota')
  assert.match(t.message, /^limite de uso\/cota atingido \(HTTP 432\) — This request exceeds/)
  assert.ok(t.message.length < 200)
  for (const s of [402, 429, 433]) assert.equal(classifyHttp(s, '').category, 'quota')
  assert.equal(classifyHttp(403, '').category, 'auth')
  assert.deepEqual(classifyHttp(500, '<html>oops</html>'), {
    category: 'http',
    message: 'HTTP 500'
  })
  assert.equal(classifyHttp(422, '{"detail":"bad field"}').category, 'http')
})

// ---------------- ordem + fallback ----------------

type Route = (req: EngineHttpRequest) => HttpResponse | Error
function backends(
  route: Route,
  opts: { ddg?: () => string | Error; brave?: () => { html: string; status?: number } } = {}
): SearchBackends & { calls: string[]; reqs: EngineHttpRequest[] } {
  const calls: string[] = []
  const reqs: EngineHttpRequest[] = []
  return {
    calls,
    reqs,
    ddg: async (_q, m) => {
      calls.push(`ddg:${m}`)
      const r = opts.ddg ? opts.ddg() : new Error('ddg não devia')
      if (r instanceof Error) throw r
      return r
    },
    brave: async () => {
      calls.push('brave-site')
      if (!opts.brave) throw new Error('brave não devia')
      return opts.brave()
    },
    http: async (req) => {
      const host = new URL(req.url).hostname
      calls.push(host)
      reqs.push(req)
      const r = route(req)
      if (r instanceof Error) throw r
      return r
    },
    bases: {
      exa: 'http://exa.test',
      tavily: 'http://tavily.test',
      'brave-api': 'http://brave.test'
    }
  }
}
const okJson = (name: string): HttpResponse => ({ status: 200, text: fx(name) })
const byHost =
  (m: Record<string, HttpResponse | Error>): Route =>
  (req) =>
    m[new URL(req.url).hostname] ?? new Error(`sem rota ${req.url}`)

const EXA: PlanEntry = { id: 'exa', key: 'exa-k', options: { maxResults: 8 } }
const TAV: PlanEntry = { id: 'tavily', key: 'tvly-k', options: { maxResults: 2, depth: 'basic' } }
const BRAPI: PlanEntry = { id: 'brave-api', key: 'BSAk', options: { maxResults: 8 } }

test('primeiro habilitado responde: só ele é chamado; cabeçalho "Resultados de X para"', async () => {
  const b = backends(byHost({ 'exa.test': okJson('exa-search.json') }))
  const r = await runWebSearch('typescript satisfies', b, sig(), [EXA, TAV, { id: 'ddg' }])
  assert.deepEqual(b.calls, ['exa.test'])
  assert.equal(r.status, 'ok')
  const lines = r.content.split('\n')
  assert.equal(lines[0], 'Resultados de Exa para "typescript satisfies":')
  assert.equal(lines[2], '1. TypeScript: Documentation - TypeScript 4.9')
  assert.match(lines[4], /^ {3}2022-11-15 — The new satisfies operator/)
  assert.equal(b.reqs[0].headers.Authorization, 'Bearer exa-k')
})

test('falha (cota/chave/rede/vazio/captcha) → próximo; cabeçalho cita quem falhou; nunca mistura', async () => {
  const b = backends(
    byHost({
      'exa.test': { status: 429, text: '{"error":"rate limited"}' },
      'tavily.test': okJson('tavily-search.json')
    })
  )
  const r = await runWebSearch('q', b, sig(), [EXA, TAV, BRAPI])
  assert.deepEqual(b.calls, ['exa.test', 'tavily.test'])
  const [h, , answer, , first] = r.content.split('\n')
  assert.equal(
    h,
    'Resultados de Tavily para "q" (após falha em Exa: limite de uso/cota atingido (HTTP 429) — rate limited):'
  )
  assert.match(answer, /^Resposta resumida: The satisfies operator/)
  assert.equal(first, '1. TypeScript: Documentation - TypeScript 4.9')
  assert.equal((r.content.match(/^\d+\. /gm) ?? []).length, 2) // maxResults do Tavily
  assert.ok(!r.content.includes('2ality'), 'resultados da Exa não entram')

  // cadeia: chave inválida (Brave API) → rede (Exa) → resposta vazia (Tavily) → DuckDuckGo captcha → Brave (site)
  const BRAVE = fx('brave-results.html')
  const b2 = backends(
    byHost({
      'brave.test': { status: 422, text: fx('brave-api-error-422.json') },
      'exa.test': new Error('ECONNREFUSED'),
      'tavily.test': { status: 200, text: '' }
    }),
    { ddg: () => DDG_CAPTCHA, brave: () => ({ html: BRAVE, status: 200 }) }
  )
  const r2 = await runWebSearch('q', b2, sig(), [
    BRAPI,
    EXA,
    TAV,
    { id: 'ddg' },
    { id: 'brave-site' }
  ])
  assert.deepEqual(b2.calls, [
    'brave.test',
    'exa.test',
    'tavily.test',
    'ddg:POST',
    'ddg:GET',
    'brave-site'
  ])
  const h2 = r2.content.split('\n')[0]
  assert.match(h2, /^Resultados de Brave Search \(site\) para "q" \(após falha em /)
  assert.match(h2, /Brave Search API: chave de API inválida ou sem permissão \(HTTP 422\)/)
  assert.match(h2, /Exa: erro de rede: ECONNREFUSED/)
  assert.match(h2, /Tavily: resposta vazia ou em formato inesperado/)
  assert.match(h2, /DuckDuckGo: verificação anti-robô \(captcha\)\):$/)
})

test('sem resultados legítimo NÃO faz fallback; HTML/JSON inválido faz', async () => {
  const b = backends(byHost({ 'exa.test': { status: 200, text: '{"results":[]}' } }))
  const r = await runWebSearch('zzz', b, sig(), [EXA, TAV])
  assert.deepEqual(b.calls, ['exa.test'])
  assert.equal(r.content, 'Nenhum resultado de Exa para "zzz".')
  const b2 = backends(
    byHost({
      'exa.test': { status: 200, text: '<html>gateway</html>' },
      'tavily.test': { status: 200, text: '{"query":"zzz","results":[]}' }
    })
  )
  const r2 = await runWebSearch('zzz', b2, sig(), [EXA, TAV])
  assert.equal(
    r2.content,
    'Nenhum resultado de Tavily para "zzz" (após falha em Exa: resposta vazia ou em formato inesperado).'
  )
})

test('buscador com API sem chave: pulado sem rede (falha "sem chave"); nenhum habilitado → erro', async () => {
  const b = backends(byHost({ 'tavily.test': okJson('tavily-search.json') }))
  const r = await runWebSearch('q', b, sig(), [{ id: 'exa', options: {} }, TAV])
  assert.deepEqual(b.calls, ['tavily.test'])
  assert.match(r.content.split('\n')[0], /\(após falha em Exa: sem chave de API\):$/)
  const none = await runWebSearch('q', b, sig(), [])
  assert.equal(none.status, 'error')
  assert.match(none.content, /nenhum buscador habilitado/)
})

test('todos falham → erro citando cada um; todos bloqueados → "bloqueada"', async () => {
  const b = backends(
    byHost({
      'exa.test': { status: 401, text: fx('exa-error-401.json') },
      'tavily.test': { status: 432, text: fx('tavily-error-432.json') }
    })
  )
  const r = await runWebSearch('q', b, sig(), [EXA, TAV])
  assert.equal(r.status, 'error')
  assert.match(
    r.content,
    /^Erro: a pesquisa falhou nos 2 buscadores habilitados — Exa: chave de API inválida .*HTTP 401.*; Tavily: limite de uso\/cota atingido \(HTTP 432\)/
  )
  assert.match(r.content, /Configurações → Pesquisa na web/)
  const one = await runWebSearch(
    'q',
    backends(() => new Error('x'), { ddg: () => DDG_CAPTCHA }),
    sig(),
    [{ id: 'ddg' }]
  )
  assert.match(one.content, /^Erro: a busca foi bloqueada — DuckDuckGo: verificação anti-robô/)
})

test('abort numa API propaga AbortError sem tentar o próximo', async () => {
  const ac = new AbortController()
  const b = backends(() => {
    ac.abort()
    return new Error('aborted')
  })
  await assert.rejects(runWebSearch('q', b, ac.signal, [EXA, TAV]), { name: 'AbortError' })
  assert.deepEqual(b.calls, ['exa.test'])
})

test('runEngine (botão Testar) roda um buscador só, sem fallback', async () => {
  const b = backends(byHost({ 'brave.test': okJson('brave-api-search.json') }))
  const o = await runEngine(BRAPI, 'q', b, sig())
  assert.equal(o.kind, 'results')
  assert.equal(o.kind === 'results' && o.results.length, 2)
  const f = await runEngine({ id: 'tavily', options: {} }, 'q', b, sig())
  assert.deepEqual(f, { kind: 'fail', category: 'no-key', message: 'sem chave de API' })
})

test('intervalo: UMA vez por pesquisa — fallbacks na hora; a próxima pesquisa espera', async () => {
  let t = 0
  const sleeps: number[] = []
  const gate = new SearchGate({
    intervalMs: () => 5000,
    now: () => t,
    sleep: async (ms) => {
      sleeps.push(ms)
      t += ms
    }
  })
  const log: string[] = []
  const b = backends((req) => {
    log.push(`${new URL(req.url).hostname}@${t}`)
    t += 300 // cada request "demora" 300 ms
    return new URL(req.url).hostname === 'exa.test'
      ? { status: 429, text: '' }
      : okJson('tavily-search.json')
  })
  const r1 = await runGatedWebSearch('a', b, sig(), gate, undefined, [EXA, TAV])
  assert.match(r1.content.split('\n')[0], /^Resultados de Tavily para "a" \(após falha em Exa/)
  assert.ok(!r1.content.split('\n')[0].includes('aguardou'))
  const r2 = await runGatedWebSearch('b', b, sig(), gate, undefined, [EXA, TAV])
  assert.deepEqual(log, ['exa.test@0', 'tavily.test@300', 'exa.test@5000', 'tavily.test@5300'])
  // o intervalo conta do INÍCIO da pesquisa anterior (t=0); ela terminou em 600 ms → espera 4,4 s
  assert.deepEqual(sleeps, [4400])
  assert.match(r2.content.split('\n')[0], /\[aguardou 4,4 s pelo intervalo entre pesquisas\]$/)
})

// ---------------- config: normalização, migração, chaves ----------------

test('normalizeEngines: padrão, ordem salva, desconhecidos/repetidos fora, faltantes no fim, sem chave = desligado', () => {
  assert.deepEqual(
    normalizeEngines(null).map((e) => `${e.id}:${e.enabled}`),
    ['ddg:true', 'brave-site:true', 'brave-api:false', 'exa:false', 'tavily:false']
  )
  assert.deepEqual(normalizeEngines(undefined), DEFAULT_ENGINES)
  const saved = [
    { id: 'tavily', enabled: true, options: { depth: 'basic', maxResults: 3 } },
    { id: 'nope', enabled: true },
    { id: 'ddg', enabled: false },
    { id: 'tavily', enabled: false },
    'exa'
  ]
  const withKey = normalizeEngines(saved, (id) => id === 'tavily')
  assert.deepEqual(
    withKey.map((e) => `${e.id}:${e.enabled}`),
    ['tavily:true', 'ddg:false', 'exa:false', 'brave-site:true', 'brave-api:false']
  )
  assert.deepEqual(withKey[0].options, { maxResults: 3, depth: 'basic' })
  assert.deepEqual(withKey[1].options, {})
  // sem a chave do Tavily, ele fica desligado (mas na mesma posição)
  assert.equal(normalizeEngines(saved)[0].enabled, false)
  // idempotente
  assert.deepEqual(
    normalizeEngines(withKey, (id) => id === 'tavily'),
    withKey
  )
  assert.deepEqual(normalizeOptions('exa', { maxResults: 0 }), { maxResults: 1 })
  assert.deepEqual(normalizeOptions('tavily', { depth: 'x' }), { maxResults: 8, depth: 'advanced' })
  assert.deepEqual(moveEngine(['a', 'b', 'c'], 2, 0), ['c', 'a', 'b'])
  assert.deepEqual(moveEngine(['a', 'b', 'c'], 0, 5), ['a', 'b', 'c'])
})

test('chaves: normalização, máscara, setting protegido', () => {
  assert.deepEqual(normalizeKeys({ exa: ' k1 ', tavily: '', ddg: 'x', 'brave-api': 3 }), {
    exa: 'k1'
  })
  assert.equal(maskKey('tvly-dev-1234567890abcd'), 'tvly-…abcd')
  assert.equal(maskKey('sk-1234567890wxyz'), 'sk-…wxyz')
  assert.equal(maskKey('BSAabcdefghijkl9876'), '…9876')
  assert.equal(maskKey('short'), '••••')
  assert.equal(maskKey(''), null)
  assert.ok(PROTECTED_SETTINGS.includes(SEARCH_KEYS_SETTING))
})

test('migração: grava o padrão uma vez (idempotente), completa listas antigas, respeita chaves', () => {
  const dir = mkdtempSync(join(tmpdir(), 'clearchat-ws-'))
  try {
    const conn = new Database(join(dir, 'db.sqlite'))
    conn.exec(SCHEMA)
    const get = (k: string): unknown => {
      const r = conn.prepare('SELECT value FROM settings WHERE key = ?').get(k) as
        { value: string } | undefined
      return r ? JSON.parse(r.value) : null
    }
    const set = (k: string, v: unknown): void => {
      conn
        .prepare(
          'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
        )
        .run(k, JSON.stringify(v))
    }
    set('webSearchMinIntervalSec', 3)
    assert.deepEqual(migrateWebSearchEngines(conn), { changed: true })
    assert.deepEqual(get(SEARCH_ENGINES_SETTING), DEFAULT_ENGINES)
    assert.equal(get('webSearchMinIntervalSec'), 3) // intervalo global intacto
    assert.deepEqual(migrateWebSearchEngines(conn), { changed: false })
    // lista parcial (ex.: versão futura/antiga) + chave da Exa → Exa mantém ligada; faltantes no fim
    set(SEARCH_KEYS_SETTING, { exa: 'exa-key-123456' })
    set(SEARCH_ENGINES_SETTING, [
      { id: 'exa', enabled: true, options: { maxResults: 4 } },
      { id: 'ddg', enabled: true, options: {} }
    ])
    assert.deepEqual(migrateWebSearchEngines(conn), { changed: true })
    const list = get(SEARCH_ENGINES_SETTING) as { id: string; enabled: boolean }[]
    assert.deepEqual(
      list.map((e) => `${e.id}:${e.enabled}`),
      ['exa:true', 'ddg:true', 'brave-site:true', 'brave-api:false', 'tavily:false']
    )
    assert.deepEqual(migrateWebSearchEngines(conn), { changed: false })
    conn.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
