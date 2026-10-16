// Fila de aprovações acima do composer (sem Electron): qual card hospeda cada pendência
// (`anchorFor`), visibilidade (`isAnchorShown`) e a fila ordenada (`queuedApprovals`).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  anchorFor,
  anchorId,
  isAnchorShown,
  queuedApprovals,
  shortFailure
} from '../src/renderer/src/lib/approvalAnchors.ts'
import type { ApprovalRequest, Session } from '../src/shared/types.ts'

const ses = (id: string, parent: string | null, tc: string | null, depth: 0 | 1 | 2): Session => ({
  id,
  chatId: 'c1',
  parentSessionId: parent,
  parentToolCallId: tc,
  depth,
  model: 'm',
  title: id,
  task: null,
  status: 'running',
  createdAt: 0
})
const sessions: Record<string, Session> = {
  main: ses('main', null, null, 0),
  a: ses('a', 'main', 'tcA', 1),
  b: ses('b', 'main', 'tcB', 1),
  a1: ses('a1', 'a', 'tcA1', 2)
}
const req = (
  id: string,
  sessionId: string,
  toolCallId: string,
  createdAt: number
): ApprovalRequest => ({
  id,
  chatId: 'c1',
  sessionId,
  toolCallId,
  toolName: 'shell',
  args: { command: 'ls' },
  createdAt
})

test('anchorFor: própria sessão → card da tool; filho/neto → card do delegate na sessão vista', () => {
  assert.equal(anchorFor('main', 'tc1', 'main', sessions), anchorId('main', 'tc1'))
  assert.equal(anchorFor('a', 'x', 'main', sessions), anchorId('main', 'tcA'))
  assert.equal(anchorFor('a1', 'x', 'main', sessions), anchorId('main', 'tcA'))
  assert.equal(anchorFor('a1', 'x', 'a', sessions), anchorId('a', 'tcA1'))
  // fora da subárvore da sessão vista (irmão, pai) → sem card: sempre na fila
  assert.equal(anchorFor('b', 'x', 'a', sessions), null)
  assert.equal(anchorFor('main', 'tc1', 'a', sessions), null)
  assert.equal(anchorFor('desconhecida', 'x', 'main', sessions), null)
})

test('isAnchorShown: montado sem medida conta como visível; desmontado/fora não', () => {
  assert.equal(isAnchorShown({ k: null }, 'k'), true)
  assert.equal(isAnchorShown({ k: true }, 'k'), true)
  assert.equal(isAnchorShown({ k: false }, 'k'), false)
  assert.equal(isAnchorShown({}, 'k'), false)
  assert.equal(isAnchorShown({ k: true }, null), false)
})

test('queuedApprovals: só as com card fora da tela, a mais antiga primeiro, só do chat', () => {
  const list = [
    req('r3', 'b', 'x3', 30),
    req('r1', 'a', 'x1', 10),
    req('r2', 'a1', 'x2', 20),
    { ...req('r9', 'z', 'x9', 1), chatId: 'outro' }
  ]
  const kA = anchorId('main', 'tcA')
  const kB = anchorId('main', 'tcB')
  // A visível → r1 e r2 (neto) ficam no card; B fora → r3 na fila
  assert.deepEqual(
    queuedApprovals(list, 'c1', 'main', sessions, { [kA]: true, [kB]: false }).map((a) => a.id),
    ['r3']
  )
  // tudo fora → fila ordenada por createdAt
  assert.deepEqual(
    queuedApprovals(list, 'c1', 'main', sessions, { [kA]: false, [kB]: false }).map((a) => a.id),
    ['r1', 'r2', 'r3']
  )
  // vendo a subsessão "a": a1 hospedado no card tcA1 (visível); r1 é da própria "a" (card x1 fora)
  assert.deepEqual(
    queuedApprovals(list, 'c1', 'a', sessions, { [anchorId('a', 'tcA1')]: true }).map((a) => a.id),
    ['r1', 'r3']
  )
})

test('shortFailure: primeira linha não vazia, cortada', () => {
  assert.equal(shortFailure('\n  Erro HTTP 402: sem créditos\nmais'), 'Erro HTTP 402: sem créditos')
  assert.equal(shortFailure(undefined), 'erro desconhecido')
  assert.equal(shortFailure('x'.repeat(200), 20).length, 20)
})
