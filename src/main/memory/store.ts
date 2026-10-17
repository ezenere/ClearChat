// Memória modular — repositório sobre o SQLite (síncrono, better-sqlite3). Sem Electron: recebe a
// conexão e um callback de mudança (o app emite 'memory-changed'; os testes usam banco temporário).
// Ver SPEC.md → "Memória".
import { randomBytes, randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import { MEMORY_LIMITS as ML } from '@shared/limits'
import {
  isMemoryCategory,
  MEMORY_CATEGORIES,
  MEMORY_CATEGORY_LABELS,
  type Memory,
  type MemoryCategory,
  type MemoryCollection,
  type MemoryCollectionInput,
  type MemoryCollectionPatch,
  type MemoryCollectionScope,
  type MemoryInput,
  type MemoryListQuery,
  type MemoryPatch,
  type MemoryUpdatedBy
} from '@shared/memory'
import { isMemoryFtsReady } from './schema'

/** Erro de validação/regra com mensagem legível (vira o resultado da tool / erro do IPC). */
export class MemoryError extends Error {}

/** Nome da coleção de memória de um chat (uma por categoria, criada sob demanda). */
export const CHAT_COLLECTION_NAME = 'Este chat'

export interface ChangeBy {
  updatedBy: MemoryUpdatedBy
  chatId?: string | null
}

// ---------------- texto ----------------

/** Minúsculas sem acentos (mesma regra do tokenizer do FTS). */
export const normText = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()

export const words = (s: string): string[] => normText(s).match(/[\p{L}\p{N}]+/gu) ?? []

const STOPWORDS = new Set(
  'a o as os e de da do das dos em no na nos nas um uma uns umas para pra por com sem que se the of and or to in on for meu minha meus minhas seu sua'.split(
    ' '
  )
)

/** Palavras que contam para semelhança de títulos (sem stopwords; números e nomes curtos valem). */
export const significantWords = (s: string): string[] => [
  ...new Set(words(s).filter((w) => !STOPWORDS.has(w)))
]

/** "Projeto TCC (2026)" → "projeto-tcc-2026". */
export function slugify(title: string): string {
  return words(title).join('-').slice(0, 60).replace(/-+$/, '')
}

const oneLine = (s: unknown): string => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '')

const cut = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/**
 * Valida e normaliza título/resumo/tópicos (espaços colapsados; tópicos vazios/duplicados
 * removidos). Limites: MEMORY_LIMITS — erro legível com o tamanho.
 */
export function validateMemoryFields(f: { title: unknown; summary?: unknown; facts?: unknown }): {
  title: string
  summary: string
  facts: string[]
} {
  const title = oneLine(f.title)
  if (!title) throw new MemoryError('O título da memória é obrigatório.')
  if (title.length > ML.titleChars)
    throw new MemoryError(
      `Título longo demais (${title.length}/${ML.titleChars} caracteres): "${cut(title, 40)}". Encurte.`
    )
  const summary = oneLine(f.summary)
  if (summary.length > ML.summaryChars)
    throw new MemoryError(
      `Resumo longo demais (${summary.length}/${ML.summaryChars} caracteres). Use uma frase curta; detalhes vão nos tópicos.`
    )
  const raw = Array.isArray(f.facts) ? f.facts : f.facts == null ? [] : [f.facts]
  const facts: string[] = []
  const seen = new Set<string>()
  for (const x of raw) {
    const t = oneLine(x)
    if (!t) continue
    const k = normText(t)
    if (seen.has(k)) continue
    seen.add(k)
    if (t.length > ML.factChars)
      throw new MemoryError(
        `Tópico longo demais (${t.length}/${ML.factChars} caracteres): "${cut(t, 60)}". Divida em tópicos curtos.`
      )
    facts.push(t)
  }
  if (facts.length > ML.maxFacts)
    throw new MemoryError(
      `Tópicos demais (${facts.length}/${ML.maxFacts}). Junte, remova os obsoletos ou divida o assunto em outra memória.`
    )
  return { title, summary, facts }
}

function validateCollection(
  name: unknown,
  description: unknown
): { name: string; description: string } {
  const n = oneLine(name)
  if (!n) throw new MemoryError('O nome da coleção é obrigatório.')
  if (n.length > ML.collectionNameChars)
    throw new MemoryError(`Nome longo demais (${n.length}/${ML.collectionNameChars} caracteres).`)
  const d = typeof description === 'string' ? description.trim() : ''
  if (d.length > ML.collectionDescriptionChars)
    throw new MemoryError(
      `Descrição longa demais (${d.length}/${ML.collectionDescriptionChars} caracteres).`
    )
  return { name: n, description: d }
}

/** Expressão FTS5: cada palavra como prefixo entre aspas, unidas por OR (null = nada a buscar). */
export function ftsQuery(text: string, column?: string): string | null {
  const ws = [...new Set(words(text))].slice(0, 16)
  if (!ws.length) return null
  const expr = ws.map((w) => `"${w}"*`).join(' OR ')
  return column ? `${column} : (${expr})` : expr
}

// ---------------- linhas ----------------

interface CollectionRow {
  id: string
  category: string
  name: string
  description: string
  icon: string | null
  scope: string
  chat_id: string | null
  created_at: number
  updated_at: number
  count?: number
}

interface MemoryRow {
  id: string
  collection_id: string
  category: string
  title: string
  slug: string
  summary: string
  facts_json: string
  pinned: number
  created_at: number
  updated_at: number
  updated_by_chat_id: string | null
  updated_by: string
  supersedes_id: string | null
}

const toCollection = (r: CollectionRow): MemoryCollection => ({
  id: r.id,
  name: r.name,
  description: r.description,
  icon: r.icon ?? null,
  category: (isMemoryCategory(r.category) ? r.category : 'topics') as MemoryCategory,
  scope: (r.scope === 'chat' ? 'chat' : 'shared') as MemoryCollectionScope,
  chatId: r.chat_id ?? null,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  ...(typeof r.count === 'number' ? { count: r.count } : {})
})

function parseFacts(s: string): string[] {
  try {
    const v = JSON.parse(s)
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

const toMemory = (r: MemoryRow): Memory => ({
  id: r.id,
  collectionId: r.collection_id,
  category: (isMemoryCategory(r.category) ? r.category : 'topics') as MemoryCategory,
  title: r.title,
  slug: r.slug,
  summary: r.summary,
  facts: parseFacts(r.facts_json),
  pinned: !!r.pinned,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  updatedByChatId: r.updated_by_chat_id ?? null,
  updatedBy: (['model', 'extraction', 'user'].includes(r.updated_by)
    ? r.updated_by
    : 'user') as MemoryUpdatedBy,
  supersedesId: r.supersedes_id ?? null
})

const placeholders = (n: number): string => Array(n).fill('?').join(', ')

const CATEGORY_ORDER = `CASE category ${MEMORY_CATEGORIES.map((c, i) => `WHEN '${c}' THEN ${i}`).join(' ')} ELSE 9 END`

export interface SearchHit {
  memory: Memory
  /** Trecho com a ocorrência (tópico ou resumo). */
  snippet: string
}

export interface MemoryStoreOptions {
  /** Depois de cada mudança (o app emite 'memory-changed'). */
  onChange?: (collectionId: string | null, memoryId: string | null) => void
  now?: () => number
}

export class MemoryStore {
  readonly conn: Database.Database
  private readonly opts: MemoryStoreOptions

  constructor(conn: Database.Database, opts: MemoryStoreOptions = {}) {
    this.conn = conn
    this.opts = opts
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now()
  }

  private changed(collectionId: string | null, memoryId: string | null): void {
    try {
      this.opts.onChange?.(collectionId, memoryId)
    } catch {
      /* ignora */
    }
  }

  // ---------------- coleções ----------------

  /** Todas as coleções (inclusive as de chat), com a contagem de memórias. */
  listCollections(): MemoryCollection[] {
    const rows = this.conn
      .prepare(
        `SELECT c.*, (SELECT COUNT(*) FROM memories m WHERE m.collection_id = c.id) AS count
         FROM memory_collections c
         ORDER BY ${CATEGORY_ORDER}, CASE scope WHEN 'shared' THEN 0 ELSE 1 END, created_at, rowid`
      )
      .all() as CollectionRow[]
    return rows.map(toCollection)
  }

  getCollection(id: string): MemoryCollection | null {
    const r = this.conn.prepare('SELECT * FROM memory_collections WHERE id = ?').get(id) as
      CollectionRow | undefined
    return r ? toCollection(r) : null
  }

  getCollections(ids: string[]): MemoryCollection[] {
    if (!ids.length) return []
    const rows = this.conn
      .prepare(`SELECT * FROM memory_collections WHERE id IN (${placeholders(ids.length)})`)
      .all(...ids) as CollectionRow[]
    const byId = new Map(rows.map((r) => [r.id, toCollection(r)]))
    return ids.map((id) => byId.get(id)).filter((c): c is MemoryCollection => !!c)
  }

  createCollection(
    input: MemoryCollectionInput,
    opts: { scope?: MemoryCollectionScope; chatId?: string | null } = {}
  ): MemoryCollection {
    if (!input || !isMemoryCategory(input.category))
      throw new MemoryError(
        `Categoria inválida: ${String(input?.category)} (use ${MEMORY_CATEGORIES.join(', ')}).`
      )
    const { name, description } = validateCollection(input.name, input.description)
    const scope: MemoryCollectionScope = opts.scope === 'chat' ? 'chat' : 'shared'
    if (scope === 'chat' && !opts.chatId) throw new MemoryError('Coleção de chat sem chat.')
    const now = this.now()
    const c: MemoryCollection = {
      id: randomUUID(),
      name,
      description,
      icon: typeof input.icon === 'string' && input.icon.trim() ? input.icon.trim() : null,
      category: input.category,
      scope,
      chatId: scope === 'chat' ? (opts.chatId ?? null) : null,
      createdAt: now,
      updatedAt: now
    }
    this.conn
      .prepare(
        'INSERT INTO memory_collections (id, category, name, description, icon, scope, chat_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(c.id, c.category, c.name, c.description, c.icon, c.scope, c.chatId, now, now)
    this.changed(c.id, null)
    return { ...c, count: 0 }
  }

  updateCollection(id: string, patch: MemoryCollectionPatch): MemoryCollection {
    const cur = this.getCollection(id)
    if (!cur) throw new MemoryError(`Coleção não encontrada: ${id}`)
    if (patch && 'category' in patch && (patch as { category?: unknown }).category !== cur.category)
      throw new MemoryError('A categoria de uma coleção não muda depois de criada.')
    const { name, description } = validateCollection(
      patch?.name !== undefined ? patch.name : cur.name,
      patch?.description !== undefined ? patch.description : cur.description
    )
    const icon =
      patch?.icon !== undefined
        ? typeof patch.icon === 'string' && patch.icon.trim()
          ? patch.icon.trim()
          : null
        : cur.icon
    const now = this.now()
    this.conn
      .prepare(
        'UPDATE memory_collections SET name = ?, description = ?, icon = ?, updated_at = ? WHERE id = ?'
      )
      .run(name, description, icon, now, id)
    this.changed(id, null)
    return this.listCollections().find((c) => c.id === id)!
  }

  /** Apaga a coleção e TODAS as memórias dela (CASCADE; o FTS sai por trigger). */
  deleteCollection(id: string): void {
    const r = this.conn.prepare('DELETE FROM memory_collections WHERE id = ?').run(id)
    if (r.changes) this.changed(id, null)
  }

  /** Coleção de memória do chat para a categoria ("Este chat"); `create` = cria sob demanda. */
  chatCollection(
    chatId: string,
    category: MemoryCategory,
    create: boolean
  ): MemoryCollection | null {
    const r = this.conn
      .prepare(
        "SELECT * FROM memory_collections WHERE scope = 'chat' AND chat_id = ? AND category = ? ORDER BY created_at, rowid LIMIT 1"
      )
      .get(chatId, category) as CollectionRow | undefined
    if (r) return toCollection(r)
    if (!create) return null
    return this.createCollection(
      {
        category,
        name: CHAT_COLLECTION_NAME,
        description: `Memória própria deste chat (${MEMORY_CATEGORY_LABELS[category]}).`
      },
      { scope: 'chat', chatId }
    )
  }

  /** Coleções de memória de um chat (todas as categorias). */
  chatCollections(chatId: string): MemoryCollection[] {
    return (
      this.conn
        .prepare(
          `SELECT * FROM memory_collections WHERE scope = 'chat' AND chat_id = ? ORDER BY ${CATEGORY_ORDER}, created_at, rowid`
        )
        .all(chatId) as CollectionRow[]
    ).map(toCollection)
  }

  // ---------------- memórias ----------------

  getMemory(id: string): Memory | null {
    const r = this.conn.prepare('SELECT * FROM memories WHERE id = ?').get(id) as
      MemoryRow | undefined
    return r ? toMemory(r) : null
  }

  /** Por id ou slug (aceita `[[slug]]`). */
  findMemory(ref: string): Memory | null {
    const t = ref
      .trim()
      .replace(/^\[\[(.*)\]\]$/, '$1')
      .trim()
    if (!t) return null
    return (
      this.getMemory(t) ??
      ((r) => (r ? toMemory(r) : null))(
        this.conn.prepare('SELECT * FROM memories WHERE slug = ?').get(t) as MemoryRow | undefined
      )
    )
  }

  /** Memórias das coleções (fixadas primeiro, depois as mais recentes). */
  memoriesIn(collectionIds: string[]): Memory[] {
    if (!collectionIds.length) return []
    return (
      this.conn
        .prepare(
          `SELECT * FROM memories WHERE collection_id IN (${placeholders(collectionIds.length)}) ORDER BY pinned DESC, updated_at DESC, rowid DESC`
        )
        .all(...collectionIds) as MemoryRow[]
    ).map(toMemory)
  }

  /** Memórias que substituem (supersedes_id) alguma destas. */
  supersedersOf(ids: string[]): Memory[] {
    if (!ids.length) return []
    return (
      this.conn
        .prepare(`SELECT * FROM memories WHERE supersedes_id IN (${placeholders(ids.length)})`)
        .all(...ids) as MemoryRow[]
    ).map(toMemory)
  }

  /** IPC memory.list: filtros por coleção / chat (coleções de chat) / categoria / texto. */
  listMemories(q: MemoryListQuery = {}): Memory[] {
    let ids: string[] | null = null
    if (q.collectionId) ids = [q.collectionId]
    if (q.chatId) {
      const own = this.chatCollections(q.chatId).map((c) => c.id)
      ids = ids ? ids.filter((i) => own.includes(i)) : own
    }
    if (q.query?.trim()) {
      const scope = ids ?? this.listCollections().map((c) => c.id)
      return this.search(q.query, {
        collectionIds: scope,
        category: q.category,
        limit: 500
      }).map((h) => h.memory)
    }
    const where: string[] = []
    const args: unknown[] = []
    if (ids) {
      if (!ids.length) return []
      where.push(`collection_id IN (${placeholders(ids.length)})`)
      args.push(...ids)
    }
    if (q.category) {
      where.push('category = ?')
      args.push(q.category)
    }
    return (
      this.conn
        .prepare(
          `SELECT * FROM memories ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ${CATEGORY_ORDER}, pinned DESC, updated_at DESC, rowid DESC`
        )
        .all(...args) as MemoryRow[]
    ).map(toMemory)
  }

  private newMemoryId(): string {
    for (;;) {
      const id =
        'm' +
        [...randomBytes(7)].map((b) => '0123456789abcdefghijklmnopqrstuvwxyz'[b % 36]).join('')
      if (!this.conn.prepare('SELECT 1 FROM memories WHERE id = ?').get(id)) return id
    }
  }

  /** Slug único (global) a partir do título: base, base-2, base-3… */
  private uniqueSlug(title: string): string {
    const base = slugify(title) || 'memoria'
    const taken = new Set(
      (
        this.conn
          .prepare('SELECT slug FROM memories WHERE slug = ? OR slug LIKE ?')
          .all(base, `${base}-%`) as { slug: string }[]
      ).map((r) => r.slug)
    )
    if (!taken.has(base)) return base
    for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`
  }

  createMemory(
    input: MemoryInput & { supersedesId?: string | null },
    by: ChangeBy = { updatedBy: 'user' }
  ): Memory {
    const col = input?.collectionId ? this.getCollection(input.collectionId) : null
    if (!col) throw new MemoryError(`Coleção não encontrada: ${input?.collectionId ?? ''}`)
    const f = validateMemoryFields(input)
    const now = this.now()
    const m: Memory = {
      id: this.newMemoryId(),
      collectionId: col.id,
      category: col.category,
      title: f.title,
      slug: this.uniqueSlug(f.title),
      summary: f.summary,
      facts: f.facts,
      pinned: !!input.pinned,
      createdAt: now,
      updatedAt: now,
      updatedByChatId: by.chatId ?? null,
      updatedBy: by.updatedBy,
      supersedesId: input.supersedesId ?? null
    }
    this.conn
      .prepare(
        `INSERT INTO memories (id, collection_id, category, title, slug, summary, facts_json, pinned, created_at, updated_at, updated_by_chat_id, updated_by, supersedes_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        m.id,
        m.collectionId,
        m.category,
        m.title,
        m.slug,
        m.summary,
        JSON.stringify(m.facts),
        m.pinned ? 1 : 0,
        now,
        now,
        m.updatedByChatId,
        m.updatedBy,
        m.supersedesId
      )
    this.conn.prepare('UPDATE memory_collections SET updated_at = ? WHERE id = ?').run(now, col.id)
    this.changed(col.id, m.id)
    return m
  }

  /**
   * Atualiza campos (o slug não muda: links [[slug]] continuam valendo). `collectionId` move a
   * memória — só para outra coleção da MESMA categoria.
   */
  updateMemory(id: string, patch: MemoryPatch, by: ChangeBy = { updatedBy: 'user' }): Memory {
    const cur = this.getMemory(id)
    if (!cur) throw new MemoryError(`Memória não encontrada: ${id}`)
    let collectionId = cur.collectionId
    if (patch?.collectionId && patch.collectionId !== cur.collectionId) {
      const to = this.getCollection(patch.collectionId)
      if (!to) throw new MemoryError(`Coleção não encontrada: ${patch.collectionId}`)
      if (to.category !== cur.category)
        throw new MemoryError(
          `Só é possível mover para uma coleção da mesma categoria (${MEMORY_CATEGORY_LABELS[cur.category]}).`
        )
      collectionId = to.id
    }
    const f = validateMemoryFields({
      title: patch?.title !== undefined ? patch.title : cur.title,
      summary: patch?.summary !== undefined ? patch.summary : cur.summary,
      facts: patch?.facts !== undefined ? patch.facts : cur.facts
    })
    const pinned = patch?.pinned !== undefined ? !!patch.pinned : cur.pinned
    const now = this.now()
    this.conn
      .prepare(
        `UPDATE memories SET collection_id = ?, title = ?, summary = ?, facts_json = ?, pinned = ?, updated_at = ?,
         updated_by_chat_id = ?, updated_by = ? WHERE id = ?`
      )
      .run(
        collectionId,
        f.title,
        f.summary,
        JSON.stringify(f.facts),
        pinned ? 1 : 0,
        now,
        by.chatId ?? null,
        by.updatedBy,
        id
      )
    this.conn
      .prepare('UPDATE memory_collections SET updated_at = ? WHERE id IN (?, ?)')
      .run(now, collectionId, cur.collectionId)
    if (collectionId !== cur.collectionId) this.changed(cur.collectionId, id)
    this.changed(collectionId, id)
    return this.getMemory(id)!
  }

  deleteMemory(id: string): void {
    const cur = this.getMemory(id)
    if (!cur) return
    this.conn.prepare('DELETE FROM memories WHERE id = ?').run(id)
    this.changed(cur.collectionId, id)
  }

  // ---------------- busca ----------------

  /** Busca por texto (FTS5 com bm25: título > resumo > tópicos; sem FTS → LIKE). */
  search(
    query: string,
    opts: { collectionIds: string[]; category?: MemoryCategory; limit?: number }
  ): SearchHit[] {
    const ids = opts.collectionIds
    if (!ids.length) return []
    const limit = Math.max(1, Math.min(500, Math.floor(opts.limit ?? ML.searchDefaultResults)))
    const cat = opts.category && isMemoryCategory(opts.category) ? opts.category : null
    const ws = words(query)
    let rows: MemoryRow[]
    const expr = ftsQuery(query)
    if (!expr) return []
    if (isMemoryFtsReady(this.conn)) {
      rows = this.conn
        .prepare(
          `SELECT m.* FROM memories_fts f JOIN memories m ON m.id = f.memory_id
           WHERE memories_fts MATCH ? AND m.collection_id IN (${placeholders(ids.length)})
           ${cat ? 'AND m.category = ?' : ''}
           ORDER BY bm25(memories_fts, 5.0, 2.0, 1.0, 0.0), m.updated_at DESC LIMIT ?`
        )
        .all(expr, ...ids, ...(cat ? [cat] : []), limit) as MemoryRow[]
    } else {
      const all = this.memoriesIn(ids).filter((m) => !cat || m.category === cat)
      const scored = all
        .map((m) => {
          const t = normText(`${m.title} ${m.summary} ${m.facts.join(' ')}`)
          return { m, s: ws.filter((w) => t.includes(w)).length }
        })
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s || b.m.updatedAt - a.m.updatedAt)
        .slice(0, limit)
      return scored.map(({ m }) => ({ memory: m, snippet: snippetFor(m, ws) }))
    }
    return rows.map((r) => {
      const m = toMemory(r)
      return { memory: m, snippet: snippetFor(m, ws) }
    })
  }

  /**
   * Memórias parecidas na MESMA coleção (antes de criar): mesmo slug-base, ou títulos com as
   * mesmas palavras significativas (FTS no título + sobreposição ≥ 60% da menor lista).
   */
  similar(collectionId: string, title: string, excludeId?: string): Memory[] {
    const slug = slugify(title)
    const mine = significantWords(title)
    let cands: Memory[]
    const expr = mine.length ? ftsQuery(mine.join(' '), 'title') : null
    if (isMemoryFtsReady(this.conn) && expr) {
      const rows = this.conn
        .prepare(
          `SELECT m.* FROM memories_fts f JOIN memories m ON m.id = f.memory_id
           WHERE memories_fts MATCH ? AND m.collection_id = ? LIMIT 50`
        )
        .all(expr, collectionId) as MemoryRow[]
      cands = rows.map(toMemory)
      const bySlug = this.conn
        .prepare('SELECT * FROM memories WHERE collection_id = ? AND (slug = ? OR slug LIKE ?)')
        .all(collectionId, slug, `${slug}-%`) as MemoryRow[]
      for (const r of bySlug) if (!cands.some((c) => c.id === r.id)) cands.push(toMemory(r))
    } else cands = this.memoriesIn([collectionId])
    const out: Memory[] = []
    for (const c of cands) {
      if (c.id === excludeId) continue
      const cs = c.slug.replace(/-\d+$/, '')
      if (slug && (cs === slug || slugify(c.title) === slug)) {
        out.push(c)
        continue
      }
      const theirs = significantWords(c.title)
      if (!mine.length || !theirs.length) continue
      const inter = mine.filter((w) => theirs.includes(w)).length
      if (inter && inter / Math.min(mine.length, theirs.length) >= 0.6) out.push(c)
    }
    return out.slice(0, 5)
  }
}

/** Trecho: o 1º tópico (ou o resumo/título) que contém alguma das palavras buscadas. */
function snippetFor(m: Memory, ws: string[]): string {
  const has = (t: string): boolean => {
    const n = normText(t)
    return ws.some((w) => n.includes(w))
  }
  const hit = m.facts.find(has) ?? (has(m.summary) ? m.summary : '')
  return cut(hit || m.facts[0] || m.summary || '', 200)
}
