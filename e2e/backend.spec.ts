/* eslint-disable @typescript-eslint/no-explicit-any */
// E2E do backend (main process) via Playwright `_electron`, chamando window.api a partir do renderer.
//
// Uso:
//   unset ELECTRON_RUN_AS_NODE
//   npm run build
//   OPENROUTER_API_KEY=sk-or-... CLEARCHAT_E2E_DIR=/tmp/algum-dir node e2e/backend.spec.ts [filtro]
//
// - A key vem SOMENTE do ambiente (nunca grave em arquivo).
// - Usa um userData isolado (CLEARCHAT_USER_DATA) e um cwd de rascunho dentro de CLEARCHAT_E2E_DIR.
// - E2E_MODEL / E2E_CACHE_MODEL sobrescrevem os modelos escolhidos.
// - [filtro] (opcional): roda só os testes cujo nome contém algum dos textos (separados por vírgula).
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  createWriteStream
} from 'node:fs'
import { execSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const KEY = process.env.OPENROUTER_API_KEY
if (!KEY) {
  console.error('Defina OPENROUTER_API_KEY no ambiente.')
  process.exit(2)
}
const ROOT = resolve(import.meta.dirname, '..')
const BASE = resolve(process.env.CLEARCHAT_E2E_DIR || join(tmpdir(), 'clearchat-e2e'))
const USER_DATA = join(BASE, 'userdata')
const CWD = join(BASE, 'cwd')
const FILTER = process.argv[2] ?? ''

const ch0 = (c: any): any => c.config
const DENIED_TEXT = 'O usuário negou a execução desta ferramenta.'
const CANCELLED_TEXT = '[Interrompido pelo usuário antes de concluir]'

// ---------------- infra ----------------

let app: ElectronApplication
let page: Page
let totalCost = 0
const results: { name: string; ok: boolean; info?: string; ms: number }[] = []
const report: Record<string, unknown> = {}

async function launch(): Promise<void> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  delete env.ELECTRON_RUN_AS_NODE
  delete env.OPENROUTER_API_KEY // o app não lê a key do ambiente; ela é passada via providers.create
  env.CLEARCHAT_USER_DATA = USER_DATA
  app = await electron.launch({ args: [ROOT], env, timeout: 60_000 })
  const log = createWriteStream(join(BASE, 'main.log'), { flags: 'a' })
  app.process().stdout?.pipe(log)
  app.process().stderr?.pipe(log)
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() => !!(window as any).api, null, { timeout: 30_000 })
  await page.evaluate(() => {
    const w = window as any
    w.__ev = []
    w.api.onEvent((e: unknown) => w.__ev.push(e))
  })
}

async function api<T = any>(path: string, ...args: unknown[]): Promise<T> {
  return page.evaluate(
    ([p, a]) => {
      const fn = (p as string).split('.').reduce((o: any, k) => o[k], (window as any).api)
      return fn(...(a as unknown[]))
    },
    [path, args] as const
  ) as Promise<T>
}

async function events(): Promise<any[]> {
  return page.evaluate(() => (window as any).__ev)
}
async function clearEvents(): Promise<void> {
  await page.evaluate(() => ((window as any).__ev = []))
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function waitFor<T>(
  fn: () => Promise<T | null | undefined | false>,
  ms: number,
  what: string
): Promise<T> {
  const t0 = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - t0 > ms) throw new Error(`timeout esperando: ${what}`)
    await sleep(150)
  }
}

async function session(sessionId: string, chatId: string): Promise<any> {
  const list = await api<any[]>('sessions.list', chatId)
  return list.find((s) => s.id === sessionId)
}

async function waitIdle(chatId: string, sessionId: string, ms = 120_000): Promise<any> {
  return waitFor(
    async () => {
      const running = await api<string[]>('agent.runningSessions')
      if (running.includes(sessionId)) return null
      const s = await session(sessionId, chatId)
      return s && s.status !== 'running' && s.status !== 'awaiting_approval' ? s : null
    },
    ms,
    `sessão ${sessionId} ociosa`
  )
}

async function waitApproval(sessionId: string, ms = 90_000): Promise<any> {
  return waitFor(
    async () => (await api<any[]>('agent.pendingApprovals')).find((a) => a.sessionId === sessionId),
    ms,
    'approval-requested'
  )
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`asserção falhou: ${msg}`)
}

/** Valida pareamento assistant.tool_calls ↔ tool. */
function assertPairing(msgs: any[]): void {
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i].message
    if (m.role === 'assistant' && m.tool_calls?.length) {
      const ids = new Set(m.tool_calls.map((t: any) => t.id))
      let j = i + 1
      while (j < msgs.length && msgs[j].message.role === 'tool') {
        assert(
          ids.delete(msgs[j].message.tool_call_id),
          `tool msg inesperada ${msgs[j].message.tool_call_id}`
        )
        j++
      }
      assert(ids.size === 0, `tool_calls sem resposta: ${[...ids].join(',')}`)
    }
    if (m.role === 'tool') {
      const prev = msgs
        .slice(0, i)
        .reverse()
        .find((x: any) => x.message.role !== 'tool')
      assert(prev?.message.role === 'assistant', 'tool msg sem assistant anterior')
    }
  }
}

function addCost(msgs: any[]): void {
  for (const m of msgs) if (m.meta?.usage?.cost) totalCost += m.meta.usage.cost
}

async function messages(sessionId: string): Promise<any[]> {
  return api<any[]>('sessions.messages', sessionId)
}

const toolMsgs = (msgs: any[], name?: string): any[] => {
  const ids = new Map<string, string>()
  for (const m of msgs)
    if (m.message.role === 'assistant')
      for (const t of m.message.tool_calls ?? []) ids.set(t.id, t.function.name)
  return msgs.filter(
    (m) => m.message.role === 'tool' && (!name || ids.get(m.message.tool_call_id) === name)
  )
}

async function test(name: string, fn: () => Promise<string | void>): Promise<void> {
  if (FILTER && name !== 'setup' && !FILTER.split(',').some((f) => name.includes(f))) return
  const t0 = Date.now()
  try {
    const info = await fn()
    results.push({ name, ok: true, info: info || undefined, ms: Date.now() - t0 })
    console.log(`✔ ${name}${info ? ` — ${info}` : ''} (${Date.now() - t0}ms)`)
  } catch (e) {
    results.push({ name, ok: false, info: (e as Error).message, ms: Date.now() - t0 })
    console.log(`✖ ${name} — ${(e as Error).message}`)
  }
}

// ---------------- testes ----------------

let providerId = ''
let model = process.env.E2E_MODEL || ''
let chatId = ''
let sid = ''

async function newChat(config: Record<string, unknown> = {}): Promise<{ chat: any; sid: string }> {
  const chat = await api('chats.create', { config: { providerId, model, cwd: CWD, ...config } })
  return { chat, sid: chat.mainSessionId }
}

async function main(): Promise<void> {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(USER_DATA, { recursive: true })
  mkdirSync(CWD, { recursive: true })
  writeFileSync(join(CWD, 'input.txt'), 'hello from clearchat\nsecond line\n')
  await launch()

  await test('setup', async () => {
    const bad = await api('providers.test', {
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-or-v1-invalid'
    })
    assert(bad.ok === false && bad.error, 'test com key inválida deve falhar')
    const t = await api('providers.test', { baseUrl: 'https://openrouter.ai/api/v1/', apiKey: KEY })
    assert(t.ok && t.modelCount > 10, `providers.test: ${JSON.stringify(t)}`)
    const p = await api('providers.create', {
      name: 'OpenRouter',
      baseUrl: 'https://openrouter.ai/api/v1/',
      apiKey: KEY,
      headers: {}
    })
    providerId = p.id
    assert(p.baseUrl === 'https://openrouter.ai/api/v1', 'baseUrl normalizada')
    await api('settings.set', 'defaultProviderId', providerId)
    assert((await api('settings.get', 'defaultProviderId')) === providerId, 'settings get/set')
    const t0 = Date.now()
    const models = await api<any[]>('providers.listModels', providerId)
    const first = Date.now() - t0
    const t1 = Date.now()
    await api('providers.listModels', providerId)
    const cached = Date.now() - t1
    assert(models.length > 10, 'listModels')
    const withPrice = models.filter((m) => typeof m.promptPrice === 'number' && m.contextLength)
    assert(withPrice.length > 10, 'preço/contexto mapeados')
    if (!model) {
      const prefs = [
        'openai/gpt-4.1-nano',
        'openai/gpt-4o-mini',
        'google/gemini-2.5-flash-lite',
        'openai/gpt-5-nano'
      ]
      model = prefs.find((id) => models.some((m) => m.id === id && m.supportsTools)) ?? ''
      assert(model, 'nenhum modelo barato com tools encontrado')
    }
    const mi = models.find((m) => m.id === model)
    report.model = mi
    const ch = await newChat()
    chatId = ch.chat.id
    sid = ch.sid
    const sessions = await api<any[]>('sessions.list', chatId)
    assert(
      sessions.length === 1 && sessions[0].depth === 0 && sessions[0].model === model,
      'sessão principal'
    )
    assert(
      ch.chat.config.cacheEnabled === true &&
        ch.chat.config.enabledTools.length === 11 &&
        ch.chat.config.enabledTools.includes('list_models') &&
        ch.chat.config.confineToRoot === true &&
        ch.chat.config.maxToolOutputChars === 30000,
      'defaults'
    )
    return `model=${model} (prompt $${(mi.promptPrice * 1e6).toFixed(3)}/M, tools=${mi.supportsTools}); listModels ${first}ms → cache ${cached}ms`
  })

  await test('previewRequest', async () => {
    const pr = await api('agent.previewRequest', sid)
    assert(pr.url === 'https://openrouter.ai/api/v1/chat/completions', 'url')
    assert(
      /^Bearer sk-or-…[0-9a-f]{4}$/.test(pr.headers.Authorization),
      `key mascarada: ${pr.headers.Authorization}`
    )
    assert(!JSON.stringify(pr).includes(KEY), 'key vazou no preview')
    assert(
      pr.headers['X-Title'] === 'ClearChat' && pr.headers['HTTP-Referer'],
      'headers OpenRouter'
    )
    const b = pr.body
    assert(
      b.model === model && b.stream === true && b.stream_options.include_usage === true,
      'body base'
    )
    assert(b.usage?.include === true, 'usage include')
    assert(
      b.messages[0].role === 'system' && Array.isArray(b.messages[0].content),
      'system em parts'
    )
    assert(b.messages[0].content[0].cache_control?.type === 'ephemeral', 'cache_control no system')
    const sysText = b.messages[0].content[0].text as string
    assert(sysText.includes(`<environment>\nroot: ${CWD}`), 'env block')
    assert(/caminhos dentro do diretório raiz/.test(sysText), 'confinação no env block')
    assert(b.tools.length === 11, 'tools')
    assert(
      b.tools.some((t: any) => t.function.name === 'list_models'),
      'list_models nas tools'
    )
    assert(
      b.tools.some((t: any) => t.function.name === 'search_files') &&
        b.tools.some((t: any) => t.function.name === 'find_files'),
      'search_files/find_files'
    )
    // extraBody inválido → erro legível
    await api('chats.update', chatId, {
      config: { params: { temperature: 0.3, extraBody: '{nope' } }
    })
    let err = ''
    try {
      await api('agent.previewRequest', sid)
    } catch (e) {
      err = (e as Error).message
    }
    assert(/extraBody não é um JSON válido/.test(err), `erro extraBody: ${err}`)
    const c = await api('chats.update', chatId, {
      config: { params: { extraBody: undefined, temperature: 0 } }
    })
    assert(
      c.config.params.temperature === 0 && !('extraBody' in c.config.params),
      `merge params ${JSON.stringify(c.config.params)}`
    )
    const pr2 = await api('agent.previewRequest', sid)
    assert(pr2.body.temperature === 0, 'temperature enviada')
    // assinatura de app
    assert(ch0(await api('chats.get', chatId)).appSignature === 'clearchat', 'assinatura padrão')
    await api('chats.update', chatId, { config: { appSignature: 'none' } })
    let h = (await api('agent.previewRequest', sid)).headers
    assert(!('HTTP-Referer' in h) && !('X-Title' in h), `none: ${JSON.stringify(h)}`)
    await api('chats.update', chatId, { config: { appSignature: 'cline' } })
    h = (await api('agent.previewRequest', sid)).headers
    assert(
      h['HTTP-Referer'] === 'https://cline.bot' && h['X-Title'] === 'Cline',
      `cline: ${JSON.stringify(h)}`
    )
    await api('chats.update', chatId, {
      config: {
        appSignature: 'custom',
        appSignatureCustom: { referer: 'https://e2e.test', title: 'E2E' }
      }
    })
    h = (await api('agent.previewRequest', sid)).headers
    assert(
      h['HTTP-Referer'] === 'https://e2e.test' && h['X-Title'] === 'E2E',
      `custom: ${JSON.stringify(h)}`
    )
    await api('chats.update', chatId, { config: { appSignature: 'clearchat' } })
    report.previewSample = {
      ...pr2,
      body: {
        ...pr2.body,
        tools: `[${pr2.body.tools.length} tools]`,
        messages: pr2.body.messages.map((m: any) => ({
          ...m,
          content: Array.isArray(m.content)
            ? m.content.map((p: any) => ({ ...p, text: p.text.slice(0, 40) + '…' }))
            : m.content
        }))
      }
    }
  })

  await test('read_file + write_file', async () => {
    const r = await api(
      'agent.send',
      sid,
      'Use the read_file tool to read input.txt, then use the write_file tool to create output.txt containing exactly the first line of input.txt converted to UPPERCASE. Finally reply with just "DONE".'
    )
    assert(r.queued === false, 'não enfileirado')
    const s = await waitIdle(chatId, sid)
    assert(s.status === 'idle', `status ${s.status}`)
    const out = readFileSync(join(CWD, 'output.txt'), 'utf8')
    assert(out.trim() === 'HELLO FROM CLEARCHAT', `output.txt = ${JSON.stringify(out)}`)
    const msgs = await messages(sid)
    addCost(msgs)
    assertPairing(msgs)
    assert(
      toolMsgs(msgs, 'read_file').some((m) =>
        m.message.content.includes('1\thello from clearchat')
      ),
      'read_file numerado'
    )
    assert(
      toolMsgs(msgs).every((m) => m.meta.toolStatus === 'ok'),
      'toolStatus ok'
    )
    const last = msgs[msgs.length - 1]
    assert(
      last.message.role === 'assistant' &&
        !last.message.tool_calls &&
        last.meta.usage?.promptTokens > 0,
      'resposta final com usage'
    )
    const chat = await api('chats.get', chatId)
    assert(
      chat.title.startsWith('Use the read_file tool') && chat.title.length <= 51,
      `título ${chat.title}`
    )
    const ev = await events()
    assert(
      ev.some((e) => e.type === 'draft' && e.draft) &&
        ev.some((e) => e.type === 'draft' && e.draft === null),
      'drafts'
    )
    assert(
      ev.some((e) => e.type === 'tool-running' && e.running) &&
        ev.some((e) => e.type === 'session-updated' && e.session.status === 'running'),
      'eventos'
    )
    return `${msgs.length} msgs; usage último: ${JSON.stringify(last.meta.usage)}`
  })

  await test('bash approve (allow)', async () => {
    await clearEvents()
    await api(
      'agent.send',
      sid,
      'Use the bash tool to run exactly this command: echo hello-e2e > bash.txt && cat bash.txt'
    )
    const ap = await waitApproval(sid)
    assert(
      ap.toolName === 'bash' && ap.args.command.includes('hello-e2e'),
      `approval ${JSON.stringify(ap)}`
    )
    const s1 = await session(sid, chatId)
    assert(s1.status === 'awaiting_approval', `status ${s1.status}`)
    await api('agent.approve', ap.id, 'allow')
    await waitIdle(chatId, sid)
    assert(readFileSync(join(CWD, 'bash.txt'), 'utf8').trim() === 'hello-e2e', 'bash.txt')
    const msgs = await messages(sid)
    addCost(msgs)
    assertPairing(msgs)
    const t = toolMsgs(msgs, 'bash').at(-1)
    assert(
      t.message.content.includes('hello-e2e') && t.message.content.includes('[exit code: 0]'),
      `bash out ${t.message.content}`
    )
    const ev = await events()
    assert(
      ev.some((e) => e.type === 'approval-requested') &&
        ev.some((e) => e.type === 'approval-resolved' && e.id === ap.id),
      'eventos approval'
    )
  })

  await test('bash deny', async () => {
    await api(
      'agent.send',
      sid,
      'Use the bash tool to run: ls -la. If it is denied, just say "ok, denied" and do not retry.'
    )
    const ap = await waitApproval(sid)
    await api('agent.approve', ap.id, 'deny')
    const s = await waitIdle(chatId, sid)
    assert(s.status === 'idle', `status ${s.status}`)
    const msgs = await messages(sid)
    addCost(msgs)
    assertPairing(msgs)
    const t = toolMsgs(msgs, 'bash').find((m) => m.message.tool_call_id === ap.toolCallId)
    assert(t && t.message.content === DENIED_TEXT && t.meta.toolStatus === 'denied', 'tool negada')
  })

  await test('approve always + fila (queue)', async () => {
    await api(
      'agent.send',
      sid,
      'Use the bash tool to run: sleep 4; echo slept-ok. Then report the output.'
    )
    const ap = await waitApproval(sid)
    await api('agent.approve', ap.id, 'always')
    const chat = await api('chats.get', chatId)
    assert(chat.config.autoApprove.includes('bash'), 'autoApprove atualizado')
    await sleep(500)
    const q = await api('agent.send', sid, 'Also: what is 2+2? Answer with just the number.')
    assert(q.queued === true, 'deveria enfileirar')
    const queue = await api<any[]>('agent.getQueue', sid)
    assert(queue.length === 1, 'fila com 1')
    await waitIdle(chatId, sid)
    assert((await api<any[]>('agent.getQueue', sid)).length === 0, 'fila drenada')
    const msgs = await messages(sid)
    addCost(msgs)
    assertPairing(msgs)
    const qi = msgs.findIndex((m) => m.meta.kind === 'queued')
    assert(qi > 0, 'msg queued persistida')
    const bashTool = toolMsgs(msgs, 'bash').find((m) => m.message.tool_call_id === ap.toolCallId)
    assert(
      bashTool && bashTool.seq < msgs[qi].seq && bashTool.message.content.includes('slept-ok'),
      'queued após resultado da tool'
    )
    const after = msgs.slice(qi + 1).filter((m) => m.message.role === 'assistant')
    assert(
      after.some((m) => /4/.test(m.message.content ?? '')),
      'resposta à msg enfileirada'
    )
    const ev = await events()
    assert(
      ev.some((e) => e.type === 'queue-updated' && e.queue.length === 1),
      'evento queue-updated'
    )
  })

  await test('forceSend durante tool (bash longo)', async () => {
    await api('chats.update', chatId, { config: { autoApprove: ['bash'] } })
    await clearEvents()
    const marker = `sleep 31.${Math.floor(Math.random() * 1000)}`
    await api(
      'agent.send',
      sid,
      `Use the bash tool to run exactly: ${marker}; echo late > late.txt`
    )
    await waitFor(
      async () => (await events()).find((e) => e.type === 'tool-running' && e.running),
      60_000,
      'bash rodando'
    )
    await sleep(800)
    assert(
      execSync(`pgrep -f "[${marker[0]}]${marker.slice(1)}" || true`)
        .toString()
        .trim(),
      'sleep deveria estar rodando'
    )
    await api('agent.send', sid, 'Never mind, stop that. Just reply "forced-ack".')
    const [item] = await api<any[]>('agent.getQueue', sid)
    assert(item, 'item na fila')
    await api('agent.forceSend', item.id)
    await waitIdle(chatId, sid)
    await sleep(500)
    assert(
      !execSync(`pgrep -f "[${marker[0]}]${marker.slice(1)}" || true`)
        .toString()
        .trim(),
      'processo bash deveria ter sido morto'
    )
    assert(!existsSync(join(CWD, 'late.txt')), 'late.txt não deveria existir')
    const msgs = await messages(sid)
    addCost(msgs)
    assertPairing(msgs)
    const fi = msgs.findIndex((m) => m.meta.kind === 'forced')
    assert(fi > 0, 'msg forced')
    const cancelled = msgs[fi - 1]
    assert(
      cancelled.message.role === 'tool' &&
        cancelled.message.content === CANCELLED_TEXT &&
        cancelled.meta.toolStatus === 'cancelled',
      'tool cancelada antes da forced'
    )
    const last = msgs.at(-1)
    assert(
      last.message.role === 'assistant' && last.seq > msgs[fi].seq,
      'próxima chamada OK após forced'
    )
    assert((await session(sid, chatId)).status === 'idle', 'idle')
  })

  await test('forceSend durante stream + stop + regenerate', async () => {
    await clearEvents()
    await api(
      'agent.send',
      sid,
      'Write a 600-word story about a lighthouse keeper. Do not use any tools.'
    )
    await waitFor(
      async () => (await events()).find((e) => e.type === 'draft' && e.draft?.content?.length > 40),
      60_000,
      'stream começar'
    )
    await api('agent.send', sid, 'Stop the story. Reply only "interrupted-ack".')
    const [item] = await api<any[]>('agent.getQueue', sid)
    await api('agent.forceSend', item.id)
    await waitIdle(chatId, sid)
    let msgs = await messages(sid)
    addCost(msgs)
    assertPairing(msgs)
    const fi = msgs.findIndex((m, i) => m.meta.kind === 'forced' && i > msgs.length - 4)
    assert(fi > 0, 'forced')
    const partial = msgs[fi - 1]
    assert(
      partial.message.role === 'assistant' &&
        partial.meta.interrupted === true &&
        partial.message.content.length > 0,
      'assistant parcial interrompido'
    )
    assert(
      msgs.at(-1).message.role === 'assistant' && msgs.at(-1).seq > msgs[fi].seq,
      'resposta após forced'
    )

    // stop
    await clearEvents()
    await api('agent.send', sid, 'Write a 600-word poem about the sea. Do not use tools.')
    await waitFor(
      async () => (await events()).find((e) => e.type === 'draft' && e.draft?.content?.length > 40),
      60_000,
      'stream começar'
    )
    await api('agent.stop', sid)
    const s = await waitIdle(chatId, sid, 10_000)
    assert(s.status === 'idle', `status após stop ${s.status}`)
    msgs = await messages(sid)
    assert(msgs.at(-1).meta.interrupted === true, 'parcial persistido após stop')

    // regenerate
    const lastUser = msgs.filter((m) => m.message.role === 'user').at(-1)
    await api('agent.regenerate', sid)
    await waitIdle(chatId, sid)
    msgs = await messages(sid)
    addCost(msgs)
    assertPairing(msgs)
    const lu = msgs.findIndex((m) => m.id === lastUser.id)
    assert(
      lu === msgs.length - 2 &&
        msgs.at(-1).message.role === 'assistant' &&
        !msgs.at(-1).meta.interrupted,
      'regenerado'
    )
  })

  await test('delegate_task (subsessão)', async () => {
    await api('chats.update', chatId, { config: { autoApprove: ['bash'] } })
    await clearEvents()
    await api(
      'agent.send',
      sid,
      'Use the delegate_task tool (title "contar arquivos") to ask a subagent to use list_dir on the current working directory and report the exact file names. Then tell me how many files there are.'
    )
    await waitIdle(chatId, sid, 180_000)
    const sessions = await api<any[]>('sessions.list', chatId)
    const t0msgs = await messages(sid)
    const lastDelegate = toolMsgs(t0msgs, 'delegate_task').at(-1)
    assert(lastDelegate, 'delegate_task chamada')
    const child = sessions.find(
      (s) => s.depth === 1 && s.parentToolCallId === lastDelegate.message.tool_call_id
    )
    assert(child, 'subsessão criada')
    assert(
      child.parentSessionId === sid && child.parentToolCallId && child.status === 'done',
      `subsessão ${JSON.stringify(child)}`
    )
    const msgs = await messages(sid)
    addCost(msgs)
    assertPairing(msgs)
    const t = toolMsgs(msgs, 'delegate_task').at(-1)
    assert(
      t && t.meta.subSessionId === child.id && t.message.tool_call_id === child.parentToolCallId,
      'tool meta.subSessionId'
    )
    const cm = await messages(child.id)
    addCost(cm)
    assertPairing(cm)
    // o resultado do delegate é exatamente o texto final do subagente (o conteúdo depende do modelo)
    const finalSub = cm.filter((m) => m.message.role === 'assistant').at(-1)
    assert(
      t.message.content.trim() === String(finalSub?.message.content ?? '').trim(),
      `resultado do subagente: ${t.message.content.slice(0, 200)}`
    )
    assert(
      toolMsgs(cm, 'list_dir').some((m) => /input\.txt/.test(m.message.content)),
      'list_dir do subagente viu input.txt'
    )
    assert(
      cm[0].message.role === 'user' && cm[0].meta.synthetic && cm[0].message.content === child.task,
      'task como primeira msg'
    )
    assert(toolMsgs(cm, 'list_dir').length >= 1, 'subagente usou list_dir')
    const pr = await api('agent.previewRequest', child.id)
    assert(
      pr.body.messages[0].content[0].text.startsWith('Você é um subagente'),
      'system prompt de subagente'
    )
    assert(
      pr.body.tools.some((x: any) => x.function.name === 'delegate_task'),
      'depth 1 ainda pode delegar'
    )
    const ev = await events()
    assert(
      ev.some((e) => e.type === 'session-created' && e.session.id === child.id),
      'evento session-created'
    )
    assert(
      ev.some((e) => e.type === 'draft' && e.sessionId === child.id),
      'drafts da subsessão'
    )
    let sendErr = ''
    try {
      await api('agent.send', child.id, 'x')
    } catch (e) {
      sendErr = (e as Error).message
    }
    assert(/somente leitura/.test(sendErr), 'subsessão somente leitura')
    assert(
      pr.body.messages[1].role === 'user' &&
        JSON.stringify(pr.body.messages[1].content).includes(child.task.slice(0, 40)),
      'task é a 1ª mensagem user da request do subagente'
    )
    // regenerate apaga a subsessão órfã (evento session-deleted)
    await clearEvents()
    await api('agent.regenerate', sid)
    await waitIdle(chatId, sid, 180_000)
    const after = await api<any[]>('sessions.list', chatId)
    assert(!after.some((s) => s.id === child.id), 'subsessão órfã apagada no regenerate')
    assert(
      (await events()).some((e) => e.type === 'session-deleted' && e.sessionId === child.id),
      'evento session-deleted'
    )
    assert((await messages(child.id)).length === 0, 'mensagens da subsessão apagadas')
    // apagar a mensagem assistant com o tool_call do delegate também apaga a subsessão
    // (depois apaga a msg tool órfã, para manter o histórico pareado para os próximos testes)
    const m3 = await messages(sid)
    addCost(m3)
    const t3 = toolMsgs(m3, 'delegate_task').at(-1)
    if (t3?.meta.subSessionId) {
      const a3 = m3.find(
        (m) =>
          m.message.role === 'assistant' &&
          m.message.tool_calls?.some((tc: any) => tc.id === t3.message.tool_call_id)
      )
      const others = m3.filter(
        (m) =>
          m.message.role === 'tool' &&
          a3.message.tool_calls.some((tc: any) => tc.id === m.message.tool_call_id)
      )
      await api('messages.delete', a3.id)
      const after2 = await api<any[]>('sessions.list', chatId)
      assert(!after2.some((s) => s.id === t3.meta.subSessionId), 'subsessão apagada com a msg')
      for (const o of others) await api('messages.delete', o.id)
      assertPairing(await messages(sid))
    }
    return `child=${child.id.slice(0, 8)} model=${child.model}; resultado: ${t.message.content.slice(0, 80).replace(/\n/g, ' ')}…`
  })

  await test('web_search + browse_url', async () => {
    await api('chats.update', chatId, {
      config: { autoApprove: ['bash', 'web_search', 'browse_url'] }
    })
    await api(
      'agent.send',
      sid,
      'First use web_search with query "electron-vite build tooling". Then use browse_url on https://example.com and tell me the page title. Keep the answer short.'
    )
    await waitIdle(chatId, sid, 120_000)
    const msgs = await messages(sid)
    addCost(msgs)
    assertPairing(msgs)
    const ws = toolMsgs(msgs, 'web_search').at(-1)
    const bu = toolMsgs(msgs, 'browse_url').at(-1)
    assert(ws, 'web_search chamada')
    assert(
      bu && bu.meta.toolStatus === 'ok' && /Example Domain/.test(bu.message.content),
      `browse_url: ${bu?.message.content.slice(0, 200)}`
    )
    return `web_search status=${ws.meta.toolStatus}: ${ws.message.content.split('\n').slice(0, 3).join(' | ').slice(0, 160)}`
  })

  await test('modo texto (nativeTools=false)', async () => {
    const { chat, sid: s2 } = await newChat({
      nativeTools: false,
      toolsInPrompt: true,
      enabledTools: ['read_file']
    })
    const pr = await api('agent.previewRequest', s2)
    assert(
      !pr.body.tools && /<tool_call>/.test(pr.body.messages[0].content[0].text),
      'sem campo tools; texto no system'
    )
    await api(
      'agent.send',
      s2,
      'Call the read_file tool on input.txt, writing the call in the exact <tool_call>{"name": ..., "arguments": {...}}</tool_call> format described in your instructions. After you get the result, tell me the second line of the file.'
    )
    await waitIdle(chat.id, s2)
    const msgs = await messages(s2)
    addCost(msgs)
    const tr = msgs.find(
      (m) =>
        m.message.role === 'user' &&
        m.meta.synthetic &&
        /<tool_result name="read_file">/.test(m.message.content)
    )
    assert(tr, 'tool_result sintético')
    assert(
      /second line/i.test(msgs.at(-1).message.content ?? ''),
      `resposta final: ${msgs.at(-1).message.content}`
    )
  })

  await test('erro HTTP legível (key inválida)', async () => {
    const p = await api('providers.create', {
      name: 'Bad',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-or-v1-bad',
      headers: {}
    })
    const { chat, sid: s3 } = await newChat({ providerId: p.id })
    await clearEvents()
    await api('agent.send', s3, 'hi')
    const s = await waitIdle(chat.id, s3, 30_000)
    assert(s.status === 'error', `status ${s.status}`)
    const ev = (await events()).find((e) => e.type === 'error' && e.sessionId === s3)
    assert(ev && /Erro HTTP 401/.test(ev.error), `evento error: ${ev?.error}`)
    // erro persistido só para exibição e excluído da request
    const em = await messages(s3)
    const errM = em.find((m) => m.meta.kind === 'error')
    assert(errM && errM.meta.synthetic && errM.meta.error === ev.error, 'erro persistido')
    const prev = await api('agent.previewRequest', s3)
    assert(
      !JSON.stringify(prev.body.messages).includes('Erro HTTP'),
      'mensagem de erro não vai para a API'
    )
    await api('chats.delete', chat.id)
    assert(!(await api('chats.get', chat.id)), 'chat apagado')
    return ev.error
  })

  await test('token caching (Anthropic haiku via OpenRouter)', async () => {
    const models = await api<any[]>('providers.listModels', providerId)
    const cacheModel =
      process.env.E2E_CACHE_MODEL ||
      [
        'anthropic/claude-haiku-5.5',
        'anthropic/claude-haiku-4.5',
        'anthropic/claude-3.5-haiku',
        'anthropic/claude-3-haiku'
      ].find((id) => models.some((m) => m.id === id))
    assert(cacheModel, 'nenhum haiku disponível')
    // system prompt longo (>4096 tokens) para passar do mínimo cacheável
    const filler = Array.from(
      { length: 260 },
      (_, i) =>
        `Regra ${i + 1}: mantenha respostas curtas, objetivas e corretas; cite fontes quando necessário; nunca invente dados sobre o item ${i + 1}.`
    ).join('\n')
    const { chat, sid: s4 } = await newChat({
      model: cacheModel,
      systemPrompt: `Você é um assistente.\n${filler}`,
      enabledTools: []
    })
    const turns: any[] = []
    for (const q of ['Responda apenas: oi', 'Responda apenas: tchau', 'Responda apenas: ok']) {
      await api('agent.send', s4, q)
      const s = await waitIdle(chat.id, s4)
      assert(s.status === 'idle', `status ${s.status}`)
      const msgs = await messages(s4)
      turns.push(msgs.at(-1).meta.usage)
    }
    addCost(await messages(s4))
    // compactação no mesmo chat: a request de resumo reaproveita o prefixo em cache
    await api('agent.compact', s4)
    await waitIdle(chat.id, s4)
    const cm = (await messages(s4)).at(-1)
    assert(cm.meta.kind === 'compaction', `fronteira: ${JSON.stringify(cm.meta)}`)
    if (cm.meta.compactUsage?.cost) totalCost += cm.meta.compactUsage.cost
    report.caching = { model: cacheModel, turns, compactUsage: cm.meta.compactUsage }
    assert(
      (cm.meta.compactUsage?.cachedTokens ?? 0) > 0,
      `compactação sem cache: ${JSON.stringify(cm.meta.compactUsage)}`
    )
    assert(
      (turns[1].cachedTokens ?? 0) > 0 || (turns[2].cachedTokens ?? 0) > 0,
      `sem cachedTokens: ${JSON.stringify(turns)}`
    )
    return turns
      .map(
        (u, i) =>
          `t${i + 1}: in=${u.promptTokens} cached=${u.cachedTokens ?? '-'} write=${u.cacheWriteTokens ?? '-'} cost=$${u.cost?.toFixed(6)}`
      )
      .join(' | ')
      .concat(` | compact: cached=${cm.meta.compactUsage?.cachedTokens}`)
  })

  await test('token caching em loop de tools (haiku)', async () => {
    const models = await api<any[]>('providers.listModels', providerId)
    const cacheModel =
      process.env.E2E_CACHE_MODEL ||
      ['anthropic/claude-haiku-5.5', 'anthropic/claude-haiku-4.5'].find((id) =>
        models.some((m) => m.id === id)
      )
    assert(cacheModel, 'nenhum haiku disponível')
    const filler = Array.from(
      { length: 260 },
      (_, i) =>
        `Regra ${i + 1}: mantenha respostas curtas, objetivas e corretas; cite fontes quando necessário; nunca invente dados sobre o item ${i + 1}.`
    ).join('\n')
    const loopDir = join(CWD, 'loop')
    mkdirSync(loopDir, { recursive: true })
    for (const n of ['a', 'b', 'c', 'd'])
      writeFileSync(
        join(loopDir, `${n}.txt`),
        Array.from({ length: 40 }, (_, i) => `${n}${i}: conteúdo de teste do arquivo ${n}`).join(
          '\n'
        )
      )
    const { chat, sid: s5 } = await newChat({
      model: cacheModel,
      systemPrompt: `Você é um assistente.\n${filler}`,
      enabledTools: ['read_file'],
      cwd: loopDir
    })
    await api(
      'agent.send',
      s5,
      'Leia os arquivos a.txt, b.txt, c.txt e d.txt com read_file, UM POR RESPOSTA (nunca chame duas tools na mesma resposta), na ordem. Depois responda apenas "fim".'
    )
    const s = await waitIdle(chat.id, s5, 180_000)
    assert(s.status === 'idle', `status ${s.status}`)
    const msgs = await messages(s5)
    addCost(msgs)
    const steps = msgs
      .filter((m) => m.message.role === 'assistant' && m.meta.usage)
      .map((m) => m.meta.usage)
    report.cachingLoop = { model: cacheModel, steps }
    const line = steps
      .map(
        (u, i) =>
          `s${i + 1}: in=${u.promptTokens} cached=${u.cachedTokens ?? 0} write=${u.cacheWriteTokens ?? 0}`
      )
      .join(' | ')
    assert(steps.length >= 3, `poucos passos: ${line}`)
    for (let i = 2; i < steps.length; i++)
      assert(
        (steps[i].cachedTokens ?? 0) > (steps[i - 1].cachedTokens ?? 0),
        `cachedTokens não cresceu no passo ${i + 1}: ${line}`
      )
    return line
  })

  await test('reinício: sessão rodando → interrupted (pareamento reparado)', async () => {
    const { chat: rc, sid: rs } = await newChat({ enabledTools: ['bash'], autoApprove: ['bash'] })
    const chatId = rc.id
    const sid = rs
    await clearEvents()
    await api('agent.send', sid, 'Use the bash tool to run exactly: sleep 20.123; echo z')
    await waitFor(
      async () =>
        (await events()).find((e) => e.type === 'tool-running' && e.running && e.sessionId === sid),
      60_000,
      'bash rodando'
    )
    await app.close()
    await sleep(500)
    assert(
      !execSync('pgrep -f "[s]leep 20.123" || true').toString().trim(),
      'bash deveria morrer ao fechar o app'
    )
    await launch()
    const s = await session(sid, chatId)
    assert(s.status === 'interrupted', `status após reinício ${s.status}`)
    const msgs = await messages(sid)
    assertPairing(msgs)
    assert(msgs.at(-1).message.content === CANCELLED_TEXT, 'tool sintética cancelada')
    // crash (SIGKILL): na próxima inicialização a sessão vira 'interrupted' e o pareamento é reparado
    await clearEvents()
    await api('agent.send', sid, 'Use the bash tool to run exactly: sleep 5.321; echo y')
    await waitFor(
      async () =>
        (await events()).find((e) => e.type === 'tool-running' && e.running && e.sessionId === sid),
      60_000,
      'bash rodando (2)'
    )
    app.process().kill('SIGKILL')
    await sleep(1000)
    await launch()
    const s2 = await session(sid, chatId)
    assert(s2.status === 'interrupted', `status após crash ${s2.status}`)
    const msgs2 = await messages(sid)
    assertPairing(msgs2)
    assert(
      msgs2.at(-1).message.content === CANCELLED_TEXT &&
        msgs2.at(-1).meta.toolStatus === 'cancelled',
      'reparo após crash'
    )
    // e segue funcionando
    await api('agent.send', sid, 'Reply only "back".')
    await waitIdle(chatId, sid)
    const m2 = await messages(sid)
    addCost(m2)
    assertPairing(m2)
    assert(m2.at(-1).message.role === 'assistant', 'responde após reinício')
  })

  // ---------------- diretório raiz / limites / compactação ----------------

  await test('compactação ponta a ponta (resumo persistido, request a partir da fronteira, continua coerente)', async () => {
    const { chat, sid: sc } = await newChat({ enabledTools: [] })
    await api('agent.send', sc, 'Remember this secret code word: ZEBRA-7731. Reply only "ok".')
    await waitIdle(chat.id, sc)
    await api('agent.send', sc, 'Also remember: my favorite color is teal. Reply only "ok".')
    await waitIdle(chat.id, sc)
    const before = await messages(sc)
    addCost(before)
    await clearEvents()
    const r = await api('agent.compact', sc)
    assert(r.scheduled === false, 'compacta já (ociosa)')
    const s = await waitIdle(chat.id, sc)
    assert(s.status === 'idle', `status ${s.status}`)
    const after = await messages(sc)
    assert(
      after.length === before.length + 1,
      `só a fronteira é persistida (${before.length} → ${after.length})`
    )
    const b = after.at(-1)
    assert(
      b.meta.kind === 'compaction' && b.meta.synthetic && b.message.role === 'user',
      'fronteira role user'
    )
    assert(
      /^<conversation_summary>\n[\s\S]+\n<\/conversation_summary>\n\n/.test(b.message.content),
      'formato'
    )
    assert(/ZEBRA-7731/.test(b.message.content), `resumo sem o código: ${b.message.content}`)
    assert(
      b.meta.summaryOf.fromSeq === before[0].seq && b.meta.summaryOf.toSeq === before.at(-1).seq,
      `summaryOf ${JSON.stringify(b.meta.summaryOf)}`
    )
    assert(b.meta.usageBefore > 0 && b.meta.contextEstimate > 0, 'usageBefore/contextEstimate')
    if (b.meta.compactUsage?.cost) totalCost += b.meta.compactUsage.cost
    const ev = await events()
    assert(
      ev.some((e) => e.type === 'compaction' && e.state === 'running' && e.text) &&
        ev.some((e) => e.type === 'compaction' && e.state === null),
      'eventos de compactação (stream do resumo)'
    )
    // a próxima request começa na fronteira
    const pr = await api('agent.previewRequest', sc)
    const roles = pr.body.messages.map((m: any) => m.role)
    assert(JSON.stringify(roles) === '["system","user"]', `request compactada: ${roles}`)
    const firstUser = pr.body.messages[1].content
    const txt = Array.isArray(firstUser) ? firstUser.map((p: any) => p.text).join('') : firstUser
    assert(txt === b.message.content, 'fronteira reenviada byte a byte')
    assert(!JSON.stringify(pr.body).includes('Reply only "ok"'), 'histórico antigo fora da request')
    // continua coerente
    await api(
      'agent.send',
      sc,
      'What is my secret code word and my favorite color? Answer in one short line.'
    )
    await waitIdle(chat.id, sc)
    const m2 = await messages(sc)
    addCost(m2.slice(after.length))
    const ans = m2.at(-1).message.content ?? ''
    assert(/ZEBRA-7731/.test(ans) && /teal/i.test(ans), `resposta pós-compactação: ${ans}`)
    // mensagens antigas continuam salvas
    assert(
      before.every((m) => m2.some((x) => x.id === m.id)),
      'histórico antigo preservado'
    )
    // Parar durante a compactação: cancela sem salvar fronteira
    const n0 = m2.length
    await clearEvents()
    await api('agent.compact', sc)
    await waitFor(
      async () => (await events()).find((e) => e.type === 'compaction' && e.state === 'running'),
      20_000,
      'compactação rodando'
    )
    await api('agent.stop', sc)
    await waitIdle(chat.id, sc)
    const m3 = await messages(sc)
    assert(
      m3.length === n0 && !m3.slice(n0).some((m) => m.meta.kind === 'compaction'),
      'nada salvo ao parar'
    )
    return `resumo ${b.message.content.length} chars; resposta: ${ans.slice(0, 60)}`
  })

  await test('compactação automática (janela pequena) + "tentar de novo"', async () => {
    const { chat, sid: sa } = await newChat({ enabledTools: [] })
    await api('agent.send', sa, 'My name is Ana. Reply only "ok".')
    await waitIdle(chat.id, sa)
    const u = (await messages(sa)).at(-1).meta.usage
    // janela minúscula + automático: o próximo turno compacta antes de chamar o modelo
    await api('chats.update', chat.id, {
      config: { contextWindow: Math.ceil(u.promptTokens * 1.05), autoCompact: true }
    })
    await api('agent.send', sa, 'What is my name? Answer with just the name.')
    await waitIdle(chat.id, sa)
    const msgs = await messages(sa)
    addCost(msgs)
    const bi = msgs.findIndex((m) => m.meta.kind === 'compaction')
    assert(bi > 0, 'fronteira automática criada')
    if (msgs[bi].meta.compactUsage?.cost) totalCost += msgs[bi].meta.compactUsage.cost
    assert(
      msgs.at(-1).message.role === 'assistant' && /ana/i.test(msgs.at(-1).message.content),
      `resposta ${msgs.at(-1).message.content}`
    )
    // retry: compacta de novo e roda o agente outra vez
    await api('chats.update', chat.id, { config: { autoCompact: false, contextWindow: null } })
    const n = msgs.length
    await api('agent.compact', sa, { retry: true })
    await waitIdle(chat.id, sa)
    const m2 = await messages(sa)
    addCost(m2.slice(n))
    assert(m2[n]?.meta.kind === 'compaction', 'nova fronteira')
    assert(
      m2.at(-1).message.role === 'assistant' && m2.length > n + 1,
      'agente rodou depois de compactar'
    )
    return `fronteira em ${bi}; ${m2.length} msgs`
  })

  await test('read_file: arquivo grande → aviso e leitura em partes', async () => {
    writeFileSync(
      join(CWD, 'big-e2e.txt'),
      Array.from({ length: 5000 }, (_, i) => `registro ${i + 1}`).join('\n') + '\n'
    )
    const { chat, sid: sr } = await newChat({ enabledTools: ['read_file'] })
    await api(
      'agent.send',
      sr,
      'Use the read_file tool on big-e2e.txt (without offset or limit). Then tell me how many lines the file has in total, as reported by the tool.'
    )
    await waitIdle(chat.id, sr)
    const msgs = await messages(sr)
    addCost(msgs)
    const t = toolMsgs(msgs, 'read_file')[0]
    assert(t, 'read_file chamado')
    assert(
      // sem offset/limit: "[arquivo grande: …]"; se o modelo passar limit mesmo assim: "[arquivo com 5.000 linhas … — mostrando …]"
      /^\[(arquivo grande: 5\.000 linhas, .* — mostrando linhas 1–[\d.]+|arquivo com 5\.000 linhas .* — mostrando linhas 1–[\d.]+)/.test(
        t.message.content
      ),
      `cabeçalho: ${t.message.content.slice(0, 200)}`
    )
    assert(t.message.content.length <= 30_000, `limite de saída: ${t.message.content.length}`)
    // (a resposta do modelo barato nem sempre lê o total corretamente: só registra)
    return `${t.message.content.slice(0, 120)} → modelo: ${(msgs.at(-1).message.content ?? '').slice(0, 80)}`
  })

  await test('search_files encontra trecho (caminho:linha)', async () => {
    mkdirSync(join(CWD, 'src'), { recursive: true })
    writeFileSync(join(CWD, 'src', 'alvo.ts'), 'export const a = 1\n\n// NEEDLE_E2E_91 está aqui\n')
    mkdirSync(join(CWD, 'node_modules', 'x'), { recursive: true })
    writeFileSync(join(CWD, 'node_modules', 'x', 'i.js'), 'NEEDLE_E2E_91')
    const { chat, sid: ss } = await newChat({
      enabledTools: ['search_files', 'find_files', 'read_file']
    })
    await api(
      'agent.send',
      ss,
      'Use the search_files tool to find the text NEEDLE_E2E_91 in this project. Reply with the file path and line number only.'
    )
    await waitIdle(chat.id, ss)
    const msgs = await messages(ss)
    addCost(msgs)
    const calls = toolMsgs(msgs, 'search_files')
    assert(calls.length, 'search_files chamado')
    // o modelo pode errar o glob na 1ª tentativa ("Nenhum resultado" — não é erro) e refazer
    assert(
      calls.every((m) => m.meta.toolStatus === 'ok'),
      'sem erro de tool'
    )
    const t = calls.find((m) => /alvo\.ts/.test(m.message.content)) ?? calls[0]
    assert(
      /src\/alvo\.ts:3:\/\/ NEEDLE_E2E_91/.test(t.message.content),
      `resultado: ${t.message.content}`
    )
    assert(!t.message.content.includes('node_modules'), 'node_modules ignorado')
    assert(/alvo\.ts/.test(msgs.at(-1).message.content ?? ''), 'resposta cita o arquivo')
    return t.message.content.split('\n').slice(0, 2).join(' | ')
  })

  await test('list_models filtra modelos do provedor (query + tools_only)', async () => {
    const { chat, sid: sl } = await newChat({ enabledTools: ['list_models', 'delegate_task'] })
    await api(
      'agent.send',
      sl,
      'Use the list_models tool with query "gpt-4.1" and tools_only true. Then reply with exactly one model id from the result, nothing else.'
    )
    await waitIdle(chat.id, sl)
    const msgs = await messages(sl)
    addCost(msgs)
    assertPairing(msgs)
    const calls = toolMsgs(msgs, 'list_models')
    assert(calls.length, 'list_models chamado')
    const t = calls.at(-1)
    assert(t.meta.toolStatus === 'ok', `status: ${t.meta.toolStatus} — ${t.message.content}`)
    const c = t.message.content as string
    assert(
      /^\[\d+ modelos de [\d.]+ no provedor OpenRouter; mostrando \d+\]/.test(c),
      `cabeçalho: ${c.slice(0, 200)}`
    )
    const lines = c
      .split('\n')
      .slice(1)
      .filter((l) => !l.startsWith('['))
    assert(lines.length >= 1, 'pelo menos um modelo')
    assert(
      lines.every((l) => /gpt-?4\.?1/i.test(l) && / · tools$/.test(l)),
      `linhas filtradas: ${lines.join(' | ')}`
    )
    if (model.includes('gpt-4.1'))
      assert(
        lines.some((l) => l.includes(`${model} (atual)`)),
        'modelo atual marcado'
      )
    const answer = (msgs.at(-1).message.content ?? '').trim()
    const ids = lines.map((l) => l.split(' ')[0])
    assert(
      ids.some((id) => answer.includes(id)),
      `resposta cita um id listado: ${answer.slice(0, 120)}`
    )
    const def = (await api('agent.previewRequest', sl)).body.tools.find(
      (x: any) => x.function.name === 'list_models'
    )
    assert(def && def.function.parameters.properties.tools_only, 'definição enviada')
    return `${lines.length} modelos (${ids.slice(0, 3).join(', ')}…) → modelo: ${answer.slice(0, 60)}`
  })

  await test('bash: cd persiste entre chamadas; confinação rejeita caminho fora da raiz', async () => {
    const { chat, sid: sb } = await newChat({
      enabledTools: ['bash', 'read_file'],
      autoApprove: ['bash']
    })
    await api(
      'agent.send',
      sb,
      'Make two SEPARATE bash tool calls, one per response: first run exactly `mkdir -p deep/dir && cd deep/dir`, then (after it finishes) run exactly `pwd`. Then reply with the pwd output only.'
    )
    await waitIdle(chat.id, sb)
    const msgs = await messages(sb)
    addCost(msgs)
    assertPairing(msgs)
    const bashes = toolMsgs(msgs, 'bash')
    assert(bashes.length >= 1, 'bash chamado')
    const last = bashes.at(-1)
    assert(last.meta.shellCwd === join(CWD, 'deep/dir'), `shellCwd ${last.meta.shellCwd}`)
    const pwdCall = msgs
      .flatMap((m) => (m.message.role === 'assistant' ? (m.message.tool_calls ?? []) : []))
      .find((tc: any) => /"pwd"|: ?"pwd/.test(tc.function.arguments))
    if (bashes.length >= 2 && pwdCall) {
      const res = bashes.find((m) => m.message.tool_call_id === pwdCall.id)
      assert(res.message.content.startsWith(join(CWD, 'deep/dir')), `pwd: ${res.message.content}`)
    }
    // confinação: read_file fora da raiz → erro devolvido ao modelo
    await api(
      'agent.send',
      sb,
      'Use the read_file tool to read the absolute path /etc/hostname, then tell me what happened.'
    )
    await waitIdle(chat.id, sb)
    const m2 = await messages(sb)
    addCost(m2.slice(msgs.length))
    const rf = toolMsgs(m2, 'read_file').at(-1)
    assert(rf && rf.meta.toolStatus === 'error', 'read_file com erro')
    assert(/fora do diretório raiz/.test(rf.message.content), `confinação: ${rf.message.content}`)
    return `bash calls=${bashes.length}; ${rf.message.content.slice(0, 80)}`
  })

  await test('fs.*', async () => {
    const list = await api<any[]>('fs.listDir', CWD)
    assert(list.length >= 3 && list.every((e) => e.path.startsWith(CWD)), 'listDir')
    mkdirSync(join(CWD, 'zdir'), { recursive: true })
    const l2 = await api<any[]>('fs.listDir', CWD)
    assert(l2[0].isDir, 'pastas primeiro')
    const f = await api('fs.readFile', join(CWD, 'input.txt'))
    assert(f.content.startsWith('hello') && !f.truncated && !f.binary, 'readFile')
    writeFileSync(join(CWD, 'bin.dat'), Buffer.from([1, 0, 2, 3]))
    assert((await api('fs.readFile', join(CWD, 'bin.dat'))).binary === true, 'binário')
    writeFileSync(join(CWD, 'big.txt'), 'x'.repeat(1_200_000))
    const big = await api('fs.readFile', join(CWD, 'big.txt'))
    assert(big.truncated && big.content.length === 1024 * 1024, 'limite 1MB')
    assert(typeof (await api('fs.homeDir')) === 'string', 'homeDir')
    const made = await api('fs.mkdir', join(CWD, 'nova-pasta'))
    assert(made === join(CWD, 'nova-pasta') && existsSync(made), 'fs.mkdir')
    let dupErr = ''
    try {
      await api('fs.mkdir', join(CWD, 'nova-pasta'))
    } catch (e) {
      dupErr = (e as Error).message
    }
    assert(/Já existe/.test(dupErr), `mkdir duplicado: ${dupErr}`)
    const caps = await api('app.capabilities')
    assert(typeof caps.bwrap === 'boolean' && typeof caps.ripgrep === 'boolean', 'capabilities')
  })

  // mensagens: update/delete emitem eventos
  await test('messages.update/delete', async () => {
    await clearEvents()
    const msgs = await messages(sid)
    const m = msgs.at(-1)
    const up = await api('messages.update', m.id, { ...m.message, content: 'editado' })
    assert(up.message.content === 'editado', 'update')
    await api('messages.delete', m.id)
    const ev = await events()
    assert(
      ev.some((e) => e.type === 'message-updated') &&
        ev.some((e) => e.type === 'message-deleted' && e.messageId === m.id),
      'eventos'
    )
    // chats.update com modelo novo atualiza a sessão principal
    await api('chats.update', chatId, { config: { model: 'openai/gpt-4o-mini' } })
    assert(
      (await session(sid, chatId)).model === 'openai/gpt-4o-mini',
      'modelo da sessão principal'
    )
    const child = (await api<any[]>('sessions.list', chatId)).find((s) => s.depth === 1)
    if (child)
      assert(
        child.model !== 'openai/gpt-4o-mini' || model === 'openai/gpt-4o-mini',
        'subsessão mantém modelo'
      )
  })

  await app.close()
  const failed = results.filter((r) => !r.ok)
  console.log(
    `\n${results.length - failed.length}/${results.length} passaram. Custo total (usage.cost): $${totalCost.toFixed(5)}`
  )
  writeFileSync(
    join(BASE, 'report.json'),
    JSON.stringify({ results, totalCost, ...report }, null, 2)
  )
  console.log(`Relatório: ${join(BASE, 'report.json')}`)
  process.exit(failed.length ? 1 : 0)
}

main().catch(async (e) => {
  console.error(e)
  try {
    await app?.close()
  } catch {
    /* */
  }
  process.exit(1)
})
