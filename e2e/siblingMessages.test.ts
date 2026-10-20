/* eslint-disable @typescript-eslint/no-explicit-any */
// Mensagens entre subagentes irmãos (message_subagent com irmão / broadcast=true, check_subagents
// com messages=true e seção "Irmãos") — runner real sem Electron: módulo `electron` substituído por
// um stub, banco SQLite num diretório temporário e um provedor OpenAI-compatible FALSO em 127.0.0.1
// (nenhuma key real, nenhum custo). O relógio do limite anti pingue-pongue é injetado.
// Rodar: npm run test:unit
import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TMP = mkdtempSync(join(process.env.CLEARCHAT_TEST_TMP || tmpdir(), 'clearchat-siblings-'))
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

// ---------------- provedor falso ----------------
// Última mensagem `tool` → "FIM". Na última mensagem `user`: linha `CALL {"name", "arguments"}` →
// chama essa tool; linha `HOLD <ms>` → stream aberto por <ms> (sessão "ativa"); senão `R<n>`.

const MODEL = 'fake/agent'
let server: Server
let base = ''
let calls = 0
const textOf = (c: any): string =>
  typeof c === 'string' ? c : Array.isArray(c) ? c.map((p: any) => p.text ?? '').join('') : ''

async function readBody(req: IncomingMessage): Promise<string> {
  let d = ''
  for await (const c of req) d += c
  return d
}
const chunk = (model: string, delta: any, finish?: string): string =>
  `data: ${JSON.stringify({ id: 'f', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta, ...(finish ? { finish_reason: finish } : {}) }], ...(finish ? { usage: { prompt_tokens: 50, completion_tokens: 5 } } : {}) })}\n\n`

before(async () => {
  server = createServer((req, res) => {
    void (async () => {
      if (req.method === 'GET' && (req.url ?? '').endsWith('/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ data: [{ id: MODEL, context_length: 64000 }] }))
        return
      }
      const body = JSON.parse((await readBody(req)) || '{}')
      calls++
      const msgs: any[] = body.messages ?? []
      const last = msgs[msgs.length - 1]
      const lastUser = textOf([...msgs].reverse().find((m) => m.role === 'user')?.content)
      const full = (t: string): void => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.write(chunk(body.model, { role: 'assistant', content: t }))
        res.end(chunk(body.model, {}, 'stop') + 'data: [DONE]\n\n')
      }
      if (last?.role === 'tool') return full('FIM')
      const call = /^CALL (.+)$/m.exec(lastUser)
      if (call) {
        const c = JSON.parse(call[1])
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.write(
          chunk(body.model, {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: `call_${calls}`,
                type: 'function',
                function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) }
              }
            ]
          })
        )
        res.end(chunk(body.model, {}, 'tool_calls') + 'data: [DONE]\n\n')
        return
      }
      const hold = /^HOLD (\d+)/m.exec(lastUser)
      if (hold) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.write(chunk(body.model, { role: 'assistant', content: 'segurando… ' }))
        const timer = setTimeout(() => {
          if (res.writableEnded || res.destroyed) return
          res.write(chunk(body.model, { content: 'HELD OK' }))
          res.end(chunk(body.model, {}, 'stop') + 'data: [DONE]\n\n')
        }, Number(hold[1]))
        res.on('close', () => clearTimeout(timer))
        return
      }
      return full(`R${calls}`)
    })()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
})

type Mods = {
  runner: typeof import('../src/main/agent/runner.ts')
  repo: typeof import('../src/main/repo.ts')
  request: typeof import('../src/main/agent/request.ts')
}
let mods: Mods | null = null
async function load(): Promise<Mods> {
  if (mods) return mods
  mods = {
    runner: await import('../src/main/agent/runner.ts'),
    repo: await import('../src/main/repo.ts'),
    request: await import('../src/main/agent/request.ts')
  }
  return mods
}

after(async () => {
  if (mods) {
    for (const sid of mods.runner.runningSessions()) await mods.runner.stop(sid).catch(() => {})
    ;(await import('../src/main/db.ts')).closeDb()
  }
  server?.close()
  rmSync(TMP, { recursive: true, force: true })
})

let clock = 1_000_000_000
beforeEach(async () => {
  const { runner } = await load()
  runner.siblingLimiter.clear()
  runner.siblingLimiter.now = () => clock
})

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
async function waitFor<T>(
  fn: () => T | null | undefined | false,
  ms = 10_000,
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

const SUB_TOOLS = [
  'delegate_task',
  'check_subagents',
  'wait_subagents',
  'cancel_subagent',
  'message_subagent',
  'read_history'
]
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
    config: { providerId, model: MODEL, cwd: TMP, enabledTools: SUB_TOOLS as any }
  })
  return { chatId: chat.id, sid: session.id }
}
/** Subsessão criada direto no banco (como um delegate concluído). */
function sub(chatId: string, parent: string, title: string, depth: 1 | 2 = 1): string {
  return mods!.repo.sessionsRepo.create({
    chatId,
    parentSessionId: parent,
    parentToolCallId: null,
    depth,
    model: MODEL,
    providerId,
    title,
    task: title,
    status: 'done'
  }).id
}

const path = (sid: string): any[] => mods!.repo.messagesRepo.path(sid)
const st = (sid: string): any => mods!.repo.sessionsRepo.get(sid)!

/** Espera não haver nenhum loop rodando (callbacks acordam o pai: confere duas vezes). */
async function settle(): Promise<void> {
  for (let i = 0; i < 2; i++) {
    await sleep(60)
    await waitFor(() => mods!.runner.runningSessions().length === 0, 15_000, 'tudo ocioso')
  }
}

/** A sessão `sid` chama a tool (turno completo) e devolve o texto do resultado. */
async function callTool(sid: string, name: string, args: Record<string, unknown>): Promise<string> {
  const before = path(sid).length
  mods!.runner.send(sid, `CALL ${JSON.stringify({ name, arguments: args })}`)
  const tool = await waitFor(
    () =>
      path(sid)
        .slice(before)
        .find((m) => m.message.role === 'tool'),
    15_000,
    `resultado de ${name}`
  )
  await settle()
  return textOf(tool.message.content)
}

const siblingMsgs = (sid: string): any[] =>
  path(sid).filter((m) => m.meta.kind === 'sibling-message' || m.meta.kind === 'sibling-broadcast')

// ---------------- disponibilidade ----------------

test('availableTools: subagente com irmãos recebe check_subagents + message_subagent (sem ter delegado)', async () => {
  const { repo, request } = await load()
  const { chatId, sid } = await newChat()
  const chat = repo.chatsRepo.get(chatId)!
  const a = sub(chatId, sid, 'A')
  const tA = (): string[] => request.availableTools(chat, st(a), [])
  assert.ok(!tA().includes('message_subagent'), 'filho único: sem tools de subagentes')
  assert.ok(!tA().includes('check_subagents'))
  const b = sub(chatId, sid, 'B')
  assert.ok(tA().includes('message_subagent') && tA().includes('check_subagents'))
  assert.ok(!tA().includes('wait_subagents') && !tA().includes('cancel_subagent'))
  // netos irmãos (depth 2, sem delegate_task)
  const b1 = sub(chatId, b, 'B1', 2)
  assert.ok(!request.availableTools(chat, st(b1), []).includes('message_subagent'))
  sub(chatId, b, 'B2', 2)
  const t = request.availableTools(chat, st(b1), [])
  assert.ok(t.includes('message_subagent') && t.includes('check_subagents'))
  assert.ok(!t.includes('delegate_task') && !t.includes('wait_subagents'))
  // message_subagent desabilitada no chat → nada
  const off = { ...chat, config: { ...chat.config, enabledTools: ['delegate_task'] as any } }
  assert.ok(!request.availableTools(off, st(a), []).includes('message_subagent'))
  // prompt de tools do subagente orienta sobre irmãos
  const sys = request.systemContent(
    { ...chat, config: { ...chat.config, toolsInPrompt: true } },
    st(a),
    undefined,
    []
  )
  assert.match(sys, /Subagentes irmãos \(mesmo agente pai/)
})

// ---------------- mensagem direta ----------------

test('irmão: entregue (retoma) e persistida com cabeçalho/meta; resultado do retomado vai ao pai; pai não vê a troca', async () => {
  await load()
  const { chatId, sid } = await newChat()
  const a = sub(chatId, sid, 'Testes')
  const b = sub(chatId, sid, 'Limpeza')
  const out = await callTool(a, 'message_subagent', { id: b, message: 'ZEBRA42 não limpe o out/' })
  assert.match(out, /Mensagem entregue ao irmão "Limpeza"/)
  const got = siblingMsgs(b)
  assert.equal(got.length, 1)
  assert.equal(got[0].message.role, 'user')
  assert.equal(got[0].meta.kind, 'sibling-message')
  assert.equal(got[0].meta.fromSessionId, a)
  assert.equal(
    textOf(got[0].message.content),
    `[Mensagem do subagente irmão "Testes" (${a})]\nZEBRA42 não limpe o out/`
  )
  // B retomou e respondeu; o resultado dele chegou ao PAI como callback de atualização
  const cbs = path(sid).filter((m) => m.meta.kind === 'subagent-callback')
  const cbB = cbs.find((m) => m.meta.subSessionId === b)
  assert.ok(cbB, 'callback de B no pai')
  assert.equal(cbB.meta.callbackUpdate, true)
  // o pai não vê a troca no histórico dele
  const parentText = JSON.stringify(path(sid))
  assert.ok(!parentText.includes('ZEBRA42'))
  assert.ok(!path(sid).some((m) => m.meta.kind === 'sibling-message'))
})

test('irmão rodando: mensagem vai para a fila e entra no próximo passo', async () => {
  await load()
  const { chatId, sid } = await newChat()
  const a = sub(chatId, sid, 'A')
  const b = sub(chatId, sid, 'B')
  mods!.runner.send(b, 'HOLD 1200')
  await waitFor(() => mods!.runner.isRunning(b), 5000, 'B rodando')
  const out = await callTool(a, 'message_subagent', { id: b, message: 'oi irmão' })
  assert.match(out, /Mensagem enfileirada para o irmão "B"/)
  await settle()
  const got = siblingMsgs(b)
  assert.equal(got.length, 1)
  assert.equal(got[0].meta.kind, 'sibling-message', 'kind da fila preservado ao persistir')
})

test('recusas: primo, pai, wait_for_reply com irmão; descendente continua valendo', async () => {
  await load()
  const { chatId, sid } = await newChat()
  const a = sub(chatId, sid, 'A')
  const b = sub(chatId, sid, 'B')
  const a1 = sub(chatId, a, 'A1', 2)
  const b1 = sub(chatId, b, 'B1', 2)
  // A1 (depth 2) filho único: nem tem message_subagent
  const lone = await callTool(a1, 'message_subagent', { id: b1, message: 'oi primo' })
  assert.match(lone, /não está disponível nesta sessão/)
  sub(chatId, a, 'A2', 2) // agora A1 tem irmão → tem message_subagent
  const cousin = await callTool(a1, 'message_subagent', { id: b1, message: 'oi primo' })
  assert.match(cousin, /não é um subagente desta sessão nem um irmão/)
  const parent = await callTool(a, 'message_subagent', { id: sid, message: 'oi pai' })
  assert.match(parent, /não é um subagente desta sessão nem um irmão/)
  const nephew = await callTool(a, 'message_subagent', { id: b1, message: 'oi sobrinho' })
  assert.match(nephew, /nem um irmão/)
  const wait = await callTool(a, 'message_subagent', {
    id: b,
    message: 'oi',
    wait_for_reply: true
  })
  assert.match(wait, /wait_for_reply não vale entre subagentes irmãos/)
  assert.equal(siblingMsgs(b).length, 0, 'nada entregue nas recusas')
  assert.equal(siblingMsgs(b1).length, 0)
  // descendente (filho de A): como antes, mensagem do pai
  const down = await callTool(a, 'message_subagent', { id: a1, message: 'oi filho' })
  assert.match(down, /Mensagem entregue ao subagente "A1"/)
  assert.ok(path(a1).some((m) => m.meta.kind === 'parent-message'))
})

test('anti pingue-pongue: 3 por minuto por par (duas direções), 4ª recusada com segundos; outro par livre; libera após a janela', async () => {
  await load()
  const { chatId, sid } = await newChat()
  const a = sub(chatId, sid, 'A')
  const b = sub(chatId, sid, 'B')
  const c = sub(chatId, sid, 'C')
  clock = 2_000_000_000
  assert.match(await callTool(a, 'message_subagent', { id: b, message: 'm1' }), /irmão "B"/)
  clock += 5_000
  assert.match(await callTool(b, 'message_subagent', { id: a, message: 'm2' }), /irmão "A"/)
  clock += 5_000
  assert.match(await callTool(a, 'message_subagent', { id: b, message: 'm3' }), /irmão "B"/)
  clock += 10_000 // 20 s depois da 1ª
  const refused = await callTool(b, 'message_subagent', { id: a, message: 'm4' })
  assert.match(refused, /já trocaram 3 mensagens no último minuto/)
  assert.match(refused, /em 40 s/)
  assert.match(refused, /agente pai coordena/)
  // outro par não divide a janela
  assert.match(await callTool(a, 'message_subagent', { id: c, message: 'x' }), /irmão "C"/)
  clock += 40_000 // a 1ª saiu da janela
  assert.match(await callTool(b, 'message_subagent', { id: a, message: 'm5' }), /irmão "A"/)
  assert.equal(siblingMsgs(a).length, 2)
  assert.equal(siblingMsgs(b).length, 2)
})

// ---------------- check_subagents ----------------

test('check_subagents: subagente vê os irmãos; o pai lista as mensagens (messages=true, filtro id)', async () => {
  await load()
  const { chatId, sid } = await newChat()
  const a = sub(chatId, sid, 'Alfa')
  const b = sub(chatId, sid, 'Beta')
  const c = sub(chatId, sid, 'Gama')
  const seen = await callTool(a, 'check_subagents', {})
  assert.match(seen, /\[nenhum subagente nesta sessão\]/)
  assert.match(seen, /\[Irmãos \(mesmo agente pai\): 2/)
  assert.ok(seen.includes(`${b} · "Beta"`) && seen.includes(`${c} · "Gama"`))
  assert.ok(!seen.includes(`${a} · "Alfa"`), 'não lista a si mesmo')

  await callTool(a, 'message_subagent', { id: b, message: 'primeira de alfa para beta' })
  await callTool(c, 'message_subagent', { id: b, message: 'de gama para beta' })
  await callTool(b, 'message_subagent', { id: a, message: 'x'.repeat(1000) })
  const list = await callTool(sid, 'check_subagents', { messages: true })
  assert.match(list, /\[3 mensagens entre os seus subagentes\]/)
  assert.match(list, /"Alfa" \([0-9a-f]{8}\) → "Beta" \([0-9a-f]{8}\): primeira de alfa para beta/)
  assert.match(list, /"Gama" .* → "Beta" .*: de gama para beta/)
  assert.match(list, /x{300}… \(1\.000 caracteres\)|x{300}… \(1000 caracteres\)/)
  assert.match(list, /read_history/)
  const onlyC = await callTool(sid, 'check_subagents', { messages: true, id: c })
  assert.match(onlyC, /\[1 mensagem entre os seus subagentes\]/)
  assert.ok(onlyC.includes('de gama para beta'))
  // sem messages: lista normal (sem seção de irmãos na principal)
  const normal = await callTool(sid, 'check_subagents', {})
  assert.match(normal, /\[3 subagentes;/)
  assert.ok(!normal.includes('Irmãos'))
})

// ---------------- broadcast ----------------

test('broadcast: só irmãos ativos por padrão; include_finished retoma os parados; listado uma vez para o pai', async () => {
  await load()
  const { chatId, sid } = await newChat()
  const a = sub(chatId, sid, 'A')
  const b = sub(chatId, sid, 'B')
  const c = sub(chatId, sid, 'C')
  clock = 3_000_000_000
  mods!.runner.send(b, 'HOLD 1500')
  await waitFor(() => mods!.runner.isRunning(b), 5000, 'B rodando')
  const before = mods!.repo.messagesRepo.path(a).length
  mods!.runner.send(
    a,
    `CALL ${JSON.stringify({ name: 'message_subagent', arguments: { broadcast: true, message: 'quem mexe no parser?' } })}`
  )
  const tool = await waitFor(
    () =>
      path(a)
        .slice(before)
        .find((m) => m.message.role === 'tool'),
    10_000,
    'resultado do broadcast'
  )
  const out = textOf(tool.message.content)
  assert.match(out, /Broadcast entregue a 1 irmão\./)
  assert.match(out, /Na fila .*"B"/)
  assert.match(out, /Pulados por estarem parados .*"C"/)
  await settle()
  const gotB = siblingMsgs(b)
  assert.equal(gotB.length, 1)
  assert.equal(gotB[0].meta.kind, 'sibling-broadcast')
  assert.equal(gotB[0].meta.fromSessionId, a)
  assert.ok(gotB[0].meta.broadcastId)
  assert.ok(
    textOf(gotB[0].message.content).startsWith(
      `[Broadcast do subagente irmão "A" (${a}) — responda diretamente (message_subagent para ${a}) só se isto for com você; caso contrário ignore e siga sua tarefa]\n`
    )
  )
  assert.equal(siblingMsgs(c).length, 0, 'C parado: pulado')

  // include_finished: retoma os parados (todos estão parados agora)
  const out2 = await callTool(a, 'message_subagent', {
    broadcast: true,
    include_finished: true,
    message: 'alguém usa a porta 5173?'
  })
  assert.match(out2, /Broadcast entregue a 2 irmãos\./)
  assert.match(out2, /Retomados .*"B".*"C"/)
  assert.equal(siblingMsgs(c).length, 1)
  assert.equal(siblingMsgs(b)[1].meta.broadcastId, siblingMsgs(c)[0].meta.broadcastId)
  assert.ok(
    path(sid).some((m) => m.meta.kind === 'subagent-callback' && m.meta.subSessionId === c),
    'resultado do irmão retomado vai ao pai'
  )

  // 3º broadcast no mesmo minuto: recusado
  clock += 15_000
  const third = await callTool(a, 'message_subagent', {
    broadcast: true,
    include_finished: true,
    message: 'terceiro'
  })
  assert.match(third, /já enviou 2 broadcasts no último minuto/)
  assert.match(third, /em 45 s/)

  // broadcasts não gastam a cota do par; respostas diretas contam
  assert.match(await callTool(b, 'message_subagent', { id: a, message: 'r1' }), /irmão "A"/)
  assert.match(await callTool(a, 'message_subagent', { id: b, message: 'r2' }), /irmão "B"/)
  assert.match(await callTool(b, 'message_subagent', { id: a, message: 'r3' }), /irmão "A"/)
  assert.match(
    await callTool(a, 'message_subagent', { id: b, message: 'r4' }),
    /já trocaram 3 mensagens/
  )

  // o pai: nenhum broadcast no histórico; listagem com cada broadcast uma vez
  assert.ok(!JSON.stringify(path(sid)).includes('porta 5173'))
  const list = await callTool(sid, 'check_subagents', { messages: true })
  assert.equal(list.split('broadcast a 1 irmão').length - 1, 1)
  assert.equal(list.split('broadcast a 2 irmãos').length - 1, 1)
  assert.match(list, /\[5 mensagens entre os seus subagentes\]/)
})

test('broadcast: wait_for_reply recusado; sem irmãos → mensagem clara; nenhum ativo → nada enviado', async () => {
  await load()
  const { chatId, sid } = await newChat()
  const lone = sub(chatId, sid, 'Sozinho')
  const none = await callTool(lone, 'message_subagent', { broadcast: true, message: 'alguém?' })
  assert.match(none, /não tem subagentes irmãos/)
  const b = sub(chatId, sid, 'B')
  const wait = await callTool(lone, 'message_subagent', {
    broadcast: true,
    message: 'alguém?',
    wait_for_reply: true
  })
  assert.match(wait, /wait_for_reply não vale com broadcast/)
  const idleOnly = await callTool(lone, 'message_subagent', { broadcast: true, message: 'alguém?' })
  assert.match(idleOnly, /Nenhum irmão ativo agora: o broadcast não foi enviado/)
  assert.match(idleOnly, /include_finished=true/)
  assert.equal(siblingMsgs(b).length, 0)
})
