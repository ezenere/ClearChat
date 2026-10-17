// SOMENTE DESENVOLVIMENTO: `window.api.memory` simulado (coleções por categoria, memórias com
// tópicos/fixadas/substituições, preview do índice e extração). Usado por dev/mockApi.ts.
import {
  defaultMemoryConfig,
  MEMORY_CATEGORIES,
  MEMORY_CATEGORY_LABELS,
  type Memory,
  type MemoryCategory,
  type MemoryCollection,
  type MemoryConfig,
  type MemoryExtractionResult,
  type MemoryPreview
} from '@shared/memory'
import type { ClearApi } from '@shared/ipc'
import type { AgentEvent, Chat, Session, StoredMessage } from '@shared/types'
import {
  DEFAULT_MEMORY_EXTRACTION_PROMPT,
  DEFAULT_MEMORY_HELP_PROMPT,
  MEMORY_LIMITS,
  memoryConfigOf
} from '../lib/memory'

const now = Date.now()
const H = 3_600_000
const D = 24 * H

export interface MemoryMockDeps {
  emit: (e: AgentEvent) => void
  chats: Chat[]
  sessions: Session[]
  messages: StoredMessage[]
  msg: (
    sessionId: string,
    message: StoredMessage['message'],
    meta?: StoredMessage['meta'],
    createdAt?: number
  ) => StoredMessage
  delay: <T>(v: T, ms?: number) => Promise<T>
  /** Cenário "memory": coleções/memórias de chat do chat c5. */
  withChatData: boolean
}

let seq = 0
const nid = (p: string): string =>
  `${p}${(++seq).toString(36)}${Math.random().toString(36).slice(2, 6)}`

const slugify = (t: string): string =>
  t
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')

/** Ids estáveis das coleções do seed (usados pelo cenário em mockApi.ts). */
export const MOCK_COLS = {
  profile: 'col-profile',
  topics: 'col-topics',
  areas: 'col-areas',
  tcc: 'col-tcc',
  clearchat: 'col-clearchat',
  people: 'col-people',
  family: 'col-family',
  prefs: 'col-prefs',
  chatAreas: 'col-chat-c5-areas',
  chatPeople: 'col-chat-c5-people'
} as const

/** Config de memória da persona "Assistente pessoal" do cenário. */
export function mockPersonaMemory(): MemoryConfig {
  return {
    ...defaultMemoryConfig(),
    enabled: true,
    collections: [
      MOCK_COLS.profile,
      MOCK_COLS.topics,
      MOCK_COLS.areas,
      MOCK_COLS.people,
      MOCK_COLS.prefs
    ],
    writeTo: {
      profile: MOCK_COLS.profile,
      areas: MOCK_COLS.areas,
      people: MOCK_COLS.people,
      preferences: MOCK_COLS.prefs
    },
    helpPrompt: { enabled: true, text: null }
  }
}

/** Config do chat c5: herda da persona, + Projeto TCC (escrita em Áreas), − Tópicos, memória do chat. */
export function mockChatMemory(): MemoryConfig {
  const p = mockPersonaMemory()
  return {
    ...p,
    collections: [...p.collections.filter((c) => c !== MOCK_COLS.topics), MOCK_COLS.tcc],
    writeTo: { ...p.writeTo, areas: MOCK_COLS.tcc },
    chatMemory: true,
    extraction: { auto: true, prompt: null, providerId: null, model: null }
  }
}

export function createMemoryMock(deps: MemoryMockDeps): ClearApi['memory'] {
  const { emit, delay } = deps
  const col = (
    id: string,
    category: MemoryCategory,
    name: string,
    description: string,
    icon: string | null = null,
    chatId: string | null = null
  ): MemoryCollection => ({
    id,
    category,
    name,
    description,
    icon,
    scope: chatId ? 'chat' : 'shared',
    chatId,
    createdAt: now - 30 * D,
    updatedAt: now - 2 * D
  })
  const collections: MemoryCollection[] = [
    col(MOCK_COLS.profile, 'profile', 'Padrão', 'Quem eu sou: trabalho, formação, onde moro'),
    col(MOCK_COLS.topics, 'topics', 'Padrão', 'Hobbies e assuntos que voltam sempre'),
    col(MOCK_COLS.areas, 'areas', 'Padrão', 'Frentes do dia a dia'),
    col(
      MOCK_COLS.tcc,
      'areas',
      'Projeto TCC',
      'Monografia sobre CRDTs — prazos, orientador, decisões',
      'graduation'
    ),
    col(
      MOCK_COLS.clearchat,
      'areas',
      'ClearChat',
      'O app: arquitetura, decisões e pendências',
      'code'
    ),
    col(MOCK_COLS.people, 'people', 'Padrão', 'Pessoas próximas'),
    col(MOCK_COLS.family, 'people', 'Família', 'Família e bichos', '🏡'),
    col(MOCK_COLS.prefs, 'preferences', 'Padrão', 'Como eu gosto das respostas')
  ]
  if (deps.withChatData)
    collections.push(
      col(MOCK_COLS.chatAreas, 'areas', 'Este chat', '', null, 'c5'),
      col(MOCK_COLS.chatPeople, 'people', 'Este chat', '', null, 'c5')
    )

  const mem = (
    id: string,
    collectionId: string,
    title: string,
    summary: string,
    facts: string[],
    extra: Partial<Memory> = {}
  ): Memory => {
    const c = collections.find((x) => x.id === collectionId)!
    return {
      id,
      collectionId,
      category: c.category,
      title,
      slug: slugify(title),
      summary,
      facts,
      pinned: false,
      createdAt: now - 20 * D,
      updatedAt: now - 3 * D,
      updatedByChatId: null,
      updatedBy: 'user',
      supersedesId: null,
      ...extra
    }
  }
  const memories: Memory[] = [
    mem(
      'm-trabalho',
      MOCK_COLS.profile,
      'Trabalho atual',
      'Dev full-stack na Lumen (fintech), time de pagamentos',
      [
        'Entrou na Lumen em março de 2025',
        'Stack: TypeScript, Node e React; um pouco de Go',
        'Trabalha remoto de Curitiba, às vezes vai a São Paulo'
      ],
      { pinned: true, updatedAt: now - 2 * H, updatedBy: 'model', updatedByChatId: 'c2' }
    ),
    mem(
      'm-formacao',
      MOCK_COLS.profile,
      'Formação',
      'Último ano de Ciência da Computação na UFPR',
      ['TCC sobre CRDTs — ver [[orientacao-do-tcc]]', 'Inglês fluente; estudando alemão (A2)'],
      { updatedAt: now - 9 * D }
    ),
    mem(
      'm-corrida',
      MOCK_COLS.topics,
      'Corrida',
      'Corre 3x por semana; treinando para a meia de Curitiba',
      ['Melhor tempo nos 10 km: 52 min', 'Prefere correr de manhã cedo'],
      { updatedAt: now - 5 * D, updatedBy: 'extraction', updatedByChatId: 'c3' }
    ),
    mem(
      'm-cafe',
      MOCK_COLS.topics,
      'Café especial',
      'Gosta de métodos filtrados (V60, Aeropress)',
      [],
      {
        updatedAt: now - 40 * D
      }
    ),
    mem(
      'm-prazos-antigo',
      MOCK_COLS.areas,
      'Prazos do semestre',
      'Entrega do TCC em 30/11; banca em dezembro',
      ['Entrega da versão final: 30/11', 'Banca prevista para a 2ª semana de dezembro'],
      { updatedAt: now - 25 * D }
    ),
    mem(
      'm-mudanca',
      MOCK_COLS.areas,
      'Mudança de apartamento',
      'Procurando apê perto do Batel até janeiro',
      ['Orçamento até R$ 3.200', 'Precisa aceitar cachorro — [[biscoito-cachorro]]'],
      { updatedAt: now - 6 * D }
    ),
    mem(
      'm-orientacao',
      MOCK_COLS.tcc,
      'Orientação do TCC',
      'Reuniões quinzenais com o [[marcos-orientador]]',
      [
        'Reuniões às quintas, 14h, a cada 15 dias',
        'Marcos prefere receber capítulos em PDF, com 3 dias de antecedência',
        'Próxima entrega: capítulo 3 (implementação)'
      ],
      { updatedAt: now - 1 * D, updatedBy: 'model', updatedByChatId: 'c5' }
    ),
    mem(
      'm-prazo',
      MOCK_COLS.tcc,
      'Prazo de entrega',
      'Entrega adiada para 14/12; banca em fevereiro',
      [
        'Coordenação aprovou o adiamento em 10/10',
        'Versão final: 14/12',
        'Banca: 1ª quinzena de fevereiro'
      ],
      {
        supersedesId: 'm-prazos-antigo',
        updatedAt: now - 4 * D,
        updatedBy: 'model',
        updatedByChatId: 'c5'
      }
    ),
    mem(
      'm-arquitetura',
      MOCK_COLS.clearchat,
      'Arquitetura',
      'Electron + React; main com SQLite e runner de agentes',
      ['Renderer não acessa Node: tudo via window.api', 'Memória modular em desenvolvimento'],
      { updatedAt: now - 2 * D }
    ),
    mem(
      'm-marcos',
      MOCK_COLS.people,
      'Marcos (orientador)',
      'Prof. Marcos Lima, sistemas distribuídos',
      ['Muito exigente com referências', 'Responde e-mails só à noite'],
      { updatedAt: now - 12 * D }
    ),
    mem(
      'm-ana',
      MOCK_COLS.family,
      'Ana (irmã)',
      'Irmã mais nova, faz Medicina em Porto Alegre',
      ['Aniversário em 22/05'],
      { updatedAt: now - 15 * D }
    ),
    mem(
      'm-biscoito',
      MOCK_COLS.family,
      'Biscoito (cachorro)',
      'Vira-lata caramelo de 4 anos',
      ['Tem medo de fogos', 'Ração especial (alergia a frango)'],
      { updatedAt: now - 8 * D }
    ),
    mem(
      'm-estilo',
      MOCK_COLS.prefs,
      'Estilo de resposta',
      'Respostas diretas, em pt-BR, sem floreio',
      [
        'Começar pela resposta, depois o contexto',
        'Exemplos de código em TypeScript',
        'Sem emojis'
      ],
      { pinned: true, updatedAt: now - 10 * D }
    )
  ]
  if (deps.withChatData)
    memories.push(
      mem(
        'm-cap3',
        MOCK_COLS.chatAreas,
        'Capítulo 3 em revisão',
        'Seções 3.2 e 3.4 precisam de figuras novas',
        ['Figura do merge de RGA está desatualizada', 'Faltam benchmarks com 10k operações'],
        { updatedAt: now - 30 * 60_000, updatedBy: 'model', updatedByChatId: 'c5' }
      ),
      mem(
        'm-helena',
        MOCK_COLS.chatPeople,
        'Banca: Profa. Helena',
        'Convidada para a banca do TCC',
        ['Especialista em sistemas distribuídos'],
        { updatedAt: now - 31 * 60_000, updatedBy: 'model', updatedByChatId: 'c5' }
      )
    )

  const snapshots = new Map<string, number>()
  if (deps.withChatData) snapshots.set('s5', now - 40 * 60_000)

  const changed = (collectionId: string | null, memoryId: string | null): void =>
    emit({ type: 'memory-changed', collectionId, memoryId })
  const counted = (): MemoryCollection[] =>
    collections.map((c) => ({
      ...c,
      count: memories.filter((m) => m.collectionId === c.id).length
    }))
  const check = (m: Pick<Memory, 'title' | 'summary' | 'facts'>): void => {
    if (!m.title.trim()) throw new Error('Título obrigatório')
    if (m.title.length > MEMORY_LIMITS.title)
      throw new Error(`Título acima de ${MEMORY_LIMITS.title} caracteres`)
    if (m.summary.length > MEMORY_LIMITS.summary)
      throw new Error(`Resumo acima de ${MEMORY_LIMITS.summary} caracteres`)
    if (m.facts.length > MEMORY_LIMITS.facts)
      throw new Error(`Mais de ${MEMORY_LIMITS.facts} tópicos`)
    if (m.facts.some((f) => f.length > MEMORY_LIMITS.fact))
      throw new Error(`Tópico acima de ${MEMORY_LIMITS.fact} caracteres`)
  }

  const chatOf = (sessionId: string): Chat | undefined => {
    const s = deps.sessions.find((x) => x.id === sessionId)
    return s ? deps.chats.find((c) => c.id === s.chatId) : undefined
  }
  const activeCols = (cfg: MemoryConfig, chatId: string): MemoryCollection[] =>
    collections.filter(
      (c) =>
        (c.scope === 'shared' &&
          cfg.collections.includes(c.id) &&
          cfg.categories.includes(c.category)) ||
        (c.scope === 'chat' && cfg.chatMemory && c.chatId === chatId)
    )

  const render = (sessionId: string): MemoryPreview => {
    const chat = chatOf(sessionId)
    const cfg = memoryConfigOf(chat?.config)
    const cols = chat ? activeCols(cfg, chat.id) : []
    const active = !!chat && cfg.enabled && (cols.length > 0 || cfg.chatMemory)
    if (!active) return { active: false, index: null, help: null, tools: [], snapshotAt: null }
    const superseded = new Set(
      memories
        .filter((m) => m.supersedesId && cols.some((c) => c.id === m.collectionId))
        .map((m) => m.supersedesId!)
    )
    const lines: string[] = [
      '<memory>',
      'Memória persistente do usuário (índice congelado nesta sessão). Use memory_search/memory_read para os detalhes.'
    ]
    for (const cat of MEMORY_CATEGORIES) {
      const inCat = cols.filter((c) => c.category === cat)
      if (!inCat.length) continue
      lines.push('', `## ${MEMORY_CATEGORY_LABELS[cat]}`)
      for (const c of inCat) {
        const write = c.scope === 'chat' || cfg.writeTo[cat] === c.id
        const name = c.scope === 'chat' ? 'Este chat (memória do chat)' : c.name
        lines.push(
          `### ${name} [${write ? 'escrita' : 'leitura'}]${c.description ? ` — ${c.description}` : ''}`
        )
        const list = memories.filter((m) => m.collectionId === c.id && !superseded.has(m.id))
        if (!list.length) lines.push('(vazia)')
        for (const m of list) {
          lines.push(`- ${m.id} · ${cat} · ${m.title} — ${m.summary}`)
          if (m.pinned) for (const f of m.facts) lines.push(`    • ${f}`)
        }
      }
    }
    lines.push('</memory>')
    const writes = MEMORY_CATEGORIES.some((c) => cfg.writeTo[c]) || cfg.chatMemory
    return {
      active: true,
      index: lines.join('\n'),
      help: cfg.helpPrompt.enabled ? (cfg.helpPrompt.text ?? DEFAULT_MEMORY_HELP_PROMPT) : null,
      tools: writes
        ? ['memory_search', 'memory_read', 'memory_write', 'memory_rewrite', 'memory_delete']
        : ['memory_search', 'memory_read'],
      snapshotAt: snapshots.get(sessionId) ?? null
    }
  }

  return {
    listCollections: () => delay(counted()),
    createCollection: async (input) => {
      if (!input.name.trim()) throw new Error('Nome obrigatório')
      const c: MemoryCollection = {
        id: nid('col-'),
        category: input.category,
        name: input.name.trim(),
        description: input.description ?? '',
        icon: input.icon ?? null,
        scope: 'shared',
        chatId: null,
        createdAt: Date.now(),
        updatedAt: Date.now()
      }
      collections.push(c)
      changed(c.id, null)
      return delay({ ...c, count: 0 })
    },
    updateCollection: async (id, patch) => {
      const c = collections.find((x) => x.id === id)
      if (!c) throw new Error('Coleção não encontrada')
      if (patch.name !== undefined) c.name = patch.name.trim() || c.name
      if (patch.description !== undefined) c.description = patch.description
      if (patch.icon !== undefined) c.icon = patch.icon
      c.updatedAt = Date.now()
      changed(id, null)
      return delay({ ...c, count: memories.filter((m) => m.collectionId === id).length })
    },
    deleteCollection: async (id) => {
      const i = collections.findIndex((x) => x.id === id)
      if (i < 0) return
      collections.splice(i, 1)
      for (let k = memories.length - 1; k >= 0; k--)
        if (memories[k].collectionId === id) memories.splice(k, 1)
      changed(id, null)
      await delay(undefined)
    },
    list: (query) => {
      const terms = (query?.query ?? '')
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean)
      const out = memories
        .filter((m) => !query?.collectionId || m.collectionId === query.collectionId)
        .filter((m) => !query?.category || m.category === query.category)
        .filter(
          (m) =>
            !query?.chatId ||
            collections.some((c) => c.id === m.collectionId && c.chatId === query.chatId)
        )
        .filter((m) => {
          if (!terms.length) return true
          const hay = [m.title, m.summary, ...m.facts]
            .join('\n')
            .normalize('NFD')
            .replace(/[̀-ͯ]/g, '')
            .toLowerCase()
          return terms.every((t) => hay.includes(t))
        })
        .sort((a, b) => b.updatedAt - a.updatedAt)
      return delay(out)
    },
    create: async (input) => {
      const c = collections.find((x) => x.id === input.collectionId)
      if (!c) throw new Error('Coleção não encontrada')
      const m: Memory = {
        id: nid('m-'),
        collectionId: c.id,
        category: c.category,
        title: input.title.trim(),
        slug: slugify(input.title),
        summary: input.summary ?? '',
        facts: input.facts ?? [],
        pinned: !!input.pinned,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        updatedByChatId: null,
        updatedBy: 'user',
        supersedesId: null
      }
      check(m)
      memories.push(m)
      changed(c.id, m.id)
      return delay(m)
    },
    update: async (id, patch) => {
      const m = memories.find((x) => x.id === id)
      if (!m) throw new Error('Memória não encontrada')
      const next = { ...m, ...patch }
      if (patch.collectionId && patch.collectionId !== m.collectionId) {
        const c = collections.find((x) => x.id === patch.collectionId)
        if (!c) throw new Error('Coleção não encontrada')
        if (c.category !== m.category) throw new Error('Só é possível mover para a mesma categoria')
      }
      check(next)
      Object.assign(m, next, {
        slug: patch.title ? slugify(patch.title) : m.slug,
        updatedAt: Date.now(),
        updatedBy: 'user',
        updatedByChatId: null
      })
      changed(m.collectionId, id)
      return delay({ ...m })
    },
    delete: async (id) => {
      const i = memories.findIndex((x) => x.id === id)
      if (i < 0) return
      const [m] = memories.splice(i, 1)
      changed(m.collectionId, id)
      await delay(undefined)
    },
    preview: (sessionId) => delay(render(sessionId)),
    refreshSnapshot: async (sessionId) => {
      snapshots.set(sessionId, Date.now())
      return delay(render(sessionId), 300)
    },
    extractNow: async (sessionId) => {
      const chat = chatOf(sessionId)
      const p = render(sessionId)
      await delay(undefined, 1400)
      if (!chat || !p.active) throw new Error('A memória não está ativa neste chat.')
      const cfg = memoryConfigOf(chat.config)
      const target =
        (cfg.writeTo.areas && collections.find((c) => c.id === cfg.writeTo.areas)) ||
        collections.find(
          (c) => c.scope === 'chat' && c.chatId === chat.id && c.category === 'areas'
        )
      const changes: MemoryExtractionResult['changes'] = []
      if (target) {
        const m: Memory = {
          id: nid('m-'),
          collectionId: target.id,
          category: 'areas',
          title: 'Benchmarks do capítulo 3',
          slug: 'benchmarks-do-capitulo-3',
          summary: 'Rodar benchmarks com 10k operações antes da reunião',
          facts: ['Comparar RGA e Logoot', 'Gerar gráficos com o script de bench/'],
          pinned: false,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          updatedByChatId: chat.id,
          updatedBy: 'extraction',
          supersedesId: null
        }
        memories.push(m)
        changes.push({ op: 'create', memoryId: m.id, title: m.title, collectionId: target.id })
      }
      const orient = memories.find((m) => m.id === 'm-orientacao')
      if (orient && cfg.collections.includes(orient.collectionId)) {
        orient.facts = [
          ...orient.facts,
          'Pediu para incluir a seção de trabalhos relacionados'
        ].slice(0, 15)
        orient.updatedAt = Date.now()
        orient.updatedBy = 'extraction'
        orient.updatedByChatId = chat.id
        changes.push({
          op: 'update',
          memoryId: orient.id,
          title: orient.title,
          collectionId: orient.collectionId
        })
      }
      if (!changes.length) {
        await delay(undefined)
        return {
          created: 0,
          updated: 0,
          deleted: 0,
          changes: [],
          error: 'Nada novo na conversa desde a última extração.'
        }
      }
      const result: MemoryExtractionResult = {
        created: changes.filter((c) => c.op === 'create').length,
        updated: changes.filter((c) => c.op === 'update').length,
        deleted: 0,
        changes
      }
      const model = cfg.extraction.model ?? chat.config.model
      const card = deps.msg(
        sessionId,
        { role: 'assistant', content: `Extração de memórias: ${extractionCountsShort(result)}.` },
        {
          synthetic: true,
          kind: 'memory-extraction',
          memoryExtraction: {
            ...result,
            model,
            providerId: cfg.extraction.providerId ?? chat.config.providerId,
            usage: { promptTokens: 6240, completionTokens: 188, cachedTokens: 5100, cost: 0.0021 },
            request: extractionRequest(model, cfg, p.index),
            trigger: 'manual'
          }
        } as unknown as StoredMessage['meta'],
        Date.now()
      )
      deps.messages.push(card)
      emit({ type: 'message-added', message: card })
      for (const c of changes) changed(c.collectionId, c.memoryId)
      return delay(result)
    }
  }
}

/** Body plausível de uma request de extração (para o (i) do card). */
export function extractionRequest(model: string, cfg: MemoryConfig, index: string | null): unknown {
  return {
    model,
    messages: [
      { role: 'system', content: cfg.extraction.prompt ?? DEFAULT_MEMORY_EXTRACTION_PROMPT },
      {
        role: 'user',
        content: `<conversation>\n[user] Me ajuda a organizar o capítulo 3?\n[assistant] …\n</conversation>\n\n${index ?? ''}`
      }
    ],
    tools: [
      { type: 'function', function: { name: 'memory_write' } },
      { type: 'function', function: { name: 'memory_delete' } }
    ],
    stream: false
  }
}

const extractionCountsShort = (r: MemoryExtractionResult): string =>
  [
    r.created && `${r.created} ${r.created === 1 ? 'criada' : 'criadas'}`,
    r.updated && `${r.updated} ${r.updated === 1 ? 'atualizada' : 'atualizadas'}`,
    r.deleted && `${r.deleted} ${r.deleted === 1 ? 'apagada' : 'apagadas'}`
  ]
    .filter(Boolean)
    .join(', ') || 'nada novo'
