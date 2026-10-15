/* eslint-disable @typescript-eslint/no-explicit-any */
// Testes unitários (sem Electron) de buildRequest, parsers de stream e tools em modo texto.
// Rodar: npm run test:unit  (node --import ./e2e/ts-hooks.mjs --test e2e/unit.test.ts)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildRequest, maskKey, maskRequest, sanitizeHistory } from '../src/main/agent/request.ts'
import {
  applyChunk,
  newAccumulator,
  finalizeToolCalls,
  parseUsage,
  readableError
} from '../src/main/agent/llm.ts'
import { parseTextToolCalls } from '../src/main/agent/textTools.ts'
import { DEFAULT_CHAT_CONFIG } from '../src/shared/defaults.ts'
import type { Chat, Provider, StoredMessage, ApiMessage } from '../src/shared/types.ts'

const env = { os: 'Linux 6.0 (x64)', shell: 'bash' }
const orProvider: Provider = {
  id: 'p1',
  name: 'OR',
  baseUrl: 'https://openrouter.ai/api/v1',
  apiKey: 'sk-or-v1-0123456789abcdefa3b9',
  headers: { 'X-Extra': '1' },
  createdAt: 0
}
const otherProvider: Provider = {
  ...orProvider,
  baseUrl: 'https://api.example.com/v1',
  headers: {}
}

const mkChat = (over: Partial<Chat['config']> = {}): Chat => ({
  id: 'c1',
  title: '',
  mainSessionId: 's1',
  createdAt: 0,
  updatedAt: 0,
  config: {
    ...DEFAULT_CHAT_CONFIG('/work', { providerId: 'p1', model: 'm', systemPrompt: 'SYS' }),
    ...over
  }
})
let seq = 0
const sm = (message: ApiMessage, meta = {}): StoredMessage => ({
  id: String(++seq),
  sessionId: 's1',
  seq,
  message,
  meta,
  createdAt: 0
})

test('system + env + tools + cache_control na cópia', () => {
  const hist = [
    sm({ role: 'user', content: 'oi' }),
    sm({ role: 'assistant', content: 'olá' }),
    sm({ role: 'user', content: 'leia x' })
  ]
  const before = JSON.stringify(hist)
  const req = buildRequest(mkChat(), { depth: 0, model: 'm' }, hist, orProvider, env)
  const body = req.body as any
  assert.equal(req.url, 'https://openrouter.ai/api/v1/chat/completions')
  assert.equal(body.model, 'm')
  assert.equal(body.stream, true)
  assert.deepEqual(body.stream_options, { include_usage: true })
  assert.deepEqual(body.usage, { include: true })
  assert.equal(body.messages[0].role, 'system')
  assert.equal(body.messages[0].content[0].cache_control.type, 'ephemeral')
  assert.equal(
    body.messages[0].content[0].text,
    'SYS\n\n<environment>\nroot: /work\nos: Linux 6.0 (x64)\nshell: bash\n' +
      'Diretório raiz (workspace) desta sessão: root acima. Caminhos relativos nas ferramentas resolvem a partir dele e o bash começa nele (o diretório do shell persiste entre chamadas).\n' +
      'As ferramentas de arquivo só acessam caminhos dentro do diretório raiz.\n</environment>'
  )
  // último user com cache_control; o primeiro user continua string
  assert.equal(body.messages[1].content, 'oi')
  assert.deepEqual(body.messages[3].content, [
    { type: 'text', text: 'leia x', cache_control: { type: 'ephemeral' } }
  ])
  assert.equal(JSON.stringify(hist), before, 'histórico não pode ser mutado')
  assert.equal(body.tools.length, 11)
  assert.equal(body.tools[0].function.name, 'list_dir')
  assert.ok(body.tools.some((t: any) => t.function.name === 'search_files'))
  assert.equal(req.headers['Authorization'], `Bearer ${orProvider.apiKey}`)
  assert.equal(req.headers['X-Title'], 'ClearChat')
  assert.ok(req.headers['HTTP-Referer'])
  assert.equal(req.headers['X-Extra'], '1')
})

test('cache: breakpoint na última mensagem (tool) + último user; erros não vão', () => {
  const hist = [
    sm({ role: 'user', content: 'antigo' }),
    sm({ role: 'assistant', content: 'ok' }),
    sm({ role: 'user', content: 'leia a e b' }),
    sm(
      { role: 'assistant', content: '' },
      { kind: 'error', synthetic: true, error: 'Erro HTTP 500' }
    ),
    sm({
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 't1', type: 'function', function: { name: 'read_file', arguments: '{}' } }]
    }),
    sm({ role: 'tool', tool_call_id: 't1', content: 'conteúdo a' })
  ]
  const before = JSON.stringify(hist)
  const body = buildRequest(mkChat(), { depth: 0, model: 'm' }, hist, orProvider, env).body as any
  const msgs = body.messages
  assert.equal(msgs.length, 6, 'mensagem de erro excluída')
  assert.ok(!msgs.some((m: any) => m.role === 'assistant' && m.content === ''))
  const marks = JSON.stringify(msgs).split('cache_control').length - 1
  assert.equal(marks, 3, 'system + última + último user')
  assert.deepEqual(msgs[5], {
    role: 'tool',
    tool_call_id: 't1',
    content: [{ type: 'text', text: 'conteúdo a', cache_control: { type: 'ephemeral' } }]
  })
  assert.deepEqual(msgs[3].content, [
    { type: 'text', text: 'leia a e b', cache_control: { type: 'ephemeral' } }
  ])
  assert.equal(msgs[1].content, 'antigo')
  assert.equal(msgs[4].content, null, 'assistant só com tool_calls não é tocado')
  assert.equal(JSON.stringify(hist), before, 'histórico não pode ser mutado')
  // última = assistant com texto → ela recebe o breakpoint (content vira parts na cópia)
  const h2 = [sm({ role: 'user', content: 'oi' }), sm({ role: 'assistant', content: 'olá' })]
  const b2 = buildRequest(mkChat(), { depth: 0, model: 'm' }, h2, orProvider, env).body as any
  assert.deepEqual(b2.messages[2].content, [
    { type: 'text', text: 'olá', cache_control: { type: 'ephemeral' } }
  ])
  assert.equal(JSON.stringify(b2.messages).split('cache_control').length - 1, 3)
})

test('sem cache, sem env, system vazio → sem mensagem system; depth 2 sem delegate', () => {
  const chat = mkChat({ cacheEnabled: false, envInPrompt: false, subagentSystemPrompt: '' })
  const req = buildRequest(
    chat,
    { depth: 2, model: 'x' },
    [sm({ role: 'user', content: 't' })],
    orProvider,
    env
  )
  const body = req.body as any
  assert.equal(body.messages.length, 1)
  assert.equal(body.messages[0].content, 't')
  assert.ok(!body.tools.some((t: any) => t.function.name === 'delegate_task'))
  assert.equal(body.tools.length, 10)
})

test('toolsInPrompt usa só as tools disponíveis; nativeTools=false omite tools', () => {
  const chat = mkChat({
    toolsInPrompt: true,
    nativeTools: false,
    enabledTools: ['read_file', 'delegate_task'],
    cacheEnabled: false
  })
  const r2 = buildRequest(chat, { depth: 2, model: 'x' }, [], orProvider, env).body as any
  assert.equal(r2.tools, undefined)
  const sys = r2.messages[0].content as string
  assert.match(sys, /<tool_call>/)
  assert.match(sys, /## read_file/)
  assert.doesNotMatch(sys, /## delegate_task/)
  const r0 = buildRequest(chat, { depth: 0, model: 'x' }, [], orProvider, env).body as any
  assert.match(r0.messages[0].content, /## delegate_task/)
})

test('params definidos, reasoning_effort, extraBody por último', () => {
  const chat = mkChat({
    params: {
      temperature: 0.2,
      top_p: undefined,
      seed: 0,
      reasoning_effort: 'low',
      extraBody: '{"temperature": 0.9, "foo": {"a": 1}}'
    }
  })
  const b = buildRequest(chat, { depth: 0, model: 'm' }, [], orProvider, env).body as any
  assert.equal(b.temperature, 0.9) // extraBody vence
  assert.equal(b.seed, 0)
  assert.ok(!('top_p' in b))
  assert.deepEqual(b.reasoning, { effort: 'low' })
  assert.deepEqual(b.foo, { a: 1 })
  const b2 = buildRequest(
    mkChat({ params: { reasoning_effort: 'high' } }),
    { depth: 0, model: 'm' },
    [],
    otherProvider,
    env
  ).body as any
  assert.equal(b2.reasoning_effort, 'high')
  assert.equal(b2.usage, undefined)
  assert.throws(
    () =>
      buildRequest(
        mkChat({ params: { extraBody: '{oops' } }),
        { depth: 0, model: 'm' },
        [],
        orProvider,
        env
      ),
    /extraBody não é um JSON válido/
  )
  assert.throws(
    () =>
      buildRequest(
        mkChat({ params: { extraBody: '[1]' } }),
        { depth: 0, model: 'm' },
        [],
        orProvider,
        env
      ),
    /objeto JSON/
  )
})

test('sanitizeHistory: pareamento, órfãs, reasoning', () => {
  const msgs: ApiMessage[] = [
    { role: 'user', content: 'a' },
    {
      role: 'assistant',
      content: null,
      reasoning: 'r',
      tool_calls: [
        { id: 't1', type: 'function', function: { name: 'list_dir', arguments: '{}' } },
        { id: 't2', type: 'function', function: { name: 'list_dir', arguments: '{}' } }
      ]
    },
    { role: 'tool', tool_call_id: 't1', content: 'ok' },
    { role: 'tool', tool_call_id: 'zz', content: 'órfã' },
    { role: 'user', content: 'b' }
  ]
  const out = sanitizeHistory(msgs, false)
  assert.equal(out.length, 5)
  assert.ok(!('reasoning' in out[1]))
  assert.deepEqual(out[3], {
    role: 'tool',
    tool_call_id: 't2',
    content: '[Resultado indisponível]'
  })
  assert.equal((sanitizeHistory(msgs, true)[1] as any).reasoning, 'r')
})

test('mascaramento da key', () => {
  assert.equal(maskKey('sk-or-v1-0123456789abcdefa3b9'), 'sk-or-…a3b9')
  const req = buildRequest(mkChat(), { depth: 0, model: 'm' }, [], orProvider, env)
  const masked = maskRequest(req, orProvider.apiKey)
  assert.equal(masked.headers['Authorization'], 'Bearer sk-or-…a3b9')
  assert.ok(!JSON.stringify(masked).includes(orProvider.apiKey))
})

test('stream: acumula content/reasoning/tool_calls por index e usage', () => {
  const acc = newAccumulator()
  applyChunk(acc, { choices: [{ delta: { reasoning: 'pen' } }] })
  applyChunk(acc, { choices: [{ delta: { reasoning_content: 'sando' } }] })
  applyChunk(acc, { choices: [{ delta: { content: 'Oi' } }] })
  applyChunk(acc, {
    choices: [
      {
        delta: {
          tool_calls: [{ index: 0, id: 'c1', function: { name: 'read_', arguments: '{"pa' } }]
        }
      }
    ]
  })
  applyChunk(acc, {
    choices: [
      { delta: { tool_calls: [{ index: 0, function: { name: 'file', arguments: 'th":"a"}' } }] } }
    ]
  })
  applyChunk(acc, {
    choices: [
      {
        delta: { tool_calls: [{ index: 1, id: 'c2', function: { name: 'bash', arguments: '{}' } }] }
      }
    ]
  })
  applyChunk(acc, {
    choices: [{ delta: {}, finish_reason: 'tool_calls' }],
    usage: {
      prompt_tokens: 100,
      completion_tokens: 5,
      prompt_tokens_details: { cached_tokens: 80, cache_write_tokens: 3 },
      completion_tokens_details: { reasoning_tokens: 2 },
      cost: 0.001
    }
  })
  assert.equal(acc.reasoning, 'pensando')
  assert.equal(acc.content, 'Oi')
  const calls = finalizeToolCalls(acc)
  assert.deepEqual(calls, [
    { id: 'c1', name: 'read_file', arguments: '{"path":"a"}' },
    { id: 'c2', name: 'bash', arguments: '{}' }
  ])
  assert.deepEqual(acc.usage, {
    promptTokens: 100,
    completionTokens: 5,
    cachedTokens: 80,
    cacheWriteTokens: 3,
    reasoningTokens: 2,
    cost: 0.001
  })
  assert.equal(parseUsage(null), undefined)
  assert.throws(() => applyChunk(newAccumulator(), { error: { message: 'boom' } }), /boom/)
})

test('erro HTTP legível', () => {
  const m = readableError(
    401,
    'Unauthorized',
    JSON.stringify({ error: { message: 'No auth credentials found', code: 401 } })
  )
  assert.equal(m, 'Erro HTTP 401 Unauthorized: No auth credentials found')
  assert.match(readableError(500, '', 'plain text'), /plain text/)
})

test('parse de <tool_call> em modo texto', () => {
  const calls = parseTextToolCalls(
    'Vou ler.\n<tool_call>{"name": "read_file", "arguments": {"path": "a.txt"}}</tool_call>\n<tool_call>{bad}</tool_call>'
  )
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[0].args, { path: 'a.txt' })
  assert.equal(calls[0].name, 'read_file')
  assert.ok(calls[1].error)
})

test('DuckDuckGo: parse, entidades, uddg, anúncios', async () => {
  const { parseDdgHtml, unwrapDdgUrl, decodeEntities } = await import('../src/main/tools/ddg.ts')
  const html = `
  <div class="result results_links results_links_deep result--ad "><a class="result__a" href="https://duckduckgo.com/y.js?ad=1">Anúncio</a></div>
  <div class="result results_links results_links_deep web-result ">
    <h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa%3Fb%3D1&amp;rut=xyz">Título &amp; <b>mais</b></a></h2>
    <a class="result__snippet" href="x">Trecho com &#x27;aspas&#x27; e &quot;duplas&quot;</a>
  </div>
  <div class="result results_links web-result "><a rel="nofollow" class="result__a" href="https://direct.org/">Direto</a></div>`
  const r = parseDdgHtml(html)
  assert.equal(r.length, 2)
  assert.deepEqual(r[0], {
    title: 'Título & mais',
    url: 'https://example.com/a?b=1',
    snippet: `Trecho com 'aspas' e "duplas"`
  })
  assert.equal(r[1].url, 'https://direct.org/')
  assert.equal(unwrapDdgUrl('https://site.com/x'), 'https://site.com/x')
  assert.equal(decodeEntities('&lt;a&gt; &#65;'), '<a> A')
})

test('assinatura de app: none / cline / custom / padrão / provider.headers sobrescrevem', async () => {
  const {
    resolveAppSignatureHeaders,
    normalizeAppSignatureId,
    DEFAULT_APP_SIGNATURE,
    APP_SIGNATURES
  } = await import('../src/shared/appSignatures.ts')
  assert.deepEqual(resolveAppSignatureHeaders('none'), {})
  assert.deepEqual(resolveAppSignatureHeaders('cline'), {
    'HTTP-Referer': 'https://cline.bot',
    'X-Title': 'Cline'
  })
  assert.deepEqual(resolveAppSignatureHeaders('custom', { referer: 'https://x.dev', title: '' }), {
    'HTTP-Referer': 'https://x.dev'
  })
  assert.equal(resolveAppSignatureHeaders('???')['X-Title'], 'ClearChat')
  // alias silencioso do id antigo (typo "CleartChat") e padrão 'clearchat'
  assert.equal(DEFAULT_APP_SIGNATURE, 'clearchat')
  assert.equal(normalizeAppSignatureId('cleartchat'), 'clearchat')
  assert.equal(normalizeAppSignatureId(undefined), 'clearchat')
  assert.equal(normalizeAppSignatureId('cline'), 'cline')
  assert.deepEqual(
    resolveAppSignatureHeaders('cleartchat'),
    resolveAppSignatureHeaders('clearchat')
  )
  assert.ok(!APP_SIGNATURES.some((s) => s.id === 'cleartchat'))
  assert.ok(APP_SIGNATURES.some((s) => s.id === 'custom') && APP_SIGNATURES[0].id === 'none')
  const h = (cfg: any, prov: Provider = orProvider): Record<string, string> =>
    buildRequest(mkChat(cfg), { depth: 1, model: 'm' }, [], prov, env).headers
  assert.ok(
    !('X-Title' in h({ appSignature: 'none' })) && !('HTTP-Referer' in h({ appSignature: 'none' }))
  )
  assert.equal(h({ appSignature: 'aider' }, otherProvider)['X-Title'], 'Aider') // qualquer provider
  assert.equal(
    h({ appSignature: 'custom', appSignatureCustom: { referer: 'https://r', title: 'T' } })[
      'HTTP-Referer'
    ],
    'https://r'
  )
  assert.equal(h({ appSignature: undefined })['X-Title'], 'ClearChat') // chats antigos
  assert.equal(h({ appSignature: 'cleartchat' })['X-Title'], 'ClearChat') // id antigo
  assert.equal(
    h({ appSignature: 'cline' }, { ...orProvider, headers: { 'X-Title': 'Mine' } })['X-Title'],
    'Mine'
  )
})

test('parse de <tool_call> tolerante (tag malformada, sem fechamento, chaves extras)', () => {
  const a = parseTextToolCalls(
    '<tool_call{"name": "read_file", "arguments": {"path": "input.txt", "offset": 1}}}'
  )
  assert.equal(a.length, 1)
  assert.equal(a[0].name, 'read_file')
  assert.deepEqual(a[0].args, { path: 'input.txt', offset: 1 })
  const b = parseTextToolCalls(
    '<tool_call>\n```json\n{"name":"bash","arguments":{"command":"echo \\"}\\""}}\n```\n</tool_call> texto <tool_call>{"name":"list_dir","arguments":{}}'
  )
  assert.deepEqual(
    b.map((x) => x.name),
    ['bash', 'list_dir']
  )
  assert.equal(b[0].args.command, 'echo "}"')
  assert.equal(parseTextToolCalls('sem chamadas').length, 0)
})

test('modo texto: JSON puro (sem tags) com tool conhecida vira chamada', () => {
  const known = ['list_dir', 'bash']
  const a = parseTextToolCalls('{"name": "list_dir", "arguments": {"path": "."}}', known)
  assert.deepEqual(
    a.map((c) => [c.name, c.args]),
    [['list_dir', { path: '.' }]]
  )
  const b = parseTextToolCalls('```json\n{"name":"bash","arguments":{"command":"ls"}}\n```', known)
  assert.equal(b[0]?.name, 'bash')
  assert.equal(parseTextToolCalls('{"name": "outra", "arguments": {}}', known).length, 0)
  assert.equal(parseTextToolCalls('texto {"name": "list_dir"}', known).length, 0)
})

// ======================= diretório raiz / limites / compactação =======================

import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after } from 'node:test'
import { resolveToolPath, truncateHeadTail } from '../src/main/tools/util.ts'
import { listDir, readFile, renderFileWindow, writeFile } from '../src/main/tools/files.ts'
import { bash, BASH_HINT } from '../src/main/tools/bash.ts'
import { _setRipgrep, findFiles, globToRegExp, searchFiles } from '../src/main/tools/search.ts'
import {
  buildCompactionRequest,
  compactionHistory,
  compactionMeta,
  splitPending
} from '../src/main/agent/compaction.ts'
import {
  activeHistory,
  contextUsage,
  hasCompactableHistory,
  isContextLengthError,
  resolveContextWindow
} from '../src/shared/context.ts'
import { compactionMessageText } from '../src/shared/defaults.ts'

// Rascunho: CLEARCHAT_TEST_TMP (se definido) ou o tmp do sistema; apagado no fim.
const TMP = mkdtempSync(join(process.env.CLEARCHAT_TEST_TMP || tmpdir(), 'clearchat-unit-'))
after(() => rmSync(TMP, { recursive: true, force: true }))

const ROOT = join(TMP, 'root')
const OUTSIDE = join(TMP, 'outside')
mkdirSync(join(ROOT, 'sub'), { recursive: true })
mkdirSync(OUTSIDE, { recursive: true })
writeFileSync(join(ROOT, 'a.txt'), 'linha 1\nlinha 2\nlinha 3\n')
writeFileSync(join(OUTSIDE, 'secret.txt'), 'segredo')
symlinkSync(OUTSIDE, join(ROOT, 'link')) // escapa da raiz
symlinkSync(join(ROOT, 'sub'), join(ROOT, 'inner-link')) // fica dentro
const ROOT_LINK = join(TMP, 'root-alias')
symlinkSync(ROOT, ROOT_LINK) // a própria raiz via symlink

const ctl = (over: Record<string, unknown> = {}): any => ({
  cwd: ROOT,
  confine: true,
  signal: new AbortController().signal,
  ...over
})

test('confinação: .., absoluto fora, symlink que escapa, symlink interno, raiz via symlink', async () => {
  const c = ctl()
  assert.equal(await resolveToolPath(c, 'a.txt'), join(ROOT, 'a.txt'))
  assert.equal(await resolveToolPath(c, 'sub/../a.txt'), join(ROOT, 'a.txt'))
  assert.equal(await resolveToolPath(c, undefined), ROOT)
  await resolveToolPath(c, 'inner-link/x.txt') // link para dentro da raiz: ok
  await resolveToolPath(c, 'sub/novo/arquivo.txt') // ainda não existe: ok
  await assert.rejects(resolveToolPath(c, '../outside/secret.txt'), /fora do diretório raiz/)
  await assert.rejects(resolveToolPath(c, 'sub/../../outside'), /fora do diretório raiz/)
  await assert.rejects(resolveToolPath(c, join(OUTSIDE, 'secret.txt')), /fora do diretório raiz/)
  await assert.rejects(resolveToolPath(c, '/etc/passwd'), /fora do diretório raiz/)
  await assert.rejects(resolveToolPath(c, 'link/secret.txt'), /fora do diretório raiz/)
  await assert.rejects(resolveToolPath(c, 'link/novo.txt'), /fora do diretório raiz/) // inexistente sob o link
  await assert.rejects(resolveToolPath(c, 'link'), /fora do diretório raiz/)
  // raiz configurada por um caminho com symlink
  assert.equal(await resolveToolPath(ctl({ cwd: ROOT_LINK }), 'a.txt'), join(ROOT_LINK, 'a.txt'))
  // as tools aplicam a confinação
  await assert.rejects(readFile({ path: '../outside/secret.txt' }, c), /fora do diretório raiz/)
  await assert.rejects(
    writeFile({ path: 'link/pwn.txt', content: 'x' }, c),
    /fora do diretório raiz/
  )
  await assert.rejects(listDir({ path: '/' }, c), /fora do diretório raiz/)
  // desligada: absoluto fora é aceito
  const r = await readFile({ path: join(OUTSIDE, 'secret.txt') }, ctl({ confine: false }))
  assert.match(r.content, /1\tsegredo/)
})

test('read_file: janela padrão, cabeçalho de arquivo grande, offset/limit, linhas longas, binário, limite rígido', async () => {
  const small = await readFile({ path: 'a.txt' }, ctl())
  assert.equal(small.content, '1\tlinha 1\n2\tlinha 2\n3\tlinha 3\n[fim do arquivo · 3 linhas]')

  writeFileSync(
    join(ROOT, 'big.txt'),
    Array.from({ length: 5000 }, (_, i) => `linha ${i + 1}`).join('\n') + '\n'
  )
  const big = await readFile({ path: 'big.txt' }, ctl({ maxOutput: 100_000 }))
  assert.match(
    big.content,
    /^\[arquivo grande: 5\.000 linhas, [\d,]+ KB — mostrando linhas 1–2\.000\. Use offset\/limit para ler o resto, ou search_files para localizar trechos\.\]\n1\tlinha 1\n/
  )
  assert.match(big.content, /\n2000\tlinha 2000$/)
  assert.ok(!big.content.includes('2001\t'))

  const tail = await readFile({ path: 'big.txt', offset: 4990, limit: 50 }, ctl())
  assert.match(
    tail.content,
    /^\[arquivo com 5\.000 linhas \([^)]+\) — mostrando linhas 4\.990–5\.000\. Fim do arquivo\.\]\n4990\t/
  )
  const mid = await readFile({ path: 'big.txt', offset: 10, limit: 5 }, ctl())
  assert.match(
    mid.content,
    /^\[arquivo com 5\.000 linhas .* — mostrando linhas 10–14\. Continue com offset=15\.\]/
  )

  // teto de caracteres: corta em linha inteira e diz por quê
  const capped = await readFile({ path: 'big.txt' }, ctl({ maxOutput: 3000 }))
  assert.ok(capped.content.length <= 3000, `len ${capped.content.length}`)
  assert.match(capped.content, /limite de caracteres da saída/)
  assert.match(capped.content, /mostrando linhas 1–\d+ \(/)

  // linha longa
  writeFileSync(join(ROOT, 'long.txt'), 'x'.repeat(5000) + '\nfim\n')
  const long = await readFile({ path: 'long.txt' }, ctl())
  assert.match(long.content, /\[… linha cortada: 5\.000 caracteres\]/)
  assert.match(long.content, /2\tfim/)

  // binário
  writeFileSync(
    join(ROOT, 'img.png'),
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
  )
  const bin = await readFile({ path: 'img.png' }, ctl())
  assert.equal(bin.status, 'error')
  assert.match(bin.content, /binário \(imagem PNG, 12 B\)/)

  // acima do limite rígido (5 MB): sem offset não lê; com offset lê em streaming
  const line = 'y'.repeat(99) + '\n'
  writeFileSync(join(ROOT, 'huge.log'), line.repeat(60_000)) // ~6 MB
  const huge = await readFile({ path: 'huge.log' }, ctl())
  assert.equal(huge.status, 'error')
  assert.match(huge.content, /arquivo muito grande: .* MB — não foi lido/)
  const part = await readFile({ path: 'huge.log', offset: 59_999, limit: 10 }, ctl())
  assert.match(
    part.content,
    /^\[arquivo com 60\.000 linhas .* — mostrando linhas 59\.999–60\.000\./
  )

  // renderFileWindow pura: arquivo vazio a partir do offset
  assert.match(
    renderFileWindow({
      lines: [],
      start: 10,
      totalLines: 3,
      sizeBytes: 10,
      explicit: true,
      maxChars: 1000
    }),
    /tem 3 linhas .*nada a partir da linha 10/
  )
})

test('list_dir: limite de entradas e tamanhos', async () => {
  const many = join(ROOT, 'many')
  mkdirSync(many)
  for (let i = 0; i < 320; i++) writeFileSync(join(many, `f${String(i).padStart(3, '0')}.txt`), 'x')
  const r = await listDir({ path: 'many' }, ctl())
  assert.match(r.content, /\[0 pastas, 320 arquivos\]/)
  assert.match(r.content, /f000\.txt {2}\(1 B\)/)
  assert.match(r.content, /mais 20 entradas omitidas \(limite 300\)/)
  assert.ok(!r.content.includes('f300.txt'))
})

test('truncateHeadTail: mantém início (40%) e fim (60%) com marcador de chars/linhas', () => {
  const s = Array.from({ length: 20_000 }, (_, i) => `linha ${i}`).join('\n')
  const out = truncateHeadTail(s, 5000, 0.4, BASH_HINT)
  assert.ok(out.length <= 5000, `len ${out.length}`)
  assert.ok(out.startsWith('linha 0\nlinha 1\n'))
  assert.ok(out.endsWith('linha 19999'))
  const m = /\[… ([\d.]+) chars \/ ([\d.]+) linhas omitidos …\]/.exec(out)
  assert.ok(m, 'marcador')
  const omittedChars = Number(m![1].replace(/\./g, ''))
  assert.ok(omittedChars > s.length - 5000)
  assert.ok(out.includes(BASH_HINT))
  const [head, tail] = out.split(/\[… .* …\]\n.*\n/)
  assert.ok(head.length < tail.length, 'fim maior que o início')
  assert.equal(truncateHeadTail('curto', 100), 'curto')
})

test('bash: corta saída enorme (início + fim) e persiste o cd entre chamadas', async () => {
  const shell = { root: ROOT, dir: ROOT }
  const big = await bash({ command: 'seq 1 200000' }, ctl({ maxOutput: 6000, shell }))
  assert.ok(big.content.length <= 6200, `len ${big.content.length}`)
  assert.ok(big.content.startsWith('1\n2\n3\n'))
  assert.match(big.content, /\n200000\n\[exit code: 0\]$/)
  assert.match(big.content, /linhas omitidos …\]/)
  assert.ok(big.content.includes(BASH_HINT))

  const r1 = await bash({ command: 'mkdir -p proj/src && cd proj/src && echo ok' }, ctl({ shell }))
  assert.equal(shell.dir, join(ROOT, 'proj/src'))
  assert.equal(r1.meta?.shellCwd, join(ROOT, 'proj/src'))
  assert.match(r1.content, /ok\n\[exit code: 0\]\n\[cwd: .*proj\/src\]$/)
  const r2 = await bash({ command: 'pwd' }, ctl({ shell }))
  assert.match(r2.content, new RegExp(`^${join(ROOT, 'proj/src')}\\n`))
  // `exit` no meio ainda registra o diretório (trap EXIT) e o código
  const r3 = await bash({ command: 'cd .. && exit 3' }, ctl({ shell }))
  assert.match(r3.content, /\[exit code: 3\]/)
  assert.equal(shell.dir, join(ROOT, 'proj'))
  // confinado: terminar fora da raiz volta para a raiz e avisa
  const r4 = await bash({ command: 'cd /' }, ctl({ shell }))
  assert.equal(shell.dir, ROOT)
  assert.match(
    r4.content,
    /terminou fora do diretório raiz \(\/\); a próxima chamada começará no diretório raiz/
  )
  const r5 = await bash({ command: 'pwd' }, ctl({ shell }))
  assert.match(r5.content, new RegExp(`^${ROOT}\\n`))
  // sem confinação o diretório fora da raiz persiste
  const free = { root: ROOT, dir: ROOT }
  await bash({ command: `cd ${OUTSIDE}` }, ctl({ shell: free, confine: false }))
  assert.equal(free.dir, OUTSIDE)
  // diretório salvo apagado → começa na raiz
  const gone = { root: ROOT, dir: join(ROOT, 'nao-existe') }
  const r6 = await bash({ command: 'pwd' }, ctl({ shell: gone }))
  assert.match(r6.content, /não está disponível; começando no diretório raiz/)
})

test('search_files / find_files (ripgrep e fallback JS): ignora node_modules, limita resultados', async () => {
  const proj = join(ROOT, 'proj2')
  mkdirSync(join(proj, 'src'), { recursive: true })
  mkdirSync(join(proj, 'node_modules', 'dep'), { recursive: true })
  writeFileSync(join(proj, 'src', 'main.ts'), 'const a = 1\n// NEEDLE_42 aqui\n')
  writeFileSync(join(proj, 'README.md'), '# needle_42 minúsculo\n')
  writeFileSync(join(proj, 'node_modules', 'dep', 'x.js'), 'NEEDLE_42')
  writeFileSync(join(proj, 'many.txt'), Array.from({ length: 80 }, () => 'NEEDLE_42').join('\n'))
  for (const rg of [null, false]) {
    _setRipgrep(rg)
    const label = rg === false ? 'js' : 'rg'
    const r = await searchFiles({ pattern: 'NEEDLE_\\d+', path: 'proj2', glob: '*.ts' }, ctl())
    assert.match(r.content, /proj2\/src\/main\.ts:2:\/\/ NEEDLE_42 aqui/, label)
    assert.ok(!r.content.includes('node_modules'), `${label}: node_modules`)
    const ci = await searchFiles(
      { pattern: 'NEEDLE_42', path: 'proj2', case_insensitive: true, glob: '*.md' },
      ctl()
    )
    assert.match(ci.content, /README\.md:1:/, label)
    const star = await searchFiles({ pattern: 'NEEDLE_42', path: 'proj2', glob: '*' }, ctl())
    assert.ok(!star.content.includes('node_modules'), `${label}: glob * não reinclui node_modules`)
    const fstar = await findFiles({ glob: '*', path: 'proj2' }, ctl())
    assert.ok(!fstar.content.includes('node_modules'), `${label}: find * sem node_modules`)
    const capped = await searchFiles({ pattern: 'NEEDLE', path: 'proj2', max_results: 10 }, ctl())
    assert.match(capped.content, /^\[10 resultados .*limite atingido/, label)
    assert.equal(capped.content.split('\n').length, 11, label)
    const none = await searchFiles({ pattern: 'nao_existe_xyz', path: 'proj2' }, ctl())
    const noFiles = await searchFiles({ pattern: 'x', path: 'proj2', glob: '*.py' }, ctl())
    assert.equal(noFiles.status, 'ok', `${label}: glob sem arquivos não é erro`)
    assert.match(noFiles.content, /^Nenhum resultado/, label)
    const all = await searchFiles({ pattern: 'NEEDLE_42', path: 'proj2', glob: '**/*.ts' }, ctl())
    assert.match(all.content, /main\.ts:2:/, `${label}: glob **/*.ts`)
    const noFind = await findFiles({ glob: '*.py', path: 'proj2' }, ctl())
    assert.match(noFind.content, /^Nenhum arquivo casa/, label)
    assert.match(none.content, /^Nenhum resultado/, label)
    const f = await findFiles({ glob: '*.ts', path: 'proj2' }, ctl())
    assert.match(
      f.content,
      /\[1 arquivo\(s\) para "\*\.ts" em proj2\]\nproj2\/src\/main\.ts/,
      label
    )
    const f2 = await findFiles({ glob: 'src/**/*.ts', path: 'proj2' }, ctl())
    assert.match(f2.content, /main\.ts/, label)
    await assert.rejects(
      searchFiles({ pattern: 'x', path: '../outside' }, ctl()),
      /fora do diretório raiz/
    )
  }
  _setRipgrep(null)
  const g = globToRegExp('src/**/*.{ts,tsx}')
  assert.ok(g.re.test('src/a/b/c.tsx') && g.re.test('src/c.ts') && !g.re.test('lib/c.ts'))
  assert.ok(globToRegExp('*.md').basename)
})

// ---- compactação ----

const boundary = (summary: string, meta: Record<string, unknown> = {}): StoredMessage =>
  sm(
    { role: 'user', content: compactionMessageText(summary) },
    { synthetic: true, kind: 'compaction', contextEstimate: 900, ...meta }
  )

test('buildRequest: envia só a partir da fronteira de compactação mais recente', () => {
  const hist = [
    sm({ role: 'user', content: 'antigo 1' }),
    sm(
      { role: 'assistant', content: 'resp 1' },
      { usage: { promptTokens: 100, completionTokens: 10 } }
    ),
    boundary('RESUMO A'),
    sm({ role: 'user', content: 'meio' }),
    sm({ role: 'assistant', content: 'resp 2' }),
    boundary('RESUMO B'),
    sm({ role: 'assistant', content: '' }, { kind: 'error', synthetic: true, error: 'x' }),
    sm({ role: 'user', content: 'novo' })
  ]
  const body = buildRequest(mkChat(), { depth: 0, model: 'm' }, hist, orProvider, env).body as any
  const msgs = body.messages
  assert.equal(msgs.length, 3)
  assert.equal(msgs[0].role, 'system')
  assert.equal(msgs[1].role, 'user')
  assert.equal(msgs[1].content, compactionMessageText('RESUMO B'))
  assert.match(msgs[1].content, /^<conversation_summary>\nRESUMO B\n<\/conversation_summary>\n\n/)
  assert.equal(msgs[2].content[0].text, 'novo')
  assert.ok(
    !JSON.stringify(msgs).includes('antigo 1') && !JSON.stringify(msgs).includes('RESUMO A')
  )
  assert.equal(activeHistory(hist).length, 3)
})

test('compactação nunca parte um par tool_calls ↔ tool', () => {
  const call = (id: string): ApiMessage => ({
    role: 'assistant',
    content: null,
    tool_calls: [{ id, type: 'function', function: { name: 'read_file', arguments: '{}' } }]
  })
  // fronteira entre o assistant e o resultado (ex.: histórico editado): o tool órfão não vai
  const hist = [
    sm({ role: 'user', content: 'leia' }),
    sm(call('t1')),
    boundary('R'),
    sm({ role: 'tool', tool_call_id: 't1', content: 'conteúdo' }),
    sm({ role: 'user', content: 'e agora?' })
  ]
  const body = buildRequest(
    mkChat({ cacheEnabled: false }),
    { depth: 0, model: 'm' },
    hist,
    orProvider,
    env
  ).body as any
  assert.deepEqual(
    body.messages.map((m: any) => m.role),
    ['system', 'user', 'user']
  )

  // modo "tail" (último recurso) corta no meio de um par → o resultado órfão é descartado
  const long: StoredMessage[] = [sm({ role: 'user', content: 'tarefa' })]
  for (let i = 0; i < 30; i++) {
    long.push(sm(call(`c${i}`)))
    long.push(sm({ role: 'tool', tool_call_id: `c${i}`, content: 'z'.repeat(3000) }))
  }
  const chat = mkChat({ cacheEnabled: false })
  const hTail = compactionHistory(long, 'tail', 4000) // orçamento ~8k chars
  assert.ok(hTail.length < long.length)
  const req = buildCompactionRequest(
    chat,
    { id: 's1', depth: 0, model: 'm' },
    long,
    orProvider,
    'RESUMA',
    { mode: 'tail', window: 4000 },
    env
  ).body as any
  const msgs = req.messages as any[]
  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i].role !== 'tool') continue
    let j = i - 1
    while (msgs[j].role === 'tool') j--
    assert.equal(msgs[j].role, 'assistant', `tool em ${i} sem assistant`)
    assert.ok(
      msgs[j].tool_calls.some((t: any) => t.id === msgs[i].tool_call_id),
      'par'
    )
  }
  for (const m of msgs) {
    if (m.role === 'assistant' && m.tool_calls) {
      const idx = msgs.indexOf(m)
      for (const t of m.tool_calls) {
        assert.ok(
          msgs.slice(idx + 1).some((x: any) => x.role === 'tool' && x.tool_call_id === t.id),
          'tool_call respondida'
        )
      }
    }
  }
  assert.deepEqual(msgs.at(-1), { role: 'user', content: 'RESUMA' })
  // "trimmed" encurta resultados de tool
  const trimmed = compactionHistory(long, 'trimmed', null)
  assert.ok((trimmed[2].message as any).content.length < 2000)
})

test('request de compactação = request normal + prompt no fim (prefixo idêntico, cache)', () => {
  const hist = [
    sm({ role: 'user', content: 'oi' }),
    sm({ role: 'assistant', content: 'olá' }, { usage: { promptTokens: 50, completionTokens: 5 } }),
    sm({ role: 'user', content: 'faça X' }),
    sm({ role: 'assistant', content: 'feito' })
  ]
  const chat = mkChat()
  const normal = buildRequest(chat, { depth: 0, model: 'm' }, hist, orProvider, env).body as any
  const comp = buildCompactionRequest(
    chat,
    { id: 's1', depth: 0, model: 'm' },
    hist,
    orProvider,
    'PROMPT DE COMPACTAÇÃO',
    { mode: 'full', window: 1000 },
    env
  ).body as any
  assert.deepEqual(comp.tools, normal.tools)
  assert.deepEqual(comp.messages[0], normal.messages[0], 'system idêntico (com cache_control)')
  assert.deepEqual(comp.messages.slice(1, 3), normal.messages.slice(1, 3))
  assert.equal(comp.messages.length, normal.messages.length + 1)
  assert.deepEqual(comp.messages.at(-1), {
    role: 'user',
    content: [{ type: 'text', text: 'PROMPT DE COMPACTAÇÃO', cache_control: { type: 'ephemeral' } }]
  })
  assert.equal(comp.tool_choice, undefined)
  const forced = buildCompactionRequest(
    chat,
    { id: 's1', depth: 0, model: 'm' },
    hist,
    orProvider,
    'P',
    { mode: 'full', window: 1000, toolChoiceNone: true },
    env
  ).body as any
  assert.equal(forced.tool_choice, 'none')
})

test('compactação no início do turno: mensagem do usuário pendente fica após a fronteira', () => {
  const hist = [
    sm({ role: 'user', content: 'meu nome é Ana' }),
    sm({ role: 'assistant', content: 'ok' }),
    sm({ role: 'user', content: 'qual é meu nome?' }),
    sm({ role: 'assistant', content: '' }, { kind: 'error', synthetic: true, error: 'x' })
  ]
  const { summarized, pending } = splitPending(hist)
  assert.deepEqual(
    summarized.map((m) => m.message.content),
    ['meu nome é Ana', 'ok']
  )
  assert.deepEqual(
    pending.map((m) => m.message.content),
    ['qual é meu nome?']
  )
  const chat = mkChat({ cacheEnabled: false })
  const req = buildCompactionRequest(
    chat,
    { id: 's1', depth: 0, model: 'm' },
    hist,
    orProvider,
    'RESUMA',
    { mode: 'full', window: null },
    env
  ).body as any
  assert.deepEqual(
    req.messages.map((m: any) => m.content).slice(1),
    ['meu nome é Ana', 'ok', 'RESUMA'],
    'pendente fora do resumo'
  )
  const meta = compactionMeta(chat, { depth: 0 }, hist, 'R', 10, env)
  assert.equal(meta.insertBeforeSeq, hist[2].seq)
  assert.deepEqual(meta.summaryOf, { fromSeq: hist[0].seq, toSeq: hist[1].seq })
  // depois de inserir a fronteira antes da pendente, a request vai: system → resumo → pendente
  const b = { ...boundary('R'), seq: hist[2].seq - 0.5 }
  const after = [...hist.slice(0, 2), b, hist[2], hist[3]]
  const body = buildRequest(chat, { depth: 0, model: 'm' }, after, orProvider, env).body as any
  assert.deepEqual(body.messages.map((m: any) => m.content).slice(1), [
    compactionMessageText('R'),
    'qual é meu nome?'
  ])
  // só mensagens do usuário (nada respondido): nada pendente
  assert.equal(splitPending([sm({ role: 'user', content: 'x' })]).pending.length, 0)
})

test('uso de contexto e janela', () => {
  const u = { promptTokens: 1000, completionTokens: 200, cachedTokens: 800 }
  const hist = [
    sm({ role: 'user', content: 'a' }),
    sm({ role: 'assistant', content: 'b' }, { usage: u })
  ]
  assert.deepEqual(contextUsage(hist), { used: 1200, estimated: false, usage: u })
  assert.ok(hasCompactableHistory(hist))
  const after = [...hist, boundary('R', { contextEstimate: 321 })]
  assert.deepEqual(contextUsage(after), { used: 321, estimated: true })
  assert.ok(!hasCompactableHistory(after))
  assert.equal(contextUsage([sm({ role: 'user', content: 'x' })]), null)
  const models = [
    { id: 'm', contextLength: 200_000 },
    { id: 'sub', contextLength: 32_000 }
  ]
  assert.equal(resolveContextWindow({}, { depth: 0, model: 'm' }, models), 200_000)
  assert.equal(
    resolveContextWindow({ contextWindow: 5000 }, { depth: 0, model: 'm' }, models),
    5000
  )
  assert.equal(
    resolveContextWindow({ contextWindow: null }, { depth: 0, model: 'x' }, models),
    null
  )
  // subsessão: janela do próprio modelo primeiro
  assert.equal(
    resolveContextWindow({ contextWindow: 5000 }, { depth: 1, model: 'sub' }, models),
    32_000
  )
  assert.equal(
    resolveContextWindow({ contextWindow: 5000 }, { depth: 1, model: '?' }, models),
    5000
  )
})

test('detecção de erro de contexto excedido', () => {
  const yes = [
    "Erro HTTP 400: This model's maximum context length is 128000 tokens. However, your messages resulted in 130000 tokens.",
    'Erro HTTP 400: {"code":"context_length_exceeded"}',
    'Erro HTTP 400 Bad Request: prompt is too long: 210000 tokens > 200000 maximum',
    'Erro HTTP 400: input length and `max_tokens` exceed context limit — The input token count (1048577) exceeds the maximum',
    'Erro HTTP 413: Request exceeds the context window of this model',
    'Please reduce the length of the messages or completion.',
    'Erro do provider durante o stream: Requested 9000 tokens, but the model supports 8192'
  ]
  for (const t of yes) assert.ok(isContextLengthError(t), t)
  const no = [
    'Erro HTTP 500: Internal Server Error',
    'Erro HTTP 429: Rate limit reached for gpt-4 on tokens per min (TPM): Limit 30000',
    'Erro HTTP 401: No auth credentials found',
    '',
    undefined
  ]
  for (const t of no) assert.ok(!isContextLengthError(t), String(t))
  // sanity: realpath da raiz de teste existe
  assert.ok(realpathSync(ROOT))
})

// ---- migração CleartChat → ClearChat (diretórios temporários) ----
import { existsSync, readFileSync, statSync } from 'node:fs'
import Database from 'better-sqlite3'
import { migrateLegacyData } from '../src/main/migrate.ts'

test('migração: copia ~/.config/CleartChat/cleartchat.db (com WAL) para ClearChat/clearchat.db', () => {
  const cfg = join(TMP, 'mig1')
  const oldDir = join(cfg, 'CleartChat')
  const newDir = join(cfg, 'ClearChat')
  mkdirSync(oldDir, { recursive: true })
  const oldDb = join(oldDir, 'cleartchat.db')
  const w = new Database(oldDb)
  w.pragma('journal_mode = WAL')
  w.exec('CREATE TABLE chats (id TEXT PRIMARY KEY, title TEXT)')
  w.pragma('wal_checkpoint(TRUNCATE)')
  w.prepare('INSERT INTO chats VALUES (?, ?)').run('c1', 'antigo') // só no -wal (conexão aberta)
  assert.ok(existsSync(oldDb + '-wal') && statSync(oldDb + '-wal').size > 0)
  const before = readFileSync(oldDb)

  const r = migrateLegacyData(newDir)
  assert.equal(r.migrated, true, r.reason)
  assert.equal(r.to, join(newDir, 'clearchat.db'))
  const n = new Database(join(newDir, 'clearchat.db'), { readonly: true })
  assert.deepEqual(n.prepare('SELECT id, title FROM chats').all(), [{ id: 'c1', title: 'antigo' }])
  n.close()
  // diretório antigo intacto
  assert.ok(readFileSync(oldDb).equals(before))
  assert.equal(w.prepare('SELECT count(*) AS c FROM chats').get().c, 1)
  w.close()
  assert.ok(existsSync(oldDb))
  assert.ok(!existsSync(join(newDir, 'clearchat.db.migrating')))

  // segunda vez: já existe → não mexe
  const r2 = migrateLegacyData(newDir)
  assert.deepEqual([r2.migrated, r2.reason], [false, 'already-exists'])
})

test('migração: no-op sem banco antigo; não sobrescreve banco novo; banco antigo inválido é ignorado', () => {
  const cfg = join(TMP, 'mig2')
  const newDir = join(cfg, 'ClearChat')
  assert.deepEqual(
    [migrateLegacyData(newDir).migrated, migrateLegacyData(newDir).reason],
    [false, 'no-legacy-db']
  )
  assert.ok(!existsSync(newDir))

  mkdirSync(join(cfg, 'CleartChat'), { recursive: true })
  const old = new Database(join(cfg, 'CleartChat', 'cleartchat.db'))
  old.exec("CREATE TABLE t (x); INSERT INTO t VALUES ('old')")
  old.close()
  mkdirSync(newDir, { recursive: true })
  const cur = new Database(join(newDir, 'clearchat.db'))
  cur.exec("CREATE TABLE t (x); INSERT INTO t VALUES ('new')")
  cur.close()
  assert.equal(migrateLegacyData(newDir).reason, 'already-exists')
  const chk = new Database(join(newDir, 'clearchat.db'), { readonly: true })
  assert.equal(chk.prepare('SELECT x FROM t').get().x, 'new')
  chk.close()

  // arquivo antigo que não é um banco: nada é criado (o app começa limpo)
  const cfg3 = join(TMP, 'mig3')
  mkdirSync(join(cfg3, 'CleartChat'), { recursive: true })
  writeFileSync(join(cfg3, 'CleartChat', 'cleartchat.db'), 'isto não é sqlite '.repeat(200))
  const r3 = migrateLegacyData(join(cfg3, 'ClearChat'))
  assert.equal(r3.migrated, false)
  assert.match(r3.reason, /^error/)
  assert.ok(!existsSync(join(cfg3, 'ClearChat', 'clearchat.db')))
})

// ---- list_models ----

import {
  delegateEmptyText,
  delegateFailureText,
  fmtContext,
  formatModelLine,
  formatModelList,
  listModelsTool
} from '../src/main/tools/models.ts'
import { TOOL_DEFINITIONS } from '../src/shared/tools.ts'
import type { ModelInfo } from '../src/shared/types.ts'

const MODELS: ModelInfo[] = [
  {
    id: 'openai/gpt-4.1-nano',
    name: 'OpenAI: GPT-4.1 Nano',
    contextLength: 1_047_576,
    promptPrice: 0.0000001,
    completionPrice: 0.0000004,
    supportsTools: true
  },
  {
    id: 'openai/gpt-4.1',
    name: 'OpenAI: GPT-4.1',
    contextLength: 1_047_576,
    promptPrice: 0.000002,
    completionPrice: 0.000008,
    supportsTools: true
  },
  {
    id: 'meta-llama/llama-3.3-70b-instruct:free',
    name: 'Meta: Llama 3.3 70B (free)',
    contextLength: 65_536,
    promptPrice: 0,
    completionPrice: 0,
    supportsTools: false
  },
  {
    id: 'anthropic/claude-haiku-4.5',
    name: 'Anthropic: Claude Haiku 4.5',
    contextLength: 200_000,
    promptPrice: 0.000001,
    completionPrice: 0.000005,
    supportsTools: true
  },
  { id: 'local/unknown' }
]

test('list_models: filtro, ordenação, formato, grátis e truncamento', async () => {
  assert.equal(
    formatModelLine(MODELS[0], 'openai/gpt-4.1-nano'),
    'openai/gpt-4.1-nano (atual) · ctx 1.047k · $0.10/$0.40 por 1M · tools'
  )
  assert.equal(
    formatModelLine(MODELS[2]),
    'meta-llama/llama-3.3-70b-instruct:free · ctx 65k · grátis'
  )
  assert.equal(formatModelLine(MODELS[4]), 'local/unknown')
  assert.equal(fmtContext(512), '512')

  const info = { providerName: 'OpenRouter', current: 'openai/gpt-4.1' }
  const q = formatModelList(MODELS, { query: 'GPT-4.1', toolsOnly: true }, info)
  assert.equal(
    q,
    '[2 modelos de 5 no provedor OpenRouter; mostrando 2]\n' +
      'openai/gpt-4.1 (atual) · ctx 1.047k · $2.00/$8.00 por 1M · tools\n' +
      'openai/gpt-4.1-nano · ctx 1.047k · $0.10/$0.40 por 1M · tools'
  )
  // "fuzzy": sem separadores e pelo nome
  assert.match(
    formatModelList(MODELS, { query: 'gpt41 nano' }, info),
    /mostrando 1\]\nopenai\/gpt-4\.1-nano/
  )
  assert.match(formatModelList(MODELS, { query: 'haiku' }, info), /claude-haiku-4\.5/)
  // free_only
  const free = formatModelList(MODELS, { freeOnly: true }, info)
  assert.match(free, /^\[1 modelos de 5 .*\]\nmeta-llama\/llama-3\.3-70b-instruct:free .*grátis$/)
  // sort por preço (grátis primeiro, sem preço por último) e por contexto (maior primeiro)
  const byPrice = formatModelList(MODELS, { sort: 'price' }, info).split('\n').slice(1)
  assert.deepEqual(
    byPrice.map((l) => l.split(' ')[0]),
    [
      'meta-llama/llama-3.3-70b-instruct:free',
      'openai/gpt-4.1-nano',
      'anthropic/claude-haiku-4.5',
      'openai/gpt-4.1',
      'local/unknown'
    ]
  )
  const byCtx = formatModelList(MODELS, { sort: 'context' }, info).split('\n').slice(1)
  assert.deepEqual(
    byCtx.map((l) => l.split(' ')[0]),
    [
      'openai/gpt-4.1',
      'openai/gpt-4.1-nano',
      'anthropic/claude-haiku-4.5',
      'meta-llama/llama-3.3-70b-instruct:free',
      'local/unknown'
    ]
  )
  // limit → dica para refinar
  const lim = formatModelList(MODELS, { limit: 2 }, info)
  assert.match(lim, /^\[5 modelos de 5 no provedor OpenRouter; mostrando 2\]/)
  assert.match(lim, /mais 3 modelos não listados\. Refine com query/)
  // nenhum resultado
  assert.match(formatModelList(MODELS, { query: 'zzz' }, info), /^Nenhum modelo de 5 .*query "zzz"/)
  // maxChars respeitado
  const many: ModelInfo[] = Array.from({ length: 300 }, (_, i) => ({
    id: `vendor/model-${String(i).padStart(3, '0')}-with-a-long-name`,
    contextLength: 128_000,
    promptPrice: 0.000001,
    completionPrice: 0.000002,
    supportsTools: true
  }))
  const capped = formatModelList(many, { limit: 500 }, { providerName: 'X', maxChars: 2000 })
  assert.ok(capped.length <= 2000, `tamanho ${capped.length}`)
  assert.match(capped, /^\[300 modelos de 300 no provedor X; mostrando \d+\]/)
  assert.match(capped, /Refine com query/)
  assert.equal(
    formatModelList(many, { limit: 500 }, { providerName: 'X', maxChars: 400_000 }).split('\n')
      .length,
    202,
    'limit máx. 200'
  )
  assert.match(
    formatModelList(many, {}, { providerName: 'X', maxChars: 400_000 }),
    /mostrando 50\]/
  )

  // tool: falha de /models vira erro legível; sort inválido; abort
  const ac = new AbortController()
  const ctx = (list: () => Promise<ModelInfo[]>): any => ({
    cwd: '/',
    signal: ac.signal,
    models: { providerName: 'Meu', current: 'm', list }
  })
  const err = await listModelsTool(
    {},
    ctx(async () => Promise.reject(new Error('Erro HTTP 404: Not Found')))
  )
  assert.equal(err.status, 'error')
  assert.match(err.content, /não foi possível listar os modelos do provedor Meu .*404/)
  await assert.rejects(
    listModelsTool(
      { sort: 'nope' },
      ctx(async () => MODELS)
    ),
    /"sort" inválido/
  )
  const okr = await listModelsTool(
    { query: 'nano', tools_only: true },
    ctx(async () => MODELS)
  )
  assert.equal(okr.status, 'ok')
  assert.match(okr.content, /openai\/gpt-4\.1-nano/)
  const none = await listModelsTool({}, { cwd: '/', signal: ac.signal } as any)
  assert.equal(none.status, 'error')

  // definições
  const d = TOOL_DEFINITIONS.list_models.function
  assert.deepEqual(Object.keys(d.parameters.properties).sort(), [
    'free_only',
    'limit',
    'query',
    'sort',
    'tools_only'
  ])
  assert.match(d.description, /grátis/)
  assert.match(TOOL_DEFINITIONS.delegate_task.function.description, /list_models/)
})

test('delegate_task: falha do modelo do subagente vira erro acionável', () => {
  const t = delegateFailureText(
    'openai/gpt-4.1-nano',
    'Erro HTTP 429 Too Many Requests: rate limited\n  upstream'
  )
  assert.match(
    t,
    /^\[falha do modelo openai\/gpt-4\.1-nano: Erro HTTP 429 Too Many Requests: rate limited upstream\]/
  )
  assert.match(t, /Tente outro modelo/)
  const f = delegateFailureText('x/y:free', 'Erro HTTP 502')
  assert.match(f, /tente outro modelo grátis ou um pago/)
  assert.match(delegateEmptyText('x/y:free'), /possível falha do modelo x\/y:free/)
})

// ---------------- personas (presets) ----------------
import {
  PRESET_FIELDS,
  applyPreset,
  copyName,
  patchPresetConfig,
  sanitizePresetConfig,
  snapshotPreset,
  withoutCwd
} from '../src/shared/presets.ts'

test('persona: snapshot copia os campos de chat, sem cwd por padrão (opcional), sem presetId', () => {
  const cfg = {
    ...DEFAULT_CHAT_CONFIG('/proj', { providerId: 'p1', model: 'm1', systemPrompt: 'SYS' }),
    params: { temperature: 0.2, top_p: null, extraBody: '{"a":1}' },
    enabledTools: ['read_file', 'bash'],
    autoApprove: ['bash'],
    nativeTools: false,
    toolsInPrompt: true,
    toolsPromptText: 'TXT',
    envInPrompt: false,
    cacheEnabled: false,
    subagentSystemPrompt: 'SUB',
    appSignature: 'custom',
    appSignatureCustom: { referer: 'https://x.dev', title: 'X' },
    contextWindow: 64000,
    compactThreshold: 0.8,
    autoCompact: true,
    compactPrompt: 'RESUMA',
    maxToolOutputChars: 12000,
    confineToRoot: false,
    sandboxBash: true,
    presetId: 'old'
  } as any
  const snap = snapshotPreset(cfg)
  // todos os campos de persona, nada além deles
  assert.deepEqual(Object.keys(snap).sort(), [...PRESET_FIELDS].sort())
  assert.equal(snap.model, 'm1')
  assert.equal(snap.systemPrompt, 'SYS')
  assert.deepEqual(snap.params, { temperature: 0.2, extraBody: '{"a":1}' }) // null removido
  assert.deepEqual(snap.enabledTools, ['read_file', 'bash'])
  assert.deepEqual(snap.autoApprove, ['bash'])
  assert.equal(snap.toolsPromptText, 'TXT')
  assert.deepEqual(snap.appSignatureCustom, { referer: 'https://x.dev', title: 'X' })
  assert.equal(snap.contextWindow, 64000)
  assert.equal(snap.compactPrompt, 'RESUMA')
  assert.equal(snap.sandboxBash, true)
  assert.ok(!('cwd' in snap) && !('presetId' in snap))
  // cópia profunda: mexer no snapshot não altera o chat
  ;(snap.enabledTools as string[]).push('write_file')
  assert.deepEqual(cfg.enabledTools, ['read_file', 'bash'])
  // cwd só com includeCwd
  assert.equal(snapshotPreset(cfg, { includeCwd: true }).cwd, '/proj')
  assert.ok(!('cwd' in withoutCwd(snapshotPreset(cfg, { includeCwd: true }))))
})

test('persona: sanitize descarta chaves desconhecidas, undefined e cwd vazio', () => {
  assert.deepEqual(sanitizePresetConfig(null), {})
  assert.deepEqual(sanitizePresetConfig([1, 2]), {})
  assert.deepEqual(
    sanitizePresetConfig({ model: 'x', hack: 1, title: 't', cwd: '  ', systemPrompt: undefined }),
    { model: 'x' }
  )
})

test('persona: aplicar sobre os padrões (campos ausentes seguem a base; params mesclados)', () => {
  const base = {
    ...DEFAULT_CHAT_CONFIG('/home/u', { providerId: 'p1', model: 'base-m', systemPrompt: 'BASE' }),
    params: { max_tokens: 100 }
  }
  // persona vazia (ex.: "Padrão") = base
  const same = applyPreset(base, {})
  assert.deepEqual(same, base)
  assert.notEqual(same.params, base.params)
  const cfg = applyPreset(base, {
    model: 'm2',
    params: { temperature: 0.5 },
    enabledTools: ['read_file'],
    cwd: '/proj',
    presetId: 'x'
  } as any)
  assert.equal(cfg.model, 'm2')
  assert.equal(cfg.systemPrompt, 'BASE')
  assert.deepEqual(cfg.params, { max_tokens: 100, temperature: 0.5 })
  assert.deepEqual(cfg.enabledTools, ['read_file'])
  assert.equal(cfg.cwd, '/proj')
  assert.equal(cfg.presetId, undefined)
  assert.equal(base.model, 'base-m') // base intacta
  // sem cwd na persona → cwd da base
  assert.equal(applyPreset(base, { model: 'z' }).cwd, '/home/u')
})

test('persona: patch de rascunho (params nulos removem) e nome de cópia', () => {
  let d = patchPresetConfig({}, { model: 'a', params: { temperature: 0.3 } })
  assert.deepEqual(d, { model: 'a', params: { temperature: 0.3 } })
  d = patchPresetConfig(d, { params: { temperature: null as any, seed: 7 } })
  assert.deepEqual(d.params, { seed: 7 })
  d = patchPresetConfig(d, { systemPrompt: undefined })
  assert.ok(!('systemPrompt' in d))
  assert.equal(copyName('Revisor', [{ name: 'Revisor' }]), 'Revisor (cópia)')
  assert.equal(
    copyName('Revisor (cópia)', [{ name: 'Revisor' }, { name: 'Revisor (cópia)' }]),
    'Revisor (cópia 2)'
  )
})
