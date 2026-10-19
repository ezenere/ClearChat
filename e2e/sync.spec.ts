/* eslint-disable @typescript-eslint/no-explicit-any */
// E2E do sync com DUAS instâncias reais do app (Playwright `_electron`, userData isolados) contra o
// servidor de sync FALSO (e2e/fakes/syncServer.ts) e um provedor OpenAI-compatible FALSO (nada de
// key real). Cobre: login pela UI (onboarding) e pela API, upload/download de provedores, chats e
// mensagens nos dois sentidos, host de execução (envio remoto executado no host, stream ao vivo
// visível no controle remoto, aprovação remota), host offline → composer desabilitado → assumir com
// aviso de ferramentas locais, troca forçada, "o dispositivo remoto caiu", divergência (escolher e
// descartar), skills opt-in e anexos (blob baixado sob demanda). Tira screenshots das telas novas.
//
// Uso:
//   unset ELECTRON_RUN_AS_NODE
//   npm run build
//   CLEARCHAT_E2E_DIR=/tmp/algum-dir node e2e/sync.spec.ts [filtro]
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { startFakeSyncServer, type FakeSyncServer } from './fakes/syncServer.ts'

const ROOT = resolve(import.meta.dirname, '..')
const BASE = resolve(process.env.CLEARCHAT_E2E_DIR || join(tmpdir(), 'clearchat-sync-e2e'))
const SHOTS = join(BASE, 'shots')
const FILTER = process.argv[2] ?? ''
const EMAIL = 'eduardo@teste.dev'
const PASSWORD = 'senha de criptografia do teste'

// ---------------- provedor falso ----------------

const hits: any[] = []
let llm: Server | null = null
let llmBase = ''
const textOf = (c: any): string =>
  typeof c === 'string' ? c : Array.isArray(c) ? c.map((p: any) => p.text ?? '').join('') : ''

async function readBody(req: IncomingMessage): Promise<string> {
  let d = ''
  for await (const c of req) d += c
  return d
}

async function startLlm(): Promise<void> {
  llm = createServer((req, res) => {
    void (async () => {
      if (req.method === 'GET' && (req.url ?? '').endsWith('/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            data: [{ id: 'fake/agent', context_length: 64000, supported_parameters: ['tools'] }]
          })
        )
        return
      }
      const body = JSON.parse((await readBody(req)) || '{}')
      hits.push(body)
      const msgs: any[] = body.messages ?? []
      const lastUser = textOf([...msgs].reverse().find((m) => m.role === 'user')?.content)
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
      const chunk = (delta: any, finish?: string): string =>
        `data: ${JSON.stringify({ id: 'f', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta, ...(finish ? { finish_reason: finish } : {}) }], ...(finish ? { usage: { prompt_tokens: 50, completion_tokens: 5 } } : {}) })}\n\n`
      const last = msgs[msgs.length - 1]
      if (last?.role === 'tool') {
        res.write(
          chunk({ role: 'assistant', content: `FIM: ${textOf(last.content).slice(0, 30)}` })
        )
        res.end(chunk({}, 'stop') + 'data: [DONE]\n\n')
        return
      }
      if (/^rode o comando/.test(lastUser)) {
        res.write(
          chunk({
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: `call_${hits.length}`,
                type: 'function',
                function: {
                  name: 'shell',
                  arguments: JSON.stringify({ command: 'echo remoto-ok' })
                }
              }
            ]
          })
        )
        res.end(chunk({}, 'tool_calls') + 'data: [DONE]\n\n')
        return
      }
      if (/devagar/.test(lastUser)) {
        const parts = [
          'Resposta ',
          'lenta, ',
          'chegando ',
          'aos ',
          'poucos ',
          'do ',
          'host ',
          'para ',
          'o ',
          'controle ',
          'remoto.'
        ]
        for (const p of parts) {
          if (res.destroyed) return
          res.write(chunk({ role: 'assistant', content: p }))
          await new Promise((r) => setTimeout(r, 350))
        }
        res.end(chunk({}, 'stop') + 'data: [DONE]\n\n')
        return
      }
      res.write(chunk({ role: 'assistant', content: `ok: ${lastUser.slice(0, 40)}` }))
      res.end(chunk({}, 'stop') + 'data: [DONE]\n\n')
    })()
  })
  await new Promise<void>((r) => llm!.listen(0, '127.0.0.1', r))
  llmBase = `http://127.0.0.1:${(llm!.address() as AddressInfo).port}/v1`
}

// ---------------- instâncias ----------------

interface Inst {
  name: string
  dir: string
  app: ElectronApplication
  page: Page
}

let srv: FakeSyncServer

async function launch(name: string, dir: string, url?: string): Promise<Inst> {
  mkdirSync(dir, { recursive: true })
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  delete env.ELECTRON_RUN_AS_NODE
  delete env.OPENROUTER_API_KEY
  env.CLEARCHAT_USER_DATA = dir
  env.CLEARCHAT_SYNC_URL = url ?? srv.url
  env.CLEARCHAT_SYNC_FAST = '1'
  env.CLEARCHAT_DEVICE_NAME = name
  const app = await electron.launch({ args: [ROOT], env, timeout: 60_000 })
  const log = createWriteStream(join(BASE, `${name.replace(/\W+/g, '_')}.log`), { flags: 'a' })
  app.process().stdout?.pipe(log)
  app.process().stderr?.pipe(log)
  const page = await app.firstWindow()
  await page.setViewportSize({ width: 1280, height: 800 }).catch(() => {})
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() => !!(window as any).api, null, { timeout: 30_000 })
  await page.evaluate(() => {
    const w = window as any
    w.__ev = []
    w.api.onEvent((e: unknown) => w.__ev.push(e))
  })
  return { name, dir, app, page }
}

async function api<T = any>(i: Inst, path: string, ...args: unknown[]): Promise<T> {
  return i.page.evaluate(
    ([p, a]) => {
      const fn = (p as string).split('.').reduce((o: any, k) => o[k], (window as any).api)
      return fn(...(a as unknown[]))
    },
    [path, args] as const
  ) as Promise<T>
}

const events = (i: Inst): Promise<any[]> => i.page.evaluate(() => (window as any).__ev)
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

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`asserção falhou: ${msg}`)
}

async function shot(i: Inst, name: string): Promise<void> {
  mkdirSync(SHOTS, { recursive: true })
  await sleep(250)
  await i.page.screenshot({ path: join(SHOTS, `${name}.png`) })
}

const results: { name: string; ok: boolean; info?: string; ms: number }[] = []
async function step(name: string, fn: () => Promise<string | void>): Promise<void> {
  if (FILTER && !FILTER.split(',').some((f) => name.includes(f.trim()))) return
  const t0 = Date.now()
  try {
    const info = await fn()
    results.push({ name, ok: true, info: info || undefined, ms: Date.now() - t0 })
    console.log(`✔ ${name}${info ? ` — ${info}` : ''} (${Date.now() - t0}ms)`)
  } catch (e) {
    results.push({ name, ok: false, info: (e as Error).message, ms: Date.now() - t0 })
    console.log(`✖ ${name} — ${(e as Error).message.split('\n')[0]}`)
  }
}

async function loginApi(i: Inst): Promise<void> {
  await api(i, 'sync.requestCode', EMAIL)
  await api(i, 'sync.verifyCode', EMAIL, srv.lastCode(EMAIL))
  await api(i, 'sync.unlock', PASSWORD, true)
}

const status = (i: Inst): Promise<any> => api(i, 'sync.status')
const hostInfo = async (i: Inst, chatId: string): Promise<any> =>
  (await api<any[]>(i, 'sync.chatStates')).find((h) => h.chatId === chatId)
const texts = async (i: Inst, sessionId: string): Promise<string[]> =>
  (await api<any[]>(i, 'sessions.messages', sessionId)).map((m) => textOf(m.message.content))
const settled = (i: Inst): Promise<any> =>
  waitFor(
    async () => {
      const s = await status(i)
      return s.phase === 'ready' && s.pending === 0 && s.connection === 'online' && s
    },
    20_000,
    `${i.name} sincronizado`
  )

async function openChatUi(i: Inst, title: string): Promise<void> {
  await i.page.locator('[data-testid="chat-item"]', { hasText: title }).first().click()
  await sleep(300)
}

// ---------------- passos ----------------

async function main(): Promise<void> {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(BASE, { recursive: true })
  await startLlm()
  srv = await startFakeSyncServer({
    hostDropGraceMs: 1500,
    commandTimeoutMs: 15_000,
    name: 'ClearChat (teste)'
  })
  await srv.createAccount({ email: EMAIL, name: 'Eduardo', password: PASSWORD })

  const A = await launch('PC de casa', join(BASE, 'a'))
  const B = await launch('Notebook', join(BASE, 'b'))
  const skillsDir = join(BASE, 'skills-a')
  let providerId = ''
  let chat: any = null
  let toolChat: any = null

  await step(
    'onboarding: entrar pela UI (servidor, e-mail, código, desbloqueio) — online vazio',
    async () => {
      await A.page.getByTestId('onboarding-login').click()
      await A.page.getByTestId('sync-email').waitFor()
      await shot(A, '01-onboarding-servidor')
      await A.page.getByTestId('sync-email').fill(EMAIL)
      await A.page.getByRole('button', { name: 'Enviar código' }).click()
      await A.page.getByTestId('sync-code').waitFor()
      await A.page.getByTestId('sync-code').fill(srv.lastCode(EMAIL)!)
      await shot(A, '02-onboarding-codigo')
      await A.page
        .getByRole('button', { name: /Entrar/ })
        .last()
        .click()
      await A.page.getByText('Desbloquear seus dados').waitFor({ timeout: 15_000 })
      await A.page.locator('input[type="password"]').first().fill(PASSWORD)
      await shot(A, '03-onboarding-desbloqueio')
      await A.page.getByRole('button', { name: 'Desbloquear' }).click()
      await waitFor(async () => (await status(A)).phase === 'ready', 20_000, 'A pronto')
      await A.page.getByText(/Conectado como/).waitFor()
      await shot(A, '04-onboarding-conectado')
    }
  )

  await step(
    'provedor criado em A sincroniza para B (login de B pela API, local vazio)',
    async () => {
      providerId = (
        await api(A, 'providers.create', {
          name: 'LLM falso',
          baseUrl: llmBase,
          apiKey: 'sk-fake-123'
        })
      ).id
      await settled(A)
      await loginApi(B)
      await settled(B)
      const list = await api<any[]>(B, 'providers.list')
      assert(
        list.some((p) => p.id === providerId && p.apiKey === 'sk-fake-123'),
        'B recebeu o provedor (com a chave)'
      )
      await B.page.getByTestId('sync-indicator').waitFor({ timeout: 10_000 })
    }
  )

  await step(
    'chat e mensagens: A executa (vira host) e B recebe; B edita o título e A recebe',
    async () => {
      chat = await api(A, 'chats.create', {
        title: 'Projeto compartilhado',
        config: { providerId, model: 'fake/agent', cwd: BASE, enabledTools: [] }
      })
      await api(A, 'agent.send', chat.mainSessionId, 'olá do PC')
      await waitFor(
        async () => (await texts(A, chat.mainSessionId)).length >= 2,
        15_000,
        'A respondeu'
      )
      await settled(A)
      await waitFor(
        async () => (await texts(B, chat.mainSessionId)).includes('ok: olá do PC'),
        15_000,
        'B recebeu as mensagens'
      )
      const h = await hostInfo(B, chat.id)
      assert(
        h?.mode === 'remote' && h.host?.name === 'PC de casa',
        `B é controle remoto (${h?.mode})`
      )
      await api(B, 'chats.update', chat.id, { title: 'Projeto compartilhado ✓' })
      await waitFor(
        async () => (await api(A, 'chats.get', chat.id))?.title === 'Projeto compartilhado ✓',
        10_000,
        'A recebe o título'
      )
    }
  )

  await step(
    'controle remoto: envio do composer de B executa no host A; stream ao vivo em B',
    async () => {
      await openChatUi(B, 'Projeto compartilhado')
      await B.page.getByTestId('host-badge').waitFor()
      const badge = await B.page.getByTestId('host-badge').innerText()
      assert(/Executando em PC de casa/.test(badge), `selo: ${badge}`)
      const n0 = hits.length
      const box = B.page.locator('[data-testid="composer-column"] textarea')
      await box.fill('responda devagar, por favor')
      await box.press('Enter')
      // o draft do host chega ao vivo em B (antes da mensagem persistida)
      await waitFor(
        async () =>
          (await events(B)).some(
            (e) => e.type === 'draft' && e.draft?.content?.includes('chegando')
          ),
        15_000,
        'draft ao vivo em B'
      ).catch(async (e) => {
        const ev = (await events(B))
          .map((x) => x.type)
          .slice(-40)
          .join(',')
        throw new Error(
          `${e.message} | A=${JSON.stringify(await texts(A, chat.mainSessionId))} | B ev=${ev} | conns=${JSON.stringify(srv.connections(srv.userIdOf(EMAIL)!))}`
        )
      })
      await shot(B, '05-controle-remoto-ao-vivo')
      assert(hits.length > n0, 'o modelo foi chamado (no host)')
      await waitFor(
        async () =>
          (await texts(A, chat.mainSessionId)).some((t) => t.includes('controle remoto.')),
        20_000,
        'host terminou'
      )
      await waitFor(
        async () =>
          (await texts(B, chat.mainSessionId)).some((t) => t.includes('controle remoto.')),
        15_000,
        'B recebe a resposta persistida'
      )
      const aMsgs = await texts(A, chat.mainSessionId)
      assert(aMsgs.includes('responda devagar, por favor'), 'a mensagem de B foi executada em A')
      await shot(B, '06-controle-remoto-concluido')
    }
  )

  await step('aprovação pedida no host aparece e é respondida no controle remoto', async () => {
    toolChat = await api(A, 'chats.create', {
      title: 'Chat com terminal',
      config: { providerId, model: 'fake/agent', cwd: BASE, enabledTools: ['shell'] }
    })
    await api(A, 'agent.send', toolChat.mainSessionId, 'primeira')
    await waitFor(
      async () => (await texts(B, toolChat.mainSessionId)).length >= 2,
      15_000,
      'B tem o chat com terminal'
    )
    await openChatUi(B, 'Chat com terminal')
    await api(B, 'agent.send', toolChat.mainSessionId, 'rode o comando, por favor')
    const req = await waitFor(
      async () =>
        (await api<any[]>(B, 'agent.pendingApprovals')).find((a) => a.chatId === toolChat.id),
      15_000,
      'aprovação espelhada em B'
    )
    assert(req.toolName === 'shell', 'pedido do shell')
    await shot(B, '06b-aprovacao-remota')
    await api(B, 'agent.approve', req.id, 'allow')
    await waitFor(
      async () =>
        (await texts(B, toolChat.mainSessionId)).some(
          (t) => t.startsWith('FIM:') && t.includes('remoto-ok')
        ),
      20_000,
      'comando rodou no host e o resultado voltou'
    )
    assert(
      (await api<any[]>(A, 'agent.pendingApprovals')).length === 0,
      'aprovação resolvida no host'
    )
    await settled(A)
    return 'shell executado em A com a aprovação dada em B'
  })

  let aDevice = ''
  await step(
    'host offline: "o dispositivo remoto caiu", composer desabilitado, assumir com aviso',
    async () => {
      aDevice = (await status(A)).device.id
      await openChatUi(B, 'Chat com terminal')
      srv.setRefuseConnections(aDevice, true)
      srv.dropDevice(aDevice)
      await B.page.getByTestId('host-offline').waitFor({ timeout: 15_000 })
      await waitFor(
        async () => (await events(B)).some((e) => e.type === 'sync-notice' && /caiu/.test(e.text)),
        10_000,
        'aviso caiu'
      )
      await B.page.getByTestId('host-notice').waitFor({ timeout: 5_000 })
      await shot(B, '07-host-offline')
      let err = ''
      try {
        await api(B, 'agent.send', toolChat.mainSessionId, 'não deve ir')
      } catch (e) {
        err = (e as Error).message
      }
      assert(/offline/.test(err), `envio recusado com host offline: ${err}`)
      await B.page.getByTestId('host-offline-takeover').click()
      await B.page.getByTestId('takeover-dialog').waitFor()
      const txt = await B.page.getByTestId('takeover-dialog').innerText()
      assert(/ferramentas locais/.test(txt), 'aviso forte de ferramentas locais')
      await shot(B, '08-assumir-aviso')
      await B.page.getByTestId('takeover-confirm').click()
      await waitFor(
        async () => (await hostInfo(B, toolChat.id))?.host?.self,
        10_000,
        'B virou host'
      )
      await api(B, 'agent.send', toolChat.mainSessionId, 'agora no notebook')
      await waitFor(
        async () => (await texts(B, toolChat.mainSessionId)).includes('ok: agora no notebook'),
        15_000,
        'B executou localmente'
      )
      await settled(B)
    }
  )

  await step('A volta: vira controle remoto; troca forçada devolve o host para A', async () => {
    srv.setRefuseConnections(aDevice, false)
    await waitFor(
      async () => (await hostInfo(A, toolChat.id))?.mode === 'remote',
      20_000,
      'A é controle remoto'
    )
    await waitFor(
      async () => (await texts(A, toolChat.mainSessionId)).includes('ok: agora no notebook'),
      15_000,
      'A recebe o que B rodou'
    )
    // B começa um turno lento e A força a troca no meio
    await api(B, 'agent.send', toolChat.mainSessionId, 'devagar de novo')
    await sleep(900)
    const info = await api(A, 'sync.takeover', toolChat.id, { mode: 'force' })
    assert(info.host?.self || info.handover?.self, 'troca pedida')
    await waitFor(
      async () => (await hostInfo(A, toolChat.id))?.host?.self,
      25_000,
      'A virou host (forçado)'
    )
    await waitFor(
      async () => (await hostInfo(B, toolChat.id))?.mode === 'remote',
      15_000,
      'B virou controle remoto'
    )
    await settled(B)
    await settled(A)
  })

  await step(
    'divergência: B roda offline, A roda online → divergente; B mantém a sua; A recebe',
    async () => {
      const bDevice = (await status(B)).device.id
      srv.setRefuseConnections(bDevice, true)
      srv.dropDevice(bDevice)
      await waitFor(
        async () => (await hostInfo(B, chat.id))?.mode === 'offline',
        10_000,
        'B offline'
      )
      await api(B, 'agent.send', chat.mainSessionId, 'versão offline do notebook')
      await waitFor(
        async () => (await texts(B, chat.mainSessionId)).includes('ok: versão offline do notebook'),
        15_000,
        'B rodou offline'
      )
      await api(A, 'agent.send', chat.mainSessionId, 'versão online do PC')
      await waitFor(
        async () => (await texts(A, chat.mainSessionId)).includes('ok: versão online do PC'),
        15_000,
        'A rodou'
      )
      await settled(A)
      srv.setRefuseConnections(bDevice, false)
      await waitFor(
        async () => (await hostInfo(B, chat.id))?.diverged?.self,
        25_000,
        'B vê a divergência'
      ).catch(async (e) => {
        throw new Error(
          `${e.message} | B=${JSON.stringify(await hostInfo(B, chat.id))} | Bst=${JSON.stringify(await status(B))} | A=${JSON.stringify(await hostInfo(A, chat.id))} | srv=${JSON.stringify(srv.chatState(srv.userIdOf(EMAIL)!, chat.id))} | Btexts=${JSON.stringify(await texts(B, chat.mainSessionId))}`
        )
      })
      await waitFor(
        async () => (await hostInfo(A, chat.id))?.diverged,
        10_000,
        'A vê a divergência'
      )
      await openChatUi(B, 'Projeto compartilhado')
      await B.page.getByTestId('divergence-panel').waitFor()
      await B.page.getByTestId('divergence-tab-local').click()
      await shot(B, '09-divergencia')
      await B.page.getByTestId('divergence-keep').click()
      await B.page.getByTestId('divergence-warning').waitFor()
      const warn = await B.page.getByTestId('divergence-warning').innerText()
      assert(/será apagada/.test(warn) && /mensage/.test(warn), `aviso de descarte: ${warn}`)
      await shot(B, '10-divergencia-aviso')
      await B.page.getByTestId('divergence-confirm').click()
      await waitFor(async () => !(await hostInfo(A, chat.id))?.diverged, 15_000, 'resolvida em A')
      await waitFor(
        async () => {
          const t = await texts(A, chat.mainSessionId)
          return (
            t.includes('ok: versão offline do notebook') && !t.includes('ok: versão online do PC')
          )
        },
        15_000,
        'A tem a versão de B (a online foi descartada)'
      )
    }
  )

  await step(
    'skills opt-in: A sincroniza uma skill; B baixa sob pedido e recebe a atualização',
    async () => {
      mkdirSync(join(skillsDir, 'demo'), { recursive: true })
      writeFileSync(
        join(skillsDir, 'demo', 'SKILL.md'),
        '---\nname: demo\ndescription: Skill de teste\n---\nversão 1\n'
      )
      await api(A, 'skills.updateSettings', {
        locations: [{ id: 'l1', path: skillsDir, enabled: true }]
      })
      await api(A, 'skills.discover', { rescan: true })
      await api(A, 'sync.setSkillSync', 'demo', true)
      await settled(A)
      const cloud = await waitFor(
        async () => {
          const l = await api<any[]>(B, 'sync.cloudSkills')
          return l.find((s) => s.name === 'demo') && l
        },
        15_000,
        'B vê a skill na nuvem'
      )
      assert(
        cloud.find((s: any) => s.name === 'demo').local === null,
        'não baixada automaticamente'
      )
      await api(B, 'sync.downloadSkills', ['demo'])
      const file = join(B.dir, 'synced-skills', 'demo', 'SKILL.md')
      assert(existsSync(file) && readFileSync(file, 'utf8').includes('versão 1'), 'B baixou')
      writeFileSync(
        join(skillsDir, 'demo', 'SKILL.md'),
        '---\nname: demo\ndescription: Skill de teste\n---\nversão 2\n'
      )
      await api(A, 'skills.discover', { rescan: true })
      await waitFor(
        async () => readFileSync(file, 'utf8').includes('versão 2'),
        20_000,
        'B recebeu a atualização'
      )
    }
  )

  await step('anexos: imagem enviada em A é baixada em B sob demanda (blob cifrado)', async () => {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64'
    )
    const info = await A.page.evaluate(async (b64) => {
      const data = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
      return (window as any).api.attachments.add({ name: 'pixel.png', mime: 'image/png', data })
    }, png.toString('base64'))
    const c = await api(A, 'chats.create', {
      title: 'Com anexo',
      config: { providerId, model: 'fake/agent', cwd: BASE, enabledTools: [] }
    })
    await api(A, 'agent.send', c.mainSessionId, 'veja a imagem', [info])
    await settled(A)
    await waitFor(
      async () => (await api<any[]>(B, 'sessions.messages', c.mainSessionId)).length >= 2,
      15_000,
      'B recebeu a mensagem'
    )
    assert(!existsSync(join(B.dir, 'attachments', info.file)), 'ainda não baixado em B')
    const w = await B.page.evaluate(
      (f) =>
        new Promise<number>((done) => {
          const img = new Image()
          img.onload = () => done(img.naturalWidth)
          img.onerror = () => done(-1)
          img.src = `clearchat-attachment://${f}`
        }),
      info.file
    )
    assert(w === 1, `B baixou e exibiu o anexo (${w})`)
    assert(existsSync(join(B.dir, 'attachments', info.file)), 'gravado no store de B')
  })

  await step('Configurações → Conta (screenshot) e dispositivos', async () => {
    await B.page.keyboard.press('Control+,')
    await B.page.getByRole('button', { name: 'Conta' }).click()
    await B.page.getByTestId('account-tab').waitFor()
    await sleep(800)
    await shot(B, '11-conta')
    const devs = await api<any[]>(B, 'sync.devices')
    assert(devs.length === 2 && devs.some((d) => d.current), 'dois dispositivos')
    await B.page.keyboard.press('Escape')
  })

  await step(
    'captcha: instância com Turnstile → janela do captcha → token → código enviado',
    async () => {
      const srv2 = await startFakeSyncServer({ captcha: true, name: 'Com captcha' })
      const email2 = 'captcha@teste.dev'
      await srv2.createAccount({ email: email2, password: PASSWORD })
      const C = await launch('Com captcha', join(BASE, 'c'), srv2.url)
      try {
        const info = await api(C, 'sync.probeServer')
        assert(info.captcha === true, 'features.captcha')
        await api(C, 'sync.requestCode', email2)
        assert(!!srv2.lastCode(email2), 'código enviado depois do captcha')
        const req = srv2.requests.find((r) => r.path.endsWith('/auth/code/request'))
        assert(req?.status === 202, 'turnstile_token aceito')
      } finally {
        await C.app.close().catch(() => {})
        await srv2.close()
      }
    }
  )

  const failed = results.filter((r) => !r.ok)
  writeFileSync(join(BASE, 'report.json'), JSON.stringify(results, null, 2))
  console.log(
    `\n${results.length - failed.length}/${results.length} passos ok · screenshots em ${SHOTS}`
  )
  await A.app.close().catch(() => {})
  await B.app.close().catch(() => {})
  await srv.close()
  llm?.close()
  process.exit(failed.length ? 1 : 0)
}

main().catch(async (e) => {
  console.error(e)
  process.exit(1)
})
