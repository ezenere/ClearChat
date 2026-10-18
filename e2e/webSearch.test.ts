// web_search: parse do Brave (fixture real), detecção de bloqueio e fallback DuckDuckGo → Brave.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseBraveHtml, isBraveBlocked, unwrapBraveUrl } from '../src/main/tools/brave.ts'
import {
  runWebSearch,
  runGatedWebSearch,
  isDdgBlocked,
  normalizeSearchInterval,
  SearchGate,
  withWaitNote,
  type SearchBackends
} from '../src/main/tools/webSearch.ts'
import { parseDdgHtml } from '../src/main/tools/ddg.ts'

const fx = (name: string): string =>
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures/web', name), 'utf8')

// Páginas reais salvas: resultados do Brave renderizados na BrowserWindow para
// "typescript satisfies operator"; captcha do Brave via fetch (HTTP 429); captcha do DuckDuckGo.
const BRAVE = fx('brave-results.html')
const BRAVE_CAPTCHA = fx('brave-captcha.html')
const DDG_CAPTCHA = fx('ddg-captcha.html')
const DDG_OK = `<div class="result results_links web-result "><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fddg.example%2F">DDG título</a><a class="result__snippet" href="x">trecho ddg</a></div>`
const DDG_EMPTY = `<div class="no-results">No results.</div>`

test('Brave: parse da página real (orgânicos, sem vídeos/related/find elsewhere)', () => {
  const r = parseBraveHtml(BRAVE)
  assert.equal(r.length, 20)
  assert.deepEqual(r[0], {
    title: 'TypeScript: Documentation - TypeScript 4.9',
    url: 'https://www.typescriptlang.org/docs/handbook/release-notes/typescript-4-9.html',
    snippet: r[0].snippet
  })
  assert.match(r[0].snippet, /^We could try to catch that bleu typo/)
  assert.match(r[0].snippet, /lets us validate that the type of an expression/)
  assert.ok(!r[0].snippet.includes('<'))
  // resultado com Q&A (Stack Overflow) tem trecho do conteúdo, não vazio
  assert.match(r[1].url, /^https:\/\/stackoverflow\.com\/questions\/78636946/)
  assert.ok(r[1].snippet.length > 20)
  for (const x of r) {
    assert.match(x.url, /^https?:\/\//)
    assert.ok(!/search\.brave\.com|imgs\.search\.brave/.test(x.url), x.url)
    assert.ok(x.title.length > 3)
    assert.ok(!/youtube\.com/.test(x.url), 'vídeos (cluster) não entram')
  }
  assert.equal(new Set(r.map((x) => x.url)).size, r.length)
  assert.equal(isBraveBlocked(BRAVE, 200), false)
})

test('Brave: anúncios/clusters/ids ignorados; redirect desembrulhado', () => {
  const html = `
  <div class="snippet svelte-x" id="llm-snippet"><a href="https://ai.example/">IA</a></div>
  <div class="snippet svelte-x" data-type="ad"><a href="https://ad.example/">Anúncio</a></div>
  <div class="snippet svelte-x" data-type="cluster"><a href="https://video.example/">Vídeo</a></div>
  <div class="snippet svelte-x" data-pos="0" data-type="web"><a href="/a/redirect?url=https%3A%2F%2Freal.example%2Fp%3Fx%3D1&amp;y=2"><cite>real.example</cite><div class="title" title="Real &amp; bom">Real &amp; b…</div></a><div class="generic-snippet"><div class="content">Trecho <strong>forte</strong></div></div></div>
  <div class="snippet svelte-x" data-pos="1" data-type="web"><a href="https://b.example/"><div class="search-snippet-title">Só texto</div></a><p>depois</p></div>
  <div class="snippet svelte-x" id="related-queries"><a href="/search?q=x">rel</a></div>
  <div class="snippet svelte-x" id="search-elsewhere"><a href="https://google.com/search?q=x">Google</a></div>`
  assert.deepEqual(parseBraveHtml(html), [
    { title: 'Real & bom', url: 'https://real.example/p?x=1', snippet: 'Trecho forte' },
    { title: 'Só texto', url: 'https://b.example/', snippet: 'depois' }
  ])
  assert.equal(unwrapBraveUrl('/search?q=abc'), null)
  assert.equal(unwrapBraveUrl('javascript:void(0)'), null)
  assert.equal(unwrapBraveUrl('https://site.com/x'), 'https://site.com/x')
})

test('detecção de bloqueio: captcha real do Brave e do DuckDuckGo', () => {
  assert.equal(parseBraveHtml(BRAVE_CAPTCHA).length, 0)
  assert.equal(isBraveBlocked(BRAVE_CAPTCHA), true)
  assert.equal(isBraveBlocked('<html><body>ok</body></html>', 429), true)
  assert.equal(isBraveBlocked('<html><body>Sem resultados</body></html>', 200), false)
  assert.equal(parseDdgHtml(DDG_CAPTCHA).length, 0)
  assert.equal(isDdgBlocked(DDG_CAPTCHA), true)
  assert.equal(isDdgBlocked(DDG_EMPTY), false)
})

function mock(
  ddg: (method: 'POST' | 'GET') => string | Error,
  brave: () => { html: string; status?: number } | Error
): SearchBackends & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    ddg: async (_q, method) => {
      calls.push(`ddg:${method}`)
      const r = ddg(method)
      if (r instanceof Error) throw r
      return r
    },
    brave: async () => {
      calls.push('brave')
      const r = brave()
      if (r instanceof Error) throw r
      return r
    }
  }
}

const sig = (): AbortSignal => new AbortController().signal

test('fallback: DDG com resultados → não chama o Brave', async () => {
  const b = mock(
    () => DDG_OK,
    () => new Error('não devia')
  )
  const r = await runWebSearch('x', b, sig())
  assert.deepEqual(b.calls, ['ddg:POST'])
  assert.equal(r.status, 'ok')
  assert.match(
    r.content,
    /^Resultados de DuckDuckGo para "x":\n\n1\. DDG título\n {3}https:\/\/ddg\.example\/\n {3}trecho ddg/
  )
})

test('fallback: DDG captcha (POST e GET) → Brave (site), com "após falha em DuckDuckGo"', async () => {
  const b = mock(
    () => DDG_CAPTCHA,
    () => ({ html: BRAVE, status: 200 })
  )
  const r = await runWebSearch('typescript satisfies operator', b, sig())
  assert.deepEqual(b.calls, ['ddg:POST', 'ddg:GET', 'brave'])
  assert.equal(r.status, 'ok')
  const lines = r.content.split('\n')
  assert.equal(
    lines[0],
    'Resultados de Brave Search (site) para "typescript satisfies operator" (após falha em DuckDuckGo: verificação anti-robô (captcha)):'
  )
  assert.equal(lines[2], '1. TypeScript: Documentation - TypeScript 4.9')
  assert.equal((r.content.match(/^\d+\. /gm) ?? []).length, 8) // LIMITS.webMaxResults
  for (const m of r.content.matchAll(/^ {3}(?!https?:)(.*)$/gm)) assert.ok(m[1].length <= 301)
})

test('fallback: erro HTTP/rede no DDG → Brave; GET recupera sem Brave', async () => {
  const b = mock(
    () => new Error('HTTP 503'),
    () => ({ html: BRAVE })
  )
  const r = await runWebSearch('q', b, sig())
  assert.deepEqual(b.calls, ['ddg:POST', 'ddg:GET', 'brave'])
  assert.match(
    r.content,
    /^Resultados de Brave Search \(site\) para "q" \(após falha em DuckDuckGo: HTTP 503\):/
  )

  const b2 = mock(
    (m) => (m === 'POST' ? DDG_CAPTCHA : DDG_OK),
    () => new Error('não devia')
  )
  const r2 = await runWebSearch('q', b2, sig())
  assert.deepEqual(b2.calls, ['ddg:POST', 'ddg:GET'])
  assert.match(r2.content, /^Resultados de DuckDuckGo para/)
})

test('fallback: "sem resultados" legítimo do DDG não chama o Brave; página estranha chama', async () => {
  const b = mock(
    () => DDG_EMPTY,
    () => new Error('não devia')
  )
  const r = await runWebSearch('zzz', b, sig())
  assert.deepEqual(b.calls, ['ddg:POST'])
  assert.equal(r.status, 'ok')
  assert.equal(r.content, 'Nenhum resultado de DuckDuckGo para "zzz".')

  const b2 = mock(
    () => '<html><body>layout novo</body></html>',
    () => ({ html: BRAVE })
  )
  const r2 = await runWebSearch('zzz', b2, sig())
  assert.deepEqual(b2.calls, ['ddg:POST', 'ddg:GET', 'brave'])
  assert.match(r2.content, /após falha em DuckDuckGo: nenhum resultado \(possível bloqueio\)/)
})

test('fallback: os dois bloqueados → erro legível citando os dois', async () => {
  const b = mock(
    () => DDG_CAPTCHA,
    () => ({ html: BRAVE_CAPTCHA, status: 429 })
  )
  const r = await runWebSearch('q', b, sig())
  assert.equal(r.status, 'error')
  assert.match(r.content, /bloqueada pelos 2 buscadores habilitados/)
  assert.match(r.content, /DuckDuckGo: verificação anti-robô/)
  assert.match(r.content, /Brave Search \(site\): verificação anti-robô.*HTTP 429/)

  const b2 = mock(
    () => new Error('fetch failed'),
    () => new Error('falha ao carregar (-106 ERR_INTERNET_DISCONNECTED)')
  )
  const r2 = await runWebSearch('q', b2, sig())
  assert.equal(r2.status, 'error')
  assert.match(r2.content, /DuckDuckGo: fetch failed; Brave Search \(site\): falha ao carregar/)
})

test('fallback: abort durante o DDG propaga AbortError (sem chamar o Brave)', async () => {
  const ac = new AbortController()
  const b: SearchBackends = {
    ddg: async () => {
      ac.abort()
      throw new Error('aborted')
    },
    brave: async () => {
      throw new Error('não devia')
    }
  }
  await assert.rejects(runWebSearch('q', b, ac.signal), { name: 'AbortError' })
})

// ---------------- intervalo mínimo global entre pesquisas ----------------

/** Relógio virtual: sleep avança o tempo quando `tick()` drena os timers pendentes, em ordem. */
function fakeClock(): {
  now: () => number
  sleep: (ms: number, signal: AbortSignal) => Promise<void>
  run: () => Promise<void>
  pending: () => number
} {
  let t = 0
  let timers: { at: number; resolve: () => void; reject: (e: Error) => void }[] = []
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 20; i++) await Promise.resolve()
  }
  return {
    now: () => t,
    sleep: (ms, signal) =>
      new Promise((resolve, reject) => {
        const timer = { at: t + ms, resolve, reject }
        timers.push(timer)
        signal.addEventListener(
          'abort',
          () => {
            timers = timers.filter((x) => x !== timer)
            const e = new Error('Aborted')
            e.name = 'AbortError'
            reject(e)
          },
          { once: true }
        )
      }),
    run: async () => {
      await flush()
      while (timers.length) {
        timers.sort((a, b) => a.at - b.at)
        const next = timers.shift()!
        t = Math.max(t, next.at)
        next.resolve()
        await flush()
      }
    },
    pending: () => timers.length
  }
}

test('intervalo: chamadas sequenciais respeitam o intervalo (espera só o restante)', async () => {
  const c = fakeClock()
  const gate = new SearchGate({ intervalMs: () => 5000, now: c.now, sleep: c.sleep })
  assert.equal(await gate.acquire(sig()), 0)
  const p = gate.acquire(sig())
  await c.run()
  assert.equal(await p, 5000)
  assert.equal(c.now(), 5000)
  // 7 s depois da última: sem espera
  const c2 = fakeClock()
  let t = 0
  const g2 = new SearchGate({ intervalMs: () => 5000, now: () => t, sleep: c2.sleep })
  await g2.acquire(sig())
  t = 2000
  const waits: number[] = []
  const p2 = g2.acquire(sig(), (ms) => {
    waits.push(ms)
    t += ms
  })
  await c2.run()
  assert.deepEqual(waits, [3000])
  t = 12_000
  assert.equal(await g2.acquire(sig()), 0)
  await p2
})

test('intervalo: 3 chamadas simultâneas saem a 0, 5 e 10 s', async () => {
  const c = fakeClock()
  const gate = new SearchGate({ intervalMs: () => 5000, now: c.now, sleep: c.sleep })
  const starts: number[] = []
  const ps = [1, 2, 3].map(() => gate.acquire(sig()).then(() => starts.push(c.now())))
  await c.run()
  await Promise.all(ps)
  assert.deepEqual(starts, [0, 5000, 10_000])
})

test('intervalo: abort durante a espera/fila não consome a vez', async () => {
  const c = fakeClock()
  const gate = new SearchGate({ intervalMs: () => 5000, now: c.now, sleep: c.sleep })
  await gate.acquire(sig()) // t=0
  const ac = new AbortController()
  const ac2 = new AbortController()
  const a = gate.acquire(ac.signal) // espera o intervalo
  const b = gate.acquire(ac2.signal) // na fila atrás de "a"
  const starts: number[] = []
  const d = gate.acquire(sig()).then(() => starts.push(c.now()))
  await Promise.resolve()
  ac2.abort() // sai da fila
  ac.abort() // cancela a espera
  await assert.rejects(a, { name: 'AbortError' })
  await assert.rejects(b, { name: 'AbortError' })
  await c.run()
  await d
  assert.deepEqual(starts, [5000]) // "d" sai no 1º horário livre (os cancelados não contaram)
  // já abortado antes: rejeita na hora
  const ac3 = new AbortController()
  ac3.abort()
  await assert.rejects(gate.acquire(ac3.signal), { name: 'AbortError' })
  assert.equal(c.pending(), 0)
})

test('intervalo: 0 = sem espera; config relida a cada pesquisa; normalização', async () => {
  const c = fakeClock()
  let iv = 0
  const gate = new SearchGate({ intervalMs: () => iv, now: c.now, sleep: c.sleep })
  for (let i = 0; i < 3; i++) assert.equal(await gate.acquire(sig()), 0)
  assert.equal(c.pending(), 0)
  iv = 5000
  const p = gate.acquire(sig())
  await c.run()
  assert.equal(await p, 5000)
  assert.equal(normalizeSearchInterval(null), 5)
  assert.equal(normalizeSearchInterval('abc'), 5)
  assert.equal(normalizeSearchInterval(-3), 0)
  assert.equal(normalizeSearchInterval(999), 60)
  assert.equal(normalizeSearchInterval('2.54'), 2.5)
})

test('intervalo: DDG bloqueado → Brave na hora (sem esperar); próxima volta ao DDG respeitando o intervalo', async () => {
  const c = fakeClock()
  const gate = new SearchGate({ intervalMs: () => 5000, now: c.now, sleep: c.sleep })
  const log: string[] = []
  let ddgBlocked = true
  const b: SearchBackends = {
    ddg: async (_q, m) => {
      log.push(`ddg:${m}@${c.now()}`)
      return ddgBlocked ? DDG_CAPTCHA : DDG_OK
    },
    brave: async () => {
      log.push(`brave@${c.now()}`)
      return { html: BRAVE, status: 200 }
    }
  }
  const r1 = await runGatedWebSearch('q', b, sig(), gate)
  assert.match(
    r1.content.split('\n')[0],
    /após falha em DuckDuckGo: verificação anti-robô \(captcha\)\):$/
  )
  ddgBlocked = false
  const waits: number[] = []
  const p = runGatedWebSearch('q', b, sig(), gate, (ms) => waits.push(ms))
  await c.run()
  const r2 = await p
  assert.deepEqual(log, ['ddg:POST@0', 'ddg:GET@0', 'brave@0', 'ddg:POST@5000'])
  assert.deepEqual(waits, [5000])
  assert.equal(
    r2.content.split('\n')[0],
    'Resultados de DuckDuckGo para "q": [aguardou 5,0 s pelo intervalo entre pesquisas]'
  )
})

test('intervalo: nota de espera na 1ª linha (só se esperou)', () => {
  assert.equal(withWaitNote('a\nb', 50), 'a\nb')
  assert.equal(
    withWaitNote('Erro: x', 3240),
    'Erro: x [aguardou 3,2 s pelo intervalo entre pesquisas]'
  )
})
