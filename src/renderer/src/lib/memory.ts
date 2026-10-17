// Memória modular — lógica pura da UI (Configurações → Memórias, aba Memória do painel, editor de
// personas, cards das tools e da extração). Sem React/store: testada em e2e/memoryUi.test.ts.
// Contrato: src/shared/memory.ts e SPEC.md → "Memória".
import {
  isMemoryCategory as isCategory,
  MEMORY_CATEGORIES,
  normalizeMemoryConfig,
  type Memory,
  type MemoryCategory,
  type MemoryCollection,
  type MemoryConfig,
  type MemoryExtractionResult,
  type MemoryUpdatedBy
} from '@shared/memory'
import { MEMORY_LIMITS as SHARED_LIMITS } from '@shared/limits'
import { MEMORY_TOOL_NAMES, TOOL_LABELS } from '@shared/tools'
import type { ChatConfig, MessageMeta, ToolName } from '@shared/types'

export { DEFAULT_MEMORY_EXTRACTION_PROMPT, DEFAULT_MEMORY_HELP_PROMPT } from '@shared/defaults'

// ---------------- limites ----------------

/**
 * Limites de conteúdo (SPEC: título ≤ 80, resumo ≤ 160, tópico ≤ 200, ≤ 15 tópicos). O main também
 * valida; aqui só para os contadores e para não deixar salvar acima do teto.
 */
export const MEMORY_LIMITS = {
  title: SHARED_LIMITS.titleChars,
  summary: SHARED_LIMITS.summaryChars,
  fact: SHARED_LIMITS.factChars,
  facts: SHARED_LIMITS.maxFacts,
  collectionName: SHARED_LIMITS.collectionNameChars,
  collectionDescription: SHARED_LIMITS.collectionDescriptionChars
} as const

export interface CounterState {
  len: number
  max: number
  /** Passou do limite (não salva). */
  over: boolean
  /** ≥ 90% do limite (contador em destaque). */
  near: boolean
  label: string
}

export function counter(text: string, max: number): CounterState {
  const len = text.length
  return { len, max, over: len > max, near: len >= Math.floor(max * 0.9), label: `${len}/${max}` }
}

/** Texto pronto para salvar: espaços aparados; vazio → null quando `required`. */
export function cleanField(text: string, max: number, required = false): string | null {
  const t = text.replace(/\s+/g, ' ').trim()
  if (required && !t) return null
  if (t.length > max) return null
  return t
}

export function canAddFact(facts: readonly string[]): boolean {
  return facts.length < MEMORY_LIMITS.facts
}

/** Move o tópico `i` uma posição (dir −1 = sobe, +1 = desce). Fora dos limites → cópia igual. */
export function moveFact(facts: readonly string[], i: number, dir: -1 | 1): string[] {
  const j = i + dir
  const next = [...facts]
  if (i < 0 || i >= facts.length || j < 0 || j >= facts.length) return next
  ;[next[i], next[j]] = [next[j], next[i]]
  return next
}

export function replaceFact(facts: readonly string[], i: number, text: string): string[] {
  return facts.map((f, k) => (k === i ? text : f))
}

export function removeFact(facts: readonly string[], i: number): string[] {
  return facts.filter((_, k) => k !== i)
}

// ---------------- config ----------------

/** `ChatConfig.memory` completo (ausente/parcial → padrões; `normalizeMemoryConfig` do contrato). */
export function memoryConfigOf(
  cfg: Partial<Pick<ChatConfig, 'memory'>> | null | undefined
): MemoryConfig {
  return normalizeMemoryConfig(cfg?.memory)
}

const byCategory = (cols: readonly MemoryCollection[], cat: MemoryCategory): MemoryCollection[] =>
  cols.filter((c) => c.category === cat)

/** Coleções de uma categoria, "Padrão" primeiro e o resto por nome. */
export function sharedCollections(
  cols: readonly MemoryCollection[],
  cat: MemoryCategory
): MemoryCollection[] {
  return byCategory(cols, cat).sort((a, b) => {
    const pa = a.name === 'Padrão' ? 0 : 1
    const pb = b.name === 'Padrão' ? 0 : 1
    return pa - pb || a.name.localeCompare(b.name, 'pt-BR')
  })
}

/** Coleções ativas (selecionadas E existentes) de uma categoria, na ordem de `sharedCollections`. */
export function activeInCategory(
  mem: MemoryConfig,
  cols: readonly MemoryCollection[],
  cat: MemoryCategory
): MemoryCollection[] {
  return sharedCollections(cols, cat).filter((c) => mem.collections.includes(c.id))
}

/**
 * Regra de envio (SPEC): ligado E alguma coleção ativa numa categoria ligada. Sem a lista de
 * coleções, conta os ids.
 */
export function memoryWillSend(
  mem: MemoryConfig,
  cols: readonly MemoryCollection[] | null
): boolean {
  if (!mem.enabled) return false
  if (!cols) return mem.collections.length > 0 && mem.categories.length > 0
  return mem.categories.some((cat) => activeInCategory(mem, cols, cat).length > 0)
}

/** Liga/desliga uma coleção para leitura. Desligar a coleção de escrita limpa a escrita da categoria. */
export function toggleCollection(
  mem: MemoryConfig,
  col: Pick<MemoryCollection, 'id' | 'category'>,
  on: boolean
): MemoryConfig {
  const has = mem.collections.includes(col.id)
  if (on === has) return mem
  const collections = on
    ? [...mem.collections, col.id]
    : mem.collections.filter((x) => x !== col.id)
  const writeTo = { ...mem.writeTo }
  if (!on && writeTo[col.category] === col.id) writeTo[col.category] = null
  // ligar uma coleção numa categoria desligada liga a categoria (senão o clique não teria efeito)
  const categories =
    on && !mem.categories.includes(col.category)
      ? MEMORY_CATEGORIES.filter((c) => c === col.category || mem.categories.includes(c))
      : mem.categories
  return { ...mem, collections, writeTo, categories }
}

export function toggleCategory(mem: MemoryConfig, cat: MemoryCategory, on: boolean): MemoryConfig {
  const categories = on
    ? MEMORY_CATEGORIES.filter((c) => c === cat || mem.categories.includes(c))
    : mem.categories.filter((c) => c !== cat)
  return { ...mem, categories }
}

/** Por que a coleção não pode ser a de escrita da categoria (null = pode). */
export function writeTargetError(
  mem: MemoryConfig,
  cols: readonly MemoryCollection[],
  cat: MemoryCategory,
  id: string | null
): string | null {
  if (id === null) return null
  const c = cols.find((x) => x.id === id)
  if (!c) return 'A coleção não existe mais.'
  if (c.category !== cat) return 'A coleção é de outra categoria.'
  if (!mem.collections.includes(id)) return 'Ative a coleção para leitura antes de gravar nela.'
  return null
}

/** Define a coleção de escrita (ou null = nenhuma). Inválida → `{ error }` e a config intacta. */
export function setWriteTarget(
  mem: MemoryConfig,
  cols: readonly MemoryCollection[],
  cat: MemoryCategory,
  id: string | null
): { mem: MemoryConfig; error: string | null } {
  const error = writeTargetError(mem, cols, cat, id)
  if (error) return { mem, error }
  return { mem: { ...mem, writeTo: { ...mem.writeTo, [cat]: id } }, error: null }
}

/** A coleção de escrita gravada da categoria ainda é válida? (apagada, desativada…) → aviso. */
export function writeTargetIssue(
  mem: MemoryConfig,
  cols: readonly MemoryCollection[],
  cat: MemoryCategory
): string | null {
  const id = mem.writeTo[cat]
  if (!id) return null
  return writeTargetError(mem, cols, cat, id)
}

/** Coleção de escrita efetiva da categoria (null se não houver ou se for inválida). */
export function writeTargetOf(
  mem: MemoryConfig,
  cols: readonly MemoryCollection[],
  cat: MemoryCategory
): MemoryCollection | null {
  const id = mem.writeTo[cat]
  if (!id || writeTargetError(mem, cols, cat, id)) return null
  return cols.find((c) => c.id === id) ?? null
}

// ---------------- herança da persona ----------------

/**
 * Selo de cada coleção no painel do chat em relação à persona de origem:
 * - `persona`: veio da persona e está ativa;
 * - `persona-off`: veio da persona, mas foi desligada neste chat;
 * - `added`: ativa só neste chat;
 * - null: nem na persona nem ativa (ou chat sem persona).
 */
export type CollectionBadge = 'persona' | 'persona-off' | 'added' | null

export function collectionBadge(
  id: string,
  mem: MemoryConfig,
  persona: MemoryConfig | null
): CollectionBadge {
  const on = mem.collections.includes(id)
  if (!persona) return null
  if (persona.collections.includes(id)) return on ? 'persona' : 'persona-off'
  return on ? 'added' : null
}

/** Campos comparados com a persona. */
function comparable(m: MemoryConfig): unknown {
  return {
    enabled: m.enabled,
    collections: [...m.collections].sort(),
    writeTo: Object.fromEntries(
      MEMORY_CATEGORIES.map((c) => [c, m.writeTo[c] ?? null]).filter(([, v]) => v !== null)
    ),
    categories: MEMORY_CATEGORIES.filter((c) => m.categories.includes(c)),
    helpPrompt: m.helpPrompt,
    extraction: m.extraction,
    subagents: m.subagents
  }
}

/** A seção difere da persona? (para "personalizado neste chat" + "Restaurar da persona"). */
export function differsFromPersona(mem: MemoryConfig, persona: MemoryConfig): boolean {
  return JSON.stringify(comparable(mem)) !== JSON.stringify(comparable(persona))
}

/** Volta à config de memória da persona (cópia). */
export function restoreFromPersona(persona: MemoryConfig): MemoryConfig {
  return {
    ...persona,
    collections: [...persona.collections],
    writeTo: { ...persona.writeTo },
    categories: [...persona.categories]
  }
}

// ---------------- exibição ----------------

export const UPDATED_BY_LABEL: Record<MemoryUpdatedBy, string> = {
  model: 'pelo modelo',
  extraction: 'pela extração',
  user: 'por você'
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** "hoje, 14:28" · "ontem, 09:10" · "12 de out." · "12 de out. de 2025". */
export function memoryDate(ts: number, now: number = Date.now()): string {
  const d = new Date(ts)
  const n = new Date(now)
  const day = (x: Date): number => Date.UTC(x.getFullYear(), x.getMonth(), x.getDate())
  const diff = Math.round((day(n) - day(d)) / 86_400_000)
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  if (diff === 0) return `hoje, ${time}`
  if (diff === 1) return `ontem, ${time}`
  return d.toLocaleDateString('pt-BR', {
    day: 'numeric',
    month: 'short',
    ...(d.getFullYear() === n.getFullYear() ? {} : { year: 'numeric' })
  })
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

/** "2 criadas, 1 atualizada, 0 apagadas". */
export function extractionCounts(
  r: Pick<MemoryExtractionResult, 'created' | 'updated' | 'deleted'>
): string {
  return [
    plural(r.created, 'criada', 'criadas'),
    plural(r.updated, 'atualizada', 'atualizadas'),
    plural(r.deleted, 'apagada', 'apagadas')
  ].join(', ')
}

export const CHANGE_LABEL: Record<MemoryChange['op'], string> = {
  create: 'criada',
  update: 'atualizada',
  delete: 'apagada'
}

/** Segmentos de texto com links `[[slug]]` (memória → link; slug desconhecido → texto). */
export type LinkSegment = { text: string } | { slug: string; label: string }

export function splitMemoryLinks(text: string): LinkSegment[] {
  const out: LinkSegment[] = []
  const re = /\[\[([^\]\n|]+?)(?:\|([^\]\n]+))?\]\]/g
  let last = 0
  for (const m of text.matchAll(re)) {
    const i = m.index ?? 0
    if (i > last) out.push({ text: text.slice(last, i) })
    out.push({ slug: m[1].trim(), label: (m[2] ?? m[1]).trim() })
    last = i + m[0].length
  }
  if (last < text.length) out.push({ text: text.slice(last) })
  return out
}

/**
 * Texto corrido sem a sintaxe de link: `[[slug|rótulo]]` → rótulo; `[[slug]]` → título da memória
 * (via `known`) ou o próprio slug.
 */
export function plainMemoryText(
  text: string,
  known: readonly Pick<Memory, 'slug' | 'title'>[] = []
): string {
  return splitMemoryLinks(text)
    .map((s) =>
      'text' in s
        ? s.text
        : s.label !== s.slug
          ? s.label
          : (known.find((m) => m.slug === s.slug)?.title ?? s.slug)
    )
    .join('')
}

/** Destinos de "Mover para": coleções da mesma categoria, exceto a atual. */
export function moveTargets(
  memory: Pick<Memory, 'collectionId' | 'category'>,
  cols: readonly MemoryCollection[]
): MemoryCollection[] {
  return sharedCollections(cols, memory.category).filter((c) => c.id !== memory.collectionId)
}

/** Filtro local (título/resumo/tópicos), termos em qualquer ordem, sem acento/caixa. */
export function matchesMemory(
  m: Pick<Memory, 'title' | 'summary' | 'facts'>,
  query: string
): boolean {
  const norm = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  const hay = norm([m.title, m.summary, ...m.facts].join('\n'))
  return norm(query)
    .split(/\s+/)
    .filter(Boolean)
    .every((t) => hay.includes(t))
}

// ---------------- tools e mensagens ----------------

export type MemoryToolName = Extract<
  ToolName,
  'memory_search' | 'memory_read' | 'memory_write' | 'memory_rewrite' | 'memory_delete'
>

/** Rótulos ("Buscar memória"…) — os mesmos de TOOL_LABELS. */
export const MEMORY_TOOL_LABELS = TOOL_LABELS as Record<MemoryToolName, string>

export const isMemoryTool = (name: string): name is MemoryToolName =>
  (MEMORY_TOOL_NAMES as readonly string[]).includes(name)

/** Mudança feita por uma tool de memória ou pela extração (`meta.memoryChanges`). */
export type MemoryChange = MemoryExtractionResult['changes'][number]

/** Meta da mensagem só de exibição `kind: 'memory-extraction'` (não vai à API). */
export type MemoryExtractionMeta = NonNullable<MessageMeta['memoryExtraction']>

const isChange = (v: unknown): v is MemoryChange => {
  const c = v as MemoryChange
  return (
    !!c &&
    typeof c === 'object' &&
    (c.op === 'create' || c.op === 'update' || c.op === 'delete') &&
    typeof c.memoryId === 'string'
  )
}

export function memoryChangesOf(meta: MessageMeta | undefined): MemoryChange[] {
  const raw: unknown = meta?.memoryChanges
  return Array.isArray(raw) ? raw.filter(isChange) : []
}

export const isExtractionMessage = (meta: MessageMeta | undefined): boolean =>
  meta?.kind === 'memory-extraction'

export function extractionOf(meta: MessageMeta | undefined): MemoryExtractionMeta | null {
  if (!isExtractionMessage(meta)) return null
  const r = meta?.memoryExtraction as Partial<MemoryExtractionMeta> | undefined
  if (!r || typeof r !== 'object') return null
  return {
    ...r,
    created: Number(r.created) || 0,
    updated: Number(r.updated) || 0,
    deleted: Number(r.deleted) || 0,
    changes: Array.isArray(r.changes) ? r.changes.filter(isChange) : [],
    trigger: r.trigger === 'compaction' ? 'compaction' : 'manual'
  }
}

const shortId = (id: string): string => (id.length > 14 ? `${id.slice(0, 10)}…` : id)

/** Resumo de uma linha dos argumentos de uma tool de memória (cabeçalho do card / aprovação). */
export function memoryToolSummary(name: string, args: Record<string, unknown> | null): string {
  if (!args) return ''
  const s = (k: string): string => (typeof args[k] === 'string' ? (args[k] as string).trim() : '')
  const cat = (): string =>
    isCategory(args.category) ? CATEGORY_SHORT[args.category as MemoryCategory] : s('category')
  switch (name) {
    case 'memory_search':
      return [
        s('query') && `"${s('query')}"`,
        cat(),
        s('collection') && `em ${s('collection')}`,
        args.limit != null && `limite ${String(args.limit)}`
      ]
        .filter(Boolean)
        .join(' · ')
    case 'memory_read': {
      const ids = Array.isArray(args.ids) ? args.ids.filter((x) => typeof x === 'string') : []
      return ids.length === 1 ? shortId(ids[0]) : `${ids.length} memórias`
    }
    case 'memory_write':
    case 'memory_rewrite': {
      const ops = Array.isArray(args.ops) ? (args.ops as { op?: unknown }[]) : []
      const n = (op: string): number => ops.filter((o) => o && o.op === op).length
      const opsText = [
        n('add') && `+${n('add')}`,
        n('replace') && `~${n('replace')}`,
        n('remove') && `−${n('remove')}`
      ]
        .filter(Boolean)
        .join(' ')
      const facts = Array.isArray(args.facts) ? `${args.facts.length} tópicos` : ''
      return [
        name === 'memory_write' ? cat() : '',
        s('title') || (s('id') && shortId(s('id'))) || (name === 'memory_write' ? 'nova' : ''),
        opsText || facts
      ]
        .filter(Boolean)
        .join(' · ')
    }
    case 'memory_delete':
      return shortId(s('id'))
    default:
      return ''
  }
}

export const CATEGORY_SHORT: Record<MemoryCategory, string> = {
  profile: 'Perfil',
  topics: 'Tópicos',
  areas: 'Áreas',
  people: 'Pessoas',
  preferences: 'Preferências'
}

/** Ids citados num resultado de memory_search/memory_read que existem na lista conhecida. */
export function memoryIdsIn(text: string, known: readonly Pick<Memory, 'id'>[]): string[] {
  const out: string[] = []
  for (const m of known) if (text.includes(m.id) && !out.includes(m.id)) out.push(m.id)
  return out.sort((a, b) => text.indexOf(a) - text.indexOf(b))
}
