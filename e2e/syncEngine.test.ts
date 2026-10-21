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
import { randomBytes, randomUUID } from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { REMOTE_FS_LIMITS } from '../src/shared/remoteFs'
import { SCHEMA } from '../src/main/dbSchema'
import { ensureMemorySchema } from '../src/main/memory/schema'
import { ensureSearchIndex } from '../src/main/searchIndex'
import { ensureSyncSchema } from '../src/main/sync/schema'
import {
  applyRemote,
  buildLocal,
  merge3,
  rowMessage,
  sameJson,
  sameRecordPlain
} from '../src/main/sync/records'
import { outdatedHosts, SyncEngine } from '../src/main/sync/engine'
import { EDIT_NEEDS_UPDATE, type RunnerAdapter } from '../src/main/sync/host'
import { activePath, resolveParents } from '../src/shared/branches'
import type { AgentEvent, Session } from '../src/shared/types'
import { trackFailure, type SubFailure } from '../src/renderer/src/lib/subFailures'
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
  opts: {
    runner?: RunnerAdapter
    conn?: Database.Database
    server?: FakeSyncServer
    appVersion?: string
  } = {}
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
    appVersion: opts.appVersion ?? 'test',
    deviceName: name,
    platform: 'linux',
    runner: opts.runner ?? null,
    envUrl: (opts.server ?? srv).url,
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

// records/fetch com orçamento de página (§7.2): o que passar do orçamento volta `omitted` de novo.
function omittedChange(id: string, rev = 1): any {
  return { seq: rev, type: 'memory', id, scope: null, rev, deleted: false, omitted: true }
}
const fakeEnv = (id: string): any => ({ v: 1, alg: 'x', n: id, ct: id })
function stubFetch(d: Dev, rounds: ((items: { type: string; id: string }[]) => any[])[]): any[][] {
  const calls: any[][] = []
  ;(d.eng as any).http.post = async (path: string, body: any) => {
    assert.equal(path, '/api/v1/records/fetch')
    calls.push(body.items.map((x: any) => x.id))
    const fn = rounds[calls.length - 1]
    assert.ok(fn, `chamada inesperada a records/fetch (${calls.length})`)
    return { records: fn(body.items) }
  }
  return calls
}

test('records/fetch: repete só os que voltaram omitted até não sobrar nenhum', async () => {
  const d = device('omit-loop')
  const changes = [
    omittedChange('a'),
    omittedChange('b'),
    omittedChange('c', 2),
    omittedChange('d')
  ]
  const calls = stubFetch(d, [
    // 1ª: orçamento estoura depois de "a"; "d" mudou de revisão (não repete)
    (items) =>
      items.map((it) =>
        it.id === 'a'
          ? { ...omittedChange('a'), omitted: undefined, env: fakeEnv('a') }
          : it.id === 'd'
            ? { ...omittedChange('d', 5) }
            : { ...omittedChange(it.id, it.id === 'c' ? 2 : 1) }
      ),
    // 2ª: o resto vem com payload
    (items) =>
      items.map((it) => ({
        ...omittedChange(it.id, it.id === 'c' ? 2 : 1),
        omitted: undefined,
        env: fakeEnv(it.id)
      }))
  ])
  await (d.eng as any).fillOmitted(changes)
  assert.deepEqual(calls, [
    ['a', 'b', 'c', 'd'],
    ['b', 'c']
  ])
  for (const c of changes.slice(0, 3)) {
    assert.equal(c.omitted, undefined, `${c.id} preenchido`)
    assert.deepEqual(c.env, fakeEnv(c.id))
  }
  assert.equal(changes[3].omitted, true)
  assert.equal(changes[3].env, undefined)
})

test('records/fetch: rodada sem payload novo para (sem laço) e mantém omitted', async () => {
  const d = device('omit-guard')
  const changes = [omittedChange('a'), omittedChange('b'), omittedChange('c')]
  const calls = stubFetch(d, [
    (items) =>
      items.map((it) =>
        it.id === 'a'
          ? { ...omittedChange('a'), omitted: undefined, env: fakeEnv('a') }
          : omittedChange(it.id)
      ),
    // servidor fora do contrato: nada de payload → desiste em vez de repetir para sempre
    (items) => items.map((it) => omittedChange(it.id))
  ])
  await (d.eng as any).fillOmitted(changes)
  assert.deepEqual(calls, [
    ['a', 'b', 'c'],
    ['b', 'c']
  ])
  assert.deepEqual(changes[0].env, fakeEnv('a'))
  for (const c of changes.slice(1)) {
    assert.equal(c.omitted, true)
    assert.equal(c.env, undefined)
  }
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

test('PC novo: subagente que falhou há tempo não vira falha pendente; falha ao vivo de outro aparelho sim', async () => {
  const email = await newAccount()
  const A = device('PC')
  const { chatId, sessionId } = addChat(A.conn, 'Com subagente que falhou')
  const subId = randomUUID()
  A.conn
    .prepare(
      `INSERT INTO sessions (id, chat_id, parent_session_id, parent_tool_call_id, depth, model, title, task, status, created_at)
       VALUES (?, ?, ?, 'tc1', 1, 'fake/m', 'Pesquisa', 'pesquisar', 'error', 2)`
    )
    .run(subId, chatId, sessionId)
  await login(A, email)
  await settled(A)

  // renderer do PC novo: aplica os session-created/updated como o store (applyEvent)
  const B = device('PC novo')
  const ui = { sessions: {} as Record<string, Session>, failures: {} as Record<string, SubFailure> }
  let replayed = 0
  const replay = (): void => {
    for (; replayed < B.events.length; replayed++) {
      const e = B.events[replayed]
      if (e.type !== 'session-created' && e.type !== 'session-updated') continue
      const prev = ui.sessions[e.session.id]
      ui.failures = trackFailure(ui.failures, prev, e.session, { kind: 'new' })
      ui.sessions[e.session.id] = e.session
    }
  }
  await login(B, email)
  await settled(B)
  replay()
  assert.equal(
    (B.conn.prepare('SELECT status FROM sessions WHERE id = ?').get(subId) as any).status,
    'error',
    'o status gravado vem como está (o card do delegate mostra a falha)'
  )
  assert.ok(ui.sessions[subId], 'o download emitiu session-updated da subsessão')
  assert.deepEqual(ui.failures, {}, 'falha antiga não deixa o chat vermelho nem o aviso')

  // ao vivo: A volta a rodar o subagente e ele falha de novo → B vê a transição
  A.conn.prepare("UPDATE sessions SET status = 'running' WHERE id = ?").run(subId)
  await synced(A, B)
  await waitFor(
    () => (replay(), ui.sessions[subId]?.status !== 'error'),
    'B vê o subagente rodando'
  )
  A.conn.prepare("UPDATE sessions SET status = 'error' WHERE id = ?").run(subId)
  await synced(A, B)
  await waitFor(() => (replay(), ui.failures[subId]), 'B registra a falha nova')
  assert.equal(ui.failures[subId].seen, false, 'chat fechado → vermelho na sidebar')
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

// espia os POSTs do motor: corpo copiado no envio + resposta
interface PostCall {
  path: string
  body: any
  res?: any
}
function spyPosts(d: Dev): PostCall[] {
  const calls: PostCall[] = []
  const http = (d.eng as any).http
  const orig = http.post.bind(http)
  http.post = async (path: string, body?: any, auth?: boolean) => {
    const c: PostCall = {
      path,
      body: body === undefined ? undefined : JSON.parse(JSON.stringify(body))
    }
    calls.push(c)
    c.res = await orig(path, body, auth)
    return c.res
  }
  return calls
}
const contentPushes = (calls: PostCall[], chatId: string): PostCall[] =>
  calls.filter((c) => c.path === '/api/v1/sync/push' && c.body?.chat_bases?.[chatId] !== undefined)
const resolveCalls = (calls: PostCall[]): PostCall[] =>
  calls.filter((c) => c.path.endsWith('/divergence/resolve'))
function addMessages(conn: Database.Database, sessionId: string, n: number, prefix: string): void {
  conn.transaction(() => {
    for (let i = 0; i < n; i++) addMessage(conn, sessionId, 'user', `${prefix} ${i}`)
  })()
}

test('push em vários lotes do mesmo chat: o 2º lote (da outbox, após reinício) leva a base do aceite do 1º', async () => {
  const email = await newAccount()
  const A = device('A')
  const { chatId, sessionId } = addChat(A.conn, 'Grande')
  addMessage(A.conn, sessionId, 'user', 'início')
  await login(A, email)
  await settled(A)
  A.eng.stop()
  addMessages(A.conn, sessionId, 620, 'm')
  const eng = A.eng as any
  const batches = (await eng.buildBatches()).filter((b: any) => b.kind === 'content')
  assert.equal(batches.length, 2, '620 mensagens → 2 lotes (≤ 500)')
  const base0 = eng.chatRow(chatId).base_head
  assert.ok(base0 > 0)
  for (const b of batches)
    A.conn
      .prepare(
        'INSERT INTO sync_outbox (push_id, kind, chat_id, body, meta, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(
        b.body.push_id,
        b.kind,
        chatId,
        JSON.stringify(b.body),
        JSON.stringify(b.meta),
        Date.now()
      )
  const calls = spyPosts(A)
  // 1º lote aceito; o app "reinicia" com o 2º ainda na outbox (gravado com a base antiga)
  const row1 = A.conn
    .prepare('SELECT * FROM sync_outbox WHERE push_id = ?')
    .get(batches[0].body.push_id)
  assert.equal(await eng.sendBatch(row1), true)
  const head1 = calls[0].res.chat_heads[chatId]
  assert.ok(head1 > base0)
  assert.equal(eng.chatRow(chatId).base_head, head1)
  const row2 = A.conn
    .prepare('SELECT body FROM sync_outbox WHERE push_id = ?')
    .get(batches[1].body.push_id) as any
  assert.equal(JSON.parse(row2.body).chat_bases[chatId], base0, 'gravado com a base da montagem')
  A.eng.start()
  await settled(A)
  const pushes = contentPushes(calls, chatId)
  assert.equal(pushes.length, 2)
  assert.equal(pushes[0].body.chat_bases[chatId], base0)
  assert.equal(pushes[1].body.chat_bases[chatId], head1, '2º lote com a base devolvida pelo 1º')
  assert.equal(A.eng.chatInfo(chatId).diverged, null, 'sem divergência falsa')
  const uid = srv.userIdOf(email)!
  assert.equal(
    srv.records(uid).filter((r: any) => r.type === 'message' && r.scope === chatId && !r.deleted)
      .length,
    621
  )
  A.eng.destroy()
})

test('divergência: manter local com mais de 500 itens → resolve com o 1º pedaço, o resto pelo push normal', async () => {
  const email = await newAccount()
  const A = device('A')
  const { chatId, sessionId } = addChat(A.conn, 'Divergente grande')
  addMessage(A.conn, sessionId, 'user', 'base')
  await login(A, email)
  await settled(A)
  const B = device('B')
  await login(B, email)
  await settled(B)
  B.eng.stop()
  addMessages(B.conn, sessionId, 649, 'offline em B')
  addMessage(A.conn, sessionId, 'assistant', 'online em A')
  await settled(A)
  B.eng.start()
  await waitFor(() => B.eng.chatInfo(chatId).diverged?.self, 'B detecta a divergência')
  const calls = spyPosts(B)
  await B.eng.resolveDivergence(chatId, 'local')
  const res = resolveCalls(calls)
  assert.equal(res.length, 1)
  const first = res[0].body.items as any[]
  assert.equal(first.length, 500)
  // pais antes dos filhos: tombstones de mensagem, sessões, mensagens, tombstones de sessão
  assert.equal(first[0].type, 'message')
  assert.equal(first[0].deleted, true, 'tombstone da mensagem só online')
  const head = res[0].res.chat_heads[chatId]
  assert.equal(B.eng.chatInfo(chatId).diverged, null, 'divergência limpa já no resolve')
  assert.equal((B.eng as any).chatRow(chatId).base_head, head)
  assert.equal(B.eng.pendingCount() > 0, true, 'o resto ficou pendente')
  await settled(B)
  const pushes = contentPushes(calls, chatId)
  assert.ok(pushes.length >= 1)
  let base = head
  for (const p of pushes) {
    assert.equal(p.body.chat_bases[chatId], base, 'cada lote com a base do aceite anterior')
    base = p.res.chat_heads[chatId]
  }
  const ids = [...first, ...pushes.flatMap((p) => p.body.items)].map((i: any) => i.id)
  assert.equal(ids.length, 650, '649 locais + tombstone da online (nada igual reenviado)')
  assert.equal(new Set(ids).size, 650)
  assert.ok(
    pushes.flatMap((p) => p.body.items).every((i: any) => i.base_rev === 0 && !i.deleted),
    'o resto: mensagens novas (base_rev 0)'
  )
  await synced(B, A)
  await waitFor(() => texts(A.conn, sessionId).length === 650, 'A recebe a versão de B inteira')
  const t = texts(A.conn, sessionId)
  assert.equal(t[0], 'base')
  assert.ok(!t.includes('online em A'), 'versão online anterior apagada')
  assert.equal(A.eng.chatInfo(chatId).diverged, null)
  A.eng.destroy()
  B.eng.destroy()
})

test('divergência: manter local com até 500 itens → uma chamada só (nada pelo push depois)', async () => {
  const email = await newAccount()
  const A = device('A')
  const { chatId, sessionId } = addChat(A.conn, 'Divergente pequeno')
  addMessage(A.conn, sessionId, 'user', 'base')
  await login(A, email)
  await settled(A)
  const B = device('B')
  await login(B, email)
  await settled(B)
  B.eng.stop()
  addMessages(B.conn, sessionId, 3, 'offline em B')
  addMessage(A.conn, sessionId, 'assistant', 'online em A')
  await settled(A)
  B.eng.start()
  await waitFor(() => B.eng.chatInfo(chatId).diverged?.self, 'B detecta a divergência')
  const calls = spyPosts(B)
  await B.eng.resolveDivergence(chatId, 'local')
  const res = resolveCalls(calls)
  assert.equal(res.length, 1)
  assert.equal(res[0].body.items.length, 4, '3 locais + tombstone da online')
  assert.equal(B.eng.chatInfo(chatId).diverged, null)
  await settled(B)
  assert.equal(contentPushes(calls, chatId).length, 0)
  await synced(B, A)
  await waitFor(() => texts(A.conn, sessionId).length === 4, 'A recebe a versão de B')
  assert.ok(!texts(A.conn, sessionId).includes('online em A'))
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
    editBranch: async () => {},
    selectBranch: fail,
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

test('host_back: piscada na tolerância não avisa; queda (caiu) → volta avisa "voltou"', async () => {
  const s2 = await startFakeSyncServer({ hostDropGraceMs: 1500 })
  try {
    const email = `blip-${Date.now()}@teste.dev`
    await s2.createAccount({ email, password: PASSWORD })
    const loginOn = async (d: Dev): Promise<void> => {
      await d.eng.init()
      await d.eng.requestCode(email)
      await d.eng.verifyCode(email, s2.lastCode(email)!)
      await d.eng.unlock(PASSWORD, true)
    }
    const A = device('PC', { server: s2 })
    const { chatId, sessionId } = addChat(A.conn, 'Piscada')
    addMessage(A.conn, sessionId, 'user', 'oi')
    await loginOn(A)
    await settled(A)
    const B = device('Notebook', { server: s2 })
    await loginOn(B)
    await settled(B)
    await waitFor(() => B.eng.host.mode(chatId) === 'remote', 'B controle remoto')
    const notices = (): string[] =>
      B.events.flatMap((e) => (e.type === 'sync-notice' ? [e.text] : []))
    const backEvents = (): number => B.events.filter((e) => e.type === 'sync-chat-state').length
    // piscada: cai e volta dentro da tolerância → host_back, sem "caiu" nem "voltou"
    const n0 = backEvents()
    s2.dropDevice(A.eng.deviceId)
    await waitFor(
      () =>
        s2.chatState(s2.userIdOf(email)!, chatId).host.status === 'online' && backEvents() > n0 + 1,
      'A voltou da tolerância'
    )
    await sleep(300)
    const backs = (): number =>
      s2.wsLog.filter(
        (l) =>
          l.dir === 'out' && l.deviceId === B.eng.deviceId && l.frame?.event?.kind === 'host_back'
      ).length
    assert.ok(backs() >= 1, 'o servidor emitiu host_back na volta da tolerância')
    assert.ok(!notices().some((t) => /caiu|voltou/.test(t)), `sem aviso na piscada: ${notices()}`)
    assert.equal(B.eng.host.mode(chatId), 'remote')
    // queda: tolerância esgota → "caiu"; volta → "voltou"
    s2.setRefuseConnections(A.eng.deviceId, true)
    s2.dropDevice(A.eng.deviceId)
    await waitFor(() => notices().some((t) => /caiu/.test(t)), 'aviso "caiu"')
    s2.setRefuseConnections(A.eng.deviceId, false)
    await waitFor(() => notices().some((t) => /voltou a ficar online/.test(t)), 'aviso "voltou"')
    await waitFor(() => B.eng.host.mode(chatId) === 'remote', 'B volta a ser controle remoto')
  } finally {
    await s2.close()
  }
})

// ---------------- versões de mensagens (ramos, protocolo 1.2.0 — §4.3.7/§4.3.8/§8.6) ----------------

/** Mensagem com mãe explícita: null = raiz (''), undefined = legado (NULL, derivar). */
function addTreeMessage(
  conn: Database.Database,
  sessionId: string,
  role: string,
  content: string,
  parent: string | null | undefined,
  meta: Record<string, unknown> = {}
): string {
  const id = randomUUID()
  const seq = (
    conn
      .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS s FROM messages WHERE session_id = ?')
      .get(sessionId) as any
  ).s
  conn
    .prepare(
      'INSERT INTO messages (id, session_id, seq, message_json, meta_json, created_at, parent_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    .run(
      id,
      sessionId,
      seq,
      JSON.stringify({ role, content }),
      JSON.stringify(meta),
      Date.now(),
      parent === undefined ? null : parent === null ? '' : parent
    )
  return id
}

const parentCol = (conn: Database.Database, id: string): string | null =>
  (conn.prepare('SELECT parent_id FROM messages WHERE id = ?').get(id) as any)?.parent_id

const selCol = (conn: Database.Database, sid: string): any =>
  JSON.parse(
    (conn.prepare('SELECT branch_sel_json FROM sessions WHERE id = ?').get(sid) as any)
      .branch_sel_json
  )

test('ramos: parentId/branchSel ida e volta; legado sem parentId continua derivável; reenvio 0.6.x preserva', () => {
  const a = newDb()
  const b = newDb()
  const { chatId, sessionId } = addChat(a, 'Ramos')
  const u1 = addTreeMessage(a, sessionId, 'user', 'oi', null)
  const r1 = addTreeMessage(a, sessionId, 'assistant', 'resposta 1', u1)
  const r2 = addTreeMessage(a, sessionId, 'assistant', 'resposta 2', u1) // irmã de r1 (regenerar)
  const old = addTreeMessage(a, sessionId, 'user', 'de um 0.6', undefined) // legado (NULL)
  a.prepare('UPDATE sessions SET branch_sel_json = ? WHERE id = ?').run(
    JSON.stringify({ [u1]: r1 }),
    sessionId
  )

  // local → plaintext
  const pu1 = buildLocal(a, 'message', u1)!.plain
  assert.equal(pu1.parentId, null, 'raiz = null explícito')
  assert.ok('parentId' in pu1)
  assert.equal(buildLocal(a, 'message', r2)!.plain.parentId, u1)
  assert.ok(!('parentId' in buildLocal(a, 'message', old)!.plain), 'legado: parentId ausente')
  assert.deepEqual(buildLocal(a, 'session', sessionId)!.plain.branchSel, { [u1]: r1 })

  // plaintext → local (outro aparelho) e de volta
  applyRemote(b, 'chat', chatId, buildLocal(a, 'chat', chatId)!.plain, { defaultCwd: () => '/x' })
  for (const [type, id] of [
    ['session', sessionId],
    ['message', u1],
    ['message', r1],
    ['message', r2],
    ['message', old]
  ] as const) {
    const l = buildLocal(a, type, id)!
    const res = applyRemote(b, type, id, JSON.parse(JSON.stringify(l.plain)))
    assert.ok(sameJson(buildLocal(b, type, id)!.plain, l.plain), `${type} ida e volta`)
    if (type === 'session') {
      const ev = res.events.find((e) => e.type === 'session-updated') as any
      assert.deepEqual(ev.session.branchSel, { [u1]: r1 }, 'evento leva branchSel')
    }
  }
  assert.equal(parentCol(b, u1), '', 'raiz gravada como ""')
  assert.equal(parentCol(b, r2), u1)
  assert.equal(parentCol(b, old), null, 'legado continua NULL (nada derivado gravado)')
  assert.deepEqual(rowMessage(b, r2)!.parentId, u1)
  assert.equal(rowMessage(b, old)!.parentId, undefined)
  // derivado na leitura: o legado vira filho da anterior por seq (r2); a seleção aponta r1
  const msgs = [u1, r1, r2, old].map((id) => rowMessage(b, id)!)
  assert.equal(resolveParents(msgs).get(old), r2)
  assert.deepEqual(
    activePath(msgs, selCol(b, sessionId)).map((m) => m.id),
    [u1, r1]
  )
  assert.deepEqual(
    activePath(msgs, {}).map((m) => m.id),
    [u1, r2, old]
  )

  // registro de escritor < 1.2.0 sem branchSel → {}
  const plainSess = { ...buildLocal(a, 'session', sessionId)!.plain }
  delete plainSess.branchSel
  applyRemote(b, 'session', sessionId, plainSess)
  assert.deepEqual(selCol(b, sessionId), {})

  // 0.6.x regrava (edita r2 como host): o plaintext dele não tem parentId/branchSel, mas o merge
  // com a base ({...base, ...local}, §4.3) os preserva
  const base = buildLocal(a, 'message', r2)!.plain
  const oldLocal: any = { ...base, message: { role: 'assistant', content: 'editada no 0.6' } }
  delete oldLocal.parentId
  applyRemote(b, 'message', r2, { ...base, ...oldLocal })
  assert.equal(parentCol(b, r2), u1, 'parentId preservado pela base')
  const sBase = buildLocal(a, 'session', sessionId)!.plain
  const sOld: any = { ...sBase, title: 'renomeada no 0.6' }
  delete sOld.branchSel
  applyRemote(b, 'session', sessionId, { ...sBase, ...sOld })
  assert.deepEqual(selCol(b, sessionId), { [u1]: r1 }, 'branchSel preservado pela base')

  // 0.7 limpando a seleção: sempre manda branchSel ({}), então a base não ressuscita a velha
  a.prepare("UPDATE sessions SET branch_sel_json = '{}' WHERE id = ?").run(sessionId)
  const merged = { ...sBase, ...buildLocal(a, 'session', sessionId)!.plain }
  assert.deepEqual(merged.branchSel, {})
  applyRemote(b, 'session', sessionId, merged)
  assert.deepEqual(selCol(b, sessionId), {})

  // comparação local × servidor: a mãe preenchida pela migração (= a derivada) e {} não contam
  // como mudança num registro antigo; uma mãe diferente da derivada conta
  const legacyRemote: any = { ...buildLocal(a, 'message', old)!.plain }
  a.prepare('UPDATE messages SET parent_id = ? WHERE id = ?').run(r2, old) // = derivada
  assert.ok(sameRecordPlain(a, 'message', buildLocal(a, 'message', old)!.plain, legacyRemote))
  a.prepare('UPDATE messages SET parent_id = ? WHERE id = ?').run(r1, old) // ≠ derivada
  assert.ok(!sameRecordPlain(a, 'message', buildLocal(a, 'message', old)!.plain, legacyRemote))
  const legacySess: any = { ...buildLocal(a, 'session', sessionId)!.plain }
  delete legacySess.branchSel
  assert.ok(sameRecordPlain(a, 'session', buildLocal(a, 'session', sessionId)!.plain, legacySess))
})

test('ramos: copyChatAsNew remapeia mães, branchSel e subSessionId (legado continua NULL)', () => {
  const d = device('cópia')
  const conn = d.conn
  const { chatId, sessionId } = addChat(conn, 'Original')
  const u1 = addTreeMessage(conn, sessionId, 'user', 'oi', null)
  const r1 = addTreeMessage(conn, sessionId, 'assistant', 'r1', u1)
  const r2 = addTreeMessage(conn, sessionId, 'assistant', 'r2', u1)
  const legacy = addTreeMessage(conn, sessionId, 'user', 'legado', undefined)
  const subId = randomUUID()
  conn
    .prepare(
      `INSERT INTO sessions (id, chat_id, parent_session_id, parent_tool_call_id, depth, model, title, task, status, created_at)
       VALUES (?, ?, ?, 'tc1', 1, 'fake/m', 'Sub', 't', 'idle', 2)`
    )
    .run(subId, chatId, sessionId)
  const tool = addTreeMessage(conn, sessionId, 'tool', 'feito', legacy, { subSessionId: subId })
  addTreeMessage(conn, subId, 'user', 'tarefa', null)
  conn
    .prepare('UPDATE sessions SET branch_sel_json = ? WHERE id = ?')
    .run(JSON.stringify({ [u1]: r1, root: u1, [r2]: null, gone: r1 }), sessionId)

  const newChat = (d.eng as any).copyChatAsNew(chatId) as string
  const ns = (
    conn.prepare('SELECT main_session_id AS m FROM chats WHERE id = ?').get(newChat) as any
  ).m
  assert.ok(ns && ns !== sessionId)
  const rows = conn
    .prepare(
      'SELECT id, parent_id, message_json, meta_json FROM messages WHERE session_id = ? ORDER BY seq'
    )
    .all(ns) as any[]
  const byText = new Map(rows.map((r) => [JSON.parse(r.message_json).content, r]))
  const nu1 = byText.get('oi')
  const nr1 = byText.get('r1')
  const nr2 = byText.get('r2')
  assert.equal(nu1.parent_id, '', 'raiz continua raiz')
  assert.equal(nr1.parent_id, nu1.id)
  assert.equal(nr2.parent_id, nu1.id)
  assert.ok(![u1, r1, r2].includes(nu1.id))
  assert.equal(byText.get('legado').parent_id, null, 'legado continua NULL')
  assert.equal(byText.get('feito').parent_id, byText.get('legado').id)
  assert.notEqual(byText.get('feito').id, tool)
  const newSub = (
    conn.prepare('SELECT id FROM sessions WHERE chat_id = ? AND depth = 1').get(newChat) as any
  ).id
  assert.equal(
    JSON.parse(byText.get('feito').meta_json).subSessionId,
    newSub,
    'subSessionId remapeado'
  )
  assert.deepEqual(
    selCol(conn, ns),
    { [nu1.id]: nr1.id, root: nu1.id, [nr2.id]: null },
    'branchSel remapeado (entrada de fora da cópia some)'
  )
  // o original ficou intacto
  assert.equal(parentCol(conn, r1), u1)
  d.eng.destroy()
})

test('ramos: outdatedHosts — desktops que hospedam com app < 0.7.0 (lista de aparelhos)', async () => {
  const dev = (o: Partial<any>): any => ({
    id: randomUUID(),
    name: 'X',
    platform: 'linux',
    client: 'desktop',
    appVersion: '0.6.1',
    canHost: true,
    createdAt: '',
    lastSeenAt: null,
    lastIp: null,
    online: true,
    current: false,
    ...o
  })
  assert.deepEqual(
    outdatedHosts([
      dev({ name: 'PC velho', appVersion: '0.6.1' }),
      dev({ name: 'PC novo', appVersion: '0.7.0' }),
      dev({ name: 'PC mais novo', appVersion: 'v1.0.2' }),
      dev({ name: 'Eu', appVersion: '0.5.0', current: true }),
      dev({ name: 'Site', client: 'web', canHost: false, appVersion: '0.1.0' }),
      dev({ name: 'Celular', client: 'mobile', appVersion: '0.1.0' }),
      dev({ name: 'Sem host', canHost: false, appVersion: '0.6.0' }),
      dev({ name: 'Dev', appVersion: 'test' })
    ]),
    [{ name: 'PC velho', appVersion: '0.6.1' }]
  )

  // pela conta: a lista do GET /devices alimenta o status
  const email = await newAccount()
  const A = device('PC 0.7', { appVersion: '0.7.0' })
  await login(A, email)
  await settled(A)
  assert.deepEqual(A.eng.status().outdatedHosts, [])
  const B = device('PC antigo', { appVersion: '0.6.1' })
  await login(B, email)
  await settled(B)
  await A.eng.devices()
  assert.deepEqual(A.eng.status().outdatedHosts, [{ name: 'PC antigo', appVersion: '0.6.1' }])
  await B.eng.logout()
  await A.eng.devices()
  assert.deepEqual(A.eng.status().outdatedHosts, [])
  A.eng.destroy()
  B.eng.destroy()
})

test('ramos: host executa branch.edit / branch.regenerate / branch.select; recusa message.edit em mensagem do usuário', async () => {
  const email = await newAccount()
  const logA: any[] = []
  const runnerA: RunnerAdapter = {
    ...stubRunner(logA),
    regenerate: async (sid, messageId) => {
      logA.push({ regenerate: sid, messageId })
    },
    editBranch: async (id, message) => {
      logA.push({ editBranch: id, message })
    },
    selectBranch: async (id) => {
      logA.push({ select: id })
      return {} as Session
    },
    editMessage: (id, message) => {
      logA.push({ edit: id, message })
      return {} as any
    }
  }
  const A = device('Host ramos', { runner: runnerA })
  const { chatId, sessionId } = addChat(A.conn, 'Ramos remoto')
  const u1 = addTreeMessage(A.conn, sessionId, 'user', 'oi', null)
  const a1 = addTreeMessage(A.conn, sessionId, 'assistant', 'olá', u1)
  const other = addChat(A.conn, 'Outro')
  const foreign = addTreeMessage(A.conn, other.sessionId, 'user', 'de outro chat', null)
  await login(A, email)
  await settled(A)
  await waitFor(() => A.eng.chatInfo(chatId).host?.self, 'A virou host')
  const purposes: string[] = []
  const kinds: string[] = []
  const host = A.eng.host as any
  const ensure = host.ensureWindow.bind(host)
  host.ensureWindow = (c: string, p: string) => {
    purposes.push(p)
    return ensure(c, p)
  }
  const exec = host.execute.bind(host)
  host.execute = (c: string, k: string, p: any) => {
    kinds.push(k)
    return exec(c, k, p)
  }
  const B = device('Remoto ramos', { runner: stubRunner([]) })
  await login(B, email)
  await settled(B)
  await waitFor(() => B.eng.host.mode(chatId) === 'remote', 'B é controle remoto')
  const send = (kind: string, p: Record<string, unknown>): Promise<any> =>
    B.eng.host.sendCommand(chatId, kind, p)
  const waitIdle = (): Promise<unknown> =>
    waitFor(() => !host.windows.has(chatId), 'janela fechada', 10_000)

  const msg = { role: 'user', content: 'oi editado' }
  assert.equal((await send('branch.edit', { messageId: u1, message: msg })).status, 'accepted')
  assert.deepEqual(logA.at(-1), { editBranch: u1, message: msg })
  assert.equal(purposes.at(-1), 'run')
  await waitIdle()

  await send('branch.regenerate', { sessionId, messageId: a1 })
  assert.deepEqual(logA.at(-1), { regenerate: sessionId, messageId: a1 })
  assert.equal(purposes.at(-1), 'run')
  await waitIdle()

  await send('branch.select', { messageId: a1 })
  assert.deepEqual(logA.at(-1), { select: a1 })
  assert.equal(purposes.at(-1), 'edit')
  await waitIdle()

  // `regenerate` (sem prefixo): o controle remoto ≥ 1.2.0 manda branch.regenerate; um antigo que
  // mande `regenerate` também vira regenerar em ramo do último turno no host
  await send('regenerate', { sessionId })
  assert.equal(kinds.at(-1), 'branch.regenerate', 'remoto nunca manda o regenerate antigo')
  assert.deepEqual(logA.at(-1), { regenerate: sessionId, messageId: undefined })
  await waitIdle()
  const n = logA.length
  assert.deepEqual(await (A.eng.host as any).execute(chatId, 'regenerate', { sessionId }), {})
  assert.deepEqual(logA.at(-1), { regenerate: sessionId, messageId: undefined })
  assert.equal(logA.length, n + 1)
  await waitIdle()

  // message.edit numa mensagem digitada na sessão principal → recusado ("atualize o app"), sem janela
  const before = purposes.length
  await assert.rejects(send('message.edit', { messageId: u1, message: msg }), (e: Error) => {
    assert.equal(e.message, EDIT_NEEDS_UPDATE)
    assert.match(e.message, /atualize/)
    return true
  })
  assert.equal(purposes.length, before, 'recusa não abre janela')
  assert.ok(!logA.some((x) => x.edit === u1))
  // mensagem do assistente continua com edição no lugar
  await send('message.edit', { messageId: a1, message: { role: 'assistant', content: 'x' } })
  assert.equal(logA.at(-1).edit, a1)
  assert.equal(purposes.at(-1), 'edit')
  await waitIdle()
  // validações: mensagem de outro chat, branch.edit numa resposta
  await assert.rejects(send('branch.select', { messageId: foreign }), /não pertence/)
  await assert.rejects(send('branch.edit', { messageId: a1, message: msg }), /principal/)
  A.eng.destroy()
  B.eng.destroy()
})

// ---------------- arquivos do host (fs.list / fs.read, protocolo 1.3.0 — §8.6) ----------------

test('arquivos do host: fs.list / fs.read com as regras de raiz do chat, pedaços, teto, host offline', async () => {
  const TMP = realpathSync(mkdtempSync(join(tmpdir(), 'cc-remotefs-')))
  const ROOT = join(TMP, 'proj')
  const OUT = join(TMP, 'fora')
  mkdirSync(join(ROOT, 'docs'), { recursive: true })
  mkdirSync(OUT, { recursive: true })
  writeFileSync(join(ROOT, 'leia.md'), '# Olá do host\n')
  writeFileSync(join(ROOT, 'docs', 'nota.txt'), 'nota')
  // incompressível: o pedaço cheio (512 KiB) precisa caber no teto do remote.result do servidor
  const big = randomBytes(1_300_000)
  writeFileSync(join(ROOT, 'grande.bin'), big)
  writeFileSync(join(OUT, 'segredo.txt'), 'não pode')
  symlinkSync(join(OUT, 'segredo.txt'), join(ROOT, 'atalho.txt'))
  symlinkSync(OUT, join(ROOT, 'link-fora'))
  // esparso de 201 MiB: o host não lê além de REMOTE_FS_LIMITS.maxFileBytes
  const sparse = join(ROOT, 'enorme.iso')
  writeFileSync(sparse, '')
  truncateSync(sparse, 201 * 1024 * 1024)
  try {
    const email = await newAccount()
    const A = device('PC host arquivos', { runner: stubRunner([]) })
    const { chatId } = addChat(A.conn, 'Arquivos')
    const setCfg = (cfg: Record<string, unknown>): void => {
      A.conn
        .prepare('UPDATE chats SET config_json = ? WHERE id = ?')
        .run(JSON.stringify({ model: 'fake/m', providerId: '', cwd: ROOT, ...cfg }), chatId)
    }
    setCfg({})
    await login(A, email)
    await settled(A)
    await waitFor(() => A.eng.chatInfo(chatId).host?.self, 'A é o host')
    const B = device('Notebook arquivos', { runner: stubRunner([]) })
    await login(B, email)
    await settled(B)
    await waitFor(() => B.eng.host.mode(chatId) === 'remote', 'B é controle remoto')
    const seenBefore = (A.conn.prepare('SELECT COUNT(*) AS n FROM sync_commands_seen').get() as any)
      .n

    // fs.list: '' = raiz do chat NO HOST, pastas primeiro
    const l = await B.eng.host.fsList(chatId, '')
    assert.ok(l.ok, JSON.stringify(l))
    if (!l.ok) return
    assert.equal(l.dir, ROOT)
    assert.equal(l.root, ROOT)
    assert.equal(l.confine, true)
    assert.equal(l.truncated, false)
    assert.deepEqual(
      l.entries.map((e) => `${e.kind}:${e.name}`),
      [
        'dir:docs',
        'dir:link-fora',
        'file:atalho.txt',
        'file:enorme.iso',
        'file:grande.bin',
        'file:leia.md'
      ]
    )
    assert.equal(l.entries.find((e) => e.name === 'grande.bin')?.size, big.length)
    const sub = await B.eng.host.fsList(chatId, 'docs')
    assert.ok(sub.ok && sub.dir === join(ROOT, 'docs') && sub.entries[0].name === 'nota.txt')
    // fora da raiz (confinado): '..', absoluto, symlink de pasta para fora
    for (const p of ['..', OUT, join(ROOT, 'link-fora'), `${ROOT}/docs/../../fora`]) {
      const r = await B.eng.host.fsList(chatId, p)
      assert.ok(!r.ok && r.reason === 'denied', `${p}: ${JSON.stringify(r)}`)
      assert.match(r.ok ? '' : r.message, /fora do diretório raiz/)
    }
    const miss = await B.eng.host.fsList(chatId, 'nao-existe')
    assert.ok(!miss.ok && miss.reason === 'missing' && /não encontrada/.test(miss.message))

    // fs.read: começo com mime; pedaços montam o arquivo; pedido grande é cortado no teto
    const md = await B.eng.host.fsRead(chatId, join(ROOT, 'leia.md'), 0, 1024)
    assert.ok(md.ok, JSON.stringify(md))
    if (!md.ok) return
    assert.equal(Buffer.from(md.data).toString(), '# Olá do host\n')
    assert.equal(md.mime, 'text/plain; charset=utf-8')
    assert.equal(md.size, Buffer.byteLength('# Olá do host\n'))
    const rel = await B.eng.host.fsRead(chatId, 'docs/nota.txt', 0, 100)
    assert.ok(rel.ok && Buffer.from(rel.data).toString() === 'nota', 'relativo à raiz do host')
    const parts: Buffer[] = []
    let off = 0
    let mtime = -1
    while (off < big.length) {
      const r = await B.eng.host.fsRead(chatId, join(ROOT, 'grande.bin'), off, 4 * 1024 * 1024)
      assert.ok(r.ok, JSON.stringify(r))
      if (!r.ok) return
      assert.ok(r.data.length <= REMOTE_FS_LIMITS.chunkBytes, 'pedaço no teto')
      assert.equal(r.offset, off)
      assert.equal(r.size, big.length)
      if (mtime < 0) mtime = r.mtime
      assert.equal(r.mtime, mtime)
      assert.equal(r.mime === undefined, off > 0, 'mime só no pedaço do começo')
      parts.push(Buffer.from(r.data))
      off += r.data.length
    }
    assert.equal(parts.length, Math.ceil(big.length / REMOTE_FS_LIMITS.chunkBytes))
    assert.ok(Buffer.concat(parts).equals(big), 'arquivo montado = original')
    const stat0 = await B.eng.host.fsRead(chatId, join(ROOT, 'grande.bin'), 0, 0)
    assert.ok(stat0.ok && stat0.data.length === 0 && stat0.size === big.length, 'length 0 = stat')
    const eof = await B.eng.host.fsRead(chatId, join(ROOT, 'grande.bin'), big.length + 10, 100)
    assert.ok(eof.ok && eof.data.length === 0, 'além do fim: vazio')

    // negados / ausentes
    const denied = async (p: string): Promise<void> => {
      const r = await B.eng.host.fsRead(chatId, p, 0, 100)
      assert.ok(!r.ok && r.reason === 'denied', `${p}: ${JSON.stringify(r)}`)
    }
    await denied(join(OUT, 'segredo.txt'))
    await denied('../fora/segredo.txt')
    await denied(join(ROOT, 'atalho.txt')) // symlink para fora
    await denied(join(ROOT, 'link-fora', 'segredo.txt'))
    for (const p of [join(ROOT, 'docs'), join(ROOT, 'nada.txt')]) {
      const r = await B.eng.host.fsRead(chatId, p, 0, 100)
      assert.ok(!r.ok && r.reason === 'missing', `${p}: ${JSON.stringify(r)}`)
    }
    const bad = await B.eng.host.fsRead(chatId, join(ROOT, 'leia.md'), -1, 10)
    assert.ok(!bad.ok && bad.reason === 'error' && /inválido/.test(bad.message))

    // teto do arquivo: nada além de 200 MiB (o pedido que cruza o teto é cortado)
    const cap = REMOTE_FS_LIMITS.maxFileBytes
    const near = await B.eng.host.fsRead(chatId, sparse, cap - 10, 1000)
    assert.ok(near.ok && near.data.length === 10 && near.size === 201 * 1024 * 1024)
    const over = await B.eng.host.fsRead(chatId, sparse, cap, 1000)
    assert.ok(!over.ok && over.reason === 'error' && /grande demais/.test(over.message))

    // sem confinamento: o mesmo que a aba Arquivos local já mostra (fora da raiz liberado)
    setCfg({ confineToRoot: false })
    const free = await B.eng.host.fsRead(chatId, join(OUT, 'segredo.txt'), 0, 100)
    assert.ok(free.ok && Buffer.from(free.data).toString() === 'não pode')
    const freeList = await B.eng.host.fsList(chatId, OUT)
    assert.ok(freeList.ok && freeList.confine === false)
    setCfg({})

    // leituras não entram no dedupe nem abrem janela (aceitas com o agente rodando)
    assert.equal(
      (A.conn.prepare('SELECT COUNT(*) AS n FROM sync_commands_seen').get() as any).n,
      seenBefore
    )
    assert.equal(A.eng.host.windowOpen(chatId), false)
    // host < 1.3.0 recusa o kind desconhecido → "atualize o app nele"
    const old = (B.eng.host as any).fsRejected(chatId, {
      status: 'rejected',
      error: 'comando desconhecido: fs.read'
    })
    assert.equal(old.reason, 'unsupported')
    assert.match(old.message, /versão antiga/)

    // host offline → "Host offline" sem ir à rede
    srv.setRefuseConnections(A.eng.deviceId, true)
    srv.dropDevice(A.eng.deviceId)
    await waitFor(() => B.eng.host.mode(chatId) === 'host-offline', 'B vê o host offline')
    const off1 = await B.eng.host.fsList(chatId, '')
    assert.ok(!off1.ok && off1.reason === 'host-offline' && off1.deviceName === 'PC host arquivos')
    const off2 = await B.eng.host.fsRead(chatId, join(ROOT, 'leia.md'), 0, 10)
    assert.ok(!off2.ok && off2.reason === 'host-offline' && /offline/.test(off2.message))
    srv.setRefuseConnections(A.eng.deviceId, false)
    A.eng.destroy()
    B.eng.destroy()
  } finally {
    rmSync(TMP, { recursive: true, force: true })
  }
})

// ---------------- preferências sincronizadas (protocolo 1.4.0) ----------------

const getSetting = (conn: Database.Database, key: string): any => {
  const r = conn.prepare('SELECT value FROM settings WHERE key = ?').get(key) as any
  return r ? JSON.parse(r.value) : undefined
}
const putSetting = (conn: Database.Database, key: string, value: unknown): void => {
  conn
    .prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    )
    .run(key, JSON.stringify(value))
}
const settingIdsOnline = (email: string): string[] =>
  srv
    .records(srv.userIdOf(email)!)
    .filter((r: any) => r.type === 'setting')
    .map((r: any) => r.id)
    .sort()

test('1.4.0: preferências globais (Smart-Approve, título automático, spill) vão e voltam; as locais não sobem', async () => {
  const email = await newAccount()
  const A = device('A')
  const pid = addProvider(A.conn, { name: 'OR', apiKey: 'k' })
  const smart = {
    environment: '172.16.1.7 é teste; produção nunca',
    acceptEditsInRoot: true,
    // 1.4.1: thinkingTokens e cache (opcionais) dentro da coleta
    capture: {
      enabled: true,
      providerId: pid,
      model: 'resumo/m',
      maxTokens: 300,
      lookback: 3,
      thinkingTokens: 3000,
      cache: false
    },
    capturePrompts: {
      prompt: 'PROMPT GLOBAL KEEP APPEND REWRITE',
      template: '{{current}} / {{user}}',
      derivePrompt: null
    }
  }
  const title = {
    providerId: pid,
    model: 'titulo/m',
    useMemory: true,
    maxTokens: 40,
    prompt: 'Dê um título.',
    thinkingTokens: 512 // 1.4.1
  }
  putSetting(A.conn, 'smartApproveDefaults', smart)
  putSetting(A.conn, 'autoTitle', title)
  putSetting(A.conn, 'toolOutputSpillChars', 12000)
  // estado do dispositivo / UI: nunca sobe
  putSetting(A.conn, 'updateDismissedVersion', '9.9.9')
  putSetting(A.conn, 'defaultCwd', '/home/a')
  putSetting(A.conn, 'skillsSettings', { locations: ['/home/a/skills'] })
  putSetting(A.conn, 'presetsSeeded', true)
  await login(A, email)
  await settled(A)
  const ids = settingIdsOnline(email)
  for (const id of ['smartApproveDefaults', 'autoTitle', 'toolOutputSpillChars'])
    assert.ok(ids.includes(id), `${id} sobe (${ids})`)
  for (const id of ['updateDismissedVersion', 'defaultCwd', 'skillsSettings', 'presetsSeeded'])
    assert.ok(!ids.includes(id), `${id} fica local`)

  const B = device('B')
  putSetting(B.conn, 'updateDismissedVersion', '1.0.0')
  await login(B, email)
  await settled(B)
  assert.deepEqual(getSetting(B.conn, 'smartApproveDefaults'), smart)
  assert.deepEqual(getSetting(B.conn, 'autoTitle'), title)
  assert.equal(getSetting(B.conn, 'toolOutputSpillChars'), 12000)
  assert.equal(getSetting(B.conn, 'updateDismissedVersion'), '1.0.0', 'local de B intacto')
  assert.equal(getSetting(B.conn, 'defaultCwd'), undefined)

  // edição em B (com o sync rodando) → A; a UI recarrega aprovações/settings
  A.events.length = 0
  putSetting(B.conn, 'smartApproveDefaults', { ...smart, environment: 'novo ambiente' })
  putSetting(B.conn, 'autoTitle', { ...title, prompt: null })
  putSetting(B.conn, 'toolOutputSpillChars', 20000)
  putSetting(B.conn, 'updateDismissedVersion', '2.0.0')
  await synced(B, A)
  await waitFor(
    () => getSetting(A.conn, 'smartApproveDefaults')?.environment === 'novo ambiente',
    'A recebe o ambiente novo'
  )
  await waitFor(() => getSetting(A.conn, 'toolOutputSpillChars') === 20000, 'A recebe o spill')
  assert.equal(getSetting(A.conn, 'autoTitle').prompt, null)
  assert.equal(getSetting(A.conn, 'updateDismissedVersion'), '9.9.9')
  const scopes = A.events.flatMap((e: any) => (e.type === 'sync-data-changed' ? e.scopes : []))
  assert.ok(scopes.includes('approvals') && scopes.includes('settings'), String(scopes))
  // remover (valor null = chave apagada) também propaga — setting nunca é tombstone
  B.conn.prepare("DELETE FROM settings WHERE key = 'autoTitle'").run()
  await synced(B, A)
  await waitFor(() => getSetting(A.conn, 'autoTitle') === undefined, 'A remove o autoTitle')
  A.eng.destroy()
  B.eng.destroy()
})

test('1.4.0: config do chat e da persona (capturedContext, acceptEditsInRoot, ambiente, coleta, prompts, juiz) vão e voltam', async () => {
  const email = await newAccount()
  const A = device('A')
  const pid = addProvider(A.conn, { name: 'OR', apiKey: 'k' })
  const { chatId } = addChat(A.conn, 'Com Smart-Approve')
  const sa = {
    providerId: pid,
    model: 'juiz/m',
    prompt: 'juiz {{tool}}',
    template: null,
    labels: { approve: 'OK', reject: 'NO', ask: 'ASK' },
    contextMessages: 4,
    timeoutS: 20,
    canDeny: true,
    judgeWhitelisted: true,
    environment: 'ambiente do chat',
    capture: {
      enabled: true,
      providerId: pid,
      model: 'resumo/m',
      maxTokens: null,
      lookback: 2,
      thinkingTokens: 1024,
      cache: false
    },
    capturePrompts: { prompt: null, template: '{{current}} {{user}}', derivePrompt: 'D' },
    // 1.4.1: tokens de pensamento e cache do prompt do juiz
    thinkingTokens: 4096,
    cache: false
  }
  const captured = {
    main: {
      text: '- só staging',
      updatedAt: 5,
      by: 'model',
      cursor: { id: 'm1', seq: 1, at: 1 },
      calls: 2,
      cost: 0.01
    },
    sessions: { sub1: { text: '- tarefa', updatedAt: 6, by: 'derived' } }
  }
  A.conn.prepare('UPDATE chats SET config_json = ? WHERE id = ?').run(
    JSON.stringify({
      model: 'fake/m',
      providerId: pid,
      cwd: '/home/a/proj',
      approvalModes: { commands: 'smart', memory_write: 'lists' },
      acceptEditsInRoot: false,
      smartApprove: sa,
      capturedContext: captured
    }),
    chatId
  )
  const presetId = randomUUID()
  A.conn
    .prepare(
      'INSERT INTO presets (id, name, description, icon, config_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    .run(
      presetId,
      'Dev',
      '',
      'code',
      JSON.stringify({ cwd: '/home/a/dev', acceptEditsInRoot: true, smartApprove: sa }),
      1,
      1
    )
  await login(A, email)
  await settled(A)
  const B = device('B')
  await login(B, email)
  await settled(B)
  const cfgB = JSON.parse(
    (B.conn.prepare('SELECT config_json FROM chats WHERE id = ?').get(chatId) as any).config_json
  )
  assert.deepEqual(cfgB.smartApprove, sa)
  assert.deepEqual(cfgB.capturedContext, captured)
  assert.equal(cfgB.acceptEditsInRoot, false)
  assert.deepEqual(cfgB.approvalModes, { commands: 'smart', memory_write: 'lists' })
  assert.notEqual(cfgB.cwd, '/home/a/proj', 'raiz do chat fica local')
  const pcfgB = JSON.parse(
    (B.conn.prepare('SELECT config_json FROM presets WHERE id = ?').get(presetId) as any)
      .config_json
  )
  assert.equal(pcfgB.acceptEditsInRoot, true)
  assert.deepEqual(pcfgB.smartApprove, sa)
  assert.notEqual(pcfgB.cwd, '/home/a/dev', 'raiz da persona fica local')
  // B muda o contexto capturado e o ambiente → A (LWW por chave da config)
  B.conn.prepare('UPDATE chats SET config_json = ? WHERE id = ?').run(
    JSON.stringify({
      ...cfgB,
      cwd: '/home/b/proj',
      acceptEditsInRoot: null,
      smartApprove: { ...sa, environment: '' },
      capturedContext: {
        ...captured,
        main: { ...captured.main, text: '- editado em B', by: 'user' }
      }
    }),
    chatId
  )
  await synced(B, A)
  await waitFor(() => {
    const c = JSON.parse(
      (A.conn.prepare('SELECT config_json FROM chats WHERE id = ?').get(chatId) as any).config_json
    )
    return c.capturedContext?.main?.text === '- editado em B' && c
  }, 'A recebe a config de B').then((c: any) => {
    assert.equal(c.smartApprove.environment, '', "'' = nenhuma (não volta para a global)")
    assert.equal(c.acceptEditsInRoot, null)
    assert.equal(c.cwd, '/home/a/proj', 'raiz local de A preservada')
  })
  A.eng.destroy()
  B.eng.destroy()
})

test('1.4.0: dispositivo que já sincronizava envia as preferências novas uma vez (o que já está online vence)', async () => {
  const email = await newAccount()
  const A = device('A')
  await login(A, email)
  await settled(A)
  const B = device('B')
  await login(B, email)
  await settled(B)
  // simula o app < 1.4.0: valores gravados sem rastreamento e sem a passada de backfill
  const legacy = (d: Dev, spill: number, env: string): void => {
    d.eng.stop()
    d.conn.prepare("DELETE FROM sync_flags WHERE k = 'on'").run()
    putSetting(d.conn, 'toolOutputSpillChars', spill)
    putSetting(d.conn, 'smartApproveDefaults', { environment: env })
    d.conn.prepare("DELETE FROM sync_state WHERE key = 'settings_backfill'").run()
    d.conn.prepare("DELETE FROM sync_dirty WHERE type = 'setting'").run()
  }
  legacy(A, 15000, 'de A')
  legacy(B, 9000, 'de B')
  assert.ok(!settingIdsOnline(email).includes('toolOutputSpillChars'))
  A.eng.start()
  await settled(A)
  await A.eng.syncNow()
  await settled(A)
  assert.ok(settingIdsOnline(email).includes('toolOutputSpillChars'), 'A enviou depois do pull')
  assert.ok(settingIdsOnline(email).includes('smartApproveDefaults'))
  // B atualiza depois: o pull traz o de A (registro online existe) e B não sobrescreve
  B.eng.start()
  await synced(B, A)
  assert.equal(getSetting(B.conn, 'toolOutputSpillChars'), 15000)
  assert.equal(getSetting(B.conn, 'smartApproveDefaults').environment, 'de A')
  assert.equal(getSetting(A.conn, 'toolOutputSpillChars'), 15000)
  // a passada é única: valor local depois disso segue o rastreamento normal (triggers)
  putSetting(B.conn, 'toolOutputSpillChars', 30000)
  await synced(B, A)
  await waitFor(() => getSetting(A.conn, 'toolOutputSpillChars') === 30000, 'A recebe o novo')
  A.eng.destroy()
  B.eng.destroy()
})

test('1.4.0: merge do primeiro login remapeia o provedor dentro de autoTitle, smartApproveDefaults e da coleta do chat', async () => {
  const email = await newAccount()
  const A = device('A')
  const pidA = addProvider(A.conn, { name: 'OpenRouter', apiKey: 'k-a' })
  await login(A, email)
  await settled(A)
  const C = device('C')
  const pidC = addProvider(C.conn, { name: 'openrouter', apiKey: 'k-c' })
  putSetting(C.conn, 'autoTitle', {
    providerId: pidC,
    model: 't/m',
    useMemory: false,
    maxTokens: 64,
    prompt: null
  })
  putSetting(C.conn, 'smartApproveDefaults', {
    environment: '',
    acceptEditsInRoot: false,
    capture: { enabled: true, providerId: pidC, model: 'r/m', maxTokens: null, lookback: 2 }
  })
  const { chatId } = addChat(C.conn, 'Chat de C')
  C.conn.prepare('UPDATE chats SET config_json = ? WHERE id = ?').run(
    JSON.stringify({
      providerId: pidC,
      model: 'x',
      cwd: '/c',
      smartApprove: {
        providerId: pidC,
        model: 'j',
        capture: { enabled: true, providerId: pidC, model: 'r/m', maxTokens: null, lookback: 2 }
      }
    }),
    chatId
  )
  await C.eng.init()
  await C.eng.requestCode(email)
  await C.eng.verifyCode(email, srv.lastCode(email)!)
  await C.eng.unlock(PASSWORD, true)
  assert.equal(C.eng.phase(), 'merge')
  await C.eng.resolveMerge('local')
  await synced(C, A)
  assert.equal(getSetting(C.conn, 'autoTitle').providerId, pidA)
  assert.equal(getSetting(C.conn, 'smartApproveDefaults').capture.providerId, pidA)
  const cfg = JSON.parse(
    (C.conn.prepare('SELECT config_json FROM chats WHERE id = ?').get(chatId) as any).config_json
  )
  assert.equal(cfg.smartApprove.providerId, pidA)
  assert.equal(cfg.smartApprove.capture.providerId, pidA)
  // e A recebe as preferências de C já com o id que existe lá
  await waitFor(() => getSetting(A.conn, 'autoTitle')?.providerId === pidA, 'A recebe autoTitle')
  assert.equal(getSetting(A.conn, 'smartApproveDefaults').capture.providerId, pidA)
  A.eng.destroy()
  C.eng.destroy()
})
