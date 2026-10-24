// E2E contra o MOCK de UI (Playwright `_electron`, sem backend/chave) de Configurações → Áudio,
// seções de Transcrição (STT) e Fala (TTS): PROVEDOR só dos cadastrados em Configurações →
// Provedores (+ "Local — whisper.cpp/Kokoro" e "Local (GPU)"; sem campos de endereço/chave; um
// servidor local OpenAI-compatível cadastrado vale), sem provedor escolhido → "Escolha um
// provedor…" (escolher um cadastrado liga a transcrição), MODELO no mesmo
// seletor do chat (`ModelPicker`: grupos por provedor com contagem, busca "em todos os provedores
// ou digitar um ID", latência medida/"lento" à direita, escolher em outro grupo troca o provedor),
// correção do id sem prefixo, VOZ no mesmo desenho (busca, grupos por idioma, ▶ prévia por linha,
// id livre pela busca), ElevenLabs direto (prévia publicada pelo provedor), "Testar voz" com
// sucesso (local e API — a CSP libera `media-src blob:`) e com erro legível, curadoria (só os
// modelos medidos rápidos; id livre = "não testado"; salvo lento = aviso com troca de um clique) e
// a aba sem rolagem horizontal em 1440/1100.
// Cenários: `?scenario=chat|voice-alias|voice-api|voice-elevenlabs|voice-tts-fail|voice-slow-model`.
//
// Uso:
//   unset ELECTRON_RUN_AS_NODE
//   CLEARCHAT_E2E_DIR=/tmp/clearchat-audio-ux node e2e/audio-settings-ux.spec.ts [filtro-para-parar]
//   (SKIP_BUILD=1 reaproveita o build anterior)
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { execSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'
import { pickModel } from './uiHelpers.ts'

const ROOT = resolve(import.meta.dirname, '..')
const BASE = resolve(process.env.CLEARCHAT_E2E_DIR || join(tmpdir(), 'clearchat-audio-ux'))
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
    console.log(`✖ ${name} — ${(e as Error).message.split('\n').slice(0, 6).join('\n')}`)
    try {
      await shot(`FAIL-${name.replace(/[^\w]+/g, '_')}`)
    } catch {
      /* */
    }
  }
  if (STOP_AFTER && name.includes(STOP_AFTER)) stopped = true
}

const dialog = (): ReturnType<Page['locator']> => page.locator('[role="dialog"]')
const popover = (): ReturnType<Page['locator']> => page.locator('div.shadow-popover').last()

/** Abre Configurações → Áudio no cenário do mock. */
async function openAudio(scenario: string): Promise<void> {
  await page.evaluate((s) => {
    location.search = `?scenario=${s}`
  }, scenario)
  await page.waitForLoadState('domcontentloaded')
  await page.getByRole('button', { name: /^Configurações/ }).waitFor()
  await page.waitForTimeout(400)
  await page.getByRole('button', { name: /^Configurações/ }).click()
  await dialog().getByRole('button', { name: 'Áudio', exact: true }).click()
  await page.getByTestId('audio-settings').waitFor()
  await page.waitForTimeout(500)
}

/** Escolhe uma opção de um `Select` (gatilho pelo aria-label, opção pelo texto). */
async function choose(label: string, option: string | RegExp): Promise<void> {
  await page.getByRole('button', { name: label, exact: true }).click()
  await popover().getByRole('button').filter({ hasText: option }).first().click()
  await page.waitForTimeout(350)
}

/** Rola a seção até o topo da área do modal (para screenshots). */
async function scrollTo(testId: string): Promise<void> {
  await page.getByTestId(testId).evaluate((e) => e.scrollIntoView({ block: 'start' }))
  await page.waitForTimeout(200)
}

const visible = (testId: string): Promise<boolean> => page.getByTestId(testId).first().isVisible()
const count = (testId: string): Promise<number> => page.getByTestId(testId).count()

async function waitFor(fn: () => Promise<boolean>, ms: number, what: string): Promise<void> {
  const t0 = Date.now()
  for (;;) {
    if (await fn()) return
    if (Date.now() - t0 > ms) throw new Error(`timeout esperando ${what}`)
    await page.waitForTimeout(100)
  }
}

async function main(): Promise<void> {
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
  const win = new BrowserWindow({ width: 1440, height: 1000, useContentSize: true, backgroundColor: '#0d0d10', show: true })
  win.loadFile(${JSON.stringify(join(BUILD, 'renderer', 'index.html'))}, { search: 'scenario=chat' })
})
app.on('window-all-closed', () => app.quit())
`
  )
  const env = { ...process.env } as Record<string, string>
  delete env.ELECTRON_RUN_AS_NODE
  app = await electron.launch({ args: [mainJs], env, timeout: 60_000 })
  page = await app.firstWindow()
  const cspErrors: string[] = []
  page.on('console', (m) => {
    if (/Content Security Policy/i.test(m.text())) cspErrors.push(m.text())
  })
  await page.waitForLoadState('domcontentloaded')

  // ---------------- provedores: só os de Configurações → Provedores ----------------

  await step(
    'Provedor: só os cadastrados + opções locais; o Groq cadastrado é o da transcrição',
    async () => {
      await openAudio('chat')
      for (const id of [
        'stt-base-url',
        'stt-api-key',
        'stt-advanced',
        'tts-base-url',
        'tts-advanced'
      ])
        assert.equal(await count(id), 0, `${id} ainda na tela`)
      await page.getByRole('button', { name: 'Provedor da transcrição', exact: true }).click()
      const sttOpts = (await popover().getByRole('button').allInnerTexts()).map((t) =>
        t.replace(/\n/g, ' · ')
      )
      await page.keyboard.press('Escape')
      const joined = sttOpts.join(' | ')
      assert(!/personalizado/i.test(joined), `opção de endpoint: ${joined}`)
      for (const want of [
        'OpenRouter',
        'Local (LM Studio)',
        'Groq',
        'Local — whisper.cpp',
        'Local (GPU)'
      ])
        assert(joined.includes(want), `${want} fora da lista: ${joined}`)
      // servidor local OpenAI-compatível cadastrado (localhost, sem chave) vale para voz
      assert.match(joined, /Local \(LM Studio\)[^|]*servidor local/)
      // a setting aponta para o provedor cadastrado: modelo + lista do provedor
      assert.match(
        await page
          .getByRole('button', { name: 'Provedor da transcrição', exact: true })
          .innerText(),
        /Groq/
      )
      await page.getByTestId('stt-api').waitFor()
      assert.equal(
        await page.getByTestId('stt-model').getAttribute('data-value'),
        'whisper-large-v3-turbo'
      )
      await waitFor(async () => (await count('voice-catalog-count')) > 0, 3000, 'modelos do Groq')
      assert(!/personalizado/i.test(await page.getByTestId('audio-settings').innerText()))
      await scrollTo('stt-section')
      await shot('ux-01-provider')
      return joined.slice(0, 200)
    }
  )

  await step(
    'sem provedor escolhido: "Escolha um provedor…"; escolher o Groq cadastrado liga a transcrição',
    async () => {
      await openAudio('voice-not-ready')
      assert.match(
        await page
          .getByRole('button', { name: 'Provedor da transcrição', exact: true })
          .innerText(),
        /Escolha um provedor/
      )
      assert.equal(await count('stt-api'), 0, 'modelo sem provedor')
      await scrollTo('stt-section')
      await shot('ux-02-no-provider')
      // escolher o provedor cadastrado liga a transcrição (modelo sugerido da família)
      await choose('Provedor da transcrição', /^Groq/)
      await page.getByTestId('stt-api').waitFor()
      assert.equal(
        await page.getByTestId('stt-model').getAttribute('data-value'),
        'whisper-large-v3-turbo'
      )
      await openAudio('chat')
    }
  )

  // ---------------- STT: modelo no seletor do chat ----------------

  await step(
    'STT: modelo no MESMO seletor do chat — grupos por provedor com contagem, busca, "lento"',
    async () => {
      await choose('Provedor da transcrição', /^OpenRouter/)
      await waitFor(
        async () =>
          (await page.getByTestId('stt-model').getAttribute('data-value')) ===
          'openai/whisper-large-v3-turbo',
        3000,
        'modelo do OpenRouter'
      )
      await page.getByTestId('stt-model').click()
      const search = page.getByRole('textbox', { name: 'Buscar modelo' })
      await search.waitFor()
      assert.equal(
        await search.getAttribute('placeholder'),
        'Buscar em todos os provedores ou digitar um ID…'
      )
      const list = page.getByRole('listbox', { name: 'Modelos' })
      await list
        .locator('[data-testid="model-group"][data-provider="Groq"]')
        .waitFor({ timeout: 4000 })
      const groups = await list
        .locator('[data-testid="model-group"]')
        .evaluateAll((els) => els.map((e) => (e as HTMLElement).innerText.replace(/\s+/g, ' ')))
      assert(
        groups.some((g) => /^OpenRouter \d+/.test(g)),
        `grupo OpenRouter: ${groups.join(' | ')}`
      )
      assert(
        groups.some((g) => /^Groq 2/.test(g)),
        `grupo Groq com contagem: ${groups.join(' | ')}`
      )
      const gemini = list.locator('[role=option][data-model="google/gemini-3.5-transcribe"]')
      await gemini.waitFor()
      assert.match(await gemini.innerText(), /lento/)
      await shot('ux-04-stt-model-picker')
      // escolher um modelo de OUTRO grupo troca o provedor junto
      await list
        .locator('[role=option][data-provider="Groq"][data-model="whisper-large-v3"]')
        .click()
      await waitFor(
        async () =>
          /Groq/.test(
            await page
              .getByRole('button', { name: 'Provedor da transcrição', exact: true })
              .innerText()
          ),
        3000,
        'provedor trocado pelo modelo'
      )
      assert.equal(
        await page.getByTestId('stt-model').getAttribute('data-value'),
        'whisper-large-v3'
      )
      return groups.join(' | ')
    }
  )

  await step(
    'STT: Local (whisper.cpp) e "Motor local nas parciais e como reserva" (híbrido)',
    async () => {
      await choose('Provedor da transcrição', /^Local — whisper\.cpp/)
      assert(await visible('stt-local-engine'), 'motor local')
      assert.equal(await count('stt-api'), 0, 'modelo de API no modo local')
      await scrollTo('stt-section')
      await shot('ux-05-stt-local')
      await choose('Provedor da transcrição', /^OpenRouter/)
      assert.equal(await count('stt-local-engine'), 0)
      await page.getByRole('switch', { name: 'Motor local nas parciais e como reserva' }).click()
      await page.getByTestId('stt-local-engine').waitFor()
      const cur = await page.getByTestId('stt-local-current').innerText()
      assert.match(cur, /parciais|reserva/)
      await page.getByRole('switch', { name: 'Motor local nas parciais e como reserva' }).click()
      await page.getByTestId('stt-local-engine').waitFor({ state: 'detached' })
      return cur
    }
  )

  await step('STT: id sem prefixo no OpenRouter é corrigido com nota visível', async () => {
    await openAudio('voice-alias')
    await page.getByTestId('stt-model-corrected').waitFor({ timeout: 3000 })
    const note = await page.getByTestId('stt-model-corrected').innerText()
    assert.match(note, /whisper-large-v3-turbo” → “openai\/whisper-large-v3-turbo/)
    assert.equal(
      await page.getByTestId('stt-model').getAttribute('data-value'),
      'openai/whisper-large-v3-turbo'
    )
    await scrollTo('stt-section')
    await shot('ux-06-stt-alias-corrected')
    return note
  })

  // ---------------- TTS ----------------

  await step(
    'TTS Local: Kokoro + catálogo; "Testar voz" toca (sem erro, sem bloqueio da CSP)',
    async () => {
      await openAudio('chat')
      assert(await visible('tts-local'), 'motor local')
      assert(await visible('voice-models-kokoro'), 'catálogo do Kokoro')
      assert.equal(await count('tts-api'), 0)
      await page.getByTestId('tts-test').click()
      await waitFor(
        async () => (await page.getByTestId('tts-test').getAttribute('data-state')) !== 'busy',
        4000,
        'síntese'
      )
      await page.waitForTimeout(300)
      assert.equal(await count('tts-error'), 0, 'erro no Testar voz local')
      assert.equal(cspErrors.length, 0, `CSP: ${cspErrors[0]}`)
      await scrollTo('tts-section')
      await shot('ux-07-local-tts')
    }
  )

  await step(
    'TTS API: OpenRouter pelo atalho; seletor do chat com a latência medida e só os curados',
    async () => {
      await page.getByTestId('tts-preset-openrouter').click()
      await page.getByTestId('tts-api').waitFor()
      assert.equal(await count('voice-models-kokoro'), 0, 'catálogo do Kokoro no modo API')
      await waitFor(
        async () =>
          (await page.getByTestId('tts-model').getAttribute('data-value')) ===
          'elevenlabs/eleven-flash-v2.5',
        3000,
        'modelo'
      )
      assert.equal(await page.getByTestId('tts-voice').getAttribute('data-value'), 'sarah')
      await waitFor(
        async () => /Sarah[\s\S]*feminina/.test(await page.getByTestId('tts-voice').innerText()),
        4000,
        'voz Sarah com badges'
      )
      await page.getByTestId('tts-model').click()
      const list = page.getByRole('listbox', { name: 'Modelos' })
      const flash = list.locator('[role=option][data-model="elevenlabs/eleven-flash-v2.5"]')
      await flash.waitFor({ timeout: 4000 })
      assert.match(await flash.innerText(), /Eleven Flash v2\.5[\s\S]*~0,5 s/)
      const ids = await list
        .locator('[role=option][data-provider="OpenRouter"]')
        .evaluateAll((els) => els.map((e) => e.getAttribute('data-model') ?? ''))
      assert.equal(ids[0], 'elevenlabs/eleven-flash-v2.5', 'recomendado primeiro')
      for (const ok of ['fish-audio/s1', 'microsoft/mai-voice-2.1-flash'])
        assert(ids.includes(ok), `${ok} fora da lista: ${ids.join(', ')}`)
      assert(!ids.includes('elevenlabs/eleven-v4-turbo'), 'lento na lista curada')
      await shot('ux-08-tts-model-picker')
      await page.keyboard.press('Escape')
      await scrollTo('tts-section')
      await shot('ux-09-api-tts')
      return `${ids.length} modelos: ${ids.join(', ').slice(0, 160)}`
    }
  )

  await step(
    'TTS: voz no mesmo desenho — busca, grupos por idioma, ▶ prévia, id livre',
    async () => {
      await page.getByTestId('tts-voice').click()
      await page.getByTestId('tts-voice-menu').waitFor()
      const n = await page.locator('[data-testid^=voice-option-]').count()
      assert.equal(n, 21, `vozes do ElevenLabs Flash: ${n}`)
      const first = page.locator('[data-testid^=voice-option-]').first()
      assert.equal(await first.getAttribute('data-testid'), 'voice-option-sarah')
      assert.equal(
        await page
          .getByTestId('tts-voice-group-recommended')
          .getByTestId('voice-option-sarah')
          .count(),
        1,
        'Sarah no grupo das recomendadas'
      )
      assert.match(
        await page.getByTestId('voice-option-george').innerText(),
        /George[\s\S]*masculina[\s\S]*britânico/
      )
      await shot('ux-10-tts-voices')
      // busca filtra
      await page.getByTestId('tts-voice-search').fill('george')
      assert.equal(await page.locator('[data-testid^=voice-option-]').count(), 1)
      await page.getByTestId('tts-voice-search').fill('')
      await page.getByTestId('voice-preview-george').click()
      await waitFor(
        async () =>
          (await page.getByTestId('voice-preview-george').getAttribute('data-state')) !== 'busy',
        4000,
        'prévia'
      )
      assert.equal(await count('tts-preview-error'), 0, 'erro da prévia')
      await page.getByTestId('voice-option-george').click()
      await waitFor(
        async () => (await page.getByTestId('tts-voice').getAttribute('data-value')) === 'george',
        2000,
        'voz escolhida'
      )
      // id livre pela própria busca
      await page.getByTestId('tts-voice').click()
      await page.getByTestId('tts-voice-search').fill('minha-voz-clonada')
      await page.getByTestId('tts-voice-custom-use').click()
      await waitFor(
        async () =>
          (await page.getByTestId('tts-voice').getAttribute('data-value')) === 'minha-voz-clonada',
        2000,
        'voz livre'
      )
      await page.getByTestId('tts-voice-custom-note').waitFor()
      return `${n} vozes`
    }
  )

  await step('TTS API: "Testar voz" toca e os clipes mostram a contagem da voz atual', async () => {
    await page.getByTestId('tts-test').click()
    await waitFor(
      async () => (await page.getByTestId('tts-test').getAttribute('data-state')) !== 'busy',
      4000,
      'síntese'
    )
    assert.equal(await count('tts-error'), 0)
    await page.getByTestId('tts-clips-generate').click()
    await page.getByTestId('tts-clips-count').waitFor({ timeout: 6000 })
    const t = await page.getByTestId('tts-clips-count').innerText()
    assert.match(t, /15 clipes gerados para “minha-voz-clonada”/)
    return t
  })

  await step(
    'TTS: trocar de modelo ajusta a voz (pt-BR primeiro; sem vozes = padrão); id livre = "não testado"',
    async () => {
      const model = page.getByTestId('tts-model')
      await pickModel(page, model, 'microsoft/mai-voice-2.1-flash', { provider: 'OpenRouter' })
      await waitFor(
        async () =>
          (await page.getByTestId('tts-voice').getAttribute('data-value')) ===
          'pt-BR-Luana:MAI-Voice-2.1-Flash',
        3000,
        'voz pt-BR recomendada'
      )
      await page.getByTestId('tts-voice').click()
      const ids = await page
        .locator('[data-testid^=voice-option-]')
        .evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')))
      assert.deepEqual(ids.slice(0, 3), [
        'voice-option-pt-BR-Luana:MAI-Voice-2.1-Flash',
        'voice-option-pt-BR-Caio:MAI-Voice-2.1-Flash',
        'voice-option-pt-PT-Rui:MAI-Voice-2.1-Flash'
      ])
      await shot('ux-11-tts-voices-pt-first')
      await page.keyboard.press('Escape')
      // Fish Audio não lista vozes → voz padrão do modelo
      await pickModel(page, model, 'fish-audio/s1', { provider: 'OpenRouter' })
      await waitFor(
        async () => (await page.getByTestId('tts-voice').getAttribute('data-value')) === '',
        3000,
        'voz padrão'
      )
      assert.match(await page.getByTestId('tts-voice').innerText(), /Voz padrão da API/)
      // id livre pela busca do seletor ("Usar … em OpenRouter") → aviso "não testado"
      await model.click()
      await page.getByRole('textbox', { name: 'Buscar modelo' }).fill('meu/modelo-x')
      await page
        .locator('[role=option][data-free="meu/modelo-x"][data-provider="OpenRouter"]')
        .click()
      await page.getByTestId('tts-model-untested').waitFor()
      assert.match(await page.getByTestId('tts-model-untested').innerText(), /não testado/)
      await pickModel(page, model, 'elevenlabs/eleven-flash-v2.5', { provider: 'OpenRouter' })
      assert.equal(await count('tts-model-untested'), 0)
      return ids.slice(0, 3).join(', ')
    }
  )

  await step(
    'TTS: modelo salvo lento → aviso "modelo lento para chamada" com troca de um clique',
    async () => {
      await openAudio('voice-slow-model')
      await page.getByTestId('tts-model-slow').waitFor({ timeout: 3000 })
      const t = await page.getByTestId('tts-model-slow').innerText()
      assert.match(t, /Modelo lento para chamada \(medido: ~1,0 s até o 1º áudio\)/)
      assert.equal(
        await page.getByTestId('tts-model').getAttribute('data-value'),
        'elevenlabs/eleven-v4-turbo'
      )
      assert.equal(await count('tts-model-unknown'), 0, 'aviso de id desconhecido')
      await scrollTo('tts-section')
      await shot('ux-12-tts-slow-model-warning')
      await page.getByTestId('tts-model-use-recommended').click()
      await waitFor(
        async () =>
          (await page.getByTestId('tts-model').getAttribute('data-value')) ===
          'elevenlabs/eleven-flash-v2.5',
        3000,
        'troca para o recomendado'
      )
      assert.equal(await count('tts-model-slow'), 0, 'aviso continua depois da troca')
      assert.equal(await page.getByTestId('tts-voice').getAttribute('data-value'), 'sarah')
      return t.replace(/\n/g, ' ')
    }
  )

  await step('TTS: "Testar voz" com falha → aviso legível (role=alert) e dispensável', async () => {
    await openAudio('voice-tts-fail')
    await page.getByTestId('tts-test').click()
    await page.getByTestId('tts-error').waitFor({ timeout: 3000 })
    const t = await page.getByTestId('tts-error').innerText()
    assert.match(t, /Falha ao testar a voz: chave de API inválida ou sem permissão \(HTTP 401\)/)
    assert.equal(await page.getByTestId('tts-error').getAttribute('role'), 'alert')
    await scrollTo('tts-section')
    await shot('ux-13-tts-test-error')
    await page.getByRole('button', { name: 'Dispensar erro de síntese de fala' }).click()
    assert.equal(await count('tts-error'), 0)
    return t
  })

  await step(
    'ElevenLabs direto: provedor só na fala, modelos/vozes da conta com prévia publicada',
    async () => {
      await openAudio('voice-elevenlabs')
      // STT não lista o ElevenLabs (só fala)
      await page.getByRole('button', { name: 'Provedor da transcrição', exact: true }).click()
      const sttOpts = await popover().getByRole('button').allInnerTexts()
      assert(!sttOpts.some((t) => t.includes('ElevenLabs')), 'ElevenLabs na transcrição')
      await page.keyboard.press('Escape')
      await choose('Provedor da fala', /^ElevenLabs/)
      await waitFor(
        async () =>
          (await page.getByTestId('tts-model').getAttribute('data-value')) === 'eleven_flash_v2_5',
        3000,
        'modelo do ElevenLabs'
      )
      // ElevenLabs direto: só Flash/Turbo v2.5 (Multilingual da conta fica fora)
      await page.getByTestId('tts-model').click()
      const list = page.getByRole('listbox', { name: 'Modelos' })
      const el = list.locator('[role=option][data-provider="ElevenLabs"]')
      await el.first().waitFor({ timeout: 4000 })
      const elOpts = (await el.allInnerTexts()).join(' | ')
      await page.keyboard.press('Escape')
      assert.match(elOpts, /Eleven Flash v2\.5[\s\S]*~0,3 s/)
      assert.match(elOpts, /Eleven Turbo v2\.5/)
      assert(!/Multilingual/.test(elOpts), `Multilingual na lista: ${elOpts}`)
      await page.getByTestId('tts-voice').click()
      assert.match(
        await page.getByTestId('voice-option-EXAVITQu4vr4xnSDxMaL').innerText(),
        /Sarah[\s\S]*pt-BR/
      )
      // voz com pt-BR verificado antes da só-inglês (George viria antes na ordem alfabética)
      assert.equal(
        await page.locator('[data-testid^=voice-option-]').first().getAttribute('data-testid'),
        'voice-option-EXAVITQu4vr4xnSDxMaL'
      )
      await page.getByTestId('voice-preview-EXAVITQu4vr4xnSDxMaL').click()
      await waitFor(
        async () =>
          (await page
            .getByTestId('voice-preview-EXAVITQu4vr4xnSDxMaL')
            .getAttribute('data-state')) !== 'busy',
        4000,
        'prévia publicada'
      )
      assert.equal(await count('tts-preview-error'), 0)
      await page.getByTestId('voice-option-EXAVITQu4vr4xnSDxMaL').click()
      await scrollTo('tts-section')
      await shot('ux-14-elevenlabs-tts')
      assert.equal(
        await page.getByTestId('tts-voice').getAttribute('data-value'),
        'EXAVITQu4vr4xnSDxMaL'
      )
      return sttOpts.join(' | ').replace(/\n/g, ' ').slice(0, 120)
    }
  )

  await step(
    'Na chamada: WebSocket (Flash), HTTP com o motivo (v4 Turbo, OpenRouter) e o interruptor força HTTP',
    async () => {
      const text = (): Promise<string> => page.getByTestId('tts-call-transport-text').innerText()
      const ws = (): Promise<string | null> =>
        page.getByTestId('tts-call-transport').getAttribute('data-ws')
      // continua no ElevenLabs direto com o Flash v2.5 (passo anterior)
      await waitFor(async () => (await ws()) === 'true', 3000, 'WebSocket no Flash')
      assert.equal(await text(), 'Na chamada: WebSocket (texto em streaming)')
      const toggle = page.getByRole('switch', { name: 'Streaming por WebSocket' })
      assert.equal(await toggle.getAttribute('aria-checked'), 'true', 'ligado por padrão')
      await scrollTo('tts-call-transport')
      await shot('ux-15-transport-ws')
      // desligar força HTTP por frase (gravado como elevenLabsWs: false)
      await toggle.click()
      await waitFor(async () => (await ws()) === 'false', 3000, 'HTTP forçado')
      assert.equal(await text(), 'Na chamada: HTTP por frase — desligado por você')
      await shot('ux-16-transport-off')
      await toggle.click()
      await waitFor(async () => (await ws()) === 'true', 3000, 'WebSocket de volta')
      // v4 Turbo (na lista curada do ElevenLabs direto): o WebSocket não aceita → HTTP + motivo,
      // sem interruptor
      await pickModel(page, page.getByTestId('tts-model'), 'eleven_v4_turbo', {
        provider: 'ElevenLabs'
      })
      await waitFor(async () => (await ws()) === 'false', 3000, 'HTTP no v4 Turbo')
      assert.equal(await text(), 'Na chamada: HTTP por frase — o v4 Turbo não suporta WebSocket')
      assert.equal(await page.getByRole('switch', { name: 'Streaming por WebSocket' }).count(), 0)
      await shot('ux-17-transport-v4')
      // OpenRouter: HTTP por frase com o motivo
      await choose('Provedor da fala', /^OpenRouter/)
      await waitFor(async () => /OpenRouter/.test(await text()), 3000, 'motivo do OpenRouter')
      assert.equal(
        await text(),
        'Na chamada: HTTP por frase — o OpenRouter não tem WebSocket de fala'
      )
      return 'Flash → WS · desligado → HTTP · v4 Turbo → HTTP · OpenRouter → HTTP'
    }
  )

  await step('layout: aba Áudio sem rolagem horizontal em 1440 e 1100', async () => {
    await openAudio('chat')
    const out: string[] = []
    for (const [w, h] of [
      [1440, 1000],
      [1100, 800]
    ]) {
      await app.evaluate(
        ({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setContentSize(w, h),
        [w, h]
      )
      await page.waitForTimeout(400)
      const geo = await page.evaluate(() => {
        const root = document.querySelector('[data-testid="audio-settings"]') as HTMLElement
        const body = root.closest('.overflow-y-auto') as HTMLElement
        const r = root.getBoundingClientRect()
        let wide = 0
        root.querySelectorAll<HTMLElement>('*').forEach((el) => {
          if (el.getBoundingClientRect().right > r.right + 1) wide++
        })
        return { scroll: body.scrollWidth > body.clientWidth + 1, wide, width: Math.round(r.width) }
      })
      assert.equal(geo.scroll, false, `rolagem horizontal em ${w}`)
      assert.equal(geo.wide, 0, `${geo.wide} elementos estouram a aba em ${w}`)
      out.push(`${w}: ${geo.width}px`)
    }
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(1440, 1000)
    )
    return out.join(' · ')
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
