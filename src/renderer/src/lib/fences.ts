// Normalização de cercas de código aninhadas (pré-processamento puro do markdown das respostas).
//
// Problema: modelos costumam emitir um bloco cercado que contém outros blocos cercados com a MESMA
// cerca (ex.: um README em ```markdown com ```python dentro). Pelo CommonMark o bloco externo fecha
// no primeiro ``` interno "nu", e o resto da mensagem vira uma bagunça de prosa/código trocados.
//
// Solução: escanear as linhas acompanhando o aninhamento e reescrever só a cerca EXTERNA (abertura
// e fechamento) com mais crases/tis do que qualquer cerca interna, para o remark ver um bloco só,
// com as cercas internas como conteúdo literal.
//
// Regras (dentro de um bloco aberto com caractere C e comprimento L):
// - só linhas-cerca com o mesmo caractere C e comprimento ≥ L são estruturais (as mais curtas ou do
//   outro caractere nunca fecham o bloco no CommonMark, então são texto literal);
// - cerca COM info string (```lang) abre um nível aninhado;
// - cerca nua fecha o nível aninhado mais interno (se for longa o bastante);
// - cerca nua com profundidade 0 é uma "candidata" a fechar o bloco externo. A escolha natural
//   (CommonMark) é a primeira; mas uma cerca nua também pode abrir um bloco aninhado sem linguagem.
//   Para decidir, cada interpretação possível (fechar na 1ª, 2ª, … candidata, ou não fechar — bloco
//   ainda em streaming) recebe uma penalidade pelos sinais de "parse errado", e vence a menor
//   (empate → a mais cedo, ou seja, o comportamento do CommonMark; se o bloco externo é markdown/md,
//   a mais tarde — num README a cerca nua aninhada é a leitura mais provável):
//     · cerca nua que ABRE seguida de linha em branco (+1) — conteúdo de código vem logo abaixo;
//     · cerca nua que FECHA seguida de texto colado na linha de baixo (+1) — depois de fechar um
//       bloco o modelo quase sempre pula uma linha (ou a mensagem acaba);
//     · cerca nua que abre seguida imediatamente de outra que fecha (bloco vazio, +2), ou cerca nua
//       que abre colada logo depois de um fechamento (+1);
//     · mensagem terminando com uma cerca aberta (+1,5) — durante o streaming isso é normal, mas
//       entre duas leituras igualmente plausíveis prefere a que fecha tudo.
//   O resto da mensagem (depois do fechamento escolhido) é avaliado com as mesmas regras
//   (programação dinâmica sobre as linhas-cerca), então "fechar aqui deixaria uma cerca solta no fim"
//   pesa contra fechar aqui.
// - Cercas de 4+ crases que já contêm as internas mais curtas ficam intocadas (as internas não são
//   estruturais). Fora de blocos, qualquer indentação é aceita (cercas dentro de listas).
//   Limitações conhecidas: cercas dentro de citações (`> ```) não são tratadas; código indentado
//   por 4 espaços contendo ``` pode confundir o scanner.

type FenceChar = '`' | '~'

interface Fence {
  line: number
  indent: string
  char: FenceChar
  len: number
  info: string
}

type Role = 'open' | 'close' | 'none'

interface BlockPlan {
  open: number // índice em `fences`
  close: number // índice em `fences`, ou -1 se não fecha (vai até o fim do texto)
  inner: number[] // índices das linhas-cerca internas com o mesmo caractere (qualquer papel)
}

interface Best {
  cost: number
  blocks: BlockPlan[]
}

const FENCE_RE = /^([ \t]*)(`{3,}|~{3,})(.*)$/

export function parseFenceLine(line: string, lineIndex = 0): Fence | null {
  const m = FENCE_RE.exec(line)
  if (!m) return null
  const char = m[2][0] as FenceChar
  // Info string de cerca de crases não pode conter crase (```x``` é código inline, não cerca).
  if (char === '`' && m[3].includes('`')) return null
  return { line: lineIndex, indent: m[1], char, len: m[2].length, info: m[3].trim() }
}

const DANGLING = 1.5
const MAX_FENCES = 400
const DOC_LANG = /^(markdown|md|mdx|rmd|qmd)\b/i

/**
 * Reescreve as cercas externas de blocos com cercas aninhadas para que o remark os veja como um
 * bloco só. Texto sem aninhamento sai idêntico.
 */
export function normalizeFences(text: string): string {
  if (!text.includes('```') && !text.includes('~~~')) return text
  const lines = text.split('\n')
  const bare = (s: string): string => s.replace(/\r$/, '')
  const fences: Fence[] = []
  for (let i = 0; i < lines.length; i++) {
    const f = parseFenceLine(bare(lines[i]), i)
    if (f) fences.push(f)
  }
  // Com menos de 3 cercas não há aninhamento possível; com centenas, desiste (custo quadrático).
  if (fences.length < 3 || fences.length > MAX_FENCES) return text

  const isBlank = (i: number): boolean => i < lines.length && bare(lines[i]).trim() === ''
  const fenceAt = new Map<number, Fence>(fences.map((f) => [f.line, f]))
  const fenceIdx = new Map<number, number>(fences.map((f, k) => [f.line, k]))

  // Penalidade local de uma cerca nua com um papel, olhando a linha seguinte.
  const linePenalty = (f: Fence, role: Role, nextRole: Role | null): number => {
    if (f.info || role === 'none') return 0
    const next = f.line + 1
    if (next >= lines.length) return 0
    const nf = fenceAt.get(next)
    if (nf && nextRole && nextRole !== 'none') {
      if (role === 'open' && nextRole === 'close' && !nf.info) return 2
      if (role === 'close' && nextRole === 'open' && !nf.info) return 1
      if (role === 'open' && nextRole === 'open' && !nf.info) return 1
      return 0
    }
    if (role === 'open' && isBlank(next)) return 1
    if (role === 'close' && !isBlank(next) && !nf) return 1
    return 0
  }

  const memo = new Map<number, Best>()

  // Melhor leitura do texto a partir da cerca `i`, que está no nível superior (portanto abre).
  const best = (start: number): Best => {
    if (start >= fences.length) return { cost: 0, blocks: [] }
    const cached = memo.get(start)
    if (cached) return cached

    const o = fences[start]
    const roles: Role[] = [] // papel de fences[start + 1 + k] na leitura "estendida"
    const candidates: number[] = []
    const inner: number[] = []
    const stack: number[] = []
    for (let j = start + 1; j < fences.length; j++) {
      const f = fences[j]
      if (f.char !== o.char || f.len < o.len) {
        roles.push('none')
        continue
      }
      inner.push(j)
      if (f.info) {
        stack.push(f.len)
        roles.push('open')
      } else if (stack.length) {
        if (f.len >= stack[stack.length - 1]) {
          stack.pop()
          roles.push('close')
        } else roles.push('none')
      } else {
        // Candidata a fechar o bloco externo; na leitura estendida, abre um nível aninhado.
        candidates.push(j)
        stack.push(f.len)
        roles.push('open')
      }
    }
    const roleOf = (j: number, closeAt: number): Role =>
      j === closeAt ? 'close' : j === start ? 'open' : roles[j - start - 1]

    // Penalidades internas acumuladas até cada cerca (para a leitura que fecha em `closeAt`).
    const innerCost = (closeAt: number): number => {
      const end = closeAt === -1 ? fences.length - 1 : closeAt
      let cost = 0
      for (let j = start; j <= end; j++) {
        const nj = fenceIdx.get(fences[j].line + 1)
        let nextRole: Role | null = null
        if (nj !== undefined) {
          if (nj <= end) nextRole = roleOf(nj, closeAt)
          else nextRole = 'open' // primeira cerca do resto: abre no nível superior
        }
        if (j === end && closeAt !== -1) {
          cost += linePenalty(fences[j], 'close', nextRole)
        } else {
          cost += linePenalty(fences[j], roleOf(j, closeAt), nextRole)
        }
      }
      return cost
    }

    // Empate: a leitura mais cedo (CommonMark); dentro de um documento markdown, a mais tarde
    // (cerca nua aninhada é bem mais provável num README do que num bloco de código).
    const preferLater = DOC_LANG.test(o.info)
    let result: Best | null = null
    for (const c of [...candidates, -1]) {
      const rest = c === -1 ? { cost: DANGLING, blocks: [] } : best(c + 1)
      const cost = innerCost(c) + rest.cost
      if (!result || cost < result.cost || (preferLater && cost === result.cost)) {
        const end = c === -1 ? fences.length - 1 : c
        result = {
          cost,
          blocks: [
            { open: start, close: c, inner: inner.filter((j) => j <= end && j !== c) },
            ...rest.blocks
          ]
        }
      }
    }
    memo.set(start, result!)
    return result!
  }

  const plan = best(0)
  let changed = false
  for (const b of plan.blocks) {
    if (!b.inner.length) continue
    const o = fences[b.open]
    const maxInner = Math.max(...b.inner.map((j) => fences[j].len))
    const len = maxInner + 1
    const fence = o.char.repeat(len)
    const cr = (i: number): string => (lines[i].endsWith('\r') ? '\r' : '')
    lines[o.line] = o.indent + fence + (o.info ? o.info : '') + cr(o.line)
    if (b.close !== -1) {
      const c = fences[b.close]
      lines[c.line] = c.indent + fence + cr(c.line)
    }
    changed = true
  }
  return changed ? lines.join('\n') : text
}
