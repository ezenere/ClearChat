// Frases de demora da chamada de voz (SPEC → "Chamada de voz → Frases de demora"): "manter viva"
// ("Só mais um instante…") e desculpa antes da resposta ("Desculpe a demora, vamos lá."),
// sintetizadas AO VIVO (`synthPhrase` — request à parte da resposta). Política pura
// (`@shared/voicePolicy`) + `VoiceCallManager` com relógio/timers FALSOS, síntese falsa e eventos
// do runner injetados. Nada pago, sem microfone.
// Rodar: node --import ./e2e/ts-hooks.mjs --test e2e/voiceDelayPhrases.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AgentEvent, ChatConfig, MessageMeta, StoredMessage } from '@shared/types'
import type { VoiceCallTimelineEvent } from '@shared/ipc'
import {
  DEFAULT_APOLOGY_POOL,
  DEFAULT_AUDIO_INPUT,
  DEFAULT_DELAY_PHRASES,
  DEFAULT_INTERJECTION_POLICY,
  DEFAULT_KEEPALIVE_POOL,
  DEFAULT_STT_SETTINGS,
  DEFAULT_TTS_SETTINGS,
  DEFAULT_VOICE_CALL_DEFAULTS,
  normalizeDelayPhrases,
  normalizeVoiceCallDefaults,
  resolveDelayPhrasePools,
  type VoiceDelayPhrases
} from '@shared/voice'
import {
  APOLOGY_AFTER_KEEPALIVE_MS,
  VoicedSpan,
  fillerBelowMinSpeech,
  pickFillerPhrase,
  EMPTY_DELAY_STATE,
  KEEPALIVE_COOLDOWN_MS,
  KEEPALIVE_MAX_PER_TURN,
  apologyDueAt,
  apologySkipReason,
  keepAliveDueAt,
  pickDelayPhrase,
  type DelayPhraseState
} from '@shared/voicePolicy'
import { computeVoiceCallMetrics } from '@shared/voiceTimeline'
import { END_CALL_RESULT, type VoiceCallMark } from '@shared/voiceCallMarks'
import {
  VoiceCallManager,
  type VoiceCallAmend,
  type VoiceCallUtterance
} from '../src/main/voice/call.ts'
import type { TtsTextFeed } from '../src/main/voice/elevenlabsStream.ts'

// =====================================================================================
// política pura
// =====================================================================================

const CFG = { enabled: true, keepAliveAfterMs: 3000, apologyAfterMs: 5000 }
const st = (p: Partial<DelayPhraseState>): DelayPhraseState => ({
  ...EMPTY_DELAY_STATE,
  turnStartedAt: 0,
  silentSince: 0,
  ...p
})

test('keepAliveDueAt: silêncio ≥ limiar, máx. por turno, cooldown, só antes da resposta (ou com tool)', () => {
  assert.equal(keepAliveDueAt(st({}), CFG), 3000, 'silêncio desde o turno + 3 s')
  assert.equal(keepAliveDueAt(st({ silentSince: 1500 }), CFG), 4500, 'conta do fim do preâmbulo')
  assert.equal(keepAliveDueAt(st({ silentSince: null }), CFG), null, 'algo tocando: espera o idle')
  assert.equal(keepAliveDueAt(st({ turnStartedAt: null }), CFG), null, 'desarmado')
  assert.equal(keepAliveDueAt(st({}), { ...CFG, enabled: false }), null, 'desligado')
  assert.equal(
    keepAliveDueAt(st({ keepAlives: KEEPALIVE_MAX_PER_TURN }), CFG),
    null,
    `no máximo ${KEEPALIVE_MAX_PER_TURN} por turno`
  )
  assert.equal(
    keepAliveDueAt(st({ keepAlives: 1, lastKeepAliveAt: 4000, silentSince: 5000 }), CFG),
    Math.max(8000, 4000 + KEEPALIVE_COOLDOWN_MS),
    'cooldown de ~6 s entre elas'
  )
  assert.equal(keepAliveDueAt(st({ answerSpoken: true }), CFG), null, 'resposta já falando')
  assert.equal(
    keepAliveDueAt(st({ answerSpoken: true, toolsRunning: true, silentSince: 10_000 }), CFG),
    13_000,
    'depois da 1ª frase, só com tool rodando'
  )
})

test('apologyDueAt / apologySkipReason: limiar desde o turno; só pronta; não emenda num "manter viva"', () => {
  assert.equal(apologyDueAt(st({}), CFG), 5000)
  assert.equal(apologyDueAt(st({ apologyStarted: true }), CFG), null, '1 por turno')
  assert.equal(apologyDueAt(st({ answerSpoken: true }), CFG), null, 'resposta já saiu')
  assert.equal(apologyDueAt(st({}), { ...CFG, enabled: false }), null)
  const base = {
    ready: true,
    now: 10_000,
    keepAlivePlaying: false,
    lastKeepAliveEmittedAt: null,
    clipPlaying: false
  }
  assert.equal(apologySkipReason(base), null, 'pronta e nada recente → toca')
  assert.equal(apologySkipReason({ ...base, ready: false }), 'not-ready', 'nunca espera a síntese')
  assert.equal(apologySkipReason({ ...base, keepAlivePlaying: true }), 'keepalive-playing')
  assert.equal(
    apologySkipReason({ ...base, lastKeepAliveEmittedAt: 10_000 - APOLOGY_AFTER_KEEPALIVE_MS + 1 }),
    'keepalive-recent'
  )
  assert.equal(
    apologySkipReason({ ...base, lastKeepAliveEmittedAt: 10_000 - APOLOGY_AFTER_KEEPALIVE_MS }),
    null
  )
  assert.equal(apologySkipReason({ ...base, clipPlaying: true }), 'clip-playing')
})

test('pickDelayPhrase: nunca repete as últimas; pool de 1 sempre devolve a única; vazio → null', () => {
  const pool = [...DEFAULT_KEEPALIVE_POOL]
  let recent: number[] = []
  let prev: number | null = null
  let seed = 7
  const rng = (): number => (seed = (seed * 9301 + 49297) % 233280) / 233280
  for (let i = 0; i < 200; i++) {
    const k = pickDelayPhrase(pool, recent, rng)!
    assert.ok(k >= 0 && k < pool.length)
    assert.ok(!recent.slice(-2).includes(k), 'fora das 2 últimas')
    assert.notEqual(k, prev)
    prev = k
    recent = [...recent, k].slice(-2)
  }
  assert.equal(
    pickDelayPhrase(['só'], [0], () => 0.9),
    0
  )
  assert.equal(
    pickDelayPhrase(['a', 'b'], [0], () => 0),
    1,
    'pool de 2: alterna'
  )
  assert.equal(
    pickDelayPhrase([], [], () => 0),
    null
  )
})

test('normalizeDelayPhrases: padrões, tempos presos em 1–60 s, pools aparados/sem duplicatas; aditivo no voiceCallDefaults', () => {
  assert.deepEqual(normalizeDelayPhrases(undefined), DEFAULT_DELAY_PHRASES)
  assert.deepEqual(normalizeDelayPhrases({}), DEFAULT_DELAY_PHRASES)
  assert.deepEqual(DEFAULT_DELAY_PHRASES, {
    enabled: true,
    keepAliveAfterMs: 3000,
    apologyAfterMs: 5000,
    keepAlivePool: null,
    apologyPool: null
  })
  const n = normalizeDelayPhrases({
    enabled: false,
    keepAliveAfterMs: 10,
    apologyAfterMs: 999_999,
    keepAlivePool: ['  Um   instante.  ', 'Um instante.', 42, '', 'x'.repeat(200)],
    apologyPool: []
  })
  assert.equal(n.enabled, false)
  assert.equal(n.keepAliveAfterMs, 1000)
  assert.equal(n.apologyAfterMs, 60_000)
  assert.deepEqual(n.keepAlivePool, ['Um instante.', 'x'.repeat(80)])
  assert.equal(n.apologyPool, null, 'vazio = padrão')
  assert.deepEqual(resolveDelayPhrasePools(n).apology, [...DEFAULT_APOLOGY_POOL])
  // registro antigo (sem o campo) → os padrões; o campo passa pelo normalizador global
  const old = normalizeVoiceCallDefaults({ enabled: true, endCall: false })
  assert.deepEqual(old.delayPhrases, DEFAULT_DELAY_PHRASES)
  const custom = normalizeVoiceCallDefaults({ delayPhrases: { apologyAfterMs: 8000 } })
  assert.equal(custom.delayPhrases.apologyAfterMs, 8000)
  assert.equal(custom.delayPhrases.keepAliveAfterMs, 3000)
  assert.deepEqual(DEFAULT_VOICE_CALL_DEFAULTS.delayPhrases, DEFAULT_DELAY_PHRASES)
})

// =====================================================================================
// VoiceCallManager com relógio e timers falsos
// =====================================================================================

/** Timers falsos: `advance` dispara em ordem, avançando o relógio até cada um. */
class FakeTimers {
  now = 1_000_000
  #seq = 0
  #list: { id: number; at: number; fn: () => void }[] = []
  set = (fn: () => void, ms: number): unknown => {
    const id = ++this.#seq
    this.#list.push({ id, at: this.now + Math.max(0, ms), fn })
    return id
  }
  clear = (h: unknown): void => {
    this.#list = this.#list.filter((t) => t.id !== h)
  }
  get pending(): number {
    return this.#list.length
  }
  async advance(ms: number): Promise<void> {
    const target = this.now + ms
    for (;;) {
      this.#list.sort((a, b) => a.at - b.at || a.id - b.id)
      const next = this.#list[0]
      if (!next || next.at > target) break
      this.#list.shift()
      this.now = Math.max(this.now, next.at)
      next.fn()
      await flush()
    }
    this.now = target
    await flush()
  }
}

/** Esvazia microtarefas/imediatos (síntese falsa resolve em microtarefa). */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r))
}

interface PhraseCall {
  text: string
  signal: AbortSignal
  resolve: () => void
  reject: (e: unknown) => void
}

interface HarnessOpts {
  delay?: Partial<VoiceDelayPhrases>
  /** Frases de demora resolvem só com `phrase.resolve()` (padrão: na hora). */
  manualPhrases?: boolean
  /** Preâmbulo (filler) ligado (padrão true — clipe falso, espera 0). */
  fillers?: boolean
  shadow?: boolean
  ttsFeed?: boolean
  /** "Fala mínima" (`interjections.minSpeechMs`). */
  minSpeechMs?: number
  /** STT só pela API (especulação lenta — espera de fim de turno longa). */
  slowSpeculation?: boolean
}

interface Harness {
  m: VoiceCallManager
  clock: FakeTimers
  emitted: VoiceCallUtterance[]
  cancelled: string[]
  timeline: VoiceCallTimelineEvent[]
  /** Textos pedidos à síntese de SENTENÇA (`synth`). */
  synthTexts: string[]
  /** Pedidos à síntese de FRASE (`synthPhrase`). */
  phrases: PhraseCall[]
  amends: { spoken: Record<string, string[]> }[]
  markers: { content: string; meta: MessageMeta }[]
  feedCalls: string[]
  emit(e: AgentEvent): void
  /** Emitidas de frase de demora (kind 'delay'), com o texto decodificado. */
  delays(): string[]
  history: StoredMessage[]
}

const dec = (u: VoiceCallUtterance): string => new TextDecoder().decode(u.audio)

function harness(opts: HarnessOpts = {}): Harness {
  const listeners: ((e: AgentEvent) => void)[] = []
  const clock = new FakeTimers()
  const h: Harness = {
    m: null as unknown as VoiceCallManager,
    clock,
    emitted: [],
    cancelled: [],
    timeline: [],
    synthTexts: [],
    phrases: [],
    amends: [],
    markers: [],
    feedCalls: [],
    history: [],
    emit: (e) => listeners.forEach((l) => l(e)),
    delays: () => h.emitted.filter((u) => u.kind === 'delay').map(dec)
  }
  let userSeq = 0
  const defaults = {
    ...DEFAULT_VOICE_CALL_DEFAULTS,
    fillers: { ...DEFAULT_VOICE_CALL_DEFAULTS.fillers, enabled: opts.fillers !== false },
    interjections: {
      ...DEFAULT_INTERJECTION_POLICY,
      shadow: opts.shadow === true,
      ...(opts.minSpeechMs != null ? { minSpeechMs: opts.minSpeechMs } : {})
    },
    delayPhrases: { ...DEFAULT_DELAY_PHRASES, ...(opts.delay ?? {}) }
  }
  const feed: TtsTextFeed = {
    begin: () => void h.feedCalls.push('begin'),
    partial: (t) => void h.feedCalls.push(`partial:${t}`),
    cut: (t) => void h.feedCalls.push(`cut:${t}`),
    end: () => void h.feedCalls.push('end'),
    reset: () => void h.feedCalls.push('reset'),
    close: () => void h.feedCalls.push('close')
  }
  h.m = new VoiceCallManager({
    // o runner grava a mensagem do usuário DENTRO do envio (como o real)
    sendTurn: (_sid, text) => {
      const u: StoredMessage = {
        id: `mu${++userSeq}`,
        sessionId: 's1',
        seq: h.history.length + 1,
        message: { role: 'user', content: text },
        createdAt: clock.now
      }
      h.history.push(u)
      h.emit({ type: 'message-added', message: u })
    },
    synth: async (text) => {
      h.synthTexts.push(text)
      return { audio: new TextEncoder().encode(`WAV:${text}`), mime: 'audio/wav' }
    },
    synthPhrase: (text, signal) =>
      new Promise((resolve, reject) => {
        const call: PhraseCall = {
          text,
          signal,
          resolve: () =>
            resolve({ audio: new TextEncoder().encode(`PHRASE:${text}`), mime: 'audio/wav' }),
          reject
        }
        h.phrases.push(call)
        signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        if (!opts.manualPhrases) queueMicrotask(call.resolve)
      }),
    timers: { set: clock.set, clear: clock.clear },
    now: () => clock.now,
    rng: () => 0.3,
    fillerDelayMs: 0,
    emitState: () => {},
    emitUtterance: (u) => void h.emitted.push(u),
    emitUtteranceCancel: (id) => void h.cancelled.push(id),
    emitTimeline: (e) => void h.timeline.push({ ...e }),
    logEval: () => {},
    clip: async (cls, n) => ({
      audio: new TextEncoder().encode(`CLIP:${cls}_${n}`),
      mime: 'audio/wav'
    }),
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
    amendTurn: async (_sid, amend: VoiceCallAmend) => {
      h.amends.push({ spoken: typeof amend.spoken === 'function' ? amend.spoken() : amend.spoken })
    },
    appendMarker: (_sid, content, meta) => void h.markers.push({ content, meta }),
    sessionMessages: () => h.history,
    newCallId: () => 'call-1',
    ...(opts.ttsFeed ? { ttsFeed: () => feed } : {}),
    ...(opts.slowSpeculation ? { slowSpeculation: () => true } : {})
  })
  h.m.start('s1')
  return h
}

const LONG_Q = 'me explica com calma como funciona a fotossíntese nas plantas'

/** Fala → turno (o filler sai na hora — espera 0 — e o renderer avisa o fim dele em `fillerMs`). */
async function turnWithFiller(h: Harness, fillerMs = 1000): Promise<void> {
  h.m.speechBegin()
  h.m.speechEnd()
  h.m.turn(LONG_Q)
  // o preâmbulo usa timer real de 0 ms: espera ele sair
  for (let i = 0; i < 50 && !h.emitted.some((u) => u.kind === 'filler'); i++)
    await new Promise((r) => setTimeout(r, 2))
  assert.ok(
    h.emitted.some((u) => u.kind === 'filler'),
    'preâmbulo tocou'
  )
  await h.clock.advance(fillerMs)
  h.m.playbackIdle() // o preâmbulo terminou de tocar
}

let aSeq = 0
/** A resposta chega inteira (raciocínio longo e depois o texto de uma vez). */
async function answer(h: Harness, text: string, opts: { done?: boolean } = {}): Promise<string> {
  const id = `ma${++aSeq}`
  h.emit({ type: 'draft', sessionId: 's1', draft: { content: text } } as unknown as AgentEvent)
  const a: StoredMessage = {
    id,
    sessionId: 's1',
    seq: h.history.length + 1,
    message: { role: 'assistant', content: text },
    createdAt: h.clock.now
  }
  h.history.push(a)
  h.emit({ type: 'message-added', message: a })
  if (opts.done !== false)
    h.emit({ type: 'session-updated', session: { id: 's1', status: 'idle' } } as AgentEvent)
  await flush()
  return id
}

const decisions = (h: Harness, cls: string): VoiceCallTimelineEvent[] =>
  h.timeline.filter((e) => e.kind === 'decision' && e.class === cls)

test('manter viva: dispara só depois de keepAliveAfterMs de silêncio após o preâmbulo (e não antes)', async () => {
  const h = harness({ delay: { apologyAfterMs: 60_000 } })
  await turnWithFiller(h, 1000)
  await h.clock.advance(2999)
  assert.equal(h.phrases.length, 0, 'antes do limiar nada é sintetizado')
  await h.clock.advance(1)
  assert.equal(h.phrases.length, 1, 'no limiar: síntese AO VIVO da frase')
  assert.ok(DEFAULT_KEEPALIVE_POOL.includes(h.phrases[0].text))
  assert.deepEqual(h.delays(), [`PHRASE:${h.phrases[0].text}`], 'tocou (kind delay)')
  assert.equal(h.synthTexts.length, 0, 'nunca pela síntese de sentença (contexto da resposta)')
  const d = decisions(h, 'KEEPALIVE').find((e) => e.played)
  assert.ok(d, 'decisão na timeline')
  assert.equal(d!.text, h.phrases[0].text)
  assert.equal(h.m.state().phase, 'thinking', 'a fase continua "Pensando…"')
})

test('manter viva: no máx. 2 por turno, ~6 s entre elas, sem repetir a frase', async () => {
  const h = harness({ delay: { apologyAfterMs: 60_000 } })
  await turnWithFiller(h, 1000)
  await h.clock.advance(3000) // 1ª
  assert.equal(h.delays().length, 1)
  const t1 = h.clock.now
  await h.clock.advance(1000)
  h.m.playbackIdle() // a 1ª terminou (silêncio desde t1+1 s → limiar em t1+4 s; cooldown t1+6 s)
  await h.clock.advance(4000)
  assert.equal(h.delays().length, 1, 'cooldown de 6 s segura a 2ª')
  await h.clock.advance(t1 + KEEPALIVE_COOLDOWN_MS - h.clock.now)
  assert.equal(h.delays().length, 2, '2ª no fim do cooldown')
  assert.notEqual(h.phrases[0].text, h.phrases[1].text, 'sem repetir')
  await h.clock.advance(1200)
  h.m.playbackIdle()
  await h.clock.advance(60_000)
  assert.equal(h.delays().length, 2, `no máximo ${KEEPALIVE_MAX_PER_TURN} por turno`)
  assert.equal(h.clock.pending, 0, 'nenhum timer pendurado')
})

test('desculpa: sintetizada no limiar, toca ANTES da 1ª frase (que fica atrás dela na fila)', async () => {
  const h = harness({ delay: { keepAliveAfterMs: 60_000 } })
  await turnWithFiller(h, 1000)
  await h.clock.advance(3999) // 5 s desde o turno (1 s do preâmbulo + 3,999 s)
  assert.equal(h.phrases.length, 0, 'antes do limiar nada')
  await h.clock.advance(1)
  assert.equal(h.phrases.length, 1, 'síntese da desculpa começa no limiar (em paralelo)')
  assert.ok(DEFAULT_APOLOGY_POOL.includes(h.phrases[0].text))
  assert.equal(h.delays().length, 0, 'pronta, mas espera a resposta (não toca solta)')
  await h.clock.advance(2000)
  await answer(h, 'A fotossíntese transforma luz em energia.')
  const kinds = h.emitted.map((u) => `${u.kind}:${dec(u)}`)
  const iA = kinds.indexOf(`delay:PHRASE:${h.phrases[0].text}`)
  const iS = kinds.indexOf('sentence:WAV:A fotossíntese transforma luz em energia.')
  assert.ok(iA >= 0 && iS === iA + 1, `desculpa logo antes da frase: ${kinds.join(' | ')}`)
  assert.ok(decisions(h, 'APOLOGY').some((e) => e.played && e.reason === 'late-answer'))
})

test('desculpa: abaixo do limiar nem é sintetizada', async () => {
  const h = harness({ delay: { keepAliveAfterMs: 60_000 } })
  await turnWithFiller(h, 1000)
  await h.clock.advance(2500) // 3,5 s
  await answer(h, 'Resposta rápida.')
  await h.clock.advance(30_000)
  assert.equal(h.phrases.length, 0)
  assert.equal(h.delays().length, 0)
})

test('desculpa: não pronta quando a resposta chega → descartada (abortada) e a resposta NÃO espera', async () => {
  const h = harness({ delay: { keepAliveAfterMs: 60_000 }, manualPhrases: true })
  await turnWithFiller(h, 1000)
  await h.clock.advance(4000)
  assert.equal(h.phrases.length, 1)
  await h.clock.advance(300)
  await answer(h, 'Aqui está.')
  assert.ok(
    h.emitted.some((u) => u.kind === 'sentence' && dec(u) === 'WAV:Aqui está.'),
    'a frase saiu sem esperar a desculpa'
  )
  assert.equal(h.phrases[0].signal.aborted, true, 'síntese da desculpa abortada')
  h.phrases[0].resolve() // chega tarde: ignorada
  await flush()
  assert.equal(h.delays().length, 0)
  assert.ok(decisions(h, 'APOLOGY').some((e) => !e.played && e.reason === 'not-ready'))
})

test('desculpa × manter viva: não emenda num "manter viva" tocando nem recém-saído', async () => {
  // "manter viva" em 1 s + 3 s = 4 s (tocando); desculpa pronta aos 5 s; resposta aos 5,5 s
  const a = harness()
  await turnWithFiller(a, 1000)
  await a.clock.advance(3000)
  assert.equal(a.delays().length, 1, '"manter viva" tocando')
  await a.clock.advance(1500)
  assert.equal(a.phrases.length, 2, 'desculpa sintetizada no limiar')
  await answer(a, 'Pronto.')
  assert.equal(a.delays().length, 1, 'sem a desculpa')
  assert.ok(decisions(a, 'APOLOGY').some((e) => e.reason === 'keepalive-playing'))
  // "manter viva" terminou há pouco (< 4 s) → também não
  const b = harness()
  await turnWithFiller(b, 1000)
  await b.clock.advance(3000)
  await b.clock.advance(1200)
  b.m.playbackIdle()
  await b.clock.advance(1500)
  await answer(b, 'Pronto.')
  assert.equal(b.delays().length, 1)
  assert.ok(decisions(b, 'APOLOGY').some((e) => e.reason === 'keepalive-recent'))
})

test('manter viva em voo é abortada quando a resposta chega antes (nunca toca depois)', async () => {
  const h = harness({ delay: { apologyAfterMs: 60_000 }, manualPhrases: true })
  await turnWithFiller(h, 1000)
  await h.clock.advance(3000)
  assert.equal(h.phrases.length, 1)
  await answer(h, 'Chegou a resposta.')
  assert.equal(h.phrases[0].signal.aborted, true)
  h.phrases[0].resolve()
  await flush()
  assert.equal(h.delays().length, 0)
  assert.ok(decisions(h, 'KEEPALIVE').some((e) => !e.played && e.reason === 'answer-first'))
})

test('nunca com o usuário falando: fala nova aborta a síntese e corta a frase tocando', async () => {
  const h = harness({ manualPhrases: true })
  await turnWithFiller(h, 1000)
  await h.clock.advance(3000)
  assert.equal(h.phrases.length, 1)
  h.m.speechBegin() // o usuário voltou a falar
  assert.equal(h.phrases[0].signal.aborted, true)
  await h.clock.advance(60_000)
  assert.equal(h.phrases.length, 1, 'nada novo enquanto/depois de o usuário falar no turno')
  // tocando: a fala do usuário corta (o renderer já descartou; o main manda cancelar)
  const g = harness()
  await turnWithFiller(g, 1000)
  await g.clock.advance(3000)
  const id = g.emitted.find((u) => u.kind === 'delay')!.id
  g.m.speechBegin()
  assert.ok(g.cancelled.includes(id), 'frase de demora cancelada com fade')
})

test('nunca depois do barge-in, do end_call (desligamento armado) nem com resposta de erro', async () => {
  // barge-in no meio da resposta (tool rodando depois da 1ª frase): nada mais
  const b = harness({ delay: { apologyAfterMs: 60_000 } })
  await turnWithFiller(b, 1000)
  await answer(b, 'Vou ver isso.', { done: false })
  b.emit({ type: 'tool-running', sessionId: 's1', toolCallId: 't1', running: true } as AgentEvent)
  b.m.bargeIn({ playedIds: [] })
  b.m.playbackIdle()
  await b.clock.advance(60_000)
  assert.equal(b.phrases.length, 0)
  // controle: sem o barge-in a tool rodando reabre o "manter viva"
  const c = harness({ delay: { apologyAfterMs: 60_000 } })
  await turnWithFiller(c, 1000)
  await answer(c, 'Vou ver isso.', { done: false })
  c.emit({ type: 'tool-running', sessionId: 's1', toolCallId: 't1', running: true } as AgentEvent)
  await c.clock.advance(1000)
  c.m.playbackIdle()
  await c.clock.advance(3000)
  assert.equal(c.delays().length, 1, 'tool longa depois da 1ª frase: "manter viva"')
  // end_call: o desligamento armado cala as frases de demora
  const e = harness()
  await turnWithFiller(e, 1000)
  const a: StoredMessage = {
    id: 'a-end',
    sessionId: 's1',
    seq: 9,
    message: {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'end_call', arguments: '{}' } }]
    },
    createdAt: 1
  }
  e.history.push(a)
  e.emit({ type: 'message-added', message: a })
  e.emit({
    type: 'message-added',
    message: {
      id: 't-end',
      sessionId: 's1',
      seq: 10,
      message: { role: 'tool', tool_call_id: 'tc1', content: END_CALL_RESULT },
      meta: { toolStatus: 'ok' },
      createdAt: 2
    }
  })
  assert.ok(e.timeline.some((t) => t.kind === 'hangup-armed'))
  await e.clock.advance(60_000)
  assert.equal(e.phrases.length, 0, 'nada depois do end_call')
  // resposta de erro: a chamada encerra, nada é falado
  const r = harness()
  await turnWithFiller(r, 1000)
  r.emit({
    type: 'message-added',
    message: {
      id: 'err',
      sessionId: 's1',
      seq: 3,
      message: { role: 'assistant', content: 'Falhou' },
      meta: { kind: 'error', error: 'HTTP 500' },
      createdAt: 3
    }
  } as AgentEvent)
  assert.equal(r.m.state().active, false)
  await r.clock.advance(60_000)
  assert.equal(r.phrases.length, 0)
})

test('frases de demora fora do histórico: o barge-in trunca só às frases da RESPOSTA', async () => {
  const h = harness({ delay: { keepAliveAfterMs: 60_000 } })
  await turnWithFiller(h, 1000)
  await h.clock.advance(4500)
  const id = await answer(h, 'Primeira frase. Segunda frase.', { done: false })
  const apologyId = h.emitted.find((u) => u.kind === 'delay')!.id
  const first = h.emitted.find((u) => u.kind === 'sentence')!.id
  h.m.bargeIn({ playedIds: [apologyId, first] })
  await flush()
  assert.equal(h.amends.length, 1)
  assert.deepEqual(h.amends[0].spoken, { [id]: ['Primeira frase.'] }, 'sem a desculpa')
})

test('custo: os caracteres das frases de demora contam no uso da voz da chamada', async () => {
  const h = harness()
  await turnWithFiller(h, 1000)
  await h.clock.advance(3000) // manter viva
  await h.clock.advance(1200)
  h.m.playbackIdle()
  await h.clock.advance(4000) // desculpa sintetizada aos 5 s; resposta aos 9,2 s
  await answer(h, 'Pronto.')
  h.m.stop()
  const end = h.markers.find((m) => (m.meta.voiceCall as VoiceCallMark).phase === 'end')!
  const usage = (end.meta.voiceCall as VoiceCallMark).usage!
  const phraseChars = h.phrases.reduce((n, p) => n + p.text.length, 0)
  assert.equal(usage.tts.chars, phraseChars + 'Pronto.'.length)
  assert.equal(h.delays().length, 2, '"manter viva" + desculpa')
})

test('modo sombra: decide mas não sintetiza nem toca', async () => {
  const h = harness({ shadow: true })
  await turnWithFiller(h, 1000).catch(() => undefined) // em sombra o preâmbulo também não toca
  h.m.playbackIdle()
  await h.clock.advance(10_000)
  assert.equal(h.phrases.length, 0)
  assert.ok(decisions(h, 'KEEPALIVE').some((e) => e.reason === 'shadow'))
  assert.ok(decisions(h, 'APOLOGY').some((e) => e.reason === 'shadow'))
})

test('desligado (delayPhrases.enabled false): nada', async () => {
  const h = harness({ delay: { enabled: false } })
  await turnWithFiller(h, 1000)
  await h.clock.advance(60_000)
  await answer(h, 'Pronto.')
  assert.equal(h.phrases.length, 0)
  assert.equal(h.clock.pending, 0)
})

test('ElevenLabs (tts-feed): a frase vai por request à parte — nunca no contexto da resposta', async () => {
  const h = harness({ ttsFeed: true, delay: { keepAliveAfterMs: 60_000 } })
  await turnWithFiller(h, 1000)
  await h.clock.advance(4500)
  await answer(h, 'Resposta.')
  const apology = h.phrases[0].text
  assert.ok(h.delays().length === 1)
  assert.ok(
    !h.feedCalls.some((c) => c.includes(apology)),
    `o texto da desculpa nunca vai ao feed: ${h.feedCalls.join(' | ')}`
  )
  assert.ok(h.feedCalls.includes('cut:Resposta.'), 'a resposta segue pelo feed')
})

test('resposta inteira depois de raciocínio longo (turno já ocioso na síntese): a desculpa ainda entra', async () => {
  const h = harness({ delay: { keepAliveAfterMs: 60_000 } })
  // síntese de sentença lenta: o turno do agente termina antes da 1ª frase ficar pronta
  await turnWithFiller(h, 1000)
  await h.clock.advance(6000)
  assert.equal(h.phrases.length, 1)
  await answer(h, 'Demorou mas veio.') // done = session idle logo depois
  assert.equal(h.delays().length, 1, 'desculpa antes da frase')
})

test('métricas: frases de demora fora das interjeições; tocadas e "não tocou" no seu balde', () => {
  const ev = (p: Partial<VoiceCallTimelineEvent>): VoiceCallTimelineEvent => ({
    ts: 1,
    kind: 'decision',
    ...p
  })
  const m = computeVoiceCallMetrics([
    ev({ class: 'KEEPALIVE', played: true }),
    ev({ class: 'APOLOGY', played: false, reason: 'not-ready' }),
    ev({ class: 'APOLOGY', played: true }),
    ev({ class: 'ACK', played: true })
  ])
  assert.equal(m.decisions, 1, 'só a interjeição')
  assert.deepEqual(m.delayPlayed, { keepAlive: 1, apology: 1 })
  assert.deepEqual(m.skipped.delay, { 'not-ready': 1 })
})

// =====================================================================================
// preâmbulo × "Fala mínima": tempo com VOZ (o silêncio do fim de turno não conta)
// =====================================================================================

/** Quadros de 100 ms: `voz`/`sil` em ms → RMS acima/abaixo do limiar. */
function frames(...parts: ['voz' | 'sil', number][]): number[] {
  const out: number[] = []
  for (const [k, ms] of parts)
    for (let i = 0; i < ms / 100; i++) out.push(k === 'voz' ? 0.2 : 0.001)
  return out
}
const THRESHOLD = 0.02

/** O que o renderer mede: `VoicedSpan` sobre os quadros da fala (início no 1º quadro com voz). */
function voicedSpanOf(fs: number[]): number {
  const v = new VoicedSpan()
  for (const rms of fs) v.push(rms, 100, THRESHOLD)
  return v.spanMs
}

test('VoicedSpan: 1º → último quadro com voz; silêncio antes/depois e a espera do fim de turno fora', () => {
  const fs = frames(['sil', 300], ['voz', 1500], ['sil', 400], ['voz', 1500], ['sil', 2000])
  const v = new VoicedSpan()
  for (const rms of fs) v.push(rms, 100, THRESHOLD)
  assert.equal(v.spanMs, 3400, 'pausa interna conta; silêncio inicial e final não')
  assert.equal(v.voicedMs, 3000)
  v.reset()
  assert.equal(v.spanMs, 0)
  assert.equal(fillerBelowMinSpeech(3000, 5000), true)
  assert.equal(fillerBelowMinSpeech(6000, 5000), false)
  assert.equal(fillerBelowMinSpeech(null, 5000), false, 'desconhecido (digitado) não barra')
})

/** Fala pela chamada: transcrição final (áudio com o silêncio) + turno com o tempo com voz. */
async function spokenTurn(
  h: Harness,
  text: string,
  speech: number[],
  audioMs: number
): Promise<void> {
  h.m.speechBegin()
  h.m.speechEnd()
  h.m.noteTranscript({ text, model: 'whisper', backend: 'api', audioMs })
  h.m.turn(text, { speechMs: voicedSpanOf(speech) })
  await new Promise((r) => setTimeout(r, 30)) // o preâmbulo usa timer real de 0 ms
}
const fillerDecision = (h: Harness): VoiceCallTimelineEvent | undefined =>
  h.timeline.find((e) => e.kind === 'decision' && e.class === 'FILLER')

test('Fala mínima 5 s: 3 s de fala + 2 s de silêncio no fim → SEM preâmbulo (o silêncio não conta)', async () => {
  const h = harness({ minSpeechMs: 5000 })
  const q = 'qual é a diferença entre fotossíntese e respiração celular?'
  await spokenTurn(h, q, frames(['voz', 3000], ['sil', 2000]), 5000)
  assert.equal(h.emitted.filter((u) => u.kind === 'filler').length, 0)
  const d = fillerDecision(h)!
  assert.equal(d.played, false)
  assert.equal(d.reason, 'below-min-speech')
  assert.equal(d.speechMs, 3000, 'tempo com voz, não os 5 s do áudio')
})

test('Fala mínima 5 s: 6 s de fala → preâmbulo (pergunta → frase de pergunta)', async () => {
  const h = harness({ minSpeechMs: 5000 })
  const q = 'qual é a diferença entre fotossíntese e respiração celular nas plantas?'
  await spokenTurn(h, q, frames(['sil', 200], ['voz', 6000], ['sil', 1200]), 7400)
  const fillers = h.emitted.filter((u) => u.kind === 'filler')
  assert.equal(fillers.length, 1)
  assert.match(fillerDecision(h)!.reason ?? '', /question/)
})

test('Fala mínima com STT só por API (espera de fim de turno longa): fala curta segue sem preâmbulo', async () => {
  const h = harness({ minSpeechMs: 5000, slowSpeculation: true })
  // 3,2 s de fala; a especulação pela API demora e o turno só fecha 3,5 s depois — o áudio enviado
  // à transcrição tem ~6,7 s, mas a voz é 3,2 s
  const q = 'me explica como funciona o ciclo da água por favor'
  await spokenTurn(h, q, frames(['voz', 3200], ['sil', 3500]), 6700)
  assert.equal(h.emitted.filter((u) => u.kind === 'filler').length, 0)
  assert.equal(fillerDecision(h)!.reason, 'below-min-speech')
})

test('comando curto "abre o arquivo" (padrão 700 ms de voz): preâmbulo de COMANDO, nunca "Boa pergunta"', async () => {
  const h = harness()
  await spokenTurn(h, 'abre o arquivo', frames(['voz', 900], ['sil', 1500]), 2400)
  const d = fillerDecision(h)!
  assert.equal(d.played, true)
  assert.match(d.reason ?? '', /command/)
  const clip = dec(h.emitted.find((u) => u.kind === 'filler')!)
  // pool padrão: índices de "comando" (Beleza/Tá/Certo/Um instante) — nunca o 2 ("Boa pergunta")
  assert.notEqual(clip, 'CLIP:FILLER_2')
})

test('mensagem digitada na chamada (sem medida de voz): a "Fala mínima" não se aplica', async () => {
  const h = harness({ minSpeechMs: 5000 })
  h.emit({
    type: 'message-added',
    message: {
      id: 'typed',
      sessionId: 's1',
      seq: 1,
      message: { role: 'user', content: 'qual a capital da Austrália e por que não é Sydney?' },
      createdAt: 1
    }
  })
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(h.emitted.filter((u) => u.kind === 'filler').length, 1)
})

test('pickFillerPhrase: frase só de pergunta nunca sai sem pergunta (nem como último recurso)', () => {
  const pool = [
    { text: 'Boa pergunta, deixa eu pensar.', contexts: ['question' as const] },
    { text: 'Um instante.', contexts: ['command' as const] }
  ]
  for (let i = 0; i < 20; i++)
    assert.equal(
      pickFillerPhrase(pool, 'generic', [1], () => i / 20),
      1,
      'cai na usada, não na de pergunta'
    )
  assert.equal(
    pickFillerPhrase([pool[0]], 'command', [], () => 0),
    null,
    'só pergunta no pool → nada'
  )
  assert.equal(
    pickFillerPhrase(pool, 'question', [], () => 0),
    0
  )
})
