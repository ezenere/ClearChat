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
// - openai (genérico): sem informação → todos (só reasoning_effort usa a tabela openAIEffortRule).
//
// reasoning_effort (níveis válidos por modelo → effortSpec; ver SPEC.md → "Parâmetros por modelo"):
// - OpenRouter: objeto `reasoning` do GET /models (`supported_efforts`, `default_effort`,
//   `mandatory`) — https://openrouter.ai/docs/guides/best-practices/reasoning-tokens ("Discovering
//   per-model reasoning options": `null` = todos os níveis do gateway; ausente = não informado).
// - Anthropic nativa: `capabilities.effort.{low,medium,high,xhigh,max}.supported` do GET /v1/models
//   (https://platform.claude.com/docs/en/api/models/list); sem capabilities → tabela
//   anthropicModelRules (doc /build-with-claude/effort, tabela "Effort levels").
// - openai genérico: o /models da OpenAI não informa nada → tabela openAIEffortRule (conferida
//   contra `supported_efforts` do OpenRouter para os mesmos modelos e o guia
//   https://developers.openai.com/api/docs/guides/reasoning: "Supported values are
//   model-dependent and can include none, minimal, low, medium, high, xhigh, and max").
// - Sem informação nenhuma → conjunto comum (low/medium/high), marcado "não informado pela API".
import type { ChatParams, ModelInfo, ModelReasoningInfo, ReasoningEffort } from './types'
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
  /** Níveis de effort aceitos (vazio se !effort). */
  efforts: ReasoningEffort[]
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
 * - níveis (doc "Effort" → tabela "Effort levels"): low/medium/high em todos; `max` em todos menos
 *   Opus 4.5; `xhigh` só em Fable/Mythos ≥ 5, qualquer ≥ 5 e Opus ≥ 4.7 (não em Opus 4.5/4.6,
 *   Sonnet 4.6 nem Mythos Preview). Não existe `minimal` nem `none`. Usada só quando o /models nativo
 *   não traz `capabilities.effort` (aí vale a API).
 */
export function anthropicModelRules(model: string): AnthropicRules {
  const c = parseClaudeId(model)
  if (!c) return { sampling: 'exclusive', effort: false, efforts: [] }
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
  const efforts: ReasoningEffort[] = []
  if (effort) {
    efforts.push('low', 'medium', 'high')
    if (c.major >= 5 || (c.family === 'opus' && atLeast(c, 4, 7))) efforts.push('xhigh')
    if (!(c.family === 'opus' && c.major === 4 && c.minor < 6)) efforts.push('max')
  }
  return { sampling, effort, efforts }
}

// ---------------- reasoning_effort: níveis por modelo ----------------

/** Todos os níveis conhecidos, em ordem crescente (o gateway do OpenRouter aceita todos). */
export const EFFORT_ORDER: ReasoningEffort[] = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max'
]

/** Conjunto comum (aceito por todas as famílias conhecidas) quando a API não informa níveis. */
export const COMMON_EFFORTS: ReasoningEffort[] = ['low', 'medium', 'high']

export const isEffort = (v: unknown): v is ReasoningEffort =>
  typeof v === 'string' && (EFFORT_ORDER as string[]).includes(v)

/** Filtra para níveis conhecidos, sem repetição, em ordem crescente. */
export function sortEfforts(list: unknown[]): ReasoningEffort[] {
  return EFFORT_ORDER.filter((e) => list.includes(e))
}

/**
 * Objeto `reasoning` de um item do GET /models do OpenRouter → ModelReasoningInfo.
 * `supported_efforts` (doc OpenRouter): array = filtrar para estes; `null` = todos os níveis do
 * gateway; ausente = o modelo não expõe níveis. Níveis desconhecidos (futuros) são ignorados.
 */
export function openRouterReasoning(r: unknown): ModelReasoningInfo | undefined {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return undefined
  const o = r as Record<string, unknown>
  const info: ModelReasoningInfo = {}
  if (o.supported_efforts === null) info.efforts = null
  else if (Array.isArray(o.supported_efforts)) info.efforts = sortEfforts(o.supported_efforts)
  if (isEffort(o.default_effort)) info.defaultEffort = o.default_effort
  if (typeof o.mandatory === 'boolean') info.mandatory = o.mandatory
  return info
}

/**
 * `capabilities` do GET /v1/models nativo da Anthropic → ModelReasoningInfo (`effort.supported` e
 * `effort.{low,medium,high,xhigh,max}.supported`). Sem `capabilities.effort` → undefined (tabela).
 */
export function anthropicCapsReasoning(caps: unknown): ModelReasoningInfo | undefined {
  const e = caps && typeof caps === 'object' ? (caps as Record<string, unknown>).effort : undefined
  if (!e || typeof e !== 'object') return undefined
  const o = e as Record<string, { supported?: unknown } | null | undefined>
  const effortSupported = (e as { supported?: unknown }).supported === true
  const efforts = effortSupported
    ? (['low', 'medium', 'high', 'xhigh', 'max'] as ReasoningEffort[]).filter(
        (l) => o[l]?.supported === true
      )
    : []
  return { effortSupported, efforts }
}

export interface OpenAIEffortRule {
  /** Família (para a origem no (i)). */
  family: string
  /** false = o modelo não tem raciocínio (reasoning_effort fica oculto). */
  reasoning: boolean
  efforts?: ReasoningEffort[]
}

const DATED = '(?:-\\d{4}-\\d{2}-\\d{2})?$'
const LMH: ReasoningEffort[] = ['low', 'medium', 'high']

/**
 * Tabela para o provider openai genérico (o GET /models da OpenAI só traz id/owned_by). Só ids
 * conferidos: níveis = `supported_efforts` do OpenRouter para o mesmo modelo (GET /models,
 * 2026-10-16) + o guia de reasoning da OpenAI. Prefixo `autor/` é ignorado. Fora da tabela → null
 * (desconhecido → conjunto comum, marcado "não informado pela API").
 * - gpt-4*, gpt-3.5*, chatgpt-4o*: sem raciocínio (OpenRouter openai/gpt-4o-mini: sem `reasoning`).
 * - o1/o3/o4-mini/o3-pro…: low/medium/high (o1-mini fica fora: não aceita reasoning_effort).
 * - gpt-oss-*: low/medium/high. gpt-5-pro: high.
 * - gpt-5, gpt-5-mini, gpt-5-nano: minimal/low/medium/high.
 * - gpt-5.1: none/low/medium/high.
 * - gpt-5.2 … gpt-5.5 (e -mini/-nano): none/low/medium/high/xhigh; gpt-5.2…5.5-pro: medium/high/xhigh.
 */
export function openAIEffortRule(model: string): OpenAIEffortRule | null {
  const id = model.toLowerCase().split('/').pop() ?? ''
  if (/^(gpt-4|gpt-3\.5|chatgpt-4o)/.test(id))
    return { family: 'GPT-4/3.5 (sem raciocínio)', reasoning: false }
  if (/^o1-mini/.test(id)) return null
  if (new RegExp(`^o[134](-mini|-pro)?${DATED}`).test(id))
    return { family: 'série o', reasoning: true, efforts: LMH }
  if (/^gpt-oss-/.test(id)) return { family: 'gpt-oss', reasoning: true, efforts: LMH }
  if (new RegExp(`^gpt-5-pro${DATED}`).test(id))
    return { family: 'gpt-5-pro', reasoning: true, efforts: ['high'] }
  if (new RegExp(`^gpt-5(-mini|-nano)?${DATED}`).test(id))
    return { family: 'gpt-5', reasoning: true, efforts: ['minimal', 'low', 'medium', 'high'] }
  if (new RegExp(`^gpt-5\\.1${DATED}`).test(id))
    return { family: 'gpt-5.1', reasoning: true, efforts: ['none', 'low', 'medium', 'high'] }
  const m = new RegExp(`^gpt-5\\.([2-5])(-mini|-nano|-pro)?${DATED}`).exec(id)
  if (m)
    return m[2] === '-pro'
      ? { family: `gpt-5.${m[1]}-pro`, reasoning: true, efforts: ['medium', 'high', 'xhigh'] }
      : {
          family: `gpt-5.${m[1]}`,
          reasoning: true,
          efforts: ['none', 'low', 'medium', 'high', 'xhigh']
        }
  return null
}

/** Formato exato no body, por tipo de provider. */
export function effortWire(kind: ProviderKind): string {
  return kind === 'openrouter'
    ? 'reasoning: { effort: "<nível>" }'
    : kind === 'anthropic'
      ? 'output_config: { effort: "<nível>" }'
      : '"reasoning_effort": "<nível>"'
}

export type EffortSource = 'api' | 'table' | 'unknown'

export interface EffortSpec {
  /** Níveis oferecidos no painel (ordem crescente). */
  levels: ReasoningEffort[]
  /** De onde vieram: API do provedor, tabela interna conferida, ou nada (conjunto comum). */
  source: EffortSource
  /** Níveis confiáveis (api/table): um valor fora deles é ajustado/omitido na request. */
  known: boolean
  /** Nível sugerido ao ligar o toggle. */
  default: ReasoningEffort
  /** Raciocínio obrigatório (OpenRouter `mandatory`). */
  mandatory?: boolean
  /** Formato no body (effortWire). */
  wire: string
  /** Origem dos níveis, legível (pt-BR) — vai no (i). */
  origin: string
}

/**
 * Níveis de reasoning_effort válidos para o modelo (se o modelo aceita o param é paramRules quem
 * decide). API primeiro; tabela só onde a API não informa; senão o conjunto comum.
 */
export function effortSpec(input: ParamRulesInput): EffortSpec {
  const { kind, model } = input
  const r = input.info?.reasoning
  let levels: ReasoningEffort[] = COMMON_EFFORTS
  let source: EffortSource = 'unknown'
  let origin = `a API não lista níveis para ${model || 'este modelo'}; mostrando o conjunto comum, aceito por todas as famílias conhecidas.`
  if (r && r.efforts === null) {
    levels = r.mandatory ? EFFORT_ORDER.filter((e) => e !== 'none') : EFFORT_ORDER
    source = 'api'
    origin = 'API do OpenRouter (GET /models): supported_efforts null = todos os níveis do gateway.'
  } else if (r && Array.isArray(r.efforts) && r.efforts.length) {
    levels = r.efforts
    source = 'api'
    origin =
      kind === 'anthropic'
        ? 'API da Anthropic (GET /v1/models → capabilities.effort).'
        : kind === 'openrouter'
          ? 'API do OpenRouter (GET /models → reasoning.supported_efforts).'
          : 'API do provedor (GET /models → reasoning.supported_efforts).'
  } else if (kind === 'anthropic') {
    const t = anthropicModelRules(model)
    if (t.efforts.length) {
      levels = t.efforts
      source = 'table'
      origin =
        'Tabela interna (o /models não trouxe capabilities.effort), conferida na doc da Anthropic (build-with-claude/effort → "Effort levels").'
    }
  } else if (kind === 'openai') {
    const t = openAIEffortRule(model)
    if (t?.efforts) {
      levels = t.efforts
      source = 'table'
      origin = `Tabela interna (o /models da OpenAI não informa níveis): família ${t.family}, conferida contra o OpenRouter e o guia de reasoning da OpenAI.`
    }
  }
  const scale = levels.filter((e) => e !== 'none')
  const def: ReasoningEffort =
    r?.defaultEffort && r.defaultEffort !== 'none' && levels.includes(r.defaultEffort)
      ? r.defaultEffort
      : levels.includes('medium')
        ? 'medium'
        : (scale[Math.floor(scale.length / 2)] ?? levels[0])
  return {
    levels,
    source,
    known: source !== 'unknown',
    default: def,
    ...(r?.mandatory ? { mandatory: true } : {}),
    wire: effortWire(kind),
    origin
  }
}

/**
 * Valor salvo → o que vai na request. Níveis desconhecidos (source 'unknown'): vai como está.
 * Fora dos níveis conhecidos: o mais alto aceito ≤ pedido (sem contar `none`), senão o mais baixo
 * acima; `none` não aceito → undefined (omitido: o modelo usa o padrão).
 */
export function clampEffort(
  value: ReasoningEffort,
  spec: Pick<EffortSpec, 'levels' | 'known'>
): ReasoningEffort | undefined {
  if (!spec.known || spec.levels.includes(value)) return value
  if (value === 'none') return undefined
  const rank = EFFORT_ORDER.indexOf(value)
  const scale = spec.levels.filter((e) => e !== 'none')
  const lower = scale.filter((e) => EFFORT_ORDER.indexOf(e) <= rank).pop()
  return lower ?? scale.find((e) => EFFORT_ORDER.indexOf(e) > rank)
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
  info?: Pick<ModelInfo, 'supportedParams' | 'reasoning'> | null
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
  /** Níveis de reasoning_effort (null se o modelo não aceita o param). */
  effort: EffortSpec | null
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
    // effort: capabilities.effort do /models nativo quando veio; senão a tabela
    const apiEffort = input.info?.reasoning?.effortSupported
    if (apiEffort === false)
      why.reasoning_effort = `${label} não aceita effort (API: capabilities.effort.supported = false)`
    else if (apiEffort === undefined && !r.effort)
      why.reasoning_effort = `${label} não aceita effort`
    return {
      supported: PARAM_KEYS.filter((k) => !why[k]),
      exclusive: r.sampling === 'exclusive' && !thinking ? [['temperature', 'top_p']] : [],
      thinking,
      why,
      effort: why.reasoning_effort ? null : effortSpec(input)
    }
  }
  const list = input.info?.supportedParams
  if (list) {
    const set = new Set(list)
    for (const k of PARAM_KEYS) if (!set.has(k)) why[k] = `não suportado por ${label}`
  } else if (
    kind === 'openai' &&
    !input.info?.reasoning &&
    openAIEffortRule(model)?.reasoning === false
  ) {
    // sem lista da API: só a tabela de modelos OpenAI sem raciocínio
    why.reasoning_effort = `${label} não tem raciocínio (tabela interna: ${openAIEffortRule(model)!.family})`
  }
  return {
    supported: PARAM_KEYS.filter((k) => !why[k]),
    exclusive: [],
    thinking: false,
    why,
    effort: why.reasoning_effort ? null : effortSpec(input)
  }
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
  /**
   * reasoning_effort salvo fora dos níveis do modelo: `to` = o que vai (ajustado) ou undefined
   * (omitido). A UI mostra um aviso.
   */
  effortAdjust?: { from: ReasoningEffort; to?: ReasoningEffort; reason: string }
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
  // reasoning_effort fora dos níveis válidos para o modelo → ajusta para o mais próximo ou omite
  let effortAdjust: ParamSupport['effortAdjust']
  const want = send.reasoning_effort
  if (want && rules.effort) {
    const to = clampEffort(want, rules.effort)
    if (to !== want) {
      const label = input.model || 'este modelo'
      const levels = rules.effort.levels.join(', ')
      if (to) {
        send.reasoning_effort = to
        effortAdjust = {
          from: want,
          to,
          reason: `${label} não aceita "${want}" (níveis: ${levels}); enviado "${to}"`
        }
      } else {
        delete send.reasoning_effort
        effortAdjust = { from: want, reason: `${label} não aceita "${want}" (níveis: ${levels})` }
        omitted.push({ key: 'reasoning_effort', reason: effortAdjust.reason })
      }
    }
  }
  const notes = omitted.map((o) => `${o.key} omitido: ${o.reason}.`)
  if (effortAdjust?.to) notes.push(`reasoning_effort ajustado: ${effortAdjust.reason}.`)
  return { ...rules, send, omitted, notes, ...(effortAdjust ? { effortAdjust } : {}) }
}

/** Parâmetros omitidos por conflito (par exclusivo / limite do thinking) — a UI os mostra desligados. */
export function conflictOmitted(s: ParamSupport): Set<ParamKey> {
  return new Set(
    s.omitted.filter((o) => !s.why[o.key] && o.key !== 'reasoning_effort').map((o) => o.key)
  )
}
