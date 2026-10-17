// Memória modular — resolução da config do chat (o que está ativo nesta sessão). Sem Electron.
// REGRA: memória ativa ⇔ `enabled` E ao menos uma coleção ativa numa categoria ligada; senão NADA
// de memória vai para a API (sem índice, sem help, sem tools). Escrita só com coleção de escrita. Subagentes: só memory_search/memory_read com `memory.subagents` (nunca índice/help/
// escrita). Ver SPEC.md → "Memória" → Config.
import {
  MEMORY_CATEGORIES,
  normalizeMemoryConfig,
  type MemoryCategory,
  type MemoryCollection,
  type MemoryConfig
} from '@shared/memory'
import type { Chat, Session, ToolName } from '@shared/types'
import type { MemoryStore } from './store'

export interface ActiveMemory {
  /** Config normalizada do chat. */
  config: MemoryConfig
  /** Algo de memória vai para a API nesta sessão (principal: ligada + algo ativo; subagente: + `subagents`). */
  active: boolean
  /** Sessão principal (índice e help) — subagentes nunca. */
  main: boolean
  /** Categorias ligadas. */
  categories: MemoryCategory[]
  /** Coleções ativas por categoria ligada (selecionadas que existem). */
  byCategory: Partial<Record<MemoryCategory, MemoryCollection[]>>
  /** Todas as coleções ativas (ordem: categoria → ordem da seleção). */
  collections: MemoryCollection[]
  /** Coleção de escrita por categoria (uma das ativas daquela categoria) ou null. */
  writeTo: Partial<Record<MemoryCategory, MemoryCollection | null>>
  /** Há algum destino de escrita (writeTo válido em alguma categoria; só sessão principal). */
  canWrite: boolean
  /** Tools de memória disponíveis (ordem fixa). */
  tools: ToolName[]
  /**
   * Chave do que define o índice (coleções ativas, escrita, categorias). Snapshot com outra chave
   * está obsoleto (memórias novas não mudam a chave → o cache não quebra).
   */
  key: string
}

const READ_TOOLS: ToolName[] = ['memory_search', 'memory_read']
const WRITE_TOOLS: ToolName[] = ['memory_write', 'memory_rewrite', 'memory_delete']

/** Config de memória do chat (normalizada; ausente = desligada). */
export function memoryConfigOf(chat: Pick<Chat, 'config'>): MemoryConfig {
  return normalizeMemoryConfig(chat.config.memory)
}

export function activeMemory(
  store: MemoryStore,
  chat: Pick<Chat, 'config'>,
  session: Pick<Session, 'depth'>
): ActiveMemory {
  const config = memoryConfigOf(chat)
  const main = session.depth === 0
  const categories = config.enabled
    ? MEMORY_CATEGORIES.filter((c) => config.categories.includes(c))
    : []
  const shared = store
    .getCollections(config.collections)
    .filter((c) => categories.includes(c.category))
  const byCategory: ActiveMemory['byCategory'] = {}
  const writeTo: ActiveMemory['writeTo'] = {}
  const collections: MemoryCollection[] = []
  for (const cat of categories) {
    const list = shared.filter((c) => c.category === cat)
    if (list.length) byCategory[cat] = list
    collections.push(...list)
    const w = config.writeTo[cat]
    writeTo[cat] = (w && list.find((c) => c.id === w)) || null
  }
  const mainActive = config.enabled && collections.length > 0
  const canWrite = mainActive && categories.some((c) => writeTo[c] != null)
  const active = mainActive && (main || config.subagents)
  const tools: ToolName[] = !active
    ? []
    : main && canWrite
      ? [...READ_TOOLS, ...WRITE_TOOLS]
      : [...READ_TOOLS]
  const key = JSON.stringify({
    c: shared.map((c) => c.id).sort(),
    w: categories.map((c) => writeTo[c]?.id ?? null),
    k: categories
  })
  return {
    config,
    active,
    main,
    categories,
    byCategory,
    collections,
    writeTo,
    canWrite: main && canWrite,
    tools,
    key
  }
}

/** A coleção é gravável nesta sessão (a de escrita da categoria)? */
export function isWritable(am: ActiveMemory, c: MemoryCollection): boolean {
  if (!am.active || !am.main || !am.categories.includes(c.category)) return false
  return am.writeTo[c.category]?.id === c.id
}

/** A coleção está ativa (leitura) nesta sessão? */
export function isActiveCollection(am: ActiveMemory, c: MemoryCollection): boolean {
  if (!am.active || !am.categories.includes(c.category)) return false
  return am.collections.some((x) => x.id === c.id)
}
