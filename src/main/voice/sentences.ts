// Corte de sentenças para o TTS por sentença da chamada de voz (função pura, sem Electron):
// `splitSentences` separa as sentenças COMPLETAS de um buffer de texto e devolve o resto ainda
// incompleto. O gestor da chamada (`voice/call.ts`) acumula o texto em streaming e corta uma
// sentença por vez, sintetizando cada uma inteira (sem streaming de áudio por tokens).
//
// Regras (testadas em `e2e/voiceCall.test.ts`):
// - fronteira = marca final `[.!?…]` (+ marcas repetidas `?!`) seguida de fechos opcionais
//   (`"»')]}` …) e então espaço/quebra de linha — ou o FIM do buffer quando `final: true`
//   (flush do fim da resposta; em streaming o fim do buffer pode continuar "Dr. Silva");
// - `.` NÃO corta: entre dígitos (decimal "3.14"), quando o trecho desde a última fronteira é só
//   um número ("1." de lista) ou quando a última palavra é uma abreviação pt-BR comum ("ex.",
//   "etc.", "Dr.", "p.ex."…) — exceto no fim do buffer com `final: true` (é o fim da resposta);
// - sem fronteira há muito tempo: corte forçado no último espaço antes de `maxChars` (padrão 240)
//   — resposta sem pontuação nunca espera o fim inteiro para começar a falar;
// - `commaCutMin` (1º pedaço da resposta): vírgula + espaço depois de ≥ N chars também corta — o
//   TTS começa a falar antes (a 1ª frase longa vira duas utterances).
export interface SentenceSplit {
  /** Sentenças completas, na ordem, já aparadas (uma por utterance do TTS). */
  sentences: string[]
  /** Trecho final ainda sem fronteira (acumular com o próximo delta). */
  rest: string
}

export const DEFAULT_SENTENCE_MAX_CHARS = 240

/** Mínimo de chars do 1º pedaço da resposta para a vírgula cortar (TTS começa antes). */
export const FIRST_CHUNK_COMMA_MIN = 25

/** Abreviações pt-BR comuns (minúsculas, sem o ponto final) — o `.` delas não corta sentença. */
const ABBREVIATIONS: ReadonlySet<string> = new Set([
  'ex',
  'exs',
  'etc',
  'p.ex',
  'p.exs',
  'p',
  'n',
  'núm',
  'dr',
  'dra',
  'sr',
  'sra',
  'srta',
  'prof',
  'profa',
  'eng',
  'av',
  'pe',
  'tel',
  'ed',
  'op',
  'cf',
  'ca',
  'cia',
  'ltda',
  'vs',
  'a.c',
  'd.c',
  'seg',
  'ter',
  'qua',
  'qui',
  'sex',
  'sáb',
  'dom',
  'jan',
  'fev',
  'mar',
  'abr',
  'mai',
  'jun',
  'jul',
  'ago',
  'set',
  'out',
  'nov',
  'dez'
])

const MARKS = '.!?…'
/** Fechos que podem vir depois da marca antes do espaço: `."`, `?)`, `]`… */
const CLOSERS = '"\'»”’)]}'

const isDigit = (c: string): boolean => c >= '0' && c <= '9'
const isMark = (c: string): boolean => MARKS.includes(c)
const isCloser = (c: string): boolean => CLOSERS.includes(c)

/** Última "palavra" (letras/pontos internos) do trecho — para a checagem de abreviação. */
function trailingToken(seg: string): string {
  const m = seg.match(/[\p{L}.]+$/u)
  return m ? m[0].toLowerCase() : ''
}

/**
 * `.` na posição `i` é fronteira? (decimais, marcadores de lista e abreviações não cortam).
 * `atEnd` (fim do buffer com `final: true`) corta SEMPRE — no fim da resposta "Etc." é o fim.
 */
function dotCuts(
  buffer: string,
  i: number,
  segStart: number,
  atEnd: boolean,
  final: boolean
): boolean {
  if (atEnd && final) return true
  if (i > 0 && isDigit(buffer[i - 1]) && i + 1 < buffer.length && isDigit(buffer[i + 1]))
    return false
  const seg = buffer.slice(segStart, i)
  if (/^\d+$/.test(seg.trim())) return false // "1." / "2." de lista numerada
  const token = trailingToken(seg)
  return !(token && ABBREVIATIONS.has(token))
}

/**
 * Corta as sentenças completas de `buffer`. `final: true` trata o fim do buffer como fronteira
 * (flush do fim da resposta); `maxChars` limita o `rest` acumulado (corte forçado em espaço).
 * `rest` volta sem espaço à esquerda (o que vem depois de um corte é início de sentença).
 */
export function splitSentences(
  buffer: string,
  opts: { final?: boolean; maxChars?: number; commaCutMin?: number } = {}
): SentenceSplit {
  const commaMin =
    typeof opts.commaCutMin === 'number' && opts.commaCutMin > 0 ? opts.commaCutMin : 0
  const maxChars =
    typeof opts.maxChars === 'number' && opts.maxChars > 0
      ? Math.round(opts.maxChars)
      : DEFAULT_SENTENCE_MAX_CHARS
  const sentences: string[] = []
  let segStart = 0
  let i = 0
  while (i < buffer.length) {
    // 1º pedaço: vírgula seguida de espaço depois de ≥ commaMin chars também é fronteira
    if (
      commaMin &&
      !sentences.length &&
      buffer[i] === ',' &&
      i + 1 < buffer.length &&
      /\s/.test(buffer[i + 1]) &&
      buffer.slice(segStart, i).trim().length >= commaMin
    ) {
      const chunk = buffer.slice(segStart, i + 1).trim()
      if (chunk) sentences.push(chunk)
      segStart = i + 1
      i = i + 1
      continue
    }
    if (!isMark(buffer[i])) {
      i++
      continue
    }
    // marca (+ marcas repetidas) + fechos; fronteira = espaço depois (ou o fim, com `final`)
    let j = i
    while (j < buffer.length && isMark(buffer[j])) j++
    while (j < buffer.length && isCloser(buffer[j])) j++
    const atEnd = j >= buffer.length
    const boundary = atEnd ? !!opts.final : /\s/.test(buffer[j])
    if (!boundary) {
      i++
      continue
    }
    if (buffer[i] === '.' && !dotCuts(buffer, i, segStart, atEnd, !!opts.final)) {
      i++
      continue
    }
    const sentence = buffer.slice(segStart, j).trim()
    if (sentence) sentences.push(sentence)
    segStart = j
    i = j
  }
  let rest = buffer.slice(segStart)
  // corte forçado: sem fronteira há mais que maxChars → corta no último espaço (ou em maxChars)
  if (rest.length > maxChars) {
    let cut = -1
    for (let k = Math.min(maxChars, rest.length - 1); k > 0; k--) {
      if (/\s/.test(rest[k])) {
        cut = k
        break
      }
    }
    if (cut <= 0) cut = maxChars
    const forced = rest.slice(0, cut).trim()
    if (forced) sentences.push(forced)
    rest = rest.slice(cut)
  }
  return { sentences, rest: rest.trimStart() }
}
