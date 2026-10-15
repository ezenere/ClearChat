/* eslint-disable @typescript-eslint/no-explicit-any */
// E2E do Smart-Approve na UI real (Playwright `_electron`), 100% determinístico: um provedor
// OpenAI-compatible FALSO servido pelo próprio teste em 127.0.0.1 faz o papel do agente
// (`fake/agent-1`: pede bash com o comando da mensagem e depois responde "FIM") E do juiz
// (`fake/judge-1`: respostas roteirizadas por passo). Nenhuma key real, nenhum custo.
//
// Uso:
//   unset ELECTRON_RUN_AS_NODE
//   npm run build
//   CLEARCHAT_E2E_DIR=/tmp/algum-dir node e2e/smart-approve.spec.ts [filtro]
//
// Cobre: seção Smart-Approve da aba Tools (habilitar só com modelo, rótulos com validação, tempo),
// juiz APPROVED → roda · REJECTED → resultado negado + "Executar mesmo assim" (liberação de uma vez)
// · ASK-USER → card de aprovação com o motivo · resposta malformada e timeout → card de aprovação,
// custo do juiz no rodapé, "Testar", popover do header (revogar uma / todas, desligar o Smart-Approve)
// e a seção no editor de personas. Screenshots em $CLEARCHAT_E2E_DIR/shots.
import {
  _electron as electron,
  type ElectronApplication,
  type Locator,
  type Page
} from 'playwright'
import { createWriteStream, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const FAKE_KEY = 'fake-key-smart-approve'
const AGENT = 'fake/agent-1'
const JUDGE = 'fake/judge-1'
const ROOT = resolve(import.meta.dirname, '..')
const BASE = resolve(process.env.CLEARCHAT_E2E_DIR || join(tmpdir(), 'clearchat-smart-e2e'))
const USER_DATA = join(BASE, 'userdata')
const CWD = join(BASE, 'cwd')
const SHOTS = join(BASE, 'shots')
const STOP_AFTER = process.argv[2] ?? ''

// ---------------- provedor falso ----------------

interface JudgeReply {
  text: string
  delayMs?: number
}
const judgeQueue: JudgeReply[] = []
const hits: { model: string; body: any }[] = []
let server: Server | null = null
let fakeBase = ''

async function readBody(req: IncomingMessage): Promise<string> {
  let data = ''
  for await (const c of req) data += c
  return data
}

const textOf = (c: any): string =>
  typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => p.text ?? '').join('') : ''

/** Comando pedido na última mensagem do usuário: "rode: <cmd>" ou "Pode executar bash `<cmd>`". */
function commandFrom(text: string): string | null {
  const m = /rode:\s*(.+)$/m.exec(text) ?? /Pode executar bash `([^`]+)`/.exec(text)
  return m ? m[1].trim() : null
}

async function startFake(): Promise<void> {
  server = createServer((req, res) => {
    void (async () => {
      const url = req.url ?? ''
      if (req.method === 'GET' && url.endsWith('/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            data: [AGENT, JUDGE].map((id) => ({
              id,
              name: id === AGENT ? 'Fake Agent' : 'Fake Judge',
              context_length: 64_000,
              pricing: { prompt: '0.0000001', completion: '0.0000002' },
              supported_parameters: ['tools']
            }))
          })
        )
        return
      }
      if (!(req.method === 'POST' && url.endsWith('/chat/completions'))) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end('{"error":{"message":"not found"}}')
        return
      }
      const body = JSON.parse((await readBody(req)) || '{}')
      hits.push({ model: body.model, body })
      const sse = (deltas: any[], usage: any): void => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
        const base = { id: 'f', object: 'chat.completion.chunk', model: body.model }
        for (const d of deltas)
          res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: d }] })}\n\n`)
        res.write(
          `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage })}\n\n`
        )
        res.end('data: [DONE]\n\n')
      }
      if (body.model === JUDGE) {
        const r = judgeQueue.shift() ?? { text: 'ASK-USER\n(sem roteiro)' }
        const send = (): void => {
          if (res.destroyed) return
          sse([{ role: 'assistant', content: r.text }], {
            prompt_tokens: 400,
            completion_tokens: 12,
            cost: 0.000042
          })
        }
        if (r.delayMs) setTimeout(send, r.delayMs)
        else send()
        return
      }
      // agente: usuário → chama bash com o comando; tool → "FIM: <resultado>"
      const msgs: any[] = body.messages ?? []
      const last = msgs[msgs.length - 1]
      if (last?.role === 'tool') {
        sse([{ role: 'assistant', content: `FIM: ${String(last.content).slice(0, 80)}` }], {
          prompt_tokens: 100,
          completion_tokens: 8
        })
        return
      }
      const cmd = commandFrom(textOf(last?.content))
      if (!cmd) {
        sse([{ role: 'assistant', content: 'Nada a fazer.' }], {
          prompt_tokens: 50,
          completion_tokens: 3
        })
        return
      }
      sse(
        [
          {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: `call_${Date.now().toString(36)}`,
                type: 'function',
                function: { name: 'bash', arguments: JSON.stringify({ command: cmd }) }
              }
            ]
          }
        ],
        { prompt_tokens: 100, completion_tokens: 10 }
      )
    })()
  })
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
  fakeBase = `http://127.0.0.1:${(server!.address() as AddressInfo).port}/v1`
}

// ---------------- infra ----------------

let app: ElectronApplication
let page: Page
let shotN = 0
let stopped = false
const results: { name: string; ok: boolean; info?: string; ms: number }[] = []

async function launch(): Promise<void> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  delete env.ELECTRON_RUN_AS_NODE
  delete env.OPENROUTER_API_KEY
  env.CLEARCHAT_USER_DATA = USER_DATA
  app = await electron.launch({ args: [ROOT], env, timeout: 60_000 })
  const log = createWriteStream(join(BASE, 'main.log'), { flags: 'a' })
  app.process().stdout?.pipe(log)
  app.process().stderr?.pipe(log)
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    win.setSize(1280, 860)
  })
  await app.evaluate(({ dialog }, dir) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [dir] })) as any
  }, CWD)
}

async function shot(name: string): Promise<void> {
  await page.screenshot({ path: join(SHOTS, `${String(++shotN).padStart(2, '0')}-${name}.png`) })
}

async function shotOf(loc: Locator, name: string): Promise<void> {
  await loc.screenshot({ path: join(SHOTS, `${String(++shotN).padStart(2, '0')}-${name}.png`) })
}

async function read<T = any>(path: string, ...args: unknown[]): Promise<T> {
  return page.evaluate(
    ([p, a]) => {
      const fn = (p as string).split('.').reduce((o: any, k) => o[k], (window as any).api)
      return fn(...(a as unknown[]))
    },
    [path, args] as const
  ) as Promise<T>
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`asserção falhou: ${msg}`)
}

async function step(name: string, fn: () => Promise<string | void>): Promise<void> {
  if (stopped) return
  const t0 = Date.now()
  try {
    const info = await fn()
    results.push({ name, ok: true, info: info || undefined, ms: Date.now() - t0 })
    console.log(`✔ ${name}${info ? ` — ${info}` : ''} (${Date.now() - t0}ms)`)
  } catch (e) {
    results.push({ name, ok: false, info: (e as Error).message, ms: Date.now() - t0 })
    console.log(`✖ ${name} — ${(e as Error).message.split('\n')[0]}`)
    try {
      await shot(`FAIL-${name.replace(/[^\w]+/g, '_')}`)
      for (let i = 0; i < 3; i++) await page.keyboard.press('Escape')
    } catch {
      /* */
    }
  }
  if (STOP_AFTER && name.includes(STOP_AFTER)) stopped = true
}

const composer = (): Locator =>
  page.locator('textarea[placeholder="Mensagem…"], textarea[placeholder="Enviar para a fila…"]')
const stopBtn = (): Locator => page.getByRole('button', { name: 'Parar', exact: true })
const bashCards = (): Locator =>
  page.locator('div.rounded-xl').filter({ has: page.locator('span:text-is("Terminal (bash)")') })
const section = (): Locator => page.locator('section[data-section="smart-approve"]')

async function sendMessage(text: string): Promise<void> {
  const c = composer()
  await c.click()
  await c.fill(text)
  await c.press('Enter')
}

async function waitIdle(ms = 30_000): Promise<void> {
  await sleep(300)
  await stopBtn().waitFor({ state: 'detached', timeout: ms })
}

async function chatState(): Promise<{ chat: any; msgs: any[] }> {
  const chat = (await read<any[]>('chats.list'))[0]
  const msgs = await read<any[]>('sessions.messages', chat.mainSessionId)
  return { chat, msgs }
}

/** Resultado (mensagem tool) da última chamada bash cujo comando é `cmd`. */
async function toolResultFor(cmd: string): Promise<any> {
  const { msgs } = await chatState()
  const call = msgs
    .filter((m) => m.message.role === 'assistant')
    .flatMap((m) => m.message.tool_calls ?? [])
    .filter((t: any) => JSON.parse(t.function.arguments).command === cmd)
    .at(-1)
  assert(call, `tool call de ${cmd}`)
  return msgs.find((m) => m.message.role === 'tool' && m.message.tool_call_id === call.id)
}

async function pickModel(combobox: Locator, id: string): Promise<void> {
  await combobox.click()
  await page.getByRole('textbox', { name: 'Buscar modelo' }).fill(id)
  const listbox = page.getByRole('listbox', { name: 'Modelos' })
  const opt = listbox.locator(`[role=option][data-model="${id}"]`)
  await opt.first().waitFor({ timeout: 15_000 })
  await opt.first().click()
  await listbox.waitFor({ state: 'detached', timeout: 5000 })
}

async function openToolsTab(): Promise<void> {
  const tab = page.getByTestId('right-panel').getByRole('tab', { name: 'Tools', exact: true })
  if (!(await tab.count())) await page.getByRole('button', { name: 'Abrir painel' }).click()
  await tab.click()
}

const judgeHits = (): { model: string; body: any }[] => hits.filter((h) => h.model === JUDGE)

// ---------------- passos ----------------

async function main(): Promise<void> {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(USER_DATA, { recursive: true })
  mkdirSync(CWD, { recursive: true })
  mkdirSync(SHOTS, { recursive: true })
  writeFileSync(join(CWD, 'readme.txt'), 'smart-approve e2e\n')
  await startFake()
  await launch()

  await step('onboarding com o provedor falso', async () => {
    await page.getByText('Bem-vindo ao ClearChat').waitFor({ timeout: 30_000 })
    await page.locator('input.field').nth(0).fill('Local')
    await page.locator('input.field').nth(1).fill(fakeBase)
    await page.locator('input[type="password"]').fill(FAKE_KEY)
    await page.getByRole('button', { name: 'Testar conexão' }).click()
    await page.getByText(/Conexão ok/).waitFor({ timeout: 15_000 })
    await page.getByRole('button', { name: 'Continuar' }).click()
    await page.getByRole('heading', { name: 'Novo chat' }).waitFor({ timeout: 15_000 })
  })

  await step('novo chat com o agente falso', async () => {
    await pickModel(page.getByRole('combobox').first(), AGENT)
    await page.getByRole('button', { name: /Alterar/ }).click()
    await page.getByRole('button', { name: 'Começar' }).click()
    await composer().waitFor({ timeout: 15_000 })
    const { chat } = await chatState()
    assert(chat.config.model === AGENT, `modelo ${chat.config.model}`)
    assert(chat.config.cwd === CWD, `cwd ${chat.config.cwd}`)
  })

  await step('aba Tools: Smart-Approve só habilita com modelo', async () => {
    await openToolsTab()
    const sec = section()
    await sec.scrollIntoViewIfNeeded()
    await sec
      .getByTestId('smart-approve-hint')
      .getByText('Escolha um modelo para habilitar')
      .waitFor()
    const sw = sec.getByRole('switch', { name: 'Habilitar Smart-Approve' })
    assert(await sw.isDisabled(), 'switch desabilitado sem modelo')
    await shotOf(sec, 'smart-section-sem-modelo')
    await pickModel(sec.getByTestId('smart-approve-model').getByRole('combobox'), JUDGE)
    await sec.getByTestId('model-picker-provider').getByText('Local').waitFor()
    assert(!(await sw.isDisabled()), 'switch habilitado com modelo')
    assert((await sw.getAttribute('aria-checked')) === 'false', 'ainda desligado')
    await sw.click()
    await sec.getByText('Ligado: o juiz decide antes de pedir sua confirmação.').waitFor()
    await sleep(700) // debounce da config
    const { chat } = await chatState()
    const sa = chat.config.smartApprove
    assert(
      sa?.enabled === true && sa.model === JUDGE && sa.providerId,
      `config ${JSON.stringify(sa)}`
    )
    // remover o modelo desliga; escolher de novo e religar
    await sec.getByRole('button', { name: 'Remover modelo do Smart-Approve' }).click()
    await sec.getByText('Escolha um modelo para habilitar').waitFor()
    assert(await sw.isDisabled(), 'sem modelo → desabilitado')
    await pickModel(sec.getByTestId('smart-approve-model').getByRole('combobox'), JUDGE)
    await sw.click()
    await sec.getByText('Ligado: o juiz decide antes de pedir sua confirmação.').waitFor()
  })

  await step('rótulos: validação (vazio, repetido) e edição; tempo máximo', async () => {
    const sec = section()
    const approve = sec.getByRole('textbox', { name: 'Rótulo Aprovar' })
    await approve.fill('')
    await sec
      .getByTestId('smart-label-error')
      .getByText(/obrigatórios/)
      .waitFor()
    await approve.fill('rejected')
    await sec
      .getByTestId('smart-label-error')
      .getByText(/diferentes/)
      .waitFor()
    await sleep(700)
    let sa = (await chatState()).chat.config.smartApprove
    assert(sa.labels.approve === 'APPROVED', `inválido não salva (${sa.labels.approve})`)
    await approve.fill('OK-GO')
    await sec.getByTestId('smart-label-error').waitFor({ state: 'detached' })
    await sleep(700)
    sa = (await chatState()).chat.config.smartApprove
    assert(sa.labels.approve === 'OK-GO', `salvo ${sa.labels.approve}`)
    await approve.fill('APPROVED')
    const timeout = sec.getByRole('spinbutton', { name: 'Tempo máximo do juiz (segundos)' })
    await timeout.fill('3')
    await sleep(700)
    sa = (await chatState()).chat.config.smartApprove
    assert(sa.labels.approve === 'APPROVED' && sa.timeoutS === 3, JSON.stringify(sa))
    await sec.getByRole('button', { name: /Prompt do juiz/ }).click()
    await sec.getByRole('textbox', { name: 'Template do Smart-Approve' }).waitFor()
    await sec.getByText('{{recent_context}}', { exact: true }).waitFor()
    await shotOf(sec, 'smart-section')
    await sec.getByRole('button', { name: /Prompt do juiz/ }).click()
  })

  await step('APPROVED → executa (linha verde, custo do juiz no rodapé)', async () => {
    judgeQueue.push({ text: '**APPROVED** — Só imprime um texto.' })
    const before = judgeHits().length
    await sendMessage('rode: echo SA-APPROVED')
    await waitIdle()
    const card = bashCards().last()
    await card.getByText('ok', { exact: true }).waitFor()
    const line = card.getByTestId('smart-approve-line')
    assert((await line.getAttribute('data-decision')) === 'approve', 'linha approve')
    await line.getByText('Aprovado pelo Smart-Approve').waitFor()
    await line.getByText('Só imprime um texto.').waitFor()
    await page.getByTestId('judge-usage').last().waitFor()
    const r = await toolResultFor('echo SA-APPROVED')
    assert(r.message.content.includes('SA-APPROVED'), 'saída do bash')
    assert(r.meta.smartApprove.decision === 'approve', 'meta')
    assert(r.meta.smartApprove.usage?.cost === 0.000042, 'custo')
    const jh = judgeHits()
    assert(jh.length === before + 1, 'uma chamada ao juiz')
    const jb = jh.at(-1)!.body
    assert(jb.temperature === 0 && jb.max_tokens === 300 && !jb.tools, 'body do juiz')
    assert(
      jb.messages[0].role === 'system' && jb.messages[0].content.includes('Smart-Approve'),
      'system'
    )
    assert(jb.messages[1].content.includes('"command": "echo SA-APPROVED"'), 'args no template')
    assert(jb.messages[1].content.includes('rode: echo SA-APPROVED'), 'última mensagem do usuário')
    // nada do juiz vai para o histórico do agente
    const agentLast = hits.filter((h) => h.model === AGENT).at(-1)!.body
    assert(!JSON.stringify(agentLast.messages).includes('Smart-Approve'), 'agente não vê o juiz')
    await card.scrollIntoViewIfNeeded()
    await shotOf(card, 'card-aprovado')
  })

  await step('REJECTED → resultado negado ao agente + linha vermelha', async () => {
    judgeQueue.push({ text: 'REJECTED\nApagaria arquivos fora da raiz.' })
    await sendMessage('rode: echo SA-REJECTED')
    await waitIdle()
    const card = bashCards().last()
    await card.getByText('negada', { exact: true }).waitFor()
    const line = card.getByTestId('smart-approve-line')
    assert((await line.getAttribute('data-decision')) === 'reject', 'linha reject')
    await line.getByText('Apagaria arquivos fora da raiz.').waitFor()
    const r = await toolResultFor('echo SA-REJECTED')
    assert(
      r.message.content ===
        'Rejeitado pelo Smart-Approve (fake/judge-1): Apagaria arquivos fora da raiz.',
      `conteúdo ${r.message.content}`
    )
    assert(r.meta.toolStatus === 'denied', 'denied')
    const agentLast = hits.filter((h) => h.model === AGENT).at(-1)!.body
    assert(
      agentLast.messages.at(-1).content.startsWith('Rejeitado pelo Smart-Approve'),
      'agente recebeu a rejeição'
    )
    await card.scrollIntoViewIfNeeded()
    await shotOf(card, 'card-rejeitado')
  })

  await step(
    'Executar mesmo assim → mensagem do usuário + chamada idêntica roda sem juiz',
    async () => {
      const before = judgeHits().length
      const card = bashCards().nth((await bashCards().count()) - 1)
      await card.getByRole('button', { name: 'Executar mesmo assim' }).click()
      await page.getByText('Pode executar bash `echo SA-REJECTED`; eu aprovo.').first().waitFor()
      await waitIdle()
      await card.getByTestId('smart-overridden').waitFor()
      const runCard = bashCards().last()
      await runCard.getByTestId('smart-override-run').waitFor()
      await runCard.getByText('ok', { exact: true }).waitFor()
      assert(judgeHits().length === before, 'sem nova chamada ao juiz')
      await runCard.scrollIntoViewIfNeeded()
      await shotOf(page.locator('main, [data-chat-drop]').first(), 'override-executado')
      const { msgs } = await chatState()
      const results = msgs.filter(
        (m) => m.message.role === 'tool' && m.message.content.includes('SA-REJECTED')
      )
      assert(
        results.some((m) => m.meta.smartOverride === true && m.meta.toolStatus === 'ok'),
        'rodou'
      )
      assert(
        msgs.some((m) => m.message.role === 'tool' && m.meta.smartApprove?.overridden === true),
        'rejeição marcada como liberada'
      )
      // a liberação é de uma vez só: a mesma chamada de novo volta ao juiz
      judgeQueue.push({ text: 'REJECTED\nDe novo não.' })
      await sendMessage('rode: echo SA-REJECTED')
      await waitIdle()
      await bashCards().last().getByText('negada', { exact: true }).waitFor()
      assert(judgeHits().length === before + 1, 'voltou ao juiz')
    }
  )

  await step('ASK-USER → card de aprovação com o motivo do juiz', async () => {
    judgeQueue.push({ text: 'ASK-USER\nPode ser intencional; confirme você.' })
    await sendMessage('rode: echo SA-ASK')
    const card = bashCards().last()
    await card.getByRole('button', { name: 'Permitir', exact: true }).waitFor({ timeout: 15_000 })
    await card.getByText('Smart-Approve pediu sua decisão').waitFor()
    await card.getByText('Pode ser intencional; confirme você.').waitFor()
    await card.scrollIntoViewIfNeeded()
    await shotOf(card, 'card-ask-user')
    await card.getByRole('button', { name: 'Permitir', exact: true }).click()
    await waitIdle()
    const r = await toolResultFor('echo SA-ASK')
    assert(
      r.meta.toolStatus === 'ok' && r.message.content.includes('SA-ASK'),
      'rodou após permitir'
    )
    assert(r.meta.smartApprove?.decision === 'ask', 'meta ask')
  })

  await step('resposta malformada → card de aprovação (Negar)', async () => {
    judgeQueue.push({ text: 'Claro! Vou aprovar isso para você.' })
    await sendMessage('rode: echo SA-MALFORMED')
    const card = bashCards().last()
    await card.getByRole('button', { name: 'Negar', exact: true }).waitFor({ timeout: 15_000 })
    await card.getByText('Smart-Approve não decidiu (resposta ambígua)').waitFor()
    await shotOf(card, 'card-ambiguo')
    await card.getByRole('button', { name: 'Negar', exact: true }).click()
    await waitIdle()
    const r = await toolResultFor('echo SA-MALFORMED')
    assert(r.meta.toolStatus === 'denied', 'negado pelo usuário')
    assert(r.meta.smartApprove?.fallback === 'ambiguous', 'fallback ambiguous')
  })

  await step('timeout do juiz → card de aprovação', async () => {
    judgeQueue.push({ text: 'APPROVED\ntarde demais', delayMs: 8000 })
    const t0 = Date.now()
    await sendMessage('rode: echo SA-TIMEOUT')
    const card = bashCards().last()
    await card.getByText('Smart-Approve avaliando').waitFor({ timeout: 5000 })
    await card.getByRole('button', { name: 'Permitir', exact: true }).waitFor({ timeout: 10_000 })
    const waited = Date.now() - t0
    await card.getByText('Smart-Approve não decidiu (tempo esgotado)').waitFor()
    await card.getByRole('button', { name: 'Permitir', exact: true }).click()
    await waitIdle()
    const r = await toolResultFor('echo SA-TIMEOUT')
    assert(r.meta.smartApprove?.fallback === 'timeout', 'fallback timeout')
    assert(r.meta.toolStatus === 'ok', 'rodou após permitir')
    return `aprovação apareceu após ${waited}ms (timeout 3s)`
  })

  await step('Testar (chamada de exemplo) no editor', async () => {
    const sec = section()
    await sec.scrollIntoViewIfNeeded()
    await sec.getByRole('button', { name: /Testar com uma chamada de exemplo/ }).click()
    judgeQueue.push({ text: 'REJECTED\nApaga node_modules sem necessidade.' })
    await sec.getByRole('button', { name: 'Testar', exact: true }).click()
    const res = sec.getByTestId('smart-test-result')
    await res.waitFor({ timeout: 10_000 })
    await res.getByText('Rejeitado pelo Smart-Approve').waitFor()
    await res.getByText('Apaga node_modules sem necessidade.').waitFor()
    const jb = judgeHits().at(-1)!.body
    assert(jb.messages[1].content.includes('rm -rf node_modules'), 'chamada de exemplo')
    await res.scrollIntoViewIfNeeded()
    await shotOf(page.getByTestId('right-panel'), 'smart-section-testar')
  })

  await step(
    'header: popover de auto-aprovação — revogar uma, revogar tudo, desligar Smart',
    async () => {
      const sec = page.getByTestId('right-panel')
      await sec.getByRole('switch', { name: 'Auto-aprovar tudo' }).click()
      const badge = page.getByTestId('auto-approve-badge')
      await badge.getByText('Auto-aprovação · Smart').waitFor({ timeout: 5000 })
      await page.getByRole('button', { name: 'Fechar painel' }).first().click()
      await badge.click()
      const pop = page.getByTestId('auto-approve-popover')
      await pop.waitFor()
      assert((await pop.getByTestId('auto-approve-item').count()) === 3, '3 tools')
      await pop.getByText('fake/judge-1'.split('/').pop()!).waitFor()
      await sleep(400) // animação de entrada
      await shot('header-popover')
      await pop.getByRole('button', { name: 'Revogar Terminal (bash)' }).click()
      await sleep(300)
      let cfg = (await chatState()).chat.config
      assert(
        !cfg.autoApprove.includes('bash') && cfg.autoApprove.length === 2,
        `revogou ${cfg.autoApprove}`
      )
      assert((await pop.getByTestId('auto-approve-item').count()) === 2, '2 tools')
      await pop.getByRole('button', { name: 'Revogar tudo' }).click()
      await sleep(300)
      cfg = (await chatState()).chat.config
      assert(cfg.autoApprove.length === 0, 'revogou tudo')
      await pop.getByText('Nenhuma tool roda sem confirmação.').waitFor()
      await badge.getByText('Smart-Approve').waitFor()
      await pop.getByRole('switch', { name: 'Smart-Approve' }).click()
      await sleep(300)
      cfg = (await chatState()).chat.config
      assert(
        cfg.smartApprove.enabled === false && cfg.smartApprove.model === JUDGE,
        'smart desligado'
      )
      await page.keyboard.press('Escape')
      await badge.waitFor({ state: 'detached', timeout: 3000 })
      // sem Smart-Approve: bash volta a pedir confirmação ao usuário, sem chamar o juiz
      const before = judgeHits().length
      await sendMessage('rode: echo SA-SEM-JUIZ')
      const card = bashCards().last()
      await card.getByRole('button', { name: 'Negar', exact: true }).waitFor({ timeout: 15_000 })
      assert((await card.getByTestId('smart-approve-line').count()) === 0, 'sem linha do juiz')
      await card.getByRole('button', { name: 'Negar', exact: true }).click()
      await waitIdle()
      assert(judgeHits().length === before, 'juiz não chamado')
    }
  )

  await step('personas: o editor de Tools mostra o Smart-Approve', async () => {
    await page.getByRole('button', { name: 'Configurações' }).first().click()
    const dlg = page.getByRole('dialog')
    await dlg.getByRole('button', { name: 'Personas', exact: true }).click()
    await dlg
      .getByRole('button', { name: /Editar/ })
      .first()
      .click()
    await dlg
      .getByRole('tab', { name: 'Tools' })
      .or(dlg.getByRole('button', { name: 'Tools', exact: true }))
      .first()
      .click()
    const s = dlg.locator('section[data-section="smart-approve"]')
    await s.scrollIntoViewIfNeeded()
    await s.getByText('Escolha um modelo para habilitar').waitFor()
    await page.keyboard.press('Escape')
  })

  const failed = results.filter((r) => !r.ok)
  writeFileSync(join(BASE, 'report.json'), JSON.stringify(results, null, 2))
  console.log(
    `\n${results.length - failed.length}/${results.length} passos ok · screenshots em ${SHOTS}`
  )
  await app.close().catch(() => {})
  server?.close()
  process.exit(failed.length ? 1 : 0)
}

main().catch(async (e) => {
  console.error(e)
  await app?.close().catch(() => {})
  server?.close()
  process.exit(1)
})
