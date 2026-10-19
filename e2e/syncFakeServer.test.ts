/* eslint-disable @typescript-eslint/no-explicit-any */
// Sanidade do servidor de sync FALSO (e2e/fakes/syncServer.ts): login, push/pull, idempotência,
// conflitos, regras de conteúdo do chat (host/replay/divergência), troca de host, comandos remotos,
// tolerância de queda e blobs. Os envelopes aqui são falsos (o servidor nunca decifra).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import { startFakeSyncServer, type FakeSyncServer } from './fakes/syncServer.ts'
import { deriveSubkeys, keyProof } from '../docs/test-vectors/generate.ts'

let srv: FakeSyncServer
const PASSWORD = 'senha de teste bem longa'

before(async () => {
  srv = await startFakeSyncServer({ hostDropGraceMs: 300, commandTimeoutMs: 2000 })
})
after(async () => {
  await srv.close()
})

const env = (): any => ({
  v: 1,
  k: 1,
  n: randomBytes(12).toString('base64url'),
  c: randomBytes(40).toString('base64url')
})

async function rest(method: string, path: string, body?: any, token?: string): Promise<any> {
  const r = await fetch(srv.url + path, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: body !== undefined ? JSON.stringify(body) : undefined
  })
  const text = await r.text()
  return { status: r.status, body: text ? JSON.parse(text) : null }
}

async function login(email: string, name: string, canHost = true): Promise<any> {
  const r1 = await rest('POST', '/api/v1/auth/code/request', { email })
  assert.equal(r1.status, 202)
  const code = srv.lastCode(email)
  assert.ok(code)
  const r2 = await rest('POST', '/api/v1/auth/code/verify', {
    email,
    code,
    device: { name, platform: 'linux', client: 'desktop', app_version: 't', can_host: canHost }
  })
  assert.equal(r2.status, 200, JSON.stringify(r2.body))
  return r2.body
}

class Client {
  ws!: WebSocket
  frames: any[] = []
  private waiters: { pred: (f: any) => boolean; resolve: (f: any) => void }[] = []
  private seq = 0
  welcome: any

  static async connect(token: string, extra: any = {}): Promise<Client> {
    const c = new Client()
    c.ws = new WebSocket(srv.url.replace(/^http/, 'ws') + '/ws')
    c.ws.on('message', (d) => {
      const f = JSON.parse(String(d))
      c.frames.push(f)
      for (const w of [...c.waiters]) {
        if (w.pred(f)) {
          c.waiters.splice(c.waiters.indexOf(w), 1)
          w.resolve(f)
        }
      }
    })
    await new Promise((r, j) => {
      c.ws.once('open', r)
      c.ws.once('error', j)
    })
    c.welcome = await c.req('hello', {
      protocol: 1,
      access_token: token,
      cursor: 0,
      state_cursor: 0,
      ...extra
    })
    assert.equal(c.welcome.t, 'welcome', JSON.stringify(c.welcome))
    return c
  }

  req(t: string, fields: any = {}): Promise<any> {
    const id = String(++this.seq)
    const p = this.wait((f) => f.re === id)
    this.ws.send(JSON.stringify({ t, id, ...fields }))
    return p
  }

  /** Próximo frame que satisfaz o predicado (inclusive os já recebidos e ainda não consumidos). */
  wait(pred: (f: any) => boolean, ms = 3000): Promise<any> {
    const i = this.frames.findIndex(pred)
    if (i >= 0) return Promise.resolve(this.frames.splice(i, 1)[0])
    return new Promise((resolve, reject) => {
      const w = {
        pred,
        resolve: (f: any) => {
          clearTimeout(timer)
          this.frames.splice(this.frames.indexOf(f), 1)
          resolve(f)
        }
      }
      const timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(w), 1)
        reject(new Error('timeout esperando frame'))
      }, ms)
      this.waiters.push(w)
    })
  }

  close(): void {
    this.ws.close()
  }
}

const item = (
  type: string,
  id: string,
  scope: string | null,
  baseRev = 0,
  deleted = false
): any => ({
  type,
  id,
  scope,
  base_rev: baseRev,
  rev: baseRev + 1,
  deleted,
  ...(deleted ? {} : { env: env() }),
  blobs: []
})

test('info, login, chaves e prova de posse', async () => {
  const info = await rest('GET', '/api/info')
  assert.equal(info.status, 200)
  assert.equal(info.body.base_url, srv.url)
  assert.deepEqual(info.body.protocol.min, 1)
  assert.equal(info.body.features.captcha, null)
  const { dek } = await srv.createAccount({ email: 'k@x.io', password: PASSWORD })
  const a = await login('k@x.io', 'PC')
  assert.equal(a.keys_ready, true)
  assert.ok(a.access_token.startsWith('cca_'))
  assert.ok(a.keys.password.wrap.c)
  const bad = await rest(
    'PUT',
    '/api/v1/keys/password',
    { key_proof: randomBytes(32).toString('base64url'), password: a.keys.password },
    a.access_token
  )
  assert.equal(bad.status, 403)
  assert.equal(bad.body.error.code, 'key_proof_invalid')
  const ok = await rest(
    'PUT',
    '/api/v1/keys/password',
    { key_proof: keyProof(deriveSubkeys(dek)).key_proof, password: a.keys.password },
    a.access_token
  )
  assert.equal(ok.status, 200)
  assert.equal(ok.body.keys_rev, 2)
  // refresh rotaciona; reutilizar o antigo revoga
  const r1 = await rest('POST', '/api/v1/auth/refresh', { refresh_token: a.refresh_token })
  assert.equal(r1.status, 200)
  const r2 = await rest('POST', '/api/v1/auth/refresh', { refresh_token: a.refresh_token })
  assert.equal(r2.body.error.code, 'refresh_reused')
  const dead = await rest('GET', '/api/v1/account', undefined, r1.body.access_token)
  assert.equal(dead.status, 401)
})

test('push/pull, idempotência e conflitos', async () => {
  await srv.createAccount({ email: 'p@x.io', password: PASSWORD })
  const a = await login('p@x.io', 'PC')
  const t = a.access_token
  const push = { push_id: randomUUID(), items: [item('provider', 'prov1', null)] }
  const r1 = await rest('POST', '/api/v1/sync/push', push, t)
  assert.equal(r1.status, 200, JSON.stringify(r1.body))
  assert.equal(r1.body.results[0].seq, 1)
  const again = await rest('POST', '/api/v1/sync/push', push, t)
  assert.deepEqual(again.body, r1.body)
  const pull = await rest('GET', '/api/v1/sync/changes?since=0', undefined, t)
  assert.equal(pull.body.changes.length, 1)
  assert.equal(pull.body.head, 1)
  assert.equal(pull.body.has_more, false)
  const conflict = await rest(
    'POST',
    '/api/v1/sync/push',
    { push_id: randomUUID(), items: [item('provider', 'prov1', null)] },
    t
  )
  assert.equal(conflict.status, 409)
  assert.equal(conflict.body.error.details.conflicts[0].reason, 'rev_mismatch')
  assert.equal(conflict.body.error.details.conflicts[0].current.rev, 1)
  const del = await rest(
    'POST',
    '/api/v1/sync/push',
    { push_id: randomUUID(), items: [item('provider', 'prov1', null, 1, true)] },
    t
  )
  assert.equal(del.status, 200)
  const gone = await rest(
    'POST',
    '/api/v1/sync/push',
    { push_id: randomUUID(), items: [item('provider', 'prov1', null, 1)] },
    t
  )
  assert.equal(gone.body.error.details.conflicts[0].reason, 'gone')
  const missing = await rest(
    'POST',
    '/api/v1/sync/push',
    { push_id: randomUUID(), items: [item('memory', 'm1', 'colX')] },
    t
  )
  assert.equal(missing.body.error.details.conflicts[0].reason, 'scope_missing')
  const badType = await rest(
    'POST',
    '/api/v1/sync/push',
    { push_id: randomUUID(), items: [item('key_grant', 'g', null)] },
    t
  )
  assert.equal(badType.body.error.code, 'invalid_request')
  srv.setTombstoneFloor(srv.userIdOf('p@x.io')!, 1)
  const expired = await rest('GET', '/api/v1/sync/changes?since=0', undefined, t)
  assert.equal(expired.status, 410)
})

test('conteúdo do chat: replay vira host, janela, chat_busy, divergência e descarte', async () => {
  const { userId } = await srv.createAccount({ email: 'c@x.io', password: PASSWORD })
  const a = await login('c@x.io', 'PC')
  const b = await login('c@x.io', 'Notebook')
  const X = 'chat-1'
  // A cria o chat + sessão em replay → vira host
  const r1 = await rest(
    'POST',
    '/api/v1/sync/push',
    {
      push_id: randomUUID(),
      items: [item('chat', X, X), item('session', 's1', X)],
      chat_bases: { [X]: 0 }
    },
    a.access_token
  )
  assert.equal(r1.status, 200, JSON.stringify(r1.body))
  assert.equal(r1.body.chat_heads[X], 2)
  assert.equal(srv.chatState(userId, X).host.device_id, a.device_id)
  // sem chat_bases → inválido
  const nb = await rest(
    'POST',
    '/api/v1/sync/push',
    { push_id: randomUUID(), items: [item('message', 'm0', X)] },
    a.access_token
  )
  assert.equal(nb.body.error.code, 'invalid_request')
  // A abre janela pelo WS e grava com host_epochs
  const wa = await Client.connect(a.access_token)
  const begin = await wa.req('host.begin', { chat_id: X, epoch: null, purpose: 'run' })
  assert.equal(begin.t, 'ack', JSON.stringify(begin))
  assert.equal(begin.head, 2)
  const r2 = await rest(
    'POST',
    '/api/v1/sync/push',
    {
      push_id: randomUUID(),
      items: [item('message', 'm1', X)],
      chat_bases: { [X]: 2 },
      host_epochs: { [X]: begin.epoch }
    },
    a.access_token
  )
  assert.equal(r2.status, 200, JSON.stringify(r2.body))
  // B tenta replay com a janela aberta → chat_busy
  const busy = await rest(
    'POST',
    '/api/v1/sync/push',
    { push_id: randomUUID(), items: [item('message', 'mb', X)], chat_bases: { [X]: 3 } },
    b.access_token
  )
  assert.equal(busy.body.error.code, 'chat_busy')
  // epoch velho → not_host
  const nh = await rest(
    'POST',
    '/api/v1/sync/push',
    {
      push_id: randomUUID(),
      items: [item('message', 'm2', X)],
      chat_bases: { [X]: 3 },
      host_epochs: { [X]: begin.epoch + 5 }
    },
    a.access_token
  )
  assert.equal(nh.body.error.code, 'not_host')
  const end = await wa.req('host.end', { chat_id: X, epoch: begin.epoch })
  assert.equal(end.handover_pending, false)
  // B grava em cima de uma base velha → diverge
  const div = await rest(
    'POST',
    '/api/v1/sync/push',
    { push_id: randomUUID(), items: [item('message', 'mb', X)], chat_bases: { [X]: 2 } },
    b.access_token
  )
  assert.equal(div.body.error.code, 'chat_diverged')
  const d = div.body.error.details.diverged
  assert.equal(d.device_id, b.device_id)
  const ev = await wa.wait((f) => f.t === 'chat.state' && f.event?.kind === 'diverged')
  assert.equal(ev.diverged.divergence_id, d.divergence_id)
  // divergente: host.begin recusado
  const blocked = await wa.req('host.begin', { chat_id: X, epoch: null, purpose: 'run' })
  assert.equal(blocked.code, 'chat_diverged')
  const bad = await rest(
    'POST',
    `/api/v1/chats/${X}/divergence/resolve`,
    { divergence_id: 'x', keep: 'online' },
    a.access_token
  )
  assert.equal(bad.body.error.code, 'divergence_mismatch')
  const res = await rest(
    'POST',
    `/api/v1/chats/${X}/divergence/resolve`,
    { divergence_id: d.divergence_id, keep: 'online' },
    a.access_token
  )
  assert.equal(res.status, 200)
  assert.equal(srv.chatState(userId, X).diverged, null)
  const disc = await rest(
    'POST',
    '/api/v1/sync/push',
    { push_id: randomUUID(), items: [item('message', 'mb', X)], chat_bases: { [X]: 2 } },
    b.access_token
  )
  assert.equal(disc.body.error.code, 'divergence_discarded')
  // keep local: divergir de novo e B mantém a sua versão
  const div2 = await rest(
    'POST',
    '/api/v1/sync/push',
    { push_id: randomUUID(), items: [item('message', 'mc', X)], chat_bases: { [X]: 1 } },
    b.access_token
  )
  assert.equal(div2.body.error.code, 'chat_diverged')
  const keep = await rest(
    'POST',
    `/api/v1/chats/${X}/divergence/resolve`,
    {
      divergence_id: div2.body.error.details.diverged.divergence_id,
      keep: 'local',
      push_id: randomUUID(),
      items: [item('message', 'mc', X), item('message', 'm1', X, 1, true)]
    },
    b.access_token
  )
  assert.equal(keep.status, 200, JSON.stringify(keep.body))
  assert.equal(srv.chatState(userId, X).head, keep.body.results[1].seq)
  // apagar o chat leva todo o conteúdo; só o tombstone fica
  const delChat = await rest(
    'POST',
    '/api/v1/sync/push',
    { push_id: randomUUID(), items: [item('chat', X, X, 1, true)] },
    a.access_token
  )
  assert.equal(delChat.status, 200, JSON.stringify(delChat.body))
  const left = srv.records(userId).filter((r) => r.scope === X)
  assert.deepEqual(
    left.map((r) => [r.type, r.deleted]),
    [['chat', true]]
  )
  wa.close()
})

test('troca de host, comandos remotos, queda e tolerância', async () => {
  const { userId } = await srv.createAccount({ email: 'h@x.io', password: PASSWORD })
  const a = await login('h@x.io', 'PC')
  const b = await login('h@x.io', 'Notebook')
  const X = 'chat-h'
  const wa = await Client.connect(a.access_token)
  const wb = await Client.connect(b.access_token, { subscriptions: [X] })
  const begin = await wa.req('host.begin', { chat_id: X, epoch: null, purpose: 'run' })
  assert.equal(begin.became_host, true)
  // stream do host → inscritos
  await wa.req('stream.subscribe', { chat_ids: [] })
  wa.ws.send(
    JSON.stringify({ t: 'stream.event', chat_id: X, epoch: begin.epoch, n: 1, env: env() })
  )
  const se = await wb.wait((f) => f.t === 'stream.event')
  assert.equal(se.device_id, a.device_id)
  assert.equal(se.n, 1)
  // inscrever → resync_request ao host
  await wb.req('stream.resync', { chat_id: X })
  const rr = await wa.wait((f) => f.t === 'stream.resync_request')
  assert.equal(rr.requester_device_id, b.device_id)
  // comando remoto B → A
  const sent = await wb.req('remote.send', {
    chat_id: X,
    cmd_id: 'cmd-1',
    kind: 'send',
    env: env()
  })
  assert.equal(sent.status, 'delivered')
  const cmd = await wa.wait((f) => f.t === 'remote.command')
  assert.equal(cmd.from_device_id, b.device_id)
  await wa.req('remote.result', { chat_id: X, cmd_id: 'cmd-1', env: env() })
  const result = await wb.wait((f) => f.t === 'remote.result')
  assert.equal(result.cmd_id, 'cmd-1')
  // troca next_turn: pendente até o release
  const tk = await wb.req('host.takeover', { chat_id: X, mode: 'next_turn', confirm_pinned: false })
  assert.equal(tk.status, 'pending')
  const hr = await wa.wait((f) => f.t === 'host.handover_request')
  assert.equal(hr.to_device_id, b.device_id)
  const end = await wa.req('host.end', { chat_id: X, epoch: begin.epoch })
  assert.equal(end.handover_pending, true)
  await wa.req('host.release', {
    chat_id: X,
    epoch: begin.epoch,
    forwarded: [{ cmd_id: 'fw-1', env: env() }]
  })
  const granted = await wb.wait((f) => f.t === 'host.granted')
  assert.equal(granted.epoch, begin.epoch + 1)
  const fw = await wb.wait((f) => f.t === 'remote.command' && f.cmd_id === 'fw-1')
  assert.equal(fw.from_device_id, a.device_id)
  const revoked = await wa.wait((f) => f.t === 'host.revoked')
  assert.equal(revoked.reason, 'handover')
  assert.equal(srv.chatState(userId, X).host.device_id, b.device_id)
  // B (host) cai no meio de um comando → remote.failed host_offline; depois host_dropped
  await wa.req('remote.send', { chat_id: X, cmd_id: 'cmd-2', kind: 'stop', env: env() })
  await wb.wait((f) => f.t === 'remote.command' && f.cmd_id === 'cmd-2')
  srv.dropDevice(b.device_id)
  const failed = await wa.wait((f) => f.t === 'remote.failed')
  assert.equal(failed.code, 'host_offline')
  const grace = await wa.req('remote.send', {
    chat_id: X,
    cmd_id: 'cmd-3',
    kind: 'stop',
    env: env()
  })
  assert.equal(grace.code, 'host_offline')
  const dropped = await wa.wait(
    (f) => f.t === 'chat.state' && f.event?.kind === 'host_dropped',
    2000
  )
  assert.equal(dropped.host.status, 'offline')
  // fixado → precisa confirmar; depois assume na hora
  await wa.req('host.pin', { chat_id: X, pinned: true })
  const pinned = await wa.req('host.takeover', { chat_id: X, mode: 'force', confirm_pinned: false })
  assert.equal(pinned.code, 'host_pinned')
  const take = await wa.req('host.takeover', { chat_id: X, mode: 'force', confirm_pinned: true })
  assert.equal(take.status, 'granted')
  await wa.wait((f) => f.t === 'host.granted')
  // B volta: recebe host.revoked e o estado com host = A
  const wb2 = await Client.connect(b.access_token)
  const rv = await wb2.wait((f) => f.t === 'host.revoked')
  assert.equal(rv.reason, 'takeover')
  assert.equal(
    wb2.welcome.chat_states.find((s: any) => s.chat_id === X).host.device_id,
    a.device_id
  )
  // nova conexão do mesmo dispositivo substitui a anterior (4409)
  const closed = new Promise<number>((r) => wb2.ws.once('close', (code) => r(code)))
  const wb3 = await Client.connect(b.access_token)
  assert.equal(await closed, 4409)
  wa.close()
  wb3.close()
})

test('hello inválido, ping e blobs', async () => {
  await srv.createAccount({ email: 'b@x.io', password: PASSWORD })
  const a = await login('b@x.io', 'PC')
  const ws = new WebSocket(srv.url.replace(/^http/, 'ws') + '/ws')
  await new Promise((r) => ws.once('open', r))
  const code = new Promise<number>((r) => ws.once('close', (c) => r(c)))
  ws.send(JSON.stringify({ t: 'hello', id: '1', protocol: 1, access_token: 'cca_nope' }))
  assert.equal(await code, 4401)
  const c = await Client.connect(a.access_token)
  const pong = await c.req('ping', { ts: 1 })
  assert.equal(pong.t, 'pong')
  c.close()
  const blob = Buffer.concat([
    Buffer.from('CCB1'),
    Buffer.from([10]),
    randomBytes(16),
    randomBytes(40)
  ])
  const id = createHash('sha256').update('x').digest('hex')
  const chk = await rest('POST', '/api/v1/blobs/check', { ids: [id] }, a.access_token)
  assert.deepEqual(chk.body.missing, [id])
  const put = (sha: string): Promise<Response> =>
    fetch(`${srv.url}/api/v1/blobs/${id}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${a.access_token}`,
        'Content-Type': 'application/octet-stream',
        'X-Content-SHA256': sha
      },
      body: blob
    })
  assert.equal((await put('00'.repeat(32))).status, 400)
  const sha = createHash('sha256').update(blob).digest('hex')
  assert.equal((await put(sha)).status, 201)
  assert.equal((await put(sha)).status, 200)
  const got = await fetch(`${srv.url}/api/v1/blobs/${id}`, {
    headers: { Authorization: `Bearer ${a.access_token}` }
  })
  assert.equal(got.headers.get('x-content-sha256'), sha)
  assert.deepEqual(Buffer.from(await got.arrayBuffer()), blob)
  // push referenciando blob ausente
  const other = createHash('sha256').update('y').digest('hex')
  const r = await rest(
    'POST',
    '/api/v1/sync/push',
    { push_id: randomUUID(), items: [{ ...item('provider', 'p', null), blobs: [other] }] },
    a.access_token
  )
  assert.equal(r.body.error.code, 'blob_missing')
  assert.deepEqual(r.body.error.details.missing, [other])
})
