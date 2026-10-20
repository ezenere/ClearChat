// Ramificação da conversa (árvore de mensagens) — funções PURAS, sem dependências (nem de
// types.ts): usadas pelo main (repo/runner), pelo renderer e portadas 1:1 pelo site
// (ClearChatWebsite/frontend/src/data/branches.ts). Ver docs/SYNC_PROTOCOL.md (§4.3.7/§4.3.8) e
// SPEC.md → "Banco"/"Tipos".
//
// Modelo:
// - Cada mensagem aponta para a anterior do mesmo ramo (`parentId`); `null` = raiz da sessão;
//   AUSENTE (registro/linha antiga) ou INVÁLIDO (pai inexistente na sessão ou com seq ≥ o dela)
//   → a mensagem anterior por seq (o histórico linear de antes).
// - Invariante: seq(pai) < seq(filho) → `seq` continua sendo uma ordem topológica (todo caminho
//   é crescente em seq; `#seq` segue estável para read_history). Ordem da sessão: seq, depois id.
// - Seleção ativa (`branchSel`, no registro da sessão): { [parentId | "root"]: childId | null }.
//   Em cada nó vale `branchSel[chave]` se nomeia um filho existente; senão o filho MAIS NOVO (maior
//   seq). `null` = o caminho termina ali (ramo novo ainda vazio — transitório, usado pelo
//   regenerate). Chat linear = mapa vazio.

/** O mínimo que as funções precisam de uma mensagem (StoredMessage satisfaz). */
export interface TreeMessage {
  id: string
  seq: number
  /** Pai no mesmo ramo; `null` = raiz; ausente = legado (→ anterior por seq). */
  parentId?: string | null
}

/** Seleção ativa: chave = id do pai (ou ROOT_KEY) → filho escolhido (`null` = o caminho para ali). */
export type BranchSel = Record<string, string | null>

/** Chave da seleção para os filhos da raiz (mensagens sem pai). */
export const ROOT_KEY = 'root'

export interface MessageTree<T extends TreeMessage> {
  /** Mensagens em ordem de seq (desempate por id). */
  ordered: T[]
  byId: Map<string, T>
  /** Pai EFETIVO de cada mensagem (já resolvido; `null` = raiz). */
  parentOf: Map<string, string | null>
  /** Filhos por chave (id do pai ou ROOT_KEY), em ordem crescente de seq. */
  children: Map<string, T[]>
}

export interface SiblingInfo {
  /** Posição (0-based) entre os irmãos, em ordem de seq. */
  index: number
  count: number
  prevId: string | null
  nextId: string | null
}

const bySeq = (a: TreeMessage, b: TreeMessage): number =>
  a.seq - b.seq || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k)

/**
 * Pai efetivo de `msg` (algoritmo normativo — SYNC_PROTOCOL.md §4.3.8): `parentId` null → raiz;
 * id de uma mensagem da sessão (`byId`) com seq MENOR → ele. Senão (ausente = legado, pai que ainda
 * não chegou/apagado/de outra sessão, ou que quebra a invariante) → `prev`: a mensagem com o maior
 * seq menor que o de `msg` (empate: maior id), ou raiz. Só leitura: nada é regravado.
 */
export function resolveParent(
  msg: TreeMessage,
  byId: ReadonlyMap<string, TreeMessage>,
  prev: TreeMessage | null
): string | null {
  const p = msg.parentId
  if (p === null) return null
  if (typeof p === 'string') {
    const pm = byId.get(p)
    if (pm && pm.seq < msg.seq) return p
  }
  return prev ? prev.id : null
}

/** Monta a árvore (pais resolvidos + filhos por chave) a partir das mensagens de UMA sessão. */
export function buildTree<T extends TreeMessage>(msgs: readonly T[]): MessageTree<T> {
  const ordered = [...msgs].sort(bySeq)
  const byId = new Map<string, T>()
  for (const m of ordered) byId.set(m.id, m)
  const parentOf = new Map<string, string | null>()
  const children = new Map<string, T[]>()
  // `prev` = última mensagem (na ordem da sessão) com seq estritamente menor que o da atual
  let prev: T | null = null
  let i = 0
  for (const m of ordered) {
    while (i < ordered.length && ordered[i].seq < m.seq) prev = ordered[i++]
    const p = resolveParent(m, byId, prev)
    parentOf.set(m.id, p)
    const k = p ?? ROOT_KEY
    const list = children.get(k)
    if (list) list.push(m)
    else children.set(k, [m])
  }
  return { ordered, byId, parentOf, children }
}

type Source<T extends TreeMessage> = readonly T[] | MessageTree<T>

const asTree = <T extends TreeMessage>(src: Source<T>): MessageTree<T> =>
  Array.isArray(src) ? buildTree(src as readonly T[]) : (src as MessageTree<T>)

/** Chave da seleção para os filhos de `parentId` (`null` → ROOT_KEY). */
export const selKey = (parentId: string | null): string => parentId ?? ROOT_KEY

/** Pais efetivos (id → pai resolvido) de todas as mensagens. */
export function resolveParents<T extends TreeMessage>(src: Source<T>): Map<string, string | null> {
  return asTree(src).parentOf
}

/** Caminho ativo (da raiz à folha), em ordem. Ver as regras no topo do arquivo. */
export function activePath<T extends TreeMessage>(src: Source<T>, sel?: BranchSel | null): T[] {
  const t = asTree(src)
  const s = sel ?? {}
  const out: T[] = []
  let key = ROOT_KEY
  for (;;) {
    const kids = t.children.get(key)
    if (!kids?.length) break
    let next: T | undefined
    if (has(s, key)) {
      const v = s[key]
      if (v === null) break
      next = kids.find((k) => k.id === v)
    }
    next ??= kids[kids.length - 1]
    out.push(next)
    key = next.id
  }
  return out
}

/** Última mensagem do caminho ativo (onde um append entra), ou null (sessão vazia / raiz vazia). */
export function activeLeaf<T extends TreeMessage>(
  src: Source<T>,
  sel?: BranchSel | null
): T | null {
  const p = activePath(src, sel)
  return p.length ? p[p.length - 1] : null
}

/** Posição de `msgId` entre os irmãos (filhos do mesmo pai); null = mensagem inexistente. */
export function siblings<T extends TreeMessage>(src: Source<T>, msgId: string): SiblingInfo | null {
  const t = asTree(src)
  if (!t.byId.has(msgId)) return null
  const kids = t.children.get(selKey(t.parentOf.get(msgId) ?? null)) ?? []
  const index = kids.findIndex((k) => k.id === msgId)
  return {
    index,
    count: kids.length,
    prevId: index > 0 ? kids[index - 1].id : null,
    nextId: index >= 0 && index < kids.length - 1 ? kids[index + 1].id : null
  }
}

/** Para a UI (‹ i/n ›): info dos irmãos de cada mensagem do caminho que tem MAIS de uma versão. */
export function pathSiblings<T extends TreeMessage>(
  src: Source<T>,
  path: readonly T[]
): Map<string, SiblingInfo> {
  const t = asTree(src)
  const out = new Map<string, SiblingInfo>()
  for (const m of path) {
    const s = siblings(t, m.id)
    if (s && s.count > 1) out.set(m.id, s)
  }
  return out
}

/**
 * Seleção mínima para o caminho ativo passar por `msgId`: em cada ancestral, apaga a chave se o
 * filho desejado já é o mais novo (o padrão) ou grava-o. O resto do mapa fica (lembra a escolha
 * em outras subárvores); abaixo de `msgId` vale o que já estava. Mensagem inexistente → cópia igual.
 */
export function selectionToReach<T extends TreeMessage>(
  src: Source<T>,
  sel: BranchSel | null | undefined,
  msgId: string
): BranchSel {
  const t = asTree(src)
  const out: BranchSel = { ...(sel ?? {}) }
  if (!t.byId.has(msgId)) return out
  let child = msgId
  for (;;) {
    const parent = t.parentOf.get(child) ?? null
    const key = selKey(parent)
    const kids = t.children.get(key) ?? []
    if (kids.length && kids[kids.length - 1].id === child) delete out[key]
    else out[key] = child
    if (parent === null) break
    child = parent
  }
  return out
}

/**
 * Limpa a seleção: tira chaves de mensagens que não existem mais, escolhas que não são filhos da
 * chave, escolhas redundantes (= o filho mais novo, que já é o padrão) e `null` em nó sem filhos
 * (o caminho já termina ali). Não muda o caminho ativo.
 */
export function pruneSel<T extends TreeMessage>(
  src: Source<T>,
  sel: BranchSel | null | undefined
): BranchSel {
  const t = asTree(src)
  const out: BranchSel = {}
  for (const [k, v] of Object.entries(sel ?? {})) {
    if (k !== ROOT_KEY && !t.byId.has(k)) continue
    const kids = t.children.get(k) ?? []
    if (!kids.length) continue
    if (v === null) out[k] = null
    else if (
      typeof v === 'string' &&
      kids.some((c) => c.id === v) &&
      kids[kids.length - 1].id !== v
    )
      out[k] = v
  }
  return out
}

/** Mesmas entradas (ordem das chaves não importa). */
export function selEquals(
  a: BranchSel | null | undefined,
  b: BranchSel | null | undefined
): boolean {
  const x = a ?? {}
  const y = b ?? {}
  const kx = Object.keys(x)
  if (kx.length !== Object.keys(y).length) return false
  return kx.every((k) => has(y, k) && y[k] === x[k])
}

/** Normaliza um valor lido (JSON) para BranchSel: só valores string ou null. */
export function toBranchSel(v: unknown): BranchSel {
  const out: BranchSel = {}
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out
  for (const [k, x] of Object.entries(v as Record<string, unknown>))
    if (typeof x === 'string' || x === null) out[k] = x
  return out
}

// ---------------- turnos ----------------

/** O mínimo de uma mensagem para as regras de turno (StoredMessage satisfaz). */
export interface TurnMessage extends TreeMessage {
  message: { role: string }
  meta: { kind?: string; synthetic?: boolean }
}

/** Kinds só de exibição (= DISPLAY_ONLY_KINDS de shared/context.ts; repetido para ficar sem deps). */
const DISPLAY_ONLY = ['error', 'memory-extraction']

/**
 * Mensagem que ABRE um turno ("prompt"): role user, não é fronteira de compactação, não é o
 * resultado sintético de tools em modo texto (`synthetic` sem kind) e não é só de exibição. Cobre
 * as digitadas, 'queued', 'forced', 'inter-chat', 'subagent-callback', 'parent-message' e as de
 * subagentes irmãos ('sibling-message' / 'sibling-broadcast').
 */
export function isPromptMessage(m: TurnMessage): boolean {
  if (m.message.role !== 'user') return false
  const kind = m.meta?.kind
  if (kind === 'compaction') return false
  if (m.meta?.synthetic && !kind) return false
  if (kind && DISPLAY_ONLY.includes(kind)) return false
  return true
}

/**
 * Edição que vira RAMO (nova versão) em vez de sobrescrever: mensagem do usuário digitada (não
 * sintética; sem kind, 'queued' ou 'forced') na sessão principal (`depth` 0). O resto (assistant,
 * sintéticas, entre chats, fronteiras, subsessões) segue com edição no lugar.
 */
export function isBranchEditable(m: TurnMessage, sessionDepth: number): boolean {
  if (sessionDepth !== 0 || m.message.role !== 'user' || m.meta?.synthetic) return false
  const kind = m.meta?.kind
  return !kind || kind === 'queued' || kind === 'forced'
}

/**
 * Prompt do turno que contém `msgId` no caminho (a própria mensagem, se for um prompt; senão o
 * prompt anterior mais próximo). null = fora do caminho ou antes de qualquer prompt.
 */
export function turnAnchor<T extends TurnMessage>(path: readonly T[], msgId: string): T | null {
  const i = path.findIndex((m) => m.id === msgId)
  if (i < 0) return null
  for (let j = i; j >= 0; j--) if (isPromptMessage(path[j])) return path[j]
  return null
}

/** Resposta do turno: o que vem depois do prompt `promptId` no caminho, até o próximo prompt. */
export function turnResponse<T extends TurnMessage>(path: readonly T[], promptId: string): T[] {
  const i = path.findIndex((m) => m.id === promptId)
  if (i < 0) return []
  const out: T[] = []
  for (let j = i + 1; j < path.length && !isPromptMessage(path[j]); j++) out.push(path[j])
  return out
}

/** Prompt do último turno do caminho (null = nenhum). */
export function lastTurnAnchor<T extends TurnMessage>(path: readonly T[]): T | null {
  for (let j = path.length - 1; j >= 0; j--) if (isPromptMessage(path[j])) return path[j]
  return null
}
