// Pré-processamento de delimitadores de LaTeX para o remark-math (função pura).
//
// - `\[ … \]` vira `$$ … $$` (em linhas próprias → bloco de display; no meio da frase → inline) e
//   `\( … \)` vira `$…$`. Os modelos da OpenAI adoram esses delimitadores; o remark-math só entende $.
// - `$…$` com um cifrão (singleDollarTextMath do remark-math) fica ligado, porque muitos modelos
//   (Claude, Gemini, DeepSeek, Qwen…) usam. Para não transformar preço em fórmula, só vale como
//   fórmula o par que segue a regra do Pandoc: o `$` de abertura tem um não-espaço logo à direita, o
//   de fechamento tem um não-espaço logo à esquerda e NÃO é seguido de dígito, e os dois estão na
//   mesma linha. Qualquer outro `$` solto vira `\$` (texto). Ex.: "custa $5 e $10" fica texto.
// - Nada é tocado dentro de blocos de código cercados, código inline, blocos `$$ … $$` nem escapes
//   (`\$`, `\\`, `` \` ``).
// - Streaming: um `\[` sem fechamento no fim do texto (só quando `streaming`) vira `$$` para a
//   fórmula aparecer progressivamente; `$$` sem fechamento já vai até o fim (o remark-math trata
//   como bloco aberto); `$` sem par vira texto até o par chegar.

import { parseFenceLine } from './fences'

const isSpace = (c: string | undefined): boolean => c === undefined || /\s/.test(c)
const isDigit = (c: string | undefined): boolean => c !== undefined && c >= '0' && c <= '9'

/** Índice do fim do parágrafo (próxima linha em branco) a partir de `from`, ou s.length. */
function paragraphEnd(s: string, from: number): number {
  const m = /\n[ \t]*(\r?\n|$)/.exec(s.slice(from))
  return m ? from + m.index : s.length
}

function lineStartBefore(s: string, i: number): number {
  const nl = s.lastIndexOf('\n', i - 1)
  return nl + 1
}

function convertInline(s: string, streaming: boolean): string {
  let out = ''
  let i = 0
  while (i < s.length) {
    const c = s[i]
    if (c === '`') {
      let n = 1
      while (s[i + n] === '`') n++
      const run = '`'.repeat(n)
      const end = paragraphEnd(s, i)
      let j = i + n
      let close = -1
      while (j < end) {
        const k = s.indexOf(run, j)
        if (k === -1 || k >= end) break
        if (s[k + n] !== '`' && s[k - 1] !== '`') {
          close = k
          break
        }
        j = k + 1
        while (s[j] === '`') j++
      }
      if (close === -1) {
        out += run
        i += n
      } else {
        out += s.slice(i, close + n)
        i = close + n
      }
      continue
    }
    if (c === '\\') {
      const next = s[i + 1]
      if (next === '[' || next === '(') {
        const closer = next === '[' ? '\\]' : '\\)'
        const end = paragraphEnd(s, i)
        const k = s.indexOf(closer, i + 2)
        const body = k !== -1 && k < end ? s.slice(i + 2, k) : null
        if (body !== null && body.trim()) {
          if (next === '(') {
            out += '$' + body.trim() + '$'
          } else {
            const ls = lineStartBefore(s, i)
            const before = s.slice(ls, i)
            const nl = s.indexOf('\n', k + 2)
            const after = s.slice(k + 2, nl === -1 ? s.length : nl)
            if (before.trim() === '' && after.trim() === '') {
              // Bloco: `$$` em linhas próprias, com a mesma indentação (listas).
              out += '$$\n' + before + body.trim() + '\n' + before + '$$'
            } else {
              out += '$$' + body.trim() + '$$'
            }
          }
          i = k + 2
          continue
        }
        if (
          next === '[' &&
          streaming &&
          k === -1 &&
          end === s.length &&
          s.slice(lineStartBefore(s, i), i).trim() === ''
        ) {
          // Fórmula de display ainda chegando: abre o bloco (o remark-math vai até o fim).
          const before = s.slice(lineStartBefore(s, i), i)
          out += '$$\n' + before + s.slice(i + 2).replace(/^[ \t]*\n?/, '')
          return out
        }
        out += c + next
        i += 2
        continue
      }
      // Escape qualquer (\$, \\, \`…): copia os dois caracteres.
      out += s.slice(i, i + 2)
      i += 2
      continue
    }
    if (c === '$') {
      let n = 1
      while (s[i + n] === '$') n++
      if (n >= 2) {
        // `$$…$$` inline: copia até o fechamento de mesmo tamanho (dentro do parágrafo).
        const run = '$'.repeat(n)
        const end = paragraphEnd(s, i)
        const k = s.indexOf(run, i + n)
        if (k !== -1 && k < end) {
          out += s.slice(i, k + n)
          i = k + n
        } else {
          out += run
          i += n
        }
        continue
      }
      // `$` único: fórmula só com par válido (regra do Pandoc) na mesma linha.
      if (!isSpace(s[i + 1])) {
        let q = i + 1
        // Para no fim da linha, no próximo `$` ou numa crase (código inline nunca é fórmula).
        while (q < s.length && s[q] !== '\n' && s[q] !== '$' && s[q] !== '`') {
          q += s[q] === '\\' ? 2 : 1
        }
        if (s[q] === '$' && s[q + 1] !== '$' && !isSpace(s[q - 1]) && !isDigit(s[q + 1])) {
          out += s.slice(i, q + 1)
          i = q + 1
          continue
        }
      }
      out += '\\$'
      i += 1
      continue
    }
    out += c
    i++
  }
  return out
}

/** Converte `\[…\]`/`\(…\)` para `$$`/`$` e escapa cifrões que não são fórmula, fora de código. */
export function normalizeMath(text: string, streaming = false): string {
  if (!/[$\\]/.test(text)) return text
  const lines = text.split('\n')
  const out: string[] = []
  let segment: string[] = []
  let fence: { char: string; len: number } | null = null
  let inMath = false
  const flush = (atEnd: boolean): void => {
    if (!segment.length) return
    out.push(convertInline(segment.join('\n'), streaming && atEnd))
    segment = []
  }
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '')
    if (fence) {
      out.push(raw)
      const f = parseFenceLine(line)
      if (f && !f.info && f.char === fence.char && f.len >= fence.len) fence = null
      continue
    }
    if (inMath) {
      out.push(raw)
      if (line.trim().endsWith('$$')) inMath = false
      continue
    }
    const f = parseFenceLine(line)
    if (f) {
      flush(false)
      out.push(raw)
      fence = { char: f.char, len: f.len }
      continue
    }
    // Linha que abre um bloco `$$` de várias linhas (`$$` sozinho, ou `$$ x` sem fechar na linha).
    const t = line.trim()
    if (t.startsWith('$$') && (t.match(/\$\$/g) ?? []).length % 2 === 1) {
      flush(false)
      out.push(raw)
      inMath = true
      continue
    }
    segment.push(raw)
  }
  flush(true)
  return out.join('\n')
}
