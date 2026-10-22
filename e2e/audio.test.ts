// Testes da fundação de captura de áudio (funções puras, sem DOM): downsampling PCM (pcm.ts),
// casamento de hotkeys do push-to-talk (hotkey.ts) e política de auto-stop por silêncio
// (silence.ts). Rodar: node --import ./e2e/ts-hooks.mjs --test e2e/audio.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  concatFloat32,
  floatToPcm16,
  frameRms,
  resampleMono
} from '../src/renderer/src/lib/audio/pcm.ts'
import {
  matchesHotkey,
  parseHotkey,
  type HotkeyEvent
} from '../src/renderer/src/lib/audio/hotkey.ts'
import {
  DEFAULT_SILENCE_THRESHOLD,
  SilenceDetector
} from '../src/renderer/src/lib/audio/silence.ts'

function keyEvent(partial: Partial<HotkeyEvent> & { key: string }): HotkeyEvent {
  return { ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...partial }
}

// ---------------- downsampling / PCM (pcm.ts) ----------------

test('resampleMono: 48 kHz → 16 kHz tem 1/3 das amostras e mantém o sinal constante', () => {
  const input = new Float32Array(480).fill(0.5)
  const out = resampleMono(input, 48000, 16000)
  assert.equal(out.length, 160)
  for (const v of out) assert.equal(v, 0.5)
})

test('resampleMono: rampa 48 kHz → 16 kHz pega cada 3ª amostra (interpolação exata)', () => {
  const input = new Float32Array(480)
  for (let i = 0; i < input.length; i++) input[i] = i
  const out = resampleMono(input, 48000, 16000)
  assert.equal(out.length, 160)
  assert.equal(out[0], 0)
  assert.equal(out[10], 30)
  assert.equal(out[159], 477)
})

test('resampleMono: 44,1 kHz → 16 kHz interpola entre as amostras', () => {
  const input = new Float32Array(441)
  for (let i = 0; i < input.length; i++) input[i] = i
  const out = resampleMono(input, 44100, 16000)
  assert.equal(out.length, 160)
  // pos = i * 44100/16000 = 2,75625 → entre as amostras 2 e 3
  assert.ok(Math.abs(out[1] - 2.75625) < 1e-6)
  assert.equal(out[0], 0)
})

test('resampleMono: mesma taxa devolve cópia; entrada vazia devolve vazio; taxas inválidas lançam', () => {
  const input = new Float32Array([1, 2, 3])
  const same = resampleMono(input, 16000, 16000)
  assert.deepEqual(Array.from(same), [1, 2, 3])
  assert.notStrictEqual(same, input)
  assert.equal(resampleMono(new Float32Array(0), 48000, 16000).length, 0)
  assert.throws(() => resampleMono(input, 0, 16000))
  assert.throws(() => resampleMono(input, 48000, NaN))
  assert.throws(() => resampleMono(input, -1, 16000))
})

test('resampleMono: upsample 8 kHz → 16 kHz dobra a quantidade de amostras', () => {
  const input = new Float32Array(100).fill(0.25)
  const out = resampleMono(input, 8000, 16000)
  assert.equal(out.length, 200)
  for (const v of out) assert.ok(Math.abs(v - 0.25) < 1e-6)
})

test('floatToPcm16: faixa cheia, apara fora da faixa e converte o meio', () => {
  assert.deepEqual(Array.from(floatToPcm16(new Float32Array([0]))), [0])
  assert.deepEqual(Array.from(floatToPcm16(new Float32Array([1]))), [32767])
  assert.deepEqual(Array.from(floatToPcm16(new Float32Array([-1]))), [-32768])
  assert.deepEqual(Array.from(floatToPcm16(new Float32Array([2, -2]))), [32767, -32768])
  assert.deepEqual(Array.from(floatToPcm16(new Float32Array([0.5, -0.5]))), [16384, -16384])
})

test('frameRms: vazio = 0; constante/alternado conferem', () => {
  assert.equal(frameRms(new Float32Array(0)), 0)
  assert.equal(frameRms(new Float32Array([0])), 0)
  assert.equal(frameRms(new Float32Array([1, -1])), 1)
  assert.ok(Math.abs(frameRms(new Float32Array([0.5, -0.5])) - 0.5) < 1e-6)
})

test('concatFloat32: junta pedaços na ordem sem alterar os originais', () => {
  const a = new Float32Array([1, 2])
  const b = new Float32Array([3])
  assert.deepEqual(Array.from(concatFloat32([a, b])), [1, 2, 3])
  assert.equal(concatFloat32([]).length, 0)
  assert.deepEqual(Array.from(a), [1, 2])
})

// ---------------- hotkeys do PTT (hotkey.ts) ----------------

test('parseHotkey: modificadores + tecla, case-insensitive, aliases', () => {
  assert.deepEqual(parseHotkey('Ctrl+Shift+Space'), {
    ctrl: true,
    shift: true,
    alt: false,
    meta: false,
    key: 'space'
  })
  assert.deepEqual(parseHotkey('  f8 '), {
    ctrl: false,
    shift: false,
    alt: false,
    meta: false,
    key: 'f8'
  })
  assert.deepEqual(parseHotkey('ctrl+k'), {
    ctrl: true,
    shift: false,
    alt: false,
    meta: false,
    key: 'k'
  })
  assert.deepEqual(parseHotkey('Cmd+Enter'), {
    ctrl: false,
    shift: false,
    alt: false,
    meta: true,
    key: 'enter'
  })
  assert.deepEqual(parseHotkey('Option+Esc'), {
    ctrl: false,
    shift: false,
    alt: true,
    meta: false,
    key: 'escape'
  })
  assert.deepEqual(parseHotkey('Win+Up'), {
    ctrl: false,
    shift: false,
    alt: false,
    meta: true,
    key: 'arrowup'
  })
})

test('parseHotkey: entradas inválidas devolvem null', () => {
  assert.equal(parseHotkey(''), null)
  assert.equal(parseHotkey('   '), null)
  assert.equal(parseHotkey(null), null)
  assert.equal(parseHotkey(undefined), null)
  assert.equal(parseHotkey('Ctrl'), null) // sem tecla
  assert.equal(parseHotkey('Ctrl+Shift'), null) // modificador na posição final
  assert.equal(parseHotkey('A+B'), null) // duas teclas
  assert.equal(parseHotkey('Ctrl++'), null) // tecla '+' literal não suportada
})

test('matchesHotkey: casamento exato de tecla e modificadores', () => {
  const ev = keyEvent({ key: ' ', code: 'Space', ctrlKey: true, shiftKey: true })
  assert.ok(matchesHotkey(ev, 'Ctrl+Shift+Space'))
  assert.ok(matchesHotkey(ev, 'ctrl+shift+space')) // case-insensitive
  assert.ok(!matchesHotkey(ev, 'Ctrl+Space')) // modificador extra não casa
  assert.ok(!matchesHotkey(ev, 'Ctrl+Shift+Alt+Space')) // modificador faltando não casa
  assert.ok(!matchesHotkey(ev, 'F8'))
  assert.ok(!matchesHotkey(ev, null))
  assert.ok(!matchesHotkey(ev, 'Ctrl')) // hotkey inválida nunca casa
})

test('matchesHotkey: teclas de função, letras e aliases de tecla', () => {
  assert.ok(matchesHotkey(keyEvent({ key: 'F8' }), 'f8'))
  assert.ok(matchesHotkey(keyEvent({ key: 'K', ctrlKey: true }), 'Ctrl+K')) // caixa livre na tecla
  assert.ok(!matchesHotkey(keyEvent({ key: 'k', ctrlKey: true, altKey: true }), 'Ctrl+K'))
  assert.ok(matchesHotkey(keyEvent({ key: 'Escape' }), 'Esc'))
  assert.ok(matchesHotkey(keyEvent({ key: 'ArrowUp', metaKey: true }), 'Meta+Up'))
  assert.ok(matchesHotkey(keyEvent({ key: 'Unidentified', code: 'KeyQ' }), 'q')) // fallback no code
})

// ---------------- auto-stop por silêncio (silence.ts) ----------------

test('SilenceDetector: silêncio abaixo do limiar acumula e dispara na duração configurada', () => {
  const d = new SilenceDetector({ threshold: 0.1, silenceMs: 100 })
  assert.equal(d.push(0.05, 50), false)
  assert.equal(d.silentMs, 50)
  assert.equal(d.push(0.05, 50), true) // atingiu 100 ms contínuos
  assert.equal(d.push(0.05, 10), true) // segue disparado enquanto o silêncio continua
})

test('SilenceDetector: fala acima do limiar zera o acumulado (e o limiar é estrito)', () => {
  const d = new SilenceDetector({ threshold: 0.1, silenceMs: 100 })
  d.push(0.05, 80)
  assert.equal(d.push(0.5, 20), false) // fala → acumulado zera
  assert.equal(d.silentMs, 0)
  d.push(0.05, 80)
  assert.equal(d.push(0.1, 20), false) // rms == threshold não conta como silêncio
  assert.equal(d.silentMs, 0)
  assert.equal(d.push(0.05, 100), true) // um frame maior que a duração já dispara
})

test('SilenceDetector: silenceMs 0 (ou negativo) ignora o limite — nunca dispara', () => {
  const off = new SilenceDetector({ threshold: 0.1, silenceMs: 0 })
  assert.equal(off.push(0.001, 100000), false)
  assert.equal(off.silentMs, 0)
  const negative = new SilenceDetector({ threshold: 0.1, silenceMs: -5 })
  assert.equal(negative.push(0.001, 100000), false)
})

test('SilenceDetector: reset() zera o acumulado e a duração precisa ser contínua', () => {
  const d = new SilenceDetector({ threshold: 0.1, silenceMs: 100 })
  d.push(0.05, 90)
  d.reset()
  assert.equal(d.silentMs, 0)
  assert.equal(d.push(0.05, 90), false) // precisa de novo os 100 ms contínuos
  assert.equal(d.push(0.05, 10), true)
})

test('SilenceDetector: defaults documentados e configuração inválida cai nos defaults', () => {
  assert.equal(DEFAULT_SILENCE_THRESHOLD, 0.01)
  const d = new SilenceDetector()
  assert.equal(d.threshold, DEFAULT_SILENCE_THRESHOLD)
  assert.equal(d.silenceMs, 0) // sem duração configurada, o limite é ignorado
  const junk = new SilenceDetector({ threshold: NaN, silenceMs: NaN })
  assert.equal(junk.threshold, DEFAULT_SILENCE_THRESHOLD)
  assert.equal(junk.silenceMs, 0)
  const negative = new SilenceDetector({ threshold: -1, silenceMs: 200 })
  assert.equal(negative.threshold, DEFAULT_SILENCE_THRESHOLD)
  assert.equal(negative.silenceMs, 200)
})

test('SilenceDetector: durações de frame inválidas contam 0', () => {
  const d = new SilenceDetector({ threshold: 0.1, silenceMs: 100 })
  assert.equal(d.push(0.05, NaN), false)
  assert.equal(d.push(0.05, -5), false)
  assert.equal(d.silentMs, 0)
})
