// Funções puras do ditado por voz (renderer): composição do rascunho durante a gravação (parciais
// + `▌`), separação da edição do usuário, mesclagem do texto final, rótulo/captura de tecla do
// push-to-talk e mensagens de erro de captura. Sem DOM/React. Rodar: npm run test:unit
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  captureErrorText,
  composeDictationDraft,
  DICTATION_CURSOR,
  mergeDictationDraft,
  splitDictationEdit
} from '../src/renderer/src/lib/voice/dictation.ts'
import { formatHotkeyLabel, hotkeyFromEvent } from '../src/renderer/src/lib/voice/hotkeyLabel.ts'
import { matchesHotkey } from '../src/renderer/src/lib/audio/hotkey.ts'

// ---------------- merge do texto final ----------------

test('mergeDictationDraft: junta com um espaço só quando necessário', () => {
  assert.equal(mergeDictationDraft('', 'falado'), 'falado')
  assert.equal(mergeDictationDraft('digitado', ''), 'digitado')
  assert.equal(mergeDictationDraft('Olá, ', 'tudo bem'), 'Olá, tudo bem')
  assert.equal(mergeDictationDraft('Olá,', 'tudo bem'), 'Olá, tudo bem')
  assert.equal(mergeDictationDraft('linha1\n', 'linha2'), 'linha1\nlinha2')
  assert.equal(mergeDictationDraft('', ''), '')
})

// ---------------- composição do rascunho durante a gravação ----------------

test('composeDictationDraft: parcial vira rascunho com cursor ▌; parcial vazia mostra a base', () => {
  assert.equal(composeDictationDraft('Olá, ', 'tud'), 'Olá, tud▌')
  assert.equal(composeDictationDraft('', 'tud'), `tud${DICTATION_CURSOR}`)
  assert.equal(composeDictationDraft('Olá, ', ''), 'Olá, ')
  assert.equal(composeDictationDraft('abc', 'xyz'), 'abc xyz▌')
})

// ---------------- separação da edição do usuário ----------------

test('splitDictationEdit: edição na base preserva a parcial e o sufixo', () => {
  const r = splitDictationEdit('Oi, tud▌', 'tud', 'Oi, ')
  assert.deepEqual(r, { text: 'Oi, ', partial: 'tud' })
  // edição no meio da base (o sufixo continua no fim)
  const r2 = splitDictationEdit('Oii, tud▌', 'tud', 'Oi, ')
  assert.deepEqual(r2, { text: 'Oii, ', partial: 'tud' })
  // espaço digitado antes da parcial muda o separador e ainda casa
  const r3 = splitDictationEdit('abc  xyz▌', 'xyz', 'abc')
  assert.deepEqual(r3, { text: 'abc ', partial: 'xyz' })
})

test('splitDictationEdit: mexer na parcial descarta a parcial e o ▌ órfão', () => {
  const r = splitDictationEdit('abc tu▌', 'tud', 'abc')
  assert.deepEqual(r, { text: 'abc tu', partial: '' })
  const r2 = splitDictationEdit('abc tud', 'tud', 'abc')
  assert.deepEqual(r2, { text: 'abc tud', partial: '' })
})

test('splitDictationEdit: sem parcial o valor inteiro é o texto', () => {
  assert.deepEqual(splitDictationEdit('qualquer coisa', '', 'base'), {
    text: 'qualquer coisa',
    partial: ''
  })
})

test('round-trip: compor → editar só a base → compor de novo', () => {
  const base = 'Olá, '
  const composed = composeDictationDraft(base, 'tud')
  assert.equal(composed, 'Olá, tud▌')
  const edited = splitDictationEdit(composed, 'tud', base)
  assert.equal(edited.text, base)
  assert.equal(composeDictationDraft(edited.text, edited.partial), composed)
})

// ---------------- tecla do PTT: rótulo e captura ----------------

test('formatHotkeyLabel: rótulos pt-BR com modificadores em ordem canônica', () => {
  assert.equal(formatHotkeyLabel('Ctrl+Shift+Space'), 'Ctrl + Shift + Espaço')
  assert.equal(formatHotkeyLabel('ctrl+shift+space'), 'Ctrl + Shift + Espaço')
  assert.equal(formatHotkeyLabel('F8'), 'F8')
  assert.equal(formatHotkeyLabel('Alt+K'), 'Alt + K')
  assert.equal(formatHotkeyLabel('Meta+Enter'), 'Meta + Enter')
  assert.equal(formatHotkeyLabel('Ctrl+Up'), 'Ctrl + ↑')
  assert.equal(formatHotkeyLabel('Shift+Ctrl+K'), 'Ctrl + Shift + K')
  assert.equal(formatHotkeyLabel(null), '')
  assert.equal(formatHotkeyLabel(''), '')
  // inválida não inventa rótulo
  assert.equal(formatHotkeyLabel('Ctrl+Shift'), 'Ctrl+Shift')
})

test('hotkeyFromEvent: monta a hotkey canônica; modificador solto não vale', () => {
  const ev = (
    key: string,
    mods: Partial<Record<string, boolean>> = {}
  ): {
    key: string
    ctrlKey: boolean
    shiftKey: boolean
    altKey: boolean
    metaKey: boolean
  } => ({
    key,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ...mods
  })
  assert.equal(hotkeyFromEvent(ev(' ', { ctrlKey: true, shiftKey: true })), 'Ctrl+Shift+Space')
  assert.equal(hotkeyFromEvent(ev('k', { altKey: true })), 'Alt+K')
  assert.equal(hotkeyFromEvent(ev('F8')), 'F8')
  assert.equal(hotkeyFromEvent(ev('Escape')), 'Esc')
  assert.equal(hotkeyFromEvent(ev('Control', { ctrlKey: true })), null)
  assert.equal(hotkeyFromEvent(ev('Shift', { shiftKey: true })), null)
  assert.equal(hotkeyFromEvent(ev('')), null)
})

test('hotkeyFromEvent → formatHotkeyLabel → matchesHotkey: round-trip do evento', () => {
  const ev = {
    key: ' ',
    ctrlKey: true,
    shiftKey: true,
    altKey: false,
    metaKey: false
  }
  const hotkey = hotkeyFromEvent(ev)!
  assert.equal(formatHotkeyLabel(hotkey), 'Ctrl + Shift + Espaço')
  assert.ok(matchesHotkey(ev, hotkey))
})

// ---------------- erros de captura ----------------

test('captureErrorText: permissão, microfone ausente/ocupado e passagem', () => {
  assert.match(captureErrorText('NotAllowedError: Permission denied'), /Permissão de microfone/)
  assert.match(captureErrorText('NotFoundError: Requested device not found'), /Nenhum microfone/)
  assert.match(captureErrorText('DeviceInUseError: device in use'), /em uso/)
  assert.equal(
    captureErrorText('AudioCapture: captura de áudio indisponível neste contexto'),
    'Captura de áudio indisponível neste contexto.'
  )
  assert.equal(captureErrorText('Erro desconhecido'), 'Erro desconhecido')
})
