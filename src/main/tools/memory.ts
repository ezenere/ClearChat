// Tools da memória modular (memory_search / memory_read / memory_write / memory_rewrite /
// memory_delete). Sem Electron: recebem o repositório e a memória ativa da sessão (o runner e a
// extração resolvem). As mesmas regras valem para o agente e para a extração. Ver SPEC.md → "Memória".
import { MEMORY_LIMITS as ML } from '@shared/limits'
import {
  isMemoryCategory,
  MEMORY_CATEGORY_LABELS,
  type Memory,
  type MemoryCollection,
  type MemoryExtractionResult
} from '@shared/memory'
import type { ToolName } from '@shared/types'
import { isActiveCollection, isWritable, type ActiveMemory } from '../memory/config'
import {
  MemoryError,
  normText,
  validateMemoryFields,
  type ChangeBy,
  type MemoryStore
} from '../memory/store'

export type MemoryChange = MemoryExtractionResult['changes'][number]

export interface MemoryToolContext {
  store: MemoryStore
  /** Memória ativa da sessão no momento da chamada (activeMemory). */
  am: ActiveMemory
  /** Quem grava: 'model' (agente) ou 'extraction'; chatId de origem. */
  by: ChangeBy
}

export interface MemoryToolResult {
  content: string
  status: 'ok' | 'error'
  changes?: MemoryChange[]
}

const err = (content: string): MemoryToolResult => ({
  content: `Erro: ${content}`,
  status: 'error'
})

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

const UPDATED_BY: Record<Memory['updatedBy'], string> = {
  model: 'modelo',
  extraction: 'extração',
  user: 'usuário'
}

function fmtDate(ms: number): string {
  const d = new Date(ms)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function colLabel(am: ActiveMemory, c: MemoryCollection | null): string {
  if (!c) return '?'
  return `${c.name} (${isWritable(am, c) ? 'escrita' : 'leitura'})`
}

/** Memória em texto: cabeçalho + resumo + tópicos numerados. */
function fullText(am: ActiveMemory, store: MemoryStore, m: Memory): string {
  const col = store.getCollection(m.collectionId)
  const lines = [
    `## ${m.id} · ${m.title}`,
    `categoria: ${MEMORY_CATEGORY_LABELS[m.category]} (${m.category}) · coleção: ${colLabel(am, col)} · [[${m.slug}]]${m.pinned ? ' · fixada' : ''}`,
    `atualizada em ${fmtDate(m.updatedAt)} por ${UPDATED_BY[m.updatedBy]}`
  ]
  if (m.supersedesId) lines.push(`substitui: ${m.supersedesId}`)
  if (m.summary) lines.push(`resumo: ${m.summary}`)
  lines.push(m.facts.length ? 'tópicos:' : 'tópicos: (nenhum)')
  m.facts.forEach((f, i) => lines.push(`${i + 1}. ${f}`))
  return lines.join('\n')
}

// ---------------- ops ----------------

export interface FactOp {
  op: 'add' | 'remove' | 'replace'
  fact: string
  with?: string
}

export function parseOps(v: unknown): FactOp[] {
  if (v == null) return []
  if (!Array.isArray(v)) throw new MemoryError('"ops" deve ser uma lista de {op, fact, with?}.')
  return v.map((o, i) => {
    const x = (o && typeof o === 'object' ? o : {}) as Record<string, unknown>
    const op = str(x.op)
    if (op !== 'add' && op !== 'remove' && op !== 'replace')
      throw new MemoryError(`ops[${i}]: "op" deve ser add, remove ou replace.`)
    const fact = str(x.fact)
    if (!fact) throw new MemoryError(`ops[${i}]: "fact" vazio.`)
    const w = str(x.with)
    if (op === 'replace' && !w)
      throw new MemoryError(`ops[${i}]: replace exige "with" (texto novo).`)
    return { op, fact, ...(op === 'replace' ? { with: w } : {}) }
  })
}

function findFact(facts: string[], ref: string): number {
  const m = /^#\s*(\d+)$/.exec(ref)
  if (m) {
    const i = Number(m[1]) - 1
    if (i >= 0 && i < facts.length) return i
    throw new MemoryError(`Tópico ${ref} não existe (a memória tem ${facts.length}).`)
  }
  const n = normText(ref).replace(/\s+/g, ' ').trim()
  const exact = facts.findIndex((f) => normText(f).replace(/\s+/g, ' ').trim() === n)
  if (exact >= 0) return exact
  const partial = facts.map((f, i) => (normText(f).includes(n) ? i : -1)).filter((i) => i >= 0)
  if (partial.length === 1) return partial[0]
  const list = facts.map((f, i) => `${i + 1}. ${f}`).join('\n')
  if (partial.length > 1)
    throw new MemoryError(
      `"${ref}" casa com ${partial.length} tópicos — use "#n". Tópicos:\n${list}`
    )
  throw new MemoryError(
    `Tópico não encontrado: "${ref}". Tópicos atuais:\n${list || '(nenhum)'}\nUse o texto exato ou "#n".`
  )
}

/** Aplica as ops em ordem (cópia). */
export function applyOps(facts: string[], ops: FactOp[]): string[] {
  const out = [...facts]
  for (const o of ops) {
    if (o.op === 'add') out.push(o.fact)
    else {
      const i = findFact(out, o.fact)
      if (o.op === 'remove') out.splice(i, 1)
      else out[i] = o.with!
    }
  }
  return out
}

// ---------------- helpers ----------------

/** Memórias ativas desta sessão que substituem alguma destas (onde as duas estão ativas). */
function activeSuperseders(ctx: MemoryToolContext, ids: string[]): Map<string, Memory> {
  const out = new Map<string, Memory>()
  for (const s of ctx.store.supersedersOf(ids)) {
    const c = ctx.store.getCollection(s.collectionId)
    if (c && isActiveCollection(ctx.am, c) && s.supersedesId) out.set(s.supersedesId, s)
  }
  return out
}

function resolveCollectionRef(am: ActiveMemory, ref: string): MemoryCollection | string {
  const byId = am.collections.find((c) => c.id === ref)
  if (byId) return byId
  const n = normText(ref)
  const byName = am.collections.filter((c) => normText(c.name) === n)
  if (byName.length === 1) return byName[0]
  if (byName.length > 1)
    return `há ${byName.length} coleções ativas chamadas "${ref}" (${byName.map((c) => `${c.id} — ${MEMORY_CATEGORY_LABELS[c.category]}`).join('; ')}); use o id.`
  return `coleção "${ref}" não está ativa neste chat. Ativas: ${am.collections.map((c) => `${c.name} (${MEMORY_CATEGORY_LABELS[c.category]})`).join(', ') || '(nenhuma)'}.`
}

/** Coleção de destino de uma gravação nova (a de escrita da categoria) ou mensagem de erro. */
function writeCollection(
  am: ActiveMemory,
  category: Memory['category']
): MemoryCollection | string {
  const label = MEMORY_CATEGORY_LABELS[category]
  if (!am.categories.includes(category))
    return `a categoria ${label} (${category}) está desligada neste chat.`
  return (
    am.writeTo[category] ??
    `Sem coleção de escrita para ${label} (${category}) neste chat — o usuário escolhe nas configurações de memória do chat.`
  )
}

const change = (op: MemoryChange['op'], m: Memory): MemoryChange => ({
  op,
  memoryId: m.id,
  title: m.title,
  collectionId: m.collectionId
})

function brief(m: Memory): string {
  return [
    `${m.id} · ${m.title}${m.summary ? ` — ${m.summary}` : ''}`,
    ...m.facts.map((f, i) => `${i + 1}. ${f}`)
  ].join('\n')
}

// ---------------- tools ----------------

function memorySearch(args: Record<string, unknown>, ctx: MemoryToolContext): MemoryToolResult {
  const { am, store } = ctx
  const query = str(args.query)
  if (!query) return err('argumento obrigatório "query" ausente.')
  let ids = am.collections.map((c) => c.id)
  const cat = str(args.category)
  if (cat) {
    if (!isMemoryCategory(cat)) return err(`categoria inválida: ${cat}.`)
    if (!am.categories.includes(cat))
      return err(`a categoria ${MEMORY_CATEGORY_LABELS[cat]} está desligada neste chat.`)
  }
  const colRef = str(args.collection)
  if (colRef) {
    const c = resolveCollectionRef(am, colRef)
    if (typeof c === 'string') return err(c)
    ids = [c.id]
  }
  const limit = Math.max(
    1,
    Math.min(ML.searchMaxResults, Math.floor(Number(args.limit) || ML.searchDefaultResults))
  )
  const raw = store.search(query, {
    collectionIds: ids,
    category: cat && isMemoryCategory(cat) ? cat : undefined,
    limit: limit + 10
  })
  const sup = activeSuperseders(
    ctx,
    raw.map((h) => h.memory.id)
  )
  const hits = raw.filter((h) => !sup.has(h.memory.id)).slice(0, limit)
  if (!hits.length)
    return {
      content: `Nenhuma memória encontrada para "${query}" (${ids.length} coleç${ids.length === 1 ? 'ão ativa' : 'ões ativas'}).`,
      status: 'ok'
    }
  const cols = new Map(
    store.getCollections([...new Set(hits.map((h) => h.memory.collectionId))]).map((c) => [c.id, c])
  )
  const lines = [
    `[busca na memória: "${query}" · ${hits.length} resultado${hits.length > 1 ? 's' : ''}]`
  ]
  for (const h of hits) {
    const m = h.memory
    lines.push(
      `- ${m.id} · ${MEMORY_CATEGORY_LABELS[m.category]} · ${colLabel(am, cols.get(m.collectionId) ?? null)} · ${m.title}${m.summary ? ` — ${m.summary}` : ''}`
    )
    if (h.snippet && h.snippet !== m.summary) lines.push(`  trecho: ${h.snippet}`)
  }
  return { content: lines.join('\n'), status: 'ok' }
}

function memoryRead(args: Record<string, unknown>, ctx: MemoryToolContext): MemoryToolResult {
  const { am, store } = ctx
  const raw = Array.isArray(args.ids) ? args.ids : typeof args.ids === 'string' ? [args.ids] : []
  const ids = [...new Set(raw.map(str).filter(Boolean))]
  if (!ids.length) return err('argumento obrigatório "ids" ausente (lista de ids).')
  if (ids.length > ML.readMaxIds) return err(`no máximo ${ML.readMaxIds} ids por chamada.`)
  const parts: string[] = []
  const found: Memory[] = []
  for (const ref of ids) {
    const m = store.findMemory(ref)
    const col = m ? store.getCollection(m.collectionId) : null
    if (!m || !col) parts.push(`## ${ref}\n(não encontrada)`)
    else if (!isActiveCollection(am, col))
      parts.push(`## ${ref}\n(não está numa coleção ativa deste chat)`)
    else found.push(m)
  }
  const sup = activeSuperseders(
    ctx,
    found.map((m) => m.id)
  )
  for (const m of found) {
    const s = sup.get(m.id)
    parts.push(
      fullText(am, store, m) +
        (s ? `\n(substituída neste chat por ${s.id} — "${s.title}"; use essa)` : '')
    )
  }
  return { content: parts.join('\n\n'), status: 'ok' }
}

function memoryWrite(args: Record<string, unknown>, ctx: MemoryToolContext): MemoryToolResult {
  const { am, store, by } = ctx
  const ops = parseOps(args.ops)
  const id = str(args.id)
  const title = args.title !== undefined ? str(args.title) : undefined
  const summary = args.summary !== undefined ? str(args.summary) : undefined
  const cat = str(args.category)
  if (cat && !isMemoryCategory(cat)) return err(`categoria inválida: ${cat}.`)
  if (id) {
    const m = store.findMemory(id)
    const col = m ? store.getCollection(m.collectionId) : null
    if (!m || !col) return err(`memória não encontrada: ${id}.`)
    if (!isActiveCollection(am, col))
      return err(`a memória ${m.id} não está numa coleção ativa deste chat.`)
    if (cat && cat !== m.category)
      return err(
        `a memória ${m.id} é da categoria ${m.category}; a categoria não muda (crie outra memória na categoria certa e apague esta, se for o caso).`
      )
    if (!isWritable(am, col))
      return err(
        `a memória ${m.id} está na coleção "${col.name}", só de leitura neste chat — use memory_rewrite para criar uma versão corrigida na coleção de escrita.`
      )
    if (!ops.length && title === undefined && summary === undefined)
      return err('nada a alterar: informe title, summary e/ou ops.')
    const next = store.updateMemory(
      m.id,
      {
        ...(title !== undefined ? { title } : {}),
        ...(summary !== undefined ? { summary } : {}),
        ...(ops.length ? { facts: applyOps(m.facts, ops) } : {})
      },
      by
    )
    return {
      content: `Memória atualizada (coleção ${col.name}):\n${brief(next)}`,
      status: 'ok',
      changes: [change('update', next)]
    }
  }
  // criar
  if (!cat) return err('para criar uma memória informe "category" (ou "id" para atualizar).')
  if (!title) return err('para criar uma memória informe "title".')
  const bad = ops.find((o) => o.op !== 'add')
  if (bad) return err(`"${bad.op}" só vale para memórias existentes (informe "id").`)
  const facts = ops.map((o) => o.fact)
  validateMemoryFields({ title, summary, facts })
  const target = writeCollection(am, cat as Memory['category'])
  if (typeof target === 'string') return err(target)
  if (args.force_new !== true && args.force_new !== 'true') {
    const similar = store.similar(target.id, title)
    if (similar.length)
      return {
        content: [
          `Nada foi criado: já existe memória parecida na coleção "${target.name}". Se for o mesmo assunto, atualize com memory_write { id, ops } (corrija o que mudou); se for outro assunto, repita com force_new: true.`,
          ...similar.map((s) => brief(s))
        ].join('\n'),
        status: 'ok'
      }
  }
  const m = store.createMemory(
    { collectionId: target.id, title, summary: summary ?? '', facts },
    by
  )
  return {
    content: `Memória criada na coleção ${target.name}:\n${brief(m)}`,
    status: 'ok',
    changes: [change('create', m)]
  }
}

function memoryRewrite(args: Record<string, unknown>, ctx: MemoryToolContext): MemoryToolResult {
  const { am, store, by } = ctx
  const id = str(args.id)
  if (!id) return err('argumento obrigatório "id" ausente.')
  const src = store.findMemory(id)
  const srcCol = src ? store.getCollection(src.collectionId) : null
  if (!src || !srcCol) return err(`memória não encontrada: ${id}.`)
  if (!isActiveCollection(am, srcCol))
    return err(`a memória ${src.id} não está numa coleção ativa deste chat.`)
  const ops = parseOps(args.ops)
  const factsArg = args.facts
  if (factsArg !== undefined && !Array.isArray(factsArg))
    return err('"facts" deve ser uma lista de tópicos.')
  const title = args.title !== undefined ? str(args.title) : undefined
  const summary = args.summary !== undefined ? str(args.summary) : undefined
  const newFacts = (base: string[]): string[] =>
    factsArg !== undefined ? applyOps((factsArg as unknown[]).map(str), ops) : applyOps(base, ops)
  const patch = (base: Memory): { title?: string; summary?: string; facts: string[] } => ({
    ...(title ? { title } : {}),
    ...(summary !== undefined ? { summary } : {}),
    facts: newFacts(base.facts)
  })
  if (isWritable(am, srcCol)) {
    const next = store.updateMemory(src.id, patch(src), by)
    return {
      content: `A memória ${src.id} já é gravável (coleção ${srcCol.name}): atualizada no lugar.\n${brief(next)}`,
      status: 'ok',
      changes: [change('update', next)]
    }
  }
  const target = writeCollection(am, src.category)
  if (typeof target === 'string') return err(target)
  // já existe uma substituta nesta coleção de destino → atualiza ela
  const prev = store.supersedersOf([src.id]).find((m) => m.collectionId === target.id)
  if (prev) {
    const next = store.updateMemory(prev.id, patch(prev), by)
    return {
      content: `A memória ${src.id} já tinha uma versão em "${target.name}" (${prev.id}); atualizada:\n${brief(next)}`,
      status: 'ok',
      changes: [change('update', next)]
    }
  }
  const m = store.createMemory(
    {
      collectionId: target.id,
      title: title || src.title,
      summary: summary !== undefined ? summary : src.summary,
      facts: newFacts(src.facts),
      pinned: src.pinned,
      supersedesId: src.id
    },
    by
  )
  return {
    content: `Nova versão criada em "${target.name}" substituindo ${src.id} neste chat (a original continua em "${srcCol.name}"):\n${brief(m)}`,
    status: 'ok',
    changes: [change('create', m)]
  }
}

function memoryDelete(args: Record<string, unknown>, ctx: MemoryToolContext): MemoryToolResult {
  const { am, store } = ctx
  const id = str(args.id)
  if (!id) return err('argumento obrigatório "id" ausente.')
  const m = store.findMemory(id)
  const col = m ? store.getCollection(m.collectionId) : null
  if (!m || !col) return err(`memória não encontrada: ${id}.`)
  if (!isActiveCollection(am, col))
    return err(`a memória ${m.id} não está numa coleção ativa deste chat.`)
  if (!isWritable(am, col))
    return err(
      `a memória ${m.id} está na coleção "${col.name}", só de leitura neste chat — não pode ser apagada daqui.`
    )
  store.deleteMemory(m.id)
  return {
    content: `Memória apagada: ${m.id} · ${m.title} (coleção ${col.name}).`,
    status: 'ok',
    changes: [change('delete', m)]
  }
}

/** Executa uma tool de memória (erros de regra/limite → resultado 'error' legível; nunca lança). */
export function runMemoryTool(
  name: ToolName,
  args: Record<string, unknown>,
  ctx: MemoryToolContext
): MemoryToolResult {
  if (!ctx.am.active) return err('a memória não está ativa neste chat.')
  if (!ctx.am.tools.includes(name))
    return err(`a ferramenta ${name} não está disponível nesta sessão.`)
  try {
    switch (name) {
      case 'memory_search':
        return memorySearch(args, ctx)
      case 'memory_read':
        return memoryRead(args, ctx)
      case 'memory_write':
        return memoryWrite(args, ctx)
      case 'memory_rewrite':
        return memoryRewrite(args, ctx)
      case 'memory_delete':
        return memoryDelete(args, ctx)
      default:
        return err(`ferramenta desconhecida: ${name}.`)
    }
  } catch (e) {
    if (e instanceof MemoryError) return err(e.message)
    return err((e as Error)?.message || String(e))
  }
}
