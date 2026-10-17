// Memória modular: cada coleção pertence a UMA categoria da taxonomia fixa (ex.: "Padrão" em cada
// categoria, "Projeto TCC" em Áreas). Chats/personas ativam coleções (várias por categoria para
// leitura) e escolhem no máximo UMA coleção de escrita por categoria via `ChatConfig.memory`.
// Ver SPEC.md → "Memória".

export const MEMORY_CATEGORIES = ['profile', 'topics', 'areas', 'people', 'preferences'] as const
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number]

export const MEMORY_CATEGORY_LABELS: Record<MemoryCategory, string> = {
  profile: 'Perfil',
  topics: 'Tópicos',
  areas: 'Áreas',
  people: 'Pessoas',
  preferences: 'Preferências'
}

/** O que cada categoria guarda (usado nas instruções de `memory_write` e na UI). */
export const MEMORY_CATEGORY_HINTS: Record<MemoryCategory, string> = {
  profile: 'quem é o usuário',
  topics: 'hábitos e interesses recorrentes',
  areas: 'frentes ativas: projetos, tarefas em andamento',
  people: 'pessoas (e animais) da vida do usuário',
  preferences: 'como o usuário quer que o chat se comporte'
}

export type MemoryCollectionScope = 'shared' | 'chat'

export interface MemoryCollection {
  id: string
  name: string
  description: string
  icon: string | null
  /** Categoria da coleção (fixa; todas as memórias dela têm esta categoria). */
  category: MemoryCategory
  scope: MemoryCollectionScope
  /** Só em scope 'chat': o chat dono (apagar o chat apaga a coleção). */
  chatId: string | null
  createdAt: number
  updatedAt: number
  /** Quantidade de memórias (preenchido em list). */
  count?: number
}

export type MemoryUpdatedBy = 'model' | 'extraction' | 'user'

export interface Memory {
  id: string
  collectionId: string
  category: MemoryCategory
  title: string
  slug: string
  summary: string
  facts: string[]
  pinned: boolean
  createdAt: number
  updatedAt: number
  updatedByChatId: string | null
  updatedBy: MemoryUpdatedBy
  /** Criada por memory_rewrite: substitui esta memória (de outra coleção) onde as duas estiverem ativas. */
  supersedesId: string | null
}

export interface MemoryCollectionInput {
  category: MemoryCategory
  name: string
  description?: string
  icon?: string | null
}
/** Categoria não muda depois de criada. */
export type MemoryCollectionPatch = Partial<Omit<MemoryCollectionInput, 'category'>>

/** A categoria vem da coleção. */
export interface MemoryInput {
  collectionId: string
  title: string
  summary?: string
  facts?: string[]
  pinned?: boolean
}
export type MemoryPatch = Partial<Omit<MemoryInput, 'collectionId'>> & { collectionId?: string }

export interface MemoryListQuery {
  collectionId?: string
  /** Coleção de memória do chat (scope 'chat'). */
  chatId?: string
  category?: MemoryCategory
  query?: string
}

export interface MemoryConfig {
  /** Desligado → nada de memória vai para a API (sem índice, sem help, sem tools). */
  enabled: boolean
  /** Coleções compartilhadas ativas para leitura (de qualquer categoria; várias por categoria). */
  collections: string[]
  /**
   * Coleção de escrita por categoria (uma das ativas daquela categoria). Ausente/null = o modelo não
   * grava naquela categoria (só na memória do chat, se ligada). Também é o destino de memory_rewrite.
   */
  writeTo: Partial<Record<MemoryCategory, string | null>>
  /** Categorias ligadas (padrão: todas). Desligar uma categoria ignora suas coleções sem perder a seleção. */
  categories: MemoryCategory[]
  /** Memória própria do chat: uma coleção scope 'chat' por categoria, criada sob demanda (só no chat; personas ignoram). */
  chatMemory: boolean
  /** Texto de auxílio anexado ao system prompt. text null = padrão. */
  helpPrompt: { enabled: boolean; text: string | null }
  /** Extração automática após a compactação + botão "Extrair memórias agora". prompt/model null = padrão/modelo do chat. */
  extraction: {
    auto: boolean
    prompt: string | null
    providerId: string | null
    model: string | null
  }
  /** memory_search/memory_read para subagentes (nunca escrita, nunca índice). */
  subagents: boolean
}

export function defaultMemoryConfig(): MemoryConfig {
  return {
    enabled: false,
    collections: [],
    writeTo: {},
    categories: [...MEMORY_CATEGORIES],
    chatMemory: false,
    helpPrompt: { enabled: false, text: null },
    extraction: { auto: false, prompt: null, providerId: null, model: null },
    subagents: false
  }
}

/** O que a memória vai mandar à API na próxima request desta sessão (para o (i) e "Ver request"). */
export interface MemoryPreview {
  active: boolean
  index: string | null
  help: string | null
  tools: string[]
  /** Quando o snapshot do índice foi tirado (null = ainda não tirado nesta sessão). */
  snapshotAt: number | null
}

export interface MemoryExtractionResult {
  created: number
  updated: number
  deleted: number
  changes: {
    op: 'create' | 'update' | 'delete'
    memoryId: string
    title: string
    collectionId: string
  }[]
  error?: string
}

export const isMemoryCategory = (v: unknown): v is MemoryCategory =>
  typeof v === 'string' && (MEMORY_CATEGORIES as readonly string[]).includes(v)

const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null)

/**
 * Config completa a partir de qualquer valor salvo (ausente/parcial/inválido → padrões). Listas sem
 * duplicatas; `writeTo` só com categorias válidas (o valor é conferido contra as coleções ativas
 * na resolução — ver main/memory/config.ts).
 */
export function normalizeMemoryConfig(v: unknown): MemoryConfig {
  const d = defaultMemoryConfig()
  if (!v || typeof v !== 'object' || Array.isArray(v)) return d
  const src = v as Record<string, unknown>
  const collections = Array.isArray(src.collections)
    ? [...new Set(src.collections.filter((x): x is string => typeof x === 'string' && !!x))]
    : d.collections
  const writeTo: MemoryConfig['writeTo'] = {}
  if (src.writeTo && typeof src.writeTo === 'object')
    for (const [k, val] of Object.entries(src.writeTo as Record<string, unknown>))
      if (isMemoryCategory(k)) writeTo[k] = typeof val === 'string' && val ? val : null
  const categories = Array.isArray(src.categories)
    ? MEMORY_CATEGORIES.filter((c) => (src.categories as unknown[]).includes(c))
    : d.categories
  const hp = (src.helpPrompt ?? {}) as Record<string, unknown>
  const ex = (src.extraction ?? {}) as Record<string, unknown>
  return {
    enabled: src.enabled === true,
    collections,
    writeTo,
    categories,
    chatMemory: src.chatMemory === true,
    helpPrompt: { enabled: hp.enabled === true, text: strOrNull(hp.text) },
    extraction: {
      auto: ex.auto === true,
      prompt: strOrNull(ex.prompt),
      providerId: strOrNull(ex.providerId),
      model: strOrNull(ex.model)
    },
    subagents: src.subagents === true
  }
}
