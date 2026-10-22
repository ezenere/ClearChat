// Atos de fala curta da chamada de voz — fillers pós-turno, interjeições/backchannel e modo
// sombra: política pura (`@shared/voicePolicy`) + `VoiceCallManager` sobre um turno MOCKADO
// (sendTurn fake + eventos do runner injetados; síntese/clipes falsos, relógio e PRNG injetáveis).
// Rodar: node --import ./e2e/ts-hooks.mjs --test e2e/voiceCallActs.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AgentEvent, ChatConfig } from '@shared/types'
import type { VoiceCallTimelineEvent } from '@shared/ipc'
import {
  DEFAULT_AUDIO_INPUT,
  DEFAULT_INTERJECTION_POLICY,
  DEFAULT_STT_SETTINGS,
  DEFAULT_TTS_SETTINGS,
  DEFAULT_VOICE_CALL_DEFAULTS,
  type InterjectionPolicy
} from '@shared/voice'
import {
  BACKCHANNEL_MAX_MS,
  EMPTY_FILLER_STATE,
  FILLER_DELAY_MS,
  INTERJECTION_MAX_AGE_MS,
  InterjectionWatcher,
  PlaybackHold,
  SpeechMeter,
  classifyInterjectionTail,
  decideInterjection,
  fillerShouldFire,
  pickClipVariant,
  type FillerState,
  type InterjectionContext,
  type InterjectionObservation
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
  /** Overrides da política de interjeições (cooldown/probabilidade/classes/min*). */
  interjections?: Partial<InterjectionPolicy>
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
  /** Eventos da timeline emitidos pelo manager. */
  timeline: VoiceCallTimelineEvent[]
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
  const timeline: VoiceCallTimelineEvent[] = []
  let clock = 1_000_000
  let clipGate: { open: () => void } | null = null
  const defaults = {
    ...DEFAULT_VOICE_CALL_DEFAULTS,
    fillers: { enabled: opts.fillers !== false, prompt: null },
    interjections: {
      ...DEFAULT_INTERJECTION_POLICY,
      shadow: opts.shadow === true,
      ...(opts.interjections ?? {})
    }
  }
  const m = new VoiceCallManager({
    sendTurn: (_sid, text) => sent.push(text),
    synth: async (text) => ({ audio: new TextEncoder().encode(`WAV:${text}`), mime: 'audio/wav' }),
    emitState: () => {},
    emitUtterance: (u) => emitted.push(u),
    emitUtteranceCancel: (id) => cancelled.push(id),
    emitTimeline: (e) => timeline.push({ ...e }),
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
    timeline,
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

// ---------------- política pura: interjeições ----------------

const P: InterjectionPolicy = { ...DEFAULT_INTERJECTION_POLICY }
const obs = (over: Partial<InterjectionObservation> = {}): InterjectionObservation => ({
  speechMs: 1000,
  pauseMs: 500,
  tail: 'sim',
  observedAt: 1_000,
  ...over
})
const ctx = (over: Partial<InterjectionContext> = {}): InterjectionContext => ({
  now: 1_000,
  lastFiredAt: null,
  ...over
})
/** PRNG fake: consome a sequência e repete o último valor. */
const rngSeq = (...vals: number[]): (() => number) => {
  let i = 0
  return () => vals[Math.min(i++, vals.length - 1)]
}

test('decideInterjection: portões — desligada, observação velha, fala curta, pausa curta, cooldown', () => {
  // habilitada + tudo ok + rng 0 → dispara a classe da cauda ('sim' → AGREEMENT)
  const ok = decideInterjection(obs(), P, ctx(), rngSeq(0))
  assert.equal(ok.class, 'AGREEMENT')
  assert.equal(ok.class === 'AGREEMENT' && ok.variant >= 1, true)

  assert.deepEqual(decideInterjection(obs(), { ...P, enabled: false }, ctx(), rngSeq(0)), {
    class: 'NONE',
    reason: 'disabled'
  })
  // expiração: > 600 ms desde a observação é tarde demais; no limite ainda decide
  assert.equal(
    decideInterjection(obs(), P, ctx({ now: 1_000 + INTERJECTION_MAX_AGE_MS + 1 }), rngSeq(0))
      .reason,
    'stale'
  )
  assert.equal(
    decideInterjection(obs(), P, ctx({ now: 1_000 + INTERJECTION_MAX_AGE_MS }), rngSeq(0)).reason,
    'ok'
  )
  assert.equal(
    decideInterjection(obs({ speechMs: 699 }), P, ctx(), rngSeq(0)).reason,
    'short-speech'
  )
  assert.equal(decideInterjection(obs({ pauseMs: 449 }), P, ctx(), rngSeq(0)).reason, 'short-pause')
  assert.equal(
    decideInterjection(obs(), P, ctx({ lastFiredAt: 1_000 - 2_499 }), rngSeq(0)).reason,
    'cooldown'
  )
  assert.equal(
    decideInterjection(obs(), P, ctx({ lastFiredAt: 1_000 - P.cooldownMs }), rngSeq(0)).reason,
    'ok'
  )
})

test('decideInterjection: fireProbability com PRNG fake (2 sorteios: probabilidade + variante)', () => {
  assert.equal(decideInterjection(obs(), P, ctx(), rngSeq(0.79, 0)).reason, 'ok', '0.79 < 0.8')
  assert.equal(
    decideInterjection(obs(), P, ctx(), rngSeq(0.8, 0)).reason,
    'probability',
    '0.8 = não dispara'
  )
  assert.equal(
    decideInterjection(obs(), { ...P, fireProbability: 0 }, ctx(), rngSeq(0, 0)).reason,
    'probability',
    'p = 0 nunca dispara'
  )
  const always = decideInterjection(obs(), { ...P, fireProbability: 1 }, ctx(), rngSeq(0.999, 0.5))
  assert.equal(always.reason, 'ok', 'p = 1 sempre dispara')
  assert.equal(always.class === 'ACK' || always.class === 'AGREEMENT', true)
})

test('decideInterjection/classifyInterjectionTail: cauda "?" evita THINKING; negação → NONE; classes filtradas', () => {
  // pergunta → ACK (THINKING evitado), mesmo com marcador de hesitação antes
  assert.equal(classifyInterjectionTail('hum, deixa eu ver, como é que fica?'), 'ACK')
  assert.equal(classifyInterjectionTail('isso funciona?'), 'ACK')
  // negação/incerteza → NONE
  assert.equal(classifyInterjectionTail('não, acho que não'), 'NONE')
  assert.equal(classifyInterjectionTail('talvez, depende'), 'NONE')
  // hesitação → THINKING; concordância → AGREEMENT; progresso → ENCOURAGEMENT
  assert.equal(classifyInterjectionTail('hum, deixa eu ver'), 'THINKING')
  assert.equal(classifyInterjectionTail('exato, isso mesmo'), 'AGREEMENT')
  assert.equal(classifyInterjectionTail('consegui, deu certo'), 'ENCOURAGEMENT')
  // sem confiança → ACK neutro
  assert.equal(classifyInterjectionTail('a resposta é quarenta e dois'), 'ACK')
  assert.equal(classifyInterjectionTail(''), 'ACK')

  assert.equal(
    decideInterjection(obs({ tail: 'não sei não' }), P, ctx(), rngSeq(0)).reason,
    'tail-skip'
  )
  // `classes` filtra as permitidas: THINKING fora da lista não sai (e não vira outra classe)
  const onlyAgreement: InterjectionPolicy = { ...P, classes: ['AGREEMENT'] }
  assert.equal(
    decideInterjection(obs({ tail: 'hum' }), onlyAgreement, ctx(), rngSeq(0)).reason,
    'class-filtered'
  )
  const agr = decideInterjection(obs({ tail: 'sim, concordo' }), onlyAgreement, ctx(), rngSeq(0))
  assert.equal(agr.class, 'AGREEMENT')
})

test('decideInterjection: variante com rotação (não repete a última da classe) e NONE domina', () => {
  const r1 = decideInterjection(
    obs({ tail: 'uhum' }),
    P,
    ctx({ lastVariant: { ACK: 1 } }),
    rngSeq(0, 0)
  )
  assert.equal(r1.class, 'ACK')
  assert.equal(r1.class === 'ACK' && r1.variant, 2, 'sorteou a última → a seguinte')
  const r2 = decideInterjection(
    obs({ tail: 'uhum' }),
    P,
    ctx({ lastVariant: { ACK: 2 } }),
    rngSeq(0.5, 0.99)
  )
  assert.equal(r2.class, 'ACK')
  assert.equal(r2.class === 'ACK' && r2.variant, 3)

  // NONE é de longe o resultado mais comum: a maioria das observações não é pausa elegível
  let none = 0
  let fired = 0
  for (let speech = 0; speech <= 1200; speech += 100) {
    for (let pause = 0; pause <= 700; pause += 100) {
      const d = decideInterjection(
        obs({ speechMs: speech, pauseMs: pause, tail: 'uhum' }),
        P,
        ctx({ lastFiredAt: null }),
        rngSeq(0.5)
      )
      if (d.class === 'NONE') none++
      else fired++
    }
  }
  assert.equal(none > fired * 2, true, `NONE dominante (none=${none}, fired=${fired})`)
})

test('SpeechMeter/InterjectionWatcher: fala/pausa e UMA observação por episódio de pausa', () => {
  const meter = new SpeechMeter()
  meter.push(0.5, 100, 0.01)
  meter.push(0.5, 100, 0.01)
  meter.push(0, 100, 0.01)
  assert.equal(meter.speechMs, 200)
  assert.equal(meter.pauseMs, 100)
  meter.push(0.5, 100, 0.01)
  assert.equal(meter.pauseMs, 0, 'voltou a falar zera a pausa')

  const w = new InterjectionWatcher(450)
  const frame = (rms: number, t: number): ReturnType<InterjectionWatcher['push']> =>
    w.push(rms, 33, 0.01, t)
  assert.equal(frame(0.5, 0), null)
  assert.equal(frame(0.5, 33), null)
  let seen = frame(0, 66)
  for (let t = 100; t < 400 && !seen; t += 33) seen = frame(0, t)
  assert.equal(seen, null, 'pausa ainda curta')
  while (!seen) seen = frame(0, 500)
  assert.ok(seen, 'observação na virada do limiar')
  assert.equal(seen!.pauseMs >= 450, true)
  for (let t = 600; t < 1200; t += 33) {
    assert.equal(frame(0, t), null, 'só UMA observação por episódio')
  }
  frame(0.5, 1300) // fala de novo: episódio novo
  assert.equal(frame(0, 1333), null)
  let second = frame(0, 1366)
  for (let t = 1400; t < 2200 && !second; t += 33) second = frame(0, t)
  assert.ok(second, 'segundo episódio gera nova observação')
})

test('PlaybackHold: fala curta durante a reprodução é backchannel; longa é barge-in (uma vez)', () => {
  assert.equal(BACKCHANNEL_MAX_MS, 800, 'limiar documentado: ~800 ms')
  const hold = new PlaybackHold()
  // fala curta (~500 ms) → nada é cancelado
  hold.start(0.5, 100, 0.01)
  for (let i = 0; i < 4; i++) assert.equal(hold.frame(0.5, 100, 0.01), 'pending')
  assert.equal(hold.speechMs, 500)
  assert.equal(hold.end(), 'backchannel')
  assert.equal(hold.open, false)
  // fala longa (~900 ms) → barge-in exatamente na transição, e `end` confirma
  hold.start(0.5, 100, 0.01)
  const events: string[] = []
  for (let i = 0; i < 8; i++) events.push(hold.frame(0.5, 100, 0.01))
  assert.equal(events.filter((e) => e === 'barge-in').length, 1, 'uma única transição')
  assert.equal(hold.end(), 'barge-in')
  // limite exato ainda é backchannel (≤ 800 ms)
  hold.start(0.5, 100, 0.01)
  for (let i = 0; i < 7; i++) hold.frame(0.5, 100, 0.01) // 800 ms contando o start
  assert.equal(hold.end(), 'backchannel')
  assert.equal(new PlaybackHold().end(), 'none', 'sem fala retida não classifica')
})

// ---------------- interjeições no turno mockado ----------------

const interject = (
  h: Harness,
  over: Partial<{ speechMs: number; pauseMs: number; tail: string; observedAt: number }> = {}
): void =>
  h.m.interjectionObserved({
    speechMs: 1200,
    pauseMs: 600,
    tail: 'uhum',
    observedAt: Date.now(), // relógio real por padrão (com relógio fake, passar observedAt)
    ...over
  })

test('interjeição: pausa elegível na fala do usuário toca o clipe da classe decidida', async () => {
  const h = harness({ rng: () => 0 })
  h.m.speechBegin()
  interject(h, { speechMs: 1200, pauseMs: 600, tail: 'uhum...' })
  await waitFor(() => h.emitted.length > 0, 2000, 'interjeição emitida')
  assert.equal(h.emitted[0].kind, 'interjection')
  assert.equal(h.clips[0].cls, 'ACK')
  assert.equal(
    h.timeline.find((e) => e.kind === 'decision')?.played,
    true,
    'decisão registrada como tocada'
  )
  h.m.stop()
})

test('interjeição: NUNCA durante a reprodução nem depois de a resposta começar a falar', async () => {
  const h = harness({ rng: () => 0, fillerDelayMs: 10_000 })
  speakTurn(h, 'algo')
  h.emit(draft('Resposta longa.'))
  h.emit(assistantMsg('Resposta longa.'))
  await waitFor(() => h.emitted.some((u) => u.kind === 'sentence'), 2000, 'sentença emitida')
  // reprodução em curso → descartada
  interject(h, { speechMs: 1200, pauseMs: 600, tail: 'uhum' })
  await sleep(20)
  assert.equal(h.emitted.filter((u) => u.kind === 'interjection').length, 0, 'sobre a reprodução')
  // reprodução terminou, mas a resposta JÁ falou neste turno → descartada
  h.m.playbackIdle()
  interject(h, { speechMs: 1200, pauseMs: 600, tail: 'uhum' })
  await sleep(20)
  assert.equal(h.emitted.filter((u) => u.kind === 'interjection').length, 0, 'resposta já falou')
  assert.equal(h.clips.length, 0, 'nem carregou o clipe')
  h.m.stop()
})

test('interjeição: modo sombra decide mas não toca; expirada é descartada na hora do áudio', async () => {
  const sh = harness({ rng: () => 0, shadow: true })
  sh.m.speechBegin()
  interject(sh, { speechMs: 1200, pauseMs: 600, tail: 'uhum' })
  await waitFor(() => sh.clips.length > 0, 2000, 'decisão (sombra)')
  assert.equal(sh.emitted.length, 0, 'sombra: não toca')
  const d = sh.timeline.find((e) => e.kind === 'decision')
  assert.equal(d?.played, false)
  assert.equal(d?.reason, 'shadow')
  sh.m.stop()

  // decisão válida, mas o clipe só resolve tarde demais (> 600 ms) → descartada
  const h = harness({ rng: () => 0, fakeClock: true, gateClips: true })
  h.m.speechBegin()
  interject(h, { speechMs: 1200, pauseMs: 600, tail: 'uhum', observedAt: 1_000_000 })
  await waitFor(() => h.clips.length > 0, 2000, 'carga do clipe')
  h.advance(INTERJECTION_MAX_AGE_MS + 100)
  h.openClip()
  await sleep(30)
  assert.equal(h.emitted.length, 0, 'decisão que chega tarde demais não toca')
  assert.equal(h.timeline.find((e) => e.kind === 'decision')?.reason, 'stale')
  h.m.stop()
})

test('interjeição: cooldown entre interjeições (sem cooldown, toca de novo)', async () => {
  const h = harness({ rng: () => 0, fakeClock: true, interjections: { cooldownMs: 2_500 } })
  h.m.speechBegin()
  interject(h, { speechMs: 1200, pauseMs: 600, tail: 'uhum', observedAt: 1_000_000 })
  await waitFor(() => h.emitted.length > 0, 2000, '1ª interjeição')
  h.m.playbackIdle() // o clipe terminou
  h.advance(100)
  interject(h, { speechMs: 1200, pauseMs: 600, tail: 'uhum', observedAt: 1_000_100 })
  await sleep(20)
  assert.equal(h.emitted.length, 1, 'cooldown segura a 2ª')
  h.advance(2_600)
  interject(h, { speechMs: 1200, pauseMs: 600, tail: 'uhum', observedAt: 1_002_700 })
  await waitFor(() => h.emitted.length > 1, 2000, '2ª interjeição após o cooldown')
  h.m.stop()
})

test('backchannel: registra na timeline sem cancelar nada nem virar turno', async () => {
  const h = harness()
  h.m.speechBegin()
  h.m.backchannel({ ms: 320 })
  assert.deepEqual(h.emitted, [])
  assert.deepEqual(h.cancelled, [])
  assert.deepEqual(h.sent, [])
  const e = h.timeline.find((x) => x.kind === 'backchannel')
  assert.equal(e?.speechMs, 320)
  assert.equal(h.m.state().phase, 'listening', 'estado do turno intacto')
  h.m.stop()
})

test('integração: fala com interjeição no meio + fase de resposta com filler (cancelado pela 1ª sentença)', async () => {
  const h = harness({ rng: () => 0, fillerDelayMs: 25 })
  // usuário falando: pausa no meio → interjeição ACK toca; depois o turno sai
  h.m.speechBegin()
  interject(h, { speechMs: 1500, pauseMs: 700, tail: 'então, sobre o relatório' })
  await waitFor(() => h.emitted.length > 0, 2000, 'interjeição')
  assert.equal(h.emitted[0].kind, 'interjection')
  h.m.playbackIdle() // o clipe da interjeição terminou
  h.m.speechEnd()
  h.m.turn('então, sobre o relatório')
  // resposta demora → filler; resposta começa → filler cancelado e a sentença toca
  await waitFor(() => h.emitted.some((u) => u.kind === 'filler'), 2000, 'filler')
  h.emit(draft('Claro. Segue o resumo.'))
  h.emit(assistantMsg('Claro. Segue o resumo.'))
  await waitFor(() => h.emitted.some((u) => u.kind === 'sentence'), 2000, 'sentença')
  assert.deepEqual(
    h.emitted.map((u) => u.kind),
    ['interjection', 'filler', 'sentence', 'sentence'],
    'ordem: interjeição → filler → resposta (2 sentenças)'
  )
  assert.equal(h.cancelled.length, 1, 'o filler foi cancelado pela 1ª sentença')
  const kinds = h.timeline.map((e) => e.kind)
  assert.equal(
    kinds.filter((k) => k === 'decision').length,
    2,
    'decisões do filler e da interjeição'
  )
  assert.equal(kinds.includes('turn-sent'), true)
  assert.equal(kinds.includes('clip-cancelled'), true)
  assert.equal(kinds.includes('sentence-emitted'), true)
  h.m.stop()
})
