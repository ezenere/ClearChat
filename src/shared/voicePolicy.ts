// Atos de fala curta da chamada de voz — política PURA (sem Electron/UI/IPC/fS): regras dos
// fillers (fase 1) e das interjeições/backchannel (fase 2), testáveis em `e2e/voiceCallActs.test.ts`.
// O consumo real: `src/main/voice/call.ts` (fillers/interjeições, sombra) e
// `src/renderer/src/lib/voice/useVoiceCall.ts` (detector de pausas/bargem-in). Ver SPEC.md →
// "Áudio → Chamada de voz (meia-duplex)" (subseções "Fillers" e "Interjeições (regras)").
//
// v1 é por REGRA (sem classificador treinado): os limiares abaixo + a cauda textual da transcrição
// parcial decidem. `VoiceFillers.prompt`/`InterjectionPolicy` existem na config; o `prompt` dos
// fillers NÃO é consumido em v1 — fica pronto para o classificador futuro (documentado na SPEC).
import {
  DEFAULT_FILLER_DELAY_MS,
  type FillerContext,
  type FillerPhrase,
  type InterjectionClass,
  type InterjectionPolicy
} from './voice'
import { classifyUtteranceEnd, isCommandLike, isQuestionLike, type UtteranceEnd } from './voiceTurn'

// ---------------- constantes de tempo ----------------

/**
 * Espera padrão entre o turno enviado e o preâmbulo (ms): se a 1ª frase da resposta ficar pronta
 * antes disso, o preâmbulo nem sai (configurável em `voiceCallDefaults.fillers.delayMs`).
 */
export const FILLER_DELAY_MS = DEFAULT_FILLER_DELAY_MS

/** Preâmbulo não repete nenhum dos últimos N usados. */
export const FILLER_RECENT_WINDOW = 4

/** Fala do usuário com menos palavras que isto (e que não é pergunta) não ganha preâmbulo. */
export const FILLER_MIN_WORDS = 3

/**
 * Fala do usuário curta DURANTE a reprodução (ms de fala detectada) = provável backchannel do
 * usuário ("uhum", "sim") — não cancela a resposta; acima disso é barge-in real (cancela).
 */
export const BACKCHANNEL_MAX_MS = 800

/**
 * Validade de uma decisão de interjeição (ms): decisão que "chega" > 600 ms tarde demais é
 * descartada (o momento da pausa passou — tocar depois vira interrupção).
 */
export const INTERJECTION_MAX_AGE_MS = 600

/** Cauda da transcrição parcial considerada pela regra de classe (caracteres). */
export const INTERJECTION_TAIL_CHARS = 80

/** Teto da cauda de texto guardada no log de avaliação (caracteres). */
export const EVAL_TAIL_MAX_CHARS = 80

// ---------------- fillers (fase 1) ----------------

/** Estado do filler do turno em andamento (quem decide = `fillerShouldFire`). */
export interface FillerState {
  /** Momento em que o turno do usuário foi disparado (ms); null = sem turno em andamento. */
  turnStartedAt: number | null
  /** Há tools em execução no turno (o espera costuma ser longa → filler já). */
  toolsRunning: boolean
  /** O agente já falou algo neste turno (1ª utterance de sentença emitida). */
  spokenThisTurn: boolean
  /** O filler deste turno já foi disparado (máximo 1 por turno). */
  usedThisTurn: boolean
  /** A resposta está em voo (sem resposta, não há o que esperar). */
  responseInFlight: boolean
  /** `fillers.enabled` resolvido (persona→chat→global). */
  enabled: boolean
}

/** Estado vazio (turno em repouso). */
export const EMPTY_FILLER_STATE: FillerState = {
  turnStartedAt: null,
  toolsRunning: false,
  spokenThisTurn: false,
  usedThisTurn: false,
  responseInFlight: false,
  enabled: true
}

/**
 * O filler (preâmbulo) deste turno deve tocar AGORA? Regra v2 (por regra, sem classificador):
 * - no máximo 1 por turno (`usedThisTurn`) e NUNCA depois de a 1ª frase da resposta ficar pronta
 *   (`spokenThisTurn`) — resposta rápida dispensa o preâmbulo;
 * - com tools em execução, dispara já; senão após `delayMs` (0 = já; inválido/negativo → o padrão);
 * - só com resposta em voo e filler habilitado.
 */
export function fillerShouldFire(
  s: FillerState,
  now: number,
  delayMs: number = FILLER_DELAY_MS
): boolean {
  if (!s.enabled || s.usedThisTurn || s.spokenThisTurn || !s.responseInFlight) return false
  if (s.turnStartedAt == null) return false
  if (s.toolsRunning) return true
  const wait = Number.isFinite(delayMs) && delayMs >= 0 ? delayMs : FILLER_DELAY_MS
  return now - s.turnStartedAt >= wait
}

const CORRECTION_START =
  /^(nao|na verdade|espera|espere|pera|perai|peraí|pera ai|calma|opa|ops|quer dizer|errado|nao e isso|nao nao)\b/

const foldText = (s: string): string =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .trim()

/** Contagem de palavras (para "fala curta"/"pedido longo"). */
export function wordCount(text: string): number {
  return String(text ?? '')
    .split(/\s+/)
    .filter((w) => /[\p{L}\p{N}]/u.test(w)).length
}

/**
 * Contexto do turno que escolhe o preâmbulo: correção/interrupção ("não…", "espera", "peraí") →
 * `correction`; pedido longo (≥ 25 palavras ou > 160 chars) → `complex`; pergunta → `question`;
 * comando/tarefa → `command`; resto → `generic`.
 */
export function classifyFillerContext(text: string): FillerContext {
  const t = String(text ?? '').trim()
  if (!t) return 'generic'
  if (CORRECTION_START.test(foldText(t))) return 'correction'
  if (wordCount(t) >= 25 || t.length > 160) return 'complex'
  if (isQuestionLike(t)) return 'question'
  if (isCommandLike(t)) return 'command'
  return 'generic'
}

/**
 * Escolhe a frase do pool (índice 0-based) para o contexto: candidatas = frases do contexto (sem
 * contexto declarado = `generic`) fora das `recent` (últimos `FILLER_RECENT_WINDOW` índices usados);
 * sem candidata → as `generic` fora das recentes → qualquer frase fora das recentes → a usada há
 * mais tempo entre as do contexto. Sorteio uniforme via `rng` (1 chamada). Pool vazio → null.
 */
export function pickFillerPhrase(
  pool: readonly FillerPhrase[],
  ctx: FillerContext,
  recent: readonly number[],
  rng: () => number = Math.random
): number | null {
  if (!pool.length) return null
  const window = recent.slice(-FILLER_RECENT_WINDOW)
  const fits = (i: number, c: FillerContext): boolean => {
    const cs = pool[i].contexts.length ? pool[i].contexts : (['generic'] as FillerContext[])
    return cs.includes(c)
  }
  // frase SÓ de pergunta ("Boa pergunta, deixa eu pensar.") nunca sai sem uma pergunta na
  // transcrição — nem como último recurso
  const questionOnly = (i: number): boolean =>
    pool[i].contexts.length > 0 && pool[i].contexts.every((c) => c === 'question')
  const all = pool.map((_, i) => i).filter((i) => ctx === 'question' || !questionOnly(i))
  if (!all.length) return null
  const fresh = (xs: number[]): number[] => xs.filter((i) => !window.includes(i))
  let cands = fresh(all.filter((i) => fits(i, ctx)))
  if (!cands.length && ctx !== 'generic') cands = fresh(all.filter((i) => fits(i, 'generic')))
  if (!cands.length) cands = fresh(all)
  if (!cands.length) {
    // tudo recente (pool pequeno): a do contexto usada há mais tempo
    const ofCtx = all.filter((i) => fits(i, ctx))
    const pickFrom = ofCtx.length ? ofCtx : all
    return pickFrom.reduce((best, i) => (window.indexOf(i) < window.indexOf(best) ? i : best))
  }
  let r = typeof rng === 'function' ? Number(rng()) : NaN
  if (!Number.isFinite(r)) r = Math.random()
  const k = Math.min(
    cands.length - 1,
    Math.floor(Math.min(Math.max(r, 0), 0.999999999) * cands.length)
  )
  return cands[k]
}

/** A fala é curta demais para preâmbulo (menos de `FILLER_MIN_WORDS` palavras e não é pergunta)? */
export function fillerTooShort(text: string): boolean {
  const t = String(text ?? '').trim()
  return wordCount(t) < FILLER_MIN_WORDS && !isQuestionLike(t)
}

/**
 * A fala teve menos VOZ que o mínimo configurado (`interjections.minSpeechMs` — "Fala mínima",
 * que vale para interjeições E para o preâmbulo)? `voicedMs` = tempo com voz da fala (do 1º ao
 * último quadro acima do limiar — `VoicedSpan.spanMs`), SEM o silêncio antes/depois nem a espera
 * do fim de turno; null = desconhecido (mensagem digitada, renderer antigo) → não barra.
 */
export function fillerBelowMinSpeech(
  voicedMs: number | null | undefined,
  minSpeechMs: number
): boolean {
  if (typeof voicedMs !== 'number' || !Number.isFinite(voicedMs)) return false
  const min = Number.isFinite(minSpeechMs) && minSpeechMs > 0 ? minSpeechMs : 0
  return voicedMs < min
}

/**
 * Tempo com VOZ de uma fala (renderer — quadros RMS da captura): `spanMs` = do início do 1º quadro
 * acima do limiar ao fim do último (as pausas internas contam — é a duração da fala), sem o
 * silêncio antes do 1º nem depois do último quadro com voz (o silêncio que fecha o turno, a espera
 * do veredito/da transcrição); `voicedMs` = só os quadros com voz.
 */
export class VoicedSpan {
  #elapsed = 0
  #first: number | null = null
  #lastEnd = 0
  #voiced = 0

  /** Duração da fala (1º → último quadro com voz, ms; 0 sem voz). */
  get spanMs(): number {
    return this.#first == null ? 0 : Math.max(0, this.#lastEnd - this.#first)
  }

  /** Soma dos quadros com voz (ms). */
  get voicedMs(): number {
    return this.#voiced
  }

  push(rms: number, frameMs: number, threshold: number): void {
    const dt = Number.isFinite(frameMs) && frameMs > 0 ? frameMs : 0
    if (rms >= threshold) {
      if (this.#first == null) this.#first = this.#elapsed
      this.#voiced += dt
      this.#lastEnd = this.#elapsed + dt
    }
    this.#elapsed += dt
  }

  reset(): void {
    this.#elapsed = 0
    this.#first = null
    this.#lastEnd = 0
    this.#voiced = 0
  }
}

// ---------------- frases de demora (sintetizadas ao vivo — SPEC → "Frases de demora") ----------------

/** No máximo N frases "manter viva" por turno. */
export const KEEPALIVE_MAX_PER_TURN = 2
/** Intervalo mínimo entre duas frases "manter viva" (ms, entre as decisões). */
export const KEEPALIVE_COOLDOWN_MS = 6000
/**
 * A desculpa NÃO toca quando uma frase "manter viva" saiu há menos que isto (ms) — o usuário acabou
 * de ouvir "só mais um instante"; emendar "desculpe a demora" soaria repetitivo.
 */
export const APOLOGY_AFTER_KEEPALIVE_MS = 4000
/** Frase de demora não repete nenhuma das últimas N do mesmo pool (limitado a pool − 1). */
export const DELAY_RECENT_WINDOW = 2

/** Estado das frases de demora no turno em andamento (o `VoiceCallManager` guarda). */
export interface DelayPhraseState {
  /** Turno disparado em (ms); null = desarmado (sem turno esperando resposta). */
  turnStartedAt: number | null
  /** Desde quando nada toca esperando a resposta (ms); null = algo audível agora. */
  silentSince: number | null
  /** Frases "manter viva" decididas neste turno. */
  keepAlives: number
  /** Última decisão de "manter viva" (ms) — o cooldown conta daqui. */
  lastKeepAliveAt: number | null
  /** A 1ª frase da resposta já ficou pronta (a desculpa não sai mais). */
  answerSpoken: boolean
  /** Há tool em execução agora (depois da 1ª frase, só aí volta a "manter viva"). */
  toolsRunning: boolean
  /** A síntese da desculpa já foi pedida neste turno. */
  apologyStarted: boolean
}

export const EMPTY_DELAY_STATE: DelayPhraseState = {
  turnStartedAt: null,
  silentSince: null,
  keepAlives: 0,
  lastKeepAliveAt: null,
  answerSpoken: false,
  toolsRunning: false,
  apologyStarted: false
}

/**
 * Momento (ms) em que a próxima frase "manter viva" fica devida; null = nenhuma neste turno (ou
 * enquanto algo toca). Regras: silêncio ≥ `keepAliveAfterMs` esperando a resposta — antes da 1ª
 * frase dela, ou depois dela só com tool rodando —, no máx. `KEEPALIVE_MAX_PER_TURN` por turno e
 * `KEEPALIVE_COOLDOWN_MS` entre elas.
 */
export function keepAliveDueAt(
  s: DelayPhraseState,
  cfg: { enabled: boolean; keepAliveAfterMs: number }
): number | null {
  if (!cfg.enabled || s.turnStartedAt == null || s.silentSince == null) return null
  if (s.keepAlives >= KEEPALIVE_MAX_PER_TURN) return null
  if (s.answerSpoken && !s.toolsRunning) return null
  let due = s.silentSince + Math.max(0, cfg.keepAliveAfterMs)
  if (s.lastKeepAliveAt != null) due = Math.max(due, s.lastKeepAliveAt + KEEPALIVE_COOLDOWN_MS)
  return due
}

/** Momento (ms) em que a síntese da desculpa começa; null = não neste turno. */
export function apologyDueAt(
  s: DelayPhraseState,
  cfg: { enabled: boolean; apologyAfterMs: number }
): number | null {
  if (!cfg.enabled || s.turnStartedAt == null || s.answerSpoken || s.apologyStarted) return null
  return s.turnStartedAt + Math.max(0, cfg.apologyAfterMs)
}

/** Por que a desculpa pronta NÃO toca antes da 1ª frase (null = toca). */
export type ApologySkip = 'not-ready' | 'keepalive-playing' | 'keepalive-recent' | 'clip-playing'

/**
 * A desculpa toca antes da 1ª frase da resposta? Só pronta (nunca se espera a síntese dela), sem
 * frase "manter viva" tocando ou recente (`APOLOGY_AFTER_KEEPALIVE_MS`) e sem outro clipe tocando
 * (a resposta já vai esperar ele terminar).
 */
export function apologySkipReason(input: {
  ready: boolean
  now: number
  keepAlivePlaying: boolean
  lastKeepAliveEmittedAt: number | null
  clipPlaying: boolean
}): ApologySkip | null {
  if (!input.ready) return 'not-ready'
  if (input.keepAlivePlaying) return 'keepalive-playing'
  if (
    input.lastKeepAliveEmittedAt != null &&
    input.now - input.lastKeepAliveEmittedAt < APOLOGY_AFTER_KEEPALIVE_MS
  )
    return 'keepalive-recent'
  if (input.clipPlaying) return 'clip-playing'
  return null
}

/**
 * Sorteia uma frase do pool (índice) sem repetir as últimas `DELAY_RECENT_WINDOW` (limitado a
 * pool − 1, para sempre sobrar candidata); pool vazio → null.
 */
export function pickDelayPhrase(
  pool: readonly string[],
  recent: readonly number[],
  rng: () => number = Math.random
): number | null {
  if (!pool.length) return null
  const n = Math.min(DELAY_RECENT_WINDOW, pool.length - 1)
  const window = n > 0 ? recent.slice(-n) : [] // slice(-0) devolveria tudo
  const cands = pool.map((_, i) => i).filter((i) => !window.includes(i))
  const list = cands.length ? cands : pool.map((_, i) => i)
  let r = typeof rng === 'function' ? Number(rng()) : NaN
  if (!Number.isFinite(r)) r = Math.random()
  const k = Math.min(
    list.length - 1,
    Math.floor(Math.min(Math.max(r, 0), 0.999999999) * list.length)
  )
  return list[k]
}

// ---------------- variantes de clipe ----------------

/**
 * Variante de clipe 1..`variants` com rotação sem repetir a última: sorteio uniforme via `rng`
 * (injetável — testes usam PRNG fake); caiu na última → a seguinte na rotação.
 */
export function pickClipVariant(rng: () => number, last: number | null, variants = 3): number {
  const n = Number.isFinite(variants) && variants >= 1 ? Math.floor(variants) : 1
  // rng chamado UMA vez (pode ser stateful); lixo/fora de [0,1) é aparado
  let r = typeof rng === 'function' ? Number(rng()) : NaN
  if (!Number.isFinite(r)) r = Math.random()
  const v = Math.min(n, Math.max(1, Math.floor(Math.min(Math.max(r, 0), 0.999999999) * n) + 1))
  if (last == null || v !== last) return v
  return (last % n) + 1
}

// ---------------- fala/pausa do usuário (quadros RMS) ----------------

/**
 * Acumulador puro de fala/pausa a partir do RMS dos quadros da captura: `speechMs` cresce nos
 * quadros audíveis e `pauseMs` acumula o silêncio CONTÍNUO atual (zera ao falar de novo).
 */
export class SpeechMeter {
  #speechMs = 0
  #pauseMs = 0

  /** Fala do usuário acumulada desde o último `reset` (ms). */
  get speechMs(): number {
    return this.#speechMs
  }

  /** Pausa contínua atual (ms; 0 = está falando). */
  get pauseMs(): number {
    return this.#pauseMs
  }

  /** Registra um quadro (`rms` 0..1, `frameMs` duração, `threshold` limiar de fala). */
  push(rms: number, frameMs: number, threshold: number): void {
    const dt = Number.isFinite(frameMs) && frameMs > 0 ? frameMs : 0
    if (rms >= threshold) {
      this.#speechMs += dt
      this.#pauseMs = 0
    } else {
      this.#pauseMs += dt
    }
  }

  /** Zera fala e pausa (início/fim de utterance). */
  reset(): void {
    this.#speechMs = 0
    this.#pauseMs = 0
  }
}

/**
 * Fala do usuário DURANTE a reprodução do assistente: backchannel (curta — "uhum", "sim"; só
 * registra, não cancela) ou barge-in real (longa; cancela a fala do assistente). Classe pura —
 * `useVoiceCall` alimenta com os quadros e executa as ações (`maxMs` = `BACKCHANNEL_MAX_MS`).
 */
export class PlaybackHold {
  /** Fala detectada (ms) acima da qual é barge-in real. */
  readonly maxMs: number
  #meter = new SpeechMeter()
  #open = false
  #committed = false

  constructor(maxMs: number = BACKCHANNEL_MAX_MS) {
    this.maxMs = Number.isFinite(maxMs) && maxMs > 0 ? maxMs : BACKCHANNEL_MAX_MS
  }

  /** Há uma fala retida em avaliação (backchannel × barge-in). */
  get open(): boolean {
    return this.#open
  }

  /** Fala detectada até agora (ms). */
  get speechMs(): number {
    return this.#meter.speechMs
  }

  /** Abre a retenção (o frame de início da fala já conta). */
  start(rms: number, frameMs: number, threshold: number): void {
    this.#open = true
    this.#committed = false
    this.#meter.reset()
    this.#meter.push(rms, frameMs, threshold)
  }

  /**
   * Quadro durante a fala retida: `'barge-in'` na transição em que a fala detectada passa de
   * `maxMs` (o chamador cancela a fala do assistente — uma única vez); senão `'pending'`.
   */
  frame(rms: number, frameMs: number, threshold: number): 'pending' | 'barge-in' {
    this.#meter.push(rms, frameMs, threshold)
    if (!this.#committed && this.#meter.speechMs > this.maxMs) {
      this.#committed = true
      return 'barge-in'
    }
    return 'pending'
  }

  /**
   * Fim da fala retida: `'backchannel'` quando curta (≤ `maxMs` — não cancelou nada) ou
   * `'barge-in'` quando longa (já cancelou durante os quadros). Sem fala retida → `'none'`.
   */
  end(): 'backchannel' | 'barge-in' | 'none' {
    if (!this.#open) return 'none'
    const long = this.#committed || this.#meter.speechMs > this.maxMs
    this.#open = false
    this.#committed = false
    return long ? 'barge-in' : 'backchannel'
  }

  /** Descarta a fala retida sem classificar (mudo/parada da chamada). */
  reset(): void {
    this.#open = false
    this.#committed = false
    this.#meter.reset()
  }
}

// ---------------- interjeições (fase 2) ----------------

/** Por que a política decidiu o que decidiu (calibração/testes). */
export type InterjectionReason =
  | 'ok'
  | 'disabled'
  | 'stale'
  | 'short-speech'
  | 'short-pause'
  | 'cooldown'
  | 'probability'
  | 'tail-skip'
  | 'class-filtered'
  | 'turn-end'

/** Resultado da política: `NONE` (o caso comum) ou a classe + variante a tocar. */
export type InterjectionDecision =
  | { class: 'NONE'; reason: InterjectionReason }
  | { class: InterjectionClass; variant: number; decidedAt: number; reason: InterjectionReason }

/** Observação do detector (pausa na fala do usuário) — o que a política tem para decidir. */
export interface InterjectionObservation {
  /** Fala do usuário acumulada no utterance atual (ms). */
  speechMs: number
  /** Pausa CONTÍNUA atual do usuário (ms). */
  pauseMs: number
  /** Cauda da transcrição parcial (texto livre; escolhe a classe; vazia = sem confiança). */
  tail: string
  /** Momento da observação (ms, mesmo relógio de `ctx.now`) — observação velha não decide. */
  observedAt: number
  /**
   * Veredito do fim de turno adaptativo para esta pausa (transcrição especulativa); ausente/null =
   * sem especulação (a cauda decide com `classifyUtteranceEnd`). `complete` = fim de turno provável
   * (pergunta/comando) → nunca backchannel.
   */
  end?: UtteranceEnd | null
}

export interface InterjectionContext {
  /** Agora (ms — o mesmo relógio de `observedAt`). */
  now: number
  /** Última interjeição DECIDIDA (ms); null = nenhuma ainda (cooldown). */
  lastFiredAt: number | null
  /** Última variante tocada por classe (rotação sem repetir). */
  lastVariant?: Partial<Record<InterjectionClass, number>>
  /** Variantes disponíveis por classe (clipes gerados; ausente = 3). */
  variants?: Partial<Record<InterjectionClass, number>>
}

const strip = (s: string): string =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')

const TAIL_NONE =
  /\b(nao|nunca|jamais|talvez|quem sabe|depende|nao sei|acho que nao|duvida|sera que|ta dificil|pera|espera ai)\b/
const TAIL_THINKING =
  /\b(hum+|hm+|ahn+|deixa (eu )?ver|vamos? ver|como (assim|e que)|ou seja|tipo assim)\b/
const TAIL_AGREEMENT =
  /\b(sim|isso|exato|certo|perfeito|otimo|beleza|ok|concordo|verdade|e isso|isso ai|tudo certo|show)\b/
const TAIL_ENCOURAGEMENT =
  /\b(consegui|deu certo|funcionou|terminei|fiz|pronto|vou tentar|vamos la|bora|seguindo|ai em diante)\b/

/**
 * Classe sugerida pela cauda textual da transcrição parcial (regra v1, sem classificador):
 * - pergunta ("?") → `ACK` — o `THINKING` ("hum…, deixa eu pensar…") é EVITADO em perguntas
 *   (soa resposta/ hesitação indecisa no meio de uma pergunta do usuário);
 * - negação/incerteza → `NONE` (backchannel no meio de uma dúvida soa desatenção);
 * - hesitação → `THINKING`; concordância → `AGREEMENT`; progresso/resultado → `ENCOURAGEMENT`;
 * - sem confiança (resto/vazio) → `ACK` neutro.
 */
export function classifyInterjectionTail(tail: string): InterjectionClass | 'NONE' {
  const t = strip(String(tail ?? ''))
    .slice(-INTERJECTION_TAIL_CHARS)
    .trim()
  if (!t) return 'ACK'
  if (t.endsWith('?')) return 'ACK' // THINKING evitado em perguntas
  if (TAIL_NONE.test(t)) return 'NONE'
  if (TAIL_THINKING.test(t)) return 'THINKING'
  // "deu certo"/"consegui" antes da concordância ("certo" também casa com AGREEMENT)
  if (TAIL_ENCOURAGEMENT.test(t)) return 'ENCOURAGEMENT'
  if (TAIL_AGREEMENT.test(t)) return 'AGREEMENT'
  return 'ACK'
}

/**
 * Decide a interjeição de uma observação (função pura; PRNG injetável — sorteio da probabilidade
 * e da variante são 2 chamadas ao `rng` quando a decisão sai). Portões, na ordem: habilitada,
 * observação fresca (≤ `INTERJECTION_MAX_AGE_MS`), fala ≥ `minSpeechMs`, pausa ≥ `minPauseMs`,
 * cooldown desde a última, classe da cauda nas `classes` permitidas e `fireProbability`.
 * `NONE` é, de longe, o resultado mais comum — inclusive porque o detector só observa pausas.
 */
export function decideInterjection(
  obs: InterjectionObservation,
  policy: InterjectionPolicy,
  ctx: InterjectionContext,
  rng: () => number = Math.random
): InterjectionDecision {
  const none = (reason: InterjectionReason): InterjectionDecision => ({ class: 'NONE', reason })
  if (!policy.enabled) return none('disabled')
  const now = Number.isFinite(ctx.now) ? ctx.now : 0
  const observedAt = Number.isFinite(obs.observedAt) ? obs.observedAt : now
  if (now - observedAt > INTERJECTION_MAX_AGE_MS) return none('stale')
  const speechMs = Number.isFinite(obs.speechMs) ? obs.speechMs : 0
  const pauseMs = Number.isFinite(obs.pauseMs) ? obs.pauseMs : 0
  if (speechMs < policy.minSpeechMs) return none('short-speech')
  if (pauseMs < policy.minPauseMs) return none('short-pause')
  if (ctx.lastFiredAt != null && now - ctx.lastFiredAt < policy.cooldownMs) return none('cooldown')
  // fim de turno provável (pergunta/comando/fecho): o backchannel vira "Aham." → preâmbulo →
  // resposta; quem fala agora é a resposta
  const end = obs.end ?? classifyUtteranceEnd(obs.tail)
  if (end === 'complete') return none('turn-end')
  if (isQuestionLike(obs.tail) || isCommandLike(obs.tail)) return none('turn-end')
  const cls = classifyInterjectionTail(obs.tail)
  if (cls === 'NONE') return none('tail-skip')
  if (!policy.classes.includes(cls)) return none('class-filtered')
  const fire = Number.isFinite(policy.fireProbability) ? policy.fireProbability : 0
  // rng chamado UMA vez por sorteio (probabilidade e depois a variante)
  let roll = typeof rng === 'function' ? Number(rng()) : NaN
  if (!Number.isFinite(roll)) roll = Math.random()
  if (!(roll < fire)) return none('probability')
  const last = ctx.lastVariant?.[cls] ?? null
  return {
    class: cls,
    variant: pickClipVariant(rng, last, ctx.variants?.[cls] ?? 3),
    decidedAt: now,
    reason: 'ok'
  }
}

/**
 * Detector de pausas para as interjeições: emite UMA observação por episódio de pausa, quando o
 * silêncio contínuo cruza `minPauseMs` (o `decideInterjection` filtra o resto). Novo episódio só
 * depois de o usuário falar de novo.
 */
export class InterjectionWatcher {
  readonly minPauseMs: number
  #meter = new SpeechMeter()
  #emitted = false

  constructor(minPauseMs: number) {
    this.minPauseMs = Number.isFinite(minPauseMs) && minPauseMs > 0 ? minPauseMs : 0
  }

  get speechMs(): number {
    return this.#meter.speechMs
  }

  get pauseMs(): number {
    return this.#meter.pauseMs
  }

  /**
   * Registra um quadro e devolve a observação no momento em que a pausa cruza `minPauseMs`
   * (uma por episódio; `tail` é preenchida pelo chamador).
   */
  push(
    rms: number,
    frameMs: number,
    threshold: number,
    now: number
  ): InterjectionObservation | null {
    const before = this.#meter.pauseMs
    this.#meter.push(rms, frameMs, threshold)
    if (this.#meter.pauseMs === 0) {
      this.#emitted = false // voltou a falar: episódio novo
      return null
    }
    if (this.#emitted || before >= this.minPauseMs) return null
    if (this.#meter.pauseMs < this.minPauseMs) return null
    this.#emitted = true
    return {
      speechMs: this.#meter.speechMs,
      pauseMs: this.#meter.pauseMs,
      tail: '',
      observedAt: now
    }
  }

  /** Fim do utterance (descarta o episódio em curso). */
  reset(): void {
    this.#meter.reset()
    this.#emitted = false
  }
}
