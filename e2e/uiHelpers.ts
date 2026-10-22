// Helpers compartilhados pelos specs de UI (Playwright + Electron): screenshot de elemento e ModelPicker.
import type { Locator, Page } from 'playwright'

/**
 * Screenshot de um elemento recortado da janela, sem nunca redimensionar a viewport.
 *
 * `locator.screenshot()` de um elemento mais alto/largo que a janela usa `captureBeyondViewport`:
 * o Chromium redimensiona a viewport por alguns ms (no Electron passa até por 1×1) e o
 * `(max-width: 1179px)` do App vira "janela estreita" — o que recolhe o painel direito no meio do
 * passo (o próximo clique/fill no painel estoura o timeout). Aqui o elemento é rolado para a vista
 * e só a parte visível dele entra na imagem (`page.screenshot` com `clip` nunca mexe na viewport).
 */
export async function elementShot(page: Page, loc: Locator, path: string): Promise<void> {
  await loc.scrollIntoViewIfNeeded()
  const box = await loc.boundingBox()
  if (!box) throw new Error(`screenshot: elemento invisível (${path})`)
  const vp = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }))
  const x = Math.max(0, box.x)
  const y = Math.max(0, box.y)
  const width = Math.min(vp.w, box.x + box.width) - x
  const height = Math.min(vp.h, box.y + box.height) - y
  if (width <= 0 || height <= 0) throw new Error(`screenshot: elemento fora da janela (${path})`)
  await page.screenshot({ path, clip: { x, y, width, height } })
}

/**
 * Abre o ModelPicker (`combobox`) e escolhe o modelo `id`. Espera a busca abrir e ganhar o foco
 * antes de digitar e confere o valor digitado (sob carga, um fill antes do foco/abertura se perdia
 * ou caía no campo errado).
 */
export async function pickModel(
  page: Page,
  combobox: Locator,
  id: string,
  opts: { provider?: string } = {}
): Promise<void> {
  if ((await combobox.getAttribute('aria-expanded')) !== 'true') await combobox.click()
  const search = page.getByRole('textbox', { name: 'Buscar modelo' })
  await search.waitFor({ state: 'visible', timeout: 10_000 })
  // openList foca a busca num requestAnimationFrame: digitar antes disso perde o foco no meio
  await page.waitForFunction(
    () => document.activeElement?.getAttribute('aria-label') === 'Buscar modelo',
    undefined,
    { timeout: 5000 }
  )
  for (let i = 0; ; i++) {
    await search.fill(id)
    const v = await search.inputValue()
    if (v === id) break
    if (i >= 2) throw new Error(`busca de modelo: digitado "${id}", ficou "${v}"`)
  }
  const listbox = page.getByRole('listbox', { name: 'Modelos' })
  const sel = `[role=option]${opts.provider ? `[data-provider="${opts.provider}"]` : ''}[data-model="${id}"]`
  const opt = listbox.locator(sel).first()
  await opt.waitFor({ timeout: 15_000 })
  await opt.click()
  await listbox.waitFor({ state: 'detached', timeout: 5000 })
}
