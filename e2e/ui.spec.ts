/* eslint-disable @typescript-eslint/no-explicit-any */
// E2E da UI real (Playwright `_electron`): clica/digita na interface do app buildado — nada de
// atalhos via window.api para AGIR (window.api só é lido para conferir estado no banco).
//
// Uso:
//   unset ELECTRON_RUN_AS_NODE
//   npm run build
//   OPENROUTER_API_KEY=sk-or-... CLEARCHAT_E2E_DIR=/tmp/algum-dir node e2e/ui.spec.ts [filtro]
//
// - A key vem SOMENTE do ambiente (nunca grave em arquivo); é digitada no onboarding.
// - userData isolado (CLEARCHAT_USER_DATA) e cwd de rascunho dentro de CLEARCHAT_E2E_DIR
//   (apagado no início). Screenshots em $CLEARCHAT_E2E_DIR/shots, log do main em ui-main.log.
// - O diálogo nativo "Escolher pasta" é substituído no main (dialog.showOpenDialog) para devolver
//   a pasta de rascunho — o clique no botão continua sendo pela UI.
// - [filtro] opcional: os passos são dependentes; o filtro só serve para PARAR depois do passo
//   cujo nome contém o texto (ex.: `node e2e/ui.spec.ts delegate`).
import {
  _electron as electron,
  type ElectronApplication,
  type Locator,
  type Page
} from 'playwright'
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const KEY = process.env.OPENROUTER_API_KEY
if (!KEY) {
  console.error('Defina OPENROUTER_API_KEY no ambiente.')
  process.exit(2)
}
const ROOT = resolve(import.meta.dirname, '..')
const BASE = resolve(process.env.CLEARCHAT_E2E_DIR || join(tmpdir(), 'clearchat-ui-e2e'))
const USER_DATA = join(BASE, 'userdata')
const CWD = join(BASE, 'cwd')
const SHOTS = join(BASE, 'shots')
const STOP_AFTER = process.argv[2] ?? ''
const MODEL = process.env.E2E_MODEL || 'openai/gpt-4.1-nano'
const ALT_MODEL = process.env.E2E_ALT_MODEL || 'openai/gpt-4o-mini'

let app: ElectronApplication
let page: Page
let shotN = 0
let stopped = false
const results: { name: string; ok: boolean; info?: string; ms: number }[] = []

// ---------------- infra ----------------

async function launch(): Promise<void> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  delete env.ELECTRON_RUN_AS_NODE
  delete env.OPENROUTER_API_KEY // o app não lê a key do ambiente: ela é digitada no onboarding
  env.CLEARCHAT_USER_DATA = USER_DATA
  app = await electron.launch({ args: [ROOT], env, timeout: 60_000 })
  const log = createWriteStream(join(BASE, 'ui-main.log'), { flags: 'a' })
  app.process().stdout?.pipe(log)
  app.process().stderr?.pipe(log)
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await setSize(1280, 820)
  // diálogo nativo de pasta → devolve a pasta configurada em global.__pickDir
  await app.evaluate(({ dialog }, dir) => {
    ;(globalThis as any).__pickDir = dir
    dialog.showOpenDialog = (async () => ({
      canceled: false,
      filePaths: [(globalThis as any).__pickDir]
    })) as any
  }, CWD)
}

async function setSize(w: number, h: number): Promise<void> {
  await app.evaluate(
    ({ BrowserWindow }, [w, h]) => {
      const win =
        BrowserWindow.getAllWindows().find((x) => x.isVisible()) ?? BrowserWindow.getAllWindows()[0]
      win.setSize(w, h)
    },
    [w, h] as const
  )
  await page.waitForTimeout(250)
}

async function shot(name: string): Promise<string> {
  const file = join(SHOTS, `${String(++shotN).padStart(2, '0')}-${name}.png`)
  await page.screenshot({ path: file })
  return file
}

/** Lê estado via window.api (só leitura, para asserções). */
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
      // não deixa modais/popovers abertos contaminarem os próximos passos
      for (let i = 0; i < 3; i++) await page.keyboard.press('Escape')
    } catch {
      /* */
    }
  }
  if (STOP_AFTER && name.includes(STOP_AFTER)) stopped = true
}

// ---------------- helpers de UI ----------------

const composer = (): Locator =>
  page.locator('textarea[placeholder="Mensagem…"], textarea[placeholder="Enviar para a fila…"]')
const stopBtn = (): Locator => page.getByRole('button', { name: 'Parar', exact: true })

async function sendMessage(text: string): Promise<void> {
  const c = composer()
  await c.click()
  await c.fill(text)
  await c.press('Enter')
}

/** Espera a sessão visível ficar ociosa (sem botão Parar). */
async function waitIdle(ms = 120_000): Promise<void> {
  await sleep(400)
  await stopBtn().waitFor({ state: 'detached', timeout: ms })
}

async function waitRunning(ms = 30_000): Promise<void> {
  await stopBtn().waitFor({ state: 'visible', timeout: ms })
}

/** Pede um comando bash e espera ele estar executando (modelos baratos às vezes hesitam: reenvia). */
async function askLongBash(cmd: string): Promise<void> {
  const prompts = [
    `Run this exact bash command with the bash tool: ${cmd}`,
    `Call the bash tool right now with command "${cmd}". The file exists in the working directory. Do not ask questions, just call the tool.`,
    `bash tool, command: ${cmd} — call it immediately.`
  ]
  for (const p of prompts) {
    const before = await toolCards('Terminal (bash)').count()
    await sendMessage(p)
    const t0 = Date.now()
    while (Date.now() - t0 < 60_000) {
      const n = await toolCards('Terminal (bash)').count()
      if (n > before && (await toolCards('Terminal (bash)').last().getByText('executando').count()))
        return
      if (!(await stopBtn().count()) && Date.now() - t0 > 1500) break
      await sleep(200)
    }
    await waitIdle(30_000)
  }
  throw new Error(`o modelo não executou: ${cmd}`)
}

/** Cards de tool da sessão visível. */
const toolCards = (label: string): Locator =>
  page.locator('div.rounded-xl').filter({ has: page.locator(`span:text-is("${label}")`) })

async function pickModel(combobox: Locator, id: string): Promise<void> {
  await combobox.click()
  const search = page.getByPlaceholder('Buscar ou digitar o ID do modelo…')
  await search.fill(id)
  const exact = page.locator('button', { has: page.locator(`span.font-mono:text-is("${id}")`) })
  if (await exact.count()) await exact.first().click()
  else await search.press('Enter') // texto livre
}

async function currentState(): Promise<{ chat: any; sid: string; msgs: any[] }> {
  const chats = await read<any[]>('chats.list')
  const chat = chats.find((c) => c.title !== 'Erro')!
  const msgs = await read<any[]>('sessions.messages', chat.mainSessionId)
  return { chat, sid: chat.mainSessionId, msgs }
}

async function openPreview(): Promise<any> {
  await page.getByRole('button', { name: 'Ver request' }).click()
  const dlg = page.getByRole('dialog')
  await dlg.getByText('POST', { exact: true }).waitFor({ timeout: 10_000 })
  await sleep(200)
  // o JSON exibido no modal: headers e body
  const pres = dlg.locator('pre.hljs')
  const headers = JSON.parse(await pres.nth(0).innerText())
  const body = JSON.parse(await pres.nth(1).innerText())
  return { headers, body, dlg }
}

async function closeModal(): Promise<void> {
  await page.keyboard.press('Escape')
  await page.getByRole('dialog').waitFor({ state: 'detached', timeout: 5000 })
}

async function ensurePanel(tab: 'Config' | 'Arquivos'): Promise<void> {
  const tabBtn = page.getByRole('button', { name: tab, exact: true })
  if (!(await tabBtn.count())) await page.getByRole('button', { name: 'Abrir painel' }).click()
  await tabBtn.click()
}

async function tooltipText(trigger: Locator): Promise<string> {
  await trigger.hover()
  const tip = page.getByRole('tooltip')
  await tip.first().waitFor({ timeout: 5000 })
  const t = await tip.first().innerText()
  await page.keyboard.press('Escape')
  await page.mouse.move(640, 5)
  await tip
    .first()
    .waitFor({ state: 'detached', timeout: 3000 })
    .catch(() => {})
  return t
}

// ---------------- passos ----------------

async function main(): Promise<void> {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(USER_DATA, { recursive: true })
  mkdirSync(join(CWD, 'sub'), { recursive: true })
  mkdirSync(SHOTS, { recursive: true })
  writeFileSync(join(CWD, 'readme.txt'), 'arquivo de exemplo do e2e\n')
  writeFileSync(join(CWD, 'sub', 'inner.txt'), 'dentro da subpasta\n')
  writeFileSync(join(CWD, 'slow.sh'), 'sleep 40\necho slow-done\n')
  await launch()

  await step('onboarding (Testar → Continuar)', async () => {
    await page.getByText('Bem-vindo ao ClearChat').waitFor({ timeout: 30_000 })
    await shot('onboarding')
    await page.locator('input[type="password"]').fill(KEY)
    await page.getByRole('button', { name: 'Testar conexão' }).click()
    await page.getByText(/Conexão ok/).waitFor({ timeout: 30_000 })
    await shot('onboarding-ok')
    await page.getByRole('button', { name: 'Continuar' }).click()
    await page.getByRole('heading', { name: 'Novo chat' }).waitFor({ timeout: 15_000 })
    const providers = await read<any[]>('providers.list')
    assert(providers.length === 1 && providers[0].baseUrl.includes('openrouter'), 'provider salvo')
  })

  await step('novo chat (modelo, system prompt, diretório raiz) → Começar', async () => {
    await pickModel(page.getByRole('combobox'), MODEL)
    await page
      .getByRole('combobox')
      .getByText(MODEL)
      .first()
      .waitFor({ timeout: 5000 })
      .catch(() => {})
    const sp = page.getByPlaceholder('Instruções para o modelo (opcional)')
    await sp.fill(
      'Você é um assistente de testes. Seja muito conciso e use as ferramentas quando pedido.'
    )
    await page.getByRole('button', { name: /Alterar/ }).click()
    await page.getByText(CWD.split('/').pop()!, { exact: false }).first().waitFor({ timeout: 5000 })
    await shot('new-chat')
    await page.getByRole('button', { name: 'Começar' }).click()
    await composer().waitFor({ timeout: 15_000 })
    await page.getByText('Pronto para conversar').waitFor()
    await shot('empty-chat')
    const { chat } = await currentState()
    assert(chat.config.model === MODEL, `modelo ${chat.config.model}`)
    assert(chat.config.cwd === CWD, `cwd ${chat.config.cwd}`)
    assert(chat.config.systemPrompt.startsWith('Você é um assistente de testes'), 'system prompt')
  })

  await step('write_file + read_file', async () => {
    await sendMessage(
      'Use write_file to create notes.txt with exactly the content "alpha beta gamma". Then use read_file to read notes.txt. Then reply with the file content only.'
    )
    await waitRunning()
    await waitIdle()
    await toolCards('Escrever arquivo').first().waitFor({ timeout: 5000 })
    await toolCards('Ler arquivo').first().waitFor({ timeout: 5000 })
    assert(existsSync(join(CWD, 'notes.txt')), 'notes.txt criado')
    assert(readFileSync(join(CWD, 'notes.txt'), 'utf8').includes('alpha beta gamma'), 'conteúdo')
    await page.getByText('alpha beta gamma').last().waitFor()
    // título do chat = primeira mensagem
    const { chat } = await currentState()
    assert(chat.title.startsWith('Use write_file'), `título ${chat.title}`)
    // medidor de contexto: "Nk / Mk · P%" (janela do modelo via /models)
    const meter = page.getByTestId('context-meter')
    await meter.waitFor({ timeout: 10_000 })
    const mt = await meter.innerText()
    assert(/\d.*\/.*\d.*%/.test(mt), `medidor: ${mt}`)
    // card de tool mostra o tamanho aproximado do resultado
    await toolCards('Ler arquivo').first().getByTestId('tool-size').waitFor({ timeout: 5000 })
    await shot('write-read')
  })

  await step('bash → Permitir', async () => {
    await sendMessage('Run this exact bash command with the bash tool: echo hello-ui-allow')
    await page.getByRole('button', { name: 'Permitir' }).waitFor({ timeout: 60_000 })
    await page.getByText('Aguardando aprovação').first().waitFor()
    await shot('approval-card')
    await page.getByRole('button', { name: 'Permitir' }).click()
    await waitIdle()
    const card = toolCards('Terminal (bash)').last()
    await card.getByText('ok', { exact: true }).waitFor({ timeout: 5000 })
    await card.locator('div[role="button"]').click()
    await card
      .getByText(/hello-ui-allow/)
      .first()
      .waitFor({ timeout: 5000 })
    await shot('bash-allowed')
  })

  await step('bash → Negar', async () => {
    await sendMessage('Run this exact bash command with the bash tool: echo hello-ui-deny')
    await page.getByRole('button', { name: 'Negar' }).waitFor({ timeout: 60_000 })
    await page.getByRole('button', { name: 'Negar' }).click()
    await waitIdle()
    await toolCards('Terminal (bash)').last().getByText('negada').waitFor({ timeout: 5000 })
    const { msgs } = await currentState()
    assert(
      msgs.some((m) => m.meta.toolStatus === 'denied' && /negou/.test(m.message.content)),
      'tool denied salvo'
    )
  })

  await step('bash → Sempre neste chat', async () => {
    await sendMessage('Run this exact bash command with the bash tool: echo hello-ui-always')
    await page.getByRole('button', { name: 'Sempre neste chat' }).waitFor({ timeout: 60_000 })
    await page.getByRole('button', { name: 'Sempre neste chat' }).click()
    await waitIdle()
    await page.getByRole('button', { name: /Auto-aprovação/ }).waitFor({ timeout: 5000 })
    const { chat } = await currentState()
    assert(chat.config.autoApprove.includes('bash'), 'autoApprove bash')
    await shot('always')
  })

  await step('fila: mensagem durante execução vira chip e é injetada depois', async () => {
    await sendMessage('Run this exact bash command with the bash tool: sleep 6 && echo slept-ok')
    await toolCards('Terminal (bash)').last().getByText('executando').waitFor({ timeout: 60_000 })
    await sendMessage('Depois disso, responda apenas: FILA-OK')
    const chip = page.locator('p.line-clamp-2', { hasText: 'FILA-OK' })
    await chip.waitFor({ timeout: 5000 })
    await page.getByText('Na fila · enviadas no próximo passo do agente').waitFor()
    await shot('queued-chip')
    await waitIdle(90_000)
    await chip.waitFor({ state: 'detached', timeout: 5000 })
    await page.getByText('da fila').last().waitFor({ timeout: 5000 })
    const { msgs } = await currentState()
    const q = msgs.find((m) => m.meta.kind === 'queued')
    assert(q && /FILA-OK/.test(q.message.content), 'mensagem queued persistida')
    const qi = msgs.indexOf(q)
    const toolBefore = msgs
      .slice(0, qi)
      .reverse()
      .find((m) => m.message.role === 'tool')
    assert(
      /slept-ok/.test(toolBefore?.message.content ?? ''),
      'injetada depois do resultado da tool'
    )
    await shot('queued-injected')
  })

  await step('⚡ no chip interrompe e injeta já', async () => {
    await askLongBash('bash slow.sh')
    await sendMessage('Esqueça o comando. Responda apenas: FORCADO')
    await page.locator('p.line-clamp-2', { hasText: 'FORCADO' }).waitFor({ timeout: 5000 })
    const t0 = Date.now()
    await page.getByRole('button', { name: 'Enviar agora' }).click()
    await page.getByText('enviada agora (interrompeu o agente)').waitFor({ timeout: 10_000 })
    const took = Date.now() - t0
    await waitIdle()
    await toolCards('Terminal (bash)').last().getByText('interrompida').waitFor({ timeout: 5000 })
    const { msgs } = await currentState()
    assert(
      msgs.some((m) => m.meta.kind === 'forced'),
      'forced persistida'
    )
    assert(
      msgs.some((m) => m.meta.toolStatus === 'cancelled' && /Interrompido/.test(m.message.content)),
      'tool cancelada'
    )
    await shot('forced')
    return `injetada em ${took}ms`
  })

  await step('botão Parar', async () => {
    await askLongBash('bash slow.sh')
    const t0 = Date.now()
    await stopBtn().click()
    await waitIdle(15_000)
    await toolCards('Terminal (bash)').last().getByText('interrompida').waitFor({ timeout: 5000 })
    await page.getByPlaceholder('Mensagem…').waitFor()
    return `parou em ${Date.now() - t0}ms`
  })

  await step('delegate_task → subsessão (conversa direta) → volta', async () => {
    await sendMessage(
      'Use the delegate_task tool (title "listar arquivos") to ask a subagent to call list_dir on the working directory and report the file names. Then tell me the names.'
    )
    await waitIdle(180_000)
    const card = toolCards('Delegar a subagente').last()
    await card.getByRole('button', { name: 'Abrir subsessão' }).waitFor({ timeout: 5000 })
    // (i) do card de delegate descreve o que o subagente recebe
    const info = await tooltipText(
      card.getByRole('button', { name: 'O que é enviado para a API' }).first()
    )
    assert(
      /primeira mensagem/.test(info) && /system prompt de subagentes/.test(info),
      `(i) delegate: ${info}`
    )
    await shot('delegate-card')
    // abre pela troca de sessão
    await page.getByRole('button', { name: /\d+ sub/ }).click()
    await shot('session-switcher')
    await page.locator('button', { hasText: 'listar arquivos' }).last().click()
    await page.getByText('Conversando com o subagente').waitFor({ timeout: 5000 })
    // conversa direta com o subagente: composer próprio
    await page.locator('textarea[placeholder="Mensagem ao subagente…"]').waitFor({ timeout: 5000 })
    await page.getByText('readme.txt').first().waitFor({ timeout: 5000 })
    await page.getByText('Esta subsessão usa o modelo').waitFor({ timeout: 5000 })
    await sleep(500) // deixa as animações de entrada terminarem
    await shot('subsession')
    await page.getByRole('button', { name: 'Voltar à principal' }).click()
    await composer().waitFor({ timeout: 5000 })
  })

  await step('editar modelo/system prompt/params no meio do chat → Ver request', async () => {
    await ensurePanel('Config')
    const aside = page.locator('aside')
    await pickModel(aside.getByRole('combobox'), ALT_MODEL)
    const sp = aside.locator('textarea').first()
    await sp.click()
    await sp.press('End')
    await sp.pressSequentially(' [editado-e2e]')
    await aside.getByRole('switch', { name: 'Enviar temperature' }).click()
    const temp = aside.getByRole('spinbutton', { name: 'temperature', exact: true })
    await temp.fill('0.3')
    await shot('config-edited')
    const { body } = await openPreview()
    await shot('preview')
    assert(body.model === ALT_MODEL, `model ${body.model}`)
    assert(body.temperature === 0.3, `temperature ${body.temperature}`)
    const sys = body.messages[0].content[0].text as string
    assert(sys.includes('[editado-e2e]'), 'system editado no preview')
    await closeModal()
    // volta ao modelo barato e desliga temperature
    await pickModel(aside.getByRole('combobox'), MODEL)
    await aside.getByRole('switch', { name: 'Enviar temperature' }).click()
    const { body: b2 } = await openPreview()
    assert(b2.model === MODEL && b2.temperature === undefined, 'voltou')
    await closeModal()
  })

  await step('modo texto (tools nativas off + texto no prompt) roda tool', async () => {
    const aside = page.locator('aside')
    await aside.getByRole('switch', { name: 'Enviar tools nativas' }).click()
    await aside.getByRole('switch', { name: 'Texto das tools no system prompt' }).click()
    const { body } = await openPreview()
    assert(!('tools' in body), 'sem campo tools')
    assert(/<tool_call>/.test(body.messages[0].content[0].text), 'instruções <tool_call> no system')
    await closeModal()
    await sendMessage(
      'Use the list_dir tool now on "." by writing a <tool_call> block exactly as instructed. After you get the result, reply with the file names.'
    )
    await waitIdle()
    await page.getByText('Resultado de tool (texto)').last().waitFor({ timeout: 5000 })
    const { msgs } = await currentState()
    assert(
      msgs.some((m) => m.meta.synthetic && /<tool_result name="list_dir">/.test(m.message.content)),
      'tool_result em texto'
    )
    await shot('text-mode')
    await aside.getByRole('switch', { name: 'Enviar tools nativas' }).click()
    await aside.getByRole('switch', { name: 'Texto das tools no system prompt' }).click()
  })

  await step('assinatura do app none/cline nos headers do Ver request', async () => {
    const aside = page.locator('aside')
    const sel = aside.locator('section', { hasText: 'Assinatura do app' }).locator('button.field')
    await sel.click()
    await page
      .locator('button', { hasText: /^Nenhuma/ })
      .last()
      .click()
    let { headers } = await openPreview()
    assert(
      !('X-Title' in headers) && !('HTTP-Referer' in headers),
      `none: ${JSON.stringify(headers)}`
    )
    assert(/…/.test(headers.Authorization) && !headers.Authorization.includes(KEY), 'key mascarada')
    await closeModal()
    await sel.click()
    await page
      .locator('button', { hasText: /^Cline/ })
      .last()
      .click()
    ;({ headers } = await openPreview())
    assert(headers['X-Title'] === 'Cline', `cline: ${JSON.stringify(headers)}`)
    await shot('preview-cline')
    await closeModal()
  })

  await step('Arquivos: raiz, navegação + Usar como raiz + preview + nova pasta', async () => {
    await ensurePanel('Arquivos')
    const aside = page.getByTestId('right-panel')
    await aside.getByText('notes.txt').waitFor({ timeout: 5000 })
    // breadcrumb começa na raiz (confinado): nada acima dela
    const crumbs = await aside.locator('nav button').allInnerTexts()
    assert(
      crumbs.length === 1 && crumbs[0].trim() === 'cwd',
      `breadcrumb ${JSON.stringify(crumbs)}`
    )
    await aside.locator('button', { hasText: /^sub$/ }).click()
    await aside.getByText('inner.txt').waitFor({ timeout: 5000 })
    await aside.getByRole('button', { name: 'Usar como raiz' }).click()
    await sleep(800)
    let { chat } = await currentState()
    assert(chat.config.cwd === join(CWD, 'sub'), `cwd ${chat.config.cwd}`)
    await aside.getByText('inner.txt').click()
    await aside.getByText('dentro da subpasta').waitFor({ timeout: 5000 })
    await shot('files-preview')
    await aside.getByRole('button', { name: 'Voltar' }).click()
    // raiz = sub: o breadcrumb não sobe; volta com "Escolher pasta…" (diálogo → pasta do e2e)
    assert(
      (await aside.locator('nav button', { hasText: /^cwd$/ }).count()) === 0,
      'não sobe da raiz'
    )
    await aside.getByRole('button', { name: 'Escolher pasta…' }).click()
    await aside.getByText('notes.txt').waitFor({ timeout: 5000 })
    await sleep(800)
    ;({ chat } = await currentState())
    assert(chat.config.cwd === CWD, `cwd ${chat.config.cwd}`)
    // nova pasta dentro da pasta atual
    await aside.getByRole('button', { name: 'Nova pasta…' }).click()
    await aside.getByLabel('Nome da nova pasta').fill('criada-na-aba')
    await aside.getByLabel('Nome da nova pasta').press('Enter')
    await aside.getByText('Pasta vazia').waitFor({ timeout: 5000 })
    assert(existsSync(join(CWD, 'criada-na-aba')), 'pasta criada')
    await aside.locator('nav button').first().click()
    await aside.getByText('notes.txt').waitFor({ timeout: 5000 })
    await shot('files')
  })

  await step('configurações: editar provider', async () => {
    await page.getByRole('button', { name: 'Configurações' }).first().click()
    const dlg = page.getByRole('dialog')
    await dlg.getByRole('button', { name: 'Editar' }).first().click()
    const name = dlg.locator('input.field').first()
    await name.fill('OpenRouter E2E')
    await dlg.getByRole('button', { name: 'Salvar' }).click()
    await dlg.getByText('OpenRouter E2E').waitFor({ timeout: 5000 })
    await shot('settings')
    await closeModal()
    const ps = await read<any[]>('providers.list')
    assert(
      ps[0].name === 'OpenRouter E2E' && ps[0].apiKey === KEY,
      'provider editado, key preservada'
    )
  })

  await step('editar / apagar mensagem, regenerar', async () => {
    await ensurePanel('Config')
    // editar a primeira mensagem do usuário
    const firstUser = page.locator('div.group\\/msg').filter({ hasText: 'Use write_file' }).first()
    await firstUser.hover()
    await firstUser.getByRole('button', { name: 'Editar' }).click()
    // durante a edição o texto vira o valor do textarea do editor inline
    const ed = page.locator('div.group\\/msg textarea').first()
    await ed.fill('Mensagem editada pelo e2e')
    await page.getByRole('button', { name: 'Salvar', exact: true }).click()
    await page.getByText('Mensagem editada pelo e2e').waitFor({ timeout: 5000 })
    let { msgs } = await currentState()
    assert(
      msgs.some((m) => m.message.content === 'Mensagem editada pelo e2e'),
      'edição salva'
    )
    // apagar a mensagem "da fila"
    const queued = page.locator('div.group\\/msg').filter({ hasText: 'FILA-OK' }).first()
    await queued.hover()
    await queued.getByRole('button', { name: 'Apagar mensagem' }).click()
    await queued.getByRole('button', { name: 'Apagar?' }).click()
    await sleep(500)
    ;({ msgs } = await currentState())
    assert(!msgs.some((m) => m.meta.kind === 'queued'), 'mensagem apagada')
    // regenerar a última resposta
    await sendMessage('Responda apenas: REGEN-BASE')
    await waitIdle()
    const before = (await currentState()).msgs.at(-1)
    const last = page.locator('div.group\\/msg').last()
    await last.hover()
    await last.getByRole('button', { name: 'Regenerar resposta' }).click()
    await sleep(500)
    await waitIdle()
    const after = (await currentState()).msgs.at(-1)
    assert(after.id !== before.id && after.message.role === 'assistant', 'regenerado')
    await shot('regenerated')
  })

  await step(
    'contexto: banner (janela pequena) → Compactar → divisor + resumo → Ver request',
    async () => {
      await ensurePanel('Config')
      const aside = page.locator('aside')
      await page.getByTestId('context-meter').click() // rola até a seção Contexto
      await aside.getByRole('switch', { name: 'Definir janela manualmente' }).click()
      const win = aside.getByRole('spinbutton', { name: 'Janela de contexto (tokens)' })
      await win.fill('1000')
      const banner = page.getByTestId('compact-banner')
      await banner.waitFor({ timeout: 10_000 })
      const bt = await banner.innerText()
      assert(/Contexto em \d+%/.test(bt), `banner: ${bt}`)
      await shot('context-banner')
      const before = (await currentState()).msgs.length
      await banner.getByRole('button', { name: 'Compactar conversa' }).click()
      await page.getByTestId('compaction-card').first().waitFor({ timeout: 90_000 })
      await waitIdle(60_000)
      await page.getByTestId('compaction-divider').waitFor({ timeout: 5000 })
      const div = await page.getByTestId('compaction-divider').innerText()
      assert(
        /Conversa compactada/.test(div) && /não são mais enviadas à API/.test(div),
        `divisor: ${div}`
      )
      const { msgs } = await currentState()
      assert(
        msgs.length === before + 1 && msgs.at(-1).meta.kind === 'compaction',
        'fronteira salva'
      )
      // (i) do resumo
      const card = page.getByTestId('compaction-card').last()
      const info = await tooltipText(
        card.getByRole('button', { name: 'O que é enviado para a API' })
      )
      assert(/role: "user"/.test(info) && /início do histórico/.test(info), `(i) resumo: ${info}`)
      assert((await banner.count()) === 0, 'banner some após compactar')
      const mt = await page.getByTestId('context-meter').innerText()
      assert(mt.trim().startsWith('~'), `medidor estimado: ${mt}`)
      await shot('compacted')
      // Ver request: system + resumo apenas
      const { body } = await openPreview()
      assert(body.messages.length === 2, `request com ${body.messages.length} mensagens`)
      const t = body.messages[1].content
      const txt = Array.isArray(t) ? t.map((p: any) => p.text).join('') : t
      assert(txt.startsWith('<conversation_summary>'), 'resumo é a 1ª mensagem do histórico')
      await shot('preview-compacted')
      await closeModal()
      // recolher/expandir a parte antiga
      await page.getByTestId('compaction-divider').getByRole('button', { name: 'Ocultar' }).click()
      assert((await page.getByTestId('compacted-old').count()) === 0, 'parte antiga recolhida')
      await page.getByTestId('compaction-divider').getByRole('button', { name: 'Mostrar' }).click()
      await page.getByTestId('compacted-old').waitFor({ timeout: 3000 })
      await aside.getByRole('switch', { name: 'Definir janela manualmente' }).click()
      // conversa continua depois da compactação
      await sendMessage('Responda apenas: POS-COMPACTACAO')
      await waitIdle()
      await page.getByText('POS-COMPACTACAO').last().waitFor({ timeout: 5000 })
    }
  )

  await step('erro HTTP persistido ((i) "não é enviado à API")', async () => {
    const aside = page.locator('aside')
    await pickModel(aside.getByRole('combobox'), 'invalid-vendor/modelo-que-nao-existe')
    await sendMessage('isto deve falhar')
    await waitIdle(30_000)
    const err = page.locator('div.group\\/msg', { has: page.locator('.text-danger') }).last()
    await err.waitFor({ timeout: 10_000 })
    await err.hover()
    const info = await tooltipText(err.getByRole('button', { name: 'O que é enviado para a API' }))
    assert(/Não é enviado à API/.test(info), `(i) do erro: ${info}`)
    const { msgs } = await currentState()
    assert(msgs.at(-1).meta.kind === 'error', 'erro persistido')
    const { body } = await openPreview()
    assert(!JSON.stringify(body.messages).includes(msgs.at(-1).meta.error), 'erro fora da request')
    await closeModal()
    await shot('error-persisted')
    await pickModel(aside.getByRole('combobox'), MODEL)
    await sleep(600)
  })

  await step('reinício: chats e mensagens persistem', async () => {
    const before = await currentState()
    await app.close()
    await launch()
    await page.locator('aside, nav').first().waitFor({ timeout: 30_000 })
    await page.getByText(before.chat.title).first().click()
    await page.getByText('Mensagem editada pelo e2e').waitFor({ timeout: 10_000 })
    await page.locator('.text-danger').first().waitFor({ timeout: 5000 }) // erro persistido
    const after = await currentState()
    assert(
      after.msgs.length === before.msgs.length,
      `msgs ${before.msgs.length} → ${after.msgs.length}`
    )
    await shot('after-restart')
  })

  await step('Novo chat → Nova pasta… vira o diretório raiz', async () => {
    await page.getByRole('button', { name: 'Novo chat' }).first().click()
    await page.getByRole('heading', { name: 'Novo chat' }).waitFor({ timeout: 10_000 })
    await page.getByRole('button', { name: /Alterar/ }).click() // diálogo → pasta do e2e
    await page.getByTestId('new-chat-root').getByText('cwd').waitFor({ timeout: 5000 })
    await page.getByRole('button', { name: 'Nova pasta…' }).click()
    await page.getByLabel('Nome da nova pasta').fill('projeto-ui')
    await shot('new-folder')
    await page.getByRole('button', { name: 'Criar', exact: true }).click()
    await page
      .getByTestId('new-chat-root')
      .getByText(/projeto-ui/)
      .waitFor({ timeout: 5000 })
    assert(existsSync(join(CWD, 'projeto-ui')), 'pasta criada no disco')
    await pickModel(page.getByRole('combobox'), MODEL)
    await page.getByRole('button', { name: 'Começar' }).click()
    await composer().waitFor({ timeout: 10_000 })
    const chats = await read<any[]>('chats.list')
    assert(
      chats.some((c) => c.config.cwd === join(CWD, 'projeto-ui')),
      'chat com raiz na pasta nova'
    )
    await ensurePanel('Arquivos')
    await page
      .getByTestId('right-panel')
      .locator('nav button')
      .first()
      .getByText('projeto-ui')
      .waitFor({ timeout: 5000 })
    await shot('new-folder-chat')
  })

  await step('indicador global de aprovação pendente (subagente pede bash)', async () => {
    await page.getByRole('button', { name: 'Novo chat' }).first().click()
    await pickModel(page.getByRole('combobox'), MODEL)
    await page.getByRole('button', { name: 'Começar' }).click()
    await composer().waitFor({ timeout: 10_000 })
    await sendMessage(
      'Use the delegate_task tool to ask a subagent to run the bash command "echo sub-approval-ok" with its bash tool and report the output. Then tell me the output.'
    )
    const indicator = page.getByRole('button', { name: /Aprovação pendente/ })
    await indicator.waitFor({ timeout: 90_000 })
    await shot('global-approval-indicator')
    // o card de delegate na principal também mostra a aprovação do subagente
    await toolCards('Delegar a subagente')
      .first()
      .getByText('Permitir que o subagente execute')
      .waitFor({ timeout: 5000 })
    await indicator.click()
    await page.getByText('Conversando com o subagente').waitFor({ timeout: 5000 })
    await shot('subagent-approval')
    await page.getByRole('button', { name: 'Permitir' }).click()
    await page.getByRole('button', { name: 'Voltar à principal' }).click()
    await composer().waitFor({ timeout: 5000 })
    // o modelo pode delegar mais de uma vez: aprova pelo card da principal
    const t0 = Date.now()
    while ((await stopBtn().count()) && Date.now() - t0 < 120_000) {
      const allow = page.getByRole('button', { name: 'Permitir' })
      if (await allow.count()) await allow.first().click()
      await sleep(500)
    }
    await waitIdle(10_000)
    await page
      .getByText(/sub-approval-ok/)
      .last()
      .waitFor({ timeout: 10_000 })
    assert((await indicator.count()) === 0, 'indicador some')
    await shot('subagent-approved')
    // regenerar apaga a subsessão órfã (evento session-deleted → some do seletor)
    const chats = await read<any[]>('chats.list')
    const c2 = chats.find((c) => c.title.startsWith('Use the delegate_task tool to ask'))
    const oldSubs = (await read<any[]>('sessions.list', c2.id)).filter((x) => x.depth > 0)
    assert(oldSubs.length >= 1, 'subsessão existe')
    const last = page.locator('div.group\\/msg').last()
    await last.hover()
    await last.getByRole('button', { name: 'Regenerar resposta' }).click()
    const t1 = Date.now()
    await sleep(800)
    while ((await stopBtn().count()) && Date.now() - t1 < 120_000) {
      const allow = page.getByRole('button', { name: 'Permitir' })
      if (await allow.count()) await allow.first().click()
      await sleep(500)
    }
    await waitIdle(10_000)
    const now = await read<any[]>('sessions.list', c2.id)
    for (const o of oldSubs) assert(!now.some((x) => x.id === o.id), 'subsessão antiga apagada')
    await shot('regenerated-delegate')
    return `subsessões antigas apagadas: ${oldSubs.length}`
  })

  await step('layout 900x600 (painel recolhe)', async () => {
    await setSize(900, 600)
    await shot('min-size')
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth
    )
    assert(!overflow, 'sem scroll horizontal')
    const comp = await composer().boundingBox()
    assert(comp && comp.width >= 300, `composer largo o bastante: ${comp?.width}`)
    assert(
      (await page.getByRole('button', { name: 'Config', exact: true }).count()) === 0,
      'painel recolhido'
    )
    // reabre como gaveta sobreposta; clicar fora fecha
    await page.getByRole('button', { name: 'Abrir painel' }).click()
    await page.getByRole('button', { name: 'Config', exact: true }).waitFor()
    await sleep(300)
    await shot('min-size-drawer')
    await page.mouse.click(300, 300)
    await page
      .getByRole('button', { name: 'Config', exact: true })
      .waitFor({ state: 'detached', timeout: 3000 })
    await setSize(1280, 820)
  })

  await app.close()
  const failed = results.filter((r) => !r.ok)
  console.log(
    `\n${results.length - failed.length}/${results.length} passaram. Screenshots: ${SHOTS}`
  )
  writeFileSync(join(BASE, 'ui-report.json'), JSON.stringify({ results }, null, 2))
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
