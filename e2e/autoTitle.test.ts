/* eslint-disable @typescript-eslint/no-explicit-any */
// Título automático (SPEC → "Título automático"). Parte A, sem Electron: limpeza da resposta,
// config, prompt (com/sem memórias, com tetos), request por adaptador (max_tokens só onde o modelo
// aceita, raciocínio mínimo) e `runAutoTitle` com dependências falsas (sem modelo → nenhuma
// chamada; erro/tempo esgotado → mantém o provisório; renomeado no meio → não sobrescreve).
// Parte B: runner real (módulo `electron` substituído por um stub) com um provedor
// OpenAI-compatible falso em 127.0.0.1: o turno não espera o título, título aplicado + custo na
// meta, renomear antes da resposta preserva, sem modelo/erro → fica o provisório, "Gerar título".
// Rodar: npm run test:unit
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AUTO_TITLE_DEFAULTS,
  autoTitleEnabled,
  autoTitleUserContent,
  boundText,
  buildAutoTitleMessages,
  defaultAutoTitleSettings,
  normalizeAutoTitleSettings,
  sanitizeTitle,
  type AutoTitleRecord,
  type AutoTitleSettings
} from '../src/shared/autoTitle.ts'
import { DEFAULT_AUTO_TITLE_PROMPT, DEFAULT_CHAT_CONFIG } from '../src/shared/defaults.ts'
import {
  buildAutoTitleRequest,
  minimalEffort,
  runAutoTitle,
  type AutoTitleDeps
} from '../src/main/agent/autoTitle.ts'
import { setModelInfoSource } from '../src/main/agent/request.ts'

const TMP = mkdtempSync(join(process.env.CLEARCHAT_TEST_TMP || tmpdir(), 'clearchat-autotitle-'))

// ---------------- parte A: limpeza ----------------

test('sanitizeTitle: aspas, markdown, rótulo, emoji, ponto final, espaços, <think>', () => {
  const cases: [string, string][] = [
    ['"Proxy reverso nginx para Node."', 'Proxy reverso nginx para Node'],
    ['“Receita de pão sem glúten”', 'Receita de pão sem glúten'],
    ["'Erro de CORS no deploy'", 'Erro de CORS no deploy'],
    ['**Título:** Migração do banco para Postgres', 'Migração do banco para Postgres'],
    ['Title: Fixing the SSE parser', 'Fixing the SSE parser'],
    ['# Plano de estudos de cálculo', 'Plano de estudos de cálculo'],
    ['- `docker compose` sem rede', 'docker compose sem rede'],
    ['🚀 Deploy no Fly.io 🎉', 'Deploy no Fly.io'],
    ['  Viagem   para\tLisboa  em  maio  ', 'Viagem para Lisboa em maio'],
    ['<think>o usuário quer…\nhmm</think>\nAjuste de vídeo no FFmpeg', 'Ajuste de vídeo no FFmpeg'],
    ['\n\n  \nCálculo de juros compostos\nExplicação: …', 'Cálculo de juros compostos'],
    ['Como funciona o React Compiler?', 'Como funciona o React Compiler?'],
    ['my_module quebrando no import', 'my_module quebrando no import'],
    ['_Resumo do artigo_', 'Resumo do artigo'],
    ['«Leitura de PDFs grandes»;', 'Leitura de PDFs grandes']
  ]
  for (const [raw, want] of cases) assert.equal(sanitizeTitle(raw), want, JSON.stringify(raw))
})

test('sanitizeTitle: vazio, genérico ou sem letras → "" (mantém o provisório)', () => {
  for (const raw of [
    '',
    '   \n  ',
    '"Nova conversa"',
    'Novo chat.',
    'New Chat',
    '**Conversa**',
    'Olá!',
    '<think>só raciocínio, sem fechar',
    '...',
    '🎉🎉'
  ])
    assert.equal(sanitizeTitle(raw), '', JSON.stringify(raw))
})

test('sanitizeTitle: corta em 60 caracteres na palavra, com reticências', () => {
  const long = 'Configuração completa de um cluster Kubernetes com Helm, Argo CD e observabilidade'
  const t = sanitizeTitle(long)
  assert.ok(t.length <= AUTO_TITLE_DEFAULTS.maxTitleChars, `${t.length}`)
  assert.ok(t.endsWith('…'))
  assert.ok(long.startsWith(t.slice(0, -1)), t)
  assert.ok(!/\s…$/.test(t) && !/,…$/.test(t), t)
  // palavra única enorme: corta no meio mesmo
  const w = sanitizeTitle('a'.repeat(200))
  assert.equal(w.length, AUTO_TITLE_DEFAULTS.maxTitleChars)
  assert.equal(sanitizeTitle('x'.repeat(60)), 'x'.repeat(60))
})

test('boundText não quebra par surrogate', () => {
  const s = 'ab😀cd'
  assert.equal(boundText(s, 4, '…'), 'ab…')
  assert.equal(boundText('abc', 10), 'abc')
})

// ---------------- parte A: config ----------------

test('normalizeAutoTitleSettings: padrão = Nenhum; par incompleto não vale; limites', () => {
  const d = defaultAutoTitleSettings()
  assert.deepEqual(normalizeAutoTitleSettings(null), d)
  assert.deepEqual(d, {
    providerId: null,
    model: null,
    useMemory: false,
    maxTokens: 64,
    prompt: null
  })
  assert.equal(autoTitleEnabled(d), false)
  assert.equal(autoTitleEnabled(normalizeAutoTitleSettings({ providerId: 'p' })), false)
  assert.equal(normalizeAutoTitleSettings({ model: 'm' }).model, null)
  const ok = normalizeAutoTitleSettings({
    providerId: 'p',
    model: 'm',
    useMemory: true,
    maxTokens: 5000,
    prompt: '  '
  })
  assert.equal(autoTitleEnabled(ok), true)
  assert.equal(ok.useMemory, true)
  assert.equal(ok.maxTokens, AUTO_TITLE_DEFAULTS.maxMaxTokens)
  assert.equal(ok.prompt, null)
  assert.equal(normalizeAutoTitleSettings({ maxTokens: 1 }).maxTokens, 8)
  assert.equal(normalizeAutoTitleSettings({ maxTokens: 'x' }).maxTokens, 64)
  assert.equal(normalizeAutoTitleSettings({ useMemory: 'sim' }).useMemory, false)
})

// ---------------- parte A: prompt ----------------

test('prompt: system padrão/personalizado; user com mensagem e nomes dos anexos; sem memória', () => {
  const m = buildAutoTitleMessages(null, {
    text: 'Como configuro o nginx como proxy reverso?',
    attachments: ['nginx.conf', '  print   da tela.png ']
  })
  assert.equal(m.length, 2)
  assert.deepEqual(m[0], { role: 'system', content: DEFAULT_AUTO_TITLE_PROMPT })
  assert.equal(m[1].role, 'user')
  const u = m[1].content
  assert.ok(u.includes('<message>\nComo configuro o nginx como proxy reverso?\n</message>'))
  assert.ok(u.includes('Anexos (só os nomes): nginx.conf, print da tela.png'))
  assert.ok(!u.includes('Contexto sobre o usuário'))
  assert.ok(u.endsWith('Responda só com o título.'))
  assert.equal(buildAutoTitleMessages('Só o título.', { text: 'x' })[0].content, 'Só o título.')
  assert.equal(buildAutoTitleMessages('   ', { text: 'x' })[0].content, DEFAULT_AUTO_TITLE_PROMPT)
  // só anexos
  assert.ok(
    autoTitleUserContent({ text: '  ', attachments: ['a.pdf'] }).includes('(sem texto — só anexos)')
  )
  // o padrão pede o que a SPEC diz
  for (const k of ['6 palavras', 'idioma', 'aspas', 'emoji', 'ponto final', 'Nova conversa'])
    assert.ok(DEFAULT_AUTO_TITLE_PROMPT.includes(k), k)
})

test('prompt: com memórias (antes da mensagem) e tudo com teto', () => {
  const D = AUTO_TITLE_DEFAULTS
  const u = autoTitleUserContent({
    text: 'y'.repeat(10_000),
    attachments: Array.from({ length: 15 }, (_, i) => `arquivo-${i}-${'n'.repeat(200)}.txt`),
    memory: '<memory>\n' + 'm'.repeat(10_000) + '\n</memory>'
  })
  const memAt = u.indexOf('Contexto sobre o usuário')
  assert.ok(memAt >= 0 && memAt < u.indexOf('<message>'), 'memória antes da mensagem')
  assert.ok(u.includes('[… mensagem cortada]'))
  assert.ok(u.includes('(+5 outros)'))
  const memBlock = u.slice(memAt, u.indexOf('\n\nAnexos'))
  assert.ok(memBlock.length < D.memoryChars + 100, `memória ${memBlock.length}`)
  const msg = u.slice(u.indexOf('<message>'), u.indexOf('</message>'))
  assert.ok(msg.length < D.messageChars + 40, `mensagem ${msg.length}`)
  // limite total: memória + 10 nomes + mensagem + textos fixos
  assert.ok(u.length < D.memoryChars + D.messageChars + 10 * (D.attachmentNameChars + 2) + 400)
  // memória vazia = sem bloco
  assert.ok(!autoTitleUserContent({ text: 'oi', memory: '   ' }).includes('Contexto'))
})

// ---------------- parte A: request ----------------

const prov = (kind: string, baseUrl: string): any => ({
  id: `p-${kind}`,
  name: kind,
  kind,
  baseUrl,
  apiKey: 'sk-test-123456789',
  headers: {},
  createdAt: 0
})
const S = (patch: Partial<AutoTitleSettings> = {}): AutoTitleSettings => ({
  ...defaultAutoTitleSettings(),
  providerId: 'p',
  model: 'm',
  ...patch
})

test('request: OpenRouter desconhecido → max_tokens, sem raciocínio, usage; system + user', () => {
  setModelInfoSource(() => undefined)
  const r = buildAutoTitleRequest({
    settings: S({ model: 'fake/x', maxTokens: 48 }),
    provider: prov('openrouter', 'https://openrouter.ai/api/v1'),
    text: 'oi'
  })
  const b = r.body as any
  assert.equal(r.url, 'https://openrouter.ai/api/v1/chat/completions')
  assert.equal(b.model, 'fake/x')
  assert.equal(b.max_tokens, 48)
  assert.equal(b.reasoning, undefined)
  assert.equal(b.reasoning_effort, undefined)
  assert.equal(b.temperature, undefined)
  assert.deepEqual(b.usage, { include: true })
  assert.equal(b.stream, true)
  assert.deepEqual(
    b.messages.map((m: any) => m.role),
    ['system', 'user']
  )
  assert.equal(r.headers.Authorization, 'Bearer sk-test-123456789')
  assert.equal(r.headers['X-Title'], 'ClearChat')
})

test('request: raciocínio mínimo onde o modelo informa níveis; max_tokens só se aceito', () => {
  setModelInfoSource((_p, model) =>
    model === 'r/reasoner'
      ? {
          id: model,
          supportedParams: ['reasoning_effort', 'max_tokens'],
          reasoning: { efforts: ['none', 'low', 'high'] }
        }
      : model === 'r/mandatory'
        ? {
            id: model,
            supportedParams: ['reasoning_effort'],
            reasoning: { efforts: ['minimal', 'low', 'high'], mandatory: true }
          }
        : undefined
  )
  const or = prov('openrouter', 'https://openrouter.ai/api/v1')
  const a = buildAutoTitleRequest({ settings: S({ model: 'r/reasoner' }), provider: or, text: 'x' })
  assert.deepEqual((a.body as any).reasoning, { effort: 'none' })
  assert.equal((a.body as any).max_tokens, 64)
  const b = buildAutoTitleRequest({
    settings: S({ model: 'r/mandatory' }),
    provider: or,
    text: 'x'
  })
  assert.deepEqual((b.body as any).reasoning, { effort: 'minimal' })
  assert.equal((b.body as any).max_tokens, undefined, 'modelo sem max_tokens na lista')
  assert.ok(b.notes?.some((n) => n.startsWith('max_tokens omitido')))
  // openai genérico: tabela conferida (gpt-5.1 → none; gpt-4o → sem raciocínio)
  setModelInfoSource(() => undefined)
  const oa = prov('openai', 'https://api.openai.com/v1')
  const c = buildAutoTitleRequest({ settings: S({ model: 'gpt-5.1' }), provider: oa, text: 'x' })
  assert.equal((c.body as any).reasoning_effort, 'none')
  const d = buildAutoTitleRequest({ settings: S({ model: 'gpt-4o' }), provider: oa, text: 'x' })
  assert.equal((d.body as any).reasoning_effort, undefined)
  // Anthropic nativa: max_tokens obrigatório + effort mais baixo da tabela; sem effort no haiku-4-5
  const an = prov('anthropic', 'https://api.anthropic.com/v1')
  const e = buildAutoTitleRequest({
    settings: S({ model: 'claude-sonnet-5', maxTokens: 40 }),
    provider: an,
    text: 'x'
  })
  const eb = e.body as any
  assert.equal(e.url, 'https://api.anthropic.com/v1/messages')
  assert.equal(eb.max_tokens, 40)
  assert.deepEqual(eb.output_config, { effort: 'low' })
  assert.equal(eb.system[0].text, DEFAULT_AUTO_TITLE_PROMPT)
  const f = buildAutoTitleRequest({
    settings: S({ model: 'claude-haiku-4-5' }),
    provider: an,
    text: 'x'
  })
  assert.equal((f.body as any).output_config, undefined)
  assert.equal(minimalEffort(null), undefined)
  assert.equal(
    minimalEffort({ levels: ['low', 'medium'], known: false } as any),
    undefined,
    'níveis desconhecidos: não manda'
  )
})

// ---------------- parte A: runAutoTitle com dependências falsas ----------------

interface Fake {
  deps: AutoTitleDeps
  chat: any
  calls: any[]
  titles: string[]
  records: { id: string; rec: AutoTitleRecord }[]
  logs: string[]
}

function fake(
  settings: Partial<AutoTitleSettings> | null,
  stream: (req: any, signal: AbortSignal, acc: any, f: Fake) => Promise<void>
): Fake {
  const f: Fake = {
    chat: {
      id: 'c1',
      title: 'Como configuro o nginx como proxy reverso para o m…',
      config: DEFAULT_CHAT_CONFIG('/tmp', { providerId: 'p', model: 'agent' }),
      mainSessionId: 's1',
      createdAt: 0,
      updatedAt: 0
    },
    calls: [],
    titles: [],
    records: [],
    logs: [],
    deps: null as any
  }
  f.deps = {
    settings: () =>
      settings === null ? defaultAutoTitleSettings() : normalizeAutoTitleSettings(S(settings)),
    chat: (id) => (id === f.chat.id ? { ...f.chat } : null),
    provider: (id) => (id === 'p' ? prov('openrouter', 'https://openrouter.ai/api/v1') : null),
    memory: () => '<memory>\n- m1 · Projeto Fênix — app Node\n</memory>',
    setTitle: (_id, t) => {
      f.titles.push(t)
      f.chat.title = t
    },
    record: (id, rec) => f.records.push({ id, rec }),
    stream: (async (req: any, signal: AbortSignal, acc: any) => {
      f.calls.push(req)
      await stream(req, signal, acc, f)
    }) as any,
    log: (m) => f.logs.push(m),
    timeoutMs: 200
  }
  return f
}
const job = (f: Fake): any => ({
  chatId: 'c1',
  text: 'Como configuro o nginx como proxy reverso para o meu app Node?',
  attachments: ['nginx.conf'],
  expectTitle: f.chat.title,
  messageId: 'msg1',
  trigger: 'auto'
})
const reply =
  (text: string, cost = 0.00002) =>
  async (_r: any, _s: AbortSignal, acc: any): Promise<void> => {
    acc.content = text
    acc.usage = { promptTokens: 120, completionTokens: 7, cost }
  }

test('runAutoTitle: sem modelo (Nenhum) → nenhuma chamada, nada muda', async () => {
  const f = fake(null, reply('X'))
  const out = await runAutoTitle(job(f), f.deps)
  assert.deepEqual(out, { status: 'skipped', reason: 'no-model' })
  assert.equal(f.calls.length, 0)
  assert.equal(f.titles.length + f.records.length, 0)
})

test('runAutoTitle: título limpo aplicado + registro (custo/modelo) na mensagem de origem', async () => {
  const f = fake({}, reply('"Proxy reverso nginx para Node."'))
  const out = await runAutoTitle(job(f), f.deps)
  assert.equal(out.status, 'applied')
  assert.deepEqual(f.titles, ['Proxy reverso nginx para Node'])
  assert.equal(f.records.length, 1)
  const { id, rec } = f.records[0]
  assert.equal(id, 'msg1')
  assert.equal(rec.title, 'Proxy reverso nginx para Node')
  assert.equal(rec.applied, true)
  assert.equal(rec.trigger, 'auto')
  assert.equal(rec.model, 'm')
  assert.equal(rec.usage?.cost, 0.00002)
  // a request: sem memória (desligada), com o nome do anexo e nunca o conteúdo
  const user = f.calls[0].body.messages[1].content
  assert.ok(user.includes('nginx.conf') && !user.includes('<memory>'))
})

test('runAutoTitle: usuário renomeia antes da resposta → o título dele fica', async () => {
  const f = fake({}, async (req, signal, acc, ff) => {
    ff.chat.title = 'Meu título'
    await reply('Proxy reverso nginx')(req, signal, acc)
  })
  const out = await runAutoTitle(job(f), f.deps)
  assert.equal(out.status, 'kept')
  assert.equal((out as any).reason, 'renamed')
  assert.equal(f.chat.title, 'Meu título')
  assert.equal(f.titles.length, 0)
  assert.equal(f.records[0].rec.applied, false, 'custo registrado, não aplicado')
})

test('runAutoTitle: erro HTTP, tempo esgotado ou resposta inútil → mantém o provisório, sem lançar', async () => {
  const provisional = 'Como configuro o nginx como proxy reverso para o m…'
  const boom = fake({}, async () => {
    throw new Error('Erro HTTP 500: falhou')
  })
  const a = await runAutoTitle(job(boom), boom.deps)
  assert.equal(a.status, 'error')
  assert.match((a as any).error, /500/)
  assert.equal(boom.chat.title, provisional)
  assert.equal(boom.records.length, 0)
  assert.ok(boom.logs.some((l) => l.includes('não gerado')))

  const slow = fake(
    {},
    (_r, signal) =>
      new Promise((_, rej) => signal.addEventListener('abort', () => rej(new Error('aborted'))))
  )
  const b = await runAutoTitle(job(slow), slow.deps)
  assert.equal(b.status, 'error')
  assert.match((b as any).error, /sem resposta/)
  assert.equal(slow.chat.title, provisional)

  for (const text of ['', '"Nova conversa"', '<think>pensando…']) {
    const f = fake({}, reply(text))
    const c = await runAutoTitle(job(f), f.deps)
    assert.equal(c.status, 'error', JSON.stringify(text))
    assert.equal(f.titles.length, 0)
  }
  // provedor apagado
  const gone = fake({ providerId: 'apagado' }, reply('X'))
  const d = await runAutoTitle(job(gone), gone.deps)
  assert.equal(d.status, 'error')
  assert.equal(gone.calls.length, 0)
})

test('runAutoTitle: "Usar as memórias" inclui o índice compacto; falha da memória não impede', async () => {
  const f = fake({ useMemory: true }, reply('Proxy do Projeto Fênix'))
  await runAutoTitle(job(f), f.deps)
  const user = f.calls[0].body.messages[1].content
  assert.ok(user.includes('Contexto sobre o usuário') && user.includes('Projeto Fênix'))
  const g = fake({ useMemory: true }, reply('Proxy reverso'))
  g.deps.memory = () => {
    throw new Error('banco fechado')
  }
  const out = await runAutoTitle(job(g), g.deps)
  assert.equal(out.status, 'applied')
  assert.ok(!g.calls[0].body.messages[1].content.includes('Contexto'))
})

// ---------------- parte B: runner real + provedor falso ----------------

process.env.CLEARCHAT_TEST_USERDATA = TMP
process.env.CLEARCHAT_SKIP_SHELL_ENV = '1'
const ELECTRON_STUB =
  'data:text/javascript,' +
  encodeURIComponent(`
export const app = { getPath: () => process.env.CLEARCHAT_TEST_USERDATA, getVersion: () => '0.0.0', isPackaged: false }
export class BrowserWindow { static getAllWindows() { return [] } }
export const session = { fromPartition: () => ({}) }
export const dialog = {}
export const ipcMain = { handle() {} }
export const nativeImage = {}
export default { app, BrowserWindow, session, dialog, ipcMain, nativeImage }
`)
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === 'electron') return { url: ELECTRON_STUB, shortCircuit: true }
    return next(spec, ctx)
  }
})

const AGENT = 'fake/agent'
const TITLER = 'fake/titler'
let server: Server
let base = ''
const hits: { model: string; body: any; at: number; doneAt?: number }[] = []
/** Atraso e resposta do modelo do título (por teste). */
let titleDelayMs = 0
let titleReply: string | { status: number } = '"Proxy reverso nginx para Node."'

async function readBody(req: IncomingMessage): Promise<string> {
  let d = ''
  for await (const c of req) d += c
  return d
}
const chunk = (model: string, delta: any, finish?: string, usage?: any): string =>
  `data: ${JSON.stringify({ id: 'f', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta, ...(finish ? { finish_reason: finish } : {}) }], ...(usage ? { usage } : {}) })}\n\n`

before(async () => {
  server = createServer((req, res) => {
    void (async () => {
      if (req.method === 'GET' && (req.url ?? '').endsWith('/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({ data: [AGENT, TITLER].map((id) => ({ id, context_length: 64000 })) })
        )
        return
      }
      const body = JSON.parse((await readBody(req)) || '{}')
      const hit: (typeof hits)[number] = { model: body.model, body, at: Date.now() }
      hits.push(hit)
      const text = (t: string, usage: any): void => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.write(chunk(body.model, { role: 'assistant', content: t }))
        res.end(chunk(body.model, {}, 'stop', usage) + 'data: [DONE]\n\n')
        hit.doneAt = Date.now()
      }
      if (body.model === TITLER) {
        const r = titleReply
        setTimeout(() => {
          if (typeof r === 'string')
            text(r, { prompt_tokens: 90, completion_tokens: 6, cost: 0.000015 })
          else {
            res.writeHead(r.status, { 'Content-Type': 'application/json' })
            res.end('{"error":{"message":"modelo do título fora do ar"}}')
            hit.doneAt = Date.now()
          }
        }, titleDelayMs)
        return
      }
      text('resposta do agente', { prompt_tokens: 50, completion_tokens: 5 })
    })()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
})

after(() => {
  server?.close()
  rmSync(TMP, { recursive: true, force: true })
})

type Mods = {
  runner: typeof import('../src/main/agent/runner.ts')
  repo: typeof import('../src/main/repo.ts')
  autoTitle: typeof import('../src/main/autoTitle.ts')
}
let mods: Mods | null = null
async function load(): Promise<Mods> {
  if (mods) return mods
  const runner = await import('../src/main/agent/runner.ts')
  const repo = await import('../src/main/repo.ts')
  const autoTitle = await import('../src/main/autoTitle.ts')
  mods = { runner, repo, autoTitle }
  return mods
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
async function waitFor<T>(
  fn: () => T | null | undefined | false,
  ms = 8000,
  what = ''
): Promise<T> {
  const t0 = Date.now()
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}`)
    await sleep(20)
  }
}
let providerId = ''
async function newChat(): Promise<{ chatId: string; sid: string }> {
  const { repo } = await load()
  if (!providerId)
    providerId = repo.providersRepo.create({
      name: 'Falso',
      baseUrl: base,
      apiKey: 'k',
      headers: {}
    } as any).id
  const { chat, session } = repo.chatsRepo.create({
    config: { providerId, model: AGENT, cwd: TMP, enabledTools: [] }
  })
  return { chatId: chat.id, sid: session.id }
}
const idle = async (sid: string): Promise<void> => {
  const { repo, runner } = await load()
  await waitFor(
    () => !runner.isRunning(sid) && repo.sessionsRepo.get(sid)!.status === 'idle',
    10000,
    'idle'
  )
}
async function setTitleModel(on: boolean, extra: Partial<AutoTitleSettings> = {}): Promise<void> {
  const { repo } = await load()
  repo.settingsRepo.set(
    'autoTitle',
    on ? { ...defaultAutoTitleSettings(), providerId, model: TITLER, ...extra } : null
  )
}
const titleHits = (): typeof hits => hits.filter((h) => h.model === TITLER)
const FIRST = 'Como configuro o nginx como proxy reverso para o meu app Node na porta 3000?'
const PROVISIONAL = 'Como configuro o nginx como proxy reverso para o m…'

test('runner: o turno não espera o título; título aplicado depois + custo na meta da 1ª mensagem', async () => {
  const { runner, repo } = await load()
  const { chatId, sid } = await newChat()
  await setTitleModel(true)
  titleDelayMs = 700
  titleReply = '"Proxy reverso nginx para Node."'
  const n0 = titleHits().length
  runner.send(sid, FIRST)
  await idle(sid)
  // o agente já respondeu e o título ainda é o provisório (a chamada do título está pendente)
  assert.equal(repo.chatsRepo.get(chatId)!.title, PROVISIONAL)
  const agentHit = hits.filter((h) => h.model === AGENT).at(-1)!
  const th = await waitFor(() => titleHits()[n0], 3000, 'chamada do título')
  assert.ok(!th.doneAt || agentHit.at <= th.doneAt, 'agente chamado antes de o título responder')
  await waitFor(
    () => repo.chatsRepo.get(chatId)!.title === 'Proxy reverso nginx para Node',
    5000,
    'título aplicado'
  )
  assert.ok(agentHit.doneAt! <= th.doneAt!, 'turno terminou antes do título')
  const first = await waitFor(
    () => repo.messagesRepo.listAll(sid).find((m) => m.meta.autoTitle),
    3000,
    'registro'
  )
  assert.equal(first.message.role, 'user')
  assert.equal(first.meta.autoTitle!.applied, true)
  assert.equal(first.meta.autoTitle!.usage?.cost, 0.000015)
  // o que foi enviado: 1ª mensagem, max_tokens padrão; o agente nunca viu a chamada
  assert.ok(th.body.messages[1].content.includes(FIRST))
  assert.equal(th.body.max_tokens, 64)
  assert.ok(!JSON.stringify(agentHit.body).includes('Responda só com o título'))
  // 2ª mensagem não gera de novo
  runner.send(sid, 'e com HTTPS?')
  await idle(sid)
  await sleep(150)
  assert.equal(titleHits().length, n0 + 1)
})

test('runner: renomear antes da resposta preserva o título do usuário', async () => {
  const { runner, repo } = await load()
  const { chatId, sid } = await newChat()
  await setTitleModel(true)
  titleDelayMs = 500
  const n0 = titleHits().length
  runner.send(sid, FIRST)
  await waitFor(() => titleHits()[n0], 3000, 'chamada do título')
  repo.chatsRepo.update(chatId, { title: 'Meu título' })
  await waitFor(() => titleHits()[n0].doneAt, 3000, 'resposta do título')
  await idle(sid)
  const rec = await waitFor(
    () => repo.messagesRepo.listAll(sid).find((m) => m.meta.autoTitle)?.meta.autoTitle,
    3000,
    'registro'
  )
  assert.equal(repo.chatsRepo.get(chatId)!.title, 'Meu título')
  assert.equal(rec.applied, false)
})

test('runner: modelo Nenhum → nenhuma chamada; erro do modelo → fica o provisório', async () => {
  const { runner, repo } = await load()
  await setTitleModel(false)
  titleDelayMs = 0
  const n0 = titleHits().length
  const a = await newChat()
  runner.send(a.sid, FIRST)
  await idle(a.sid)
  await sleep(200)
  assert.equal(titleHits().length, n0, 'sem chamada')
  assert.equal(repo.chatsRepo.get(a.chatId)!.title, PROVISIONAL)

  await setTitleModel(true)
  titleReply = { status: 500 }
  const b = await newChat()
  runner.send(b.sid, FIRST)
  await idle(b.sid)
  await waitFor(() => titleHits()[n0]?.doneAt, 3000, 'chamada com erro')
  await sleep(150)
  assert.equal(repo.chatsRepo.get(b.chatId)!.title, PROVISIONAL)
  assert.ok(!repo.messagesRepo.listAll(b.sid).some((m) => m.meta.autoTitle))
  titleReply = '"Proxy reverso nginx para Node."'
})

test('só a mensagem DIGITADA dispara (de outro chat, callback, sintética → não)', async () => {
  const { autoTitle } = await load()
  assert.equal(autoTitle.isTypedFirstMessage({}), true)
  assert.equal(autoTitle.isTypedFirstMessage({ kind: 'queued' }), true)
  assert.equal(autoTitle.isTypedFirstMessage({ kind: 'forced' }), true)
  for (const meta of [
    { kind: 'inter-chat', synthetic: true },
    { kind: 'inter-chat' },
    { kind: 'subagent-callback', synthetic: true },
    { kind: 'parent-message' },
    { synthetic: true }
  ])
    assert.equal(autoTitle.isTypedFirstMessage(meta as any), false, JSON.stringify(meta))
})

test('"Gerar título": gera de novo a partir da 1ª mensagem (manual) e erros legíveis', async () => {
  const { runner, repo, autoTitle } = await load()
  await setTitleModel(true)
  titleDelayMs = 0
  const { chatId, sid } = await newChat()
  await assert.rejects(autoTitle.generateTitleNow(chatId), /ainda não tem mensagem/)
  runner.send(sid, FIRST)
  await idle(sid)
  await waitFor(() => repo.chatsRepo.get(chatId)!.title === 'Proxy reverso nginx para Node')
  repo.chatsRepo.update(chatId, { title: 'Renomeado à mão' })
  titleReply = 'Configuração de proxy reverso no nginx'
  const chat = await autoTitle.generateTitleNow(chatId)
  assert.equal(chat.title, 'Configuração de proxy reverso no nginx')
  const rec = repo.messagesRepo.listAll(sid).find((m) => m.meta.autoTitle)!.meta.autoTitle!
  assert.equal(rec.trigger, 'manual')
  titleReply = { status: 500 }
  await assert.rejects(autoTitle.generateTitleNow(chatId), /Não foi possível gerar o título/)
  assert.equal(repo.chatsRepo.get(chatId)!.title, 'Configuração de proxy reverso no nginx')
  await setTitleModel(false)
  await assert.rejects(autoTitle.generateTitleNow(chatId), /Modelo para o título/)
  titleReply = '"Proxy reverso nginx para Node."'
})
