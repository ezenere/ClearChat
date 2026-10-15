// Testes unitários do seletor de modelos (funções puras, sem DOM): grupos por provedor, busca em
// todos os grupos, ID livre por provedor, navegação por teclado, virtualização e o par
// (provedor, modelo) de personas / "Novos chats" / subsessões.
// Rodar: npm run test:unit
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ROW_HEIGHT,
  buildPickerRows,
  initialHighlight,
  modelMatches,
  nextSelectable,
  rowAt,
  rowOffsets,
  scrollToRow,
  stickyHeader,
  visibleRange,
  type PickerModels,
  type PickerRow
} from '../src/renderer/src/lib/modelPicker.ts'
import { defaultModelRef, resolvePresetModel, sessionProviderId } from '../src/shared/models.ts'
import type { ModelInfo } from '../src/shared/types.ts'

const OR = { id: 'or', name: 'OpenRouter' }
const AN = { id: 'an', name: 'Anthropic' }
const LOCAL = { id: 'lo', name: 'Local' }

const m = (id: string, name?: string, extra: Partial<ModelInfo> = {}): ModelInfo => ({
  id,
  ...(name ? { name } : {}),
  ...extra
})

const models: Record<string, PickerModels> = {
  or: {
    status: 'ok',
    list: [
      m('anthropic/claude-opus-4', 'Claude Opus 4'),
      m('openai/gpt-4.1-nano', 'GPT-4.1 Nano', { supportsTools: true }),
      m('openai/gpt-4o-mini', 'GPT-4o mini')
    ]
  },
  an: { status: 'ok', list: [m('claude-opus-4', 'Claude Opus 4'), m('claude-haiku-4')] }
}

const kinds = (rows: PickerRow[]): string[] =>
  rows.map((r) =>
    r.kind === 'header'
      ? `H:${r.name}${r.collapsed ? '-' : ''}`
      : r.kind === 'model'
        ? `M:${r.providerId}:${r.model.id}${r.selected ? '*' : ''}`
        : r.kind === 'status'
          ? `S:${r.providerId}:${r.status}`
          : r.kind === 'free'
            ? `F:${r.providerId}`
            : 'FH'
  )

const build = (
  over: Partial<Parameters<typeof buildPickerRows>[0]> = {}
): ReturnType<typeof buildPickerRows> =>
  buildPickerRows({
    providers: [OR, AN],
    models,
    query: '',
    collapsed: new Set(),
    selected: null,
    ...over
  })

test('grupos: um cabeçalho por provedor, na ordem dos provedores, com contagem', () => {
  const rows = build()
  assert.deepEqual(kinds(rows), [
    'H:OpenRouter',
    'M:or:anthropic/claude-opus-4',
    'M:or:openai/gpt-4.1-nano',
    'M:or:openai/gpt-4o-mini',
    'H:Anthropic',
    'M:an:claude-opus-4',
    'M:an:claude-haiku-4'
  ])
  const h = rows[0]
  assert.ok(h.kind === 'header' && h.total === 3 && h.shown === 3)
})

test('mesmo id em dois provedores = duas opções distintas; seleção marca só o par', () => {
  const same: Record<string, PickerModels> = {
    or: { status: 'ok', list: [m('x/opus')] },
    an: { status: 'ok', list: [m('x/opus')] }
  }
  const rows = build({ models: same, selected: { providerId: 'an', model: 'x/opus' } })
  assert.deepEqual(kinds(rows), ['H:OpenRouter', 'M:or:x/opus', 'H:Anthropic', 'M:an:x/opus*'])
  const keys = rows.map((r) => r.key)
  assert.equal(new Set(keys).size, keys.length, 'keys únicas')
})

test('recolhido: só o cabeçalho; busca ignora o recolhimento', () => {
  const rows = build({ collapsed: new Set(['or']) })
  assert.deepEqual(kinds(rows).slice(0, 2), ['H:OpenRouter-', 'H:Anthropic'])
  const searched = build({ collapsed: new Set(['or']), query: 'nano' })
  assert.deepEqual(kinds(searched), [
    'H:OpenRouter',
    'M:or:openai/gpt-4.1-nano',
    'FH',
    'F:or',
    'F:an'
  ])
})

test('busca em todos os grupos: cabeçalhos ficam, grupos sem resultado somem', () => {
  const rows = build({ query: 'opus' })
  assert.deepEqual(
    kinds(rows).filter((k) => !k.startsWith('F')),
    ['H:OpenRouter', 'M:or:anthropic/claude-opus-4', 'H:Anthropic', 'M:an:claude-opus-4']
  )
  const h = rows[0]
  assert.ok(h.kind === 'header' && h.shown === 1 && h.total === 3)
  const onlyAn = build({ query: 'haiku' })
  assert.deepEqual(
    kinds(onlyAn).filter((k) => !k.startsWith('F')),
    ['H:Anthropic', 'M:an:claude-haiku-4']
  )
})

test('busca: termos em qualquer ordem, sem separadores e pelo nome do provedor', () => {
  const nano = models.or.list[1]
  assert.ok(modelMatches(nano, 'OpenRouter', ['nano', 'gpt']))
  assert.ok(modelMatches(nano, 'OpenRouter', ['gpt41']))
  assert.ok(modelMatches(nano, 'OpenRouter', ['openrouter', 'nano']))
  assert.ok(!modelMatches(nano, 'OpenRouter', ['anthropic']))
  const rows = build({ query: 'anthropic opus' })
  // "anthropic" casa com o id no OpenRouter e com o nome do provedor Anthropic
  assert.deepEqual(
    kinds(rows).filter((k) => k.startsWith('M')),
    ['M:or:anthropic/claude-opus-4', 'M:an:claude-opus-4']
  )
})

test('ID livre: "Usar <texto> em <provedor>" por provedor sem o id exato, seleção primeiro', () => {
  const none = build({
    query: 'meu/modelo-x',
    selected: { providerId: 'an', model: 'claude-haiku-4' }
  })
  assert.deepEqual(kinds(none), ['FH', 'F:an', 'F:or'])
  const f = none[1]
  assert.ok(f.kind === 'free' && f.text === 'meu/modelo-x' && f.providerName === 'Anthropic')
  // id exato em um provedor: só o outro ganha a opção livre
  const exact = build({ query: 'claude-haiku-4' })
  assert.deepEqual(kinds(exact), ['H:Anthropic', 'M:an:claude-haiku-4', 'FH', 'F:or'])
  // espaços nas pontas não contam
  const trimmed = build({ query: '  zzz  ' })
  assert.ok(trimmed.every((r) => r.kind !== 'free' || r.text === 'zzz'))
  assert.deepEqual(
    kinds(build({ query: '' })).filter((k) => k.startsWith('F')),
    []
  )
})

test('carregando / erro / vazio: linha de status no grupo, sem quebrar os outros', () => {
  const rows = build({
    providers: [OR, AN, LOCAL],
    models: {
      or: models.or,
      an: { status: 'error', list: [], error: 'HTTP 401' },
      lo: { status: 'ok', list: [] }
    }
  })
  assert.deepEqual(kinds(rows).slice(-4), ['H:Anthropic', 'S:an:error', 'H:Local', 'S:lo:empty'])
  const err = rows.find((r) => r.kind === 'status' && r.status === 'error')
  assert.ok(err?.kind === 'status' && err.error === 'HTTP 401')
  // sem entrada ainda (nunca carregado) = carregando
  const pending = build({ providers: [OR, LOCAL], models: { or: models.or } })
  assert.deepEqual(kinds(pending).slice(-2), ['H:Local', 'S:lo:loading'])
  // na busca: grupo carregando/com erro continua visível; vazio/sem resultado some
  const searching = build({
    providers: [OR, AN, LOCAL],
    query: 'nano',
    models: {
      or: models.or,
      an: { status: 'error', list: [], error: 'x' },
      lo: { status: 'ok', list: [] }
    }
  })
  assert.deepEqual(
    kinds(searching).filter((k) => !k.startsWith('F')),
    ['H:OpenRouter', 'M:or:openai/gpt-4.1-nano', 'H:Anthropic', 'S:an:error']
  )
  // recarregando com lista antiga: mostra a lista (status no cabeçalho)
  const reloading = build({
    providers: [AN],
    models: { an: { status: 'loading', list: models.an.list } }
  })
  assert.deepEqual(kinds(reloading), ['H:Anthropic', 'M:an:claude-opus-4', 'M:an:claude-haiku-4'])
})

test('teclado: ↑/↓ pulam cabeçalhos e status; destaque inicial = seleção', () => {
  const rows = build({ selected: { providerId: 'an', model: 'claude-opus-4' } })
  assert.equal(initialHighlight(rows), 5)
  assert.equal(nextSelectable(rows, 3, 1), 5) // pula o cabeçalho Anthropic
  assert.equal(nextSelectable(rows, 5, -1), 3)
  assert.equal(nextSelectable(rows, 1, -1), 1) // topo: fica
  assert.equal(nextSelectable(rows, 6, 1), 6) // fim: fica
  assert.equal(initialHighlight(build()), 1)
  assert.equal(initialHighlight(build({ query: 'nada-casa-zz' })), 1) // 1ª opção livre
  const statusOnly = build({ providers: [LOCAL], models: { lo: { status: 'ok', list: [] } } })
  assert.equal(initialHighlight(statusOnly), -1)
})

test('virtualização: offsets, faixa visível, scroll até a linha e cabeçalho grudado', () => {
  const big: Record<string, PickerModels> = {
    or: { status: 'ok', list: Array.from({ length: 460 }, (_, i) => m(`v/m-${i}`)) },
    an: models.an
  }
  const rows = build({ models: big })
  const off = rowOffsets(rows)
  assert.equal(off[0], 0)
  assert.equal(off[1], ROW_HEIGHT.header)
  assert.equal(off[rows.length], ROW_HEIGHT.header * 2 + ROW_HEIGHT.model * 462)
  assert.equal(rowAt(off, 0), 0)
  assert.equal(rowAt(off, ROW_HEIGHT.header + 1), 1)
  const [s, e] = visibleRange(off, 5000, 400, 200)
  assert.ok(e - s < 30, `renderiza poucas linhas: ${e - s}`)
  assert.ok(off[s] <= 4800 && off[e] >= 5600)
  // linha abaixo da janela → rola até o fim dela; acima → até o topo (menos o cabeçalho grudado)
  assert.equal(scrollToRow(off, 20, 0, 400), off[21] - 400)
  assert.equal(scrollToRow(off, 20, 5000, 400, 32), off[20] - 32)
  assert.equal(scrollToRow(off, 20, off[20] - 100, 400), off[20] - 100)
  // cabeçalho grudado: o do grupo da primeira linha visível, quando o real saiu da tela
  assert.equal(stickyHeader(rows, off, 0), -1)
  assert.equal(stickyHeader(rows, off, 5000), 0)
  const anHeader = rows.findIndex((r) => r.kind === 'header' && r.providerId === 'an')
  assert.equal(stickyHeader(rows, off, off[anHeader]), -1) // o real está bem no topo
  assert.equal(stickyHeader(rows, off, off[anHeader] + 10), anHeader)
})

test('par padrão de "Novos chats": provedor apagado ou sem modelo = não definido', () => {
  const ids = ['or', 'an']
  assert.deepEqual(
    defaultModelRef({ defaultProviderId: 'an', defaultModel: 'claude-opus-4' }, ids),
    {
      providerId: 'an',
      model: 'claude-opus-4'
    }
  )
  const unset = { providerId: '', model: '' }
  assert.deepEqual(defaultModelRef({ defaultProviderId: 'gone', defaultModel: 'x' }, ids), unset)
  assert.deepEqual(defaultModelRef({ defaultProviderId: 'or', defaultModel: null }, ids), unset)
  assert.deepEqual(defaultModelRef({ defaultProviderId: null, defaultModel: 'x' }, ids), unset)
})

test('persona: provedor + modelo como par; sem modelo ou provedor apagado → par padrão', () => {
  const base = { providerId: 'or', model: 'openai/gpt-4.1-nano' }
  const ids = ['or', 'an']
  assert.deepEqual(resolvePresetModel(base, { providerId: 'an', model: 'claude-opus-4' }, ids), {
    ref: { providerId: 'an', model: 'claude-opus-4' },
    missingProvider: false
  })
  // sem modelo: o providerId sozinho é ignorado
  assert.deepEqual(resolvePresetModel(base, { providerId: 'an' }, ids).ref, base)
  assert.deepEqual(resolvePresetModel(base, {}, ids).ref, base)
  assert.deepEqual(resolvePresetModel(base, null, ids).ref, base)
  // persona antiga só com modelo → no provedor padrão
  assert.deepEqual(resolvePresetModel(base, { model: 'x/y' }, ids).ref, {
    providerId: 'or',
    model: 'x/y'
  })
  // provedor apagado → par padrão + aviso
  assert.deepEqual(resolvePresetModel(base, { providerId: 'gone', model: 'z' }, ids), {
    ref: base,
    missingProvider: true
  })
})

test('subsessão fica no seu provedor; principal segue o do chat', () => {
  const cfg = { providerId: 'an' }
  assert.equal(sessionProviderId(cfg, { depth: 0, providerId: null }), 'an')
  assert.equal(sessionProviderId(cfg, { depth: 0, providerId: 'or' }), 'an')
  assert.equal(sessionProviderId(cfg, { depth: 1, providerId: 'or' }), 'or')
  assert.equal(sessionProviderId(cfg, { depth: 2, providerId: null }), 'an') // antiga
  assert.equal(sessionProviderId(cfg, null), 'an')
})
