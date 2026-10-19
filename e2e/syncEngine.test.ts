/* eslint-disable @typescript-eslint/no-explicit-any */
// Motor do sync (src/main/sync/engine.ts + host.ts) contra o servidor FALSO (e2e/fakes/syncServer.ts),
// sem Electron: vários "dispositivos" (bancos SQLite em memória) na mesma conta. Cobre mapeamento de
// registros (ida e volta de cada entidade), upload/download inicial, LWW por campo, tombstones,
// idempotência do push (mesmo push_id), merge do primeiro login (as duas prioridades, online vazio,
// chats com histórias diferentes), divergência (manter local / manter online), comando remoto
// relayed ao host, stream ao vivo e queda do host → "host offline" → assumir.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { SCHEMA } from '../src/main/dbSchema'
import { ensureMemorySchema } from '../src/main/memory/schema'
import { ensureSearchIndex } from '../src/main/searchIndex'
import { ensureSyncSchema } from '../src/main/sync/schema'
import { applyRemote, buildLocal, merge3, sameJson } from '../src/main/sync/records'
import { SyncEngine } from '../src/main/sync/engine'
import type { RunnerAdapter } from '../src/main/sync/host'
import type { AgentEvent } from '../src/shared/types'
import { startFakeSyncServer, type FakeSyncServer } from './fakes/syncServer.ts'

let srv: FakeSyncServer
const PASSWORD = 'senha de criptografia longa'
let emailN = 0

before(async () => {
  srv = await startFakeSyncServer({ hostDropGraceMs: 400, commandTimeoutMs: 3000 })
})
const allDevs: Dev[] = []
after(async () => {
  for (const d of allDevs) d.eng.destroy()
  await srv.close()
})

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
async function waitFor<T>(fn: () => T | Promise<T>, what: string, ms = 8000): Promise<T> {
  const t0 = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}`)
    await sleep(40)
  }
}

function newDb(): Database.Database {
  const conn = new Database(':memory:')
  conn.pragma('foreign_keys = ON')
  conn.exec(SCHEMA)
  conn.exec('ALTER TABLE sessions ADD COLUMN provider_id TEXT')
  conn.exec("ALTER TABLE providers ADD COLUMN kind TEXT NOT NULL DEFAULT ''")
  ensureMemorySchema(conn)
  ensureSearchIndex(conn)
  return conn
}

interface Dev {
  name: string
  conn: Database.Database
  eng: SyncEngine
  events: AgentEvent[]
  agent: (e: AgentEvent) => void
}

function device(
  name: string,
  opts: { runner?: RunnerAdapter; conn?: Database.Database } = {}
): Dev {
  const conn = opts.conn ?? newDb()
  const listeners = new Set<(e: AgentEvent) => void>()
  const events: AgentEvent[] = []
  const secrets = new Map<string, string>()
  const eng = new SyncEngine({
    conn,
    emit: (e) => {
      events.push(e)
      for (const l of listeners) l(e)
    },
    onAgentEvent: (fn) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    secrets: {
      get: (k) => secrets.get(k) ?? null,
      set: (k, v) => (v == null ? secrets.delete(k) : secrets.set(k, v)),
      available: () => true
    },
    appVersion: 'test',
    deviceName: name,
    platform: 'linux',
    runner: opts.runner ?? null,
    envUrl: srv.url,
    timing: {
      pollMs: 40,
      pushDebounceMs: 20,
      retryMs: 150,
      ws: { backoffBaseMs: 80, backoffMaxMs: 400, pingMs: 2000, pongTimeoutMs: 2000 }
    },
    log: process.env.SYNC_DEBUG ? (...a: unknown[]) => console.log(`[${name}]`, ...a) : () => {}
  })
  const dev: Dev = {
    name,
    conn,
    eng,
    events,
    // evento "do runner local" (main) — o host publica no stream
    agent: (e) => {
      for (const l of listeners) l(e)
    }
  }
  allDevs.push(dev)
  return dev
}

async function newAccount(): Promise<string> {
  const email = `u${++emailN}-${Date.now()}@teste.dev`
  await srv.createAccount({ email, password: PASSWORD })
  return email
}

async function login(d: Dev, email: string): Promise<void> {
  await d.eng.init()
  await d.eng.requestCode(email)
  const code = srv.lastCode(email)
  assert.ok(code, 'código enviado')
  await d.eng.verifyCode(email, code!)
  await d.eng.unlock(PASSWORD, true)
}

const settled = (d: Dev): Promise<boolean> =>
  waitFor(
    () =>
      d.eng.phase() === 'ready' &&
      d.eng.pendingCount() === 0 &&
      (d.conn.prepare('SELECT COUNT(*) AS n FROM sync_outbox').get() as any).n === 0,
    `${d.name} sincronizado`
  ).catch((e) => {
    const dirty = d.conn.prepare('SELECT * FROM sync_dirty').all()
    const out = d.conn.prepare('SELECT push_id, kind, chat_id FROM sync_outbox').all()
    throw new Error(
      `${e.message} phase=${d.eng.phase()} status=${JSON.stringify(d.eng.status())} dirty=${JSON.stringify(dirty)} states=${JSON.stringify([...(d.eng.host as any).states.values()])} windows=${JSON.stringify([...(d.eng.host as any).windows])} beginning=${[...(d.eng.host as any).beginning.keys()]} recs=${JSON.stringify(srv.records(d.eng.userId).map((r: any) => [r.type, r.seq, r.rev, r.device_id?.slice(0, 4)]))} me=${d.eng.deviceId.slice(0, 4)} chatrow=${JSON.stringify(d.conn.prepare('SELECT chat_id, head, base_head FROM sync_chat').all())} cycle=${!!(d.eng as any).cycle} pulling=${!!(d.eng as any).pulling} outbox=${JSON.stringify(out)}`
    )
  })

async function synced(...devs: Dev[]): Promise<void> {
  for (let i = 0; i < 2; i++)
    for (const d of devs) {
      await settled(d)
      await d.eng.syncNow()
    }
}

// ---------------- dados (SQL como os repos) ----------------

function addProvider(conn: Database.Database, p: Partial<any> = {}): string {
  const id = p.id ?? randomUUID()
  conn
    .prepare(
      'INSERT INTO providers (id, name, base_url, kind, api_key, headers_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    .run(
      id,
      p.name ?? 'OpenRouter',
      p.baseUrl ?? 'https://openrouter.ai/api/v1',
      p.kind ?? 'openrouter',
      p.apiKey ?? 'sk-1',
      '{}',
      p.createdAt ?? 1000
    )
  return id
}

function addChat(
  conn: Database.Database,
  title = 'Chat',
  id = randomUUID()
): { chatId: string; sessionId: string } {
  const sessionId = randomUUID()
  conn
    .prepare(
      'INSERT INTO chats (id, title, config_json, main_session_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(
      id,
      title,
      JSON.stringify({
        model: 'fake/m',
        providerId: '',
        cwd: '/home/teste/proj',
        enabledTools: ['shell']
      }),
      sessionId,
      1,
      1
    )
  conn
    .prepare(
      `INSERT INTO sessions (id, chat_id, parent_session_id, parent_tool_call_id, depth, model, title, task, status, created_at)
       VALUES (?, ?, NULL, NULL, 0, 'fake/m', 'Principal', NULL, 'idle', 1)`
    )
    .run(sessionId, id)
  return { chatId: id, sessionId }
}

function addMessage(
  conn: Database.Database,
  sessionId: string,
  role: string,
  content: string
): string {
  const id = randomUUID()
  const seq = (
    conn
      .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS s FROM messages WHERE session_id = ?')
      .get(sessionId) as any
  ).s
  conn
    .prepare(
      'INSERT INTO messages (id, session_id, seq, message_json, meta_json, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(id, sessionId, seq, JSON.stringify({ role, content }), '{}', Date.now())
  return id
}

const texts = (conn: Database.Database, sessionId: string): string[] =>
  (
    conn
      .prepare('SELECT message_json FROM messages WHERE session_id = ? ORDER BY seq')
      .all(sessionId) as any[]
  ).map((r) => JSON.parse(r.message_json).content)

const mainTexts = (conn: Database.Database, chatId: string): string[] => {
  const r = conn.prepare('SELECT main_session_id AS m FROM chats WHERE id = ?').get(chatId) as any
  return r ? texts(conn, r.m) : []
}

const seedDefaultPreset = (conn: Database.Database): string => {
  const id = randomUUID()
  conn
    .prepare(
      'INSERT INTO presets (id, name, description, icon, config_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    .run(id, 'Padrão', '', 'sparkles', '{}', 1, 1)
  return id
}

// ---------------- testes ----------------

test('mapeamento: ida e volta de cada entidade (campos locais preservados)', () => {
  const a = newDb()
  const b = newDb()
  ensureSyncSchema(a)
  const pid = addProvider(a, { name: 'P', apiKey: 'k' })
  a.prepare(
    "INSERT INTO settings (key, value) VALUES ('defaultProviderId', ?), ('defaultModel', '\"m1\"'), ('approvalModes', '{\"commands\":\"lists\"}')"
  ).run(JSON.stringify(pid))
  a.prepare(
    'INSERT INTO presets (id, name, description, icon, config_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run('pr1', 'Dev', 'd', 'code', JSON.stringify({ model: 'x', cwd: '/a/b' }), 1, 2)
  a.prepare(
    "INSERT INTO memory_collections (id, category, name, description, icon, created_at, updated_at) VALUES ('c1', 'people', 'Família', '', NULL, 1, 1)"
  ).run()
  a.prepare(
    "INSERT INTO memories (id, collection_id, category, title, slug, summary, facts_json, pinned, created_at, updated_at, updated_by) VALUES ('m1', 'c1', 'people', 'Ana', 'ana', 's', '[\"f\"]', 1, 1, 2, 'user')"
  ).run()
  const { chatId, sessionId } = addChat(a, 'Título')
  const mid = addMessage(
    a,
    sessionId,
    'user',
    'oi clearchat-attachment://' + 'a'.repeat(64) + '.png'
  )
  a.prepare('UPDATE sessions SET memory_json = \'{"lastExtractedSeq":3}\' WHERE id = ?').run(
    sessionId
  )
  b.prepare(
    'INSERT INTO presets (id, name, description, icon, config_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run('pr1', 'Dev', 'd', 'code', JSON.stringify({ cwd: '/local/b' }), 1, 1)
  const cases: [string, string][] = [
    ['provider', pid],
    ['setting', 'defaultModel'],
    ['setting', 'approvalModes'],
    ['preset', 'pr1'],
    ['memory_collection', 'c1'],
    ['memory', 'm1'],
    ['chat', chatId],
    ['session', sessionId],
    ['message', mid]
  ]
  for (const [type, id] of cases) {
    const l = buildLocal(a, type, id)
    assert.ok(l, `${type} local`)
    assert.equal(l!.plain.sv, 1)
    if (type === 'preset' || type === 'chat')
      assert.equal((l!.plain.config as any).cwd, undefined, 'cwd não sai')
    applyRemote(b, type, id, JSON.parse(JSON.stringify(l!.plain)), { defaultCwd: () => '/padrao' })
    const back = buildLocal(b, type, id)
    assert.ok(back, `${type} aplicado`)
    assert.ok(sameJson(back!.plain, l!.plain), `${type} ida e volta`)
    assert.equal(back!.scope, l!.scope)
  }
  assert.deepEqual(buildLocal(a, 'message', mid)!.shas, ['a'.repeat(64)])
  // cwd local mantido / padrão em chat novo
  assert.equal(
    JSON.parse(
      (b.prepare("SELECT config_json FROM presets WHERE id = 'pr1'").get() as any).config_json
    ).cwd,
    '/local/b'
  )
  assert.equal(
    JSON.parse(
      (b.prepare('SELECT config_json FROM chats WHERE id = ?').get(chatId) as any).config_json
    ).cwd,
    '/padrao'
  )
  // status transitório vira interrupted localmente
  applyRemote(b, 'session', sessionId, {
    ...buildLocal(a, 'session', sessionId)!.plain,
    status: 'running'
  })
  assert.equal(
    (b.prepare('SELECT status FROM sessions WHERE id = ?').get(sessionId) as any).status,
    'interrupted'
  )
  // colisão de slug: a mais nova ganha sufixo
  applyRemote(b, 'memory', 'mZZZ9', {
    ...buildLocal(a, 'memory', 'm1')!.plain,
    title: 'Outra',
    createdAt: 99
  })
  assert.equal(
    (b.prepare("SELECT slug FROM memories WHERE id = 'mZZZ9'").get() as any).slug,
    'ana-zzz9'
  )
  // merge 3-way por campo (config chave a chave)
  const merged = merge3(
    { sv: 1, title: 'servidor', config: { a: 1, b: 2 }, updatedAt: 5, extra: 'x' },
    { sv: 1, title: 'base', config: { a: 1, b: 1 }, updatedAt: 3 },
    { sv: 1, title: 'base', config: { a: 9, b: 1 }, updatedAt: 4 }
  )
  assert.deepEqual(merged, {
    sv: 1,
    title: 'servidor',
    config: { a: 9, b: 2 },
    updatedAt: 5,
    extra: 'x'
  })
})

test('upload inicial (online vazio) e download no segundo dispositivo (local vazio)', async () => {
  const email = await newAccount()
  const A = device('PC')
  const pid = addProvider(A.conn, { name: 'Meu OpenRouter', apiKey: 'sk-aaa' })
  const presetA = seedDefaultPreset(A.conn)
  const { chatId, sessionId } = addChat(A.conn, 'Primeiro chat')
  addMessage(A.conn, sessionId, 'user', 'olá')
  addMessage(A.conn, sessionId, 'assistant', 'oi!')
  A.conn
    .prepare("INSERT INTO settings (key, value) VALUES ('defaultSystemPrompt', '\"seja breve\"')")
    .run()
  await login(A, email)
  await settled(A)
  const uid = srv.userIdOf(email)!
  const types = srv
    .records(uid)
    .map((r: any) => r.type)
    .sort()
  assert.ok(types.includes('provider') && types.includes('chat') && types.includes('session'))
  assert.equal(types.filter((t: string) => t === 'message').length, 2)

  const B = device('Notebook')
  const presetB = seedDefaultPreset(B.conn)
  await login(B, email)
  await settled(B)
  assert.equal(
    (B.conn.prepare('SELECT api_key FROM providers WHERE id = ?').get(pid) as any)?.api_key,
    'sk-aaa'
  )
  assert.deepEqual(texts(B.conn, sessionId), ['olá', 'oi!'])
  assert.equal(
    JSON.parse(
      (B.conn.prepare("SELECT value FROM settings WHERE key = 'defaultSystemPrompt'").get() as any)
        .value
    ),
    'seja breve'
  )
  // persona "Padrão" de cada instalação deduplicada (id canônico = o online)
  const presets = B.conn.prepare('SELECT id FROM presets').all() as any[]
  assert.deepEqual(
    presets.map((p) => p.id),
    [presetA]
  )
  assert.notEqual(presetA, presetB)
  assert.equal(
    B.eng.chatInfo(chatId).needsCwd,
    true,
    'chat vindo de outro dispositivo pede a raiz local'
  )
  // nos dois sentidos: B cria e A recebe
  addMessage(B.conn, sessionId, 'user', 'do notebook')
  await synced(B, A)
  await waitFor(() => texts(A.conn, sessionId).includes('do notebook'), 'A recebe a mensagem de B')
  A.eng.destroy()
  B.eng.destroy()
})

test('LWW por campo: edições concorrentes em campos diferentes não se perdem; tombstone apaga', async () => {
  const email = await newAccount()
  const A = device('A')
  const pid = addProvider(A.conn, { name: 'Nome', apiKey: 'k0' })
  const { chatId } = addChat(A.conn, 'Vai sumir')
  await login(A, email)
  await settled(A)
  const B = device('B')
  await login(B, email)
  await settled(B)
  A.eng.stop()
  B.eng.stop()
  A.conn.prepare("UPDATE providers SET name = 'Nome de A' WHERE id = ?").run(pid)
  B.conn.prepare("UPDATE providers SET api_key = 'k-de-B' WHERE id = ?").run(pid)
  A.eng.start()
  await settled(A)
  B.eng.start()
  await settled(B)
  await synced(A, B)
  for (const d of [A, B]) {
    const r = d.conn.prepare('SELECT name, api_key FROM providers WHERE id = ?').get(pid) as any
    assert.deepEqual(r, { name: 'Nome de A', api_key: 'k-de-B' }, d.name)
  }
  // apagar o chat em A → tombstone → B apaga (cascata)
  A.conn.prepare('DELETE FROM chats WHERE id = ?').run(chatId)
  await settled(A)
  await waitFor(
    () => !B.conn.prepare('SELECT 1 FROM chats WHERE id = ?').get(chatId),
    'B apaga o chat'
  )
  assert.ok(B.events.some((e) => e.type === 'chat-deleted' && e.chatId === chatId))
  assert.equal(
    (B.conn.prepare('SELECT COUNT(*) AS n FROM sessions WHERE chat_id = ?').get(chatId) as any).n,
    0
  )
  A.eng.destroy()
  B.eng.destroy()
})

test('push idempotente: lote reenviado com o mesmo push_id não duplica', async () => {
  const email = await newAccount()
  const A = device('A')
  await login(A, email)
  await settled(A)
  A.eng.stop()
  const pid = addProvider(A.conn, { name: 'Idem' })
  const eng = A.eng as any
  const batches = await eng.buildBatches()
  assert.equal(batches.length, 1)
  const b = batches[0]
  A.conn
    .prepare(
      'INSERT INTO sync_outbox (push_id, kind, chat_id, body, meta, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(b.body.push_id, b.kind, null, JSON.stringify(b.body), JSON.stringify(b.meta), Date.now())
  // "chegou ao servidor mas a resposta se perdeu"
  const first = await eng.http.post('/api/v1/sync/push', b.body)
  A.eng.start()
  await settled(A)
  const uid = srv.userIdOf(email)!
  const recs = srv.records(uid).filter((r: any) => r.type === 'provider' && r.id === pid)
  assert.equal(recs.length, 1)
  assert.equal(recs[0].rev, 1)
  assert.equal(recs[0].seq, first.results[0].seq, 'mesmo seq: a resposta guardada foi devolvida')
  assert.equal(eng.record('provider', pid).rev, 1)
  A.eng.destroy()
})

test('merge do primeiro login: priorizar local / priorizar online / chat com história diferente', async () => {
  const email = await newAccount()
  const A = device('A')
  const pidA = addProvider(A.conn, {
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey: 'k-online'
  })
  const c1 = addChat(A.conn, 'Compartilhado')
  addMessage(A.conn, c1.sessionId, 'user', 'versão online')
  A.conn
    .prepare(
      "INSERT INTO memory_collections (id, category, name, description, created_at, updated_at) VALUES ('colA', 'people', 'Família', '', 1, 1)"
    )
    .run()
  await login(A, email)
  await settled(A)

  // C: mesmos dados com ids diferentes + chat só local → priorizar local
  const C = device('C')
  const pidC = addProvider(C.conn, {
    name: 'openrouter',
    baseUrl: 'https://OpenRouter.ai/api/v1/',
    apiKey: 'k-local'
  })
  C.conn
    .prepare(
      "INSERT INTO memory_collections (id, category, name, description, created_at, updated_at) VALUES ('colC', 'people', 'familia', '', 1, 1)"
    )
    .run()
  C.conn
    .prepare(
      "INSERT INTO memories (id, collection_id, category, title, slug, summary, facts_json, pinned, created_at, updated_at, updated_by) VALUES ('mc', 'colC', 'people', 'Tia', 'tia', '', '[]', 0, 1, 1, 'user')"
    )
    .run()
  const onlyC = addChat(C.conn, 'Só no C')
  C.conn.prepare('UPDATE chats SET config_json = ? WHERE id = ?').run(
    JSON.stringify({
      providerId: pidC,
      cwd: '/c',
      memory: { collections: ['colC'], writeTo: { people: 'colC' } }
    }),
    onlyC.chatId
  )
  // mesmo id do chat online, história diferente
  const same = addChat(C.conn, 'Compartilhado', c1.chatId)
  addMessage(C.conn, same.sessionId, 'user', 'versão local')
  await C.eng.init()
  await C.eng.requestCode(email)
  await C.eng.verifyCode(email, srv.lastCode(email)!)
  await C.eng.unlock(PASSWORD, true)
  assert.equal(C.eng.phase(), 'merge')
  const info = C.eng.status().merge!
  assert.equal(info.conflictingChats, 1)
  assert.equal(info.online.providers, 1)
  await C.eng.resolveMerge('local')
  await synced(C)
  // provedor deduplicado: id online, conteúdo local
  assert.ok(C.conn.prepare('SELECT 1 FROM providers WHERE id = ?').get(pidA))
  assert.ok(!C.conn.prepare('SELECT 1 FROM providers WHERE id = ?').get(pidC))
  const cfg = JSON.parse(
    (C.conn.prepare('SELECT config_json FROM chats WHERE id = ?').get(onlyC.chatId) as any)
      .config_json
  )
  assert.equal(cfg.providerId, pidA, 'referência remapeada')
  assert.deepEqual(cfg.memory.collections, ['colA'])
  assert.equal(cfg.memory.writeTo.people, 'colA')
  assert.equal(
    (C.conn.prepare("SELECT collection_id FROM memories WHERE id = 'mc'").get() as any)
      .collection_id,
    'colA'
  )
  await synced(A)
  await waitFor(
    () =>
      (A.conn.prepare('SELECT api_key FROM providers WHERE id = ?').get(pidA) as any).api_key ===
      'k-local',
    'A recebe a chave priorizada (local de C)'
  )
  await waitFor(
    () => A.conn.prepare('SELECT 1 FROM chats WHERE id = ?').get(onlyC.chatId),
    'A recebe o chat só do C'
  )
  await waitFor(
    () => sameJson(mainTexts(A.conn, c1.chatId), ['versão local']),
    'história local de C venceu'
  )
  assert.equal(
    (A.conn.prepare('SELECT COUNT(*) AS n FROM sessions WHERE id = ?').get(c1.sessionId) as any).n,
    0,
    'versão perdedora apagada'
  )

  // D: priorizar online
  const D = device('D')
  addProvider(D.conn, {
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey: 'k-do-D'
  })
  const sameD = addChat(D.conn, 'Compartilhado', c1.chatId)
  addMessage(D.conn, sameD.sessionId, 'user', 'versão do D')
  await D.eng.init()
  await D.eng.requestCode(email)
  await D.eng.verifyCode(email, srv.lastCode(email)!)
  await D.eng.unlock(PASSWORD, true)
  assert.equal(D.eng.phase(), 'merge')
  await D.eng.resolveMerge('online')
  await synced(D)
  assert.equal(
    (D.conn.prepare('SELECT api_key FROM providers WHERE id = ?').get(pidA) as any).api_key,
    'k-local'
  )
  assert.deepEqual(mainTexts(D.conn, c1.chatId), ['versão local'], 'história online venceu no D')
  assert.equal(
    (D.conn.prepare('SELECT COUNT(*) AS n FROM sessions WHERE id = ?').get(sameD.sessionId) as any)
      .n,
    0
  )
  for (const d of [A, C, D]) d.eng.destroy()
})

test('divergência: manter local apaga a outra versão; manter online (de outro dispositivo) descarta a local', async () => {
  const email = await newAccount()
  const A = device('A')
  const { chatId, sessionId } = addChat(A.conn, 'Divergente')
  addMessage(A.conn, sessionId, 'user', 'base')
  await login(A, email)
  await settled(A)
  const B = device('B')
  await login(B, email)
  await settled(B)
  assert.deepEqual(texts(B.conn, sessionId), ['base'])

  // B executa offline; A continua online
  B.eng.stop()
  addMessage(B.conn, sessionId, 'assistant', 'offline em B')
  addMessage(A.conn, sessionId, 'assistant', 'online em A')
  await settled(A)
  B.eng.start()
  await waitFor(() => B.eng.chatInfo(chatId).diverged?.self, 'B detecta a divergência')
  await waitFor(
    () => A.eng.chatInfo(chatId).diverged && !A.eng.chatInfo(chatId).diverged!.self,
    'A vê divergente'
  )
  const det = await B.eng.divergence(chatId)
  assert.equal(det.onlyLocal.count, 1)
  assert.equal(det.onlyOnline.count, 1)
  assert.deepEqual(
    texts(B.conn, sessionId),
    ['base', 'offline em B'],
    'B não aplicou a versão online'
  )
  await B.eng.resolveDivergence(chatId, 'local')
  await synced(B, A)
  await waitFor(
    () => sameJson(texts(A.conn, sessionId), ['base', 'offline em B']),
    'A recebe a versão de B (a de A foi apagada)'
  )
  assert.equal(A.eng.chatInfo(chatId).diverged, null)

  // de novo, agora o outro dispositivo (A) descarta a versão de B
  B.eng.stop()
  addMessage(B.conn, sessionId, 'user', 'B offline 2')
  addMessage(A.conn, sessionId, 'user', 'A online 2')
  await settled(A)
  B.eng.start()
  await waitFor(() => A.eng.chatInfo(chatId).diverged, 'A vê a segunda divergência')
  await A.eng.resolveDivergence(chatId, 'online')
  await waitFor(
    () => sameJson(texts(B.conn, sessionId), ['base', 'offline em B', 'A online 2']),
    'B descarta a versão local'
  )
  await waitFor(() => !B.eng.chatInfo(chatId).diverged, 'B sem divergência')
  await synced(A, B)
  assert.deepEqual(texts(A.conn, sessionId), ['base', 'offline em B', 'A online 2'])
  A.eng.destroy()
  B.eng.destroy()
})

function stubRunner(log: any[]): RunnerAdapter {
  const fail = (): never => {
    throw new Error('não usado')
  }
  return {
    busyChats: () => new Set(),
    send: async (sid, text) => {
      log.push({ sid, text })
      return { queued: false }
    },
    forceSend: () => {},
    removeQueued: () => {},
    getQueue: () => [],
    takeChatQueues: () => [],
    stop: async () => {},
    stopChat: async () => {},
    stopSubagents: async () => {},
    approve: (id, d) => log.push({ approve: id, d }),
    smartOverride: fail,
    answerQuestion: fail,
    cancelQuestion: async () => {},
    retry: fail,
    cancelRetry: fail,
    regenerate: async () => {},
    editMessage: fail,
    deleteMessage: async () => {},
    compact: () => ({ scheduled: false }),
    extractMemory: async () => ({ created: 0, updated: 0, deleted: 0, changes: [] }),
    approvals: () => [],
    questions: () => [],
    retries: () => [],
    processes: () => [],
    skillsFor: async () => [{ name: 'pdf', description: 'PDFs' }]
  }
}

test('host: comando remoto executado no host, stream ao vivo, queda → host offline → assumir', async () => {
  const email = await newAccount()
  const logA: any[] = []
  const A = device('PC de casa', { runner: stubRunner(logA) })
  const { chatId, sessionId } = addChat(A.conn, 'Host')
  addMessage(A.conn, sessionId, 'user', 'oi')
  await login(A, email)
  await settled(A)
  await waitFor(() => A.eng.chatInfo(chatId).host?.self, 'A virou host (replay)')
  const B = device('Notebook', { runner: stubRunner([]) })
  await login(B, email)
  await settled(B)
  await waitFor(() => B.eng.host.mode(chatId) === 'remote', 'B é controle remoto')
  assert.equal(B.eng.chatInfo(chatId).host?.name, 'PC de casa')
  B.eng.host.setActive(chatId)
  await sleep(150)
  const r = await B.eng.host.sendCommand(chatId, 'send', {
    sessionId,
    text: 'do notebook',
    attachments: [],
    skills: [],
    createdAt: Date.now()
  })
  assert.equal(r.status, 'accepted')
  assert.deepEqual(logA, [{ sid: sessionId, text: 'do notebook' }])
  // dedupe por cmd_id não é reenvio automático; comando inválido → rejeitado legível
  await assert.rejects(
    B.eng.host.sendCommand(chatId, 'send', { sessionId: 'outra', text: 'x' }),
    /não pertence/
  )

  // stream: A (host) emite draft → B vê o draft
  await A.eng.host.ensureWindow(chatId, 'run')
  A.agent({
    type: 'session-updated',
    session: {
      id: sessionId,
      chatId,
      parentSessionId: null,
      parentToolCallId: null,
      depth: 0,
      model: 'fake/m',
      title: 'Principal',
      task: null,
      status: 'running',
      createdAt: 1
    } as any
  })
  A.agent({
    type: 'draft',
    sessionId,
    draft: { content: 'Escrevendo', reasoning: '', toolCalls: [] }
  })
  await sleep(150)
  A.agent({
    type: 'draft',
    sessionId,
    draft: { content: 'Escrevendo ao vivo', reasoning: '', toolCalls: [] }
  })
  await waitFor(
    () => B.events.some((e) => e.type === 'draft' && e.draft?.content === 'Escrevendo ao vivo'),
    'B recebe o draft'
  )
  assert.ok(B.events.some((e) => e.type === 'session-updated' && e.session.status === 'running'))
  A.agent({
    type: 'approval-requested',
    request: {
      id: 'ap1',
      chatId,
      sessionId,
      toolCallId: 't1',
      toolName: 'shell',
      args: {},
      createdAt: 1
    } as any
  })
  await waitFor(() => B.eng.host.findApproval('ap1') === chatId, 'B espelha a aprovação')
  await B.eng.host.sendCommand(chatId, 'approval', { requestId: 'ap1', decision: 'allow' })
  assert.ok(logA.some((x) => x.approve === 'ap1' && x.d === 'allow'))

  // queda do host: tolerância → "caiu" → host offline → B assume
  srv.setRefuseConnections(A.eng.deviceId, true)
  srv.dropDevice(A.eng.deviceId)
  await waitFor(() => B.eng.host.mode(chatId) === 'host-offline', 'B vê o host offline')
  await waitFor(
    () => B.events.some((e) => e.type === 'sync-notice' && /caiu/.test(e.text)),
    'aviso "caiu"'
  )
  await assert.rejects(
    B.eng.host.sendCommand(chatId, 'send', { sessionId, text: 'x', attachments: [], skills: [] }),
    /offline/
  )
  const info = await B.eng.takeover(chatId, { mode: 'next_turn' })
  assert.equal(info.host?.self, true)
  assert.equal(B.eng.host.mode(chatId), 'local')
  srv.setRefuseConnections(A.eng.deviceId, false)
  await waitFor(() => A.eng.host.mode(chatId) === 'remote', 'A volta como controle remoto')
  A.eng.destroy()
  B.eng.destroy()
})

test('conta: trocar senha, nova chave de recuperação e desbloqueio pela chave', async () => {
  const email = `u${++emailN}-${Date.now()}@teste.dev`
  await srv.createAccount({ email, password: PASSWORD })
  const A = device('A')
  await login(A, email)
  await settled(A)
  await assert.rejects(A.eng.changePassword('curta'), /10 caracteres/)
  await A.eng.changePassword('uma senha nova bem longa')
  const { recoveryKey } = await A.eng.newRecoveryKey()
  assert.match(recoveryKey, /^([0-9A-Z]{4}-){8}[0-9A-Z]{4}$/)
  // outro dispositivo: senha antiga falha, nova funciona
  const B = device('B')
  await B.eng.init()
  await B.eng.requestCode(email)
  await B.eng.verifyCode(email, srv.lastCode(email)!)
  await assert.rejects(B.eng.unlock(PASSWORD, true), /incorreta/)
  await B.eng.unlock('uma senha nova bem longa', true)
  assert.equal(B.eng.phase(), 'ready')
  // C: chave de recuperação → senha nova obrigatória
  const C = device('C')
  await C.eng.init()
  await C.eng.requestCode(email)
  await C.eng.verifyCode(email, srv.lastCode(email)!)
  await assert.rejects(
    C.eng.unlockWithRecovery(recoveryKey.slice(0, -1) + 'Z', 'terceira senha longa', true),
    /incorreta/
  )
  await C.eng.unlockWithRecovery(recoveryKey.toLowerCase(), 'terceira senha longa', true)
  assert.equal(C.eng.phase(), 'ready')
  // A continua funcionando (a DEK não muda)
  addProvider(A.conn, { name: 'Depois da troca' })
  await settled(A)
  await waitFor(
    () => C.conn.prepare("SELECT 1 FROM providers WHERE name = 'Depois da troca'").get(),
    'C recebe'
  )
})

test('cursor expirado (410) → resync completo; keys.reset volta a "definir senha" sem derrubar a sessão', async () => {
  const email = await newAccount()
  const A = device('A')
  addProvider(A.conn, { id: 'pa', name: 'Fica' })
  addProvider(A.conn, { id: 'pb', name: 'Some' })
  await login(A, email)
  await settled(A)
  const B = device('B')
  await login(B, email)
  await settled(B)
  B.eng.stop()
  A.conn.prepare("DELETE FROM providers WHERE id = 'pb'").run()
  A.conn.prepare("UPDATE providers SET name = 'Fica (editado)' WHERE id = 'pa'").run()
  await settled(A)
  const uid = srv.userIdOf(email)!
  srv.setTombstoneFloor(uid, Math.max(...srv.records(uid).map((r: any) => r.seq)))
  B.eng.start()
  await waitFor(
    () => !B.conn.prepare("SELECT 1 FROM providers WHERE id = 'pb'").get(),
    'B apaga o que sumiu online (resync)'
  )
  assert.equal(
    (B.conn.prepare("SELECT name FROM providers WHERE id = 'pa'").get() as any).name,
    'Fica (editado)'
  )

  // keys.reset: código fresco + POST /keys/reset
  const token = (B.eng as any).tokens.access_token
  await fetch(`${srv.url}/api/v1/auth/reauth/request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ purpose: 'reset_keys' })
  })
  const r = await fetch(`${srv.url}/api/v1/keys/reset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ code: srv.lastCode(email) })
  })
  assert.equal(r.status, 204)
  await waitFor(() => A.eng.phase() === 'keys-not-ready', 'A volta a "definir senha"')
  await sleep(300)
  assert.equal(
    A.eng.status().account?.email,
    email,
    'sessão mantida (4403 logo depois do reset não desloga)'
  )
  assert.ok(A.conn.prepare("SELECT 1 FROM providers WHERE id = 'pa'").get(), 'dados locais ficam')
})
