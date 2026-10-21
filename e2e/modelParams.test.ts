/* eslint-disable @typescript-eslint/no-explicit-any */
// Parâmetros por modelo (@shared/modelParams): mapeamento do supported_parameters do OpenRouter,
// tabela Anthropic, combinações (temperature+top_p, thinking), omissão + notas no buildRequest,
// valor preservado ao trocar de modelo, juiz do Smart-Approve e compactação filtrados.
// Rodar: npm run test:unit
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  anthropicModelRules,
  conflictOmitted,
  openRouterSupportedParams,
  paramRules,
  paramSupport,
  parseClaudeId,
  PARAM_KEYS
} from '../src/shared/modelParams.ts'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  clampEffort,
  COMMON_EFFORTS,
  effortSpec,
  effortWire,
  openAIEffortRule,
  openRouterReasoning
} from '../src/shared/modelParams.ts'
import { mapModel } from '../src/main/providers.ts'
import { mapAnthropicModel } from '../src/main/agent/adapters/anthropic.ts'
import { buildRequest, setModelInfoSource } from '../src/main/agent/request.ts'
import { buildCompactionRequest } from '../src/main/agent/compaction.ts'
import { buildJudgeRequest } from '../src/main/agent/smartApprove.ts'
import { normalizeSmartApprove } from '../src/shared/smartApprove.ts'
import { DEFAULT_CHAT_CONFIG } from '../src/shared/defaults.ts'
import type { Chat, ChatParams, ModelInfo, Provider } from '../src/shared/types.ts'

const env = { os: 'Linux 6.0 (x64)', shell: 'bash' }
const anth: Provider = {
  id: 'pa',
  name: 'Anthropic',
  kind: 'anthropic',
  baseUrl: 'https://api.anthropic.com/v1',
  apiKey: 'k',
  headers: {},
  createdAt: 0
}
const orp: Provider = {
  ...anth,
  id: 'po',
  kind: 'openrouter',
  baseUrl: 'https://openrouter.ai/api/v1'
}
const gen: Provider = { ...anth, id: 'pg', kind: 'openai', baseUrl: 'https://x.test/v1' }

const chat = (params: ChatParams, over: Partial<Chat['config']> = {}): Chat => ({
  id: 'c1',
  title: '',
  mainSessionId: 's1',
  createdAt: 0,
  updatedAt: 0,
  config: {
    ...DEFAULT_CHAT_CONFIG('/work', { providerId: 'pa', model: 'm', systemPrompt: 'SYS' }),
    enabledTools: [],
    envInPrompt: false,
    params,
    ...over
  } as Chat['config']
})

const models: Record<string, ModelInfo> = {}
setModelInfoSource((pid, model) => models[`${pid}|${model}`])
after(() => setModelInfoSource(() => undefined))

test('OpenRouter: supported_parameters → chaves de ChatParams', () => {
  assert.deepEqual(
    openRouterSupportedParams([
      'include_reasoning',
      'max_tokens',
      'reasoning',
      'response_format',
      'seed',
      'tools'
    ]),
    ['max_tokens', 'seed', 'reasoning_effort']
  )
  // max_completion_tokens → max_tokens; reasoning_effort sozinho também liga
  assert.deepEqual(openRouterSupportedParams(['max_completion_tokens', 'reasoning_effort']), [
    'max_tokens',
    'reasoning_effort'
  ])
  assert.deepEqual(
    openRouterSupportedParams([
      'frequency_penalty',
      'max_tokens',
      'presence_penalty',
      'repetition_penalty',
      'seed',
      'temperature',
      'top_k',
      'top_p'
    ]),
    PARAM_KEYS.filter((k) => k !== 'reasoning_effort')
  )
  assert.equal(openRouterSupportedParams([]), undefined)
  assert.equal(openRouterSupportedParams(undefined), undefined)
  // mapModel preenche supportedParams
  const m = mapModel({
    id: 'anthropic/claude-opus-4.5',
    supported_parameters: ['max_tokens', 'reasoning', 'temperature', 'tools', 'top_k']
  })!
  assert.deepEqual(m.supportedParams, ['temperature', 'top_k', 'max_tokens', 'reasoning_effort'])
  assert.equal(m.supportsTools, true)
  assert.equal(mapModel({ id: 'x' })!.supportedParams, undefined)
})

test('Anthropic: parse do id e tabela de amostragem/effort', () => {
  assert.deepEqual(parseClaudeId('claude-opus-4-5-20251101'), {
    family: 'opus',
    major: 4,
    minor: 5
  })
  assert.deepEqual(parseClaudeId('claude-haiku-4-5-20251001'), {
    family: 'haiku',
    major: 4,
    minor: 5
  })
  assert.deepEqual(parseClaudeId('claude-sonnet-5'), { family: 'sonnet', major: 5, minor: 0 })
  assert.deepEqual(parseClaudeId('claude-3-5-haiku-latest'), {
    family: 'haiku',
    major: 3,
    minor: 5
  })
  assert.deepEqual(parseClaudeId('anthropic/claude-opus-4.7'), {
    family: 'opus',
    major: 4,
    minor: 7
  })
  assert.equal(parseClaudeId('gpt-4o'), null)
  const none = [
    'claude-haiku-5-5',
    'claude-sonnet-5-5',
    'claude-opus-5-5',
    'claude-fable-5-1',
    'claude-opus-5',
    'claude-sonnet-5',
    'claude-fable-5',
    'claude-mythos-preview',
    'claude-opus-4-8',
    'claude-opus-4-7'
  ]
  for (const id of none) assert.equal(anthropicModelRules(id).sampling, 'none', id)
  for (const id of [
    'claude-sonnet-4-6',
    'claude-opus-4-6',
    'claude-opus-4-5-20251101',
    'claude-haiku-4-5-20251001',
    'claude-haiku-4-5',
    'claude-opus-4-1'
  ])
    assert.equal(anthropicModelRules(id).sampling, 'exclusive', id)
  assert.equal(anthropicModelRules('claude-3-5-haiku-latest').sampling, 'all')
  assert.equal(anthropicModelRules('modelo-desconhecido').sampling, 'exclusive')
  // effort (doc "Effort" supportedModels; haiku-4-5 testado → 400)
  for (const id of ['claude-sonnet-4-6', 'claude-opus-4-5-20251101', 'claude-sonnet-5-5'])
    assert.equal(anthropicModelRules(id).effort, true, id)
  for (const id of ['claude-haiku-4-5', 'claude-sonnet-4-5', 'claude-opus-4-1'])
    assert.equal(anthropicModelRules(id).effort, false, id)
})

test('regras: visíveis por provider/modelo', () => {
  const s55 = paramRules({ kind: 'anthropic', model: 'claude-sonnet-5-5' })
  assert.deepEqual(s55.supported, ['max_tokens', 'reasoning_effort'])
  const h45 = paramRules({ kind: 'anthropic', model: 'claude-haiku-4-5' })
  assert.deepEqual(h45.supported, ['temperature', 'top_p', 'top_k', 'max_tokens'])
  assert.deepEqual(h45.exclusive, [['temperature', 'top_p']])
  // thinking ligado: temperature e top_k somem; top_p fica (≥ 0.95); sem par exclusivo
  const th = paramRules({
    kind: 'anthropic',
    model: 'claude-haiku-4-5',
    extra: { thinking: { type: 'enabled', budget_tokens: 1024 } }
  })
  assert.deepEqual(th.supported, ['top_p', 'max_tokens'])
  assert.equal(th.thinking, true)
  assert.deepEqual(th.exclusive, [])
  // genérico sem info → todos; OpenRouter com lista → só a lista
  assert.deepEqual(paramRules({ kind: 'openai', model: 'x' }).supported, PARAM_KEYS)
  assert.deepEqual(
    paramRules({
      kind: 'openrouter',
      model: 'openai/o4-mini',
      info: { supportedParams: ['max_tokens', 'seed', 'reasoning_effort'] }
    }).supported,
    ['max_tokens', 'seed', 'reasoning_effort']
  )
  assert.deepEqual(paramRules({ kind: 'openrouter', model: 'x', info: null }).supported, PARAM_KEYS)
})

test('combinações: temperature+top_p (4.x) e limites do thinking', () => {
  const both = paramSupport({
    kind: 'anthropic',
    model: 'claude-haiku-4-5',
    params: { temperature: 0.5, top_p: 0.9 }
  })
  assert.deepEqual(both.send, { temperature: 0.5 })
  assert.equal(both.notes.length, 1)
  assert.match(
    both.notes[0],
    /^top_p omitido: claude-haiku-4-5 não aceita temperature e top_p juntos/
  )
  assert.deepEqual([...conflictOmitted(both)], ['top_p'])

  const th = paramSupport({
    kind: 'anthropic',
    model: 'claude-sonnet-4-6',
    extra: { thinking: { type: 'adaptive' } },
    params: { temperature: 0.5, top_k: 5, top_p: 0.9, max_tokens: 2000 }
  })
  assert.deepEqual(th.send, { max_tokens: 2000 })
  assert.deepEqual(
    th.omitted.map((o) => o.key),
    ['temperature', 'top_k', 'top_p']
  )
  assert.match(
    th.notes.join('\n'),
    /top_p omitido: com thinking ligado a API só aceita top_p ≥ 0.95/
  )
  const ok = paramSupport({
    kind: 'anthropic',
    model: 'claude-sonnet-4-6',
    extra: { thinking: { type: 'enabled', budget_tokens: 1024 } },
    params: { top_p: 0.97 }
  })
  assert.deepEqual(ok.send, { top_p: 0.97 })
  assert.deepEqual(ok.notes, [])
  // thinking desligado explicitamente não restringe
  const off = paramSupport({
    kind: 'anthropic',
    model: 'claude-haiku-4-5',
    extra: { thinking: { type: 'disabled' } },
    params: { top_k: 3 }
  })
  assert.deepEqual(off.send, { top_k: 3 })
})

test('buildRequest: omite o não suportado, anota e preserva o valor salvo', () => {
  const params: ChatParams = { temperature: 0.3, top_k: 7, max_tokens: 100, seed: 1 }
  const c = chat(params, { model: 'claude-sonnet-5-5' })
  const r = buildRequest(c, { depth: 0, model: 'claude-sonnet-5-5' }, [], anth, env)
  const b = r.body as any
  assert.equal(b.temperature, undefined)
  assert.equal(b.top_k, undefined)
  assert.equal(b.seed, undefined)
  assert.equal(b.max_tokens, 100)
  assert.ok(
    r.notes!.includes(
      'temperature omitido: não suportado por claude-sonnet-5-5 (a API rejeita valores fora do padrão).'
    )
  )
  assert.ok(r.notes!.some((n) => n.startsWith('seed omitido: não existe na API nativa')))
  // nada foi apagado do chat
  assert.deepEqual(c.config.params, params)
  // o mesmo chat em um modelo que aceita → volta a ir com o valor antigo
  const r2 = buildRequest(c, { depth: 0, model: 'claude-haiku-4-5' }, [], anth, env)
  assert.equal((r2.body as any).temperature, 0.3)
  assert.equal((r2.body as any).top_k, 7)

  // haiku-4-5: temperature + top_p → só temperature
  const r3 = buildRequest(
    chat({ temperature: 0.5, top_p: 0.9 }),
    { depth: 0, model: 'claude-haiku-4-5' },
    [],
    anth,
    env
  )
  assert.equal((r3.body as any).temperature, 0.5)
  assert.equal((r3.body as any).top_p, undefined)
  assert.equal(r3.notes!.length, 1)

  // reasoning_effort → output_config.effort (minimal → low, com nota); haiku-4-5 não aceita
  const r4 = buildRequest(
    chat({ reasoning_effort: 'minimal' }),
    { depth: 0, model: 'claude-sonnet-4-6' },
    [],
    anth,
    env
  )
  assert.deepEqual((r4.body as any).output_config, { effort: 'low' })
  assert.ok(
    r4.notes!.includes(
      'reasoning_effort ajustado: claude-sonnet-4-6 não aceita "minimal" (níveis: low, medium, high, max); enviado "low".'
    )
  )
  const r5 = buildRequest(
    chat({ reasoning_effort: 'high' }),
    { depth: 0, model: 'claude-haiku-4-5' },
    [],
    anth,
    env
  )
  assert.equal((r5.body as any).output_config, undefined)

  // sem nada omitido → sem notes
  const r6 = buildRequest(
    chat({ max_tokens: 5 }),
    { depth: 0, model: 'claude-haiku-4-5' },
    [],
    anth,
    env
  )
  assert.equal(r6.notes, undefined)
})

test('buildRequest OpenRouter/genérico: supported_parameters do /models', () => {
  models['po|openai/o4-mini'] = {
    id: 'openai/o4-mini',
    supportedParams: ['max_tokens', 'seed', 'reasoning_effort']
  }
  const params: ChatParams = { temperature: 0.2, top_p: 0.5, seed: 3, reasoning_effort: 'low' }
  const r = buildRequest(
    chat(params, { providerId: 'po' }),
    { depth: 0, model: 'openai/o4-mini' },
    [],
    orp,
    env
  )
  const b = r.body as any
  assert.equal(b.temperature, undefined)
  assert.equal(b.top_p, undefined)
  assert.equal(b.seed, 3)
  assert.deepEqual(b.reasoning, { effort: 'low' })
  assert.deepEqual(r.notes, [
    'temperature omitido: não suportado por openai/o4-mini.',
    'top_p omitido: não suportado por openai/o4-mini.'
  ])
  // modelo fora da lista do /models (desconhecido) → todos
  const r2 = buildRequest(chat(params), { depth: 0, model: 'x/desconhecido' }, [], orp, env)
  assert.equal((r2.body as any).temperature, 0.2)
  assert.equal(r2.notes, undefined)
  // genérico: todos
  const r3 = buildRequest(chat(params), { depth: 0, model: 'gpt' }, [], gen, env)
  assert.equal((r3.body as any).temperature, 0.2)
  assert.equal((r3.body as any).reasoning_effort, 'low')
})

test('compactação passa pelo mesmo filtro', () => {
  const c = chat({ temperature: 0.4, max_tokens: 50 })
  const session = { id: 's1', depth: 0, model: 'claude-opus-5-5' } as any
  const r = buildCompactionRequest(
    c,
    session,
    [],
    anth,
    'Resuma.',
    { mode: 'full', window: null } as any,
    env
  )
  assert.equal((r.body as any).temperature, undefined)
  assert.equal((r.body as any).max_tokens, 50)
  assert.ok(r.notes?.some((n) => n.startsWith('temperature omitido')))
})

test('juiz do Smart-Approve: temperature 0 omitido onde não é aceito', () => {
  const ctx = { tool: 'read_file', args: { path: 'x' }, history: [] } as any
  const sa = (model: string, providerId = 'pa'): any =>
    normalizeSmartApprove({ enabled: true, providerId, model } as any)
  const j = buildJudgeRequest({ sa: sa('claude-sonnet-5-5'), provider: anth, chatConfig: {}, ctx })!
  assert.equal((j.body as any).temperature, undefined)
  assert.equal((j.body as any).max_tokens, 300)
  assert.match(j.notes!.join(), /temperature omitido/)
  const j2 = buildJudgeRequest({ sa: sa('claude-haiku-4-5'), provider: anth, chatConfig: {}, ctx })!
  assert.equal((j2.body as any).temperature, 0)
  assert.deepEqual(
    (j2.notes ?? []).filter((n) => !n.startsWith('Cache do prompt')),
    [],
    'sem notas de parâmetros'
  )
  models['po|openai/o4-mini'] = { id: 'openai/o4-mini', supportedParams: ['max_tokens'] }
  const j3 = buildJudgeRequest({
    sa: sa('openai/o4-mini', 'po'),
    provider: orp,
    chatConfig: {},
    ctx
  })!
  assert.equal((j3.body as any).temperature, undefined)
  assert.equal((j3.body as any).max_tokens, 300)
  assert.deepEqual((j3.body as any).usage, { include: true })
})

// ---------------- reasoning_effort: níveis derivados do modelo ----------------
// Fixture: recorte real do GET https://openrouter.ai/api/v1/models (público, sem key).

const FIXTURE = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), 'fixtures/openrouter-models.json'),
    'utf8'
  )
) as { data: Record<string, unknown>[] }
const orModel = (id: string): ModelInfo => {
  const raw = FIXTURE.data.find((m) => m.id === id)
  assert.ok(raw, `fixture sem ${id}`)
  return mapModel(raw)!
}
const orRules = (id: string): ReturnType<typeof paramRules> =>
  paramRules({ kind: 'openrouter', model: id, info: orModel(id) })

test('OpenRouter (fixture real): reasoning_effort só onde supported_parameters tem reasoning', () => {
  for (const id of ['openai/gpt-4o-mini', 'openai/gpt-5.2-chat', 'deepseek/deepseek-chat']) {
    const r = orRules(id)
    assert.ok(!r.supported.includes('reasoning_effort'), id)
    assert.equal(r.effort, null, id)
    assert.equal(orModel(id).reasoning, undefined, id)
  }
  assert.ok(orRules('openai/gpt-4o-mini').supported.includes('temperature'))
  for (const id of ['openai/gpt-5', 'openai/o4-mini', 'anthropic/claude-sonnet-4.6'])
    assert.ok(orRules(id).supported.includes('reasoning_effort'), id)
})

test('OpenRouter (fixture real): níveis = reasoning.supported_efforts (ordem crescente)', () => {
  const expect: Record<string, string[]> = {
    'openai/gpt-5': ['minimal', 'low', 'medium', 'high'],
    'openai/gpt-5-pro': ['high'],
    'openai/gpt-5.1': ['none', 'low', 'medium', 'high'],
    'openai/gpt-5.5': ['none', 'low', 'medium', 'high', 'xhigh'],
    'openai/gpt-5.5-pro': ['medium', 'high', 'xhigh'],
    'openai/o3-mini-high': ['high'],
    'openai/gpt-oss-120b': ['low', 'medium', 'high'],
    'anthropic/claude-sonnet-4.6': ['none', 'low', 'medium', 'high', 'max'],
    'anthropic/claude-sonnet-5.5': ['low', 'medium', 'high', 'xhigh', 'max'],
    'anthropic/claude-haiku-5.5': ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
    'google/gemini-3-flash-preview': ['none', 'minimal', 'low', 'medium', 'high'],
    'google/gemini-3.1-pro-preview': ['low', 'medium', 'high'],
    'deepseek/deepseek-v4-pro': ['none', 'high', 'xhigh'],
    'x-ai/grok-4.3': ['none', 'low', 'medium', 'high'],
    'qwen/qwen3.8-max-prime': ['minimal', 'low', 'medium', 'high', 'xhigh']
  }
  for (const [id, levels] of Object.entries(expect)) {
    const e = orRules(id).effort!
    assert.deepEqual(e.levels, levels, id)
    assert.equal(e.source, 'api', id)
    assert.equal(e.known, true, id)
    assert.match(e.origin, /reasoning\.supported_efforts/, id)
    assert.equal(e.wire, 'reasoning: { effort: "<nível>" }')
  }
  // default_effort do /models vira o padrão ao ligar; mandatory é exposto
  assert.equal(orRules('x-ai/grok-4.3').effort!.default, 'low')
  assert.equal(orRules('qwen/qwen3.8-max-prime').effort!.default, 'xhigh')
  assert.equal(orRules('anthropic/claude-sonnet-5.5').effort!.mandatory, true)
  assert.equal(orRules('openai/gpt-5.1').effort!.mandatory, undefined)
})

test('OpenRouter (fixture real): reasoning sem supported_efforts → conjunto comum, "não informado"', () => {
  for (const id of [
    'openai/o4-mini',
    'anthropic/claude-opus-4.5',
    'anthropic/claude-haiku-4.5',
    'google/gemini-2.5-flash',
    'deepseek/deepseek-r1',
    'qwen/qwen3-235b-a22b-thinking-2507'
  ]) {
    const e = orRules(id).effort!
    assert.deepEqual(e.levels, COMMON_EFFORTS, id)
    assert.equal(e.source, 'unknown', id)
    assert.equal(e.known, false, id)
    assert.match(e.origin, /a API não lista níveis/, id)
  }
  // nível desconhecido não é "corrigido" (o OpenRouter leva ao mais próximo)
  const s = paramSupport({
    kind: 'openrouter',
    model: 'openai/o4-mini',
    info: orModel('openai/o4-mini'),
    params: { reasoning_effort: 'minimal' }
  })
  assert.equal(s.send.reasoning_effort, 'minimal')
  assert.equal(s.effortAdjust, undefined)
})

test('openRouterReasoning: null = todos os níveis; ausente = não informado; níveis estranhos ignorados', () => {
  assert.deepEqual(openRouterReasoning({ supported_efforts: null, mandatory: true }), {
    efforts: null,
    mandatory: true
  })
  assert.deepEqual(openRouterReasoning({ mandatory: false }), { mandatory: false })
  assert.deepEqual(
    openRouterReasoning({ supported_efforts: ['high', 'ultra', 'low'], default_effort: 'ultra' }),
    { efforts: ['low', 'high'] }
  )
  assert.equal(openRouterReasoning(null), undefined)
  const all = effortSpec({
    kind: 'openrouter',
    model: 'x',
    info: { reasoning: { efforts: null, mandatory: true } }
  })
  assert.deepEqual(all.levels, ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
  assert.equal(all.source, 'api')
})

test('clamp: valor salvo fora dos níveis do modelo → mais próximo (ou omitido) + aviso', () => {
  const cases: [string, ChatParams['reasoning_effort'], string | undefined][] = [
    ['openai/o3-mini-high', 'minimal', 'high'],
    ['openai/gpt-5.1', 'minimal', 'low'], // não vira "none" (desligaria o raciocínio)
    ['openai/gpt-5.5', 'max', 'xhigh'],
    ['openai/gpt-5-pro', 'low', 'high'],
    ['google/gemini-3.1-pro-preview', 'minimal', 'low'],
    ['deepseek/deepseek-v4-pro', 'medium', 'high'],
    ['anthropic/claude-sonnet-4.6', 'xhigh', 'high'],
    ['anthropic/claude-sonnet-5.5', 'none', undefined], // mandatory: "none" não existe
    ['openai/gpt-5', 'minimal', 'minimal'] // válido: vai como está
  ]
  for (const [id, from, to] of cases) {
    const s = paramSupport({
      kind: 'openrouter',
      model: id,
      info: orModel(id),
      params: { reasoning_effort: from }
    })
    assert.equal(s.send.reasoning_effort, to, `${id} ${from}`)
    if (to === from) assert.equal(s.effortAdjust, undefined)
    else {
      assert.deepEqual(
        { from: s.effortAdjust?.from, to: s.effortAdjust?.to },
        { from, to },
        `${id} ${from}`
      )
      assert.ok(
        s.notes.some((n) => n.startsWith('reasoning_effort ')),
        id
      )
    }
  }
  assert.equal(clampEffort('xhigh', { levels: COMMON_EFFORTS, known: false }), 'xhigh')
  assert.equal(clampEffort('none', { levels: ['low', 'high'], known: true }), undefined)
})

test('buildRequest: formato no body por tipo de provider; desligado = omitido', () => {
  models['po|openai/gpt-5.1'] = orModel('openai/gpt-5.1')
  models['po|openai/gpt-4o-mini'] = orModel('openai/gpt-4o-mini')
  const or = (model: string, params: ChatParams): any =>
    buildRequest(chat(params, { providerId: 'po' }), { depth: 0, model }, [], orp, env)
  // OpenRouter: reasoning: {effort}; nível inválido ajustado; modelo sem reasoning → omitido
  assert.deepEqual(or('openai/gpt-5.1', { reasoning_effort: 'high' }).body.reasoning, {
    effort: 'high'
  })
  const adj = or('openai/gpt-5.1', { reasoning_effort: 'minimal' })
  assert.deepEqual(adj.body.reasoning, { effort: 'low' })
  assert.equal(adj.body.reasoning_effort, undefined)
  const no = or('openai/gpt-4o-mini', { reasoning_effort: 'high' })
  assert.equal(no.body.reasoning, undefined)
  assert.equal(no.body.reasoning_effort, undefined)
  assert.ok(no.notes.some((n: string) => n.startsWith('reasoning_effort omitido')))
  // openai genérico: reasoning_effort na raiz; gpt-4o-mini (tabela) → omitido; o3 minimal → low
  const g = (model: string, params: ChatParams): any =>
    buildRequest(chat(params), { depth: 0, model }, [], gen, env).body
  assert.equal(g('gpt-5-mini', { reasoning_effort: 'minimal' }).reasoning_effort, 'minimal')
  assert.equal(g('o3', { reasoning_effort: 'minimal' }).reasoning_effort, 'low')
  assert.equal(g('gpt-4o-mini', { reasoning_effort: 'high' }).reasoning_effort, undefined)
  assert.equal(g('gpt-5-mini', { reasoning_effort: 'low' }).reasoning, undefined)
  // Anthropic nativa: output_config.effort; xhigh em sonnet-4-6 (tabela) → high
  const a = (model: string, params: ChatParams): any =>
    buildRequest(chat(params), { depth: 0, model }, [], anth, env).body
  assert.deepEqual(a('claude-sonnet-5-5', { reasoning_effort: 'max' }).output_config, {
    effort: 'max'
  })
  assert.deepEqual(a('claude-sonnet-4-6', { reasoning_effort: 'xhigh' }).output_config, {
    effort: 'high'
  })
  // toggle desligado (ausente ou null) → nenhum campo de raciocínio em nenhum formato
  for (const params of [{}, { reasoning_effort: null as any }]) {
    assert.equal(or('openai/gpt-5.1', params).body.reasoning, undefined)
    assert.equal(g('gpt-5-mini', params).reasoning_effort, undefined)
    assert.equal(a('claude-sonnet-5-5', params).output_config, undefined)
  }
  assert.equal(effortWire('openai'), '"reasoning_effort": "<nível>"')
  assert.equal(effortWire('anthropic'), 'output_config: { effort: "<nível>" }')
})

test('Anthropic nativa: capabilities.effort do /v1/models manda; tabela só sem capabilities', () => {
  const lvl = (s: boolean): { supported: boolean } => ({ supported: s })
  // formato da doc (api/models/list): effort.{low,medium,high,max,xhigh}.supported
  const m46 = mapAnthropicModel({
    id: 'claude-opus-4-6',
    capabilities: {
      image_input: lvl(true),
      pdf_input: lvl(true),
      effort: {
        supported: true,
        low: lvl(true),
        medium: lvl(true),
        high: lvl(true),
        max: lvl(true),
        xhigh: null
      }
    }
  })!
  assert.deepEqual(m46.reasoning, {
    effortSupported: true,
    efforts: ['low', 'medium', 'high', 'max']
  })
  const e = paramRules({ kind: 'anthropic', model: m46.id, info: m46 }).effort!
  assert.deepEqual(e.levels, ['low', 'medium', 'high', 'max'])
  assert.equal(e.source, 'api')
  assert.match(e.origin, /capabilities\.effort/)
  assert.equal(e.wire, 'output_config: { effort: "<nível>" }')
  // API diz que não aceita → oculto, mesmo que a tabela dissesse o contrário
  const off = mapAnthropicModel({
    id: 'claude-sonnet-5-5',
    capabilities: { effort: { supported: false } }
  })!
  const r = paramRules({ kind: 'anthropic', model: off.id, info: off })
  assert.ok(!r.supported.includes('reasoning_effort'))
  assert.equal(r.effort, null)
  // sem capabilities → tabela (doc "Effort levels")
  const table: Record<string, string[]> = {
    'claude-opus-4-5-20251101': ['low', 'medium', 'high'],
    'claude-opus-4-6': ['low', 'medium', 'high', 'max'],
    'claude-sonnet-4-6': ['low', 'medium', 'high', 'max'],
    'claude-mythos-preview': ['low', 'medium', 'high', 'max'],
    'claude-opus-4-7': ['low', 'medium', 'high', 'xhigh', 'max'],
    'claude-sonnet-5-5': ['low', 'medium', 'high', 'xhigh', 'max'],
    'claude-haiku-5-5': ['low', 'medium', 'high', 'xhigh', 'max'],
    'claude-fable-5-1': ['low', 'medium', 'high', 'xhigh', 'max']
  }
  for (const [id, levels] of Object.entries(table)) {
    const t = paramRules({ kind: 'anthropic', model: id }).effort!
    assert.deepEqual(t.levels, levels, id)
    assert.equal(t.source, 'table', id)
  }
  assert.equal(paramRules({ kind: 'anthropic', model: 'claude-haiku-4-5' }).effort, null)
})

test('openai genérico: tabela por família (conferida contra o OpenRouter) e desconhecido', () => {
  // a tabela bate com supported_efforts do OpenRouter para os mesmos modelos
  for (const id of [
    'openai/gpt-5',
    'openai/gpt-5-pro',
    'openai/gpt-5.1',
    'openai/gpt-5.5',
    'openai/gpt-5.5-pro',
    'openai/gpt-oss-120b'
  ])
    assert.deepEqual(openAIEffortRule(id)?.efforts, orModel(id).reasoning!.efforts, id)
  assert.equal(openAIEffortRule('openai/gpt-4o-mini')?.reasoning, false)
  assert.equal(orModel('openai/gpt-4o-mini').reasoning, undefined)

  const spec = (model: string): any => paramRules({ kind: 'openai', model }).effort
  assert.deepEqual(spec('gpt-5-mini-2025-08-07').levels, ['minimal', 'low', 'medium', 'high'])
  assert.deepEqual(spec('o4-mini').levels, ['low', 'medium', 'high'])
  assert.deepEqual(spec('gpt-5.4-nano').levels, ['none', 'low', 'medium', 'high', 'xhigh'])
  assert.equal(spec('o3').source, 'table')
  assert.match(spec('o3').origin, /Tabela interna/)
  assert.equal(spec('gpt-4o-mini'), null)
  assert.ok(
    !paramRules({ kind: 'openai', model: 'gpt-4.1' }).supported.includes('reasoning_effort')
  )
  for (const id of ['llama-3.3-70b', 'o1-mini', 'gpt-5-codex', 'gpt-5.6-luna', 'qwen3:32b']) {
    assert.equal(spec(id).source, 'unknown', id)
    assert.deepEqual(spec(id).levels, COMMON_EFFORTS, id)
  }
  // endpoint genérico que devolve supported_parameters/reasoning (ex.: proxy) → vale a API
  const proxied = mapModel({
    id: 'gpt-4o-mini',
    supported_parameters: ['reasoning', 'max_tokens'],
    reasoning: { supported_efforts: ['high', 'low'] }
  })!
  assert.deepEqual(
    paramRules({ kind: 'openai', model: 'gpt-4o-mini', info: proxied }).effort!.levels,
    ['low', 'high']
  )
})
