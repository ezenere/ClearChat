/* eslint-disable @typescript-eslint/no-explicit-any */
// E2E contra o MOCK de UI (Playwright `_electron`, sem backend, sem chave, sem microfone) da UX de
// áudio: ditado (cancelar durante o "Transcrevendo…" não insere; texto final no cursor do início
// com desfazer; digitar durante a gravação não corrompe o rascunho; parcial fora da textarea),
// falhas do microfone (salvo desconectado → padrão + aviso; permissão negada dispensável; perdido
// no meio), botões de parar distintos com o agente ocupado, chamada de voz (falha visível em toast,
// pré-checagem, barra da chamada NO LUGAR do composer em 1440/1100/900 com e sem painel — sem
// textarea, rascunho intacto ao encerrar, pílula "Chamada ativa em…" nos outros chats, aprovações e
// pergunta clicáveis acima da barra —, CTA de clipes ausentes, botão some com a chamada desligada) e Configurações (abas cabem sem
// rolagem; Esc na captura da tecla do PTT não fecha o modal; tecla que digita é recusada).
// Cenários do mock: `?scenario=voice-mic-missing|voice-mic-denied|voice-mic-lost|voice-call-fail|
// voice-not-ready|voice-no-espeak` (ver `dev/mockApi.ts` → binding `voice`). Screenshots em $CLEARCHAT_E2E_DIR/shots.
//
// Uso:
//   unset ELECTRON_RUN_AS_NODE
//   CLEARCHAT_E2E_DIR=/tmp/clearchat-voice-ui node e2e/voice-ui.spec.ts [filtro-para-parar]
//   (SKIP_BUILD=1 reaproveita o build anterior)
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { execSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'

const ROOT = resolve(import.meta.dirname, '..')
const BASE = resolve(process.env.CLEARCHAT_E2E_DIR || join(tmpdir(), 'clearchat-voice-ui'))
const BUILD = join(BASE, 'build')
const SHOTS = join(BASE, 'shots')
const STOP_AFTER = process.argv[2] ?? ''
const MOCK_FINAL = 'Olá mundo, isto é um ditado simulado pelo mock de voz.'

let app: ElectronApplication
let page: Page
let stopped = false
const results: { name: string; ok: boolean; info?: string }[] = []

async function shot(name: string): Promise<void> {
  await page.waitForTimeout(200)
  await page.screenshot({ path: join(SHOTS, `${name}.png`) })
}

async function step(name: string, fn: () => Promise<string | void>): Promise<void> {
  if (stopped) return
  try {
    const info = await fn()
    results.push({ name, ok: true, info: info || undefined })
    console.log(`✔ ${name}${info ? ` — ${info}` : ''}`)
  } catch (e) {
    results.push({ name, ok: false, info: (e as Error).message })
    console.log(`✖ ${name} — ${(e as Error).message.split('\n').slice(0, 6).join('\n')}`)
    try {
      await shot(`FAIL-${name.replace(/[^\w]+/g, '_')}`)
    } catch {
      /* */
    }
  }
  if (STOP_AFTER && name.includes(STOP_AFTER)) stopped = true
}

async function setSize(w: number, h: number): Promise<void> {
  await app.evaluate(
    ({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setContentSize(w, h),
    [w, h]
  )
  await page.waitForTimeout(350)
}

async function panel(open: boolean): Promise<void> {
  const isOpen = await page.getByTestId('right-panel').isVisible()
  if (isOpen === open) return
  await page
    .getByRole('banner')
    .getByRole('button', { name: open ? 'Abrir painel' : 'Fechar painel' })
    .click()
  await page.waitForTimeout(300)
}

async function open(scenario: string, chat: string): Promise<void> {
  await page.evaluate((s) => {
    location.search = `?scenario=${s}`
  }, scenario)
  await page.waitForLoadState('domcontentloaded')
  await page.getByTestId('chat-item').filter({ hasText: chat }).first().click()
  await page.getByTestId('chat-scroller').waitFor()
  await page.waitForTimeout(500)
}

const composer = (): ReturnType<Page['locator']> =>
  page.locator('[data-testid="composer-column"] textarea')
const recording = (): ReturnType<Page['locator']> =>
  page.locator('[data-testid="voice-mic-button"][aria-pressed="true"]')
const dialog = (): ReturnType<Page['locator']> => page.locator('[role="dialog"]')

async function openAudioSettings(): Promise<void> {
  await page.getByRole('button', { name: /^Configurações/ }).click()
  await dialog().getByRole('button', { name: 'Áudio', exact: true }).click()
  await page.getByTestId('audio-settings').waitFor()
  await page.waitForTimeout(250)
}

/** Retângulos da barra da chamada e da coluna do composer (+ rolagem horizontal da página). */
function dockGeo(): Promise<{
  dock: DOMRect | null
  column: DOMRect
  pageScroll: boolean
}> {
  return page.evaluate(() => {
    const r = (sel: string): DOMRect | null =>
      document.querySelector<HTMLElement>(sel)?.getBoundingClientRect().toJSON() ?? null
    return {
      dock: r('[data-testid=voice-call-dock]'),
      column: r('[data-testid=composer-column]')!,
      pageScroll: document.documentElement.scrollWidth > window.innerWidth
    }
  })
}

async function main(): Promise<void> {
  rmSync(SHOTS, { recursive: true, force: true })
  mkdirSync(SHOTS, { recursive: true })
  if (!process.env.SKIP_BUILD) {
    execSync(`npx electron-vite build --outDir "${BUILD}"`, {
      cwd: ROOT,
      stdio: 'inherit',
      env: { ...process.env, VITE_CLEAR_MOCK: '1' }
    })
  }
  const mainJs = join(BASE, 'mock-main.cjs')
  writeFileSync(
    mainJs,
    `const { app, BrowserWindow } = require('electron')
app.setPath('userData', ${JSON.stringify(join(BASE, 'user-data'))})
app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 1440, height: 860, useContentSize: true, backgroundColor: '#0d0d10', show: true })
  win.setIgnoreMouseEvents(true)
  win.loadFile(${JSON.stringify(join(BUILD, 'renderer', 'index.html'))}, { search: 'scenario=chat' })
})
app.on('window-all-closed', () => app.quit())
`
  )
  const env = { ...process.env } as Record<string, string>
  delete env.ELECTRON_RUN_AS_NODE
  app = await electron.launch({ args: [mainJs], env, timeout: 60_000 })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await setSize(1440, 860)

  // ---------------- ditado ----------------

  await step(
    'ditado: parcial fica FORA da textarea; digitar no fim durante a gravação é seguro',
    async () => {
      await open('chat', 'Ideias de nomes para o app')
      await composer().fill('Começo')
      await page.getByTestId('voice-mic-button').click()
      await recording().waitFor()
      await page.getByTestId('voice-partial').waitFor()
      // as parciais do mock chegam em ~350 ms cada
      await page.waitForFunction(
        () => document.querySelector('[data-testid=voice-partial]')?.textContent?.includes('Olá'),
        undefined,
        { timeout: 4000 }
      )
      // digita no fim enquanto grava: o valor da textarea é SÓ o texto do usuário
      await composer().focus()
      await page.keyboard.press('End')
      await page.keyboard.type(' e fim')
      const during = await composer().inputValue()
      assert.equal(during, 'Começo e fim')
      assert(!during.includes('▌'), 'cursor ▌ dentro do texto editável')
      await shot('after-dictation-partial-ghost')
      await page.getByTestId('voice-stop-button').click()
      await page.waitForFunction(
        (want) =>
          (document.querySelector('[data-testid=composer-column] textarea') as HTMLTextAreaElement)
            ?.value === want,
        `Começo e fim ${MOCK_FINAL}`,
        { timeout: 5000 }
      )
      return await composer().inputValue()
    }
  )

  await step(
    'ditado: texto final entra no cursor do início do ditado e Ctrl+Z desfaz',
    async () => {
      await open('chat', 'Ideias de nomes para o app')
      await composer().fill('Início fim')
      // cursor depois de "Início " (o clique no mic tira o foco, a seleção fica)
      await composer().evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(7, 7))
      await page.getByTestId('voice-mic-button').click()
      await recording().waitFor()
      await page.waitForTimeout(500)
      await page.getByTestId('voice-stop-button').click()
      const want = `Início ${MOCK_FINAL} fim`
      await page.waitForFunction(
        (w) =>
          (document.querySelector('[data-testid=composer-column] textarea') as HTMLTextAreaElement)
            ?.value === w,
        want,
        { timeout: 5000 }
      )
      await composer().focus()
      await page.keyboard.press('Control+z')
      await page.waitForTimeout(150)
      const undone = await composer().inputValue()
      assert.equal(undone, 'Início fim', 'desfazer remove a inserção do ditado')
      return `"${want}" → Ctrl+Z → "${undone}"`
    }
  )

  await step('ditado: Cancelar durante o "Transcrevendo…" NÃO insere o texto', async () => {
    await open('chat', 'Ideias de nomes para o app')
    await composer().fill('abc')
    await page.getByTestId('voice-mic-button').click()
    await recording().waitFor()
    await page.waitForTimeout(400)
    await page.getByTestId('voice-stop-button').click()
    // o mock leva ~700 ms para devolver a final: cancela no meio
    await page.getByTestId('voice-stop-button').and(page.locator('[disabled]')).waitFor()
    await page.getByTestId('voice-cancel-button').click()
    await page.getByTestId('voice-cancel-button').waitFor({ state: 'detached', timeout: 3000 })
    await page.waitForTimeout(1200)
    assert.equal(await composer().inputValue(), 'abc')
    return 'rascunho intacto'
  })

  await step(
    'agente ocupado + ditado: "Parar o agente" e "Parar gravação" são distintos',
    async () => {
      await open('chat', 'Refatorar o parser de SSE')
      await page.getByTestId('voice-mic-button').click()
      await recording().waitFor()
      const agent = page.getByTestId('agent-stop-button')
      const rec = page.getByTestId('voice-stop-button')
      await agent.waitFor()
      await rec.waitFor()
      const a = await agent.evaluate((el) => ({
        label: el.getAttribute('aria-label'),
        icon: el.querySelector('svg')?.getAttribute('class') ?? '',
        bg: getComputedStyle(el).backgroundColor
      }))
      const r = await rec.evaluate((el) => ({
        label: el.getAttribute('aria-label'),
        icon: el.querySelector('svg')?.getAttribute('class') ?? '',
        bg: getComputedStyle(el).backgroundColor
      }))
      assert.equal(a.label, 'Parar o agente')
      assert.equal(r.label, 'Parar gravação')
      assert.match(a.icon, /lucide-square/)
      assert.match(r.icon, /lucide-mic-off/)
      assert.notEqual(a.bg, r.bg, 'mesma cor de fundo')
      await page
        .getByTestId('composer-toolbar')
        .screenshot({ path: join(SHOTS, 'after-stop-buttons.png') })
      await page.getByTestId('voice-cancel-button').click()
      return `${a.label} (${a.bg}) × ${r.label} (${r.bg})`
    }
  )

  // ---------------- falhas do microfone ----------------

  await step(
    'microfone salvo desconectado: grava no padrão e avisa uma vez; menu marca o ausente',
    async () => {
      await open('voice-mic-missing', 'Ideias de nomes para o app')
      await page.getByTestId('voice-mic-button').click()
      await recording().waitFor()
      const notice = page.getByTestId('voice-notice')
      await notice.waitFor()
      assert.match(await notice.innerText(), /Microfone salvo não encontrado — usando o padrão/)
      await shot('after-mic-missing-notice')
      await page.getByTestId('voice-cancel-button').click()
      await page.getByTestId('voice-mic-menu-button').click()
      await page.getByTestId('voice-mic-menu').waitFor()
      await page.waitForTimeout(600)
      const missing = await page.getByTestId('voice-mic-option-missing').count()
      const expanded = await page.getByTestId('voice-mic-menu-button').getAttribute('aria-expanded')
      assert.equal(expanded, 'true')
      const radios = await page.locator('[data-testid=voice-mic-menu] [role=menuitemradio]').count()
      assert(radios >= 1, 'itens menuitemradio')
      await page.keyboard.press('Escape')
      await page.getByTestId('voice-mic-menu').waitFor({ state: 'detached' })
      return `aviso ok · item "desconectado" no menu: ${missing ? 'sim' : 'não (lista sem deviceIds)'}`
    }
  )

  await step(
    'permissão negada: erro legível e dispensável (X limpa o erro da captura)',
    async () => {
      await open('voice-mic-denied', 'Ideias de nomes para o app')
      await page.getByTestId('voice-mic-button').click()
      const err = page.getByTestId('voice-error')
      await err.waitFor()
      assert.match(await err.innerText(), /Permissão de microfone negada/)
      await err.getByRole('button', { name: 'Dispensar erro de voz' }).click()
      await err.waitFor({ state: 'detached' })
    }
  )

  await step('microfone perdido no meio da gravação: aviso visível', async () => {
    await open('voice-mic-lost', 'Ideias de nomes para o app')
    await page.getByTestId('voice-mic-button').click()
    await recording().waitFor()
    const notice = page.getByTestId('voice-notice')
    await notice.waitFor({ timeout: 4000 })
    assert.match(await notice.innerText(), /desconectado durante a gravação/)
  })

  // ---------------- chamada de voz ----------------

  await step(
    'chamada: falha ao iniciar aparece (toast) e a pré-checagem aponta o que falta',
    async () => {
      await open('voice-call-fail', 'Ideias de nomes para o app')
      await page.getByTestId('voice-call-button').click()
      const toast = page.getByTestId('toast').filter({ hasText: 'espeak-ng' })
      await toast.waitFor({ timeout: 4000 })
      assert.equal(await page.getByTestId('voice-call-dock').count(), 0)
      await shot('after-call-start-failure')
      await open('voice-not-ready', 'Ideias de nomes para o app')
      await page.getByTestId('voice-call-button').click()
      const t2 = page.getByTestId('toast').filter({ hasText: 'Chamada de voz indisponível' })
      await t2.waitFor({ timeout: 4000 })
      const txt = await t2.innerText()
      assert.match(txt, /chave de API da transcrição/)
      assert.match(txt, /Kokoro/)
      // runtime local quebrado (espeak-ng ausente — probe `voice.runtime.status`)
      await open('voice-no-espeak', 'Ideias de nomes para o app')
      await page.getByTestId('voice-call-button').click()
      const t3 = page.getByTestId('toast').filter({ hasText: 'espeak-ng não encontrado' })
      await t3.waitFor({ timeout: 4000 })
      assert.equal(await page.getByTestId('voice-call-dock').count(), 0)
      // Configurações → Áudio mostra o motivo do motor local não estar pronto
      await openAudioSettings()
      const warn = page.getByTestId('tts-runtime-warning')
      await warn.waitFor({ timeout: 3000 })
      assert.match(await warn.innerText(), /espeak-ng não encontrado/)
      await page.keyboard.press('Escape')
      await dialog().waitFor({ state: 'detached' })
      return txt.replace(/\s+/g, ' ').slice(0, 140)
    }
  )

  await step('chamada: microfone negado encerra a chamada COM aviso (toast)', async () => {
    await open('voice-mic-denied', 'Ideias de nomes para o app')
    await page.getByTestId('voice-call-button').click()
    const toast = page.getByTestId('toast').filter({ hasText: 'Chamada de voz encerrada' })
    await toast.waitFor({ timeout: 4000 })
    assert.match(await toast.innerText(), /Permissão de microfone negada/)
    await page.getByTestId('voice-call-dock').waitFor({ state: 'detached', timeout: 3000 })
  })

  await step(
    'chamada: barra NO LUGAR do composer (sem textarea) em 1440/1100/900 ± painel; rascunho volta',
    async () => {
      await open('chat', 'Ideias de nomes para o app')
      await composer().fill('rascunho guardado')
      await page.getByTestId('voice-call-button').click()
      await page.getByTestId('voice-call-dock').waitFor()
      // texto, anexos, mic, toolbar (pílula do modelo, enviar) somem durante a chamada
      assert.equal(await composer().count(), 0, 'textarea visível durante a chamada')
      assert.equal(await page.getByTestId('composer-toolbar').count(), 0, 'toolbar visível')
      assert.equal(await page.getByTestId('voice-mic-button').count(), 0, 'mic visível')
      const out: string[] = []
      for (const [w, h] of [
        [1440, 860],
        [1100, 800],
        [900, 760]
      ] as const) {
        await setSize(w, h)
        for (const p of [false, true]) {
          await panel(p)
          const g = await dockGeo()
          assert(g.dock, `barra ausente em ${w} painel=${p}`)
          // mesma largura e posição do card do composer: ocupa a coluna e fica no rodapé dela
          assert(
            Math.abs(g.dock.left - g.column.left) <= 1 &&
              Math.abs(g.dock.right - g.column.right) <= 1,
            `barra fora da largura da coluna em ${w} painel=${p}`
          )
          assert(Math.abs(g.dock.bottom - g.column.bottom) <= 1, `barra não está no rodapé em ${w}`)
          assert(!g.pageScroll, `página rola em ${w}`)
          out.push(`${w}${p ? '+painel' : ''}`)
          if (!p && (w === 1440 || w === 900)) await shot(`after-call-bar-${w}`)
        }
      }
      await panel(false)
      await setSize(1440, 860)
      // outro chat: composer normal + pílula que leva de volta à chamada
      await page.getByTestId('chat-item').filter({ hasText: 'Script de backup' }).first().click()
      await page.waitForTimeout(400)
      await composer().waitFor()
      const pill = page.getByTestId('voice-call-elsewhere')
      await pill.waitFor()
      assert.match(await pill.innerText(), /Chamada ativa em .*Ideias de nomes/)
      await shot('after-call-elsewhere-pill')
      await pill.click()
      await page.getByTestId('voice-call-dock').waitFor()
      assert.equal(await composer().count(), 0)
      return out.join(' · ')
    }
  )

  await step('chamada: sem clipes → aviso com "Gerar clipes" (some depois de gerar)', async () => {
    const hint = page.getByTestId('voice-call-clips-hint')
    await hint.waitFor()
    await page.getByTestId('voice-call-clips-generate').click()
    await hint.waitFor({ state: 'detached', timeout: 6000 })
    await page.getByTestId('voice-call-end').click()
    await page.getByTestId('voice-call-dock').waitFor({ state: 'detached' })
    // fim da chamada: composer de volta com o rascunho intacto e o foco no texto
    await composer().waitFor()
    assert.equal(await composer().inputValue(), 'rascunho guardado')
    const focused = await composer().evaluate((el) => document.activeElement === el)
    assert(focused, 'foco não voltou ao composer')
  })

  await step(
    'chamada: aprovações e pergunta (ask_user) continuam clicáveis acima da barra',
    async () => {
      // aprovações: chat c1 tem aprovações pendentes (fila de aprovação acima do composer)
      await open('chat', 'Refatorar o parser de SSE')
      await page.getByTestId('voice-call-button').click()
      await page.getByTestId('voice-call-dock').waitFor()
      const queue = page.getByTestId('approval-queue')
      const hasQueue = (await queue.count()) > 0
      if (hasQueue) {
        const q = await queue.boundingBox()
        const d = await page.getByTestId('voice-call-dock').boundingBox()
        assert(q && d && q.y + q.height <= d.y + 1, 'aprovações não ficam acima da barra')
      }
      await page.getByTestId('voice-call-end').click()
      await page.getByTestId('voice-call-dock').waitFor({ state: 'detached' })
      // pergunta pendente que chega durante a chamada: card acima da barra, opções clicáveis
      await open('question', 'Ideias de nomes para o app')
      await page.evaluate(`window.__clearStore.getState().startVoiceCall('s2')`)
      await page.getByTestId('voice-call-dock').waitFor()
      await page.getByTestId('voice-call-blocking-card').waitFor()
      await page.getByTestId('ask-option').first().click()
      await shot('after-call-with-question')
      await page.getByTestId('voice-call-end').click()
      await page.getByTestId('voice-call-dock').waitFor({ state: 'detached' })
      return `aprovações acima: ${hasQueue ? 'sim' : 'sem fila neste mock'} · pergunta clicável`
    }
  )

  // ---------------- Configurações → Áudio ----------------

  await step('Configurações: abas cabem numa linha sem rolagem (1440 e 1100)', async () => {
    const out: string[] = []
    for (const [w, h] of [
      [1440, 860],
      [1100, 800]
    ] as const) {
      await setSize(w, h)
      await openAudioSettings()
      const g = await page.getByTestId('settings-tabs').evaluate((el) => {
        const box = el.getBoundingClientRect()
        const btns = [...el.querySelectorAll('button')].map((b) => b.getBoundingClientRect())
        return {
          scroll: el.scrollWidth > el.clientWidth + 1,
          rows: new Set(btns.map((b) => Math.round(b.top))).size,
          outside: btns.filter((b) => b.right > box.right + 1 || b.left < box.left - 1).length,
          labels: [...el.querySelectorAll('button')].map((b) => b.textContent)
        }
      })
      assert(!g.scroll, `rolagem horizontal em ${w}`)
      assert.equal(g.rows, 1, `abas em ${g.rows} linhas em ${w}`)
      assert.equal(g.outside, 0, `aba cortada em ${w}`)
      assert(g.labels.includes('Áudio'), 'rótulo "Áudio" inteiro')
      if (w === 1440) {
        await page
          .getByTestId('settings-tabs')
          .screenshot({ path: join(SHOTS, 'after-tabbar.png') })
        await shot('after-settings-audio')
      }
      await page.keyboard.press('Escape')
      await dialog().waitFor({ state: 'detached' })
      out.push(`${w}: 1 linha`)
    }
    return out.join(' · ')
  })

  await step(
    'Configurações → Áudio: Esc na captura da tecla do PTT NÃO fecha o modal',
    async () => {
      await openAudioSettings()
      const cap = page.getByTestId('ptt-key-capture')
      // sem tecla: push-to-talk aparece inativo
      await page.getByTestId('ptt-inactive-hint').waitFor()
      await cap.click()
      assert.match(await cap.innerText(), /Pressione a tecla/)
      await page.keyboard.press('Escape')
      await page.waitForTimeout(200)
      assert(await dialog().isVisible(), 'o modal fechou com o Esc da captura')
      assert.equal(await cap.innerText(), 'Definir tecla')
      // tecla que digita é recusada (com o motivo) e a captura continua
      await cap.click()
      await page.keyboard.press('k')
      await page.getByTestId('ptt-key-problem').waitFor()
      assert.match(await cap.innerText(), /Pressione a tecla/)
      await page.keyboard.press('F8')
      await page.waitForFunction(
        () =>
          document.querySelector('[data-testid=ptt-key-capture]')?.textContent === 'Alterar tecla'
      )
      assert.equal(await page.getByTestId('ptt-inactive-hint').count(), 0)
      // segundo Esc (sem captura) fecha o modal normalmente
      await page.keyboard.press('Escape')
      await dialog().waitFor({ state: 'detached' })
      return 'Esc → só a captura; "k" recusada; F8 salva'
    }
  )

  // ---------------- correções de uso real (callfix) ----------------

  await step(
    'ditado: ao parar, o texto já transcrito continua visível ("finalizando…") até a final',
    async () => {
      await open('chat', 'Ideias de nomes para o app')
      await composer().fill('')
      await page.getByTestId('voice-mic-button').click()
      await recording().waitFor()
      await page.waitForFunction(
        () => document.querySelector('[data-testid=voice-partial]')?.textContent?.includes('Olá'),
        undefined,
        { timeout: 4000 }
      )
      await page.getByTestId('voice-stop-button').click()
      // o mock leva ~700 ms para a final: nesse meio a parcial NÃO some
      await page.getByTestId('voice-partial-finalizing').waitFor({ timeout: 1500 })
      const ghost = await page.getByTestId('voice-partial').innerText()
      assert(ghost.includes('Olá'), `parcial sumiu ao parar: "${ghost}"`)
      assert(!/Transcrevendo/.test(ghost), 'mostrou "Transcrevendo…" no lugar do texto')
      await shot('after-dictation-finalizing')
      await page.waitForFunction(
        (t) =>
          (
            document.querySelector(
              '[data-testid="composer-column"] textarea'
            ) as HTMLTextAreaElement
          )?.value.includes(t),
        MOCK_FINAL,
        { timeout: 4000 }
      )
      await page.getByTestId('voice-partial').waitFor({ state: 'detached', timeout: 2000 })
      return 'parcial esmaecida + "finalizando…" → final no lugar'
    }
  )

  await step('chamada: transcrição ao vivo do usuário na barra (parcial → final)', async () => {
    await open('chat', 'Ideias de nomes para o app')
    await page.getByTestId('voice-call-button').click()
    await page.getByTestId('voice-call-dock').waitFor()
    await page.evaluate(() =>
      (window as any).__clearVoiceRuntime.setState({
        live: { text: 'eu queria saber se dá pra mudar o tema', state: 'partial' }
      })
    )
    const live = page.getByTestId('voice-call-live')
    await live.waitFor()
    assert.equal(await live.getAttribute('data-state'), 'partial')
    assert.match(await live.innerText(), /mudar o tema/)
    await page.evaluate(() =>
      (window as any).__clearVoiceRuntime.setState({
        live: { text: 'Eu queria saber se dá pra mudar o tema do aplicativo.', state: 'final' }
      })
    )
    await page.waitForFunction(
      () =>
        document.querySelector('[data-testid=voice-call-live]')?.getAttribute('data-state') ===
        'final'
    )
    await shot('after-call-live-transcript')
    return 'voice-call-live na linha 1 da barra'
  })

  await step(
    'chamada: painel → "Modelo da chamada" (opcional) com raciocínio auto e parâmetros',
    async () => {
      // continua na chamada do passo anterior
      await page.getByTestId('voice-call-panel-toggle').click()
      await page.getByTestId('voice-call-panel').waitFor()
      await page.getByTestId('voice-call-panel-model').locator('summary').click()
      const ed = page.getByTestId('voice-call-model-call')
      await ed.waitFor()
      await ed.getByTestId('voice-call-model-inherit-call').waitFor()
      await ed.getByTestId('model-picker').click()
      const opt = page
        .getByRole('listbox', { name: 'Modelos' })
        .locator('[role=option][data-model]')
        .first()
      await opt.waitFor({ timeout: 8000 })
      const picked = await opt.getAttribute('data-model')
      await opt.click()
      await ed.getByTestId('voice-call-model-clear-call').waitFor()
      // o chat salvo ganhou o override (voice.model) — só a chamada usa
      const voice = await page.evaluate(() => {
        const st = (window as any).__clearStore.getState()
        return st.chats.find((c: any) => c.id === st.voiceCall.chatId)?.config.voice
      })
      assert.equal(voice?.model?.model, picked)
      await shot('after-call-panel-model')
      await ed.getByTestId('voice-call-model-clear-call').click()
      await ed.getByTestId('voice-call-model-inherit-call').waitFor()
      await page.getByTestId('voice-call-end').click()
      await page.getByTestId('voice-call-dock').waitFor({ state: 'detached' })
      return `modelo da chamada: ${picked} → herdar`
    }
  )

  await step('chamada: sem violação de CSP ao tocar a fala (WAV por blob)', async () => {
    const violations: string[] = []
    const onConsole = (m: { text(): string }): void => {
      if (/Content Security Policy|media-src/i.test(m.text())) violations.push(m.text())
    }
    page.on('console', onConsole)
    await open('chat', 'Ideias de nomes para o app')
    await page.evaluate(() => {
      ;(window as any).__csp = []
      document.addEventListener('securitypolicyviolation', (e) =>
        (window as any).__csp.push(`${e.violatedDirective} ${e.blockedURI}`)
      )
    })
    await page.getByTestId('voice-call-button').click()
    await page.getByTestId('voice-call-dock').waitFor()
    // turno simulado: o mock fala 2 utterances WAV (DomAudioPlayer → blob:)
    await page.evaluate(() => (window as any).__clearMockApi.voice.call.turn({ text: 'oi' }))
    await page.waitForTimeout(3200)
    const csp = await page.evaluate(() => (window as any).__csp as string[])
    page.off('console', onConsole)
    await page.getByTestId('voice-call-end').click()
    await page.getByTestId('voice-call-dock').waitFor({ state: 'detached' })
    assert.deepEqual([...csp, ...violations], [], 'violação de CSP ao tocar áudio')
    return 'blob: liberado em media-src'
  })

  await step(
    'chamada: falha da API de voz encerra a chamada com o motivo e o composer volta',
    async () => {
      await open('voice-call-api-error', 'Ideias de nomes para o app')
      await composer().fill('rascunho guardado')
      await page.getByTestId('voice-call-button').click()
      await page.getByTestId('voice-call-dock').waitFor()
      await page.getByTestId('voice-call-dock').waitFor({ state: 'detached', timeout: 5000 })
      await page
        .getByText(/Chamada encerrada: créditos da ElevenLabs esgotados/)
        .waitFor({ timeout: 3000 })
      assert.equal(await composer().inputValue(), 'rascunho guardado', 'rascunho intacto')
      await shot('after-call-api-error')
      return 'toast "Chamada encerrada: …" + composer com o rascunho'
    }
  )

  await step(
    'persona: chamada desligada + modo do prompt no editor; chat da persona → telefone desabilitado com o motivo',
    async () => {
      await open('chat', 'Ideias de nomes para o app')
      await page.getByRole('button', { name: /^Configurações/ }).click()
      await dialog().getByRole('button', { name: 'Personas', exact: true }).click()
      const row = dialog().getByTestId('preset-row').filter({ hasText: 'Revisor de código' })
      await row.getByRole('button', { name: /Editar/ }).click()
      await dialog().getByTestId('preset-editor').waitFor()
      await dialog().getByRole('tab', { name: 'Chat' }).click()
      // a seção "Chamada de voz" (recolhida por padrão) abre pelo cabeçalho
      if (
        !(await dialog()
          .getByTestId('voice-call-enabled')
          .isVisible()
          .catch(() => false))
      )
        await dialog().getByText('Chamada de voz', { exact: true }).click()
      await dialog().getByTestId('voice-call-enabled').waitFor()
      // modo do prompt (com a chamada ligada) e depois desligar a chamada nesta persona
      const modes = dialog().getByTestId('voice-call-prompt-mode')
      await modes.locator('[data-value=replace]').click()
      assert.equal(await modes.getAttribute('data-effective'), 'replace')
      await dialog().getByTestId('voice-call-enabled').locator('[data-value=off]').click()
      await dialog().getByTestId('voice-call-disabled-note').waitFor()
      await shot('after-persona-voice-off')
      await dialog().getByRole('button', { name: 'Salvar persona' }).click()
      await page.waitForTimeout(300)
      await page.keyboard.press('Escape')
      await dialog().waitFor({ state: 'detached' })
      // o chat atual passa a vir desta persona (presetId) e herda (voice.enabled null)
      const presetId = await page.evaluate(() => {
        const st = (window as any).__clearStore.getState()
        const p = st.presets.find((x: any) => x.name === 'Revisor de código')
        const chat =
          st.chats.find((c: any) => c.id === st.activeChatId) ??
          st.chats.find((c: any) => c.title === 'Ideias de nomes para o app')
        st.patchConfig(chat.id, {
          presetId: p.id,
          voice: { ...(chat.config.voice ?? {}), enabled: null }
        })
        return p.id
      })
      const btn = page.getByTestId('voice-call-button')
      await page.waitForFunction(
        () =>
          document.querySelector('[data-testid=voice-call-button]')?.getAttribute('data-off') ===
          'persona'
      )
      assert(await btn.isDisabled(), 'telefone habilitado com a persona desligando a chamada')
      // override do chat religa
      await page.evaluate(() => {
        const st = (window as any).__clearStore.getState()
        const chat = st.chats.find((c: any) => c.title === 'Ideias de nomes para o app')
        st.patchConfig(chat.id, { voice: { ...(chat.config.voice ?? {}), enabled: true } })
      })
      await page.waitForFunction(
        () => !document.querySelector('[data-testid=voice-call-button]')?.hasAttribute('disabled')
      )
      return `persona ${presetId}: desligada → telefone desabilitado; chat religa`
    }
  )

  await step('chamada desligada globalmente → telefone some (e volta ao religar)', async () => {
    await open('chat', 'Ideias de nomes para o app')
    await page.getByTestId('voice-call-button').waitFor()
    await openAudioSettings()
    const sw = page.getByRole('switch', { name: 'Chamada de voz disponível' })
    await sw.click()
    await page.keyboard.press('Escape')
    await dialog().waitFor({ state: 'detached' })
    await page.waitForTimeout(300)
    assert.equal(await page.getByTestId('voice-call-button').count(), 0)
    await openAudioSettings()
    await page.getByRole('switch', { name: 'Chamada de voz disponível' }).click()
    await page.keyboard.press('Escape')
    await dialog().waitFor({ state: 'detached' })
    await page.getByTestId('voice-call-button').waitFor({ timeout: 2000 })
  })

  await app.close()
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
  process.exit(1)
})
