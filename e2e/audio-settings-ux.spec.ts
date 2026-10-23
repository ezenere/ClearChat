// E2E contra o MOCK de UI (Playwright `_electron`, sem backend/chave) de Configurações → Áudio,
// seções de Transcrição (STT) e Fala (TTS): provedor cadastrado + modelo/voz descobertos (dados
// reais recortados do OpenRouter em `dev/mockVoiceCatalog.ts`), endpoint personalizado no
// "Avançado" (fechado quando há provedor), catálogos locais só nos modos Local/Híbrido (STT) e
// no backend Local (TTS), correção do id sem prefixo, seletor de voz com badges e ▶ prévia,
// ElevenLabs direto (prévia publicada pelo provedor) e "Testar voz" com sucesso (local e API — a
// CSP libera `media-src blob:`) e com erro legível.
// Curadoria da chamada: o seletor de modelo de fala só lista os modelos medidos rápidos com pt-BR
// (badge de latência), o id livre fica no "Avançado", vozes pt primeiro (recomendada marcada) e um
// modelo salvo lento mostra o aviso com a troca de um clique; STT lento ganha o badge "lento".
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

  // ---------------- STT ----------------

  await step(
    'STT (padrão, endpoint avulso): Avançado aberto com o erro da listagem visível',
    async () => {
      await openAudio('chat')
      assert.equal(
        await page.getByTestId('stt-advanced-toggle').getAttribute('aria-expanded'),
        'true'
      )
      assert(await visible('stt-base-url'), 'baseUrl do endpoint personalizado visível')
      await page.getByTestId('stt-section').getByTestId('voice-catalog-error').waitFor()
      // modo API: nada do motor local
      assert.equal(await count('stt-local-engine'), 0, 'catálogo local no modo API')
      return (
        await page.getByTestId('stt-section').getByTestId('voice-catalog-error').innerText()
      ).slice(0, 80)
    }
  )

  await step(
    'STT: provedor OpenRouter → modelos listados, id do OpenRouter e Avançado fechado',
    async () => {
      await choose('Provedor da transcrição', 'OpenRouter')
      await waitFor(
        async () =>
          (await page.getByTestId('stt-model').getAttribute('data-value')) ===
          'openai/whisper-large-v3-turbo',
        3000,
        'modelo do OpenRouter'
      )
      assert.equal(
        await page.getByTestId('stt-advanced-toggle').getAttribute('aria-expanded'),
        'false'
      )
      assert.equal(await count('stt-base-url'), 0, 'campo de endpoint no fluxo principal')
      assert.equal(await count('stt-api-key'), 0, 'campo de chave no fluxo principal')
      await page.getByTestId('voice-catalog-count').first().waitFor()
      // a lista mostra nome + id
      await page.getByRole('button', { name: 'Modelo de transcrição', exact: true }).click()
      const opts = await popover().getByRole('button').allInnerTexts()
      assert(
        opts.some((t) => t.includes('ElevenLabs: Scribe v2')),
        'Scribe na lista'
      )
      // STT não é curado: o lento continua na lista, com o badge
      assert(
        opts.some((t) => /Gemini 3\.5 Transcribe[\s\S]*lento/.test(t)),
        `STT lento sem badge: ${opts.join(' | ')}`
      )
      await page.keyboard.press('Escape')
      await scrollTo('stt-section')
      await shot('after-api-stt')
      return `${opts.length - 1} modelos`
    }
  )

  await step(
    'STT: Local mostra o motor/catálogo e esconde provedor; Híbrido mostra os dois',
    async () => {
      await choose('Modo de transcrição', /^Local/)
      assert(await visible('stt-local-engine'), 'motor local')
      assert.equal(await count('stt-api'), 0, 'provedor no modo Local')
      await scrollTo('stt-section')
      await shot('after-local-stt')
      await choose('Modo de transcrição', /^Híbrido/)
      assert(await visible('stt-local-engine'), 'motor local no híbrido')
      assert(await visible('stt-api'), 'provedor no híbrido')
      const cur = await page.getByTestId('stt-local-current').innerText()
      assert.match(cur, /parciais|reserva/)
      await choose('Modo de transcrição', /^API/)
      assert.equal(await count('stt-local-engine'), 0)
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
    await shot('after-stt-alias-corrected')
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
      await shot('after-local-tts')
    }
  )

  await step(
    'TTS API: OpenRouter com modelo/voz listados; Kokoro e endpoint somem; Avançado fechado',
    async () => {
      await page.getByTestId('tts-preset-openrouter').click()
      await page.getByTestId('tts-api').waitFor()
      assert.equal(await count('voice-models-kokoro'), 0, 'catálogo do Kokoro no modo API')
      assert.equal(
        await page.getByTestId('tts-advanced-toggle').getAttribute('aria-expanded'),
        'false'
      )
      assert.equal(await count('tts-base-url'), 0)
      await waitFor(
        async () =>
          (await page.getByTestId('tts-model').getAttribute('data-value')) ===
          'elevenlabs/eleven-flash-v2.5',
        3000,
        'modelo'
      )
      assert.equal(await page.getByTestId('tts-voice').getAttribute('data-value'), 'sarah')
      assert.match(await page.getByTestId('tts-voice').innerText(), /Sarah[\s\S]*feminina/)
      // lista curada: só os medidos para a chamada, com a latência; sem "Outro id" no menu
      await page.getByRole('button', { name: 'Modelo de fala', exact: true }).click()
      const opts = await popover().getByRole('button').allInnerTexts()
      await shot('after-api-tts-models')
      await page.keyboard.press('Escape')
      const joined = opts.join(' | ').replace(/\n/g, ' ')
      assert.match(opts[0], /Eleven Flash v2\.5[\s\S]*~0,5 s/, 'recomendado primeiro com badge')
      for (const ok of ['Fish Audio: S1', 'Grok Voice', 'MAI-Voice-2.1-Flash', 'Kokoro 82M'])
        assert(joined.includes(ok), `${ok} fora da lista: ${joined}`)
      for (const slow of ['v4 Turbo', 'Multilingual', 'Gemini', 'MAI-Voice-2 '])
        assert(!joined.includes(slow), `${slow} na lista curada: ${joined}`)
      assert(!joined.includes('Outro id'), 'id livre no menu da lista curada')
      assert(await visible('tts-model-other'), 'Avançado: outro modelo')
      await scrollTo('tts-section')
      await shot('after-api-tts')
      return `${opts.length} modelos: ${joined.slice(0, 160)}`
    }
  )

  await step('TTS: seletor de voz com badges, ▶ prévia (frase sintetizada) e escolha', async () => {
    await page.getByTestId('tts-voice').click()
    await page.getByTestId('tts-voice-menu').waitFor()
    const n = await page.locator('[data-testid^=voice-option-]').count()
    assert.equal(n, 21, `vozes do ElevenLabs Flash: ${n}`)
    // a recomendada para pt-BR vem primeiro, marcada
    const first = page.locator('[data-testid^=voice-option-]').first()
    assert.equal(await first.getAttribute('data-testid'), 'voice-option-sarah')
    assert.match(await first.innerText(), /Sarah[\s\S]*recomendada/)
    assert.match(
      await page.getByTestId('voice-option-george').innerText(),
      /George[\s\S]*masculina[\s\S]*britânico/
    )
    await shot('after-api-tts-voices')
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
    // "Outra voz (ID)"
    await page.getByTestId('tts-voice').click()
    await page.getByTestId('tts-voice-custom').fill('minha-voz-clonada')
    await page.getByTestId('tts-voice-custom-use').click()
    await waitFor(
      async () =>
        (await page.getByTestId('tts-voice').getAttribute('data-value')) === 'minha-voz-clonada',
      2000,
      'voz livre'
    )
    await page.getByTestId('tts-voice-custom-note').waitFor()
    return `${n} vozes`
  })

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
    'TTS: trocar de modelo ajusta a voz (pt-BR recomendada primeiro; sem vozes = padrão) e o id livre fica no Avançado',
    async () => {
      await choose('Modelo de fala', /MAI-Voice-2\.1-Flash/)
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
      await shot('after-tts-voices-pt-first')
      await page.keyboard.press('Escape')
      // Fish Audio não lista vozes → voz padrão do modelo
      await choose('Modelo de fala', /Fish Audio: S1/)
      await waitFor(
        async () => (await page.getByTestId('tts-voice').getAttribute('data-value')) === '',
        3000,
        'voz padrão'
      )
      assert.match(await page.getByTestId('tts-voice').innerText(), /Voz padrão da API/)
      // id livre: Avançado, marcado "não testado para chamada"
      await page.getByTestId('tts-model-other').click()
      await page.getByTestId('tts-model-untested').waitFor()
      assert.match(await page.getByTestId('tts-model-untested').innerText(), /não testado/)
      await page.getByRole('button', { name: 'Lista', exact: true }).click()
      await choose('Modelo de fala', /Eleven Flash v2\.5/)
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
      await shot('after-tts-slow-model-warning')
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
    await shot('after-tts-test-error')
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
      await page.getByRole('button', { name: 'Modelo de fala', exact: true }).click()
      const elOpts = (await popover().getByRole('button').allInnerTexts()).join(' | ')
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
      await shot('after-elevenlabs-tts')
      assert.equal(
        await page.getByTestId('tts-voice').getAttribute('data-value'),
        'EXAVITQu4vr4xnSDxMaL'
      )
      return sttOpts.join(' | ').replace(/\n/g, ' ').slice(0, 120)
    }
  )

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
