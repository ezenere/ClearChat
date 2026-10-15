// list_models: lista os modelos de todos os provedores configurados (providers.listModels, com cache
// por provider). Formatação e resolução de provedor do delegate_task são puras — testadas em
// e2e/unit.test.ts sem rede.
import { LIMITS } from '@shared/limits'
import type { ModelInfo } from '@shared/types'
import {
  abortError,
  fail,
  fmtNum,
  maxOutputOf,
  ok,
  ToolError,
  type ToolContext,
  type ToolResult
} from './util'

export type ModelSort = 'id' | 'price' | 'context'
export const MODEL_SORTS: ModelSort[] = ['id', 'price', 'context']

export interface ModelListOptions {
  query?: string
  toolsOnly?: boolean
  freeOnly?: boolean
  limit?: number
  sort?: ModelSort
}

/** Modelo gratuito: id do OpenRouter terminado em ":free" ou preço 0 (entrada e saída). */
export const isFreeModel = (m: ModelInfo): boolean =>
  m.id.endsWith(':free') || (m.promptPrice === 0 && m.completionPrice === 0)

const squash = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '')

/** Cada termo da busca precisa aparecer no id ou no nome (sem diferenciar caixa nem separadores). */
export function matchesModelQuery(m: ModelInfo, query: string): boolean {
  const hay = `${m.id} ${m.name ?? ''}`.toLowerCase()
  const hayS = squash(hay)
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((t) => hay.includes(t) || (squash(t) !== '' && hayS.includes(squash(t))))
}

/** "1.047k" (milhares, pt-BR) ou o número exato abaixo de 1000. */
export function fmtContext(n: number): string {
  return n >= 1000 ? `${fmtNum(Math.floor(n / 1000))}k` : String(n)
}

/** Preço por 1M tokens a partir do preço por token: 0.10, 2.50, 0.0075. */
export function fmtPricePerM(p: number): string {
  const v = p * 1_000_000
  if (v === 0) return '0'
  return v >= 0.01 ? v.toFixed(2) : String(Number(v.toPrecision(2)))
}

const totalPrice = (m: ModelInfo): number | undefined =>
  m.promptPrice === undefined && m.completionPrice === undefined
    ? undefined
    : (m.promptPrice ?? 0) + (m.completionPrice ?? 0)

export function formatModelLine(m: ModelInfo, current?: string): string {
  const parts = [m.id + (current && m.id === current ? ' (atual)' : '')]
  if (m.contextLength) parts.push(`ctx ${fmtContext(m.contextLength)}`)
  if (isFreeModel(m)) parts.push('grátis')
  else if (m.promptPrice !== undefined || m.completionPrice !== undefined) {
    const p = m.promptPrice !== undefined ? `$${fmtPricePerM(m.promptPrice)}` : '?'
    const c = m.completionPrice !== undefined ? `$${fmtPricePerM(m.completionPrice)}` : '?'
    parts.push(`${p}/${c} por 1M`)
  }
  if (m.supportsTools) parts.push('tools')
  return parts.join(' · ')
}

/** Normaliza `limit` (padrão 50, 1..200). */
export function clampModelLimit(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  if (!Number.isFinite(n) || n <= 0) return LIMITS.modelsDefaultResults
  return Math.min(LIMITS.modelsMaxResults, Math.max(1, Math.floor(n)))
}

/** Aplica query/tools_only/free_only e a ordenação pedida (sem limite). */
export function filterSortModels(models: ModelInfo[], opts: ModelListOptions): ModelInfo[] {
  const query = (opts.query ?? '').trim()
  const list = models.filter(
    (m) =>
      (!query || matchesModelQuery(m, query)) &&
      (!opts.toolsOnly || m.supportsTools === true) &&
      (!opts.freeOnly || isFreeModel(m))
  )
  const byId = (a: ModelInfo, b: ModelInfo): number => a.id.localeCompare(b.id)
  const sort = opts.sort ?? 'id'
  return [...list].sort((a, b) => {
    if (sort === 'price') {
      const pa = totalPrice(a)
      const pb = totalPrice(b)
      if (pa !== pb) return pa === undefined ? 1 : pb === undefined ? -1 : pa - pb
    } else if (sort === 'context') {
      const ca = a.contextLength
      const cb = b.contextLength
      if (ca !== cb) return ca === undefined ? 1 : cb === undefined ? -1 : cb - ca
    }
    return byId(a, b)
  })
}

/** Filtra, ordena e formata a lista (uma linha por modelo), respeitando `maxChars`. */
export function formatModelList(
  models: ModelInfo[],
  opts: ModelListOptions,
  info: { providerName: string; current?: string; maxChars?: number }
): string {
  const query = (opts.query ?? '').trim()
  const list = filterSortModels(models, opts)
  const filters = [
    query && `query "${query}"`,
    opts.toolsOnly && 'tools_only',
    opts.freeOnly && 'free_only'
  ].filter(Boolean)
  if (list.length === 0) {
    return `Nenhum modelo de ${fmtNum(models.length)} no provedor ${info.providerName} casa com ${filters.join(', ') || 'os filtros'}. Tente uma query mais curta (ex.: só o fornecedor, como "openai" ou "claude") ou sem filtros.`
  }

  const limit = clampModelLimit(opts.limit)
  const max = info.maxChars && info.maxChars > 0 ? info.maxChars : LIMITS.maxToolOutputChars
  const budget = max - 400 // cabeçalho + dica
  const lines: string[] = []
  let used = 0
  for (const m of list.slice(0, limit)) {
    const line = formatModelLine(m, info.current)
    if (used + line.length + 1 > budget) break
    lines.push(line)
    used += line.length + 1
  }
  const header = `[${fmtNum(list.length)} modelos de ${fmtNum(models.length)} no provedor ${info.providerName}; mostrando ${fmtNum(lines.length)}]`
  const out = [header, ...lines]
  if (lines.length < list.length) {
    out.push(
      `[… mais ${fmtNum(list.length - lines.length)} modelos não listados. Refine com query (ex.: "claude", "gpt-4.1"), tools_only/free_only, ou aumente limit (máx. ${LIMITS.modelsMaxResults}).]`
    )
  }
  return out.join('\n')
}

/** Um provedor configurado como fonte de modelos (list_models / delegate_task). */
export interface ModelSource {
  id: string
  name: string
  /** Provedor da sessão chamadora (marca "(atual)" e vem primeiro). */
  isSession?: boolean
  list: () => Promise<ModelInfo[]>
}

/** Resultado de um provedor: modelos ou o erro do /models. */
export interface ProviderModels {
  id: string
  name: string
  isSession?: boolean
  models?: ModelInfo[]
  error?: string
}

export interface ProviderRef {
  id: string
  name: string
}

/** Provedor por id exato ou nome (sem diferenciar caixa nem espaços nas pontas). */
export function matchProvider<T extends ProviderRef>(
  providers: T[],
  ref: string
): T | 'ambiguous' | null {
  const r = ref.trim()
  if (!r) return null
  const byId = providers.find((p) => p.id === r)
  if (byId) return byId
  const lc = r.toLowerCase()
  const byName = providers.filter((p) => p.name.trim().toLowerCase() === lc)
  return byName.length === 1 ? byName[0] : byName.length > 1 ? 'ambiguous' : null
}

const providerNames = (ps: ProviderRef[]): string =>
  ps.length ? ps.map((p) => `"${p.name}"`).join(', ') : '(nenhum provedor configurado)'

const oneLine = (e: string, max = 200): string => {
  const t = e.replace(/\s+/g, ' ').trim()
  return t.length > max ? t.slice(0, max) + '…' : t
}

/**
 * Lista de vários provedores: cabeçalho com contagem por provedor, uma seção `[Provedor]` por
 * provedor (o da sessão primeiro) e erros inline. `limit` vale por provedor; o teto de caracteres é
 * dividido entre os provedores com resultados (sobra de um passa ao próximo).
 */
export function formatMultiProviderModels(
  groups: ProviderModels[],
  opts: ModelListOptions,
  info: { current?: string; maxChars?: number }
): string {
  const ordered = [...groups.filter((g) => g.isSession), ...groups.filter((g) => !g.isSession)]
  const limit = clampModelLimit(opts.limit)
  const max = info.maxChars && info.maxChars > 0 ? info.maxChars : LIMITS.maxToolOutputChars
  const rows = ordered.map((g) => ({ g, list: g.models ? filterSortModels(g.models, opts) : [] }))
  const tag = (g: ProviderModels): string => (g.isSession ? `${g.name} (desta sessão)` : g.name)
  // orçamento: tira cabeçalho, títulos e erros; divide o resto entre os que têm resultados
  const fixed = 600 + ordered.reduce((n, g) => n + g.name.length * 2 + 80, 0)
  let budget = Math.max(400, max - fixed)
  let pending = rows.filter((r) => r.list.length).length
  const sections: string[] = []
  const counts: string[] = []
  let hidden = 0
  for (const { g, list } of rows) {
    if (g.error !== undefined) {
      counts.push(`${tag(g)}: falhou`)
      sections.push(`[${g.name}] erro ao listar (GET /models): ${oneLine(g.error)}`)
      continue
    }
    const total = g.models?.length ?? 0
    if (!list.length) {
      counts.push(`${tag(g)}: 0 de ${fmtNum(total)}`)
      sections.push(`[${g.name}] nenhum modelo casa com os filtros (de ${fmtNum(total)})`)
      continue
    }
    const share = Math.floor(budget / Math.max(1, pending))
    pending--
    const lines: string[] = []
    let used = 0
    for (const m of list.slice(0, limit)) {
      const line = formatModelLine(m, g.isSession ? info.current : undefined)
      if (used + line.length + 1 > share) break
      lines.push(line)
      used += line.length + 1
    }
    budget -= used
    counts.push(
      `${tag(g)}: ${fmtNum(list.length)} de ${fmtNum(total)}, mostrando ${fmtNum(lines.length)}`
    )
    const more = list.length - lines.length
    hidden += more
    sections.push(
      [
        `[${g.name}]${g.isSession ? ' (provedor desta sessão)' : ''}`,
        ...lines,
        ...(more > 0 ? [`[… mais ${fmtNum(more)} em ${g.name}]`] : [])
      ].join('\n')
    )
  }
  const out = [
    `[modelos de ${fmtNum(ordered.length)} provedores — ${counts.join(' · ')}]`,
    ...sections
  ]
  if (hidden > 0)
    out.push(
      `[Refine com query (ex.: "claude", "gpt-4.1"), provider, tools_only/free_only, ou aumente limit (por provedor, máx. ${LIMITS.modelsMaxResults}).]`
    )
  out.push(
    '[Para usar um modelo de outro provedor num subagente: delegate_task com "provider" e "model".]'
  )
  return out.join('\n')
}

function parseOptions(args: Record<string, unknown>): ModelListOptions {
  const { query, tools_only, free_only, limit, sort } = args
  if (query !== undefined && query !== null && typeof query !== 'string')
    throw new ToolError('O argumento "query" deve ser uma string.')
  if (sort !== undefined && sort !== null && !MODEL_SORTS.includes(sort as ModelSort))
    throw new ToolError(`"sort" inválido: use ${MODEL_SORTS.map((s) => `"${s}"`).join(', ')}.`)
  return {
    query: (query as string | undefined) ?? undefined,
    toolsOnly: tools_only === true || tools_only === 'true',
    freeOnly: free_only === true || free_only === 'true',
    limit: clampModelLimit(limit),
    sort: (sort as ModelSort | undefined) ?? 'id'
  }
}

const listFailText = (name: string, e: unknown): string =>
  `Erro: não foi possível listar os modelos do provedor ${name} (GET /models): ${(e as Error).message}. O endpoint pode não suportar /models; use o id do modelo diretamente se o conhecer.`

export async function listModelsTool(
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  const opts = parseOptions(args)
  const src = ctx.models
  const all: ModelSource[] = src?.providers?.length
    ? src.providers
    : src
      ? [{ id: '', name: src.providerName, isSession: true, list: src.list }]
      : []
  if (!all.length) return fail('Erro: nenhum provedor configurado.')
  let sources = all
  const pref = args.provider
  if (pref !== undefined && pref !== null && pref !== '') {
    if (typeof pref !== 'string') throw new ToolError('O argumento "provider" deve ser uma string.')
    const m = matchProvider(all, pref)
    if (m === 'ambiguous')
      return fail(
        `Erro: há mais de um provedor chamado "${pref}"; use o id (${all.map((p) => `${p.name}: ${p.id}`).join(', ')}).`
      )
    if (!m)
      return fail(
        `Erro: provedor "${pref}" não encontrado. Provedores disponíveis: ${providerNames(all)}.`
      )
    sources = [m]
  }
  const results = await Promise.allSettled(sources.map((p) => p.list()))
  if (ctx.signal.aborted) throw abortError()
  // um só provedor: formato simples (como antes)
  if (sources.length === 1) {
    const one = sources[0]
    const r = results[0]
    if (r.status === 'rejected') return fail(listFailText(one.name, r.reason))
    if (r.value.length === 0)
      return ok(`O provedor ${one.name} não informou nenhum modelo em /models.`)
    return ok(
      formatModelList(r.value, opts, {
        providerName: one.name,
        current: one.isSession ? src?.current : undefined,
        maxChars: maxOutputOf(ctx)
      })
    )
  }
  if (results.every((r) => r.status === 'rejected')) {
    return fail(
      `Erro: não foi possível listar os modelos de nenhum provedor (GET /models): ${sources
        .map(
          (p, i) =>
            `${p.name}: ${oneLine(((results[i] as PromiseRejectedResult).reason as Error)?.message ?? '?', 160)}`
        )
        .join(' · ')}`
    )
  }
  const groups: ProviderModels[] = sources.map((p, i) => {
    const r = results[i]
    return r.status === 'fulfilled'
      ? { id: p.id, name: p.name, isSession: p.isSession, models: r.value }
      : {
          id: p.id,
          name: p.name,
          isSession: p.isSession,
          error: (r.reason as Error)?.message ?? String(r.reason)
        }
  })
  return ok(
    formatMultiProviderModels(groups, opts, { current: src?.current, maxChars: maxOutputOf(ctx) })
  )
}

/** Provedor + modelo do subagente (delegate_task), ou um erro legível para o modelo chamador. */
export type SubagentTarget =
  { providerId: string; model: string; note?: string } | { error: string }

/**
 * Regras (testadas em e2e/unit.test.ts):
 * - `provider` (nome sem caixa ou id): esse provedor; desconhecido → erro com os nomes disponíveis.
 *   Sem `model`: o modelo da sessão (se existir lá). `model` que o /models dele não lista → erro
 *   (no próprio provedor da sessão: o modelo da sessão, com nota).
 * - sem `provider`: o da sessão chamadora. `model` que não existe nele mas existe em exatamente um
 *   outro provedor → esse outro (com nota); em vários → erro pedindo `provider`; em nenhum → o modelo
 *   da sessão (com nota). /models com falha → confia no pedido.
 */
export async function resolveSubagentTarget(p: {
  providers: ProviderRef[]
  callerProviderId: string
  callerModel: string
  provider?: unknown
  model?: unknown
  listModels: (providerId: string) => Promise<ModelInfo[]>
}): Promise<SubagentTarget> {
  const reqProv = typeof p.provider === 'string' ? p.provider.trim() : ''
  const reqModel = typeof p.model === 'string' ? p.model.trim() : ''
  /** true/false = o /models lista (ou não) o modelo; null = sem lista (falhou). */
  const has = async (pid: string, model: string): Promise<boolean | null> => {
    try {
      return (await p.listModels(pid)).some((m) => m.id === model)
    } catch {
      return null
    }
  }
  if (reqProv) {
    const m = matchProvider(p.providers, reqProv)
    if (m === 'ambiguous')
      return {
        error: `Erro: há mais de um provedor chamado "${reqProv}"; use o id (${p.providers.map((x) => `${x.name}: ${x.id}`).join(', ')}).`
      }
    if (!m)
      return {
        error: `Erro: provedor "${reqProv}" não encontrado. Provedores disponíveis: ${providerNames(p.providers)}.`
      }
    const model = reqModel || p.callerModel
    if (m.id === p.callerProviderId && (!reqModel || reqModel === p.callerModel))
      return { providerId: m.id, model }
    if ((await has(m.id, model)) === false) {
      // o próprio provedor da sessão: como sem `provider` (modelo inexistente → o da sessão)
      if (m.id === p.callerProviderId)
        return {
          providerId: m.id,
          model: p.callerModel,
          note: `o modelo ${model} não existe no provedor ${m.name}; usando ${p.callerModel}.`
        }
      return {
        error: reqModel
          ? `Erro: o modelo "${model}" não existe no provedor ${m.name}. Veja list_models com provider "${m.name}".`
          : `Erro: o modelo desta sessão (${model}) não existe no provedor ${m.name}; informe "model" (veja list_models com provider "${m.name}").`
      }
    }
    return { providerId: m.id, model }
  }
  const callerName = p.providers.find((x) => x.id === p.callerProviderId)?.name ?? 'desta sessão'
  if (!reqModel || reqModel === p.callerModel)
    return { providerId: p.callerProviderId, model: p.callerModel }
  if ((await has(p.callerProviderId, reqModel)) !== false)
    return { providerId: p.callerProviderId, model: reqModel }
  const others = p.providers.filter((x) => x.id !== p.callerProviderId)
  const hits = await Promise.all(others.map((o) => has(o.id, reqModel)))
  const found = others.filter((_, i) => hits[i] === true)
  if (found.length === 1)
    return {
      providerId: found[0].id,
      model: reqModel,
      note: `o modelo ${reqModel} não existe no provedor ${callerName}; usando o provedor ${found[0].name}, onde ele existe.`
    }
  if (found.length > 1)
    return {
      error: `Erro: o modelo "${reqModel}" não existe no provedor ${callerName}, mas existe em vários provedores (${providerNames(found)}); informe "provider".`
    }
  return {
    providerId: p.callerProviderId,
    model: p.callerModel,
    note: `o modelo ${reqModel} não foi encontrado em nenhum provedor; usando ${p.callerModel} (${callerName}).`
  }
}

/** Primeira linha (curta) de um erro. */
const shortError = (e: string): string => {
  const s = e.replace(/\s+/g, ' ').trim()
  return s.length > 400 ? s.slice(0, 400) + '…' : s
}

/**
 * Resultado de delegate_task quando a chamada ao modelo do subagente falha: erro acionável para o
 * agente pai tentar de novo com outro modelo.
 */
export function delegateFailureText(model: string, error: string): string {
  const free = model.endsWith(':free')
  return (
    `[falha do modelo ${model}: ${shortError(error) || 'erro desconhecido'}] O subagente não concluiu a tarefa. ` +
    (free
      ? 'Modelos grátis falham com frequência: tente outro modelo grátis ou um pago (delegate_task com "model"; veja list_models).'
      : 'Tente outro modelo (delegate_task com "model"; veja list_models) ou repita a tarefa.')
  )
}

/** Resultado de delegate_task quando o subagente termina sem texto (comum em modelos instáveis). */
export function delegateEmptyText(model: string): string {
  return `(o subagente terminou sem retornar texto — possível falha do modelo ${model}; tente outro modelo)`
}
