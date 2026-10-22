// Atos de fala curta da chamada de voz — fillers pós-turno, interjeições/backchannel e modo
// sombra: política pura (`@shared/voicePolicy`) + `VoiceCallManager` sobre um turno MOCKADO
// (sendTurn fake + eventos do runner injetados; síntese/clipes falsos, relógio e PRNG injetáveis).
// Rodar: node --import ./e2e/ts-hooks.mjs --test e2e/voiceCallActs.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AgentEvent, ChatConfig } from '@shared/types'
import {
  DEFAULT_AUDIO_INPUT,
  DEFAULT_STT_SETTINGS,
  DEFAULT_TTS_SETTINGS,
  DEFAULT_VOICE_CALL_DEFAULTS
} from '@shared/voice'
import {
  FILLER_DELAY_MS,
  EMPTY_FILLER_STATE,
  fillerShouldFire,
  pickClipVariant,
  type FillerState
} from '@shared/voicePolicy'
import { VoiceCallManager, type VoiceCallUtterance } from '../src/main/voice/call.ts'
import {
  UtteranceQueue,
  type UtterancePlayer
} from '../src/renderer/src/lib/voice/utteranceQueue.ts'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
async function waitFor<T>(
  fn: () => T | null | undefined | false,
  ms = 3000,
  what = ''
): Promise<T> {
  const t0 = Date.now()
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}`)
    await sleep(5)
  }
}

// ---------------- turno mockado (runner fake) ----------------

interface HarnessOpts {
  /** `fillers.enabled` resolvido (padrão true). */
  fillers?: boolean
  /** `interjections.shadow` resolvido (padrão false). */
  shadow?: boolean
  /** PRNG do manager (padrão Math.random). */
  rng?: () => number
  /** Espera do filler em ms (padrão 25 — o limiar de 1,2 s é testado na política pura). */
  fillerDelayMs?: number
  /** Relógio fake (só avança com `advance`) — expiração/cooldown determinísticos. */
  fakeClock?: boolean
  /** Clipes só resolvem quando `openClip()` libera (testa corrida resposta × filler). */
  gateClips?: boolean
  /** Clip dep devolve null (clipes não gerados). */
  noClips?: boolean
}

interface Harness {
  m: VoiceCallManager
  /** Turnos enviados pelo `sendTurn` (caminho do composer). */
  sent: string[]
  /** Utterances emitidas ao renderer (sentenças + clipes). */
  emitted: VoiceCallUtterance[]
  /** Ids cancelados pelo `emitUtteranceCancel`. */
  cancelled: string[]
  /** Tentativas de clipe (classe + variante), na ordem. */
  clips: { cls: string; n: number }[]
  emit(e: AgentEvent): void
  advance(ms: number): void
  openClip(): void
}

function harness(opts: HarnessOpts = {}): Harness {
  const listeners: ((e: AgentEvent) => void)[] = []
  const sent: string[] = []
  const emitted: VoiceCallUtterance[] = []
  const cancelled: string[] = []
  const clips: { cls: string; n: number }[] = []
  let clock = 1_000_000
  let clipGate: { open: () => void } | null = null
  const defaults = {
    ...DEFAULT_VOICE_CALL_DEFAULTS,
    fillers: { enabled: opts.fillers !== false, prompt: null },
    interjections: { ...DEFAULT_VOICE_CALL_DEFAULTS.interjections, shadow: opts.shadow === true }
  }
  const m = new VoiceCallManager({
    sendTurn: (_sid, text) => sent.push(text),
    synth: async (text) => ({ audio: new TextEncoder().encode(`WAV:${text}`), mime: 'audio/wav' }),
    emitState: () => {},
    emitUtterance: (u) => emitted.push(u),
    emitUtteranceCancel: (id) => cancelled.push(id),
    clip: async (cls, n) => {
      clips.push({ cls, n })
      if (opts.gateClips) await new Promise<void>((r) => (clipGate = { open: r }))
      if (opts.noClips) return null
      return { audio: new TextEncoder().encode(`CLIP:${cls}_${n}`), mime: 'audio/wav' }
    },
    sessionInfo: () => ({ chatId: 'c1', depth: 0, busy: false }),
    chatConfig: () => ({}) as ChatConfig,
    settings: () => ({
      defaults,
      audioInput: DEFAULT_AUDIO_INPUT,
      stt: DEFAULT_STT_SETTINGS,
      tts: DEFAULT_TTS_SETTINGS
    }),
    onEvent: (cb) => {
      listeners.push(cb)
      return () => {}
    },
    now: () => (opts.fakeClock ? clock : Date.now()),
    rng: opts.rng,
    fillerDelayMs: opts.fillerDelayMs ?? 25
  })
  m.start('s1')
  return {
    m,
    sent,
    emitted,
    cancelled,
    clips,
    emit: (e) => listeners.forEach((l) => l(e)),
    advance: (ms) => {
      clock += ms
    },
    openClip: () => clipGate?.open()
  }
}

// eventos do runner (só os campos que o manager consome)
const userMsg = (text: string): AgentEvent =>
  ({
    type: 'message-added',
    message: { sessionId: 's1', message: { role: 'user', content: text } }
  }) as unknown as AgentEvent
const assistantMsg = (text: string): AgentEvent =>
  ({
    type: 'message-added',
    message: { sessionId: 's1', message: { role: 'assistant', content: text } }
  }) as unknown as AgentEvent
const draft = (content: string): AgentEvent =>
  ({ type: 'draft', sessionId: 's1', draft: { content } }) as unknown as AgentEvent
const toolRunning = (running: boolean): AgentEvent =>
  ({ type: 'tool-running', sessionId: 's1', toolCallId: 't1', running }) as unknown as AgentEvent
const responseDone = (): AgentEvent =>
  ({ type: 'session-updated', session: { id: 's1', status: 'idle' } }) as unknown as AgentEvent

/** Fala falada → transcrição final vira turno (como o renderer faz). */
function speakTurn(h: Harness, text: string): void {
  h.m.speechBegin()
  h.m.speechEnd()
  h.m.turn(text)
}

// ---------------- política pura: fillers ----------------

test('fillerShouldFire: limiar de FILLER_DELAY_MS (1200 ms), tools disparam já, 1 por turno', () => {
  assert.equal(FILLER_DELAY_MS, 1200, 'limiar documentado: ~1,2 s')
  const base: FillerState = {
    ...EMPTY_FILLER_STATE,
    turnStartedAt: 1000,
    responseInFlight: true,
    enabled: true
  }
  assert.equal(fillerShouldFire(base, 1000 + FILLER_DELAY_MS - 1), false, 'antes do limiar')
  assert.equal(fillerShouldFire(base, 1000 + FILLER_DELAY_MS), true, 'no limiar')
  assert.equal(fillerShouldFire({ ...base, toolsRunning: true }, 1001), true, 'tools: já')
  assert.equal(
    fillerShouldFire({ ...base, usedThisTurn: true }, 1000 + FILLER_DELAY_MS),
    false,
    'máx. 1 por turno'
  )
  assert.equal(
    fillerShouldFire({ ...base, spokenThisTurn: true }, 1000 + FILLER_DELAY_MS),
    false,
    'nunca depois da 1ª fala do agente'
  )
  assert.equal(fillerShouldFire({ ...base, enabled: false }, 2000), false, 'fillers desligados')
  assert.equal(
    fillerShouldFire({ ...base, responseInFlight: false }, 2000),
    false,
    'sem resposta em voo'
  )
  assert.equal(
    fillerShouldFire({ ...base, turnStartedAt: null }, 2000),
    false,
    'sem turno em andamento'
  )
  assert.equal(fillerShouldFire(base, 1000 + 50, 50), true, 'delayMs configurável')
})

test('pickClipVariant: uniforme 1..3, rotação sem repetir a última, rng lixo é aparado', () => {
  assert.equal(
    pickClipVariant(() => 0, null),
    1
  )
  assert.equal(
    pickClipVariant(() => 0.5, null),
    2
  )
  assert.equal(
    pickClipVariant(() => 0.99, null),
    3
  )
  // sorteou a última → a seguinte na rotação
  assert.equal(
    pickClipVariant(() => 0.99, 3),
    1
  )
  assert.equal(
    pickClipVariant(() => 0, 1),
    2
  )
  assert.equal(
    pickClipVariant(() => 0.5, 2),
    3
  )
  // lixo/fora de faixa nunca sai de 1..variants
  assert.equal(
    pickClipVariant(() => 1.5, null),
    3
  )
  assert.equal(
    pickClipVariant(() => -1, null),
    1
  )
  assert.equal(pickClipVariant(() => Number.NaN, null, 3) >= 1, true)
  assert.equal(
    pickClipVariant(() => 0.5, null, 1),
    1,
    'uma variante só'
  )
})

// ---------------- fillers no turno mockado ----------------

test('filler: resposta muda por ~delay toca UM clipe FILLER; a 1ª sentença o cancela', async () => {
  const h = harness({ fillerDelayMs: 25 })
  speakTurn(h, 'algo')
  h.emit(userMsg('algo')) // o runner persiste a mensagem do usuário (rearma o filler, como no real)
  assert.deepEqual(h.sent, ['algo'])
  await waitFor(() => h.emitted.length > 0, 2000, 'filler emitido')
  assert.equal(h.emitted[0].kind, 'filler')
  assert.equal(
    new TextDecoder().decode(h.emitted[0].audio),
    `CLIP:FILLER_${h.clips[0].n}`,
    'o clipe tocado é o sorteado'
  )

  // a resposta começa → a utterance do filler é cancelada e a sentença toca
  h.emit(draft('Primeira frase.'))
  h.emit(assistantMsg('Primeira frase.'))
  await waitFor(() => h.emitted.length > 1, 2000, 'sentença emitida')
  assert.equal(h.emitted[1].kind, 'sentence')
  assert.deepEqual(h.cancelled, [h.emitted[0].id], 'começo da resposta cancela o filler')

  // máximo 1 por turno (o tempo segue passando e nada mais sai)
  await sleep(80)
  assert.equal(h.emitted.filter((u) => u.kind === 'filler').length, 1)
  h.m.stop()
})

test('filler: resposta rápida (1ª sentença antes do limiar) não toca filler', async () => {
  const h = harness({ fillerDelayMs: 40 })
  speakTurn(h, 'algo')
  h.emit(draft('Resposta imediata.'))
  h.emit(assistantMsg('Resposta imediata.'))
  await waitFor(() => h.emitted.length > 0, 2000, 'sentença emitida')
  assert.equal(h.emitted[0].kind, 'sentence')
  await sleep(120)
  assert.equal(h.emitted.filter((u) => u.kind === 'filler').length, 0, 'sem filler')
  assert.equal(h.clips.length, 0, 'nem carregou o clipe')
  h.m.stop()
})

test('filler: tools em execução disparam o filler já (sem esperar o limiar)', async () => {
  const h = harness({ fillerDelayMs: 5000 })
  speakTurn(h, 'algo')
  h.emit(toolRunning(true))
  await waitFor(() => h.emitted.length > 0, 2000, 'filler emitido no tool-running')
  assert.equal(h.emitted[0].kind, 'filler')
  await sleep(60)
  assert.equal(h.emitted.filter((u) => u.kind === 'filler').length, 1, 'máx. 1 por turno')
  h.m.stop()
})

test('filler: fillers desligados não tocam; modo sombra decide mas não toca', async () => {
  const off = harness({ fillers: false, fillerDelayMs: 15 })
  speakTurn(off, 'a')
  await sleep(80)
  assert.equal(off.emitted.length, 0)
  assert.equal(off.clips.length, 0, 'desligado não carrega clipe')
  off.m.stop()

  const shadow = harness({ shadow: true, fillerDelayMs: 15 })
  speakTurn(shadow, 'a')
  await sleep(80)
  assert.equal(shadow.emitted.length, 0, 'sombra: não toca')
  assert.equal(shadow.clips.length, 1, 'sombra: decide (carrega o clipe que tocaria)')
  shadow.m.stop()
})

test('filler: variante sorteada com rotação sem repetir a última entre turnos', async () => {
  const h = harness({ fillerDelayMs: 15, rng: () => 0.99 }) // sorteio sempre na variante 3
  speakTurn(h, 'um')
  await waitFor(() => h.emitted.length > 0, 2000, '1º filler')
  assert.equal(h.clips[0].n, 3)
  // resposta termina e o turno seguinte vem: sorteou a última de novo → rotação para a 1
  h.emit(assistantMsg('ok'))
  await waitFor(() => h.emitted.some((u) => u.kind === 'sentence'), 2000, 'resposta falada')
  h.m.playbackIdle() // a fila do renderer esvaziou (fim da reprodução)
  h.emit(responseDone())
  speakTurn(h, 'dois')
  await waitFor(() => h.emitted.filter((u) => u.kind === 'filler').length > 1, 2000, '2º filler')
  const fillerClips = h.clips.filter((c) => c.cls === 'FILLER')
  assert.deepEqual(
    fillerClips.map((c) => c.n),
    [3, 1]
  )
  h.m.stop()
})

test('filler: clipe ausente (não gerado) não toca nem erro; stop cancela filler tocando', async () => {
  const none = harness({ noClips: true, fillerDelayMs: 15 })
  speakTurn(none, 'a')
  await sleep(80)
  assert.equal(none.emitted.length, 0)
  assert.equal(none.m.state().error, null, 'clip ausente não é erro')
  none.m.stop()

  // stop no meio do filler: o clipe tocando é cancelado
  const h = harness({ fillerDelayMs: 15 })
  speakTurn(h, 'a')
  await waitFor(() => h.emitted.length > 0, 2000, 'filler emitido')
  h.m.stop()
  assert.deepEqual(h.cancelled, [h.emitted[0].id])
})

test('filler: carga de clipe em voo descartada quando a 1ª sentença chega primeiro', async () => {
  const h = harness({ fillerDelayMs: 15, gateClips: true })
  speakTurn(h, 'a')
  await waitFor(() => h.clips.length > 0, 2000, 'carga do clipe iniciada')
  // resposta chega ANTES do clipe resolver
  h.emit(draft('Cheguei primeiro.'))
  h.emit(assistantMsg('Cheguei primeiro.'))
  await waitFor(() => h.emitted.length > 0, 2000, 'sentença emitida')
  assert.equal(h.emitted[0].kind, 'sentence')
  h.openClip()
  await sleep(50)
  assert.equal(h.emitted.filter((u) => u.kind === 'filler').length, 0, 'filler descartado')
  h.m.stop()
})

// ---------------- fila de utterances: drop (cancela só a utterance alvo) ----------------

test('UtteranceQueue.drop: cancela só a utterance alvo (tocando ou na fila)', () => {
  const players: (UtterancePlayer & { id: string })[] = []
  const log: string[] = []
  const factory = (audio: Uint8Array): UtterancePlayer => {
    const id = new TextDecoder().decode(audio)
    const p: UtterancePlayer & { id: string } = {
      id,
      play: () => log.push(`play:${id}`),
      pause: () => log.push(`pause:${id}`),
      onended: null,
      onerror: null,
      volume: 1
    }
    players.push(p)
    return p
  }
  const q = new UtteranceQueue({ playerFactory: factory })
  const u = (id: string): { id: string; audio: Uint8Array; mime: string; kind: 'filler' } => ({
    id,
    audio: new TextEncoder().encode(id),
    mime: 'audio/wav',
    kind: 'filler'
  })
  q.enqueue(u('a'))
  q.enqueue(u('b'))
  q.enqueue(u('c'))
  assert.equal(q.pending, 2)
  q.drop('a') // tocando → pausa e avança
  assert.deepEqual(log, ['play:a', 'pause:a', 'play:b'])
  q.drop('c') // na fila → só descarta
  assert.equal(q.pending, 0)
  players[1].onended!()
  assert.equal(q.state, 'idle')
  q.drop('zzz') // id desconhecido: sem efeito
  assert.equal(q.state, 'idle')
})
