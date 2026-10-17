// Lógica pura da UI da memória (src/renderer/src/lib/memory.ts), sem Electron: herança da persona
// (selos, diferença, restaurar), coleção de escrita (validação, desligar limpa), regra de envio,
// contadores/limites, tópicos (mover/trocar/remover), links [[slug]], resumos das tools e da extração.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  activeInCategory,
  canAddFact,
  cleanField,
  collectionBadge,
  counter,
  differsFromPersona,
  extractionCounts,
  extractionOf,
  isMemoryTool,
  matchesMemory,
  memoryChangesOf,
  memoryConfigOf,
  memoryDate,
  memoryIdsIn,
  MEMORY_LIMITS,
  memoryToolSummary,
  memoryWillSend,
  moveFact,
  moveTargets,
  plainMemoryText,
  removeFact,
  replaceFact,
  restoreFromPersona,
  setWriteTarget,
  sharedCollections,
  splitMemoryLinks,
  toggleCategory,
  toggleCollection,
  writeTargetError,
  writeTargetIssue,
  writeTargetOf
} from '../src/renderer/src/lib/memory.ts'
import {
  defaultMemoryConfig,
  type MemoryCollection,
  type MemoryConfig
} from '../src/shared/memory.ts'
import type { MessageMeta } from '../src/shared/types.ts'

const col = (
  id: string,
  category: MemoryCollection['category'],
  name: string,
  extra: Partial<MemoryCollection> = {}
): MemoryCollection => ({
  id,
  category,
  name,
  description: '',
  icon: null,
  createdAt: 0,
  updatedAt: 0,
  ...extra
})

const cols: MemoryCollection[] = [
  col('a-tcc', 'areas', 'Projeto TCC', { count: 3 }),
  col('a-pad', 'areas', 'Padrão', { count: 2 }),
  col('a-app', 'areas', 'ClearChat'),
  col('p-pad', 'profile', 'Padrão'),
  col('t-pad', 'topics', 'Padrão')
]

const cfg = (p: Partial<MemoryConfig> = {}): MemoryConfig => ({
  ...defaultMemoryConfig(),
  enabled: true,
  ...p
})

test('memoryConfigOf: ausente/parcial → padrões completos', () => {
  assert.deepEqual(memoryConfigOf(undefined), defaultMemoryConfig())
  const m = memoryConfigOf({ memory: { enabled: true, collections: ['x', 'x'] } as never })
  assert.equal(m.enabled, true)
  assert.deepEqual(m.collections, ['x'])
  assert.equal(m.categories.length, 5)
  assert.deepEqual(m.extraction, { auto: false, prompt: null, providerId: null, model: null })
})

test('sharedCollections: coleções da categoria, "Padrão" primeiro', () => {
  assert.deepEqual(
    sharedCollections(cols, 'areas').map((c) => c.id),
    ['a-pad', 'a-app', 'a-tcc']
  )
  assert.deepEqual(
    activeInCategory(cfg({ collections: ['a-tcc', 'p-pad', 'sumiu'] }), cols, 'areas').map(
      (c) => c.id
    ),
    ['a-tcc']
  )
})

test('regra de envio: desligada, sem coleção, categoria desligada, chatMemory legado', () => {
  assert.equal(memoryWillSend(cfg({ enabled: false, collections: ['a-tcc'] }), cols), false)
  assert.equal(memoryWillSend(cfg(), cols), false)
  assert.equal(memoryWillSend(cfg({ collections: ['a-tcc'] }), cols), true)
  // categoria desligada ignora a coleção (sem perder a seleção)
  const off = cfg({ collections: ['a-tcc'], categories: ['profile'] })
  assert.equal(memoryWillSend(off, cols), false)
  // coleção apagada não conta
  assert.equal(memoryWillSend(cfg({ collections: ['sumiu'] }), cols), false)
  // sem a lista de coleções: conta os ids
  assert.equal(memoryWillSend(cfg({ collections: ['x'] }), null), true)
  // chatMemory de configs antigas é descartado e não ativa nada
  const legacy = memoryConfigOf({ memory: { enabled: true, chatMemory: true } as never })
  assert.ok(!('chatMemory' in legacy))
  assert.equal(memoryWillSend(legacy, cols), false)
})

test('toggleCollection: desligar a coleção de escrita limpa a escrita; ligar liga a categoria', () => {
  const m = cfg({ collections: ['a-tcc'], writeTo: { areas: 'a-tcc' }, categories: ['profile'] })
  const off = toggleCollection(m, cols[0], false)
  assert.deepEqual(off.collections, [])
  assert.equal(off.writeTo.areas, null)
  const on = toggleCollection(cfg({ categories: ['profile'] }), cols[0], true)
  assert.deepEqual(on.collections, ['a-tcc'])
  assert.deepEqual(on.categories, ['profile', 'areas'])
  // idempotente
  assert.equal(toggleCollection(m, cols[0], true), m)
})

test('toggleCategory mantém a ordem da taxonomia', () => {
  const m = cfg({ categories: ['people'] })
  assert.deepEqual(toggleCategory(m, 'profile', true).categories, ['profile', 'people'])
  assert.deepEqual(toggleCategory(m, 'people', false).categories, [])
})

test('coleção de escrita: só uma das ativas, da mesma categoria', () => {
  const m = cfg({ collections: ['a-tcc', 'p-pad'] })
  assert.equal(writeTargetError(m, cols, 'areas', null), null)
  assert.match(writeTargetError(m, cols, 'areas', 'a-app') ?? '', /Ative a coleção/)
  assert.match(writeTargetError(m, cols, 'areas', 'p-pad') ?? '', /outra categoria/)
  assert.match(writeTargetError(m, cols, 'areas', 'sumiu') ?? '', /não existe/)
  const ok = setWriteTarget(m, cols, 'areas', 'a-tcc')
  assert.equal(ok.error, null)
  assert.equal(ok.mem.writeTo.areas, 'a-tcc')
  const bad = setWriteTarget(m, cols, 'areas', 'a-app')
  assert.ok(bad.error)
  assert.equal(bad.mem, m)
  // escrita salva que ficou inválida (coleção desativada/apagada) → aviso e sem efeito
  const stale = cfg({ collections: [], writeTo: { areas: 'a-tcc' } })
  assert.ok(writeTargetIssue(stale, cols, 'areas'))
  assert.equal(writeTargetOf(stale, cols, 'areas'), null)
  assert.equal(writeTargetOf(ok.mem, cols, 'areas')?.id, 'a-tcc')
})

test('herança da persona: selos, diferença e restaurar', () => {
  const persona = cfg({ collections: ['a-pad', 't-pad'], writeTo: { areas: 'a-pad' } })
  const chat = cfg({ collections: ['a-pad', 'a-tcc'], writeTo: { areas: 'a-tcc' } })
  assert.equal(collectionBadge('a-pad', chat, persona), 'persona')
  assert.equal(collectionBadge('t-pad', chat, persona), 'persona-off')
  assert.equal(collectionBadge('a-tcc', chat, persona), 'added')
  assert.equal(collectionBadge('a-app', chat, persona), null)
  assert.equal(collectionBadge('a-pad', chat, null), null)
  assert.equal(differsFromPersona(chat, persona), true)
  const restored = restoreFromPersona(persona)
  assert.equal(differsFromPersona(restored, persona), false)
  assert.deepEqual(restored, persona)
  assert.notEqual(restored.collections, persona.collections, 'cópia')
  // ordem das coleções não conta como diferença
  assert.equal(
    differsFromPersona(
      cfg({ collections: ['t-pad', 'a-pad'], writeTo: { areas: 'a-pad' } }),
      persona
    ),
    false
  )
})

test('limites e contadores', () => {
  assert.deepEqual(
    [MEMORY_LIMITS.title, MEMORY_LIMITS.summary, MEMORY_LIMITS.fact, MEMORY_LIMITS.facts],
    [80, 160, 200, 15]
  )
  assert.deepEqual(counter('abc', 80), { len: 3, max: 80, over: false, near: false, label: '3/80' })
  assert.equal(counter('x'.repeat(72), 80).near, true)
  assert.equal(counter('x'.repeat(81), 80).over, true)
  assert.equal(cleanField('  a   b ', 80), 'a b')
  assert.equal(cleanField('   ', 80, true), null)
  assert.equal(cleanField('x'.repeat(81), 80), null)
  assert.equal(cleanField('', 160), '')
  assert.equal(canAddFact(Array(14).fill('f')), true)
  assert.equal(canAddFact(Array(15).fill('f')), false)
})

test('tópicos: mover, trocar, remover', () => {
  const f = ['a', 'b', 'c']
  assert.deepEqual(moveFact(f, 1, -1), ['b', 'a', 'c'])
  assert.deepEqual(moveFact(f, 2, 1), f)
  assert.deepEqual(moveFact(f, 0, -1), f)
  assert.deepEqual(replaceFact(f, 1, 'B'), ['a', 'B', 'c'])
  assert.deepEqual(removeFact(f, 0), ['b', 'c'])
  assert.deepEqual(f, ['a', 'b', 'c'])
})

test('links [[slug]]', () => {
  assert.deepEqual(splitMemoryLinks('Fala com [[marcos]] e [[ana|a Ana]].'), [
    { text: 'Fala com ' },
    { slug: 'marcos', label: 'marcos' },
    { text: ' e ' },
    { slug: 'ana', label: 'a Ana' },
    { text: '.' }
  ])
  assert.deepEqual(splitMemoryLinks('sem links'), [{ text: 'sem links' }])
  assert.equal(
    plainMemoryText('com o [[marcos]] e [[x|X]]', [
      { slug: 'marcos', title: 'Marcos (orientador)' }
    ]),
    'com o Marcos (orientador) e X'
  )
  assert.equal(plainMemoryText('[[sumiu]]'), 'sumiu')
})

test('mover: só coleções da mesma categoria', () => {
  assert.deepEqual(
    moveTargets({ collectionId: 'a-tcc', category: 'areas' }, cols).map((c) => c.id),
    ['a-pad', 'a-app']
  )
  assert.deepEqual(
    moveTargets({ collectionId: 'p-pad', category: 'profile' }, cols).map((c) => c.id),
    []
  )
})

test('busca local sem acento/caixa, termos em qualquer ordem', () => {
  const m = { title: 'Orientação do TCC', summary: 'Reuniões', facts: ['quinta 14h'] }
  assert.equal(matchesMemory(m, 'tcc orientacao'), true)
  assert.equal(matchesMemory(m, 'QUINTA'), true)
  assert.equal(matchesMemory(m, 'sexta'), false)
})

test('tools: resumo de uma linha e ids citados', () => {
  assert.equal(isMemoryTool('memory_write'), true)
  assert.equal(isMemoryTool('read_file'), false)
  assert.equal(
    memoryToolSummary('memory_search', { query: 'tcc', category: 'areas', limit: 5 }),
    '"tcc" · Áreas · limite 5'
  )
  assert.equal(memoryToolSummary('memory_read', { ids: ['m1', 'm2'] }), '2 memórias')
  assert.equal(memoryToolSummary('memory_read', { ids: ['m1abcde'] }), 'm1abcde')
  assert.equal(
    memoryToolSummary('memory_write', {
      category: 'people',
      title: 'Ana',
      ops: [
        { op: 'add', fact: 'x' },
        { op: 'add', fact: 'y' },
        { op: 'remove', fact: '#1' }
      ]
    }),
    'Pessoas · Ana · +2 −1'
  )
  assert.equal(memoryToolSummary('memory_write', { category: 'areas' }), 'Áreas · nova')
  assert.equal(
    memoryToolSummary('memory_rewrite', { id: 'm1', facts: ['a', 'b'] }),
    'm1 · 2 tópicos'
  )
  assert.equal(memoryToolSummary('memory_delete', { id: 'mabc123' }), 'mabc123')
  assert.deepEqual(memoryIdsIn('- m2 · x\n- m1 · y', [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }]), [
    'm2',
    'm1'
  ])
})

test('extração e mudanças: contagem, meta tolerante', () => {
  assert.equal(
    extractionCounts({ created: 2, updated: 1, deleted: 0 }),
    '2 criadas, 1 atualizada, 0 apagadas'
  )
  assert.equal(
    extractionCounts({ created: 1, updated: 0, deleted: 1 }),
    '1 criada, 0 atualizadas, 1 apagada'
  )
  const change = { op: 'create' as const, memoryId: 'm1', title: 'T', collectionId: 'c' }
  const meta: MessageMeta = {
    synthetic: true,
    kind: 'memory-extraction',
    memoryExtraction: {
      created: 1,
      updated: 0,
      deleted: 0,
      changes: [change],
      trigger: 'compaction'
    }
  }
  assert.deepEqual(extractionOf(meta)?.changes, [change])
  assert.equal(extractionOf(meta)?.trigger, 'compaction')
  assert.equal(extractionOf({ kind: 'error' }), null)
  assert.deepEqual(memoryChangesOf({ memoryChanges: [change, { op: 'x' } as never] }), [change])
  assert.deepEqual(memoryChangesOf(undefined), [])
})

test('memoryDate: hoje / ontem / data', () => {
  const now = new Date(2026, 9, 16, 15, 0).getTime()
  assert.equal(memoryDate(new Date(2026, 9, 16, 9, 5).getTime(), now), 'hoje, 09:05')
  assert.equal(memoryDate(new Date(2026, 9, 15, 23, 59).getTime(), now), 'ontem, 23:59')
  assert.match(memoryDate(new Date(2026, 9, 12).getTime(), now), /12 de out/)
  assert.match(memoryDate(new Date(2025, 9, 12).getTime(), now), /2025/)
})
