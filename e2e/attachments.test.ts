/* eslint-disable @typescript-eslint/no-explicit-any */
// Testes unitários dos anexos (sem Electron): classificação, store, codificação por tipo, expansão
// determinística das referências, campos privados, cache_control com parts mistos, preview e GC.
// Rodar: npm run test:unit
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import {
  attachmentPart,
  buildUserContent,
  capText,
  expandAttachments,
  gcAttachments,
  readAttachment,
  referencedFilesInDb,
  saveAttachment,
  setAttachmentsDir,
  truncateBodyForPreview,
  validateAttachments
} from '../src/main/attachments.ts'
import { buildRequest } from '../src/main/agent/request.ts'
import { buildCompactionRequest } from '../src/main/agent/compaction.ts'
import { mapModel } from '../src/main/providers.ts'
import {
  classifyAttachment,
  contentText,
  modalitySupport,
  modalityWarning,
  parseAttachmentUrl,
  textFileBody
} from '../src/shared/attachments.ts'
import { withText } from '../src/renderer/src/lib/format.ts'
import { ATTACHMENT_LIMITS } from '../src/shared/limits.ts'
import { DEFAULT_CHAT_CONFIG } from '../src/shared/defaults.ts'
import type { ApiMessage, Chat, Provider, StoredMessage } from '../src/shared/types.ts'

const TMP = mkdtempSync(join(process.env.CLEARCHAT_TEST_TMP || tmpdir(), 'clearchat-att-'))
const STORE = join(TMP, 'attachments')
setAttachmentsDir(STORE)
after(() => rmSync(TMP, { recursive: true, force: true }))

const env = { os: 'Linux 6.0 (x64)', shell: 'bash' }
const provider: Provider = {
  id: 'p1',
  name: 'OR',
  baseUrl: 'https://openrouter.ai/api/v1',
  apiKey: 'sk-or-v1-0123456789abcdefa3b9',
  headers: {},
  createdAt: 0
}
const chat = (over: Partial<Chat['config']> = {}): Chat => ({
  id: 'c1',
  title: '',
  mainSessionId: 's1',
  createdAt: 0,
  updatedAt: 0,
  config: {
    ...DEFAULT_CHAT_CONFIG('/work', { providerId: 'p1', model: 'm', systemPrompt: 'SYS' }),
    enabledTools: [],
    ...over
  }
})
let seq = 0
const sm = (message: ApiMessage, meta = {}): StoredMessage => ({
  id: String(++seq),
  sessionId: 's1',
  seq,
  message,
  meta,
  createdAt: 0
})

// bytes de teste (o conteúdo não é validado como imagem; o tipo vem de nome/mime)
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6])
const PDF = new TextEncoder().encode('%PDF-1.4\n% teste\n%%EOF\n')
const WAV = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45])

test('classificação por nome/mime', () => {
  assert.equal(classifyAttachment('a.PNG').kind, 'image')
  assert.equal(classifyAttachment('foto', 'image/jpeg').kind, 'image')
  assert.equal(classifyAttachment('foto.jpg').mime, 'image/jpeg')
  assert.equal(classifyAttachment('doc.pdf').kind, 'pdf')
  assert.equal(classifyAttachment('voz.mp3').mime, 'audio/mpeg')
  assert.equal(classifyAttachment('voz.wav').kind, 'audio')
  assert.equal(classifyAttachment('main.rs').kind, 'text')
  assert.equal(classifyAttachment('Makefile').kind, 'text')
  assert.equal(classifyAttachment('dados', 'application/json').kind, 'text')
  assert.equal(classifyAttachment('coisa.xyz').kind, 'maybe-text')
  assert.equal(classifyAttachment('a.zip', 'application/zip').kind, null)
  assert.equal(classifyAttachment('a.bmp', 'image/bmp').kind, null)
  assert.equal(classifyAttachment('v.mp4', 'video/mp4').kind, null)
})

test('store: content-addressed (dedup), limites e erros legíveis', () => {
  const a = saveAttachment({ name: '../../etc/foto.png', data: PNG })
  assert.equal(a.kind, 'image')
  assert.equal(a.mime, 'image/png')
  assert.equal(a.name, 'foto.png') // sem diretórios
  assert.match(a.file, /^[0-9a-f]{64}\.png$/)
  assert.equal(a.file.slice(0, 64), a.sha256)
  assert.ok(existsSync(join(STORE, a.file)))
  const b = saveAttachment({ name: 'outra.png', data: PNG })
  assert.equal(b.file, a.file) // dedup
  assert.equal(readAttachment(a.file).length, PNG.length)

  const t = saveAttachment({ name: 'notas.xyz', data: new TextEncoder().encode('olá, mundo') })
  assert.equal(t.kind, 'text') // desconhecido mas UTF-8 → texto
  assert.match(t.file, /\.txt$/)

  assert.throws(
    () => saveAttachment({ name: 'bin.xyz', data: Uint8Array.from([0, 1, 2, 0xff]) }),
    /não parece ser texto/
  )
  assert.throws(
    () => saveAttachment({ name: 'a.zip', mime: 'application/zip', data: PNG }),
    /Tipo não suportado: "a.zip"/
  )
  assert.throws(() => saveAttachment({ name: 'vazio.txt', data: new Uint8Array(0) }), /vazio/)
  const big = new Uint8Array(ATTACHMENT_LIMITS.maxFileBytes + 1)
  assert.throws(
    () => saveAttachment({ name: 'grande.png', data: big }),
    /limite por arquivo é 20\.0 MB/
  )
})

test('codificação por tipo: parts persistidos com referência + _attachment, texto por último', () => {
  const img = saveAttachment({ name: 'a.png', data: PNG })
  const pdf = saveAttachment({ name: 'Relatório "Q3".pdf', data: PDF })
  const wav = saveAttachment({ name: 'voz.wav', data: WAV })
  const txt = saveAttachment({ name: 'main.ts', data: new TextEncoder().encode('const x = 1\n') })

  const content = buildUserContent('descreva', [img, pdf, wav, txt]) as any[]
  assert.equal(content.length, 5)
  assert.deepEqual(content[0], {
    type: 'image_url',
    image_url: { url: `clearchat-attachment://${img.file}` },
    _attachment: {
      name: 'a.png',
      mime: 'image/png',
      size: PNG.length,
      kind: 'image',
      file: img.file
    }
  })
  assert.equal(content[1].type, 'file')
  assert.equal(content[1].file.filename, 'Relatório "Q3".pdf')
  assert.equal(content[1].file.file_data, `clearchat-attachment://${pdf.file}`)
  assert.deepEqual(content[2].input_audio, {
    data: `clearchat-attachment://${wav.file}`,
    format: 'wav'
  })
  assert.equal(content[3].type, 'text')
  assert.equal(content[3].text, '<file name="main.ts">\nconst x = 1\n\n</file>')
  assert.equal(textFileBody(content[3].text), 'const x = 1\n')
  assert.deepEqual(content[4], { type: 'text', text: 'descreva' })
  // nome com aspas escapado no atributo
  const q = attachmentPart({ ...txt, name: 'a"b<c>.md' }) as any
  assert.ok(q.text.startsWith('<file name="a&quot;b&lt;c&gt;.md">\n'))
  // sem anexos → string (formato de sempre); texto vazio com anexo → sem text part
  assert.equal(buildUserContent('oi', []), 'oi')
  assert.equal((buildUserContent('  ', [img]) as any[]).length, 1)
  // texto da mensagem ignora os parts de anexo
  assert.equal(contentText(content as any), 'descreva')
  // corte de texto
  const c = capText('x'.repeat(50), 10)
  assert.ok(c.truncated && c.text.startsWith('xxxxxxxxxx\n[… arquivo cortado: mostrando 10 de 50'))
  assert.equal(parseAttachmentUrl(`clearchat-attachment://${img.file}/`), img.file)
  assert.equal(parseAttachmentUrl('clearchat-attachment://../etc/passwd'), null)
})

test('validateAttachments: confere o store e os limites', () => {
  const img = saveAttachment({ name: 'a.png', data: PNG })
  const [v] = validateAttachments([{ ...img, size: 999_999, name: 'x/y/z.png' }])
  assert.equal(v.size, PNG.length) // tamanho real do disco
  assert.equal(v.name, 'z.png')
  assert.deepEqual(validateAttachments(undefined), [])
  assert.throws(() => validateAttachments([{ ...img, file: '../x' }]), /Anexo inválido/)
  assert.throws(
    () => validateAttachments([{ ...img, file: 'f'.repeat(64) + '.png' }]),
    /não encontrado no disco/
  )
  assert.throws(
    () => validateAttachments(Array.from({ length: ATTACHMENT_LIMITS.maxFiles + 1 }, () => img)),
    /No máximo/
  )
})

test('buildRequest: expande referências (base64), remove _attachment, determinístico e sem mutar o histórico', () => {
  const img = saveAttachment({ name: 'a.png', data: PNG })
  const pdf = saveAttachment({ name: 'r.pdf', data: PDF })
  const wav = saveAttachment({ name: 'voz.wav', data: WAV })
  const hist = [
    sm({ role: 'user', content: buildUserContent('o que é isso?', [img, pdf, wav]) }),
    sm({ role: 'assistant', content: 'um png' }),
    sm({ role: 'user', content: 'ok' })
  ]
  const before = JSON.stringify(hist)
  const r1 = buildRequest(chat(), { depth: 0, model: 'm' }, hist, provider, env)
  const r2 = buildRequest(chat(), { depth: 0, model: 'm' }, hist, provider, env)
  assert.equal(JSON.stringify(r1.body), JSON.stringify(r2.body)) // mesmos bytes → cacheável
  assert.equal(JSON.stringify(hist), before) // histórico intacto (referências continuam no DB)
  const wire = JSON.stringify(r1.body)
  assert.ok(!wire.includes('_attachment'), 'campo privado vazou')
  assert.ok(!wire.includes('clearchat-attachment://'), 'referência não expandida')
  const u = (r1.body as any).messages[1].content
  assert.deepEqual(u[0], {
    type: 'image_url',
    image_url: { url: `data:image/png;base64,${Buffer.from(PNG).toString('base64')}` }
  })
  assert.deepEqual(u[1], {
    type: 'file',
    file: {
      filename: 'r.pdf',
      file_data: `data:application/pdf;base64,${Buffer.from(PDF).toString('base64')}`
    }
  })
  assert.deepEqual(u[2], {
    type: 'input_audio',
    input_audio: { data: Buffer.from(WAV).toString('base64'), format: 'wav' }
  })
  assert.deepEqual(u[3], { type: 'text', text: 'o que é isso?' })
  // expandAttachments isolado: mensagens sem anexo ficam como estão (mesmo objeto)
  const plain: ApiMessage = { role: 'user', content: 'x' }
  assert.equal(expandAttachments([plain])[0], plain)
})

test('cache_control com parts mistos: último text part; só anexo marca o último part; text de arquivo conta', () => {
  const img = saveAttachment({ name: 'a.png', data: PNG })
  const txt = saveAttachment({ name: 'n.md', data: new TextEncoder().encode('# t') })
  // última user = [imagem, texto] → breakpoint no texto (fim da mensagem)
  let hist = [sm({ role: 'user', content: buildUserContent('veja', [img]) })]
  let body = buildRequest(chat(), { depth: 0, model: 'm' }, hist, provider, env).body as any
  let last = body.messages.at(-1).content
  assert.equal(last[0].cache_control, undefined)
  assert.deepEqual(last[1], { type: 'text', text: 'veja', cache_control: { type: 'ephemeral' } })
  // só imagem (sem texto) → o próprio part da imagem recebe o breakpoint; o anterior não
  hist = [
    sm({ role: 'user', content: 'antes' }),
    sm({ role: 'assistant', content: 'ok' }),
    sm({ role: 'user', content: buildUserContent('', [img]) })
  ]
  body = buildRequest(chat(), { depth: 0, model: 'm' }, hist, provider, env).body as any
  last = body.messages.at(-1).content
  assert.equal(last.length, 1)
  assert.equal(last[0].type, 'image_url')
  assert.deepEqual(last[0].cache_control, { type: 'ephemeral' })
  assert.ok(last[0].image_url.url.startsWith('data:image/png;base64,'))
  assert.ok(!JSON.stringify(body.messages.at(-1)).includes('_attachment'))
  assert.equal(body.messages.at(-2).content, 'ok')
  // só arquivo de texto → o part text do arquivo recebe o breakpoint
  hist = [sm({ role: 'user', content: buildUserContent('', [txt]) })]
  body = buildRequest(chat(), { depth: 0, model: 'm' }, hist, provider, env).body as any
  last = body.messages.at(-1).content
  assert.equal(last.length, 1)
  assert.deepEqual(last[0].cache_control, { type: 'ephemeral' })
  assert.ok(last[0].text.startsWith('<file name="n.md">'))
  assert.equal(last[0]._attachment, undefined)
  // sem cache: nenhum cache_control, mas expansão/remoção continuam
  hist = [sm({ role: 'user', content: buildUserContent('veja', [img]) })]
  body = buildRequest(chat({ cacheEnabled: false }), { depth: 0, model: 'm' }, hist, provider, env)
    .body as any
  assert.ok(!JSON.stringify(body).includes('cache_control'))
  assert.ok(body.messages.at(-1).content[0].image_url.url.startsWith('data:image/png;base64,'))
})

test('anexo ausente no disco → erro legível (não crash)', () => {
  const img = saveAttachment({ name: 'sumiu.png', data: Uint8Array.from([9, 9, 9, 1]) })
  const hist = [sm({ role: 'user', content: buildUserContent('x', [img]) })]
  rmSync(join(STORE, img.file))
  assert.throws(
    () => buildRequest(chat(), { depth: 0, model: 'm' }, hist, provider, env),
    /Anexo não encontrado no disco: "sumiu\.png".*Apague a mensagem/
  )
})

test('preview: base64 encurtado com tamanho, original intacto', () => {
  const data = new Uint8Array(3000).fill(7)
  const img = saveAttachment({ name: 'g.png', data })
  const wav = saveAttachment({ name: 'g.wav', data: new Uint8Array(2000).fill(3) })
  const hist = [sm({ role: 'user', content: buildUserContent('oi', [img, wav]) })]
  const req = buildRequest(chat(), { depth: 0, model: 'm' }, hist, provider, env)
  const original = JSON.stringify(req.body)
  const { body, truncated } = truncateBodyForPreview(req.body)
  assert.equal(truncated, 2)
  assert.equal(JSON.stringify(req.body), original)
  const parts = (body as any).messages.at(-1).content
  const b64 = Buffer.from(data).toString('base64')
  assert.equal(parts[0].image_url.url, `data:image/png;base64,${b64.slice(0, 24)}…(2.9 KB)`)
  assert.match(parts[1].input_audio.data, /^[A-Za-z0-9+/]{24}…\(2\.0 KB\)$/)
  assert.deepEqual(parts[2], { type: 'text', text: 'oi', cache_control: { type: 'ephemeral' } })
  // nada a encurtar → mesmo objeto
  const plain = { messages: [{ role: 'user', content: 'x' }] }
  assert.equal(truncateBodyForPreview(plain).body, plain)
})

test('compactação encurtada: anexos viram placeholders [imagem: nome]', () => {
  const img = saveAttachment({ name: 'tela.png', data: PNG })
  const hist = [
    sm({ role: 'user', content: buildUserContent('analise', [img]) }),
    sm({ role: 'assistant', content: 'feito' })
  ]
  const full = buildCompactionRequest(
    chat(),
    { id: 's1', depth: 0, model: 'm' },
    hist,
    provider,
    'RESUMA',
    { mode: 'full', window: null },
    env
  )
  assert.ok((full.body as any).messages[1].content[0].image_url.url.startsWith('data:image/png'))
  const trimmed = buildCompactionRequest(
    chat(),
    { id: 's1', depth: 0, model: 'm' },
    hist,
    provider,
    'RESUMA',
    { mode: 'trimmed', window: null },
    env
  )
  const u = (trimmed.body as any).messages[1].content
  assert.deepEqual(u[0], { type: 'text', text: '[imagem: tela.png]' })
  assert.ok(!JSON.stringify(trimmed.body).includes('base64'))
})

test('edição (withText) preserva os parts de anexo', () => {
  const img = saveAttachment({ name: 'a.png', data: PNG })
  const m: ApiMessage = { role: 'user', content: buildUserContent('antigo', [img]) }
  const e = withText(m, 'novo') as any
  assert.equal(e.content.length, 2)
  assert.deepEqual(e.content[0], (m.content as any[])[0])
  assert.deepEqual(e.content[1], { type: 'text', text: 'novo' })
  const empty = withText(m, '') as any
  assert.deepEqual(empty.content, [(m.content as any[])[0]])
  assert.deepEqual(withText({ role: 'user', content: 'a' }, 'b'), { role: 'user', content: 'b' })
})

test('modalidades: /models (input_modalities) e avisos', () => {
  const m = mapModel({
    id: 'x/y',
    architecture: { input_modalities: ['text', 'image', 7] },
    supported_parameters: ['tools']
  })!
  assert.deepEqual(m.inputModalities, ['text', 'image'])
  assert.equal(mapModel({ id: 'z' })!.inputModalities, undefined)
  assert.equal(modalitySupport('image', m, true), 'ok')
  assert.equal(modalitySupport('audio', m, true), 'unsupported')
  assert.equal(modalitySupport('pdf', m, true), 'parsed') // OpenRouter extrai o texto
  assert.equal(modalitySupport('pdf', m, false), 'unsupported')
  assert.equal(modalitySupport('image', { id: 'q' } as any, false), 'unknown')
  assert.equal(modalitySupport('text', null, false), 'ok')
  assert.equal(modalityWarning('image', 'unsupported'), 'Este modelo não aceita imagens')
  assert.match(modalityWarning('audio', 'unknown')!, /Não sei se este modelo aceita áudio/)
  assert.equal(modalityWarning('pdf', 'parsed'), null)
})

test('GC: apaga só órfãos antigos do store; poupa referenciados, recentes e arquivos alheios', () => {
  const dir = join(TMP, 'gc')
  mkdirSync(dir, { recursive: true })
  const ref = 'a'.repeat(64) + '.png'
  const orphan = 'b'.repeat(64) + '.pdf'
  const fresh = 'c'.repeat(64) + '.txt'
  const tmp = '.tmp-12345678-1234-1234-1234-123456789abc'
  const alien = 'notas.txt'
  for (const f of [ref, orphan, fresh, tmp, alien]) writeFileSync(join(dir, f), 'x')
  mkdirSync(join(dir, 'd'.repeat(64))) // pasta com nome de store: nunca apagada
  const old = new Date(Date.now() - 3 * 3600_000)
  for (const f of [ref, orphan, tmp, alien, 'd'.repeat(64)]) utimesSync(join(dir, f), old, old)

  // referências a partir do banco (só mensagens com clearchat-attachment://)
  const db = new Database(':memory:')
  db.exec('CREATE TABLE messages (id TEXT, message_json TEXT, meta_json TEXT)')
  db.prepare('INSERT INTO messages (id, message_json) VALUES (?, ?)').run(
    '1',
    JSON.stringify({
      role: 'user',
      content: buildUserContent('x', [
        {
          sha256: 'a'.repeat(64),
          name: 'a.png',
          mime: 'image/png',
          size: 1,
          kind: 'image',
          file: ref
        }
      ])
    })
  )
  db.prepare('INSERT INTO messages (id, message_json) VALUES (?, ?)').run(
    '2',
    JSON.stringify({ role: 'user', content: 'oi' })
  )
  const referenced = referencedFilesInDb(db)
  db.close()
  assert.deepEqual([...referenced], [ref])

  const r = gcAttachments(dir, referenced, { graceMs: 3600_000 })
  assert.deepEqual(r.deleted.sort(), [orphan, tmp].sort())
  assert.ok(existsSync(join(dir, ref)))
  assert.ok(existsSync(join(dir, fresh)))
  assert.ok(existsSync(join(dir, alien)))
  assert.ok(existsSync(join(dir, 'd'.repeat(64))))
  // pasta inexistente → no-op
  assert.deepEqual(gcAttachments(join(TMP, 'nao-existe'), new Set()), { deleted: [], kept: 0 })
})
