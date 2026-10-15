// list_models: lista os modelos do provedor do chat (providers.listModels, com cache por provider).
// A formatação é pura (formatModelList) — testada em e2e/unit.test.ts sem rede.
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

/** Filtra, ordena e formata a lista (uma linha por modelo), respeitando `maxChars`. */
export function formatModelList(
  models: ModelInfo[],
  opts: ModelListOptions,
  info: { providerName: string; current?: string; maxChars?: number }
): string {
  const query = (opts.query ?? '').trim()
  let list = models.filter(
    (m) =>
      (!query || matchesModelQuery(m, query)) &&
      (!opts.toolsOnly || m.supportsTools === true) &&
      (!opts.freeOnly || isFreeModel(m))
  )
  const byId = (a: ModelInfo, b: ModelInfo): number => a.id.localeCompare(b.id)
  const sort = opts.sort ?? 'id'
  list = [...list].sort((a, b) => {
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

export async function listModelsTool(
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  const opts = parseOptions(args)
  const src = ctx.models
  if (!src) return fail('Erro: nenhum provedor configurado para este chat.')
  let models: ModelInfo[]
  try {
    models = await src.list()
  } catch (e) {
    if (ctx.signal.aborted) throw abortError()
    return fail(
      `Erro: não foi possível listar os modelos do provedor ${src.providerName} (GET /models): ${(e as Error).message}. O endpoint pode não suportar /models; use o id do modelo diretamente se o conhecer.`
    )
  }
  if (ctx.signal.aborted) throw abortError()
  if (models.length === 0)
    return ok(`O provedor ${src.providerName} não informou nenhum modelo em /models.`)
  return ok(
    formatModelList(models, opts, {
      providerName: src.providerName,
      current: src.current,
      maxChars: maxOutputOf(ctx)
    })
  )
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
