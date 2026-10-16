/* eslint-disable @typescript-eslint/no-explicit-any */
// read_history em outros chats: índice FTS5 (searchIndex.ts), HistoryStore e formatação
// (chat_id / scope "all"), list_chats por relevância. Banco temporário em memória.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { SCHEMA } from '../src/main/dbSchema.ts'
import {
  ensureSearchIndex,
  ftsQuery,
  indexMessage,
  SEARCH_INDEX_FLAG,
  searchableText
} from '../src/main/searchIndex.ts'
import { historyStore } from '../src/main/historyStore.ts'
import { readHistoryTool, readOtherChat, searchAllChats } from '../src/main/tools/history.ts'
import { formatChatList, rankChatsByTitle } from '../src/main/tools/chats.ts'
import type { ApiMessage, MessageMeta } from '../src/shared/types.ts'

function freshDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(SCHEMA)
  return db
}

let seqs = new Map<string, number>()
let idn = 0
function addChat(db: Database.Database, id: string, title: string, updatedAt = 1000): string {
  db.prepare(
    'INSERT INTO chats (id, title, config_json, main_session_id, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?)'
  ).run(id, title, '{}', `${id}-main`, updatedAt)
  addSession(db, `${id}-main`, id, 0, '')
  return `${id}-main`
}
function addSession(
  db: Database.Database,
  id: string,
  chatId: string,
  depth: number,
  title: string
): void {
  db.prepare(
    'INSERT INTO sessions (id, chat_id, parent_session_id, depth, model, title, created_at) VALUES (?, ?, ?, ?, ?, ?, 0)'
  ).run(id, chatId, depth ? `${chatId}-main` : null, depth, 'm', title)
}
/** Simula messagesRepo.append (INSERT + indexMessage). */
function add(
  db: Database.Database,
  sessionId: string,
  message: ApiMessage,
  meta: MessageMeta = {}
): string {
  const seq = (seqs.get(sessionId) ?? 0) + 1
  seqs.set(sessionId, seq)
  const id = `m${++idn}`
  db.prepare(
    'INSERT INTO messages (id, session_id, seq, message_json, meta_json, created_at) VALUES (?, ?, ?, ?, ?, 0)'
  ).run(id, sessionId, seq, JSON.stringify(message), JSON.stringify(meta))
  indexMessage(db, id, message, meta)
  return id
}
const u = (content: string): ApiMessage => ({ role: 'user', content })
const a = (content: string): ApiMessage => ({ role: 'assistant', content })

/** 3 chats: self, Viagem (com subagente), Receitas. */
function seeded(): Database.Database {
  seqs = new Map()
  const db = freshDb()
  ensureSearchIndex(db)
  const self = addChat(db, 'self0001', 'Chat atual', 3000)
  add(db, self, u('Também falei de flaresolverr aqui, mas este chat fica fora.'))
  const v = addChat(db, 'viag1111', 'Planejamento de Viagem', 2000)
  add(db, v, u('Quero ir para São Paulo em março e visitar o Museu do Ipiranga.'))
  add(db, v, a('Ótimo! Em MARÇO o clima em são paulo é quente.'))
  add(db, v, {
    role: 'assistant',
    content: null,
    tool_calls: [
      {
        id: 'c1',
        type: 'function',
        function: { name: 'web_search', arguments: '{"query":"flaresolverr docker"}' }
      }
    ]
  })
  add(
    db,
    v,
    {
      role: 'tool',
      tool_call_id: 'c1',
      content: 'FlareSolverr is a proxy server to bypass Cloudflare.'
    },
    { toolStatus: 'ok' }
  )
  addSession(db, 'viag1111-sub', 'viag1111', 1, 'Pesquisador')
  add(db, 'viag1111-sub', u('Pesquise hotéis baratos perto da Avenida Paulista'))
  const r = addChat(db, 'rece2222', 'Receitas', 1000)
  add(db, r, u('Receita de pão de queijo mineiro'))
  add(db, r, a('Use polvilho azedo e queijo canastra.'))
  return db
}

test('FTS5: índice criado, populado na migração (flag) e idempotente', () => {
  seqs = new Map()
  const db = freshDb()
  const s = addChat(db, 'aaaa0000', 'X')
  // mensagens antes do índice existir (banco antigo): indexMessage é no-op até ensureSearchIndex
  add(db, s, u('mensagem antiga sobre PAPAYA'))
  add(db, s, { role: 'assistant', content: 'erro' }, { kind: 'error', synthetic: true })
  const r1 = ensureSearchIndex(db)
  assert.equal(r1.skipped, false)
  assert.equal(r1.indexed, 1) // erro só de exibição não entra
  assert.equal(
    (db.prepare('SELECT value FROM settings WHERE key = ?').get(SEARCH_INDEX_FLAG) as any).value,
    '1'
  )
  assert.equal(ensureSearchIndex(db).skipped, true)
  const st = historyStore(db)
  assert.equal(st.search(ftsQuery('papaya')!, { limit: 5 }).length, 1)
  // índice apagado por fora → recria e repopula
  db.exec('DROP TABLE messages_fts')
  assert.equal(ensureSearchIndex(db).indexed, 1)
  db.close()
})

test('searchableText: sem base64/anexos, sem saídas do read_history', () => {
  const img: ApiMessage = {
    role: 'user',
    content: [
      { type: 'text', text: 'veja a foto' },
      {
        type: 'image_url',
        image_url: { url: 'data:image/png;base64,' + 'A'.repeat(5000) },
        _attachment: { id: 'x', name: 'foto.png', mime: 'image/png', size: 1 }
      } as any
    ]
  }
  const t = searchableText(img)
  assert.match(t.body, /veja a foto\nfoto\.png/)
  assert.ok(!t.body.includes('AAAA'))
  assert.equal(
    searchableText({ role: 'user', content: 'x ' + 'Q'.repeat(400) + ' y' }).body,
    'x   y'
  )
  assert.equal(
    searchableText({ role: 'tool', tool_call_id: 'c', content: '[histórico desta sessão: 3 …' })
      .tool,
    ''
  )
  const call: ApiMessage = {
    role: 'assistant',
    content: 'ok',
    tool_calls: [
      { id: 'c', type: 'function', function: { name: 'read_history', arguments: '{"query":"zz"}' } }
    ]
  }
  assert.deepEqual(searchableText(call), { body: 'ok', tool: '' })
})

test('ftsQuery: escapa a entrada do agente', () => {
  assert.equal(ftsQuery('whitelist blacklist'), '"whitelist"* AND "blacklist"*')
  assert.equal(ftsQuery('a b', 'any'), '"a" OR "b"')
  assert.equal(ftsQuery('NEAR(foo bar'), '"NEAR foo"* AND "bar"*')
  assert.equal(ftsQuery('"aspas" ou\'tro'), '"aspas"* AND "ou tro"*')
  assert.equal(ftsQuery('*'), null)
  assert.equal(ftsQuery('  ( ) " - '), null)
  const db = seeded()
  const st = historyStore(db)
  for (const evil of [
    'NEAR(',
    '"',
    '*',
    'AND OR NOT',
    'col:x',
    '^start',
    '{a b}',
    'a"b*c',
    '- -x'
  ]) {
    const q = ftsQuery(evil)
    if (q) assert.doesNotThrow(() => st.search(q, { limit: 5 }), evil)
    assert.doesNotThrow(() => searchAllChats(st, evil, 'self0001'), evil)
  }
  assert.match(searchAllChats(st, '*', 'self0001').text, /não tem termos pesquisáveis/)
  db.close()
})

test('scope all: relevância multi-termo com acento/maiúscula, exclui o próprio chat, subagentes', () => {
  const db = seeded()
  const st = historyStore(db)
  const r = searchAllChats(st, 'SAO PAULO marco', 'self0001')
  assert.ok(r.ok)
  assert.match(
    r.text,
    /^\[busca em 2 chats \(exceto este\) por "SAO PAULO marco": 2 mensagens com todos os termos em 1 chat;/
  )
  assert.match(
    r.text,
    /## "Planejamento de Viagem" · chat_id viag1111 · atualizado \d{4}-\d\d-\d\d · 2 mensagens/
  )
  assert.match(r.text, /^#[12] (user|assistant): .*(São Paulo|são paulo)/m)
  // flaresolverr: casa na tool (argumentos e resultado), não no próprio chat
  const f = searchAllChats(st, 'flaresolverr', 'self0001')
  assert.ok(!f.text.includes('self0001'))
  assert.match(f.text, /#3 assistant: .*web_search/)
  assert.match(f.text, /#4 tool \(web_search\): FlareSolverr is a proxy/)
  // prefixo + subagente
  const h = searchAllChats(st, 'hote paulis', 'self0001')
  assert.match(h.text, /#1 user \[subagente "Pesquisador" · session_id viag1111\]: Pesquise hotéis/)
  // nenhum com todos → qualquer termo
  const any = searchAllChats(st, 'polvilho inexistentezz', 'self0001')
  assert.match(any.text, /com algum dos termos/)
  assert.match(any.text, /"Receitas"/)
  // nada + título parecido
  const t = searchAllChats(st, 'receitas', 'self0001')
  assert.match(t.text, /Receita de pão|"Receitas"/)
  const none = searchAllChats(st, 'zzzzz', 'self0001')
  assert.match(none.text, /nenhuma mensagem encontrada/)
  // sem excluir (ex.: chamador sem chatId) o atual entra
  assert.match(searchAllChats(st, 'flaresolverr', undefined).text, /self0001/)
  db.close()
})

test('scope all: limites (chats, trechos por chat, teto de saída)', () => {
  seqs = new Map()
  const db = freshDb()
  ensureSearchIndex(db)
  for (let c = 0; c < 12; c++) {
    const s = addChat(db, `chat${String(c).padStart(4, '0')}`, `Chat ${c}`)
    for (let i = 0; i < 6; i++) add(db, s, u(`tema kiwi número ${i} ` + 'texto '.repeat(60)))
  }
  const st = historyStore(db)
  const r = searchAllChats(st, 'kiwi', 'x')
  assert.equal((r.text.match(/^## /gm) ?? []).length, 5)
  assert.match(r.text, /72 mensagens com todos os termos em 12 chats; mostrando 5/)
  assert.match(r.text, /Há mais 7 chat\(s\)/)
  const blocks = r.text.split(/^## /m).slice(1)
  for (const b of blocks) assert.equal((b.match(/^#\d+ /gm) ?? []).length, 3)
  assert.equal(
    (searchAllChats(st, 'kiwi', 'x', { limit: 50 }).text.match(/^## /gm) ?? []).length,
    12
  )
  const small = searchAllChats(st, 'kiwi', 'x', { limit: 20 }, 2000)
  assert.ok(small.text.length <= 2300, String(small.text.length))
  db.close()
})

test('chat_id: prefixo, ambíguo, faixa e busca em outro chat, session_id', async () => {
  const db = seeded()
  addChat(db, 'viag9999', 'Outra viagem')
  const st = historyStore(db)
  assert.match(readOtherChat(st, 'viag', {}).text, /mais de um chat/)
  assert.match(readOtherChat(st, 'via', {}).text, /chat não encontrado/)
  assert.match(readOtherChat(st, 'nope1234', {}).text, /chat não encontrado/)
  const range = readOtherChat(st, 'viag1', { fromSeq: 1, toSeq: 2 })
  assert.ok(range.ok)
  assert.match(
    range.text,
    /^\[histórico do chat "Planejamento de Viagem" \(id viag1111, sessão principal; 1 subagente\): 4 mensagens \(#1–#4\); sem compactações\]/
  )
  assert.match(range.text, /^#1 user: Quero ir para São Paulo/m)
  assert.match(range.text, /^#2 assistant: Ótimo/m)
  // uma mensagem só = inteira (com resultado de tool)
  assert.match(
    readOtherChat(st, 'viag1111', { fromSeq: 4, toSeq: 4 }).text,
    /#4 tool \(web_search\): FlareSolverr is a proxy/
  )
  // busca relevante só nesse chat (inclui subagente)
  const s = readOtherChat(st, 'viag1111', { query: 'avenida' })
  assert.match(s.text, /\[1 mensagem com "avenida", mais relevantes primeiro; mostrando 1\]/)
  assert.match(s.text, /subagente "Pesquisador"/)
  // session_id do subagente: faixa
  const sub = readOtherChat(st, 'viag1111', { sessionRef: 'viag1111-sub' })
  assert.match(sub.text, /^\[histórico do subagente "Pesquisador"/)
  assert.match(
    readOtherChat(st, 'viag1111', { sessionRef: 'zzzz' }).text,
    /sessão "zzzz" não encontrada/
  )
  // via tool
  const ctx = {
    cwd: '/',
    signal: new AbortController().signal,
    chatId: 'self0001',
    historyStore: st
  } as any
  const t1 = await readHistoryTool({ chat_id: 'rece', query: 'QUEIJO' }, ctx)
  assert.equal(t1.status, 'ok')
  assert.match(t1.content, /Receitas/)
  const t2 = await readHistoryTool({ scope: 'all', query: 'polvilho' }, ctx)
  assert.match(t2.content, /## "Receitas"/)
  assert.equal((await readHistoryTool({ scope: 'all' }, ctx)).status, 'error')
  assert.equal(
    (await readHistoryTool({ scope: 'all', chat_id: 'rece', query: 'x' }, ctx)).status,
    'error'
  )
  assert.equal((await readHistoryTool({ scope: 'outro', query: 'x' }, ctx)).status, 'error')
  assert.equal(
    (await readHistoryTool({ session_id: 'x' }, { ...ctx, history: () => [] })).status,
    'error'
  )
  assert.equal(
    (await readHistoryTool({ chat_id: 'rece' }, { cwd: '/', signal: ctx.signal } as any)).status,
    'error'
  )
  // sem chat_id/scope: comportamento atual (sessão do chamador)
  const t3 = await readHistoryTool({ query: 'abc' }, { ...ctx, history: () => [] })
  assert.match(t3.content, /histórico desta sessão: vazio/)
  db.close()
})

test('índice acompanha editar / apagar mensagem / apagar sessão e chat / insertAt', () => {
  const db = seeded()
  const st = historyStore(db)
  const q = (s: string): number => st.search(ftsQuery(s)!, { limit: 50 }).length
  const ftsRows = (): number =>
    (db.prepare('SELECT COUNT(*) AS n FROM messages_fts').get() as any).n
  // editar (repo.update → UPDATE + indexMessage)
  const id = (
    db.prepare("SELECT id FROM messages WHERE message_json LIKE '%polvilho%'").get() as any
  ).id
  const edited = a('Use tapioca e queijo meia cura.')
  db.prepare('UPDATE messages SET message_json = ? WHERE id = ?').run(JSON.stringify(edited), id)
  indexMessage(db, id, edited)
  assert.equal(q('polvilho'), 0)
  assert.equal(q('tapioca'), 1)
  // insertAt: seq muda, o índice continua apontando (seq vem do JOIN)
  db.prepare(
    "UPDATE messages SET seq = -(seq + 1) WHERE session_id = 'rece2222-main' AND seq >= 1"
  ).run()
  db.prepare("UPDATE messages SET seq = -seq WHERE session_id = 'rece2222-main' AND seq < 0").run()
  assert.equal(st.search(ftsQuery('tapioca')!, { limit: 5 })[0].seq, 3)
  // apagar mensagem (trigger)
  const before = ftsRows()
  db.prepare('DELETE FROM messages WHERE id = ?').run(id)
  assert.equal(q('tapioca'), 0)
  assert.equal(ftsRows(), before - 1)
  // apagar subsessão (CASCADE → trigger)
  db.prepare("DELETE FROM sessions WHERE id = 'viag1111-sub'").run()
  assert.equal(q('avenida'), 0)
  // apagar chat (CASCADE sessões → mensagens → trigger)
  db.prepare("DELETE FROM chats WHERE id = 'viag1111'").run()
  assert.equal(q('flaresolverr'), 1) // só a do self
  assert.equal(
    searchAllChats(st, 'flaresolverr', 'self0001').text.includes('nenhuma mensagem'),
    true
  )
  const orphans = db
    .prepare(
      'SELECT COUNT(*) AS n FROM message_search WHERE message_id NOT IN (SELECT id FROM messages)'
    )
    .get() as any
  assert.equal(orphans.n, 0)
  assert.equal(ftsRows(), (db.prepare('SELECT COUNT(*) AS n FROM message_search').get() as any).n)
  db.close()
})

test('list_chats: título por relevância (sem acentos), dica para scope all', () => {
  const base = { model: 'm', status: 'idle' as const, updatedAt: 0, self: false }
  const chats = [
    { ...base, id: 'c1', title: 'Notas sobre viagem a Portugal' },
    { ...base, id: 'c2', title: 'Viagem' },
    { ...base, id: 'c3', title: 'Viagens e passeios' },
    { ...base, id: 'c4', title: 'Portugal — viagem de férias' },
    { ...base, id: 'c5', title: 'Receitas' }
  ]
  assert.deepEqual(
    rankChatsByTitle(chats, 'VIAGEM').map((c) => c.id),
    ['c2', 'c1', 'c4']
  )
  assert.deepEqual(
    rankChatsByTitle(chats, 'ferias portugal').map((c) => c.id),
    ['c4']
  )
  assert.deepEqual(
    rankChatsByTitle(chats, 'c5').map((c) => c.id),
    ['c5']
  )
  const none = formatChatList(chats, { query: 'flaresolverr' })
  assert.match(none, /nenhum chat de 5 tem "flaresolverr" no título/)
  assert.match(none, /read_history com scope "all"/)
})
