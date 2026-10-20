/* eslint-disable @typescript-eslint/no-explicit-any */
// Testes unitários (sem Electron): saídas grandes de tools → arquivo (tools/toolOutputs.ts +
// runToolImpl), leitura das saídas salvas com confineToRoot, limpeza e poda.
// Rodar: npm run test:unit
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clampSpillChars, LIMITS } from '../src/shared/limits.ts'
import {
  chatToolOutputDir,
  gcToolOutputs,
  headExcerpt,
  removeChatToolOutputs,
  renderSpilled,
  setToolOutputDir
} from '../src/main/tools/toolOutputs.ts'
import { fail, ok, runToolImpl, spillCharsOf } from '../src/main/tools/util.ts'
import { listDir, readFile, writeFile, editFile } from '../src/main/tools/files.ts'
import { searchFiles } from '../src/main/tools/search.ts'
import { shell } from '../src/main/tools/bash.ts'
import { setProcessLogDir } from '../src/main/tools/processes.ts'
import { extractPage, formatExtracted } from '../src/main/tools/pageExtract.ts'

const TMP = mkdtempSync(join(process.env.CLEARCHAT_TEST_TMP || tmpdir(), 'clearchat-spill-'))
after(() => rmSync(TMP, { recursive: true, force: true }))
const OUT = join(TMP, 'tool-outputs')
const ROOT = join(TMP, 'root')
const OUTSIDE = join(TMP, 'outside')
mkdirSync(ROOT, { recursive: true })
mkdirSync(OUTSIDE, { recursive: true })
writeFileSync(join(OUTSIDE, 'secret.txt'), 'segredo')
setToolOutputDir(OUT)

let n = 0
const ctx = (over: Record<string, unknown> = {}): any => ({
  cwd: ROOT,
  confine: true,
  chatId: 'chat-a',
  toolCallId: `call_${++n}`,
  signal: new AbortController().signal,
  ...over
})

const PATH_RE = /Conteúdo completo salvo em:\n(.+)\n/
const pathOf = (content: string): string => {
  const m = PATH_RE.exec(content)
  assert.ok(m, `sem caminho no resultado:\n${content.slice(0, 600)}`)
  return m![1]
}
const bigText = (lines: number, width = 40): string =>
  Array.from({ length: lines }, (_, i) => `linha ${i + 1} ${'x'.repeat(width)}`).join('\n')

test('limite: padrão 8.000, setting normalizado e nunca acima de maxToolOutputChars', () => {
  assert.equal(LIMITS.spillThresholdChars, 8000)
  assert.equal(clampSpillChars(undefined), 8000)
  assert.equal(clampSpillChars(100), LIMITS.spillThresholdMin)
  assert.equal(clampSpillChars(10_000_000), LIMITS.spillThresholdMax)
  assert.equal(spillCharsOf({}), 8000)
  assert.equal(spillCharsOf({ spillChars: 20_000 }), 20_000)
  assert.equal(spillCharsOf({ spillChars: 20_000, maxOutput: 5000 }), 5000)
})

test('headExcerpt: corta em fronteira de linha; linha enorme corta no meio', () => {
  const h = headExcerpt('aaaa\nbbbb\ncccc\ndddd', 12)
  assert.deepEqual(h, { text: 'aaaa\nbbbb', lines: 2, partial: false })
  const p = headExcerpt('z'.repeat(100), 30)
  assert.equal(p.text.length, 30)
  assert.equal(p.partial, true)
})

test('spill: abaixo do limite fica inline; acima vai inteiro para arquivo + trecho + instruções', async () => {
  const small = 'pequeno\n'.repeat(10)
  const r1 = await runToolImpl(async () => ok(small), {}, ctx())
  assert.equal(r1.content, small)
  assert.equal((r1 as any).spill, undefined)

  const text = bigText(1000) // ~50 mil chars
  const c = ctx({ toolCallId: 'call_big' })
  const r = await runToolImpl(async () => ok(text), {}, c)
  assert.equal(r.status, 'ok')
  assert.ok(r.content.length < 4000, `len ${r.content.length}`)
  const path = pathOf(r.content)
  assert.equal(path, join(chatToolOutputDir('chat-a'), 'call_big.txt'))
  assert.equal(readFileSync(path, 'utf8'), text)
  // trecho do início cortado numa linha inteira
  const head = r.content.split('\n[saída longa')[0]
  assert.ok(head.startsWith('linha 1 x'))
  assert.match(head.split('\n').pop()!, /^linha \d+ x{40}$/)
  const shown = head.split('\n').length
  assert.match(
    r.content,
    new RegExp(
      `\\[saída longa: ${text.length.toLocaleString('pt-BR').replace(/\./g, '\\.')} caracteres em 1\\.000 linhas — acima, só o início \\(linhas 1–${shown}\\)`
    )
  )
  assert.match(
    r.content,
    new RegExp(
      `read_file \\(esse path, offset/limit em linhas — ex\\.: offset=${shown + 1}, limit=200\\)`
    )
  )
  assert.match(r.content, /search_files \(pattern \+ path = esse arquivo\)/)
  // determinístico: o texto só depende da saída e do caminho
  const again = await runToolImpl(async () => ok(text), {}, ctx({ toolCallId: 'call_big2' }))
  assert.equal(again.content.replace('call_big2', 'call_big'), r.content)
  // id repetido (provedores que repetem ids) não sobrescreve a saída antiga
  const dup = await runToolImpl(async () => ok(text + '\nfim'), {}, ctx({ toolCallId: 'call_big' }))
  assert.equal(pathOf(dup.content), join(chatToolOutputDir('chat-a'), 'call_big-2.txt'))
  assert.equal(readFileSync(path, 'utf8'), text)
})

test('spill: erros ficam inline; noSpill e limite configurado', async () => {
  const text = bigText(1000)
  const e = await runToolImpl(async () => fail(`Erro: ${text}`), {}, ctx({ maxOutput: 100_000 }))
  assert.equal(e.status, 'error')
  assert.ok(!PATH_RE.test(e.content))
  assert.ok(e.content.length > 40_000)
  const ns = await runToolImpl(
    async () => ({ ...ok(text), noSpill: true }),
    {},
    ctx({ maxOutput: 100_000 })
  )
  assert.equal(ns.content, text)
  assert.equal((ns as any).noSpill, undefined)
  // setting maior: fica inline
  const big = await runToolImpl(
    async () => ok(text),
    {},
    ctx({ spillChars: 100_000, maxOutput: 100_000 })
  )
  assert.equal(big.content, text)
})

test('shell: saída enorme → início + fim inline, status no fim, arquivo com tudo', async () => {
  const sh = { root: ROOT, dir: ROOT }
  const r = await runToolImpl(shell, { command: 'seq 1 200000' }, ctx({ shell: sh }))
  assert.equal(r.status, 'ok')
  assert.ok(r.content.length < 4500, `len ${r.content.length}`)
  assert.ok(r.content.startsWith('1\n2\n3\n'))
  assert.match(r.content, /\[… linhas [\d.]+–[\d.]+ omitidas …\]/)
  assert.match(r.content, /\n200000\n\[saída longa: /)
  assert.match(r.content, /o início \(linhas 1–\d+\) e o fim \(linhas [\d.]+–200\.000\)/)
  assert.match(r.content, /\n\[exit code: 0\]$/)
  const path = pathOf(r.content)
  const saved = readFileSync(path, 'utf8')
  assert.equal(saved.split('\n').length, 200000)
  assert.ok(saved.endsWith('199999\n200000'))

  // read_file do arquivo salvo com confineToRoot: permitido, em partes
  const part = await runToolImpl(readFile, { path, offset: 150_000, limit: 3 }, ctx())
  assert.equal(part.status, 'ok', part.content)
  assert.match(part.content, /150000\t150000\n150001\t150001\n150002\t150002$/)
  // sem limit: só o início + instruções (sem gerar outro arquivo)
  const whole = await runToolImpl(readFile, { path }, ctx())
  assert.match(whole.content, /^\[arquivo grande: 200\.000 linhas/)
  assert.ok(!PATH_RE.test(whole.content))
  assert.ok(whole.content.length <= 30_000) // teto padrão do chat (maxToolOutputChars)
  // search_files no arquivo salvo
  const s = await runToolImpl(searchFiles, { pattern: '^12345$', path }, ctx())
  assert.equal(s.status, 'ok', s.content)
  assert.match(s.content, /:12345:12345/)
  // outro chat: negado; caminho de fora: continua negado
  const other = await runToolImpl(readFile, { path }, ctx({ chatId: 'chat-b' }))
  assert.match(other.content, /fora do diretório raiz/)
  const outside = await runToolImpl(readFile, { path: join(OUTSIDE, 'secret.txt') }, ctx())
  assert.match(outside.content, /fora do diretório raiz/)
  // escrita nunca (nem sem confinação)
  const w = await runToolImpl(writeFile, { path, content: 'x' }, ctx({ confine: false }))
  assert.match(w.content, /saída salva de ferramenta \(somente leitura\)/)
  const ed = await runToolImpl(
    editFile,
    { path, old_string: '1', new_string: '2' },
    ctx({ confine: false })
  )
  assert.match(ed.content, /somente leitura/)
  assert.equal(readFileSync(path, 'utf8'), saved)
})

test('leitura de saídas salvas: só arquivos comuns, sem escapar por symlink; apagada → aviso', async () => {
  const dir = chatToolOutputDir('chat-a')
  mkdirSync(dir, { recursive: true })
  const link = join(dir, 'link.txt')
  symlinkSync(join(OUTSIDE, 'secret.txt'), link)
  const r = await runToolImpl(readFile, { path: link }, ctx())
  assert.match(r.content, /fora do diretório raiz/)
  const sub = join(dir, 'pasta')
  mkdirSync(sub)
  const d = await runToolImpl(readFile, { path: sub }, ctx())
  assert.match(d.content, /fora do diretório raiz/)
  const gone = await runToolImpl(readFile, { path: join(dir, 'nao-existe.txt') }, ctx())
  assert.match(gone.content, /a saída salva .* não existe mais/)
})

test('logs de processos do próprio chat: legíveis com confineToRoot', async () => {
  const logs = join(TMP, 'processes')
  mkdirSync(logs)
  setProcessLogDir(logs)
  writeFileSync(join(logs, 'chat-a-p1-123.log'), 'pronto na porta 5173\n')
  writeFileSync(join(logs, 'chat-b-p1-123.log'), 'de outro chat\n')
  const mine = await runToolImpl(readFile, { path: join(logs, 'chat-a-p1-123.log') }, ctx())
  assert.match(mine.content, /1\tpronto na porta 5173/)
  const theirs = await runToolImpl(readFile, { path: join(logs, 'chat-b-p1-123.log') }, ctx())
  assert.match(theirs.content, /fora do diretório raiz/)
})

test('list_dir grande vai para arquivo', async () => {
  const many = join(ROOT, 'many')
  mkdirSync(many)
  for (let i = 0; i < 280; i++) writeFileSync(join(many, `arquivo-com-nome-comprido-${i}.txt`), 'x')
  const r = await runToolImpl(listDir, { path: 'many' }, ctx())
  const path = pathOf(r.content)
  assert.match(readFileSync(path, 'utf8'), /arquivo-com-nome-comprido-99\.txt/)
  assert.ok(r.content.length < 4000)
})

test('browse_url: Markdown grande vai inteiro para o arquivo', async () => {
  const paras = Array.from(
    { length: 120 },
    (_, i) => `<p>Parágrafo ${i + 1}: ${'conteúdo relevante '.repeat(8)}</p>`
  ).join('\n')
  const html = `<html><head><title>Longa</title></head><body><nav><a href="/x">Menu</a></nav><main><h1>Longa</h1>${paras}</main></body></html>`
  const page = extractPage(html, 'https://ex.com/longa')
  const r = await runToolImpl(async () => ok(formatExtracted(page)), {}, ctx())
  assert.ok(r.content.startsWith('# Longa\nURL: https://ex.com/longa'))
  const saved = readFileSync(pathOf(r.content), 'utf8')
  assert.match(saved, /Parágrafo 120: conteúdo relevante/)
  assert.ok(!saved.includes('Menu'))
})

test('renderSpilled: linhas longas avisam para usar shell; caminho e rodapé preservados', () => {
  const body = `${'j'.repeat(5000)}\nfim`
  const out = renderSpilled({ body, foot: '\n[exit code: 0]' }, '/tmp/x.txt', 1000)
  assert.match(out, /só o começo da linha 1 \(cortada\)/)
  assert.match(out, /Há linhas com mais de 2\.000 caracteres/)
  assert.match(out, /\n\/tmp\/x\.txt\n/)
  assert.ok(out.endsWith('\n[exit code: 0]'))
})

test('limpeza: apagar o chat remove a pasta; poda por idade, chats inexistentes e orçamento', () => {
  setToolOutputDir(join(TMP, 'gc'))
  try {
    const a = chatToolOutputDir('chat-gc-a')
    const b = chatToolOutputDir('chat-gc-b')
    const orphan = chatToolOutputDir('chat-apagado')
    for (const d of [a, b, orphan]) mkdirSync(d, { recursive: true })
    const old = join(a, 'velho.txt')
    const recent = join(a, 'novo.txt')
    const b1 = join(b, 'b1.txt')
    writeFileSync(old, 'v'.repeat(100))
    writeFileSync(recent, 'n'.repeat(100))
    writeFileSync(b1, 'b'.repeat(1000))
    writeFileSync(join(orphan, 'o.txt'), 'o')
    const t = Date.now() / 1000 - 10 * 86400
    utimesSync(old, t, t)
    const t2 = Date.now() / 1000 - 3600
    utimesSync(b1, t2, t2)

    const live = ['chat-gc-a', 'chat-gc-b']
    const gone = gcToolOutputs({ liveChatIds: live, maxAgeDays: 7 })
    assert.ok(gone.includes(old), 'mais antigo que 7 dias')
    assert.ok(gone.includes(orphan), 'chat que não existe mais')
    assert.ok(!existsSync(old) && existsSync(recent) && existsSync(b1) && !existsSync(orphan))

    // orçamento (1.100 B > 500 B): apaga os mais antigos até caber; pasta vazia some
    const g2 = gcToolOutputs({ liveChatIds: live, maxTotalBytes: 500 })
    assert.deepEqual(g2, [b1])
    assert.ok(existsSync(recent) && !existsSync(b))

    removeChatToolOutputs('chat-gc-a')
    assert.ok(!existsSync(a))
  } finally {
    setToolOutputDir(OUT)
  }
})
