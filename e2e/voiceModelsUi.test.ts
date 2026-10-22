// Lógica nova e PURA dos modelos locais de áudio (SPEC → "Áudio → Componentes locais" e "Modelos
// locais por IPC"): formatação de tamanho/idiomas da lista (`src/renderer/src/lib/voice/modelList.ts`),
// mapeamento estado → ação do painel e a derivação de `hasLocalReady` da sessão de transcrição
// (`src/main/voice/session.ts`). Sem DOM, sem Electron, sem download. Rodar: npm run test:unit
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findCatalogEntry } from '../src/main/voice/catalog.ts'
import type { LocalModelInfo, LocalModelState } from '../src/main/voice/models.ts'
import { deriveHasLocalReady } from '../src/main/voice/session.ts'
import {
  formatModelLanguages,
  formatModelSize,
  modelAction
} from '../src/renderer/src/lib/voice/modelList.ts'

// ---------------- formatModelSize ----------------

test('formatModelSize: B/KB/MB/GB legíveis (1024, vírgula pt-BR, sem zero supérfluo)', () => {
  assert.equal(formatModelSize(0), '0 B')
  assert.equal(formatModelSize(512), '512 B')
  assert.equal(formatModelSize(1024), '1 KB')
  assert.equal(formatModelSize(1536), '1,5 KB')
  assert.equal(formatModelSize(1_048_576), '1 MB')
  assert.equal(formatModelSize(32_453_112), '30,9 MB') // vosk-model-small-pt-0.3
  assert.equal(formatModelSize(77_691_713), '74,1 MB') // ggml-tiny
  assert.equal(formatModelSize(1_073_741_824), '1 GB')
  assert.equal(formatModelSize(1_624_555_275), '1,51 GB') // ggml-large-v3-turbo
})

test('formatModelSize: valor inválido → "—" (nunca NaN)', () => {
  assert.equal(formatModelSize(NaN), '—')
  assert.equal(formatModelSize(Infinity), '—')
  assert.equal(formatModelSize(-5), '—')
})

// ---------------- formatModelLanguages ----------------

test('formatModelLanguages: "mul" = Multilíngue, comuns por extenso, desconhecidos crus', () => {
  assert.equal(formatModelLanguages([]), '—')
  assert.equal(formatModelLanguages(['mul']), 'Multilíngue')
  assert.equal(formatModelLanguages(['pt-BR']), 'Português (Brasil)')
  assert.equal(formatModelLanguages(['pt-BR', 'en-US']), 'Português (Brasil), Inglês (EUA)')
  assert.equal(formatModelLanguages(['nl']), 'nl')
})

// ---------------- modelAction (estado → ação) ----------------

test('modelAction: notInstalled → Baixar; sem URL → ação nula (placeholder de TTS)', () => {
  assert.deepEqual(modelAction('notInstalled', true), {
    action: 'download',
    label: 'Baixar',
    badge: 'não instalado',
    warning: null
  })
  assert.deepEqual(modelAction('notInstalled', false), {
    action: null,
    label: 'Baixar',
    badge: 'não instalado',
    warning: null
  })
})

test('modelAction: downloading → Cancelar; installed → Remover', () => {
  assert.deepEqual(modelAction('downloading', true), {
    action: 'cancel',
    label: 'Cancelar',
    badge: 'baixando…',
    warning: null
  })
  assert.deepEqual(modelAction('installed', true), {
    action: 'remove',
    label: 'Remover',
    badge: 'instalado',
    warning: null
  })
})

test('modelAction: corrupt → Baixar novamente com aviso (ação nula sem URL)', () => {
  const ok = modelAction('corrupt', true)
  assert.equal(ok.action, 'retry')
  assert.equal(ok.label, 'Baixar novamente')
  assert.equal(ok.badge, 'corrompido')
  assert.match(ok.warning ?? '', /baixe novamente/)
  const noUrl = modelAction('corrupt', false)
  assert.equal(noUrl.action, null)
  assert.equal(noUrl.label, 'Baixar novamente')
})

// ---------------- deriveHasLocalReady ----------------

const model = (id: string, state: LocalModelState): LocalModelInfo => {
  const entry = findCatalogEntry(id)
  assert.ok(entry, `entrada do catálogo: ${id}`)
  return { entry, state, path: null, installedBytes: null, manifest: null }
}

test('deriveHasLocalReady: modelo INSTALADO de verdade para o engine escolhido', () => {
  const models = [model('ggml-tiny', 'installed')]
  assert.equal(deriveHasLocalReady({ engine: 'whisper.cpp' }, models), true)
  // sem motor escolhido (local: null) → false
  assert.equal(deriveHasLocalReady(null, models), false)
  // engine sem modelo instalado → false
  assert.equal(deriveHasLocalReady({ engine: 'vosk' }, models), false)
})

test('deriveHasLocalReady: só o estado "installed" conta — corrupt/downloading/não instalado não', () => {
  const models = [
    model('ggml-tiny', 'corrupt'),
    model('ggml-base', 'downloading'),
    model('ggml-small', 'notInstalled')
  ]
  assert.equal(deriveHasLocalReady({ engine: 'whisper.cpp' }, models), false)
})

test('deriveHasLocalReady: modelo de TTS instalado não conta para o STT (e vice-verso)', () => {
  const models = [model('kokoro', 'installed'), model('vosk-model-small-pt-0.3', 'installed')]
  assert.equal(deriveHasLocalReady({ engine: 'vosk' }, models), true)
  assert.equal(deriveHasLocalReady({ engine: 'whisper.cpp' }, models), false)
})
