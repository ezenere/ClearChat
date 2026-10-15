// Questionário (tool ask_user) — partes puras compartilhadas por main e renderer: validação dos
// argumentos, classificação de ícones/imagens/ajuda, validação das respostas e o texto do
// resultado enviado ao modelo. Ver SPEC.md → "Questionário (ask_user)".
import type { AskUserQuestion, QuestionAnswer } from './types'

export const ASK_USER_LIMITS = {
  maxQuestions: 5,
  maxOptions: 5,
  titleChars: 200,
  descriptionChars: 1000,
  helpChars: 4000,
  /** Ícone em texto (emoji). */
  iconTextChars: 16,
  /** URL / caminho / data URL. */
  refChars: 4000,
  /** SVG inline (bytes UTF-8). */
  svgBytes: 200 * 1024,
  /** Imagem baixada / lida do disco. */
  imageBytes: 5 * 1024 * 1024,
  downloadTimeoutMs: 15_000,
  /** Texto de "Outro". */
  otherChars: 4000
} as const

/** Resultado quando o usuário cancela (Esc, Parar, ⚡). O agente para em seguida. */
export const ASK_USER_NOT_ANSWERED = '[O usuário não respondeu ao questionário]'
/** Resultado quando o app foi fechado com o questionário pendente. */
export const ASK_USER_APP_CLOSED = '[não respondido: o app foi fechado]'

/** Opção como o modelo enviou (strings cruas, ainda não resolvidas). */
export interface RawAskUserOption {
  title: string
  description?: string
  icon?: string
  image?: string
  help?: string
}
export interface RawAskUserQuestion {
  title: string
  description?: string
  multiple: boolean
  options: RawAskUserOption[]
}

export type ImageRefKind = 'svg' | 'url' | 'data' | 'path'
export type IconKind = ImageRefKind | 'lucide' | 'text'

const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif|svg)$/i
const LUCIDE_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Forma de uma referência de imagem (`image`): svg inline, URL http(s), data URL ou caminho. */
export function classifyImageRef(s: string): ImageRefKind {
  const t = s.trim()
  if (/^<svg[\s>]/i.test(t) || /^<\?xml[\s\S]*<svg[\s>]/i.test(t)) return 'svg'
  if (/^https?:\/\//i.test(t)) return 'url'
  if (/^data:/i.test(t)) return 'data'
  return 'path'
}

/**
 * Forma de um `icon`: "<svg…>" → svg inline; http(s):// → URL; data: → data URL; parece caminho
 * (contém / ou \ ou termina em extensão de imagem) → arquivo local; kebab-case → ícone lucide;
 * senão → texto (emoji).
 */
export function classifyIcon(s: string): IconKind {
  const t = s.trim()
  const k = classifyImageRef(t)
  if (k !== 'path') return k
  if (/[\\/]/.test(t) || IMAGE_EXT_RE.test(t)) return 'path'
  if (LUCIDE_RE.test(t)) return 'lucide'
  return 'text'
}

/**
 * Forma de um `help`: imagem (svg inline, URL, data URL, ou caminho de uma linha só terminado em
 * extensão de imagem) ou texto (monospace — ASCII art com barras continua texto).
 */
export function classifyHelp(s: string): ImageRefKind | 'text' {
  const t = s.trim()
  const k = classifyImageRef(t)
  if (k === 'svg') return 'svg'
  if (k === 'url' || k === 'data') return /\s/.test(t) ? 'text' : k
  if (!/\s/.test(t) && IMAGE_EXT_RE.test(t)) return 'path'
  return 'text'
}

const utf8Len = (s: string): number => new TextEncoder().encode(s).length

/** Limite para uma referência de imagem (svg inline maior; URL/caminho menor). */
function refError(value: string, where: string): string | null {
  if (classifyImageRef(value) === 'svg') {
    const n = utf8Len(value)
    return n > ASK_USER_LIMITS.svgBytes
      ? `${where}: SVG inline com ${Math.round(n / 1024)} KB — máximo ${ASK_USER_LIMITS.svgBytes / 1024} KB`
      : null
  }
  if (classifyImageRef(value) === 'data') {
    return value.length > ASK_USER_LIMITS.imageBytes * 1.4
      ? `${where}: data URL grande demais (máx. ${ASK_USER_LIMITS.imageBytes / 1024 / 1024} MB)`
      : null
  }
  return value.length > ASK_USER_LIMITS.refChars
    ? `${where}: referência com ${value.length} caracteres — máximo ${ASK_USER_LIMITS.refChars}`
    : null
}

function optBool(v: unknown): boolean | 'invalid' {
  if (v === undefined || v === null || v === false || v === 'false') return false
  if (v === true || v === 'true') return true
  return 'invalid'
}

/**
 * Valida e normaliza os argumentos de ask_user. Erros legíveis (pt-BR) que voltam ao modelo.
 * Campos opcionais vazios são descartados (não aparecem na UI).
 */
export function parseAskUserArgs(
  args: Record<string, unknown>
): { questions: RawAskUserQuestion[] } | { error: string } {
  const L = ASK_USER_LIMITS
  let qs: unknown = args.questions
  if (typeof qs === 'string') {
    try {
      qs = JSON.parse(qs)
    } catch {
      return { error: 'Erro: "questions" deve ser uma lista (array JSON) de perguntas.' }
    }
  }
  if (!Array.isArray(qs))
    return { error: 'Erro: argumento obrigatório "questions" ausente (lista de 1 a 5 perguntas).' }
  if (qs.length === 0) return { error: 'Erro: "questions" está vazia — envie de 1 a 5 perguntas.' }
  if (qs.length > L.maxQuestions)
    return {
      error: `Erro: máximo de ${L.maxQuestions} perguntas por questionário (recebidas ${qs.length}). Divida em mais de um questionário ou corte as menos importantes.`
    }
  const errors: string[] = []
  const out: RawAskUserQuestion[] = []
  const str = (v: unknown, where: string, max: number, required: boolean): string | undefined => {
    if (v === undefined || v === null || (typeof v === 'string' && !v.trim())) {
      if (required) errors.push(`${where}: obrigatório (texto não vazio)`)
      return undefined
    }
    if (typeof v !== 'string') {
      errors.push(`${where}: deve ser texto`)
      return undefined
    }
    if (v.length > max) errors.push(`${where}: ${v.length} caracteres — máximo ${max}`)
    return v
  }
  qs.forEach((rq, qi) => {
    const qn = `pergunta ${qi + 1}`
    if (!rq || typeof rq !== 'object' || Array.isArray(rq)) {
      errors.push(`${qn}: deve ser um objeto { title, options, … }`)
      return
    }
    const q = rq as Record<string, unknown>
    const title = str(q.title, `${qn} › title`, L.titleChars, true)
    const description = str(q.description, `${qn} › description`, L.descriptionChars, false)
    const multiple = optBool(q.multiple)
    if (multiple === 'invalid') errors.push(`${qn} › multiple: deve ser true ou false`)
    let opts: unknown = q.options
    if (typeof opts === 'string') {
      try {
        opts = JSON.parse(opts)
      } catch {
        /* cai no erro abaixo */
      }
    }
    if (!Array.isArray(opts)) {
      errors.push(`${qn} › options: obrigatório (lista de 1 a ${L.maxOptions} opções)`)
      return
    }
    if (opts.length === 0)
      errors.push(`${qn} › options: vazia — envie de 1 a ${L.maxOptions} opções`)
    if (opts.length > L.maxOptions)
      errors.push(
        `Máximo de ${L.maxOptions} opções por pergunta (pergunta ${qi + 1} tem ${opts.length}) — a opção "Outro" é adicionada automaticamente e não conta`
      )
    const options: RawAskUserOption[] = []
    opts.slice(0, L.maxOptions).forEach((ro, oi) => {
      const on = `${qn} › opção ${oi + 1}`
      if (typeof ro === 'string' && ro.trim()) {
        // tolerância: opção como texto simples
        str(ro, `${on} › title`, L.titleChars, true)
        options.push({ title: ro })
        return
      }
      if (!ro || typeof ro !== 'object' || Array.isArray(ro)) {
        errors.push(`${on}: deve ser um objeto { title, … }`)
        return
      }
      const o = ro as Record<string, unknown>
      const opt: RawAskUserOption = {
        title: str(o.title, `${on} › title`, L.titleChars, true) ?? ''
      }
      const d = str(o.description, `${on} › description`, L.descriptionChars, false)
      if (d) opt.description = d
      const icon = str(o.icon, `${on} › icon`, L.svgBytes * 2, false)?.trim()
      if (icon) {
        const k = classifyIcon(icon)
        if (k === 'text' && [...icon].length > L.iconTextChars)
          errors.push(
            `${on} › icon: "${icon.slice(0, 40)}…" não é um nome de ícone lucide (kebab-case, ex. "database"), emoji, URL, caminho de imagem nem "<svg…>"`
          )
        else if (k !== 'text' && k !== 'lucide') {
          const e = refError(icon, `${on} › icon`)
          if (e) errors.push(e)
        }
        opt.icon = icon
      }
      const image = str(o.image, `${on} › image`, L.svgBytes * 2, false)?.trim()
      if (image) {
        const e = refError(image, `${on} › image`)
        if (e) errors.push(e)
        opt.image = image
      }
      const help = str(o.help, `${on} › help`, L.svgBytes * 2, false)
      if (help && help.trim()) {
        const k = classifyHelp(help)
        if (k === 'text') {
          if (help.length > L.helpChars)
            errors.push(`${on} › help: ${help.length} caracteres — máximo ${L.helpChars}`)
          opt.help = help.replace(/^\n+|\s+$/g, '')
        } else {
          const e = refError(help.trim(), `${on} › help`)
          if (e) errors.push(e)
          opt.help = help.trim()
        }
      }
      options.push(opt)
    })
    out.push({
      title: title ?? '',
      ...(description ? { description } : {}),
      multiple: multiple === true,
      options
    })
  })
  if (errors.length) {
    const shown = errors.slice(0, 12)
    return {
      error: `Erro: questionário inválido — nada foi mostrado ao usuário. Corrija e chame ask_user de novo:\n${shown.map((e) => `- ${e}`).join('\n')}${errors.length > shown.length ? `\n- … mais ${errors.length - shown.length} erro(s)` : ''}`
    }
  }
  return { questions: out }
}

/** Valida as respostas da UI contra as perguntas. Retorna as respostas normalizadas ou erro. */
export function validateAnswers(
  questions: Pick<AskUserQuestion, 'multiple' | 'options'>[],
  input: unknown
): { answers: QuestionAnswer[] } | { error: string } {
  if (!Array.isArray(input) || input.length !== questions.length)
    return { error: `Responda todas as ${questions.length} perguntas.` }
  const answers: QuestionAnswer[] = []
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i]
    const a = input[i] as Partial<QuestionAnswer> | null
    const sel = Array.isArray(a?.selected) ? a.selected : []
    const selected = [...new Set(sel)].filter(
      (n): n is number => Number.isInteger(n) && n >= 0 && n < q.options.length
    )
    if (selected.length !== sel.length) return { error: `Pergunta ${i + 1}: opção inválida.` }
    selected.sort((x, y) => x - y)
    const other = typeof a?.other === 'string' ? a.other.trim() : ''
    if (other.length > ASK_USER_LIMITS.otherChars)
      return {
        error: `Pergunta ${i + 1}: "Outro" com mais de ${ASK_USER_LIMITS.otherChars} caracteres.`
      }
    if (!selected.length && !other) return { error: `Pergunta ${i + 1} sem resposta.` }
    if (!q.multiple && selected.length + (other ? 1 : 0) > 1)
      return { error: `Pergunta ${i + 1} aceita uma resposta só.` }
    answers.push(other ? { selected, other } : { selected })
  }
  return { answers }
}

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim()

/** Texto exato enviado ao modelo quando o usuário responde. */
export function formatAskUserResult(
  questions: Pick<AskUserQuestion, 'title' | 'options'>[],
  answers: QuestionAnswer[],
  notes: string[] = []
): string {
  const lines = ['Respostas do usuário:']
  questions.forEach((q, i) => {
    const a = answers[i] ?? { selected: [] }
    const parts = a.selected.map((n) => oneLine(q.options[n]?.title ?? `opção ${n + 1}`))
    if (a.other) parts.push(`Outro: "${a.other.replace(/\r\n?/g, '\n')}"`)
    lines.push(`${i + 1}. ${oneLine(q.title)} → ${parts.join(', ') || '(sem resposta)'}`)
  })
  if (notes.length) lines.push('', ...notes)
  return lines.join('\n')
}
