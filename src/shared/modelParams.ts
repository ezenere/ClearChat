// Quais parâmetros de amostragem (ChatParams) cada modelo aceita. Função pura usada pelo painel
// (renderer: some o que o modelo não aceita), pelo buildRequest (main: não envia + notas no
// "Ver request"), pela compactação (mesma request) e pelo juiz do Smart-Approve.
// Ver SPEC.md → "Parâmetros por modelo".
//
// Fontes:
// - OpenRouter: `supported_parameters` de cada modelo no GET /models (mapeado por
//   openRouterSupportedParams).
// - Anthropic (API nativa): o /models NÃO informa parâmetros de amostragem → tabela por
//   família/geração (anthropicModelRules), conferida em
//   https://platform.claude.com/docs/en/build-with-claude/thinking ("Sampling parameters"),
//   https://platform.claude.com/docs/en/api/messages (temperature/top_p/top_k "Deprecated: models
//   released after Claude Opus 4.6"), https://platform.claude.com/docs/en/build-with-claude/effort
//   (supportedModels) e testada na API real (400 "`X` is deprecated for this model"; 400
//   "`temperature` and `top_p` cannot both be specified for this model").
// - openai (genérico): sem informação → todos.
import type { ChatParams, ModelInfo } from './types'
import type { ProviderKind } from './providerKinds'

export type ParamKey = Exclude<keyof ChatParams, 'extraBody'>

/** Ordem fixa (painel e body). */
export const PARAM_KEYS: ParamKey[] = [
  'temperature',
  'top_p',
  'top_k',
  'max_tokens',
  'frequency_penalty',
  'presence_penalty',
  'repetition_penalty',
  'seed',
  'reasoning_effort'
]

// ---------------- OpenRouter ----------------

/** Nome em `supported_parameters` (OpenRouter) → chave de ChatParams. */
const OPENROUTER_NAMES: Record<string, ParamKey> = {
  temperature: 'temperature',
  top_p: 'top_p',
  top_k: 'top_k',
  max_tokens: 'max_tokens',
  max_completion_tokens: 'max_tokens',
  frequency_penalty: 'frequency_penalty',
  presence_penalty: 'presence_penalty',
  repetition_penalty: 'repetition_penalty',
  seed: 'seed',
  // o adaptador OpenRouter envia `reasoning: {effort}` — vale qualquer um dos dois
  reasoning: 'reasoning_effort',
  reasoning_effort: 'reasoning_effort'
}

/**
 * `supported_parameters` → chaves de ChatParams (na ordem de PARAM_KEYS). Lista ausente/vazia →
 * undefined (= desconhecido → todos).
 */
export function openRouterSupportedParams(list: unknown): ParamKey[] | undefined {
  if (!Array.isArray(list) || !list.length) return undefined
  const set = new Set<ParamKey>()
  for (const x of list)
    if (typeof x === 'string' && OPENROUTER_NAMES[x]) set.add(OPENROUTER_NAMES[x])
  return PARAM_KEYS.filter((k) => set.has(k))
}

// ---------------- Anthropic (tabela) ----------------

export interface ClaudeId {
  family: string
  major: number
  minor: number
}

/**
 * Família e versão de um id Claude: `claude-opus-4-5-20251101` → opus 4.5; `claude-sonnet-5` →
 * sonnet 5.0; `claude-3-5-haiku-latest` → haiku 3.5; `claude-mythos-preview` → mythos 0.0.
 * Aceita prefixos (ex.: `anthropic/claude-…`, `us.anthropic.claude-…`). Não-Claude → null.
 */
export function parseClaudeId(id: string): ClaudeId | null {
  const s = id.toLowerCase()
  const m = /claude-(opus|sonnet|haiku|fable|mythos)(?:-(\d+)(?:[-.](\d{1,2})(?!\d))?)?/.exec(s)
  if (m) return { family: m[1], major: Number(m[2] ?? 0), minor: Number(m[3] ?? 0) }
  const old = /claude-(\d+)(?:[-.](\d))?-(opus|sonnet|haiku)/.exec(s)
  if (old) return { family: old[3], major: Number(old[1]), minor: Number(old[2] ?? 0) }
  return null
}

export interface AnthropicRules {
  /**
   * 'none': temperature/top_p/top_k rejeitados (400 "deprecated");
   * 'exclusive': aceitos, mas temperature e top_p não podem ir juntos;
   * 'all': os três, inclusive juntos.
   */
  sampling: 'none' | 'exclusive' | 'all'
  /** Aceita `output_config.effort`. */
  effort: boolean
}

const atLeast = (c: ClaudeId, major: number, minor: number): boolean =>
  c.major > major || (c.major === major && c.minor >= minor)

/**
 * Tabela (API nativa):
 * - sampling 'none': Fable/Mythos (todas), qualquer família ≥ 5 (Opus/Sonnet/Haiku 5, 5.5),
 *   Opus ≥ 4.7 — doc "thinking → Sampling parameters" lista Fable 5.1/5, Mythos, Opus 5.5/5/4.8/4.7,
 *   Sonnet 5.5/5, Haiku 5.5; testado: haiku-5-5, sonnet-5-5, opus-5-5, fable-5-1, opus-5, sonnet-5,
 *   fable-5, opus-4-8, opus-4-7 → 400 "`temperature` is deprecated for this model".
 * - 'exclusive': demais 4.x — testado: haiku-4-5, sonnet-4-6, opus-4-6, opus-4-5 aceitam cada um
 *   sozinho e rejeitam temperature+top_p juntos; release notes: "Opus 4.1 does not allow both".
 *   Id não reconhecido também cai aqui (mandar só um nunca dá esse 400).
 * - 'all': Claude 3.x (aposentados; sem restrição documentada — não testado).
 * - effort: doc "Effort" (supportedModels): Fable/Mythos, Opus ≥ 4.5, Sonnet ≥ 4.6, Haiku ≥ 5 e
 *   tudo ≥ 5; testado: haiku-4-5 → 400 "does not support the effort parameter", sonnet-4-6/
 *   opus-4-5/sonnet-5-5 ok. Bate com `capabilities.effort.supported` do /models nativo.
 */
export function anthropicModelRules(model: string): AnthropicRules {
  const c = parseClaudeId(model)
  if (!c) return { sampling: 'exclusive', effort: false }
  const newGen = c.family === 'fable' || c.family === 'mythos' || c.major >= 5
  const sampling: AnthropicRules['sampling'] =
    newGen || (c.family === 'opus' && atLeast(c, 4, 7))
      ? 'none'
      : c.major <= 3
        ? 'all'
        : 'exclusive'
  const effort =
    newGen ||
    (c.family === 'opus' && atLeast(c, 4, 5)) ||
    (c.family === 'sonnet' && atLeast(c, 4, 6))
  return { sampling, effort }
}

/** O extraBody liga thinking (Anthropic: `thinking.type` 'enabled' ou 'adaptive')? */
export function thinkingEnabled(extra: Record<string, unknown> | null | undefined): boolean {
  const t = extra?.thinking
  if (!t || typeof t !== 'object') return false
  const type = (t as { type?: unknown }).type
  return type === 'enabled' || type === 'adaptive'
}

/** extraBody → objeto (inválido/vazio → null; nunca lança — o buildRequest valida à parte). */
export function safeExtraBody(extra: string | undefined | null): Record<string, unknown> | null {
  if (!extra || !extra.trim()) return null
  try {
    const v = JSON.parse(extra)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

// ---------------- Regras e filtro ----------------

export interface ParamRulesInput {
  kind: ProviderKind
  model: string
  /** Item do /models (OpenRouter: supportedParams). Ausente = desconhecido. */
  info?: Pick<ModelInfo, 'supportedParams'> | null
  /** extraBody já parseado (thinking). */
  extra?: Record<string, unknown> | null
}

export interface ParamRules {
  /** Parâmetros que o modelo aceita (o painel mostra só estes). */
  supported: ParamKey[]
  /** Pares que não podem ir juntos (a UI torna mutuamente exclusivos; a request manda só o 1º). */
  exclusive: [ParamKey, ParamKey][]
  /** Thinking ligado (Anthropic): top_p só ≥ 0.95. */
  thinking: boolean
  /** Motivo de cada parâmetro não suportado (para as notas). */
  why: Partial<Record<ParamKey, string>>
}

const ANTHROPIC_NEVER: ParamKey[] = [
  'frequency_penalty',
  'presence_penalty',
  'repetition_penalty',
  'seed'
]

export function paramRules(input: ParamRulesInput): ParamRules {
  const { kind, model } = input
  const label = model || 'este modelo'
  const why: ParamRules['why'] = {}
  if (kind === 'anthropic') {
    const r = anthropicModelRules(model)
    const thinking = r.sampling !== 'none' && thinkingEnabled(input.extra)
    for (const k of ANTHROPIC_NEVER) why[k] = 'não existe na API nativa da Anthropic'
    if (r.sampling === 'none') {
      for (const k of ['temperature', 'top_p', 'top_k'] as ParamKey[])
        why[k] = `não suportado por ${label} (a API rejeita valores fora do padrão)`
    } else if (thinking) {
      why.temperature = 'com thinking ligado a API só aceita temperature = 1'
      why.top_k = 'não suportado com thinking ligado'
    }
    if (!r.effort) why.reasoning_effort = `${label} não aceita effort`
    return {
      supported: PARAM_KEYS.filter((k) => !why[k]),
      exclusive: r.sampling === 'exclusive' && !thinking ? [['temperature', 'top_p']] : [],
      thinking,
      why
    }
  }
  const list = input.info?.supportedParams
  if (list) {
    const set = new Set(list)
    for (const k of PARAM_KEYS) if (!set.has(k)) why[k] = `não suportado por ${label}`
  }
  return { supported: PARAM_KEYS.filter((k) => !why[k]), exclusive: [], thinking: false, why }
}

/** Valor "ligado" (definido e não NaN). */
export function paramOn(v: unknown): boolean {
  return v !== undefined && v !== null && !(typeof v === 'number' && Number.isNaN(v))
}

export interface ParamSupport extends ParamRules {
  /** Params que vão na request (só os ligados e aceitos). extraBody não entra. */
  send: Omit<ChatParams, 'extraBody'>
  /** Parâmetros ligados no chat mas não enviados. */
  omitted: { key: ParamKey; reason: string }[]
  /** Notas legíveis (omissões e ajustes) para o "Ver request". */
  notes: string[]
}

/**
 * Filtra os params ligados do chat pelo que o modelo aceita. Os valores salvos NÃO mudam (só não
 * vão): ao voltar para um modelo que aceite, valem de novo. Pares exclusivos: vai o primeiro
 * (temperature) e o outro é omitido com nota.
 */
export function paramSupport(input: ParamRulesInput & { params: ChatParams }): ParamSupport {
  const rules = paramRules(input)
  const send: ParamSupport['send'] = {}
  const omitted: ParamSupport['omitted'] = []
  for (const k of PARAM_KEYS) {
    const v = input.params[k]
    if (!paramOn(v)) continue
    if (rules.why[k]) {
      omitted.push({ key: k, reason: rules.why[k]! })
      continue
    }
    ;(send as Record<string, unknown>)[k] = v
  }
  for (const [a, b] of rules.exclusive) {
    if (a in send && b in send) {
      delete send[b]
      omitted.push({
        key: b,
        reason: `${input.model || 'este modelo'} não aceita ${a} e ${b} juntos (enviado só ${a})`
      })
    }
  }
  if (rules.thinking && typeof send.top_p === 'number' && send.top_p < 0.95) {
    omitted.push({
      key: 'top_p',
      reason: `com thinking ligado a API só aceita top_p ≥ 0.95 (valor: ${send.top_p})`
    })
    delete send.top_p
  }
  const notes = omitted.map((o) => `${o.key} omitido: ${o.reason}.`)
  if (input.kind === 'anthropic' && send.reasoning_effort === 'minimal')
    notes.push(
      'reasoning_effort minimal enviado como output_config.effort "low" (a Anthropic não tem minimal).'
    )
  return { ...rules, send, omitted, notes }
}

/** Parâmetros omitidos por conflito (par exclusivo / limite do thinking) — a UI os mostra desligados. */
export function conflictOmitted(s: ParamSupport): Set<ParamKey> {
  return new Set(s.omitted.filter((o) => !s.why[o.key]).map((o) => o.key))
}
