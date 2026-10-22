// Testes unitários da compatibilidade modelo ↔ chat (@shared/modelCompat) e da desabilitação no
// seletor de modelos (lib/modelPicker): requisitos do histórico (imagem/PDF/áudio/tools, ramos,
// fronteira de compactação, mensagens só de exibição) e a checagem por provider (desconhecido nunca
// bloqueia). Rodar: npm run test:unit
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  chatRequirements,
  compatLabel,
  compatReason,
  incompatibility,
  modelCompat
} from '../src/shared/modelCompat.ts'
import { activePath } from '../src/shared/branches.ts'
import {
  buildPickerRows,
  initialHighlight,
  isSelectable,
  nextSelectable,
  type PickerModels,
  type PickerRow
} from '../src/renderer/src/lib/modelPicker.ts'
import type {
  ApiMessage,
  AttachmentMeta,
  ChatConfig,
  ContentPart,
  MessageMeta,
  ModelInfo,
  StoredMessage
} from '../src/shared/types.ts'

let seq = 0
const sm = (
  message: ApiMessage,
  meta: MessageMeta = {},
  parentId?: string | null
): StoredMessage => {
  const id = `m${++seq}`
  return {
    id,
    sessionId: 's',
    seq,
    ...(parentId !== undefined ? { parentId } : {}),
    message,
    meta,
    createdAt: seq
  }
}
const att = (kind: AttachmentMeta['kind'], name: string): AttachmentMeta => ({
  name,
  mime: 'x',
  size: 10,
  kind,
  file: `${'a'.repeat(64)}.bin`
})
const img: ContentPart = {
  type: 'image_url',
  image_url: { url: 'clearchat-attachment://x.png' },
  _attachment: att('image', 'a.png')
}
const pdf: ContentPart = {
  type: 'file',
  file: { filename: 'r.pdf', file_data: 'clearchat-attachment://x.pdf' },
  _attachment: att('pdf', 'r.pdf')
}
const audio: ContentPart = {
  type: 'input_audio',
  input_audio: { data: 'clearchat-attachment://x.mp3', format: 'mp3' },
  _attachment: att('audio', 'g.mp3')
}
const txtFile: ContentPart = {
  type: 'text',
  text: '<file name="n.md">\nx\n</file>',
  _attachment: att('text', 'n.md')
}
const user = (...parts: ContentPart[]): ApiMessage => ({
  role: 'user',
  content: [...parts, { type: 'text', text: 'olha' }]
})
const TOOLS: Pick<ChatConfig, 'nativeTools' | 'enabledTools'> = {
  nativeTools: true,
  enabledTools: ['read_file']
}

test('chatRequirements: chat vazio / só texto / arquivo de texto → nada', () => {
  assert.deepEqual(chatRequirements([], TOOLS), [])
  assert.deepEqual(
    chatRequirements(
      [sm({ role: 'user', content: 'oi' }), sm({ role: 'assistant', content: 'olá' })],
      TOOLS
    ),
    []
  )
  assert.deepEqual(chatRequirements([sm(user(txtFile))], TOOLS), [])
})

test('chatRequirements: imagem, PDF e áudio (ordem fixa, sem repetição)', () => {
  const h = [
    sm(user(audio, img)),
    sm({ role: 'assistant', content: 'ok' }),
    sm(user(pdf, img)),
    sm({ role: 'assistant', content: 'ok' })
  ]
  assert.deepEqual(chatRequirements(h, TOOLS), ['image', 'pdf', 'audio'])
})

test('chatRequirements: mídia de resultado de tool (read_file) conta; tools nativas exigem tools', () => {
  const h = [
    sm({ role: 'user', content: 'leia a.png' }),
    sm({
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 't1',
          type: 'function',
          function: { name: 'read_file', arguments: '{"path":"a.png"}' }
        }
      ]
    }),
    sm({ role: 'tool', tool_call_id: 't1', content: [{ type: 'text', text: 'a.png' }, img] })
  ]
  assert.deepEqual(chatRequirements(h, TOOLS), ['image', 'tools'])
  // modo texto (<tool_call>) ou sem tools habilitadas: a request não leva `tools`
  assert.deepEqual(chatRequirements(h, { nativeTools: false, enabledTools: ['read_file'] }), [
    'image'
  ])
  assert.deepEqual(chatRequirements(h, { nativeTools: true, enabledTools: [] }), ['image'])
})

test('chatRequirements: antes da fronteira de compactação não conta (não é enviado)', () => {
  const h = [
    sm(user(img)),
    sm({ role: 'assistant', content: 'vi a imagem' }),
    sm(
      { role: 'user', content: 'Resumo: o usuário mandou [imagem: a.png]…' },
      { kind: 'compaction' }
    ),
    sm({ role: 'user', content: 'e agora?' })
  ]
  assert.deepEqual(chatRequirements(h, TOOLS), [])
  // anexo depois da fronteira conta
  assert.deepEqual(chatRequirements([...h, sm(user(pdf))], TOOLS), ['pdf'])
})

test('chatRequirements: mensagens só de exibição não contam', () => {
  const h = [sm(user(img), { kind: 'error' })]
  assert.deepEqual(chatRequirements(h, TOOLS), [])
})

test('chatRequirements + activePath: só o ramo ativo conta', () => {
  seq = 100
  const u1 = sm({ role: 'user', content: 'oi' }, {}, null)
  const a1 = sm({ role: 'assistant', content: 'olá' }, {}, u1.id)
  const withImg = sm(user(img), {}, a1.id) // versão 1 da pergunta (com imagem)
  const plain = sm({ role: 'user', content: 'sem imagem' }, {}, a1.id) // versão 2 (a mais nova)
  const all = [u1, a1, withImg, plain]
  assert.deepEqual(chatRequirements(activePath(all), TOOLS), []) // padrão: a mais nova
  assert.deepEqual(chatRequirements(activePath(all, { [a1.id]: withImg.id }), TOOLS), ['image'])
})

const visionOR: Pick<ModelInfo, 'inputModalities' | 'supportsTools'> = {
  inputModalities: ['text', 'image'],
  supportsTools: true
}
const textOR: Pick<ModelInfo, 'inputModalities' | 'supportsTools'> = {
  inputModalities: ['text'],
  supportsTools: false
}

test('modelCompat: OpenRouter — imagem/áudio exigem a modalidade; PDF passa pelo file-parser', () => {
  assert.deepEqual(modelCompat(['image'], visionOR, 'openrouter'), { missing: [], unknown: [] })
  assert.deepEqual(modelCompat(['image', 'pdf', 'audio', 'tools'], textOR, 'openrouter'), {
    missing: ['image', 'audio', 'tools'],
    unknown: []
  })
})

test('modelCompat: metadados ausentes → desconhecido (nunca bloqueia)', () => {
  assert.deepEqual(modelCompat(['image', 'pdf', 'audio', 'tools'], undefined, 'openai'), {
    missing: [],
    unknown: ['image', 'pdf', 'audio', 'tools']
  })
  assert.deepEqual(modelCompat(['image', 'tools'], {}, 'openrouter'), {
    missing: [],
    unknown: ['image', 'tools']
  })
  assert.equal(incompatibility(['image', 'tools'], undefined, 'openai'), null)
  assert.equal(incompatibility([], textOR, 'openrouter'), null)
})

test('modelCompat: Anthropic — áudio nunca; PDF exige file (capabilities)', () => {
  const claude = { inputModalities: ['text', 'image', 'file'], supportsTools: true }
  assert.deepEqual(modelCompat(['image', 'pdf', 'tools'], claude, 'anthropic').missing, [])
  assert.deepEqual(modelCompat(['audio'], claude, 'anthropic').missing, ['audio'])
  assert.deepEqual(
    modelCompat(['pdf'], { inputModalities: ['text', 'image'] }, 'anthropic').missing,
    ['pdf']
  )
})

test('compatReason / compatLabel: textos pt-BR', () => {
  assert.equal(
    compatReason(['image'], 'openrouter'),
    'Este chat tem imagens — o modelo não aceita imagem'
  )
  assert.equal(
    compatReason(['image', 'pdf', 'tools'], 'openai', 'o modelo atual'),
    'Este chat tem imagens e PDF e usa tools — o modelo atual não aceita imagem, PDF nem tools'
  )
  assert.equal(
    compatReason(['audio'], 'anthropic'),
    'Este chat tem áudio — o modelo não aceita áudio (o áudio seria trocado por um aviso em texto)'
  )
  assert.equal(compatReason([], 'openai'), null)
  assert.equal(compatLabel(['image', 'audio']), 'não aceita imagem nem áudio')
  assert.equal(
    incompatibility(['image'], textOR, 'openrouter'),
    'Este chat tem imagens — o modelo não aceita imagem'
  )
})

test('seletor: modelos incompatíveis desabilitados (pulados no teclado; ID livre nunca)', () => {
  const OR = { id: 'or', name: 'OpenRouter' }
  const models: Record<string, PickerModels> = {
    or: {
      status: 'ok',
      list: [
        { id: 'text-only', inputModalities: ['text'] },
        { id: 'vision', inputModalities: ['text', 'image'] },
        { id: 'unknown' }
      ]
    }
  }
  const disabledReason = (_pid: string, m: ModelInfo): { reason: string; label: string } | null => {
    const r = incompatibility(['image'], m, 'openrouter')
    return r ? { reason: r, label: 'x' } : null
  }
  const rows = buildPickerRows({
    providers: [OR],
    models,
    query: '',
    collapsed: new Set(),
    selected: { providerId: 'or', model: 'text-only' },
    disabledReason
  })
  const byId = (id: string): PickerRow => rows.find((r) => r.kind === 'model' && r.model.id === id)!
  assert.ok(!isSelectable(byId('text-only')))
  assert.ok(isSelectable(byId('vision')))
  assert.ok(isSelectable(byId('unknown')))
  // a seleção atual (incompatível) não é destacada: vai para a primeira selecionável
  const hi = initialHighlight(rows)
  assert.equal(rows[hi], byId('vision'))
  assert.equal(nextSelectable(rows, 0, 1), rows.indexOf(byId('vision')))
  // ID livre: sem metadados → selecionável
  const free = buildPickerRows({
    providers: [OR],
    models,
    query: 'meu/modelo',
    collapsed: new Set(),
    selected: null,
    disabledReason
  }).find((r) => r.kind === 'free')
  assert.ok(isSelectable(free))
  // sem requisitos: nada desabilitado
  const plain = buildPickerRows({
    providers: [OR],
    models,
    query: '',
    collapsed: new Set(),
    selected: null
  })
  assert.ok(plain.filter((r) => r.kind === 'model').every(isSelectable))
})
