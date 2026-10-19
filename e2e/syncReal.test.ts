/* eslint-disable @typescript-eslint/no-explicit-any */
// Fumaça de integração contra o servidor de sync REAL (../ClearChatWebsite/backend), sem Electron:
// dois "dispositivos" (motor do sync + SQLite em memória) na mesma conta. Pulado automaticamente sem
// CLEARCHAT_SYNC_TEST_URL.
//
// Uso (backend com MAIL_BACKEND=console gravando o log num arquivo):
//   CLEARCHAT_SYNC_TEST_URL=http://127.0.0.1:8100 CLEARCHAT_SYNC_TEST_MAIL_LOG=/caminho/api.log \
//     node --import ./e2e/ts-hooks.mjs --test e2e/syncReal.test.ts
//
// Cobre: cadastro por código + setup de chaves (como o site faz), login por código nos dois
// dispositivos, desbloqueio, push/pull de provedor + chat + mensagens, edição LWW nos dois sentidos,
// host de execução (replay vira host) + comando remoto relayed e executado no host, e divergência.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { SCHEMA } from '../src/main/dbSchema'
import { ensureMemorySchema } from '../src/main/memory/schema'
import { ensureSearchIndex } from '../src/main/searchIndex'
import { SyncEngine } from '../src/main/sync/engine'
import type { RunnerAdapter } from '../src/main/sync/host'
import {
  aadWrap,
  b64u,
  deriveSubkeys,
  keyProof,
  newPasswordWrap,
  randomBytesU8,
  recoveryKek,
  wrapDek
} from '../src/main/sync/crypto'

const URL_ = process.env.CLEARCHAT_SYNC_TEST_URL
const MAIL_LOG = process.env.CLEARCHAT_SYNC_TEST_MAIL_LOG
const skip =
  !URL_ || !MAIL_LOG ? 'defina CLEARCHAT_SYNC_TEST_URL e CLEARCHAT_SYNC_TEST_MAIL_LOG' : false
const PASSWORD = 'senha de integração bem longa'
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const engines: SyncEngine[] = []
after(() => {
  for (const e of engines) e.destroy()
})

async function waitFor<T>(fn: () => T | Promise<T>, what: string, ms = 15_000): Promise<T> {
  const t0 = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}`)
    await sleep(80)
  }
}

/** Último código enviado ao e-mail (MAIL_BACKEND=console grava no log do servidor). */
async function codeFor(email: string, after = 0): Promise<string> {
  return waitFor(() => {
    const lines = readFileSync(MAIL_LOG!, 'utf8').split('\n').slice(after)
    let code = ''
    for (const l of lines) {
      const m = new RegExp(
        `para ${email.replace(/[.+]/g, '\\$&')} — Seu código ClearChat: (\\d{6})`
      ).exec(l)
      if (m) code = m[1]
    }
    return code
  }, `código para ${email}`)
}
const logLines = (): number => readFileSync(MAIL_LOG!, 'utf8').split('\n').length

async function rest(method: string, path: string, body?: unknown, token?: string): Promise<any> {
  const r = await fetch(URL_ + path, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: body !== undefined ? JSON.stringify(body) : undefined
  })
  const text = await r.text()
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${text}`)
  return text ? JSON.parse(text) : null
}

/** Cadastro como o site faz: código por e-mail + DEK/wraps/verifier gerados no cliente. */
async function signup(email: string): Promise<void> {
  const n0 = logLines()
  await rest('POST', '/api/v1/auth/signup/start', { email, name: 'Integração' })
  const code = await codeFor(email, n0 - 1)
  const auth = await rest('POST', '/api/v1/auth/signup/verify', {
    email,
    code,
    device: { name: 'site', platform: 'web', client: 'web', app_version: 'teste', can_host: false }
  })
  const dek = randomBytesU8(32)
  const userId = auth.user.id
  const password = await newPasswordWrap(userId, dek, PASSWORD)
  const salt = randomBytesU8(16)
  const kek = recoveryKek(randomBytesU8(20), salt)
  await rest(
    'POST',
    '/api/v1/keys/setup',
    {
      password,
      recovery: {
        kdf: { alg: 'hkdf-sha256' },
        salt: b64u(salt),
        wrap: wrapDek(kek, dek, aadWrap(userId, 'recovery'))
      },
      verifier: keyProof(deriveSubkeys(dek)).verifier
    },
    auth.access_token
  )
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

function device(
  name: string,
  runner: RunnerAdapter | null = null
): { conn: Database.Database; eng: SyncEngine } {
  const conn = newDb()
  const listeners = new Set<(e: any) => void>()
  const secrets = new Map<string, string>()
  const eng = new SyncEngine({
    conn,
    emit: (e) => {
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
    appVersion: 'teste',
    deviceName: name,
    platform: 'linux',
    runner,
    envUrl: URL_!,
    timing: {
      pollMs: 50,
      pushDebounceMs: 30,
      retryMs: 300,
      ws: { backoffBaseMs: 100, backoffMaxMs: 600 }
    },
    log: process.env.SYNC_DEBUG ? (...a) => console.log(`[${name}]`, ...a) : () => {}
  })
  engines.push(eng)
  return { conn, eng }
}

async function login(d: { eng: SyncEngine }, email: string): Promise<void> {
  await d.eng.init()
  const n0 = logLines()
  await d.eng.requestCode(email)
  await d.eng.verifyCode(email, await codeFor(email, n0 - 1))
  await d.eng.unlock(PASSWORD, true)
}

const settled = (d: { conn: Database.Database; eng: SyncEngine }, what: string): Promise<boolean> =>
  waitFor(
    () =>
      d.eng.phase() === 'ready' &&
      d.eng.pendingCount() === 0 &&
      (d.conn.prepare('SELECT COUNT(*) AS n FROM sync_outbox').get() as any).n === 0,
    what
  )

function addChat(conn: Database.Database, title: string): { chatId: string; sessionId: string } {
  const chatId = randomUUID()
  const sessionId = randomUUID()
  conn
    .prepare(
      'INSERT INTO chats (id, title, config_json, main_session_id, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1)'
    )
    .run(chatId, title, JSON.stringify({ model: 'm', cwd: '/x', enabledTools: [] }), sessionId)
  conn
    .prepare(
      "INSERT INTO sessions (id, chat_id, depth, model, title, status, created_at) VALUES (?, ?, 0, 'm', 'Principal', 'idle', 1)"
    )
    .run(sessionId, chatId)
  return { chatId, sessionId }
}

function addMessage(
  conn: Database.Database,
  sessionId: string,
  role: string,
  content: string
): void {
  const seq = (
    conn
      .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS s FROM messages WHERE session_id = ?')
      .get(sessionId) as any
  ).s
  conn
    .prepare(
      'INSERT INTO messages (id, session_id, seq, message_json, meta_json, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(randomUUID(), sessionId, seq, JSON.stringify({ role, content }), '{}', Date.now())
}

const texts = (conn: Database.Database, sessionId: string): string[] =>
  (
    conn
      .prepare('SELECT message_json FROM messages WHERE session_id = ? ORDER BY seq')
      .all(sessionId) as any[]
  ).map((r) => JSON.parse(r.message_json).content)

function stubRunner(log: any[]): RunnerAdapter {
  const no = (): never => {
    throw new Error('não usado')
  }
  return {
    busyChats: () => new Set(),
    send: async (sessionId, text) => {
      log.push({ sessionId, text })
      return { queued: false }
    },
    forceSend: no,
    removeQueued: no,
    getQueue: () => [],
    takeChatQueues: () => [],
    stop: async () => {},
    stopChat: async () => {},
    stopSubagents: async () => {},
    approve: no,
    smartOverride: no,
    answerQuestion: no,
    cancelQuestion: async () => {},
    retry: no,
    cancelRetry: no,
    regenerate: async () => {},
    editMessage: no,
    deleteMessage: async () => {},
    compact: () => ({ scheduled: false }),
    extractMemory: async () => ({ created: 0, updated: 0, deleted: 0, changes: [] }),
    approvals: () => [],
    questions: () => [],
    retries: () => [],
    processes: () => [],
    skillsFor: async () => []
  }
}

test(
  'servidor real: cadastro, login nos dois dispositivos, push/pull, host + comando remoto, divergência',
  { skip },
  async () => {
    const email = `integ-${Date.now()}@teste.dev`
    await signup(email)
    const log: any[] = []
    const A = device('PC (integração)', stubRunner(log))
    A.conn
      .prepare(
        "INSERT INTO providers (id, name, base_url, kind, api_key, headers_json, created_at) VALUES ('p1', 'OR', 'https://openrouter.ai/api/v1', 'openrouter', 'k-a', '{}', 1)"
      )
      .run()
    const { chatId, sessionId } = addChat(A.conn, 'Chat real')
    addMessage(A.conn, sessionId, 'user', 'olá servidor real')
    await login(A, email)
    await settled(A, 'A enviou tudo')
    await waitFor(() => A.eng.chatInfo(chatId).host?.self, 'A virou host (replay)')

    const B = device('Notebook (integração)', stubRunner([]))
    await login(B, email)
    await settled(B, 'B baixou')
    assert.equal(
      (B.conn.prepare("SELECT api_key FROM providers WHERE id = 'p1'").get() as any)?.api_key,
      'k-a'
    )
    assert.deepEqual(texts(B.conn, sessionId), ['olá servidor real'])

    // LWW nos dois sentidos
    B.conn.prepare("UPDATE providers SET name = 'OpenRouter (de B)' WHERE id = 'p1'").run()
    await settled(B, 'B enviou')
    await waitFor(
      () =>
        (A.conn.prepare("SELECT name FROM providers WHERE id = 'p1'").get() as any).name ===
        'OpenRouter (de B)',
      'A recebeu'
    )

    // host + comando remoto
    await waitFor(() => B.eng.host.mode(chatId) === 'remote', 'B é controle remoto')
    const r = await B.eng.host.sendCommand(chatId, 'send', {
      sessionId,
      text: 'do notebook',
      attachments: [],
      skills: [],
      createdAt: Date.now()
    })
    assert.equal(r.status, 'accepted')
    assert.deepEqual(log, [{ sessionId, text: 'do notebook' }])

    // janela do host: A grava dentro da janela; B recebe
    await A.eng.host.ensureWindow(chatId, 'run')
    addMessage(A.conn, sessionId, 'assistant', 'resposta do host')
    await waitFor(
      () => texts(B.conn, sessionId).includes('resposta do host'),
      'B recebeu a resposta do host'
    )

    // divergência: B offline + A online → divergente; B mantém a sua
    B.eng.stop()
    addMessage(B.conn, sessionId, 'user', 'offline em B')
    addMessage(A.conn, sessionId, 'user', 'online em A')
    await settled(A, 'A enviou')
    B.eng.start()
    await waitFor(() => B.eng.chatInfo(chatId).diverged?.self, 'B detecta a divergência', 20_000)
    await B.eng.resolveDivergence(chatId, 'local')
    await waitFor(
      () => {
        const t = texts(A.conn, sessionId)
        return t.includes('offline em B') && !t.includes('online em A')
      },
      'A recebe a versão escolhida (a outra foi apagada)',
      20_000
    )
  }
)
