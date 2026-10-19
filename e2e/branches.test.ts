/* eslint-disable @typescript-eslint/no-explicit-any */
// Ramificação da conversa — base (WP1). Parte A: funções puras de src/shared/branches.ts (caminho
// ativo, seleção, null, pai legado/órfão, irmãos, turnos) + o fixture compartilhado
// docs/test-vectors/branches.json (mesmo algoritmo no app e no site). Parte B: migração
// (ensureMessageTree) num banco temporário com o sync ligado — o preenchimento do parent_id NÃO
// marca nada em sync_dirty. Parte C: repositório real (db.ts/repo.ts com o módulo `electron`
// substituído por um stub): append no fim do caminho, versões, troca, null, delete re-ligando
// filhos e ajustando a seleção, insertAt da compactação, historyStore.
// Rodar: npm run test:unit
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { SCHEMA } from '../src/main/dbSchema.ts'
import { ensureMemorySchema } from '../src/main/memory/schema.ts'
import { ensureSyncSchema, setTracking } from '../src/main/sync/schema.ts'
import { ensureMessageTree, MESSAGE_TREE_FLAG } from '../src/main/migrateBranches.ts'
import {
  activeLeaf,
  activePath,
  buildTree,
  isBranchEditable,
  isPromptMessage,
  lastTurnAnchor,
  pathSiblings,
  pruneSel,
  resolveParents,
  selectionToReach,
  selEquals,
  siblings,
  toBranchSel,
  turnAnchor,
  turnResponse,
  type BranchSel,
  type TreeMessage
} from '../src/shared/branches.ts'

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TMP = mkdtempSync(join(process.env.CLEARCHAT_TEST_TMP || tmpdir(), 'clearchat-branches-'))
after(() => rmSync(TMP, { recursive: true, force: true }))

const ids = (ms: readonly { id: string }[]): string[] => ms.map((m) => m.id)
const n = (id: string, seq: number, parentId?: string | null): TreeMessage =>
  parentId === undefined ? { id, seq } : { id, seq, parentId }

// ---------------- parte A: funções puras ----------------

// u1 → a1 → { u2 → a2 , u2b → a2b }   (u2b = edição de u2, mais nova)
const EDITED = [
  n('u1', 1, null),
  n('a1', 2, 'u1'),
  n('u2', 3, 'a1'),
  n('a2', 4, 'u2'),
  n('u2b', 5, 'a1'),
  n('a2b', 6, 'u2b')
]

test('caminho: padrão = filho mais novo; seleção explícita; seleção velha cai no padrão', () => {
  assert.deepEqual(ids(activePath(EDITED, {})), ['u1', 'a1', 'u2b', 'a2b'])
  assert.deepEqual(ids(activePath(EDITED, null)), ['u1', 'a1', 'u2b', 'a2b'])
  assert.deepEqual(ids(activePath(EDITED, { a1: 'u2' })), ['u1', 'a1', 'u2', 'a2'])
  // filho inexistente / que não é filho dessa chave / chave sumida → mais novo
  assert.deepEqual(ids(activePath(EDITED, { a1: 'a2', u2b: 'x', sumiu: 'u2' })), [
    'u1',
    'a1',
    'u2b',
    'a2b'
  ])
  // ordem da entrada não importa (só seq)
  assert.deepEqual(ids(activePath([...EDITED].reverse(), { a1: 'u2' })), ['u1', 'a1', 'u2', 'a2'])
  assert.equal(activeLeaf(EDITED, {})?.id, 'a2b')
  assert.equal(activeLeaf([], {}), null)
})

test('caminho: null termina o caminho (regenerar em andamento); null na raiz = vazio', () => {
  assert.deepEqual(ids(activePath(EDITED, { a1: null })), ['u1', 'a1'])
  assert.equal(activeLeaf(EDITED, { a1: null })?.id, 'a1')
  assert.deepEqual(ids(activePath(EDITED, { root: null })), [])
  // null numa folha (sem filhos) não muda nada
  assert.deepEqual(ids(activePath(EDITED, { a2b: null })), ['u1', 'a1', 'u2b', 'a2b'])
})

test('pai legado (ausente) = anterior por seq; órfão/inválido também; raiz explícita', () => {
  const legacy = [n('m1', 1), n('m2', 2), n('m3', 5)]
  assert.deepEqual(Object.fromEntries(resolveParents(legacy)), { m1: null, m2: 'm1', m3: 'm2' })
  assert.deepEqual(ids(activePath(legacy, {})), ['m1', 'm2', 'm3'])
  const bad = [
    n('m1', 1, null),
    n('m2', 2, 'ainda-nao-chegou'), // órfão: pai não está na sessão
    n('m3', 5, 'm4'), // pai com seq maior (quebra a invariante)
    n('m4', 7, 'm3'),
    n('m5', 8, 'm5') // ele mesmo
  ]
  assert.deepEqual(Object.fromEntries(resolveParents(bad)), {
    m1: null,
    m2: 'm1',
    m3: 'm2',
    m4: 'm3',
    m5: 'm4'
  })
  // mensagem antiga (sem parentId) anexada depois de uma edição: filha da anterior por seq,
  // mesmo que ela esteja noutro ramo
  const mixed = [...EDITED, n('x', 7)]
  assert.equal(resolveParents(mixed).get('x'), 'a2b')
  assert.deepEqual(ids(activePath(mixed, { a1: 'u2' })), ['u1', 'a1', 'u2', 'a2'])
  // primeira mensagem editada: várias raízes (null explícito), chave "root"
  const roots = [n('u1', 1, null), n('a1', 2, 'u1'), n('u1b', 3, null), n('a1b', 4, 'u1b')]
  assert.deepEqual(ids(activePath(roots, {})), ['u1b', 'a1b'])
  assert.deepEqual(ids(activePath(roots, { root: 'u1' })), ['u1', 'a1'])
  // empate de seq (transitório): desempate por id; derivada = maior id entre os de maior seq menor
  const tie = [n('r', 1, null), n('b', 2, 'r'), n('a', 2, 'r'), n('z', 3)]
  assert.equal(resolveParents(tie).get('z'), 'b')
  assert.deepEqual(ids(activePath(tie, {})), ['r', 'b', 'z'])
})

test('irmãos: index/count/prev/next na ordem de seq; pathSiblings só com > 1 versão', () => {
  assert.deepEqual(siblings(EDITED, 'u2'), { index: 0, count: 2, prevId: null, nextId: 'u2b' })
  assert.deepEqual(siblings(EDITED, 'u2b'), { index: 1, count: 2, prevId: 'u2', nextId: null })
  assert.deepEqual(siblings(EDITED, 'a1'), { index: 0, count: 1, prevId: null, nextId: null })
  assert.equal(siblings(EDITED, 'nao-existe'), null)
  const tree = buildTree(EDITED)
  const path = activePath(tree, {})
  const ps = pathSiblings(tree, path)
  assert.deepEqual([...ps.keys()], ['u2b'])
  assert.equal(ps.get('u2b')?.count, 2)
})

test('selectionToReach / pruneSel: seleção mínima, sem entradas redundantes', () => {
  // ir para a versão antiga grava uma entrada; voltar para a mais nova apaga
  const s1 = selectionToReach(EDITED, {}, 'a2')
  assert.deepEqual(s1, { a1: 'u2' })
  assert.deepEqual(ids(activePath(EDITED, s1)), ['u1', 'a1', 'u2', 'a2'])
  const s2 = selectionToReach(EDITED, s1, 'u2b')
  assert.deepEqual(s2, {})
  // seleção em dois níveis
  const two = [...EDITED.slice(0, 4), n('a2x', 7, 'u2')] // u2 → { a2, a2x }
  const s3 = selectionToReach(two, {}, 'a2')
  assert.deepEqual(s3, { u2: 'a2' })
  // null num ancestral é substituído (o caminho precisa passar)
  assert.deepEqual(selectionToReach(EDITED, { a1: null }, 'a2b'), {})
  // mensagem inexistente → cópia igual
  const keep: BranchSel = { a1: 'u2' }
  const same = selectionToReach(EDITED, keep, 'nope')
  assert.deepEqual(same, keep)
  assert.notEqual(same, keep)
  // prune: chave inexistente, escolha que não é filho, escolha = mais novo, null sem filhos saem
  assert.deepEqual(
    pruneSel(EDITED, { sumiu: 'u2', a1: 'u2b', u1: 'u2', a2b: null, u2: 'a2', root: 'u1' }),
    {}
  )
  assert.deepEqual(pruneSel(EDITED, { a1: 'u2', u1: null }), { a1: 'u2', u1: null })
  assert.ok(selEquals({ a: 'x', b: null }, { b: null, a: 'x' }))
  assert.ok(!selEquals({ a: 'x' }, { a: null }))
  assert.ok(!selEquals({ a: 'x' }, {}))
  assert.deepEqual(toBranchSel({ a: 'x', b: null, c: 3, d: {} }), { a: 'x', b: null })
  assert.deepEqual(toBranchSel([1]), {})
  assert.deepEqual(toBranchSel(null), {})
})

const tm = (
  id: string,
  seq: number,
  role: string,
  meta: any = {},
  parentId?: string | null
): any => ({
  ...n(id, seq, parentId),
  message: { role },
  meta
})

test('turnos: prompt, âncora do turno, resposta, edição que vira ramo', () => {
  const path = [
    tm('u1', 1, 'user'),
    tm('a1', 2, 'assistant'),
    tm('t1', 3, 'tool'),
    tm('a2', 4, 'assistant'),
    tm('s1', 5, 'user', { synthetic: true }), // resultado de tools em modo texto: não abre turno
    tm('a3', 6, 'assistant'),
    tm('e1', 7, 'assistant', { synthetic: true, kind: 'error' }),
    tm('q1', 8, 'user', { kind: 'queued' }),
    tm('a4', 9, 'assistant'),
    tm('c1', 10, 'user', { synthetic: true, kind: 'compaction' }),
    tm('cb', 11, 'user', { synthetic: true, kind: 'subagent-callback' }),
    tm('a5', 12, 'assistant')
  ]
  assert.deepEqual(
    path.filter(isPromptMessage).map((m) => m.id),
    ['u1', 'q1', 'cb']
  )
  assert.equal(turnAnchor(path, 'u1')?.id, 'u1')
  assert.equal(turnAnchor(path, 'a3')?.id, 'u1')
  assert.equal(turnAnchor(path, 'e1')?.id, 'u1')
  assert.equal(turnAnchor(path, 'c1')?.id, 'q1') // fronteira não abre turno
  assert.equal(turnAnchor(path, 'a5')?.id, 'cb')
  assert.equal(turnAnchor(path, 'nope'), null)
  assert.equal(turnAnchor([tm('a0', 1, 'assistant')], 'a0'), null)
  assert.deepEqual(ids(turnResponse(path, 'u1')), ['a1', 't1', 'a2', 's1', 'a3', 'e1'])
  assert.deepEqual(ids(turnResponse(path, 'q1')), ['a4', 'c1'])
  assert.deepEqual(ids(turnResponse(path, 'cb')), ['a5'])
  assert.equal(lastTurnAnchor(path)?.id, 'cb')
  assert.equal(lastTurnAnchor([]), null)
  // edição como ramo: digitada (sem kind / queued / forced), não sintética, sessão principal
  assert.ok(isBranchEditable(tm('x', 1, 'user'), 0))
  assert.ok(isBranchEditable(tm('x', 1, 'user', { kind: 'queued' }), 0))
  assert.ok(isBranchEditable(tm('x', 1, 'user', { kind: 'forced' }), 0))
  assert.ok(!isBranchEditable(tm('x', 1, 'user'), 1))
  assert.ok(!isBranchEditable(tm('x', 1, 'assistant'), 0))
  assert.ok(!isBranchEditable(tm('x', 1, 'user', { kind: 'inter-chat' }), 0))
  assert.ok(!isBranchEditable(tm('x', 1, 'user', { synthetic: true, kind: 'compaction' }), 0))
  assert.ok(!isBranchEditable(tm('x', 1, 'user', { synthetic: true }), 0))
})

const VECTORS = join(ROOT_DIR, 'docs/test-vectors/branches.json')
test(
  'fixture compartilhado docs/test-vectors/branches.json',
  { skip: !existsSync(VECTORS) },
  () => {
    const v = JSON.parse(readFileSync(VECTORS, 'utf8'))
    assert.ok(Array.isArray(v.cases) && v.cases.length > 0)
    for (const c of v.cases) {
      const tree = buildTree(c.messages as TreeMessage[])
      if (c.parents)
        assert.deepEqual(Object.fromEntries(tree.parentOf), c.parents, `${c.name}: parents`)
      assert.deepEqual(ids(activePath(tree, c.branchSel)), c.path, `${c.name}: path`)
      for (const [id, exp] of Object.entries(c.siblings ?? {}) as [string, any][]) {
        const s = siblings(tree, id)
        assert.ok(s, `${c.name}: siblings ${id}`)
        assert.deepEqual({ index: s.index, count: s.count }, exp, `${c.name}: siblings ${id}`)
      }
    }
  }
)

// ---------------- parte B: migração ----------------

/** Banco no formato antigo (sem parent_id / branch_sel_json), com memória e sync. */
function legacyDb(name: string): Database.Database {
  const conn = new Database(join(TMP, name))
  conn.pragma('foreign_keys = ON')
  const old = SCHEMA.replace(",\n  branch_sel_json     TEXT NOT NULL DEFAULT '{}'", '').replace(
    ',\n  parent_id    TEXT',
    ''
  )
  assert.ok(!old.includes('parent_id') && !old.includes('branch_sel_json'), 'schema antigo')
  conn.exec(old)
  ensureMemorySchema(conn)
  return conn
}

function seedLegacy(conn: Database.Database): void {
  conn
    .prepare(
      "INSERT INTO chats (id, title, config_json, main_session_id, created_at, updated_at) VALUES ('c1', 't', '{}', 's1', 0, 0)"
    )
    .run()
  const ses = conn.prepare(
    "INSERT INTO sessions (id, chat_id, parent_session_id, depth, model, status, created_at) VALUES (?, 'c1', ?, ?, 'm', 'idle', 0)"
  )
  ses.run('s1', null, 0)
  ses.run('s2', 's1', 1)
  const msg = conn.prepare(
    "INSERT INTO messages (id, session_id, seq, message_json, meta_json, created_at) VALUES (?, ?, ?, '{}', '{}', 0)"
  )
  msg.run('a', 's1', 1)
  msg.run('b', 's1', 2)
  msg.run('c', 's1', 4) // lacuna de seq
  msg.run('x', 's2', 1)
  msg.run('y', 's2', 2)
}

test('migração: colunas + parent_id preenchido sem marcar nada no sync (triggers ligados)', () => {
  const conn = legacyDb('migrate.db')
  seedLegacy(conn)
  ensureSyncSchema(conn)
  setTracking(conn, true)
  // sanidade: com o rastreamento ligado, uma escrita comum marca
  conn.prepare("UPDATE messages SET meta_json = '{}' WHERE id = 'a'").run()
  assert.equal((conn.prepare('SELECT COUNT(*) AS n FROM sync_dirty').get() as any).n, 1)
  conn.exec('DELETE FROM sync_dirty')

  const r = ensureMessageTree(conn)
  assert.deepEqual(r, { skipped: false, filled: 5 })
  const parents = Object.fromEntries(
    (conn.prepare('SELECT id, parent_id FROM messages').all() as any[]).map((x) => [
      x.id,
      x.parent_id
    ])
  )
  assert.deepEqual(parents, { a: '', b: 'a', c: 'b', x: '', y: 'x' }) // '' = raiz
  assert.equal((conn.prepare('SELECT COUNT(*) AS n FROM sync_dirty').get() as any).n, 0)
  assert.equal(conn.prepare("SELECT 1 FROM sync_flags WHERE k = 'apply'").get(), undefined)
  assert.ok(conn.prepare("SELECT 1 FROM sync_flags WHERE k = 'on'").get(), 'rastreamento segue')
  assert.ok(conn.prepare('SELECT 1 FROM settings WHERE key = ?').get(MESSAGE_TREE_FLAG))
  const scols = (conn.prepare('PRAGMA table_info(sessions)').all() as any[]).map((c) => c.name)
  assert.ok(scols.includes('branch_sel_json'))
  assert.equal(
    (conn.prepare("SELECT branch_sel_json AS v FROM sessions WHERE id = 's1'").get() as any).v,
    '{}'
  )
  assert.ok(
    conn
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_messages_session_parent'"
      )
      .get()
  )
  // idempotente: 2ª vez não mexe (linha nova sem parent_id fica NULL = legado/derivada)
  conn
    .prepare(
      "INSERT INTO messages (id, session_id, seq, message_json, meta_json, created_at) VALUES ('d', 's1', 5, '{}', '{}', 0)"
    )
    .run()
  conn.exec('DELETE FROM sync_dirty')
  assert.deepEqual(ensureMessageTree(conn), { skipped: true, filled: 0 })
  assert.equal(
    (conn.prepare("SELECT parent_id AS p FROM messages WHERE id = 'd'").get() as any).p,
    null
  )
  // depois da migração o rastreamento continua valendo para escritas normais
  conn.prepare("UPDATE messages SET parent_id = 'c' WHERE id = 'd'").run()
  assert.equal((conn.prepare('SELECT COUNT(*) AS n FROM sync_dirty').get() as any).n, 1)
  conn.close()
})

test('migração: banco novo (SCHEMA atual) e banco sem sync', () => {
  const fresh = new Database(':memory:')
  fresh.exec(SCHEMA)
  assert.deepEqual(ensureMessageTree(fresh), { skipped: false, filled: 0 })
  assert.deepEqual(ensureMessageTree(fresh), { skipped: true, filled: 0 })
  fresh.close()
  const nosync = legacyDb('nosync.db')
  seedLegacy(nosync)
  assert.equal(ensureMessageTree(nosync).filled, 5)
  assert.equal(
    nosync
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sync_flags'")
      .get(),
    undefined
  )
  nosync.close()
})

// ---------------- parte C: repositório real (db.ts + repo.ts) ----------------

process.env.CLEARCHAT_TEST_USERDATA = TMP
const ELECTRON_STUB =
  'data:text/javascript,' +
  encodeURIComponent(`
export const app = { getPath: () => process.env.CLEARCHAT_TEST_USERDATA, getVersion: () => '0.0.0', isPackaged: false }
export default { app }
`)
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === 'electron') return { url: ELECTRON_STUB, shortCircuit: true }
    return next(spec, ctx)
  }
})

type Repo = typeof import('../src/main/repo.ts')
let repoMod: Repo | null = null
async function repo(): Promise<Repo> {
  repoMod ??= await import('../src/main/repo.ts')
  return repoMod
}
after(async () => {
  if (repoMod) (await import('../src/main/db.ts')).closeDb()
})

async function newSession(): Promise<{ r: Repo; sid: string }> {
  const r = await repo()
  const { session } = r.chatsRepo.create({ title: 'ramos' })
  return { r, sid: session.id }
}
const U = (t: string): any => ({ role: 'user', content: t })
const A = (t: string): any => ({ role: 'assistant', content: t })

test('repo: append encadeia no fim do caminho ativo; path/listAll; sessão com branchSel', async () => {
  const { r, sid } = await newSession()
  assert.deepEqual(r.sessionsRepo.get(sid)?.branchSel, {})
  const u1 = r.messagesRepo.append(sid, U('oi'))
  const a1 = r.messagesRepo.append(sid, A('olá'))
  const u2 = r.messagesRepo.append(sid, U('tudo?'))
  assert.equal(u1.parentId, null)
  assert.equal(a1.parentId, u1.id)
  assert.equal(u2.parentId, a1.id)
  assert.equal(r.messagesRepo.get(u1.id)?.parentId, null) // '' no banco → null
  assert.equal(r.messagesRepo.get(u2.id)?.parentId, a1.id)
  assert.deepEqual(ids(r.messagesRepo.path(sid)), [u1.id, a1.id, u2.id])
  assert.deepEqual(ids(r.messagesRepo.listAll(sid)), [u1.id, a1.id, u2.id])
  // pai explícito inexistente → erro
  assert.throws(() => r.messagesRepo.append(sid, U('x'), {}, 'nao-existe'), /pai não encontrada/)
})

test('repo: versões (branch/addSibling), troca (select), null do regenerate', async () => {
  const { r, sid } = await newSession()
  const u1 = r.messagesRepo.append(sid, U('u1'))
  const a1 = r.messagesRepo.append(sid, A('a1'))
  const u2 = r.messagesRepo.append(sid, U('u2'))
  const a2 = r.messagesRepo.append(sid, A('a2'))
  // editar u2 → irmã com o mesmo pai, já ativa
  const u2b = r.messagesRepo.addSibling(u2.id, U('u2 editada'))
  assert.equal(u2b.parentId, a1.id)
  assert.deepEqual(ids(r.messagesRepo.path(sid)), [u1.id, a1.id, u2b.id])
  assert.deepEqual(r.sessionsRepo.get(sid)?.branchSel, {})
  const a2b = r.messagesRepo.append(sid, A('a2b'))
  assert.equal(a2b.parentId, u2b.id)
  // trocar para a versão antiga: uma entrada; o append segue o caminho escolhido
  const s = r.messagesRepo.select(u2.id)
  assert.deepEqual(s.branchSel, { [a1.id]: u2.id })
  assert.deepEqual(ids(r.messagesRepo.path(sid)), [u1.id, a1.id, u2.id, a2.id])
  const u3 = r.messagesRepo.append(sid, U('u3'))
  assert.equal(u3.parentId, a2.id)
  assert.deepEqual(ids(r.messagesRepo.path(sid)), [u1.id, a1.id, u2.id, a2.id, u3.id])
  assert.deepEqual(
    ids(r.messagesRepo.listAll(sid)),
    [u1, a1, u2, a2, u2b, a2b, u3].map((m) => m.id)
  )
  // voltar para a mais nova apaga a entrada
  assert.deepEqual(r.messagesRepo.select(a2b.id).branchSel, {})
  // regenerar: null sob o prompt termina o caminho nele; o 1º append ali limpa o null
  r.sessionsRepo.setBranchSel(sid, { [u2b.id]: null })
  assert.deepEqual(ids(r.messagesRepo.path(sid)), [u1.id, a1.id, u2b.id])
  const a2c = r.messagesRepo.append(sid, A('a2c'))
  assert.equal(a2c.parentId, u2b.id)
  assert.deepEqual(r.sessionsRepo.get(sid)?.branchSel, {})
  assert.deepEqual(ids(r.messagesRepo.path(sid)), [u1.id, a1.id, u2b.id, a2c.id])
  // setBranchSel limpa entradas inválidas/redundantes
  r.sessionsRepo.setBranchSel(sid, { [u2b.id]: a2b.id, sumiu: 'x', [a1.id]: u2b.id })
  assert.deepEqual(r.sessionsRepo.get(sid)?.branchSel, { [u2b.id]: a2b.id })
  // editar a primeira mensagem → nova raiz (chave "root")
  const u1b = r.messagesRepo.branch(sid, null, U('u1 editada'))
  assert.equal(u1b.parentId, null)
  assert.deepEqual(ids(r.messagesRepo.path(sid)), [u1b.id])
  assert.deepEqual(r.messagesRepo.select(u2.id).branchSel, {
    root: u1.id,
    [a1.id]: u2.id,
    [u2b.id]: a2b.id
  })
  assert.deepEqual(ids(r.messagesRepo.path(sid)), [u1.id, a1.id, u2.id, a2.id, u3.id])
})

test('repo: delete re-liga os filhos ao pai e mantém o caminho', async () => {
  const { r, sid } = await newSession()
  // linear a → b → c: apagar b liga c em a
  const a = r.messagesRepo.append(sid, U('a'))
  const b = r.messagesRepo.append(sid, A('b'))
  const c = r.messagesRepo.append(sid, U('c'))
  const rm = r.messagesRepo.remove(b.id)!
  assert.equal(rm.message.id, b.id)
  assert.deepEqual(ids(rm.reparented), [c.id])
  assert.equal(rm.reparented[0].parentId, a.id)
  assert.equal(rm.selChanged, false)
  assert.deepEqual(ids(r.messagesRepo.path(sid)), [a.id, c.id])
  assert.equal(r.messagesRepo.remove('nao-existe'), null)
  assert.equal(r.messagesRepo.delete('nao-existe'), null)
})

test('repo: delete da versão selecionada — a escolha "de dentro" sobe para o pai', async () => {
  const { r, sid } = await newSession()
  const a = r.messagesRepo.append(sid, U('a'))
  const b1 = r.messagesRepo.append(sid, A('b1'))
  const c1 = r.messagesRepo.append(sid, U('c1'))
  const b2 = r.messagesRepo.branch(sid, a.id, A('b2'))
  r.messagesRepo.select(c1.id)
  assert.deepEqual(r.sessionsRepo.get(sid)?.branchSel, { [a.id]: b1.id })
  // apagar b1 (selecionada): c1 vira filha de a (seq 3 < b2 4) e continua no caminho
  const rm = r.messagesRepo.remove(b1.id)!
  assert.equal(rm.selChanged, true)
  assert.equal(r.messagesRepo.get(c1.id)?.parentId, a.id)
  assert.deepEqual(ids(r.messagesRepo.path(sid)), [a.id, c1.id])
  assert.deepEqual(r.sessionsRepo.get(sid)?.branchSel, { [a.id]: c1.id })
  // apagar a folha c1: o caminho segue pelo pai (versão restante b2)
  r.messagesRepo.delete(c1.id)
  assert.deepEqual(ids(r.messagesRepo.path(sid)), [a.id, b2.id])
  assert.deepEqual(r.sessionsRepo.get(sid)?.branchSel, {})
})

test('repo: delete fora do caminho não deixa os filhos dela "roubarem" o padrão', async () => {
  const { r, sid } = await newSession()
  const a = r.messagesRepo.append(sid, U('a'))
  const d = r.messagesRepo.append(sid, A('d')) // seq 2
  const x = r.messagesRepo.branch(sid, a.id, A('x')) // seq 3 — a mais nova, ativa por padrão
  const e = r.messagesRepo.append(sid, U('e'), {}, d.id) // seq 4, filha de d (fora do caminho)
  assert.deepEqual(ids(r.messagesRepo.path(sid)), [a.id, x.id])
  assert.deepEqual(r.sessionsRepo.get(sid)?.branchSel, {}) // append explícito não muda a seleção
  r.messagesRepo.delete(d.id) // e (seq 4) vira filha de a e seria a mais nova…
  assert.equal(r.messagesRepo.get(e.id)?.parentId, a.id)
  assert.deepEqual(ids(r.messagesRepo.path(sid)), [a.id, x.id]) // …mas o caminho fica
  assert.deepEqual(r.sessionsRepo.get(sid)?.branchSel, { [a.id]: x.id })
})

test('repo: insertAt (compactação) põe a fronteira entre o pendente e o pai dele', async () => {
  const { r, sid } = await newSession()
  const u1 = r.messagesRepo.append(sid, U('u1'))
  const a1 = r.messagesRepo.append(sid, A('a1'))
  const p = r.messagesRepo.append(sid, U('pendente'))
  const res = r.messagesRepo.insertAt(sid, p.seq, U('resumo'), {
    synthetic: true,
    kind: 'compaction'
  })
  assert.equal(res.message.seq, 3)
  assert.equal(res.message.parentId, a1.id)
  assert.equal(res.selChanged, false)
  assert.deepEqual(
    res.shifted.map((m) => [m.id, m.seq, m.parentId]),
    [[p.id, 4, res.message.id]]
  )
  assert.deepEqual(ids(r.messagesRepo.path(sid)), [u1.id, a1.id, res.message.id, p.id])
  // sem mensagem na posição → filha da folha (como append)
  const end = r.messagesRepo.insertAt(sid, 99, U('fim'))
  assert.equal(end.message.parentId, p.id)
})

test('repo: insertAt com a seleção apontando para o pendente → aponta para a fronteira', async () => {
  const { r, sid } = await newSession()
  const u1 = r.messagesRepo.append(sid, U('u1'))
  const a1 = r.messagesRepo.append(sid, A('a1'))
  const p1 = r.messagesRepo.append(sid, U('p1')) // seq 3
  const p2 = r.messagesRepo.addSibling(p1.id, U('p2')) // seq 4, irmã mais nova
  r.messagesRepo.select(p1.id)
  assert.deepEqual(r.sessionsRepo.get(sid)?.branchSel, { [a1.id]: p1.id })
  const res = r.messagesRepo.insertAt(sid, 3, U('resumo'), { synthetic: true, kind: 'compaction' })
  assert.equal(res.selChanged, true)
  assert.deepEqual(r.sessionsRepo.get(sid)?.branchSel, { [a1.id]: res.message.id })
  assert.deepEqual(ids(r.messagesRepo.path(sid)), [u1.id, a1.id, res.message.id, p1.id])
  const all = r.messagesRepo.listAll(sid)
  assert.deepEqual(
    all.map((m) => [m.id, m.seq]),
    [
      [u1.id, 1],
      [a1.id, 2],
      [res.message.id, 3],
      [p1.id, 4],
      [p2.id, 5]
    ]
  )
  assert.equal(all.find((m) => m.id === p2.id)?.parentId, a1.id)
})

test('repo: linhas legadas (parent_id NULL) seguem lineares; historyStore devolve o caminho', async () => {
  const { r, sid } = await newSession()
  const { getDb } = await import('../src/main/db.ts')
  const { historyStore } = await import('../src/main/historyStore.ts')
  const db = getDb()
  const a = r.messagesRepo.append(sid, U('a'))
  // linha gravada por código que não conhece a árvore (ex.: sync de um cliente antigo)
  db.prepare(
    "INSERT INTO messages (id, session_id, seq, message_json, meta_json, created_at) VALUES ('legacy-b', ?, 2, ?, '{}', 0)"
  ).run(sid, JSON.stringify(A('b')))
  assert.equal(r.messagesRepo.get('legacy-b')?.parentId, undefined)
  assert.deepEqual(ids(r.messagesRepo.path(sid)), [a.id, 'legacy-b'])
  const c = r.messagesRepo.append(sid, U('c'))
  assert.equal(c.parentId, 'legacy-b')
  const c2 = r.messagesRepo.addSibling(c.id, U('c2'))
  r.messagesRepo.select(c.id)
  const st = historyStore(db)
  assert.deepEqual(ids(st.messages(sid)), [a.id, 'legacy-b', c.id])
  assert.equal(st.message(c2.id)?.parentId, 'legacy-b')
})
