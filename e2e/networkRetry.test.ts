/* eslint-disable @typescript-eslint/no-explicit-any */
// Falha de conexão com o provedor → card "Tentar de novo / Cancelar" (sem Electron: módulo
// `electron` substituído por um stub; banco SQLite num diretório temporário; provedor
// OpenAI-compatible falso em 127.0.0.1 que corta a conexão no meio do stream).
// Cobre: classificação rede × provider, retry descarta o parcial, Cancelar = erro como antes,
// Parar e ⚡ com o card aberto, erro HTTP sem card, subagente bloqueante esperando no card (o pai
// também espera), recuperação na inicialização e no encerramento.
// Rodar: npm run test:unit
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connectionErrorText, isConnectionFailure, isNetworkError } from '../src/shared/network.ts'
import { isNetworkError as legacyIsNetworkError } from '../src/main/tools/models.ts'
import { callWithNetworkRetry } from '../src/main/agent/retries.ts'
import { LlmHttpError } from '../src/main/agent/llm.ts'

// ---------------- puros ----------------

test('rede × provider: classificação de erros lançados', () => {
  const undici = Object.assign(new TypeError('terminated'), {
    cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' })
  })
  for (const e of [
    undici,
    new TypeError('fetch failed'),
    new Error(
      'Falha de rede ao chamar https://x/v1/chat/completions: fetch failed (getaddrinfo ENOTFOUND x)'
    ),
    Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
    new Error('connect ETIMEDOUT 1.2.3.4:443'),
    new Error('Sem resposta do provider por 120s (timeout).'),
    Object.assign(new Error('boom'), { cause: { code: 'ENOTFOUND', message: 'getaddrinfo' } })
  ])
    assert.ok(isConnectionFailure(e), String((e as Error).message))
  for (const e of [
    new LlmHttpError('Erro HTTP 429 Too Many Requests: rate limited', 429),
    new LlmHttpError('Erro HTTP 502 Bad Gateway: upstream ECONNRESET', 502), // HTTP nunca é rede
    new Error('Erro HTTP 500: socket hang up no upstream'),
    new Error('Erro do provider durante o stream: Upstream terminated'),
    new Error('Resposta sem corpo.'),
    new Error('Erro interno qualquer')
  ])
    assert.ok(!isConnectionFailure(e), String((e as Error).message))
  // export antigo continua funcionando (mesma função)
  assert.equal(legacyIsNetworkError, isNetworkError)
  assert.equal(connectionErrorText(undici), 'terminated (other side closed · UND_ERR_SOCKET)')
})

test('callWithNetworkRetry: retry descarta e repete; cancel devolve o erro; erro comum direto', async () => {
  const sig = new AbortController().signal
  let n = 0
  let discards = 0
  const r1 = await callWithNetworkRetry({
    signal: sig,
    attempt: async () => {
      if (++n < 3) throw new TypeError('terminated')
      return 'ok'
    },
    isNetwork: isConnectionFailure,
    onDiscard: () => discards++,
    ask: async () => 'retry'
  })
  assert.deepEqual(r1, { kind: 'ok', value: 'ok' })
  assert.equal(n, 3)
  assert.equal(discards, 2)

  const r2 = await callWithNetworkRetry({
    signal: sig,
    attempt: async () => {
      throw new TypeError('fetch failed')
    },
    isNetwork: isConnectionFailure,
    ask: async () => 'cancel'
  })
  assert.equal(r2.kind, 'error')
  assert.equal((r2 as any).network, true)

  let asked = 0
  const r3 = await callWithNetworkRetry({
    signal: sig,
    attempt: async () => {
      throw new LlmHttpError('Erro HTTP 500', 500)
    },
    isNetwork: isConnectionFailure,
    ask: async () => {
      asked++
      return 'retry'
    }
  })
  assert.equal(r3.kind, 'error')
  assert.equal((r3 as any).network, undefined)
  assert.equal(asked, 0, 'erro HTTP não pergunta')
})

// ---------------- runner real (banco temporário + provedor falso) ----------------

const TMP = mkdtempSync(join(process.env.CLEARCHAT_TEST_TMP || tmpdir(), 'clearchat-retry-'))
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

const MODEL = 'fake/agent'
/** Comportamento do provedor por "roteiro": a 1ª palavra da última mensagem user decide. */
let server: Server
let base = ''
const hits: any[] = []
const counters = new Map<string, number>()
const textOf = (c: any): string =>
  typeof c === 'string' ? c : Array.isArray(c) ? c.map((p: any) => p.text ?? '').join('') : ''

async function readBody(req: IncomingMessage): Promise<string> {
  let d = ''
  for await (const c of req) d += c
  return d
}

function chunk(model: string, delta: any, finish?: string): string {
  return `data: ${JSON.stringify({ id: 'f', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta, ...(finish ? { finish_reason: finish } : {}) }] })}\n\n`
}

before(async () => {
  server = createServer((req, res) => {
    void (async () => {
      const url = req.url ?? ''
      if (req.method === 'GET' && url.endsWith('/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ data: [{ id: MODEL, context_length: 64000 }] }))
        return
      }
      const body = JSON.parse((await readBody(req)) || '{}')
      hits.push(body)
      const msgs: any[] = body.messages ?? []
      const lastUser = [...msgs].reverse().find((m) => m.role === 'user')
      const last = msgs[msgs.length - 1]
      const key = textOf(lastUser?.content).split(/\s+/)[0] || ''
      const n = (counters.get(key) ?? 0) + 1
      counters.set(key, n)
      const full = (text: string): void => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.write(chunk(body.model, { role: 'assistant', content: text }))
        res.write(chunk(body.model, {}, 'stop'))
        res.end('data: [DONE]\n\n')
      }
      const cut = (): void => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.write(chunk(body.model, { role: 'assistant', content: 'PARCIAL-QUE-SOME ' }))
        setTimeout(() => res.socket?.destroy(), 80)
      }
      if (last?.role === 'tool') return full(`FIM: ${textOf(last.content)}`)
      switch (key) {
        case 'corte1': // corta na 1ª, responde na 2ª
          return n === 1 ? cut() : full('RESPOSTA COMPLETA')
        case 'cortesempre':
          return cut()
        case 'http500':
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: { message: 'pane no upstream' } }))
          return
        case 'delegue': {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' })
          res.write(
            chunk(body.model, {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: `call_${Date.now()}`,
                  type: 'function',
                  function: {
                    name: 'delegate_task',
                    arguments: JSON.stringify({ task: 'subtarefa corte na primeira' })
                  }
                }
              ]
            })
          )
          res.write(chunk(body.model, {}, 'tool_calls'))
          res.end('data: [DONE]\n\n')
          return
        }
        case 'subtarefa':
          return n === 1 ? cut() : full('SUB OK')
        default:
          return full('ok')
      }
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
  events: typeof import('../src/main/events.ts')
}
let mods: Mods | null = null
async function load(): Promise<Mods> {
  if (mods) return mods
  const runner = await import('../src/main/agent/runner.ts')
  const repo = await import('../src/main/repo.ts')
  const events = await import('../src/main/events.ts')
  mods = { runner, repo, events }
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
    await sleep(25)
  }
}

let providerId = ''
async function newChat(enabledTools: string[] = []): Promise<{ chatId: string; sid: string }> {
  const { repo } = await load()
  if (!providerId)
    providerId = repo.providersRepo.create({
      name: 'Falso',
      baseUrl: base,
      apiKey: 'k',
      headers: {}
    } as any).id
  const { chat, session } = repo.chatsRepo.create({
    config: { providerId, model: MODEL, cwd: TMP, enabledTools: enabledTools as any }
  })
  return { chatId: chat.id, sid: session.id }
}

const status = (sid: string): string => mods!.repo.sessionsRepo.get(sid)!.status
const msgs = (sid: string): any[] => mods!.repo.messagesRepo.listAll(sid)

test('rede cai no meio do stream → card; Tentar de novo → resposta completa, sem parcial', async () => {
  const { runner, events } = await load()
  const { sid } = await newChat()
  const seen: any[] = []
  const off = events.onAgentEvent((e) => seen.push(e))
  runner.send(sid, 'corte1 olá')
  const req = await waitFor(() => runner.pendingRetries().find((r) => r.sessionId === sid))
  assert.equal(status(sid), 'awaiting_retry')
  assert.match(req.error, /terminated/)
  assert.equal(req.model, MODEL)
  // parcial descartado: draft nulo emitido antes do card e nada de assistant persistido
  const iReq = seen.findIndex((e) => e.type === 'retry-requested')
  assert.ok(
    seen.slice(0, iReq).some((e) => e.type === 'draft' && e.sessionId === sid && e.draft === null)
  )
  assert.ok(!msgs(sid).some((m) => m.message.role === 'assistant'))
  // fila durante o card: mensagens novas vão para a fila
  assert.equal(runner.send(sid, 'outra coisa').queued, true)
  runner.retryRequest(req.id)
  await waitFor(() => status(sid) === 'idle', 8000, 'idle')
  off()
  const assistants = msgs(sid).filter((m) => m.message.role === 'assistant')
  assert.deepEqual(
    assistants.map((m) => m.message.content),
    ['RESPOSTA COMPLETA', 'ok'] // a da fila foi entregue depois
  )
  assert.ok(!msgs(sid).some((m) => /PARCIAL/.test(textOf(m.message.content))))
  assert.ok(seen.some((e) => e.type === 'retry-resolved' && e.id === req.id))
  assert.equal(runner.pendingRetries().length, 0)
})

test('Cancelar no card = erro como antes (mensagem de erro persistida, status error)', async () => {
  const { runner } = await load()
  const { sid } = await newChat()
  runner.send(sid, 'cortesempre a')
  const req = await waitFor(() => runner.pendingRetries().find((r) => r.sessionId === sid))
  const before = hits.length
  runner.cancelRetryRequest(req.id)
  await waitFor(() => status(sid) === 'error', 8000, 'error')
  const last = msgs(sid).at(-1)
  assert.equal(last.meta.kind, 'error')
  assert.match(last.meta.error, /terminated/)
  assert.ok(!msgs(sid).some((m) => m.message.role === 'assistant' && !m.meta.kind))
  await sleep(150)
  assert.equal(hits.length, before, 'sem nova chamada')
})

test('erro HTTP (provider) não abre card: falha como antes', async () => {
  const { runner, events } = await load()
  const { sid } = await newChat()
  let card = false
  const off = events.onAgentEvent((e) => {
    if (e.type === 'retry-requested' && e.request.sessionId === sid) card = true
  })
  runner.send(sid, 'http500 x')
  await waitFor(() => status(sid) === 'error', 8000, 'error')
  off()
  assert.equal(card, false)
  assert.match(msgs(sid).at(-1).meta.error, /Erro HTTP 500.*pane no upstream/)
})

test('Parar com o card aberto = Cancelar (erro); ⚡ cancela e injeta a mensagem', async () => {
  const { runner } = await load()
  const a = await newChat()
  runner.send(a.sid, 'cortesempre b')
  await waitFor(() => runner.pendingRetries().find((r) => r.sessionId === a.sid))
  await runner.stop(a.sid)
  await waitFor(() => !runner.isRunning(a.sid), 8000, 'parou')
  assert.equal(status(a.sid), 'error')
  assert.equal(msgs(a.sid).at(-1).meta.kind, 'error')
  assert.equal(runner.pendingRetries().length, 0)

  const b = await newChat()
  runner.send(b.sid, 'cortesempre c')
  await waitFor(() => runner.pendingRetries().find((r) => r.sessionId === b.sid))
  runner.send(b.sid, 'depois do card')
  const q = runner.getQueue(b.sid)[0]
  runner.forceSend(q.id)
  await waitFor(() => status(b.sid) === 'idle', 8000, 'idle após ⚡')
  const m = msgs(b.sid)
  const iErr = m.findIndex((x) => x.meta.kind === 'error')
  const iForced = m.findIndex((x) => x.meta.kind === 'forced')
  assert.ok(iErr >= 0 && iForced > iErr, 'erro e depois a mensagem forçada')
  assert.equal(m.at(-1).message.content, 'ok')
})

test('subagente bloqueante: card na subsessão, pai continua esperando; retry → resultado ao pai', async () => {
  const { runner, repo } = await load()
  const { chatId, sid } = await newChat(['delegate_task'])
  runner.send(sid, 'delegue algo')
  const req = await waitFor(() =>
    runner.pendingRetries().find((r) => r.chatId === chatId && r.sessionId !== sid)
  )
  const sub = repo.sessionsRepo.get(req.sessionId)!
  assert.equal(sub.depth, 1)
  assert.equal(sub.status, 'awaiting_retry')
  assert.equal(status(sid), 'running', 'pai segue esperando o delegate')
  await sleep(200)
  assert.ok(!msgs(sid).some((m) => m.message.role === 'tool'), 'nada voltou ao pai ainda')
  runner.retryRequest(req.id)
  await waitFor(() => status(sid) === 'idle', 8000, 'pai idle')
  const tool = msgs(sid).find((m) => m.message.role === 'tool')
  assert.equal(tool.message.content, 'SUB OK')
  assert.equal(tool.meta.toolStatus, 'ok')
  assert.equal(msgs(sid).at(-1).message.content, 'FIM: SUB OK')
  assert.equal(repo.sessionsRepo.get(sub.id)!.status, 'done')
})

test('inicialização: sessão que ficou em awaiting_retry vira erro "interrompido: o app foi fechado"', async () => {
  const { runner, repo } = await load()
  const { sid } = await newChat()
  repo.messagesRepo.append(sid, { role: 'user', content: 'x' })
  repo.sessionsRepo.setStatus(sid, 'awaiting_retry')
  runner.initRunner()
  assert.equal(status(sid), 'error')
  const last = msgs(sid).at(-1)
  assert.equal(last.meta.kind, 'error')
  assert.match(last.meta.error, /Falha de conexão com o provedor.*interrompido: o app foi fechado/)
})

// por último: shutdownRunner desliga o runner deste processo
test('encerramento com o card aberto: erro "… (interrompido: o app foi fechado)"', async () => {
  const { runner } = await load()
  const { sid } = await newChat()
  runner.send(sid, 'cortesempre d')
  await waitFor(() => runner.pendingRetries().find((r) => r.sessionId === sid))
  runner.shutdownRunner()
  assert.equal(status(sid), 'error')
  const last = msgs(sid).at(-1)
  assert.equal(last.meta.kind, 'error')
  assert.match(last.meta.error, /terminated.*interrompido: o app foi fechado/)
})
