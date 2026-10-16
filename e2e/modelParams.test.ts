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
import { mapModel } from '../src/main/providers.ts'
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
  assert.match(r4.notes!.join('\n'), /minimal enviado como output_config.effort "low"/)
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
  assert.equal(j2.notes, undefined)
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
