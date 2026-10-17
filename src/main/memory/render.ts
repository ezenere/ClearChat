// Memória modular — índice enviado no system prompt (função pura sobre os dados já carregados).
// Ver SPEC.md → "Memória" → Envio à API.
import { MEMORY_LIMITS as ML } from '@shared/limits'
import {
  MEMORY_CATEGORY_HINTS,
  MEMORY_CATEGORY_LABELS,
  type Memory,
  type MemoryCategory,
  type MemoryCollection
} from '@shared/memory'
import { isWritable, type ActiveMemory } from './config'
import type { MemoryStore } from './store'

export interface IndexGroup {
  category: MemoryCategory
  collections: { collection: MemoryCollection; writable: boolean; memories: Memory[] }[]
}

/**
 * Esconde memórias substituídas (memory_rewrite) cuja substituta também está entre as ativas.
 * `all` = memórias de todas as coleções ativas.
 */
export function hideSuperseded(all: Memory[]): Memory[] {
  const ids = new Set(all.map((m) => m.id))
  const superseded = new Set(
    all.filter((m) => m.supersedesId && ids.has(m.supersedesId)).map((m) => m.supersedesId!)
  )
  return all.filter((m) => !superseded.has(m.id))
}

/** Grupos categoria → coleção ativa → memórias visíveis (substituídas ocultas). */
export function indexGroups(store: MemoryStore, am: ActiveMemory): IndexGroup[] {
  const visible = hideSuperseded(store.memoriesIn(am.collections.map((c) => c.id)))
  const groups: IndexGroup[] = []
  for (const cat of am.categories) {
    const cols = am.byCategory[cat] ?? []
    if (!cols.length) continue
    groups.push({
      category: cat,
      collections: cols.map((c) => ({
        collection: c,
        writable: isWritable(am, c),
        memories: visible.filter((m) => m.collectionId === c.id)
      }))
    })
  }
  return groups
}

const line = (m: Memory): string => `- ${m.id} · ${m.title}${m.summary ? ` — ${m.summary}` : ''}`

export interface RenderOptions {
  /** Teto de caracteres (padrão MEMORY_LIMITS.indexMaxChars). */
  maxChars?: number
  /** 'pinned' (padrão: tópicos só das fixadas) | 'all' (extração: todos os tópicos). */
  facts?: 'pinned' | 'all'
  /** Cabeçalho (padrão: o do system prompt). */
  header?: string
}

export const INDEX_HEADER =
  'Memória persistente sobre o usuário — índice congelado no início desta sessão (o que você gravar depois aparece só nos resultados das ferramentas). Formato: id · título — resumo; memórias fixadas trazem os tópicos. Detalhes: memory_read; busca: memory_search. Coleções marcadas "escrita" recebem memory_write; "leitura" só podem ser corrigidas com memory_rewrite.'

/**
 * Bloco `<memory>…</memory>`: por categoria → coleção (nome, escrita/leitura, descrição) → memórias.
 * Acima do teto: ficam as fixadas + as mais recentes; o resto é contado com "use memory_search".
 */
export function renderIndex(groups: IndexGroup[], opts: RenderOptions = {}): string {
  const max = opts.maxChars ?? ML.indexMaxChars
  const factsMode = opts.facts ?? 'pinned'
  const entry = (m: Memory): string => {
    const facts = factsMode === 'all' || m.pinned ? m.facts : []
    return [line(m), ...facts.map((f, i) => `  ${i + 1}. ${f}`)].join('\n')
  }
  // orçamento: fixadas primeiro, depois as mais recentes
  const all = groups.flatMap((g) => g.collections.flatMap((c) => c.memories))
  const ranked = [...all].sort(
    (a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt
  )
  const skeleton = renderWith(groups, new Set(), entry, opts)
  let budget = max - skeleton.length - 120
  const keep = new Set<string>()
  for (const m of ranked) {
    const n = entry(m).length + 1
    if (n > budget && keep.size) continue
    if (n > budget) break
    keep.add(m.id)
    budget -= n
  }
  return renderWith(groups, keep, entry, opts, all.length - keep.size)
}

function renderWith(
  groups: IndexGroup[],
  keep: Set<string>,
  entry: (m: Memory) => string,
  opts: RenderOptions,
  omitted = 0
): string {
  const out: string[] = ['<memory>', opts.header ?? INDEX_HEADER]
  for (const g of groups) {
    out.push(
      '',
      `## ${MEMORY_CATEGORY_LABELS[g.category]} (${g.category}: ${MEMORY_CATEGORY_HINTS[g.category]})`
    )
    for (const c of g.collections) {
      const col = c.collection
      const kind = c.writable ? 'escrita' : 'leitura'
      out.push(`### ${col.name} — ${kind}`)
      if (col.description) out.push(col.description)
      const shown = c.memories.filter((m) => keep.has(m.id))
      for (const m of shown) out.push(entry(m))
      const hidden = c.memories.length - shown.length
      if (!c.memories.length) out.push('(vazia)')
      else if (hidden > 0) out.push(`(+${hidden} não listada${hidden > 1 ? 's' : ''})`)
    }
  }
  if (omitted > 0)
    out.push(
      '',
      `[${omitted} memória${omitted > 1 ? 's' : ''} fora do índice por tamanho — use memory_search para encontrá-las.]`
    )
  out.push('</memory>')
  return out.join('\n')
}
