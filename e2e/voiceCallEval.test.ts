// Log de avaliação (`<userData>/voice-eval/*.jsonl`) e métricas da timeline da chamada de voz:
// schema das linhas de decisão (filler/interjeição — tocadas, sombra, descartadas), escrita
// tolerante em arquivos por dia e as métricas do painel (interjeições/min, p50/p95 decisão→áudio).
// Rodar: node --import ./e2e/ts-hooks.mjs --test e2e/voiceCallEval.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { VoiceCallTimelineEvent } from '@shared/ipc'
import { computeVoiceCallMetrics } from '@shared/voiceTimeline'
import {
  createEvalLogger,
  evalLogFile,
  normalizeEvalEvent,
  type VoiceEvalEvent
} from '../src/main/voice/evalLog.ts'

const BASE = (): VoiceEvalEvent => ({
  ts: 1_700_000_000_000,
  kind: 'interjection',
  class: 'ACK',
  variant: 2,
  played: true,
  shadow: false,
  speechMs: 1200,
  pauseMs: 500,
  tail: 'uhum, entendi',
  latencyMs: 40,
  reason: 'ok'
})

// ---------------- schema ----------------

test('normalizeEvalEvent: round-trip válido; lixo/campos inválidos viram null; tail truncado', () => {
  const e = normalizeEvalEvent(BASE())
  assert.deepEqual(e, BASE())

  assert.equal(normalizeEvalEvent(null), null)
  assert.equal(normalizeEvalEvent('x'), null)
  assert.equal(
    normalizeEvalEvent({ ...BASE(), class: 'DROP TABLE' }),
    null,
    'classe fora da whitelist'
  )
  assert.equal(normalizeEvalEvent({ ...BASE(), variant: 9 }), null, 'variante fora de 1..3')
  assert.equal(normalizeEvalEvent({ ...BASE(), kind: 'x' }), null, 'kind desconhecido')
  assert.equal(normalizeEvalEvent({ ...BASE(), ts: Number.NaN }), null, 'ts inválido')

  const long = normalizeEvalEvent({ ...BASE(), tail: 'x'.repeat(300) })
  assert.equal(long?.tail?.length, 80, 'cauda truncada')

  const rough = normalizeEvalEvent({
    ...BASE(),
    ts: 1.6,
    variant: 2.7,
    speechMs: -5,
    pauseMs: 10.2,
    latencyMs: 7.9,
    played: 1,
    shadow: 'yes',
    reason: 'r'.repeat(200)
  })
  assert.equal(rough?.ts, 2)
  assert.equal(rough?.variant, 3)
  assert.equal(rough?.speechMs, 0, 'negativo vira 0')
  assert.equal(rough?.pauseMs, 10)
  assert.equal(rough?.latencyMs, 8)
  assert.equal(rough?.played, false, 'só boolean true conta')
  assert.equal(rough?.shadow, false)
  assert.equal(rough?.reason.length, 64)
})

// ---------------- escrita ----------------

test('createEvalLogger: um JSONL por dia com UMA linha por decisão; inválido não escreve', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'clearchat-eval-'))
  try {
    const logger = createEvalLogger(dir)
    const filler: VoiceEvalEvent = {
      ...BASE(),
      kind: 'filler',
      class: 'FILLER',
      variant: 1,
      tail: null,
      speechMs: null,
      pauseMs: null
    }
    logger.log(filler)
    logger.log(BASE())
    logger.log({ ...BASE(), class: 'NOPE' } as VoiceEvalEvent) // inválido: fora
    // as escritas são serializadas numa cadeia: espera o arquivo do dia
    const file = evalLogFile(dir, new Date(BASE().ts))
    assert.equal(file, logger.file(new Date(BASE().ts)))
    let text = ''
    for (let i = 0; i < 100 && text.split('\n').filter(Boolean).length < 2; i++) {
      await new Promise((r) => setTimeout(r, 10))
      text = await readFile(file, 'utf8').catch(() => '')
    }
    const lines = text.split('\n').filter(Boolean)
    assert.equal(lines.length, 2, 'uma linha por decisão (a inválida não entra)')
    const parsed = lines.map((l) => normalizeEvalEvent(JSON.parse(l)))
    assert.equal(parsed[0]?.kind, 'filler')
    assert.equal(parsed[0]?.class, 'FILLER')
    assert.equal(parsed[0]?.speechMs, null)
    assert.equal(parsed[1]?.kind, 'interjection')
    assert.equal(parsed[1]?.tail, 'uhum, entendi')
    assert.equal(parsed[1]?.latencyMs, 40)
    assert.deepEqual(parsed[0], normalizeEvalEvent(filler))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('createEvalLogger: falha de escrita nunca propaga (diretório ilegível só chama onError)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'clearchat-eval-'))
  try {
    // um ARQUIVO no lugar do diretório raiz faz o mkdir/append falharem
    const { writeFile } = await import('node:fs/promises')
    const bad = join(dir, 'voice-eval')
    await writeFile(bad, 'não sou um diretório')
    const errors: unknown[] = []
    const logger = createEvalLogger(dir, (e) => errors.push(e))
    logger.log(BASE())
    logger.log(BASE())
    for (let i = 0; i < 100 && errors.length < 2; i++) {
      await new Promise((r) => setTimeout(r, 10))
    }
    assert.equal(errors.length, 2, 'as duas escritas falharam sem explodir')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ---------------- métricas ----------------

const ev = (
  ts: number,
  kind: VoiceCallTimelineEvent['kind'],
  extra: Partial<VoiceCallTimelineEvent> = {}
): VoiceCallTimelineEvent => ({ ts, kind, ...extra })

test('computeVoiceCallMetrics: interjeições/min, contagens e p50/p95 decisão→áudio', () => {
  const events: VoiceCallTimelineEvent[] = [
    ev(1_000, 'speech-start'),
    ev(1_100, 'pause', { pauseMs: 500 }),
    ev(1_200, 'decision', { class: 'ACK', variant: 1, played: true, id: 'u1' }),
    ev(1_250, 'clip-emitted', { class: 'ACK', id: 'u1' }),
    ev(1_300, 'clip-start', { id: 'u1' }), // 100 ms decisão→áudio
    ev(2_000, 'decision', { class: 'FILLER', variant: 2, played: true, id: 'u2' }), // filler não conta
    ev(2_010, 'clip-start', { id: 'u2' }),
    ev(3_000, 'decision', { class: 'AGREEMENT', variant: 1, played: true, id: 'u3' }),
    ev(3_120, 'clip-start', { id: 'u3' }), // 120 ms
    ev(3_200, 'decision', { class: 'THINKING', variant: 3, played: false, reason: 'shadow' }), // sombra: sem áudio
    ev(3_870, 'decision', { class: 'ACK', variant: 2, played: true, id: 'u4' }),
    ev(4_000, 'clip-start', { id: 'u4' }) // 130 ms
  ]
  const m = computeVoiceCallMetrics(events)
  assert.equal(m.elapsedMs, 3_000, '1000 → 4000')
  assert.equal(m.decisions, 4, 'decisões de interjeição (filler não conta)')
  assert.equal(m.played, 3)
  assert.equal(m.interjectionsPerMin, 80, '4 decisões em 0,05 min')
  assert.deepEqual(m.decisionToAudioMs, { p50: 120, p95: 130 })

  // sem pares (decisão sem id / áudio nunca começou) → null
  const noPairs = computeVoiceCallMetrics([
    ev(0, 'decision', { class: 'ACK', played: true, reason: 'ok' }),
    ev(1_000, 'speech-end')
  ])
  assert.equal(noPairs.decisionToAudioMs, null)
  assert.equal(noPairs.decisions, 1)
  assert.equal(noPairs.interjectionsPerMin, 60, '1 decisão em 1 s = 60/min')

  // sem eventos: zeros
  const empty = computeVoiceCallMetrics([])
  assert.equal(empty.decisions, 0)
  assert.equal(empty.interjectionsPerMin, 0)
  assert.equal(empty.decisionToAudioMs, null)

  // `now` fecha o tempo da chamada
  const short = computeVoiceCallMetrics(
    [ev(1_000, 'decision', { class: 'ACK', played: false })],
    2_000
  )
  assert.equal(short.elapsedMs, 1_000)
  assert.equal(short.interjectionsPerMin, 60)
})
