// Lógica pura do ModelPicker: todos os provedores numa lista só, um grupo por provedor (cabeçalho
// + modelos), busca em todos os grupos, opções de ID livre por provedor e virtualização (alturas
// fixas por tipo de linha). Sem React — testado em e2e/models.test.ts.
import type { ModelInfo } from '@shared/types'
import type { ModelRef } from '@shared/models'

export interface PickerProvider {
  id: string
  name: string
  /** Grupo fechado (ex.: "Local (CPU)" em Áudio): sem a linha "Usar “id” em …" do ID livre. */
  noFreeId?: boolean
}

export interface PickerModels {
  status: 'loading' | 'ok' | 'error'
  list: ModelInfo[]
  error?: string
}

export type GroupStatus = 'idle' | 'loading' | 'ok' | 'error'

export type PickerRow =
  | {
      kind: 'header'
      key: string
      providerId: string
      name: string
      /** Modelos do provedor. */
      total: number
      /** Modelos que casam com a busca (= total sem busca). */
      shown: number
      collapsed: boolean
      status: GroupStatus
      error?: string
    }
  | {
      kind: 'model'
      key: string
      providerId: string
      providerName: string
      model: ModelInfo
      selected: boolean
      /** Incompatível com o chat (ver @shared/modelCompat): não selecionável. */
      disabled?: ModelDisabled
    }
  | {
      kind: 'status'
      key: string
      providerId: string
      status: 'loading' | 'error' | 'empty'
      error?: string
    }
  | { kind: 'free-header'; key: string }
  | { kind: 'free'; key: string; providerId: string; providerName: string; text: string }

export type SelectableRow = Extract<PickerRow, { kind: 'model' | 'free' }>

/** Por que um modelo não pode ser escolhido aqui (tooltip completo + rótulo curto da linha). */
export interface ModelDisabled {
  reason: string
  label: string
}

/** Altura (px) de cada tipo de linha — a virtualização depende delas serem fixas. */
export const ROW_HEIGHT: Record<PickerRow['kind'], number> = {
  header: 32,
  model: 44,
  status: 36,
  'free-header': 30,
  free: 34
}

/** Minúsculas sem separadores ("GPT-4.1" → "gpt41"). */
export function compact(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

export function queryTokens(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean)
}

/**
 * Cada termo precisa aparecer no id, no nome ou no nome do provedor (com ou sem separadores:
 * "gpt41" acha "gpt-4.1"; "openrouter claude" filtra o grupo do OpenRouter).
 */
export function modelMatches(m: ModelInfo, providerName: string, tokens: string[]): boolean {
  if (!tokens.length) return true
  const hay = `${m.id} ${m.name ?? ''} ${providerName}`.toLowerCase()
  const hayCompact = compact(hay)
  return tokens.every((t) => {
    if (hay.includes(t)) return true
    const c = compact(t)
    return c.length > 0 && hayCompact.includes(c)
  })
}

export function isSelectable(r: PickerRow | undefined): r is SelectableRow {
  return !!r && ((r.kind === 'model' && !r.disabled) || r.kind === 'free')
}

/**
 * Linhas da lista. Sem busca: todo provedor tem cabeçalho; recolhido = só o cabeçalho; carregando
 * / erro / vazio viram uma linha de status no grupo. Com busca: os grupos ignoram o recolhimento,
 * mostram só o que casa e somem se nada casar (exceto carregando/erro, que continuam visíveis).
 * ID livre: com texto digitado, "Usar <texto>" para cada provedor que não tem esse id exato
 * (o provedor da seleção atual primeiro), no fim — ID livre não tem metadados (capacidades
 * desconhecidas), então nunca é desabilitado. `disabledReason` (opcional) marca modelos
 * incompatíveis com o chat.
 */
export function buildPickerRows(opts: {
  providers: PickerProvider[]
  models: Record<string, PickerModels | undefined>
  query: string
  collapsed: ReadonlySet<string>
  selected: ModelRef | null
  disabledReason?: (providerId: string, model: ModelInfo) => ModelDisabled | null
}): PickerRow[] {
  const { providers, models, query, collapsed, selected, disabledReason } = opts
  const tokens = queryTokens(query)
  const searching = tokens.length > 0
  const rows: PickerRow[] = []
  for (const p of providers) {
    const entry = models[p.id]
    const status: GroupStatus = entry?.status ?? 'idle'
    const list = entry?.list ?? []
    const matched = searching ? list.filter((m) => modelMatches(m, p.name, tokens)) : list
    const pending = status === 'idle' || status === 'loading'
    if (searching && matched.length === 0 && !pending && status !== 'error') continue
    const isCollapsed = !searching && collapsed.has(p.id)
    rows.push({
      kind: 'header',
      key: `h:${p.id}`,
      providerId: p.id,
      name: p.name,
      total: list.length,
      shown: matched.length,
      collapsed: isCollapsed,
      status,
      ...(entry?.error ? { error: entry.error } : {})
    })
    if (isCollapsed) continue
    for (const m of matched) {
      const disabled = disabledReason?.(p.id, m)
      rows.push({
        kind: 'model',
        key: `m:${p.id}:${m.id}`,
        providerId: p.id,
        providerName: p.name,
        model: m,
        selected: !!selected && selected.providerId === p.id && selected.model === m.id,
        ...(disabled ? { disabled } : {})
      })
    }
    if (matched.length) continue
    if (pending)
      rows.push({ kind: 'status', key: `s:${p.id}`, providerId: p.id, status: 'loading' })
    else if (status === 'error')
      rows.push({
        kind: 'status',
        key: `s:${p.id}`,
        providerId: p.id,
        status: 'error',
        ...(entry?.error ? { error: entry.error } : {})
      })
    else rows.push({ kind: 'status', key: `s:${p.id}`, providerId: p.id, status: 'empty' })
  }

  const text = query.trim()
  if (text) {
    const ordered = [...providers].sort(
      (a, b) => Number(b.id === selected?.providerId) - Number(a.id === selected?.providerId)
    )
    const free = ordered.filter(
      (p) => !p.noFreeId && !(models[p.id]?.list ?? []).some((m) => m.id === text)
    )
    if (free.length) {
      rows.push({ kind: 'free-header', key: 'free' })
      for (const p of free)
        rows.push({
          kind: 'free',
          key: `f:${p.id}`,
          providerId: p.id,
          providerName: p.name,
          text
        })
    }
  }
  return rows
}

/** Próxima linha selecionável a partir de `from` na direção `dir` (pula cabeçalhos/status). */
export function nextSelectable(rows: PickerRow[], from: number, dir: 1 | -1): number {
  for (let i = from + dir; i >= 0 && i < rows.length; i += dir) if (isSelectable(rows[i])) return i
  return isSelectable(rows[from]) ? from : -1
}

/**
 * Linha destacada ao abrir/buscar: a seleção atual (se selecionável), senão a primeira
 * selecionável (-1 = nenhuma).
 */
export function initialHighlight(rows: PickerRow[]): number {
  const sel = rows.findIndex((r) => r.kind === 'model' && r.selected)
  return sel >= 0 && isSelectable(rows[sel]) ? sel : nextSelectable(rows, -1, 1)
}

/** Topo (px) de cada linha + altura total no fim (`offsets[rows.length]`). */
export function rowOffsets(rows: PickerRow[]): number[] {
  const out = new Array<number>(rows.length + 1)
  let y = 0
  for (let i = 0; i < rows.length; i++) {
    out[i] = y
    y += ROW_HEIGHT[rows[i].kind]
  }
  out[rows.length] = y
  return out
}

/** Índice da linha que contém o pixel `y` (busca binária em `offsets`). */
export function rowAt(offsets: number[], y: number): number {
  const n = offsets.length - 1
  if (n <= 0) return 0
  let lo = 0
  let hi = n - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (offsets[mid] <= y) lo = mid
    else hi = mid - 1
  }
  return lo
}

/** Faixa [start, end) de linhas a renderizar para a janela visível (+ folga). */
export function visibleRange(
  offsets: number[],
  scrollTop: number,
  viewHeight: number,
  overscan = 240
): [number, number] {
  const n = offsets.length - 1
  if (n <= 0) return [0, 0]
  const start = rowAt(offsets, Math.max(0, scrollTop - overscan))
  const end = rowAt(offsets, scrollTop + viewHeight + overscan) + 1
  return [start, Math.min(n, end)]
}

/**
 * Cabeçalho "grudado" no topo: o do grupo da primeira linha visível, quando o cabeçalho real já
 * saiu da tela (-1 = nenhum). Mantém o nome do provedor visível ao rolar.
 */
export function stickyHeader(rows: PickerRow[], offsets: number[], scrollTop: number): number {
  if (scrollTop <= 0 || !rows.length) return -1
  for (let i = rowAt(offsets, scrollTop); i >= 0; i--) {
    const r = rows[i]
    if (r.kind === 'free-header') return -1
    if (r.kind === 'header') return offsets[i] < scrollTop ? i : -1
  }
  return -1
}

/** Scroll necessário para a linha `i` ficar inteira na janela (ou o atual, se já está). */
export function scrollToRow(
  offsets: number[],
  i: number,
  scrollTop: number,
  viewHeight: number,
  topInset = 0
): number {
  const top = offsets[i]
  const bottom = offsets[i + 1]
  if (top - topInset < scrollTop) return Math.max(0, top - topInset)
  if (bottom > scrollTop + viewHeight) return bottom - viewHeight
  return scrollTop
}
