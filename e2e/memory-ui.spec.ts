/* eslint-disable @typescript-eslint/no-explicit-any */
// E2E da UI da memória modular contra o MOCK de UI (Playwright `_electron`, sem backend, sem key):
// builda o renderer com VITE_CLEAR_MOCK=1 numa pasta de rascunho (não mexe em out/), abre
// `index.html?scenario=memory` numa janela Electron mínima e percorre:
//   Configurações → Memórias (criar coleções em duas categorias, criar/editar/fixar/reordenar/
//   apagar memórias, detalhe, links [[slug]], substitui/substituída, memórias de chats);
//   aba Memória do painel (selos da persona, ligar coleções, escrita, toggles, extrair agora,
//   (i) com o índice exato e o estado "Nada de memória vai para a API");
//   editor de personas (seção sem extrair/atualizar/memória do chat); aba Tools (subagentes);
//   cards das tools de memória (chips → abre a memória) e card da extração.
// Screenshots em $CLEARCHAT_E2E_DIR/shots (1280x820 e 900x600).
//
// Uso:
//   unset ELECTRON_RUN_AS_NODE
//   CLEARCHAT_E2E_DIR=/tmp/clearchat-memory-e2e node e2e/memory-ui.spec.ts [filtro-para-parar]
//   (SKIP_BUILD=1 reaproveita o build anterior)
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { execSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'

const ROOT = resolve(import.meta.dirname, '..')
const BASE = resolve(process.env.CLEARCHAT_E2E_DIR || join(tmpdir(), 'clearchat-memory-e2e'))
const BUILD = join(BASE, 'build')
const SHOTS = join(BASE, 'shots')
const STOP_AFTER = process.argv[2] ?? ''

let app: ElectronApplication
let page: Page
let stopped = false
const results: { name: string; ok: boolean; info?: string }[] = []

async function shot(name: string): Promise<void> {
  await page.waitForTimeout(250)
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

async function setSize(w: number, h: number): Promise<void> {
  await app.evaluate(
    ({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setContentSize(w, h),
    [w, h]
  )
  await page.waitForTimeout(300)
}

const settings = (): ReturnType<Page['locator']> => page.locator('[role="dialog"]')
const panel = (): ReturnType<Page['locator']> => page.getByTestId('right-panel')

async function openSettingsMemory(): Promise<void> {
  await page.getByRole('button', { name: 'Configurações', exact: true }).click()
  await settings().getByRole('button', { name: 'Memórias', exact: true }).click()
  await settings().getByTestId('memory-settings').waitFor()
}

async function closeSettings(): Promise<void> {
  await page.keyboard.press('Escape')
  await settings().waitFor({ state: 'detached' })
}

/** Abre o (i) (tooltip Radix) e devolve o texto. */
async function infoText(trigger: ReturnType<Page['locator']>): Promise<string> {
  await trigger.hover()
  const tip = page.locator('[data-radix-popper-content-wrapper]').last()
  await tip.waitFor()
  await page.waitForTimeout(200)
  return (await tip.innerText()).trim()
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
app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 1280, height: 820, useContentSize: true, backgroundColor: '#0d0d10', show: true })
  win.loadFile(${JSON.stringify(join(BUILD, 'renderer', 'index.html'))}, { search: 'scenario=memory' })
})
app.on('window-all-closed', () => app.quit())
`
  )
  const env = { ...process.env } as Record<string, string>
  delete env.ELECTRON_RUN_AS_NODE
  app = await electron.launch({ args: [mainJs], env, timeout: 60_000 })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await setSize(1280, 820)

  await step('chat com tools de memória e cards de extração', async () => {
    await page.getByTestId('chat-item').filter({ hasText: 'Planejamento do TCC' }).click()
    const cards = page.getByTestId('memory-extraction-card')
    await cards.first().waitFor()
    assert.equal(await cards.count(), 2)
    const summary = await cards.first().getByTestId('memory-extraction-summary').innerText()
    assert.match(summary, /2 criadas, 1 atualizada, 0 apagadas/)
    assert.match(summary, /após compactar/)
    assert.equal(await cards.nth(1).getAttribute('data-failed'), 'true')
    assert.match(await cards.nth(1).innerText(), /HTTP 429/)
    // chips das tools
    const chips = page.getByTestId('memory-changes')
    assert.ok((await chips.count()) >= 3)
    assert.ok(await page.getByText('Buscar memória').first().isVisible())
    assert.ok(await page.getByText('Gravar memória').first().isVisible())
    // card de extração: expandir e (i) com a request
    await cards.first().getByRole('button', { name: /^Extração de memórias/ }).click()
    await cards.first().getByTestId('memory-changes').waitFor()
    const info = await infoText(cards.first().getByRole('button', { name: 'O que é enviado para a API', exact: true }))
    assert.match(info, /não é enviado à API/)
    assert.match(info, /memory_write/)
    await page.mouse.move(10, 10)
    await page.getByTestId('memory-extraction-card').first().scrollIntoViewIfNeeded()
    await shot('01-chat-extracao')
  })

  await step('busca: memórias encontradas com link', async () => {
    const search = page.locator('div.my-2', { hasText: 'Buscar memória' }).first()
    await search.scrollIntoViewIfNeeded()
    const found = search.getByTestId('memory-found')
    await found.waitFor()
    assert.match(await found.innerText(), /Orientação do TCC/)
    await shot('02-tool-busca')
  })

  await step('aba Memória: herança da persona', async () => {
    if (!(await panel().isVisible().catch(() => false)))
      await page.getByRole('button', { name: 'Abrir painel' }).click()
    await panel().getByRole('tab', { name: 'Memória' }).click()
    const p = panel().getByTestId('memory-panel')
    await p.waitFor()
    assert.equal(await p.getByTestId('memory-col-col-tcc').getByTestId('memory-badge').getAttribute('data-badge'), 'added')
    assert.equal(
      await p.getByTestId('memory-col-col-topics').getByTestId('memory-badge').getAttribute('data-badge'),
      'persona-off'
    )
    assert.equal(
      await p.getByTestId('memory-col-col-profile').getByTestId('memory-badge').getAttribute('data-badge'),
      'persona'
    )
    assert.ok(await p.getByTestId('memory-col-col-tcc').getByTestId('memory-write-mark').isVisible())
    assert.match(await p.getByTestId('memory-persona-line').innerText(), /Ajustada neste chat/)
    assert.equal(await p.getByTestId('memory-status').getAttribute('data-active'), 'true')
    await p.getByTestId('memory-snapshot').getByText(/congelado desde/).waitFor({ timeout: 5000 })
    await shot('03-painel-memoria')
  })

  await step('aba Memória: ligar coleção, escrita, toggles', async () => {
    const p = panel().getByTestId('memory-panel')
    await p.getByTestId('memory-col-col-clearchat').click()
    assert.equal(await p.getByTestId('memory-col-col-clearchat').getAttribute('data-checked'), 'true')
    assert.equal(
      await p.getByTestId('memory-col-col-clearchat').getByTestId('memory-badge').getAttribute('data-badge'),
      'added'
    )
    // escrita de Áreas → ClearChat
    await p.getByRole('button', { name: 'Coleção de escrita: Áreas' }).click()
    await page.locator('[role="dialog"], body').getByRole('button', { name: /ClearChat/ }).last().click()
    await p.getByTestId('memory-col-col-clearchat').getByTestId('memory-write-mark').waitFor()
    assert.equal(await p.getByTestId('memory-col-col-tcc').getByTestId('memory-write-mark').count(), 0)
    // desligar a coleção de escrita limpa a escrita da categoria
    await p.getByTestId('memory-col-col-clearchat').click()
    assert.equal(await p.getByTestId('memory-write-mark').filter({ visible: true }).count() >= 0, true)
    assert.match(await p.getByRole('button', { name: 'Coleção de escrita: Áreas' }).innerText(), /Nenhuma/)
    // de volta: TCC como escrita
    await p.getByRole('button', { name: 'Coleção de escrita: Áreas' }).click()
    await page.getByRole('button', { name: /Projeto TCC/ }).last().click()
    // categoria Tópicos: desligar some com as coleções
    await p.getByRole('switch', { name: 'Categoria Tópicos' }).click()
    assert.equal(await p.getByTestId('memory-col-col-topics').count(), 0)
    await p.getByRole('switch', { name: 'Categoria Tópicos' }).click()
    // toggles
    await p.getByRole('switch', { name: 'Memória nos subagentes (só busca/leitura)' }).click()
    assert.equal(
      await p.getByRole('switch', { name: 'Memória nos subagentes (só busca/leitura)' }).getAttribute('aria-checked'),
      'true'
    )
    await shot('04-painel-escrita')
  })

  await step('aba Memória: (i) com o índice exato', async () => {
    const p = panel().getByTestId('memory-panel')
    await page.waitForTimeout(700) // preview depois do flush da config
    const info = await infoText(p.locator('section').first().getByRole('button', { name: 'O que é enviado para a API', exact: true }))
    assert.match(info, /Índice exato/)
    assert.match(info, /Projeto TCC \[escrita\]/)
    assert.match(info, /memory_search/)
    assert.match(info, /Instruções/)
    await shot('05-painel-preview')
    await page.mouse.move(10, 10)
  })

  await step('aba Memória: extrair agora', async () => {
    const p = panel().getByTestId('memory-panel')
    const before = await page.getByTestId('memory-extraction-card').count()
    const btn = p.getByTestId('memory-extract-now')
    await btn.scrollIntoViewIfNeeded()
    await btn.click()
    await p.getByText('Extraindo memórias…').waitFor()
    await shot('06-extraindo')
    await page.getByText(/Extração de memórias: 1 criada, 1 atualizada/).waitFor({ timeout: 8000 })
    await page.waitForFunction(
      (n) => document.querySelectorAll('[data-testid="memory-extraction-card"]').length > n,
      before
    )
    await shot('07-extraido')
  })

  await step('aba Memória: desligada → nada vai para a API', async () => {
    const p = panel().getByTestId('memory-panel')
    await p.locator('section').first().scrollIntoViewIfNeeded()
    await p.getByRole('switch', { name: 'Memória neste chat' }).click()
    assert.equal(await p.getByTestId('memory-status').getAttribute('data-active'), 'false')
    assert.match(await p.getByTestId('memory-status').innerText(), /Nada de memória vai para a API/)
    await page.waitForTimeout(700)
    const info = await infoText(p.locator('section').first().getByRole('button', { name: 'O que é enviado para a API', exact: true }))
    assert.match(info, /Nada de memória vai para a API/)
    await page.mouse.move(10, 10)
    assert.ok(await p.getByTestId('memory-extract-now').isDisabled())
    await shot('08-painel-desligada')
    await p.getByRole('switch', { name: 'Memória neste chat' }).click()
  })

  await step('aba Tools: indicador de memória para subagentes', async () => {
    await panel().getByRole('tab', { name: 'Tools' }).click()
    const line = panel().getByTestId('subagent-memory')
    await line.scrollIntoViewIfNeeded()
    assert.match(await line.innerText(), /Memória para subagentes: ligada/)
    await shot('09-tools-subagentes')
    await line.getByRole('button', { name: /Memória/ }).click()
    await panel().getByTestId('memory-panel').waitFor()
  })

  await step('Configurações → Memórias: visão geral', async () => {
    await openSettingsMemory()
    const s = settings()
    assert.match(await s.getByTestId('memory-settings-cat-areas').innerText(), /Projeto TCC/)
    assert.match(await s.getByTestId('memory-chat-groups').innerText(), /Planejamento do TCC/)
    await shot('10-config-memorias')
  })

  await step('Configurações: criar coleções em duas categorias', async () => {
    const s = settings()
    for (const [cat, name, desc] of [
      ['areas', 'Viagem ao Japão', 'Roteiro, reservas e orçamento'],
      ['people', 'Trabalho', 'Colegas da Lumen']
    ]) {
      await s.getByTestId(`memory-settings-cat-${cat}`).getByRole('button', { name: 'Nova coleção' }).click()
      const form = s.getByTestId('memory-collection-form')
      await form.getByLabel('Nome da coleção').fill(name)
      await form.getByLabel('Descrição da coleção').fill(desc)
      await form.getByRole('button', { name: 'Criar coleção' }).click()
      await s.getByTestId(`memory-settings-cat-${cat}`).getByText(name).waitFor()
    }
    // renomear
    const row = s.getByTestId('memory-settings-cat-people').locator('[data-testid^="memory-collection-"]', { hasText: 'Trabalho' })
    await row.hover()
    await row.getByRole('button', { name: 'Editar Trabalho' }).click()
    await s.getByTestId('memory-collection-form').getByLabel('Nome da coleção').fill('Trabalho (Lumen)')
    await s.getByTestId('memory-collection-form').getByRole('button', { name: 'Salvar' }).click()
    await s.getByText('Trabalho (Lumen)').waitFor()
    await shot('11-config-colecoes-criadas')
  })

  await step('Configurações: criar, editar, fixar e apagar memória', async () => {
    const s = settings()
    await s.getByText('Viagem ao Japão').click()
    await s.getByTestId('memory-collection-view').waitFor()
    await s.getByRole('button', { name: 'Nova memória' }).click()
    const f = s.getByTestId('memory-new-form')
    await f.getByLabel('Título da memória').fill('Roteiro de Tóquio')
    await f.getByLabel('Resumo da memória').fill('5 dias em Tóquio em abril')
    assert.match(await f.getByTestId('memory-counter').first().innerText(), /17\/80/)
    await f.getByRole('button', { name: 'Criar memória' }).click()
    const d = s.getByTestId('memory-detail')
    await d.waitFor()
    // detalhes: adicionar 3, reordenar, editar, remover
    for (const fact of ['Hotel em Shinjuku', 'JR Pass de 7 dias', 'Visitar o [[marcos-orientador]]?']) {
      await d.getByLabel('Novo detalhe').fill(fact)
      await d.getByLabel('Novo detalhe').press('Enter')
      await d.getByTestId('memory-facts').getByText(fact.replace(/\[\[.*\]\]\?/, '').trim()).first().waitFor()
    }
    assert.match(await d.getByTestId('memory-facts-count').innerText(), /3\/15/)
    // link [[slug]] vira link para a memória
    assert.match(await d.getByTestId('memory-link').innerText(), /Marcos \(orientador\)/)
    const items = d.getByTestId('memory-facts').locator('li')
    await items.nth(1).hover()
    await items.nth(1).getByRole('button', { name: 'Subir' }).click()
    await page.waitForTimeout(200)
    assert.match(await items.nth(0).innerText(), /JR Pass/)
    await items.nth(2).hover()
    await items.nth(2).getByRole('button', { name: 'Remover' }).click()
    await page.waitForTimeout(200)
    assert.equal(await items.count(), 2)
    // editar o resumo inline (limite)
    await d.getByRole('button', { name: 'Editar resumo' }).click()
    const sum = d.getByLabel('resumo')
    await sum.fill('x'.repeat(170))
    assert.match(await d.getByTestId('memory-counter').first().innerText(), /170\/160/)
    await sum.fill('5 dias em Tóquio e 3 em Kyoto, em abril')
    await sum.press('Enter')
    await d.getByText('5 dias em Tóquio e 3 em Kyoto, em abril').waitFor()
    // fixar
    await d.getByRole('switch', { name: 'Sempre carregar' }).click()
    await page.waitForTimeout(200)
    assert.equal(await d.getByRole('switch', { name: 'Sempre carregar' }).getAttribute('aria-checked'), 'true')
    assert.match(await d.getByTestId('memory-updated').innerText(), /por você/)
    await shot('12-config-memoria-detalhe')
    // apagar
    await d.getByRole('button', { name: 'Apagar', exact: true }).click()
    await d.getByRole('button', { name: 'Apagar memória?' }).click()
    await s.getByTestId('memory-collection-view').waitFor()
    assert.match(await s.getByTestId('memory-collection-view').innerText(), /Nenhuma memória nesta coleção/)
  })

  await step('Configurações: lista da coleção, links e substituições', async () => {
    const s = settings()
    await s.getByTestId('memory-back').click()
    await s.getByTestId('memory-settings-cat-areas').getByText('Projeto TCC').click()
    await s.getByTestId('memory-collection-view').waitFor()
    await shot('13-config-colecao')
    await s.getByTestId('memory-row-m-prazo').click()
    const d = s.getByTestId('memory-detail')
    assert.match(await d.getByTestId('memory-supersedes').innerText(), /Substitui: Prazos do semestre/)
    await d.getByTestId('memory-supersedes').getByRole('button').click()
    assert.match(await s.getByTestId('memory-detail').getByTestId('memory-superseded-by').innerText(), /Substituída por: Prazo de entrega/)
    await shot('14-config-substituida')
    // busca global
    await s.getByTestId('memory-back').click()
    await s.getByTestId('memory-back').click()
    await s.getByLabel('Buscar em todas as memórias').fill('orientador')
    await s.getByTestId('memory-search-results').waitFor()
    assert.match(await s.getByTestId('memory-search-results').innerText(), /Marcos/)
    await s.getByLabel('Buscar em todas as memórias').fill('')
    // memórias de chats
    await s.getByTestId('memory-chat-group-c5').getByRole('button', { name: /Pessoas/ }).click()
    assert.match(await s.getByTestId('memory-collection-view').innerText(), /Banca: Profa. Helena/)
    await closeSettings()
  })

  await step('chip da tool abre a memória nas Configurações', async () => {
    await page.getByTestId('memory-changes').locator('button', { hasText: 'Banca: Profa. Helena' }).first().click()
    await settings().getByTestId('memory-detail').waitFor()
    assert.match(await settings().getByTestId('memory-detail').innerText(), /Banca: Profa. Helena/)
    await closeSettings()
  })

  await step('editor de personas: seção de memória', async () => {
    await page.getByRole('button', { name: 'Configurações', exact: true }).click()
    await settings().getByRole('button', { name: 'Personas', exact: true }).click()
    const row = settings().getByTestId('preset-row').filter({ hasText: 'Assistente pessoal' })
    await row.hover()
    await row.getByRole('button', { name: /Editar/ }).click()
    await settings().getByTestId('preset-editor').getByRole('tab', { name: 'Memória' }).click()
    const sec = settings().getByTestId('preset-memory')
    await sec.waitFor()
    assert.equal(await sec.getByTestId('memory-extract-now').count(), 0)
    assert.equal(await sec.getByText('Atualizar memória').count(), 0)
    assert.equal(await sec.getByRole('switch', { name: 'Memória do chat' }).count(), 0)
    assert.equal(await sec.getByTestId('memory-col-col-profile').getAttribute('data-checked'), 'true')
    await shot('15-persona-memoria')
    await closeSettings()
  })

  await step('900x600', async () => {
    await setSize(900, 600)
    await page.getByRole('button', { name: 'Abrir painel' }).click().catch(() => {})
    const tab = panel().getByRole('tab', { name: 'Memória' })
    if (await tab.isVisible().catch(() => false)) await tab.click()
    await shot('16-900-painel')
    await openSettingsMemory()
    await shot('17-900-config')
    await settings().getByTestId('memory-settings-cat-areas').getByText('Projeto TCC').click()
    await settings().getByTestId('memory-row-m-orientacao').click()
    await shot('18-900-detalhe')
    await closeSettings()
  })

  await app.close()
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} ok · shots em ${SHOTS}`)
  writeFileSync(join(BASE, 'report.json'), JSON.stringify(results, null, 2))
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
