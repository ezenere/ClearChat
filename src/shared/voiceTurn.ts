// Fim de turno adaptativo da chamada de voz — política PURA (sem Electron/UI/IPC; testada em
// `e2e/voiceTurnEnd.test.ts`). O renderer (`useVoiceCall`) alimenta o `AdaptiveTurnGate` com os
// quadros RMS da captura; aos `speculativeAtMs` de pausa pede a transcrição ESPECULATIVA do que já
// foi dito (`voice:transcribe:speculate`) e o veredito de `classifyUtteranceEnd` define quanto
// silêncio ainda falta para fechar o turno. Ver SPEC.md → "Chamada de voz (meia-duplex)" →
// "Fim de turno adaptativo".
//
// Heurística pt-BR (v1, sem classificador): o STT (whisper) põe ponto final em quase tudo — inclusive
// em história contada aos pedaços — então o ponto sozinho NÃO é "completo": vira `statement` (espera
// intermediária). Completo = pergunta ("?", palavra interrogativa no começo), comando/pedido
// (imperativo/"pode…" no começo) ou fecho curto ("obrigado", "é isso", "valeu"). Inacabado =
// termina em conectivo/preposição/artigo ("e", "mas", "então", "porque", "que", "de"…), vírgula,
// reticências ou hesitação ("é…", "tipo", "hum").
import type { TurnTiming } from './voice'

/** Como a fala do usuário termina (decide o silêncio que fecha o turno). */
export type UtteranceEnd = 'complete' | 'statement' | 'unfinished' | 'unknown'

const fold = (s: string): string =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')

/** Palavras que, no FIM da fala, indicam que a frase continua (conectivos, preposições, artigos, hesitações). */
const TRAILING_CONNECTORS: ReadonlySet<string> = new Set([
  'e',
  'mas',
  'entao',
  'porque',
  'pois',
  'que',
  'ou',
  'nem',
  'quando',
  'se',
  'como',
  'onde',
  'enquanto',
  'embora',
  'tipo',
  'assim',
  'ai',
  'dai',
  'depois',
  'tambem',
  'inclusive',
  'principalmente',
  'tipo assim',
  'de',
  'da',
  'do',
  'das',
  'dos',
  'em',
  'no',
  'na',
  'nos',
  'nas',
  'num',
  'numa',
  'para',
  'pra',
  'pro',
  'pras',
  'pros',
  'com',
  'sem',
  'por',
  'pelo',
  'pela',
  'pelos',
  'pelas',
  'sobre',
  'entre',
  'ate',
  'ao',
  'aos',
  'a',
  'o',
  'os',
  'as',
  'um',
  'uma',
  'uns',
  'umas',
  'meu',
  'minha',
  'seu',
  'sua',
  'esse',
  'essa',
  'este',
  'esta',
  'aquele',
  'aquela',
  'cujo',
  'cuja',
  'qual',
  'eh',
  'ah',
  'ahn',
  'hum',
  'hmm',
  'uhm',
  'tipo'
])

/**
 * Interrogativas inequívocas no começo (o STT às vezes omite o "?") — "como/quando/onde/o que"
 * ficam de fora: abrem narrativa com a mesma frequência ("Quando eu cheguei lá…").
 */
const QUESTION_START = /^(qual|quais|quantos|quantas|sera que|voce sabe|tem como|da pra|da para)\b/

/** Imperativos/pedidos comuns no começo (comando/tarefa). */
const COMMAND_START =
  /^(por favor,? )?(lista|liste|listar|mostra|mostre|abre|abra|cria|crie|roda|rode|executa|execute|procura|procure|busca|busque|le|leia|escreve|escreva|apaga|apague|muda|mude|troca|troque|coloca|coloque|manda|mande|envia|envie|verifica|verifique|confere|confira|calcula|calcule|traduz|traduza|resume|resuma|explica|explique|descreve|descreva|me diz|me diga|me fala|me conta|me mostra|me ajuda|diga|pare|continua|continue|repete|repita|tenta|tente|adiciona|adicione|remove|remova|instala|instale|atualiza|atualize|compila|compile|testa|teste|salva|salve|copia|copie|move|mova|renomeia|renomeie|pesquisa|pesquise|analisa|analise|corrige|corrija|gera|gere|escolhe|escolha|marca|marque|agenda|agende|ligue|desliga|desligue|pode|podes|voce pode|vc pode)\b/

/** Fechos curtos que encerram a fala sozinhos ("obrigado", "é isso"). */
const CLOSING =
  /^(obrigad[oa]|valeu|e isso|e so isso|so isso|tchau|ok|okay|beleza|ta bom|ta|certo|entendi|perfeito|pode ser|sim|nao|claro|combinado|fechou|isso|exato|show|otimo|legal|bom dia|boa tarde|boa noite|oi|ola)( (entao|mesmo|ai|obrigad[oa]))?$/

/** Palavras da fala (minúsculas, sem acento/pontuação). */
function words(s: string): string[] {
  return fold(s)
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
}

/** Última frase da fala (depois do último `.!?` interno) — o começo dela decide comando/pergunta. */
function lastSentence(text: string): string {
  const t = text.trim().replace(/[.!?…]+$/u, '')
  const m = t.split(/[.!?…]\s+/u)
  return (m[m.length - 1] ?? '').trim()
}

/** A fala soa como pergunta (termina em "?" ou começa com interrogativa)? */
export function isQuestionLike(text: string): boolean {
  const t = String(text ?? '').trim()
  if (!t) return false
  if (/\?["'»”)\]]*$/u.test(t)) return true
  return QUESTION_START.test(fold(lastSentence(t)))
}

/** A fala soa como comando/pedido (imperativo, "pode…", "quero…" no começo da última frase)? */
export function isCommandLike(text: string): boolean {
  const t = String(text ?? '').trim()
  if (!t) return false
  return COMMAND_START.test(fold(lastSentence(t)))
}

/**
 * Como a fala termina (texto da transcrição especulativa/final ou a cauda da parcial). Ordem:
 * vazio → `unknown`; reticências/vírgula/dois-pontos/conectivo no fim → `unfinished`; "?"/"!" ou
 * interrogativa/comando/fecho curto → `complete`; o resto (ponto final ou sem pontuação) →
 * `statement` (o ponto do STT não prova fim de turno).
 */
export function classifyUtteranceEnd(text: string): UtteranceEnd {
  const t = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!t) return 'unknown'
  if (/(\.\.\.|…)["'»”)\]]*$/u.test(t)) return 'unfinished'
  if (/[,;:\-–—]["'»”)\]]*$/u.test(t)) return 'unfinished'
  const ws = words(t)
  if (!ws.length) return 'unknown'
  const last = ws[ws.length - 1]
  const last2 = ws.slice(-2).join(' ')
  if (TRAILING_CONNECTORS.has(last) || TRAILING_CONNECTORS.has(last2)) {
    // "e" sozinho como fecho de pergunta ("e você?") já saiu acima pelo "?"
    return 'unfinished'
  }
  if (/[?!]["'»”)\]]*$/u.test(t)) return 'complete'
  const sentence = lastSentence(t)
  const sWords = words(sentence)
  if (sWords.length && sWords.length <= 4 && CLOSING.test(sWords.join(' '))) return 'complete'
  if (isQuestionLike(t)) return 'complete'
  if (isCommandLike(t)) return 'complete'
  return 'statement'
}

/** Silêncio (ms) que fecha o turno para o veredito (`unknown` = sem transcrição → fallback). */
export function turnSilenceFor(end: UtteranceEnd, timing: TurnTiming): number {
  switch (end) {
    case 'complete':
      return timing.completeMs
    case 'statement':
      return timing.statementMs
    case 'unfinished':
      return timing.unfinishedMs
    default:
      return timing.fallbackMs
  }
}

/** Evento de fronteira do `AdaptiveTurnGate`. */
export type AdaptiveGateEvent = 'start' | 'speculate' | 'resume' | 'end' | null

/**
 * Porta de fala do usuário com fim de turno adaptativo (pura). `'start'` no 1º quadro audível;
 * `'speculate'` UMA vez por pausa quando o silêncio contínuo cruza `speculativeAtMs` (o chamador
 * pede a transcrição especulativa e devolve o veredito em `setVerdict`); `'resume'` quando a fala
 * volta depois de um `'speculate'` (a especulação ficou velha); `'end'` quando o silêncio alcança o
 * exigido. Enquanto a especulação está pendente o exigido é o TETO (`unfinishedMs`; `pendingMs`
 * quando definido — especulação lenta pela API) — o veredito só encurta; sem adaptativo (ou veredito `unknown`) o exigido é `fallbackMs`.
 */
export class AdaptiveTurnGate {
  readonly threshold: number
  readonly timing: TurnTiming
  #speaking = false
  #silenceMs = 0
  #speculating = false
  #verdict: UtteranceEnd | null = null
  #specSeq = 0

  constructor(timing: TurnTiming, threshold: number) {
    this.timing = timing
    this.threshold = Number.isFinite(threshold) && threshold >= 0 ? threshold : 0.01
  }

  get speaking(): boolean {
    return this.#speaking
  }

  /** Silêncio contínuo atual (ms; 0 = falando ou fora de fala). */
  get pauseMs(): number {
    return this.#speaking ? this.#silenceMs : 0
  }

  /** Veredito da pausa atual (null = ainda sem). */
  get verdict(): UtteranceEnd | null {
    return this.#verdict
  }

  /** Há especulação em curso nesta pausa (pedida e sem veredito). */
  get speculating(): boolean {
    return this.#speculating && this.#verdict == null
  }

  /** Geração da especulação atual (o veredito de uma geração velha é ignorado). */
  get specSeq(): number {
    return this.#specSeq
  }

  /** Silêncio exigido agora para fechar o turno. */
  get requiredMs(): number {
    const t = this.timing
    if (!t.adaptive) return t.fallbackMs
    if (this.#verdict) return turnSilenceFor(this.#verdict, t)
    // especulação pendente: o teto — ou `pendingMs` quando ela é lenta (API: não adianta esperar
    // o teto inteiro; a final reaproveita a especulação em voo)
    if (this.#speculating) return t.pendingMs ?? t.unfinishedMs
    return t.fallbackMs
  }

  /**
   * Veredito da especulação `seq` (ignorado se a fala voltou/geração velha). Devolve `'end'` quando
   * o silêncio já cumpriu o novo exigido (o chamador fecha o turno na hora).
   */
  setVerdict(seq: number, verdict: UtteranceEnd): 'end' | null {
    if (!this.#speaking || seq !== this.#specSeq || !this.#speculating) return null
    this.#verdict = verdict
    if (this.#silenceMs >= this.requiredMs) {
      this.#close()
      return 'end'
    }
    return null
  }

  push(rms: number, frameMs: number): AdaptiveGateEvent {
    const dt = Number.isFinite(frameMs) && frameMs > 0 ? frameMs : 0
    const loud = rms >= this.threshold
    if (!this.#speaking) {
      if (!loud) return null
      this.#speaking = true
      this.#silenceMs = 0
      this.#resetPause()
      return 'start'
    }
    if (loud) {
      const resumed = this.#speculating
      this.#silenceMs = 0
      this.#resetPause()
      return resumed ? 'resume' : null
    }
    this.#silenceMs += dt
    const t = this.timing
    if (t.adaptive && !this.#speculating && this.#silenceMs >= t.speculativeAtMs) {
      this.#speculating = true
      this.#specSeq++
      return 'speculate'
    }
    if (this.#silenceMs >= this.requiredMs) {
      this.#close()
      return 'end'
    }
    return null
  }

  /** Descarta a fala em curso (sem `'end'`) — mudo, parada, captura reiniciada. */
  reset(): void {
    this.#speaking = false
    this.#silenceMs = 0
    this.#resetPause()
  }

  #resetPause(): void {
    this.#speculating = false
    this.#verdict = null
  }

  #close(): void {
    this.#speaking = false
    this.#silenceMs = 0
    // o veredito fica legível até o próximo 'start' (o chamador decide reusar a especulação)
  }
}

/**
 * Prefixo do `content` que cobre as sentenças efetivamente FALADAS (na ordem — cada uma procurada a
 * partir do fim da anterior, ignorando espaços): preserva a formatação original. Sentença não
 * encontrada → as faladas unidas por espaço (melhor esforço). Sem sentenças → ''.
 */
export function spokenPrefix(content: string, sentences: readonly string[]): string {
  const spoken = sentences.map((s) => s.trim()).filter(Boolean)
  if (!spoken.length) return ''
  let cursor = 0
  for (const s of spoken) {
    const at = content.indexOf(s, cursor)
    if (at < 0) return spoken.join(' ')
    cursor = at + s.length
  }
  return content.slice(0, cursor).trimEnd()
}

const BACKCHANNEL_TEXT =
  /^(uhum+|aham+|hum+|hm+|uh+|ah+|ok|okay|ta|sim|certo|isso|entendi|beleza|show|legal|bom)$/

/**
 * A fala inteira é só um backchannel do usuário ("uhum", "aham", "tá", "ok") — não é conteúdo novo:
 * com a resposta retida, ela volta a ser falada em vez de virar turno continuado.
 */
export function isBackchannelText(text: string): boolean {
  const t = fold(String(text ?? ''))
    .replace(/[^\p{L}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!t) return false
  const parts = t.split(' ')
  return parts.length <= 3 && parts.every((p) => BACKCHANNEL_TEXT.test(p))
}
