/* eslint-disable @typescript-eslint/no-explicit-any */
// E2E do ditado por voz (Feature A) na UI real (Playwright `_electron`), determinístico e sem
// rede externa: microfone FALSO do Chromium (`--use-fake-device-for-media-capture
// --use-fake-ui-for-media-capture` — gera áudio sintético sem hardware) + servidor FALSO de STT
// (`e2e/fakes/sttServer.ts`) respondendo `/audio/transcriptions` com transcrição fixa (o
// `sttSettings` é apontado para ele). userData isolado (`CLEARCHAT_USER_DATA`); nenhuma chave real.
//
// Uso:
//   unset ELECTRON_RUN_AS_NODE
//   npm run build
//   CLEARCHAT_E2E_DIR=/tmp/algum-dir node e2e/voice-dictation.spec.ts
//   (ou: npm run test:e2e:voice)
//
// Cobre: botão de microfone no composer (clique inicia/para), chevron com menu de microfone
// (Padrão do sistema + dispositivos do fake device), gravação com áudio do fake device → parciais
// (`▌` no rascunho) → Parar gravação → texto final no rascunho editável (envio SEMPRE manual — a
// mensagem não sai sozinha), Esc cancela descartando e o request multipart chega ao servidor falso
// (file/model/language/response_format + Authorization da chave salva).
import {
  _electron as electron,
  type ElectronApplication,
  type Locator,
  type Page
} from 'playwright'
import { createWriteStream, mkdirSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { startFakeSttServer, type FakeSttServer } from './fakes/sttServer.ts'

const AGENT = 'fake/agent-1'
const ROOT = resolve(import.meta.dirname, '..')
const BASE = resolve(process.env.CLEARCHAT_E2E_DIR || join(tmpdir(), 'clearchat-voice-e2e'))
const USER_DATA = join(BASE, 'userdata')
const CWD = join(BASE, 'cwd')
const SHOTS = join(BASE, 'shots')
const STT_KEY = 'e2e-stt-fake-key-01'
const STT_TEXT = 'ISTO É UM DITADO DE TESTE'

// ---------------- servidor falso do LLM (só para o onboarding) ----------------

let llm: Server | null = null
let llmBase = ''

async function readBody(req: IncomingMessage): Promise<string> {
  let data = ''
  for await (const c of req) data += c
  return data
}

async function startLlm(): Promise<void> {
  llm = createServer((req, res) => {
    void (async () => {
      const url = req.url ?? ''
      if (req.method === 'GET' && url.endsWith('/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            data: [
              {
                id: AGENT,
                name: 'Fake Agent',
                context_length: 64_000,
                supported_parameters: ['tools']
              }
            ]
          })
        )
        return
      }
      await readBody(req)
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(
        `data: ${JSON.stringify({ id: 'f', object: 'chat.completion.chunk', model: AGENT, choices: [{ index: 0, delta: { role: 'assistant', content: 'OK.' } }] })}\n\n`
      )
      res.write(
        `data: ${JSON.stringify({ id: 'f', object: 'chat.completion.chunk', model: AGENT, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`
      )
      res.end('data: [DONE]\n\n')
    })()
  })
  await new Promise<void>((r) => llm!.listen(0, '127.0.0.1', r))
  llmBase = `http://127.0.0.1:${(llm!.address() as AddressInfo).port}/v1`
}

// ---------------- infra ----------------

let app: ElectronApplication
let page: Page
let stt: FakeSttServer | null = null
let shotN = 0
const results: { name: string; ok: boolean; info?: string }[] = []

async function shot(name: string): Promise<void> {
  await page.waitForTimeout(200)
  await page.screenshot({ path: join(SHOTS, `${String(++shotN).padStart(2, '0')}-${name}.png`) })
}
async function call<T = any>(path: string, ...args: unknown[]): Promise<T> {
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
  try {
    const info = await fn()
    results.push({ name, ok: true, info: info || undefined })
    console.log(`✔ ${name}${info ? ` — ${info}` : ''}`)
  } catch (e) {
    results.push({ name, ok: false, info: (e as Error).message })
    console.log(`✖ ${name} — ${(e as Error).message.split('\n')[0]}`)
    await shot(`FAIL-${name.replace(/[^\w]+/g, '_')}`).catch(() => {})
  }
}
async function waitFor<T>(
  fn: () => Promise<T | null | undefined | false>,
  ms: number,
  what: string
): Promise<T> {
  const t0 = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}`)
    await sleep(150)
  }
}
const composer = (): Locator => page.locator('[data-testid="composer-column"] textarea')
const dialog = (): Locator => page.locator('[role="dialog"]')
const composerValue = (): Promise<string> => composer().inputValue()
const micButton = (): Locator => page.getByTestId('voice-mic-button')
const stopButton = (): Locator => page.getByTestId('voice-stop-button')
const waveform = (): Locator => page.getByTestId('voice-waveform')

async function main(): Promise<void> {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(USER_DATA, { recursive: true })
  mkdirSync(CWD, { recursive: true })
  mkdirSync(SHOTS, { recursive: true })
  await startLlm()
  stt = await startFakeSttServer({ text: STT_TEXT, requireKey: STT_KEY })
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  delete env.ELECTRON_RUN_AS_NODE
  env.CLEARCHAT_USER_DATA = USER_DATA
  app = await electron.launch({
    args: [
      // microfone falso do Chromium: áudio sintético + permissão concedida sem diálogo
      '--use-fake-device-for-media-capture',
      '--use-fake-ui-for-media-capture',
      ROOT
    ],
    env,
    timeout: 60_000
  })
  const log = createWriteStream(join(BASE, 'main.log'), { flags: 'a' })
  app.process().stdout?.pipe(log)
  app.process().stderr?.pipe(log)
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 900))
  await app.evaluate(({ dialog }, dir) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [dir] })) as any
  }, CWD)
  const userData = await app.evaluate(({ app }) => app.getPath('userData'))

  await step('userData isolado + onboarding + novo chat', async () => {
    assert(userData === USER_DATA, `userData ${userData}`)
    await page.getByText('Bem-vindo ao ClearChat').waitFor({ timeout: 30_000 })
    await page.getByTestId('onboarding-provider').click()
    await page.locator('input.field').nth(0).fill('Local')
    await page.locator('input.field').nth(1).fill(llmBase)
    await page.locator('input[type="password"]').fill('fake-key')
    await page.getByRole('button', { name: 'Testar conexão' }).click()
    await page.getByText(/Conexão ok/).waitFor({ timeout: 15_000 })
    await page.getByRole('button', { name: 'Continuar' }).click()
    await page.getByRole('heading', { name: 'Novo chat' }).waitFor({ timeout: 15_000 })
    await page.getByRole('combobox').first().click()
    await page.getByRole('textbox', { name: 'Buscar modelo' }).fill(AGENT)
    await page.locator(`[role=option][data-model="${AGENT}"]`).first().click()
    await page.getByRole('button', { name: /Alterar/ }).click()
    await page.getByRole('button', { name: 'Começar' }).click()
    await composer().waitFor({ timeout: 15_000 })
  })

  await step(
    'Configurações → Áudio: STT para o servidor falso, tecla do PTT e silêncio 0 (sem limite)',
    async () => {
      await page.getByRole('button', { name: /^Configurações/ }).click()
      await page.getByRole('button', { name: 'Áudio', exact: true }).click()
      await page.getByTestId('audio-settings').waitFor()
      // STT: endpoint do servidor falso (commit no blur de cada campo)
      await page.getByTestId('stt-base-url').fill(stt!.url)
      await page.getByTestId('stt-base-url').press('Tab')
      await page.getByTestId('stt-model').fill('whisper-large-v3-turbo')
      await page.getByTestId('stt-model').press('Tab')
      await page.getByTestId('stt-api-key').fill(STT_KEY)
      await page.getByTestId('stt-api-key').press('Tab')
      // a chave sai MASCARADA do main e volta ecoada no campo (nunca em claro)
      const keyField = page.getByTestId('stt-api-key')
      await waitFor(
        async () => !(await keyField.inputValue()).includes(STT_KEY),
        5000,
        'máscara no campo'
      )
      const masked = await keyField.inputValue()
      assert(masked.includes('…') && masked.endsWith(STT_KEY.slice(-4)), `máscara: ${masked}`)
      // tecla do push-to-talk: captura a próxima tecla e mostra a atual
      await page.getByTestId('ptt-key-capture').click()
      await page.keyboard.press('F8')
      await waitFor(
        async () => (await page.getByTestId('ptt-key-capture').innerText()) === 'Alterar tecla',
        5000,
        'tecla capturada'
      )
      const view0 = await call<any>('voice.settings.get')
      assert(view0.audioInput.pttKey === 'F8', `pttKey ${view0.audioInput.pttKey}`)
      // auto-stop por silêncio: 0 = sem limite (o fake device tem pausas de silêncio)
      await page.getByTestId('silence-stop-ms').fill('0')
      await page.getByTestId('silence-stop-ms').press('Tab')
      await shot('config-audio')
      // fecha (Esc) — o composer recarrega as settings — e confere o que o main salvou
      await page.keyboard.press('Escape')
      await dialog().waitFor({ state: 'detached' })
      const view = await call<any>('voice.settings.get')
      assert(view.sttSettings.api.apiKey === masked, 'máscara estável no get')
      assert(!JSON.stringify(view).includes(STT_KEY), 'chave em claro no get')
      assert(view.audioInput.silenceStopMs === 0, `silenceStopMs ${view.audioInput.silenceStopMs}`)
      return `máscara ${masked} · baseUrl ${stt!.url}`
    }
  )

  await step('menu de microfone: Padrão do sistema + dispositivos do fake device', async () => {
    await page.getByTestId('voice-mic-menu-button').click()
    await page.getByTestId('voice-mic-menu').waitFor()
    await page.getByTestId('voice-mic-option-system').waitFor()
    // a lista carrega assíncrona (enumeração + liberação de labels)
    await waitFor(
      async () => (await page.getByTestId('voice-mic-option-device').count()) >= 1,
      8000,
      'microfone listado'
    )
    const n = await page.getByTestId('voice-mic-option-device').count()
    assert(n >= 1, `nenhum microfone listado (${n})`)
    await page.getByTestId('voice-mic-option-system').click()
    await page.getByTestId('voice-mic-menu').waitFor({ state: 'detached' })
    const ai = await call<any>('voice.settings.get')
    assert(ai.audioInput.deviceId === null, `deviceId ${ai.audioInput.deviceId}`)
    return `${n} microfone(s)`
  })

  await step(
    'clicar mic → grava (fake device) → parciais no rascunho → parar → texto final',
    async () => {
      await micButton().click()
      // estado real "gravando" (depois do start assíncrono da captura)
      await page.locator('[data-testid="voice-mic-button"][aria-pressed="true"]').waitFor({
        timeout: 15_000
      })
      await waveform().waitFor({ timeout: 10_000 })
      await stopButton().waitFor({ timeout: 10_000 })
      // o botão de enviar vira "Parar gravação"
      assert(
        (await page.getByRole('button', { name: 'Enviar' }).count()) === 0,
        'envio ainda visível'
      )
      // parcial ao vivo aparece no rascunho com o cursor ▌
      await waitFor(
        async () => (await composerValue()).includes('▌'),
        20_000,
        'parcial no rascunho'
      )
      await shot('gravando')
      const partial = await composerValue()
      assert(partial.includes(STT_TEXT.slice(0, 8)), `parcial inesperada: ${partial}`)
      const chat = (await call<any[]>('chats.list'))[0]
      const before = (await call<any[]>('sessions.messages', chat.mainSessionId)).length
      await stopButton().click()
      // texto final vira rascunho normal (sem ▌)
      await waitFor(
        async () => (await composerValue()) === STT_TEXT,
        20_000,
        'texto final no rascunho'
      )
      // envio é SEMPRE manual: nada saiu sozinho
      const after = (await call<any[]>('sessions.messages', chat.mainSessionId)).length
      assert(after === before, `mensagem saiu sozinha (${before} → ${after})`)
      await shot('rascunho-final')
      return `parcial "${partial}" → final "${STT_TEXT}"`
    }
  )

  await step(
    'request multipart chega ao servidor falso (file/model/language + Bearer)',
    async () => {
      const posts = stt!.hits.filter((h) => h.path.endsWith('/audio/transcriptions'))
      assert(posts.length >= 2, `requests: ${posts.length} (parciais + final)`)
      const last = posts[posts.length - 1]
      assert(last.method === 'POST', last.method)
      assert(
        last.headers.authorization === `Bearer ${STT_KEY}`,
        `auth ${last.headers.authorization}`
      )
      for (const field of [
        'name="file"',
        'name="model"',
        'name="language"',
        'name="response_format"'
      ])
        assert(last.body.includes(field), `campo ausente: ${field}`)
      assert(last.body.includes('whisper-large-v3-turbo'), 'modelo')
      assert(
        last.body.includes('\r\npt\r\n') || last.body.includes('\r\npt-'),
        'language normalizado'
      )
      return `${posts.length} request(s) em /audio/transcriptions`
    }
  )

  await step('Esc cancela a gravação e descarta (rascunho intacto)', async () => {
    const before = await composerValue()
    await micButton().click()
    await page.locator('[data-testid="voice-mic-button"][aria-pressed="true"]').waitFor({
      timeout: 15_000
    })
    await waveform().waitFor({ timeout: 10_000 })
    await page.keyboard.press('Escape')
    await waveform().waitFor({ state: 'detached', timeout: 10_000 })
    assert(!(await composerValue()).includes('▌'), 'parcial sobrou após cancelar')
    assert((await composerValue()) === before, `rascunho mudou: "${await composerValue()}"`)
    await shot('cancelado')
  })

  await app.close()
  await stt?.close()
  llm?.close()
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} ok — screenshots em ${SHOTS}`)
  process.exit(failed.length ? 1 : 0)
}

main().catch(async (e) => {
  console.error(e)
  try {
    await app?.close()
  } catch {
    /* */
  }
  try {
    await stt?.close()
  } catch {
    /* */
  }
  process.exit(1)
})
