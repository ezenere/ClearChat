// Funções puras do ditado por voz (renderer): ponto de inserção do texto final (cursor do início
// do ditado ajustado às edições feitas durante a gravação), espaçamento da inserção, mesclagem de
// fallback, rótulo/captura/validação da tecla do push-to-talk e mensagens de erro de captura. Sem
// DOM/React. Rodar: npm run test:unit
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  captureErrorText,
  dictationPreview,
  insertDictationText,
  isMissingDeviceError,
  mergeDictationDraft,
  planDictationCommit,
  rebaseDictationAnchor,
  SEND_FINAL_FAILED_NOTE
} from '../src/renderer/src/lib/voice/dictation.ts'
import { formatHotkeyLabel, hotkeyFromEvent } from '../src/renderer/src/lib/voice/hotkeyLabel.ts'
import {
  matchesHotkey,
  parseHotkey,
  pttHotkeyProblem
} from '../src/renderer/src/lib/audio/hotkey.ts'

// ---------------- merge do texto final ----------------

test('mergeDictationDraft: junta com um espaço só quando necessário', () => {
  assert.equal(mergeDictationDraft('', 'falado'), 'falado')
  assert.equal(mergeDictationDraft('digitado', ''), 'digitado')
  assert.equal(mergeDictationDraft('Olá, ', 'tudo bem'), 'Olá, tudo bem')
  assert.equal(mergeDictationDraft('Olá,', 'tudo bem'), 'Olá, tudo bem')
  assert.equal(mergeDictationDraft('linha1\n', 'linha2'), 'linha1\nlinha2')
  assert.equal(mergeDictationDraft('', ''), '')
})

// ---------------- ponto de inserção do texto final ----------------

test('rebaseDictationAnchor: sem edição durante a gravação o ponto é o cursor do início', () => {
  const anchor = { text: 'Olá mundo', start: 4, end: 4 }
  assert.deepEqual(rebaseDictationAnchor(anchor, 'Olá mundo'), { start: 4, end: 4 })
  assert.deepEqual(rebaseDictationAnchor(null, 'abc'), { start: 3, end: 3 }, 'sem âncora → fim')
})

test('rebaseDictationAnchor: digitar no fim durante a gravação não desloca um cursor no meio', () => {
  const anchor = { text: 'Olá mundo', start: 4, end: 4 }
  assert.deepEqual(rebaseDictationAnchor(anchor, 'Olá mundo, tudo bem?'), { start: 4, end: 4 })
})

test('rebaseDictationAnchor: editar ANTES do cursor desloca o ponto junto', () => {
  const anchor = { text: 'abc def', start: 4, end: 4 }
  assert.deepEqual(rebaseDictationAnchor(anchor, 'XXabc def'), { start: 6, end: 6 })
  assert.deepEqual(rebaseDictationAnchor(anchor, 'bc def'), { start: 3, end: 3 })
})

test('rebaseDictationAnchor: digitar exatamente no cursor → o falado entra depois do digitado', () => {
  // cursor no fim (caso comum): o usuário continua digitando enquanto fala
  const end = { text: 'Oi', start: 2, end: 2 }
  assert.deepEqual(rebaseDictationAnchor(end, 'Oi, tudo'), { start: 8, end: 8 })
  const mid = { text: 'ab|cd', start: 2, end: 2 }
  assert.deepEqual(rebaseDictationAnchor(mid, 'abXY|cd'), { start: 4, end: 4 })
})

test('rebaseDictationAnchor: seleção do início substituída/apagada durante a gravação', () => {
  const sel = { text: 'um dois três', start: 3, end: 7 } // "dois" selecionado
  assert.deepEqual(rebaseDictationAnchor(sel, 'um dois três'), { start: 3, end: 7 })
  // o usuário apagou "dois": a região editada contém a seleção → vai para o fim da edição
  assert.deepEqual(rebaseDictationAnchor(sel, 'um  três'), { start: 3, end: 3 })
})

test('insertDictationText: espaço antes/depois só quando precisa; pontuação não ganha espaço', () => {
  assert.deepEqual(insertDictationText('', 0, 0, 'olá'), {
    value: 'olá',
    insert: 'olá',
    start: 0,
    end: 0,
    caret: 3
  })
  assert.equal(insertDictationText('Oi,', 3, 3, 'tudo bem').value, 'Oi, tudo bem')
  assert.equal(insertDictationText('Oi, ', 4, 4, 'tudo bem').value, 'Oi, tudo bem')
  assert.equal(insertDictationText('abc def', 4, 4, 'XYZ').value, 'abc XYZ def')
  assert.equal(insertDictationText('abcdef', 3, 3, 'XYZ').value, 'abc XYZ def')
  assert.equal(insertDictationText('Olá.', 3, 3, 'mundo').value, 'Olá mundo.')
  assert.equal(insertDictationText('linha1\n', 7, 7, 'linha2').value, 'linha1\nlinha2')
  // seleção é substituída
  const r = insertDictationText('um dois três', 3, 7, 'quatro')
  assert.equal(r.value, 'um quatro três')
  assert.equal(r.insert, 'quatro')
  assert.equal(r.caret, 9)
  // falado vazio não muda nada
  assert.equal(insertDictationText('abc', 1, 1, '   ').insert, '')
  // limites fora da faixa são aparados
  assert.equal(insertDictationText('abc', 99, 99, 'x').value, 'abc x')
})

test('fluxo: cursor no meio + digitação no fim durante a gravação → final no cursor original', () => {
  const start = 'Prezado , obrigado.'
  const anchor = { text: start, start: 8, end: 8 } // depois de "Prezado "
  const typed = `${start} Abraços`
  const at = rebaseDictationAnchor(anchor, typed)
  const r = insertDictationText(typed, at.start, at.end, 'João')
  assert.equal(r.value, 'Prezado João, obrigado. Abraços')
})

// ---------------- campo durante o ditado (digitado + ditado translúcido) ----------------

const joined = (p: ReturnType<typeof dictationPreview>): string =>
  p.before + p.lead + p.spoken + p.trail + p.after

test('dictationPreview: campo vazio → só o ditado (ou o marcador), sem espaços', () => {
  assert.deepEqual(dictationPreview('', { text: '', start: 0, end: 0 }, 'Ouvindo…'), {
    before: '',
    lead: '',
    spoken: 'Ouvindo…',
    trail: '',
    after: ''
  })
  assert.equal(joined(dictationPreview('', null, '  olá mundo ')), 'olá mundo')
})

test('dictationPreview: digitado + espaço + ditado (cursor no fim)', () => {
  const p = dictationPreview('Oi, tudo', { text: 'Oi, tudo', start: 8, end: 8 }, 'bem por aí')
  assert.equal(p.before, 'Oi, tudo')
  assert.equal(p.lead, ' ')
  assert.equal(p.spoken, 'bem por aí')
  assert.equal(p.after, '')
  assert.equal(joined(p), 'Oi, tudo bem por aí')
  // digitado terminando em espaço/quebra de linha: sem espaço extra; multi-linha preservado
  assert.equal(joined(dictationPreview('linha 1\n', null, 'linha 2')), 'linha 1\nlinha 2')
})

test('dictationPreview: cursor no meio → ditado no ponto de inserção, resto depois', () => {
  const t = 'Prezado , obrigado.'
  const p = dictationPreview(t, { text: t, start: 8, end: 8 }, 'João')
  assert.equal(p.before, 'Prezado ')
  assert.equal(p.spoken, 'João')
  assert.equal(p.after, ', obrigado.')
  assert.equal(joined(p), 'Prezado João, obrigado.')
  // seleção do início: a prévia já mostra a substituição
  const s = dictationPreview('um dois três', { text: 'um dois três', start: 3, end: 7 }, 'DOIS')
  assert.equal(joined(s), 'um DOIS três')
})

test('dictationPreview ≡ insertDictationText: o texto não pula ao concluir (✓)', () => {
  const cases: [string, number, number, string][] = [
    ['', 0, 0, 'olá'],
    ['abc def', 4, 4, 'XYZ'],
    ['abcdef', 3, 3, 'XYZ'],
    ['Olá.', 3, 3, 'mundo'],
    ['Oi,', 3, 3, 'tudo bem'],
    ['um dois três', 3, 7, 'DOIS'],
    ['multi\nlinha', 11, 11, 'fim']
  ]
  for (const [v, s, e, spoken] of cases)
    assert.equal(
      joined(dictationPreview(v, { text: v, start: s, end: e }, spoken)),
      insertDictationText(v, s, e, spoken).value,
      JSON.stringify([v, s, e, spoken])
    )
  // sem fala: a prévia é o próprio texto (cancelar não deixa rastro)
  assert.equal(joined(dictationPreview('abc', null, '')), 'abc')
})

// ---------------- desfecho do ditado (✓ / × / Enviar) ----------------

test('planDictationCommit: ✓ → o final entra no campo, nada é enviado', () => {
  assert.deepEqual(
    planDictationCommit({ settle: 'final', final: ' olá ', sendRequested: false, hasOther: true }),
    { insert: 'olá', send: false, note: null }
  )
})

test('planDictationCommit: × (cancelado) → o campo não muda e nada é enviado', () => {
  for (const sendRequested of [false, true])
    assert.deepEqual(
      planDictationCommit({ settle: 'cancelled', partial: 'meio', sendRequested, hasOther: true }),
      { insert: null, send: false, note: null }
    )
})

test('planDictationCommit: Enviar durante a gravação → final no campo e envia digitado + final', () => {
  assert.deepEqual(
    planDictationCommit({
      settle: 'final',
      final: 'tudo bem',
      sendRequested: true,
      hasOther: false
    }),
    { insert: 'tudo bem', send: true, note: null }
  )
  // nada foi dito: envia o que já estava digitado (se houver)
  assert.deepEqual(planDictationCommit({ settle: 'empty', sendRequested: true, hasOther: true }), {
    insert: null,
    send: true,
    note: null
  })
  assert.deepEqual(planDictationCommit({ settle: 'empty', sendRequested: true, hasOther: false }), {
    insert: null,
    send: false,
    note: null
  })
})

test('planDictationCommit: final falhou → nunca envia a parcial sozinha', () => {
  // pediu para enviar: a parcial entra no campo com aviso, sem enviar
  assert.deepEqual(
    planDictationCommit({
      settle: 'failed',
      partial: 'quase',
      sendRequested: true,
      hasOther: true
    }),
    { insert: 'quase', send: false, note: SEND_FINAL_FAILED_NOTE }
  )
  // sem pedido de envio: o card de erro oferece "Inserir o texto parcial" (nada entra sozinho)
  assert.deepEqual(
    planDictationCommit({
      settle: 'failed',
      partial: 'quase',
      sendRequested: false,
      hasOther: true
    }),
    { insert: null, send: false, note: null }
  )
  assert.deepEqual(
    planDictationCommit({ settle: 'failed', partial: '', sendRequested: true, hasOther: true }),
    { insert: null, send: false, note: null }
  )
})

test('fluxo: digitado + Enviar durante o ditado → envia o campo com o final no ponto de inserção', () => {
  const typed = 'Resumo:'
  const anchor = { text: typed, start: typed.length, end: typed.length }
  const plan = planDictationCommit({
    settle: 'final',
    final: 'três itens',
    sendRequested: true,
    hasOther: true
  })
  const at = rebaseDictationAnchor(anchor, typed)
  const sent = insertDictationText(typed, at.start, at.end, plan.insert!).value
  assert.equal(sent, 'Resumo: três itens')
  assert.equal(plan.send, true)
})

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

test('hotkeyFromEvent: PageUp/PageDown e "+" gravam tokens parseáveis (round-trip)', () => {
  const ev = (
    key: string,
    mods: Partial<Record<string, boolean>> = {}
  ): { key: string; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean } => ({
    key,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ...mods
  })
  const pgUp = hotkeyFromEvent(ev('PageUp', { ctrlKey: true }))!
  assert.equal(pgUp, 'Ctrl+PageUp')
  assert.ok(matchesHotkey(ev('PageUp', { ctrlKey: true }), pgUp))
  assert.equal(formatHotkeyLabel(pgUp), 'Ctrl + Page Up')
  const pgDn = hotkeyFromEvent(ev('PageDown', { altKey: true }))!
  assert.equal(pgDn, 'Alt+PageDown')
  assert.ok(matchesHotkey(ev('PageDown', { altKey: true }), pgDn))
  // valor antigo gravado com o rótulo ('Page Up') continua casando
  assert.ok(matchesHotkey(ev('PageUp', { ctrlKey: true }), 'Ctrl+Page Up'))
  const plus = hotkeyFromEvent(ev('+', { ctrlKey: true, shiftKey: true }))!
  assert.equal(plus, 'Ctrl+Shift+Plus')
  assert.ok(parseHotkey(plus), 'Plus é parseável')
  assert.ok(matchesHotkey(ev('+', { ctrlKey: true, shiftKey: true }), plus))
})

test('pttHotkeyProblem: exige modificador ou tecla que não digita; Esc nunca', () => {
  for (const ok of [
    'F8',
    'F1',
    'F24',
    'Ctrl+Shift+Space',
    'Alt+K',
    'Meta+Enter',
    'Ctrl+PageUp',
    'Pause',
    'ScrollLock',
    'Insert',
    'Ctrl+Plus'
  ])
    assert.equal(pttHotkeyProblem(ok), null, ok)
  for (const bad of [
    'K',
    'Space',
    'Shift+K',
    'Enter',
    'Backspace',
    'PageUp',
    'Home',
    'Up',
    'Esc',
    'Ctrl+Esc',
    'F25',
    ''
  ])
    assert.ok(pttHotkeyProblem(bad), bad)
  assert.match(pttHotkeyProblem('K')!, /F1–F24|Ctrl/)
  assert.match(pttHotkeyProblem('Esc')!, /Esc/)
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

test('captureErrorText: pelo name do DOMException (message vazia do OverconstrainedError)', () => {
  assert.match(
    captureErrorText({ name: 'OverconstrainedError', message: '' }),
    /não está disponível/
  )
  assert.match(captureErrorText({ name: 'NotReadableError', message: '' }), /em uso|desconectado/)
  assert.match(
    captureErrorText({ name: 'NotAllowedError', message: 'x' }),
    /Permissão de microfone/
  )
  assert.match(captureErrorText({ name: 'NotFoundError', message: '' }), /Nenhum microfone/)
  assert.match(captureErrorText({ name: 'SecurityError', message: '' }), /Permissão/)
  assert.equal(
    captureErrorText({ name: 'WeirdError', message: '' }),
    'Falha ao abrir o microfone (WeirdError).'
  )
  assert.equal(captureErrorText(null), 'Falha ao abrir o microfone.')
  assert.equal(
    captureErrorText(new Error('AudioCapture: falha ao carregar o worklet de captura (x)')),
    'falha ao carregar o worklet de captura (x)'
  )
})

test('isMissingDeviceError: Overconstrained/NotFound valem fallback; permissão não', () => {
  assert.ok(isMissingDeviceError({ name: 'OverconstrainedError' }))
  assert.ok(isMissingDeviceError({ name: 'NotFoundError' }))
  assert.ok(!isMissingDeviceError({ name: 'NotAllowedError' }))
  assert.ok(!isMissingDeviceError(new Error('x')))
  assert.ok(!isMissingDeviceError(null))
})

test('captureErrorText: permissão, microfone ausente/ocupado e passagem', () => {
  assert.match(captureErrorText('NotAllowedError: Permission denied'), /Permissão de microfone/)
  assert.match(captureErrorText('NotFoundError: Requested device not found'), /Nenhum microfone/)
  assert.match(captureErrorText('DeviceInUseError: device in use'), /em uso/)
  assert.match(captureErrorText('NotReadableError: Could not start audio source'), /em uso/)
  assert.equal(
    captureErrorText('AudioCapture: captura de áudio indisponível neste contexto'),
    'Captura de áudio indisponível neste contexto.'
  )
  assert.equal(captureErrorText('Erro desconhecido'), 'Erro desconhecido')
})
