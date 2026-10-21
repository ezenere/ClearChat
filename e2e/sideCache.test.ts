/* eslint-disable @typescript-eslint/no-explicit-any */
// Cache do prompt nas chamadas laterais (@shared/sideCache): marcador {{cache_break}}, breakpoints
// por provedor (Anthropic nativa, OpenRouter Anthropic/Gemini; demais = strings), liga/desliga
// (juiz e resumidor), normalização e paridade da prévia do renderer.
// Rodar: npm run test:unit
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CACHE_BREAK_SENTINEL,
  sideCacheable,
  sideMessage,
  sideWireMessages
} from '../src/shared/sideCache.ts'
import {
  planSideCall,
  sideAnthropicPreviewBody,
  SIDE_THINKING
} from '../src/shared/sideReasoning.ts'
import {
  buildJudgeMessages,
  normalizeSmartApprove,
  SMART_APPROVE_PLACEHOLDERS
} from '../src/shared/smartApprove.ts'
import {
  buildCaptureMessages,
  buildDeriveMessages,
  CAPTURE_PLACEHOLDERS,
  validateCapturePrompts
} from '../src/shared/contextCapture.ts'
import { normalizeCapture, normalizeSmartDefaults } from '../src/shared/smartDefaults.ts'
import { setModelInfoSource } from '../src/main/agent/request.ts'
import { buildJudgeRequest, buildSideRequest } from '../src/main/agent/smartApprove.ts'
import type { Provider } from '../src/shared/types.ts'

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

setModelInfoSource(() => undefined)
after(() => setModelInfoSource(() => undefined))

const ctx = {
  tool: 'shell',
  args: { command: 'npm test' },
  cwd: '/work',
  confine: true,
  sandbox: false,
  history: []
} as any
const judge = (provider: Provider, model: string, extra: Record<string, unknown> = {}): any =>
  buildJudgeRequest({
    sa: normalizeSmartApprove({ providerId: provider.id, model, ...extra } as any),
    provider,
    chatConfig: {},
    ctx
  })!
const marks = (body: unknown): number =>
  (JSON.stringify(body).match(/"cache_control"/g) ?? []).length

test('marcador: some do texto e vira cacheAt; nas bordas não divide', () => {
  const m = sideMessage('user', `AAA${CACHE_BREAK_SENTINEL}BBB${CACHE_BREAK_SENTINEL}`)
  assert.deepEqual(m, { role: 'user', content: 'AAABBB', cacheAt: 3 })
  assert.deepEqual(sideMessage('user', `${CACHE_BREAK_SENTINEL}X`), { role: 'user', content: 'X' })
  assert.deepEqual(sideMessage('user', `X${CACHE_BREAK_SENTINEL}  `), {
    role: 'user',
    content: 'X  '
  })
  assert.deepEqual(sideMessage('user', 'sem'), { role: 'user', content: 'sem' })
  // listado como placeholder opcional (juiz e resumidor)
  assert.ok(SMART_APPROVE_PLACEHOLDERS.some((p) => p.key === 'cache_break'))
  assert.ok(CAPTURE_PLACEHOLDERS.some((p) => p.key === 'cache_break' && !p.required))
  assert.deepEqual(
    validateCapturePrompts({ template: '{{current}}{{cache_break}}{{user}}' }),
    [],
    'validação aceita o marcador'
  )
})

test('juiz: template padrão divide antes dos arquivos tocados; texto igual ao de sempre', () => {
  const sa = normalizeSmartApprove({ providerId: 'pa', model: 'm' } as any)
  const [sys, user] = buildJudgeMessages(sa, ctx)
  assert.equal(sys.cacheAt, undefined)
  assert.ok(user.cacheAt! > 0)
  const stable = user.content.slice(0, user.cacheAt)
  const rest = user.content.slice(user.cacheAt)
  assert.ok(stable.includes('Shell sandboxed'), 'raiz/flags na parte estável')
  assert.ok(!stable.includes('Pending tool call'))
  assert.ok(rest.includes('Pending tool call') && rest.includes('npm test'))
  assert.ok(!user.content.includes('cache_break') && !user.content.includes('\u0000'))
  // personalizado sem marcador: só o system; marcador no system: renderiza vazio
  const custom = buildJudgeMessages(
    normalizeSmartApprove({ template: 'T {{tool}}', prompt: 'P{{cache_break}}Q' } as any),
    ctx
  )
  assert.equal(custom[0].content, 'PQ')
  assert.equal(custom[1].cacheAt, undefined)
  const withMark = buildJudgeMessages(
    normalizeSmartApprove({ template: 'fixo {{cwd}}\n{{cache_break}}chamada {{tool}}' } as any),
    ctx
  )[1]
  assert.equal(withMark.content.slice(0, withMark.cacheAt), 'fixo /work\n')
})

test('juiz Anthropic nativa: 2 breakpoints (system + parte estável); desligado = body de sempre', () => {
  const on = judge(anth, 'claude-haiku-4-5').body
  assert.equal(marks(on), 2)
  assert.deepEqual(on.system[0].cache_control, { type: 'ephemeral' })
  const parts = on.messages[0].content
  assert.equal(parts.length, 2)
  assert.deepEqual(parts[0].cache_control, { type: 'ephemeral' })
  assert.equal(parts[1].cache_control, undefined)
  assert.ok(parts[1].text.includes('Pending tool call'))
  assert.ok(
    judge(anth, 'claude-haiku-4-5').notes.some((n: string) => n.startsWith('Cache do prompt'))
  )
  const off = judge(anth, 'claude-haiku-4-5', { cache: false }).body
  assert.equal(marks(off), 0)
  assert.equal(off.messages[0].content.length, 1)
  assert.equal(off.messages[0].content[0].text, parts[0].text + parts[1].text)
  assert.equal(off.system[0].text, on.system[0].text)
  // template sem marcador: só o system
  const nomark = judge(anth, 'claude-opus-5-5', { template: 'só {{tool}}' }).body
  assert.equal(marks(nomark), 1)
  assert.deepEqual(nomark.system[0].cache_control, { type: 'ephemeral' })
})

test('juiz OpenRouter: Anthropic/Gemini → parts com cache_control; OpenAI e genérico → strings', () => {
  for (const m of ['anthropic/claude-haiku-5.5', 'google/gemini-3.5-flash']) {
    const b = judge(orp, m).body
    assert.equal(marks(b), 2, m)
    assert.deepEqual(b.messages[0].content[0].cache_control, { type: 'ephemeral' }, m)
    assert.equal(b.messages[1].content.length, 2, m)
    assert.deepEqual(b.messages[1].content[0].cache_control, { type: 'ephemeral' }, m)
    const off = judge(orp, m, { cache: false }).body
    assert.equal(typeof off.messages[0].content, 'string', m)
    assert.equal(typeof off.messages[1].content, 'string', m)
    assert.equal(off.messages[1].content, b.messages[1].content.map((p: any) => p.text).join(''))
  }
  const oai = judge(orp, 'openai/gpt-5.4').body
  assert.equal(marks(oai), 0)
  assert.equal(typeof oai.messages[1].content, 'string')
  const g = judge(gen, 'claude-haiku-4-5').body
  assert.equal(marks(g), 0, 'openai genérico: sem cache_control mesmo com id Claude')
  assert.equal(typeof g.messages[0].content, 'string')
  assert.equal(sideCacheable('openai', 'x'), false)
  assert.equal(sideCacheable('openrouter', 'deepseek/v4'), false)
  assert.equal(sideCacheable('anthropic', 'qualquer'), true)
})

test('resumidor: system + descrição atual cacheados; mensagens novas fora; derivação só system', () => {
  const msgs = buildCaptureMessages('- usa o servidor 172.16.1.7', {
    agent: 'fala do agente',
    user: '[1] reinicie o nginx'
  })
  const u = msgs[1]
  const stable = u.content.slice(0, u.cacheAt)
  assert.ok(stable.includes('172.16.1.7') && !stable.includes('reinicie'))
  assert.ok(u.content.slice(u.cacheAt).includes('fala do agente'))
  const req = (cache: boolean, messages = msgs): any =>
    buildSideRequest({
      provider: anth,
      model: 'claude-haiku-5-5',
      messages,
      cache,
      maxTokens: 400,
      temperature: 0,
      defaultThinkingTokens: SIDE_THINKING.capture
    }).body
  assert.equal(marks(req(true)), 2)
  assert.equal(req(true).messages[0].content[1].text.includes('reinicie'), true)
  assert.equal(marks(req(false)), 0)
  // personalizado sem marcador → só system
  const custom = buildCaptureMessages('x', { agent: '', user: 'y' }, false, {
    template: '{{current}} {{user}}'
  })
  assert.equal(custom[1].cacheAt, undefined)
  assert.equal(marks(req(true, custom)), 1)
  const derive = buildDeriveMessages('pai', 'tarefa')
  assert.equal(derive[1].cacheAt, undefined)
  assert.equal(marks(req(true, derive)), 1)
})

test('normalização do liga/desliga (ausente = ligado; só false é gravado)', () => {
  assert.equal('cache' in normalizeSmartApprove({}), false)
  assert.equal('cache' in normalizeSmartApprove({ cache: true } as any), false)
  assert.equal(normalizeSmartApprove({ cache: false } as any).cache, false)
  assert.equal('cache' in normalizeSmartApprove({ cache: 'no' } as any), false)
  assert.equal('cache' in normalizeCapture({}), false)
  assert.equal(normalizeCapture({ cache: false }).cache, false)
  assert.equal(normalizeSmartDefaults({ capture: { cache: false } }).capture.cache, false)
  assert.equal(
    normalizeSmartApprove({ capture: { cache: false } } as any).capture?.cache,
    false,
    'coleta do chat'
  )
})

test('prévia do renderer = body do main (cache ligado e desligado)', () => {
  const sa = normalizeSmartApprove({ providerId: 'pa', model: 'm' } as any)
  const messages = buildJudgeMessages(sa, ctx)
  for (const model of ['claude-haiku-4-5', 'claude-sonnet-5-5', 'claude-opus-5-5'])
    for (const cache of [true, false]) {
      const input = { maxTokens: 300, temperature: 0, defaultThinkingTokens: SIDE_THINKING.judge }
      const main = buildSideRequest({ provider: anth, model, messages, cache, ...input }).body
      const plan = planSideCall({ kind: 'anthropic', model, ...input })
      const wire = sideWireMessages(messages, { cache, kind: 'anthropic', model })
      assert.deepEqual(sideAnthropicPreviewBody(model, wire, plan), main, `${model} ${cache}`)
    }
})
