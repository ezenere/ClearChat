/* eslint-disable @typescript-eslint/no-explicit-any */
// Raciocínio nas chamadas laterais (@shared/sideReasoning): política por provedor/modelo (desligar
// onde dá; obrigatório → esforço mínimo + "tokens de pensamento" somados ao max_tokens; desconhecido
// → nada), normalização dos campos novos e o body exato do juiz/resumidor/título.
// Rodar: npm run test:unit
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { anthropicThinkingRule } from '../src/shared/modelParams.ts'
import {
  normalizeThinkingTokens,
  planSideCall,
  sideAnthropicPreviewBody,
  sideReasoning,
  SIDE_THINKING
} from '../src/shared/sideReasoning.ts'
import { normalizeSmartApprove } from '../src/shared/smartApprove.ts'
import { normalizeCapture, normalizeSmartDefaults } from '../src/shared/smartDefaults.ts'
import { normalizeAutoTitleSettings, defaultAutoTitleSettings } from '../src/shared/autoTitle.ts'
import { mapModel } from '../src/main/providers.ts'
import { setModelInfoSource } from '../src/main/agent/request.ts'
import { buildJudgeRequest, buildSideRequest } from '../src/main/agent/smartApprove.ts'
import { buildAutoTitleRequest } from '../src/main/agent/autoTitle.ts'
import type { ModelInfo, Provider } from '../src/shared/types.ts'

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

// Recortes reais do GET https://openrouter.ai/api/v1/models (2026-10-21, público).
const OR_RAW: Record<string, unknown>[] = [
  {
    id: 'anthropic/claude-haiku-5.5',
    supported_parameters: ['include_reasoning', 'max_tokens', 'reasoning'],
    reasoning: {
      mandatory: false,
      supported_efforts: ['max', 'xhigh', 'high', 'medium', 'low', 'none'],
      default_effort: 'medium'
    }
  },
  {
    id: 'anthropic/claude-opus-5.5',
    supported_parameters: ['include_reasoning', 'max_tokens', 'reasoning'],
    reasoning: {
      mandatory: true,
      supported_efforts: ['max', 'xhigh', 'high', 'medium', 'low'],
      default_effort: 'high'
    }
  },
  {
    id: 'anthropic/claude-haiku-4.5',
    supported_parameters: ['include_reasoning', 'max_tokens', 'reasoning', 'temperature'],
    reasoning: { mandatory: false }
  },
  {
    id: 'google/gemma-4-31b-it',
    supported_parameters: ['max_tokens', 'reasoning', 'temperature'],
    reasoning: { mandatory: false, default_enabled: false }
  },
  {
    id: 'meta/llama-plain',
    supported_parameters: ['max_tokens', 'temperature']
  }
]
const models: Record<string, ModelInfo> = {}
for (const raw of OR_RAW) models[`po|${raw.id}`] = mapModel(raw)!
setModelInfoSource((pid, model) => models[`${pid}|${model}`])
after(() => setModelInfoSource(() => undefined))

const info = (id: string): ModelInfo => models[`po|${id}`]

const ctx = { tool: 'read_file', args: { path: 'x' }, history: [] } as any
const judge = (provider: Provider, model: string, extra: Record<string, unknown> = {}): any =>
  buildJudgeRequest({
    sa: normalizeSmartApprove({ providerId: provider.id, model, ...extra } as any),
    provider,
    chatConfig: {},
    ctx
  })!

test('tabela Anthropic: como desligar o raciocínio por modelo', () => {
  const off = (m: string): unknown => anthropicThinkingRule(m)?.off
  assert.equal(off('claude-haiku-4-5'), 'omit')
  assert.equal(off('claude-sonnet-4-5-20250929'), 'omit')
  assert.equal(off('claude-opus-4-5'), 'omit')
  assert.equal(off('claude-opus-4-6'), 'omit')
  assert.equal(off('claude-sonnet-4-6'), 'omit')
  assert.equal(off('claude-opus-4-8'), 'omit')
  assert.equal(off('claude-3-5-haiku-latest'), 'omit')
  assert.equal(off('claude-sonnet-5'), 'disabled')
  assert.equal(off('claude-opus-5'), 'disabled')
  assert.equal(off('claude-haiku-5-5'), 'disabled')
  assert.equal(off('claude-sonnet-5-5'), 'between_tools')
  assert.equal(off('claude-opus-5-5'), null)
  assert.equal(off('claude-fable-5-1'), null)
  assert.equal(off('claude-fable-5'), null)
  assert.equal(off('claude-mythos-5-1'), null)
  assert.equal(anthropicThinkingRule('claude-opus-5-5')?.inferred, undefined)
  assert.deepEqual(anthropicThinkingRule('claude-opus-6'), { off: null, inferred: true })
  assert.deepEqual(anthropicThinkingRule('claude-sonnet-5-7'), { off: null, inferred: true })
  assert.equal(anthropicThinkingRule('gpt-5'), null)
})

test('política: modos por provedor', () => {
  const a = (model: string): any => sideReasoning({ kind: 'anthropic', model })
  assert.deepEqual(
    [a('claude-haiku-4-5').mode, a('claude-haiku-4-5').effort, a('claude-haiku-4-5').thinking],
    ['off', undefined, undefined]
  )
  assert.deepEqual(a('claude-haiku-5-5').thinking, { type: 'disabled' })
  assert.equal(a('claude-haiku-5-5').effort, 'low')
  assert.equal(a('claude-haiku-5-5').explicitOff, true)
  assert.deepEqual(a('claude-sonnet-5-5').thinking, { type: 'between_tools' })
  assert.equal(a('claude-opus-4-8').thinking, undefined, 'Opus 4.8 não pensa sem thinking')
  assert.equal(a('claude-opus-4-8').mode, 'off')
  for (const m of ['claude-opus-5-5', 'claude-fable-5-1', 'claude-fable-5']) {
    assert.equal(a(m).mode, 'minimal', m)
    assert.equal(a(m).mandatory, true, m)
    assert.equal(a(m).effort, 'low', m)
    assert.equal(a(m).thinking, undefined, m)
  }
  assert.equal(a('claude-opus-6').mandatory, false, 'fora da tabela: presumido')
  assert.equal(a('meu-modelo').mode, 'unknown')
  // OpenRouter (metadados reais)
  const o = (id: string): any => sideReasoning({ kind: 'openrouter', model: id, info: info(id) })
  assert.deepEqual(
    [o('anthropic/claude-haiku-5.5').mode, o('anthropic/claude-haiku-5.5').effort],
    ['off', 'none']
  )
  assert.deepEqual(
    [o('anthropic/claude-opus-5.5').mode, o('anthropic/claude-opus-5.5').effort],
    ['minimal', 'low']
  )
  assert.equal(o('anthropic/claude-haiku-4.5').mode, 'unknown', 'sem níveis: nada')
  assert.equal(o('google/gemma-4-31b-it').mode, 'off', 'default_enabled false: já desligado')
  assert.equal(o('google/gemma-4-31b-it').effort, undefined)
  assert.equal(o('meta/llama-plain').mode, 'off', 'sem raciocínio')
  assert.equal(o('meta/llama-plain').effort, undefined)
  assert.equal(sideReasoning({ kind: 'openrouter', model: 'x/desconhecido' }).mode, 'unknown')
  // openai genérico: tabela conferida
  const g = (m: string): any => sideReasoning({ kind: 'openai', model: m })
  assert.deepEqual([g('gpt-5.1').mode, g('gpt-5.1').effort], ['off', 'none'])
  assert.deepEqual([g('gpt-5-mini').mode, g('gpt-5-mini').effort], ['minimal', 'minimal'])
  assert.deepEqual([g('o4-mini').mode, g('o4-mini').effort], ['minimal', 'low'])
  assert.equal(g('gpt-4o').mode, 'off')
  assert.equal(g('gpt-4o').effort, undefined)
  assert.equal(g('llama-3-70b').mode, 'unknown')
  assert.equal(g('llama-3-70b').effort, undefined)
})

test('normalização dos tokens de pensamento (juiz, resumidor, título)', () => {
  assert.equal(normalizeThinkingTokens(undefined), null)
  assert.equal(normalizeThinkingTokens(null), null)
  assert.equal(normalizeThinkingTokens('2000'), null)
  assert.equal(normalizeThinkingTokens(NaN), null)
  assert.equal(normalizeThinkingTokens(3000.4), 3000)
  assert.equal(normalizeThinkingTokens(10), SIDE_THINKING.min)
  assert.equal(normalizeThinkingTokens(1e9), SIDE_THINKING.max)
  // ausente → campo ausente (objetos antigos ficam iguais)
  assert.equal('thinkingTokens' in normalizeSmartApprove({}), false)
  assert.equal(normalizeSmartApprove({ thinkingTokens: 4096 } as any).thinkingTokens, 4096)
  assert.equal(normalizeSmartApprove({ thinkingTokens: 1 } as any).thinkingTokens, 256)
  assert.equal('thinkingTokens' in normalizeCapture({}), false)
  assert.equal(normalizeCapture({ thinkingTokens: 5000 }).thinkingTokens, 5000)
  assert.equal(
    normalizeSmartDefaults({ capture: { thinkingTokens: 999 } }).capture.thinkingTokens,
    999
  )
  assert.equal(
    normalizeSmartApprove({ capture: { thinkingTokens: 700 } } as any).capture?.thinkingTokens,
    700
  )
  assert.deepEqual(normalizeAutoTitleSettings({}), defaultAutoTitleSettings())
  assert.equal(normalizeAutoTitleSettings({ thinkingTokens: 512 }).thinkingTokens, 512)
  assert.equal('thinkingTokens' in normalizeAutoTitleSettings({ thinkingTokens: null }), false)
})

test('juiz Anthropic: corpo por modelo', () => {
  // Haiku 4.5: nada de raciocínio, temperature 0 aceito, 300
  const h45 = judge(anth, 'claude-haiku-4-5').body
  assert.equal(h45.thinking, undefined)
  assert.equal(h45.output_config, undefined)
  assert.equal(h45.temperature, 0)
  assert.equal(h45.max_tokens, 300)
  // Haiku 5.5: desligado com disabled; temperature não vai (400 em valores fora do padrão)
  const h55 = judge(anth, 'claude-haiku-5-5')
  assert.deepEqual(h55.body.thinking, { type: 'disabled' })
  assert.deepEqual(h55.body.output_config, { effort: 'low' })
  assert.equal(h55.body.temperature, undefined)
  assert.equal(h55.body.max_tokens, 300)
  assert.ok(h55.notes.some((n: string) => n.includes('thinking {type: "disabled"}')))
  // Sonnet 5.5: between_tools, sem outro campo de thinking
  const s55 = judge(anth, 'claude-sonnet-5-5').body
  assert.deepEqual(s55.thinking, { type: 'between_tools' })
  assert.deepEqual(s55.output_config, { effort: 'low' })
  assert.equal(s55.max_tokens, 300)
  // Opus 5.5 / Fable 5.1: obrigatório → sem thinking, effort low, 300 + padrão
  for (const m of ['claude-opus-5-5', 'claude-fable-5-1']) {
    const r = judge(anth, m)
    assert.equal(r.body.thinking, undefined, m)
    assert.deepEqual(r.body.output_config, { effort: 'low' }, m)
    assert.equal(r.body.temperature, undefined, m)
    assert.equal(r.body.max_tokens, 300 + SIDE_THINKING.judge, m)
    assert.ok(
      r.notes.some((n: string) => n.includes('tokens de pensamento')),
      m
    )
  }
  assert.equal(judge(anth, 'claude-opus-5-5', { thinkingTokens: 5000 }).body.max_tokens, 5300)
  // Opus 4.8: já não pensa sem thinking → nada de thinking; effort low
  const o48 = judge(anth, 'claude-opus-4-8').body
  assert.equal(o48.thinking, undefined)
  assert.deepEqual(o48.output_config, { effort: 'low' })
  assert.equal(o48.max_tokens, 300)
  // thinkingTokens não muda nada fora do modo minimal
  assert.equal(judge(anth, 'claude-haiku-5-5', { thinkingTokens: 5000 }).body.max_tokens, 300)
})

test('juiz OpenRouter / openai genérico', () => {
  const h = judge(orp, 'anthropic/claude-haiku-5.5').body
  assert.deepEqual(h.reasoning, { effort: 'none' })
  assert.equal(h.max_tokens, 300)
  assert.equal(h.temperature, undefined, 'temperature fora do supported_parameters')
  const o = judge(orp, 'anthropic/claude-opus-5.5', { thinkingTokens: 1000 })
  assert.deepEqual(o.body.reasoning, { effort: 'low' })
  assert.equal(o.body.max_tokens, 1300)
  const h45 = judge(orp, 'anthropic/claude-haiku-4.5').body
  assert.equal(h45.reasoning, undefined)
  assert.equal(h45.temperature, 0)
  assert.equal(h45.max_tokens, 300)
  // genérico desconhecido: nada além de temperature/max_tokens
  const u = judge(gen, 'llama-3-70b').body
  assert.equal(u.reasoning_effort, undefined)
  assert.equal(u.reasoning, undefined)
  assert.equal(u.temperature, 0)
  assert.equal(u.max_tokens, 300)
  // genérico com tabela: série o (obrigatório) → low + pensamento, sem temperature
  const o4 = judge(gen, 'o4-mini').body
  assert.equal(o4.reasoning_effort, 'low')
  assert.equal(o4.temperature, undefined)
  assert.equal(o4.max_tokens, 300 + SIDE_THINKING.judge)
  assert.equal(judge(gen, 'gpt-5.1').body.reasoning_effort, 'none')
})

test('resumidor e título usam a mesma política (padrões próprios)', () => {
  const cap = buildSideRequest({
    provider: anth,
    model: 'claude-fable-5-1',
    messages: [
      { role: 'system', content: 'S' },
      { role: 'user', content: 'U' }
    ],
    maxTokens: 400,
    temperature: 0,
    thinkingTokens: null,
    defaultThinkingTokens: SIDE_THINKING.capture
  }).body as any
  assert.equal(cap.max_tokens, 400 + SIDE_THINKING.capture)
  assert.equal(cap.temperature, undefined)
  const settings = {
    ...defaultAutoTitleSettings(),
    providerId: 'pa',
    model: 'claude-opus-5-5',
    maxTokens: 64
  }
  const t = buildAutoTitleRequest({ settings, provider: anth, text: 'oi' }).body as any
  assert.equal(t.max_tokens, 64 + SIDE_THINKING.title)
  assert.deepEqual(t.output_config, { effort: 'low' })
  const t2 = buildAutoTitleRequest({
    settings: { ...settings, thinkingTokens: 300 },
    provider: anth,
    text: 'oi'
  }).body as any
  assert.equal(t2.max_tokens, 364)
  const t3 = buildAutoTitleRequest({
    settings: { ...settings, model: 'claude-haiku-5-5' },
    provider: anth,
    text: 'oi'
  }).body as any
  assert.deepEqual(t3.thinking, { type: 'disabled' })
  assert.equal(t3.max_tokens, 64)
  const t4 = buildAutoTitleRequest({
    settings: { ...settings, providerId: 'po', model: 'anthropic/claude-opus-5.5' },
    provider: orp,
    text: 'oi'
  }).body as any
  assert.deepEqual(t4.reasoning, { effort: 'low' })
  assert.equal(t4.max_tokens, 64 + SIDE_THINKING.title)
})

test('prévia do renderer (sideAnthropicPreviewBody) = body do main', () => {
  const messages: { role: 'system' | 'user'; content: string }[] = [
    { role: 'system', content: 'Sistema' },
    { role: 'user', content: 'Usuário' }
  ]
  for (const model of [
    'claude-haiku-4-5',
    'claude-haiku-5-5',
    'claude-sonnet-5-5',
    'claude-opus-5-5',
    'claude-opus-4-8'
  ]) {
    const input = {
      maxTokens: 300,
      temperature: 0,
      thinkingTokens: 1500,
      defaultThinkingTokens: SIDE_THINKING.judge
    }
    const main = buildSideRequest({ provider: anth, model, messages, ...input }).body
    const plan = planSideCall({ kind: 'anthropic', model, ...input })
    assert.deepEqual(sideAnthropicPreviewBody(model, messages, plan), main, model)
  }
})
