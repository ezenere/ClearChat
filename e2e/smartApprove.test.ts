/* eslint-disable @typescript-eslint/no-explicit-any */
// Smart-Approve (sem Electron): parse da resposta do juiz, template, ordem de decisão, chamada ao
// juiz contra um servidor HTTP local (aprovar/rejeitar/perguntar/ambíguo/erro/timeout — nunca
// libera por falha), liberação de uma vez só e inclusão nos campos de persona.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  approvalRoute,
  argsKey,
  buildJudgeBody,
  buildJudgeMessages,
  lastUserMessage,
  normalizeSmartApprove,
  overrideMessageText,
  parseJudgeOutput,
  recentContext,
  renderSmartTemplate,
  smartApproveActive,
  smartRejectText,
  validateLabels
} from '../src/shared/smartApprove.ts'
import {
  DEFAULT_SMART_APPROVE_PROMPT,
  DEFAULT_SMART_APPROVE_TEMPLATE
} from '../src/shared/defaults.ts'
import {
  PRESET_FIELDS,
  applyPreset,
  sanitizePresetConfig,
  snapshotPreset
} from '../src/shared/presets.ts'
import { DEFAULT_CHAT_CONFIG } from '../src/shared/defaults.ts'
import {
  OVERRIDE_TTL_MS,
  addOverride,
  clearOverrides,
  runJudge,
  takeOverride
} from '../src/main/agent/smartApprove.ts'
import type {
  Provider,
  SmartApproveConfig,
  SmartApproveRecord,
  StoredMessage
} from '../src/shared/types.ts'

// ---------------- parse ----------------

test('parse: variantes aceitas (markdown, caixa, prefixo, aspas, <think>)', () => {
  const cases: [string, string, string][] = [
    ['APPROVED\nLista arquivos na raiz.', 'approve', 'Lista arquivos na raiz.'],
    ['**APPROVED** — seguro', 'approve', 'seguro'],
    ['approved: tudo certo', 'approve', 'tudo certo'],
    ['Decision: REJECTED\nApaga a home.', 'reject', 'Apaga a home.'],
    ['Veredito — REJECTED: fora da raiz', 'reject', 'fora da raiz'],
    ['`ASK-USER`\nNão sei.', 'ask', 'Não sei.'],
    ['\n\n   APPROVED   \n\n  ok  ', 'approve', 'ok'],
    ['## REJECTED\n- exfiltra ~/.ssh', 'reject', 'exfiltra ~/.ssh'],
    ['"APPROVED" ok', 'approve', 'ok'],
    ['[ASK-USER] talvez', 'ask', 'talvez'],
    ['<think>REJECTED? hmm, APPROVED</think>\nAPPROVED\nok', 'approve', 'ok'],
    ['APPROVED\nthe user approved this earlier', 'approve', 'the user approved this earlier'],
    ['APPROVED', 'approve', '']
  ]
  for (const [raw, decision, reason] of cases) {
    const r = parseJudgeOutput(raw)
    assert.equal(r.decision, decision, raw)
    assert.equal(r.reason, reason, raw)
  }
})

test('parse: ambíguo / sem rótulo / vazio → sem decisão (perguntar)', () => {
  const cases: [string, string][] = [
    ['', 'empty'],
    ['   \n  ', 'empty'],
    ['This should not be APPROVED', 'no-label'],
    ['I think it is fine.\nAPPROVED', 'no-label'],
    ['ASK', 'no-label'],
    ['ASK-USERS please', 'no-label'],
    ['APPROVED_NOW', 'no-label'],
    ['APPROVEDX', 'no-label'],
    ['APPROVED or REJECTED', 'multiple'],
    ['APPROVED (not rejected)', 'multiple'],
    ['APPROVED\nActually REJECTED, it deletes files', 'multiple'],
    ['REJECTED\nASK-USER would also work', 'multiple']
  ]
  for (const [raw, problem] of cases) {
    const r = parseJudgeOutput(raw)
    assert.equal(r.decision, null, raw)
    assert.equal(r.problem, problem, raw)
  }
})

test('parse: rótulos personalizados (inclusive com caracteres de regex)', () => {
  const labels = { approve: 'SIM', reject: 'NÃO', ask: 'TALVEZ?' }
  assert.equal(parseJudgeOutput('sim\nok', labels).decision, 'approve')
  assert.equal(parseJudgeOutput('Não — perigoso', labels).decision, 'reject')
  assert.equal(parseJudgeOutput('TALVEZ? depende', labels).decision, 'ask')
  assert.equal(parseJudgeOutput('APPROVED', labels).decision, null) // rótulo padrão não vale
  // inválidos (duplicados) → padrão
  assert.equal(
    parseJudgeOutput('APPROVED', { approve: 'X', reject: 'x', ask: 'Y' }).decision,
    'approve'
  )
})

test('validateLabels / normalizeSmartApprove', () => {
  assert.equal(validateLabels({ approve: 'A', reject: 'B', ask: 'C' }), null)
  assert.match(validateLabels({ approve: '', reject: 'B', ask: 'C' })!, /obrigatórios/)
  assert.match(validateLabels({ approve: 'ok', reject: 'OK', ask: 'C' })!, /diferentes/)
  assert.match(validateLabels({ approve: 'a\nb', reject: 'B', ask: 'C' })!, /quebra/)
  const d = normalizeSmartApprove(undefined)
  assert.deepEqual(d, {
    enabled: false,
    providerId: null,
    model: null,
    prompt: null,
    template: null,
    labels: { approve: 'APPROVED', reject: 'REJECTED', ask: 'ASK-USER' },
    contextMessages: 6,
    timeoutS: 30
  })
  const n = normalizeSmartApprove({
    enabled: true,
    providerId: 'p',
    model: ' m ',
    labels: { approve: ' SIM ', reject: 'NAO', ask: 'TALVEZ' },
    contextMessages: 999,
    timeoutS: 1,
    tools: ['shell', 'shell', 'write_file']
  })
  assert.equal(n.model, 'm')
  assert.deepEqual(n.labels, { approve: 'SIM', reject: 'NAO', ask: 'TALVEZ' })
  assert.equal(n.contextMessages, 50)
  assert.equal(n.timeoutS, 3)
  assert.deepEqual(n.tools, ['shell', 'write_file'])
  assert.equal(smartApproveActive(n), true)
  assert.equal(smartApproveActive({ ...n, model: null }), false)
  assert.equal(smartApproveActive({ ...n, enabled: false }), false)
})

// ---------------- template ----------------

let seq = 0
const sm = (message: any, meta: any = {}): StoredMessage => ({
  id: String(++seq),
  sessionId: 's',
  seq,
  message,
  meta,
  createdAt: 0
})

test('template: placeholders, desconhecidos intactos, sem reexpansão', () => {
  const out = renderSmartTemplate('t={{tool}} a={{ args }} x={{nada}} {{TOOL}}', {
    tool: '{{args}}',
    args: 'A'
  })
  assert.equal(out, 't={{args}} a=A x={{nada}} {{args}}')
})

test('mensagens do juiz: system + user renderizados com contexto compacto', () => {
  const sa = normalizeSmartApprove({
    enabled: true,
    providerId: 'p',
    model: 'j',
    contextMessages: 3
  })
  const long = 'x'.repeat(2000)
  const history = [
    sm({ role: 'user', content: 'mensagem antiga' }),
    sm({ role: 'user', content: 'Liste os arquivos, por favor.' }),
    sm({
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } }
      ]
    }),
    sm({ role: 'tool', tool_call_id: 'c1', content: long }, { toolStatus: 'ok' }),
    sm({ role: 'assistant', content: 'erro', tool_calls: undefined }, { kind: 'error' }),
    sm({
      role: 'assistant',
      content: 'Vou listar.',
      tool_calls: [
        {
          id: 'c2',
          type: 'function',
          function: { name: 'shell', arguments: '{"command":"ls -la"}' }
        }
      ]
    })
  ]
  const msgs = buildJudgeMessages(sa, {
    tool: 'shell',
    args: { command: 'ls -la' },
    cwd: '/work',
    confine: true,
    sandbox: false,
    history
  })
  assert.equal(msgs.length, 2)
  assert.equal(msgs[0].role, 'system')
  assert.ok(msgs[0].content.includes('APPROVED | REJECTED | ASK-USER'))
  assert.ok(!msgs[0].content.includes('{{'), 'system sem placeholders')
  const u = msgs[1].content
  assert.ok(!u.includes('{{'), 'user sem placeholders')
  assert.ok(u.includes('tool: shell'))
  assert.ok(u.includes('{\n  "command": "ls -la"\n}'), 'args em JSON formatado')
  assert.ok(u.includes('Project root (cwd): /work'))
  assert.ok(u.includes('File tools confined to the root: yes'))
  assert.ok(u.includes('Shell sandboxed (only the root is writable): no'))
  assert.ok(u.includes('"""\nListe os arquivos, por favor.\n"""'))
  // últimas 3 (sem a de erro): assistant(read_file), tool (cortado), assistant(shell)
  assert.ok(!u.includes('mensagem antiga'))
  assert.ok(u.includes('→ read_file({"path":"a"})'))
  assert.ok(u.includes('[tool read_file] ' + 'x'.repeat(300) + '… [+1700 chars]'))
  assert.ok(u.includes('[assistant] Vou listar.\n  → shell({"command":"ls -la"})'))
  assert.ok(!u.includes('erro'))
})

test('contexto: N=0, fronteira de compactação, última mensagem do usuário', () => {
  const h = [
    sm({ role: 'user', content: 'antes' }),
    sm({ role: 'user', content: '<conversation_summary>…' }, { kind: 'compaction' }),
    sm({ role: 'user', content: 'depois' }),
    sm(
      { role: 'user', content: '[Subagente X concluiu]' },
      { kind: 'subagent-callback', synthetic: true }
    )
  ]
  assert.equal(recentContext(h, 0), '(omitted)')
  assert.ok(!recentContext(h, 10).includes('antes'))
  assert.equal(lastUserMessage(h), 'depois')
  assert.equal(lastUserMessage([]), '(none)')
  // subsessão: a tarefa (synthetic) conta como mensagem do usuário
  assert.equal(
    lastUserMessage([sm({ role: 'user', content: 'Tarefa X' }, { synthetic: true })]),
    'Tarefa X'
  )
})

test('body do juiz: temperatura 0, poucos tokens, sem tools; usage só no OpenRouter', () => {
  const b = buildJudgeBody('m', [{ role: 'user', content: 'x' }], false)
  assert.equal(b.temperature, 0)
  assert.equal(b.max_tokens, 300)
  assert.equal(b.stream, true)
  assert.equal('tools' in b, false)
  assert.equal('usage' in b, false)
  assert.deepEqual(buildJudgeBody('m', [], true).usage, { include: true })
})

// ---------------- ordem de decisão ----------------

test('ordem: autoApprove → juiz → usuário; tools extras só com o juiz ativo', () => {
  const sa = { enabled: true, providerId: 'p', model: 'j' }
  const r = (cfg: any, t: any): string => approvalRoute(cfg, t)
  assert.equal(r({ autoApprove: [] }, 'shell'), 'user')
  assert.equal(r({ autoApprove: [] }, 'read_file'), 'run')
  assert.equal(r({ autoApprove: ['shell'] }, 'shell'), 'run')
  assert.equal(r({ autoApprove: [], smartApprove: sa }, 'shell'), 'judge')
  assert.equal(r({ autoApprove: ['shell'], smartApprove: sa }, 'shell'), 'run')
  assert.equal(r({ autoApprove: [], smartApprove: { ...sa, enabled: false } }, 'shell'), 'user')
  assert.equal(r({ autoApprove: [], smartApprove: { ...sa, model: null } }, 'shell'), 'user')
  // fora da lista do juiz → usuário (CONFIRM) ou roda (não-CONFIRM)
  const only = { ...sa, tools: ['web_search', 'write_file'] }
  assert.equal(r({ autoApprove: [], smartApprove: only }, 'shell'), 'user')
  assert.equal(r({ autoApprove: [], smartApprove: only }, 'web_search'), 'judge')
  assert.equal(r({ autoApprove: [], smartApprove: only }, 'write_file'), 'judge')
  assert.equal(
    r({ autoApprove: [], smartApprove: { ...only, enabled: false } }, 'write_file'),
    'run'
  )
  assert.equal(r({ autoApprove: ['write_file'], smartApprove: only }, 'write_file'), 'run')
  assert.equal(r({ autoApprove: [], smartApprove: only }, 'edit_file'), 'run')
})

test('textos: rejeição e "Executar mesmo assim"', () => {
  assert.equal(smartRejectText('m/j', ' perigoso '), 'Rejeitado pelo Smart-Approve (m/j): perigoso')
  assert.equal(smartRejectText('m', ''), 'Rejeitado pelo Smart-Approve (m): sem motivo informado.')
  assert.equal(
    overrideMessageText('shell', { command: 'rm -rf build' }),
    'Pode executar shell `rm -rf build`; eu aprovo.'
  )
  assert.match(overrideMessageText('write_file', { path: 'a.txt', content: 'x' }), /`a\.txt`/)
})

test('liberação de uma vez só: mesma tool + mesmos args (ordem das chaves não importa), expira', () => {
  clearOverrides()
  addOverride('s1', 'shell', { command: 'ls', timeout_ms: 5 })
  assert.equal(takeOverride('s2', 'shell', { command: 'ls', timeout_ms: 5 }), false, 'outra sessão')
  assert.equal(
    takeOverride('s1', 'shell', { command: 'ls -a', timeout_ms: 5 }),
    false,
    'outros args'
  )
  assert.equal(
    takeOverride('s1', 'web_search', { command: 'ls', timeout_ms: 5 }),
    false,
    'outra tool'
  )
  assert.equal(takeOverride('s1', 'shell', { timeout_ms: 5, command: 'ls' }), true)
  assert.equal(takeOverride('s1', 'shell', { timeout_ms: 5, command: 'ls' }), false, 'só uma vez')
  addOverride('s1', 'shell', { command: 'x' }, 1000)
  assert.equal(
    takeOverride('s1', 'shell', { command: 'x' }, 1000 + OVERRIDE_TTL_MS + 1),
    false,
    'expirou'
  )
  assert.equal(argsKey({ b: 1, a: { d: 2, c: 3 } }), argsKey({ a: { c: 3, d: 2 }, b: 1 }))
})

// ---------------- personas ----------------

test('personas: smartApprove está em PRESET_FIELDS e sobrevive a snapshot/aplicar', () => {
  assert.ok((PRESET_FIELDS as readonly string[]).includes('smartApprove'))
  const sa: SmartApproveConfig = {
    ...normalizeSmartApprove({ enabled: true, providerId: 'p', model: 'j' }),
    tools: ['shell', 'write_file']
  }
  const base = DEFAULT_CHAT_CONFIG('/w', { providerId: 'p', model: 'm' })
  const snap = snapshotPreset({ ...base, smartApprove: sa })
  assert.deepEqual(snap.smartApprove, sa)
  assert.deepEqual(sanitizePresetConfig({ smartApprove: sa, junk: 1 }), { smartApprove: sa })
  const applied = applyPreset(base, snap)
  assert.deepEqual(applied.smartApprove, sa)
  assert.notEqual(applied.smartApprove, sa, 'cópia')
})

// ---------------- chamada ao juiz (servidor local) ----------------

type Script = { status?: number; body?: string; delayMs?: number; json?: boolean }
let server: Server
let base = ''
const hits: any[] = []
let script: Script = {}

async function startServer(): Promise<void> {
  server = createServer((req, res) => {
    let data = ''
    req.on('data', (c) => (data += c))
    req.on('end', () => {
      hits.push({ headers: req.headers, body: JSON.parse(data || '{}') })
      const s = script
      const send = (): void => {
        if (s.status && s.status !== 200) {
          res.writeHead(s.status, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: { message: s.body ?? 'falhou' } }))
          return
        }
        if (s.json) {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(
            JSON.stringify({
              choices: [{ message: { content: s.body ?? '' }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 50, completion_tokens: 5, cost: 0.00002 }
            })
          )
          return
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        const text = s.body ?? ''
        const mid = Math.floor(text.length / 2)
        for (const part of [text.slice(0, mid), text.slice(mid)])
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: part } }] })}\n\n`)
        res.write(
          `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 120, completion_tokens: 9, cost: 0.00001 } })}\n\n`
        )
        res.end('data: [DONE]\n\n')
      }
      if (s.delayMs) setTimeout(send, s.delayMs)
      else send()
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
}

const provider = (): Provider => ({
  id: 'pj',
  name: 'Juiz',
  baseUrl: base,
  apiKey: 'sk-judge-0123456789abcdef',
  headers: {},
  createdAt: 0
})

const judge = (
  over: Partial<SmartApproveConfig> = {},
  signal = new AbortController().signal,
  p: Provider | null = provider()
): Promise<SmartApproveRecord> =>
  runJudge({
    sa: {
      ...normalizeSmartApprove({ enabled: true, providerId: 'pj', model: 'judge/1' }),
      ...over
    },
    provider: p,
    chatConfig: { appSignature: 'none' },
    ctx: {
      tool: 'shell',
      args: { command: 'ls' },
      cwd: '/w',
      confine: true,
      sandbox: false,
      history: []
    },
    signal
  })

test('juiz: aprovar / rejeitar / perguntar; request exata e usage', async () => {
  await startServer()
  try {
    script = { body: 'APPROVED\nSó lista arquivos.' }
    let r = await judge()
    assert.equal(r.decision, 'approve')
    assert.equal(r.reason, 'Só lista arquivos.')
    assert.equal(r.model, 'judge/1')
    assert.equal(r.providerId, 'pj')
    assert.equal(r.usage?.cost, 0.00001)
    assert.equal(r.fallback, undefined)
    const hit = hits.at(-1)
    assert.equal(hit.body.model, 'judge/1')
    assert.equal(hit.body.temperature, 0)
    assert.equal(hit.body.max_tokens, 300)
    assert.equal(hit.body.tools, undefined)
    assert.equal(
      hit.body.messages[0].content,
      renderSmartTemplate(DEFAULT_SMART_APPROVE_PROMPT, {
        labels: 'APPROVED | REJECTED | ASK-USER',
        approve: 'APPROVED',
        reject: 'REJECTED',
        ask: 'ASK-USER'
      })
    )
    assert.ok(
      hit.body.messages[1].content.startsWith(DEFAULT_SMART_APPROVE_TEMPLATE.split('{{')[0])
    )
    assert.equal(hit.headers.authorization, 'Bearer sk-judge-0123456789abcdef')
    // o registro guarda a request com a key mascarada
    assert.ok(!JSON.stringify(r.request).includes('0123456789abcdef'))
    assert.deepEqual((r.request!.body as any).messages, hit.body.messages)

    script = { body: '**REJECTED** — apaga a home' }
    r = await judge()
    assert.equal(r.decision, 'reject')
    assert.equal(r.reason, 'apaga a home')

    script = { body: 'ASK-USER\nAmbíguo.', json: true }
    r = await judge()
    assert.equal(r.decision, 'ask')
    assert.equal(r.fallback, undefined)
    assert.equal(r.reason, 'Ambíguo.')
    assert.equal(r.usage?.cost, 0.00002)
  } finally {
    server.close()
  }
})

test('juiz: falhas nunca liberam (ambíguo, vazio, HTTP, rede, timeout, abort, sem provedor)', async () => {
  await startServer()
  try {
    script = { body: 'Sure! APPROVED or REJECTED, your call' }
    let r = await judge()
    assert.equal(r.decision, 'ask')
    assert.equal(r.fallback, 'ambiguous')
    assert.ok(r.response?.includes('your call'))

    script = { body: '' }
    r = await judge()
    assert.equal(r.decision, 'ask')
    assert.equal(r.fallback, 'ambiguous')
    assert.match(r.error!, /vazio/)

    script = { status: 402, body: 'requires at least $0.50' }
    r = await judge()
    assert.equal(r.decision, 'ask')
    assert.equal(r.fallback, 'error')
    assert.match(r.error!, /402.*requires at least/)

    script = { body: 'APPROVED\nok', delayMs: 1500 }
    const t0 = Date.now()
    r = await judge({ timeoutS: 0.3 })
    assert.equal(r.decision, 'ask')
    assert.equal(r.fallback, 'timeout')
    assert.ok(Date.now() - t0 < 1400, 'respeita o timeout')

    const ac = new AbortController()
    script = { body: 'APPROVED\nok', delayMs: 1500 }
    setTimeout(() => ac.abort(), 100)
    r = await judge({}, ac.signal)
    assert.equal(r.decision, 'ask')
    assert.equal(r.fallback, 'error')

    r = await judge({}, undefined, null)
    assert.equal(r.decision, 'ask')
    assert.match(r.error!, /provedor/)
    r = await judge({ model: null })
    assert.equal(r.decision, 'ask')
  } finally {
    server.closeAllConnections() // keep-alive do fetch reaproveitaria a conexão
    server.close()
  }
  // servidor fechado → erro de rede
  const r = await judge()
  assert.equal(r.decision, 'ask')
  assert.equal(r.fallback, 'error')
  assert.match(r.error!, /Falha de rede/)
})
