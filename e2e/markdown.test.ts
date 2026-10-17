// Testes unitários do pré-processamento de markdown do renderer (funções puras, sem DOM):
// cercas de código aninhadas (normalizeFences) e delimitadores de LaTeX (normalizeMath).
// Rodar: npm run test:unit
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeFences } from '../src/renderer/src/lib/fences.ts'
import { normalizeMath } from '../src/renderer/src/lib/math.ts'

const md = (...lines: string[]): string => lines.join('\n')
const F = '```'
const F4 = '````'

test('cercas: aninhada com linguagem → externa vira ```` e as internas ficam literais', () => {
  const src = md(F + 'markdown', '# Título', F + 'python', 'print(1)', F, 'texto', F, '', 'fim')
  assert.equal(
    normalizeFences(src),
    md(F4 + 'markdown', '# Título', F + 'python', 'print(1)', F, 'texto', F4, '', 'fim')
  )
})

test('cercas: dois níveis de aninhamento e vários blocos internos', () => {
  const src = md(
    F + 'md',
    F + 'markdown',
    F + 'js',
    'x()',
    F,
    F,
    F + 'bash',
    'ls',
    F,
    F,
    '',
    'depois',
    '',
    F + 'py',
    'y = 1',
    F
  )
  const out = normalizeFences(src).split('\n')
  assert.equal(out[0], F4 + 'md')
  assert.equal(out[9], F4)
  // Os blocos internos e o bloco seguinte (sem aninhamento) não mudam.
  assert.deepEqual(out.slice(1, 9), src.split('\n').slice(1, 9))
  assert.deepEqual(out.slice(10), src.split('\n').slice(10))
})

test('cercas: sem aninhamento o texto sai idêntico (blocos seguidos, código inline)', () => {
  const src = md(
    'Use `' + F + '` para cercar e ``a`b``.',
    '',
    F + 'ts',
    'const a = 1',
    F,
    '',
    'entre',
    '',
    F,
    'b',
    F,
    'Inline ```não é cerca``` aqui.'
  )
  assert.equal(normalizeFences(src), src)
})

test('cercas: cerca nua aninhada dentro de markdown (README) com fechamentos colados', () => {
  const src = md(F + 'markdown', '# Proj', F, 'npm i', F, F)
  assert.equal(normalizeFences(src), md(F4 + 'markdown', '# Proj', F, 'npm i', F, F4))
})

test('cercas: cerca nua aninhada no meio de um README sem linhas em branco', () => {
  const src = md(
    F + 'markdown',
    '# Proj',
    '## Instalar',
    F,
    'npm i',
    F,
    '## Uso',
    'Rode.',
    F,
    '',
    'Pronto!'
  )
  assert.equal(
    normalizeFences(src),
    md(
      F4 + 'markdown',
      '# Proj',
      '## Instalar',
      F,
      'npm i',
      F,
      '## Uso',
      'Rode.',
      F4,
      '',
      'Pronto!'
    )
  )
})

test('cercas: README fechado seguido de um bloco nu de nível superior não é engolido', () => {
  const src = md(F + 'markdown', '# A', F, '', 'Agora rode:', F, 'npm start', F)
  assert.equal(normalizeFences(src), src)
  // Com aninhamento dentro do README e um bloco nu depois.
  const src2 = md(
    F + 'markdown',
    '# Proj',
    F,
    'npm i',
    F,
    '',
    'Resto do README',
    F,
    '',
    'Agora rode:',
    F,
    'npm start',
    F
  )
  const out = normalizeFences(src2).split('\n')
  assert.equal(out[0], F4 + 'markdown')
  assert.equal(out[7], F4)
  assert.deepEqual(out.slice(8), src2.split('\n').slice(8))
})

test('cercas: streaming — bloco externo ainda aberto continua um bloco só', () => {
  // Interno ainda aberto: nada a fazer (o remark já trata o externo como aberto até o fim).
  const a = md(F + 'markdown', '# Proj', F + 'bash', 'npm i')
  assert.equal(normalizeFences(a), a)
  // Bloco interno já fechado, externo ainda não: a externa é alongada e fica aberta.
  const b = md(F + 'markdown', '# Proj', F + 'bash', 'npm i', F, 'mais')
  assert.equal(normalizeFences(b), md(F4 + 'markdown', '# Proj', F + 'bash', 'npm i', F, 'mais'))
  const c = md(F + 'markdown', '# Proj', F, 'npm i', F)
  assert.equal(normalizeFences(c), md(F4 + 'markdown', '# Proj', F, 'npm i', F))
  // Um bloco simples aberto não muda.
  const d = md('texto', '', F + 'python', 'x = 1')
  assert.equal(normalizeFences(d), d)
})

test('cercas: ~~~ (til) e cercas de til dentro de crases não interferem', () => {
  const src = md('~~~markdown', '~~~py', 'x', '~~~', '~~~')
  assert.equal(normalizeFences(src), md('~~~~markdown', '~~~py', 'x', '~~~', '~~~~'))
  const mixed = md(F + 'markdown', '~~~py', 'x', '~~~', F)
  assert.equal(normalizeFences(mixed), mixed)
})

test('cercas: dentro de lista indentada preserva a indentação', () => {
  const src = md(
    '1. Passo:',
    '   ' + F + 'markdown',
    '   ' + F + 'bash',
    '   ls',
    '   ' + F,
    '   ' + F,
    '2. Fim'
  )
  assert.equal(
    normalizeFences(src),
    md(
      '1. Passo:',
      '   ' + F4 + 'markdown',
      '   ' + F + 'bash',
      '   ls',
      '   ' + F,
      '   ' + F4,
      '2. Fim'
    )
  )
})

test('cercas: externa de 4+ crases já correta fica intocada; CRLF preservado', () => {
  const src = md(F4 + 'markdown', F + 'py', 'x', F, F, F4, '')
  assert.equal(normalizeFences(src), src)
  const crlf = [F + 'md', F + 'py', 'x', F, F, ''].join('\r\n')
  assert.equal(normalizeFences(crlf), [F4 + 'md', F + 'py', 'x', F, F4, ''].join('\r\n'))
})

test('cercas: string Python com cercas dentro de um bloco python', () => {
  const src = md(F + 'python', 's = """', F + 'js', 'x', F, '"""', F, '', 'ok')
  assert.equal(
    normalizeFences(src),
    md(F4 + 'python', 's = """', F + 'js', 'x', F, '"""', F4, '', 'ok')
  )
})

test('math: \\[ \\] em linhas próprias vira bloco $$ (também em lista); inline vira $$…$$', () => {
  assert.equal(
    normalizeMath('Antes\n\\[\nE = mc^2\n\\]\ndepois'),
    'Antes\n$$\nE = mc^2\n$$\ndepois'
  )
  assert.equal(normalizeMath('\\[ a^2 + b^2 = c^2 \\]'), '$$\na^2 + b^2 = c^2\n$$')
  assert.equal(normalizeMath('- item\n  \\[ x = 1 \\]'), '- item\n  $$\n  x = 1\n  $$')
  assert.equal(normalizeMath('veja \\[x\\] aqui'), 'veja $$x$$ aqui')
})

test('math: \\( \\) vira $…$ e $…$ válido fica como está', () => {
  assert.equal(normalizeMath('Seja \\( x^2 \\) e \\(y\\).'), 'Seja $x^2$ e $y$.')
  assert.equal(normalizeMath('Seja $x^2$ e $\\alpha$.'), 'Seja $x^2$ e $\\alpha$.')
  assert.equal(normalizeMath('$$\\int_0^1 f$$ inline'), '$$\\int_0^1 f$$ inline')
})

test('math: cifrões de preço viram texto (\\$), fórmula na mesma frase continua', () => {
  assert.equal(normalizeMath('custa $5 e $10'), 'custa \\$5 e \\$10')
  assert.equal(normalizeMath('R$ 50,00 ou R$60'), 'R\\$ 50,00 ou R\\$60')
  assert.equal(normalizeMath('entre $5-$10'), 'entre \\$5-\\$10')
  assert.equal(normalizeMath('Preço: $5. Já $x$ é fórmula'), 'Preço: \\$5. Já $x$ é fórmula')
  assert.equal(normalizeMath('já escapado \\$5'), 'já escapado \\$5')
})

test('math: nada muda dentro de código cercado, código inline nem bloco $$', () => {
  const code = md('```', '\\(x\\) custa $5 \\[y\\]', '```', 'ok \\(y\\)')
  assert.equal(normalizeMath(code), md('```', '\\(x\\) custa $5 \\[y\\]', '```', 'ok $y$'))
  assert.equal(
    normalizeMath('code `\\(x\\)` e `$5` e ``a ` $1``'),
    'code `\\(x\\)` e `$5` e ``a ` $1``'
  )
  assert.equal(normalizeMath('$5 `$x$`'), '\\$5 `$x$`')
  const block = md('$$', 'a \\\\ b \\(c\\) $5', '$$', '\\(z\\)')
  assert.equal(normalizeMath(block), md('$$', 'a \\\\ b \\(c\\) $5', '$$', '$z$'))
  // Depois do normalizeFences, um bloco aninhado inteiro é código.
  const nested = normalizeFences(md('```md', '```tex', '\\(x\\)', '```', '\\[y\\]', '```'))
  assert.equal(normalizeMath(nested), nested)
})

test('math: streaming — \\[ aberto no fim vira $$ só durante o streaming', () => {
  assert.equal(normalizeMath('Fórmula:\n\\[\nx = \\frac{1', true), 'Fórmula:\n$$\nx = \\frac{1')
  assert.equal(normalizeMath('Fórmula:\n\\[\nx = \\frac{1', false), 'Fórmula:\n\\[\nx = \\frac{1')
  // $ sem par ainda: texto até o par chegar.
  assert.equal(normalizeMath('valor $x + ', true), 'valor \\$x + ')
  // $$ aberto fica como está (o remark-math trata como bloco aberto até o fim).
  assert.equal(normalizeMath('$$\nx = ', true), '$$\nx = ')
})

test('tabelas: largura mínima pelas colunas (prosa até 14em, curtas 4em)', async () => {
  const { columnLengths, tableMinWidthEm } = await import('../src/renderer/src/lib/tableWidth.ts')
  const t = (s: string): { type: string; value: string } => ({ type: 'text', value: s })
  const cell = (tag: string, s: string): object => ({
    type: 'element',
    tagName: tag,
    children: [t(s)]
  })
  const row = (tag: string, ...c: string[]): object => ({
    type: 'element',
    tagName: 'tr',
    children: c.map((x) => cell(tag, x))
  })
  const table = {
    type: 'element',
    tagName: 'table',
    children: [
      { type: 'element', tagName: 'thead', children: [row('th', '', 'Candidato A')] },
      {
        type: 'element',
        tagName: 'tbody',
        children: [row('td', 'Trajetória', 'x'.repeat(120)), row('td', 'Ficha criminal', 'curto')]
      }
    ]
  }
  assert.deepEqual(columnLengths(table as never), [14, 120])
  // 7em + 1,5 (padding) + 14em + 1,5
  assert.equal(tableMinWidthEm(table as never), 24)
})
