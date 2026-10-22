// Ramificação na UI — lógica pura de src/renderer/src/lib/branchView.ts (sem Electron): caminho
// ativo + irmãos para o ‹ i/n ›, grupo de versões, "Regenerar resposta" em todos os turnos, erro que
// fecha o caminho e subagentes em segundo plano abaixo de uma bifurcação.
// Rodar: node --import ./e2e/ts-hooks.mjs --test e2e/branchView.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Session, StoredMessage } from '../src/shared/types.ts'
import { pruneSel, selectionToReach, type BranchSel } from '../src/shared/branches.ts'
import { createBranchSelects } from '../src/renderer/src/lib/branchSelects.ts'
import {
  branchGroup,
  branchView,
  regenerateTargets,
  subagentsBelow,
  trailingErrorId,
  versionLabel
} from '../src/renderer/src/lib/branchView.ts'

let seq = 0
function m(
  id: string,
  parentId: string | null | undefined,
  role: 'user' | 'assistant' | 'tool',
  extra: { meta?: StoredMessage['meta']; calls?: string[] } = {}
): StoredMessage {
  const message =
    role === 'assistant'
      ? {
          role,
          content: id,
          ...(extra.calls
            ? {
                tool_calls: extra.calls.map((c) => ({
                  id: c,
                  type: 'function' as const,
                  function: { name: 'delegate_task', arguments: '{}' }
                }))
              }
            : {})
        }
      : role === 'tool'
        ? { role, tool_call_id: 'x', content: id }
        : { role, content: id }
  return {
    id,
    sessionId: 's',
    seq: ++seq,
    message: message as StoredMessage['message'],
    meta: extra.meta ?? {},
    createdAt: seq,
    ...(parentId === undefined ? {} : { parentId })
  }
}

// u1 → a1 | a1b (regenerada) → u2a | u2b | u2c (editada) → … ; u3/a3 sob a2b
const u1 = m('u1', null, 'user')
const a1 = m('a1', 'u1', 'assistant')
const a1b = m('a1b', 'u1', 'assistant')
const u2a = m('u2a', 'a1b', 'user')
const a2a = m('a2a', 'u2a', 'assistant')
const u2b = m('u2b', 'a1b', 'user')
const a2b = m('a2b', 'u2b', 'assistant', { calls: ['tc-bg'] })
const t2b = m('t2b', 'a2b', 'tool')
const a2b2 = m('a2b2', 't2b', 'assistant')
const u2c = m('u2c', 'a1b', 'user')
const a2c = m('a2c', 'u2c', 'assistant')
const u3 = m('u3', 'a2b2', 'user')
const a3 = m('a3', 'u3', 'assistant')
const all = [u1, a1, a1b, u2a, a2a, u2b, a2b, t2b, a2b2, u2c, a2c, u3, a3]
const ids = (l: StoredMessage[]): string[] => l.map((x) => x.id)

test('branchView: seleção explícita no meio, padrão = mais nova', () => {
  const v = branchView(all, { a1b: 'u2b' })
  assert.deepEqual(ids(v.path), ['u1', 'a1b', 'u2b', 'a2b', 't2b', 'a2b2', 'u3', 'a3'])
  assert.deepEqual([...v.siblings.keys()], ['a1b', 'u2b'])
  assert.deepEqual(v.siblings.get('u2b'), { index: 1, count: 3, prevId: 'u2a', nextId: 'u2c' })
  assert.equal(versionLabel(v.siblings.get('u2b')!), 'Versão 2 de 3')
  assert.equal(versionLabel(v.siblings.get('a1b')!), 'Versão 2 de 2')
  // sem seleção: a versão mais nova (u2c)
  assert.deepEqual(ids(branchView(all, {}).path), ['u1', 'a1b', 'u2c', 'a2c'])
  // null = o caminho para no prompt (regenerar em andamento)
  assert.deepEqual(ids(branchView(all, { a1b: 'u2b', u3: null }).path).slice(-1), ['u3'])
})

test('branchView: chat linear legado (sem parentId) = tudo, sem ‹ ›', () => {
  const lin = [m('l1', undefined, 'user'), m('l2', undefined, 'assistant')]
  const v = branchView(lin, undefined)
  assert.deepEqual(ids(v.path), ['l1', 'l2'])
  assert.equal(v.siblings.size, 0)
})

test('branchGroup: chave do pai (root para a raiz)', () => {
  const { tree } = branchView(all, {})
  assert.equal(branchGroup(tree, 'u2a'), 'a1b')
  assert.equal(branchGroup(tree, 'u2c'), 'a1b')
  assert.equal(branchGroup(tree, 'u1'), 'root')
})

test('regenerateTargets: última resposta do assistente de CADA turno', () => {
  const { path } = branchView(all, { a1b: 'u2b' })
  assert.deepEqual([...regenerateTargets(path)].sort(), ['a1b', 'a2b2', 'a3'])
  // erro (só exibição) não conta; turno só com erro → sem alvo
  const err = m('e1', 'a3', 'assistant', { meta: { kind: 'error', error: 'HTTP 500' } })
  const u4 = m('u4', 'e1', 'user')
  const err2 = m('e2', 'u4', 'assistant', { meta: { kind: 'error', error: 'HTTP 500' } })
  const p2 = branchView([...all, err, u4, err2], { a1b: 'u2b' }).path
  assert.deepEqual([...regenerateTargets(p2)].sort(), ['a1b', 'a2b2', 'a3'])
  assert.equal(trailingErrorId(p2), 'e2')
  // card de extração depois do erro não muda nada
  const ext = m('x1', 'e2', 'assistant', { meta: { kind: 'memory-extraction' } })
  assert.equal(trailingErrorId(branchView([...all, err, u4, err2, ext], { a1b: 'u2b' }).path), 'e2')
  assert.equal(trailingErrorId(path), null)
})

test('subagentsBelow: só os que nasceram abaixo da bifurcação', () => {
  const { tree } = branchView(all, { a1b: 'u2b' })
  // tc-bg nasceu em a2b (abaixo de a1b e de u1, acima de u3)
  assert.equal(subagentsBelow(tree, 'a1b', ['tc-bg']), 1)
  assert.equal(subagentsBelow(tree, 'u1', ['tc-bg']), 1)
  assert.equal(subagentsBelow(tree, null, ['tc-bg']), 1)
  assert.equal(subagentsBelow(tree, 'u3', ['tc-bg']), 0)
  assert.equal(subagentsBelow(tree, 'a2b', ['tc-bg']), 0) // a própria origem é o tronco
  assert.equal(subagentsBelow(tree, 'a1b', []), 0)
  assert.equal(subagentsBelow(tree, 'a1b', ['desconhecida']), 0)
})

/**
 * Troca de versão no renderer contra um "main" falso com a ordem do IPC real: cada chamada grava a
 * seleção (sobre a anterior), emite `session-updated` na hora e a resposta só chega quando o teste
 * manda (`reply()`), sempre na ordem das chamadas.
 */
interface BranchSelectHarness {
  sel: ReturnType<typeof createBranchSelects>
  shown(): string[]
  main(): string[]
  failNext(v: boolean): void
  reply(): Promise<void>
}
function branchSelectHarness(initial: BranchSel): BranchSelectHarness {
  let mainSel: BranchSel = { ...initial }
  const base = { id: 's', chatId: 'c', status: 'idle' } as unknown as Session
  const sessions: Record<string, Session> = { s: { ...base, branchSel: { ...initial } } }
  const replies: {
    session?: Session
    error?: Error
    resolve: (s: Session) => void
    reject: (e: Error) => void
  }[] = []
  let fail = false
  const sel = createBranchSelects({
    session: (sid) => sessions[sid],
    messages: () => all,
    put: (session) => void (sessions[session.id] = session),
    call: (messageId) =>
      new Promise<Session>((resolve, reject) => {
        if (fail) return void replies.push({ error: new Error('recusada'), resolve, reject })
        mainSel = pruneSel(all, selectionToReach(all, mainSel, messageId))
        const session = { ...base, branchSel: mainSel }
        sessions.s = sel.incoming(session) // session-updated (applyEvent)
        replies.push({ session, resolve, reject })
      })
  })
  return {
    sel,
    shown: (): string[] => ids(branchView(all, sessions.s.branchSel).path),
    main: (): string[] => ids(branchView(all, mainSel).path),
    failNext: (v: boolean): void => void (fail = v),
    /** entrega a resposta da chamada mais antiga ainda pendente */
    async reply(): Promise<void> {
      const r = replies.shift()!
      if (r.error) r.reject(r.error)
      else r.resolve(r.session!)
      await new Promise((ok) => setImmediate(ok))
    }
  }
}

test('troca de versão: resposta atrasada da troca anterior não volta a tela (←/→ rápidos)', async () => {
  // Python (u2b) ativo; ← vai para TypeScript (u2a) e → volta para Python antes da 1ª resposta
  const h = branchSelectHarness({ a1b: 'u2b' })
  const t = h.sel.select('s', 'u2a')
  assert.equal(h.shown()[2], 'u2a')
  const p = h.sel.select('s', 'u2b')
  assert.equal(h.shown()[2], 'u2b')
  await h.reply() // resposta da troca para TypeScript chega depois do otimista de Python
  assert.equal(h.shown()[2], 'u2b', 'a resposta atrasada não pode trazer TypeScript de volta')
  // a troca seguinte (resposta do assistente v1 → v2) parte do caminho certo
  const a = h.sel.select('s', 'a1')
  assert.deepEqual(h.shown(), ['u1', 'a1'])
  await h.reply()
  assert.deepEqual(h.shown(), ['u1', 'a1'])
  const b = h.sel.select('s', 'a1b')
  await h.reply()
  await h.reply()
  await Promise.all([t, p, a, b])
  assert.equal(h.shown()[2], 'u2b', 'a versão lembrada sob a resposta é Python')
  assert.deepEqual(h.shown(), h.main())
})

test('troca de versão: falha da mais recente volta ao que o main gravou; falha antiga não desfaz', async () => {
  const h = branchSelectHarness({ a1b: 'u2b' })
  const t = h.sel.select('s', 'u2a')
  h.failNext(true)
  const g = h.sel.select('s', 'u2c').catch((e: Error) => e.message)
  assert.equal(h.shown()[2], 'u2c')
  await h.reply()
  assert.equal(h.shown()[2], 'u2c') // a Go ainda pendente
  await h.reply()
  assert.equal(await g, 'recusada')
  await t
  assert.equal(h.shown()[2], 'u2a', 'volta para TypeScript (gravada pelo main), não para Python')
  assert.deepEqual(h.shown(), h.main())
  // falha de uma troca antiga com outra mais nova pendente: a nova fica
  const f = h.sel.select('s', 'u2b').catch(() => 'erro')
  h.failNext(false)
  const ok = h.sel.select('s', 'u2c')
  await h.reply()
  assert.equal(await f, 'erro')
  assert.equal(h.shown()[2], 'u2c')
  await h.reply()
  await ok
  assert.deepEqual(h.shown(), h.main())
})
