// Largura mínima de uma tabela do markdown, estimada pelo texto de cada coluna (árvore hast do
// react-markdown). Colunas de prosa ganham até ~14em; curtas ficam no tamanho delas. Com o
// table-layout auto, o navegador distribui o resto; se a coluna do chat for mais estreita que o
// mínimo, o container .md-table rola na horizontal em vez de espremer as colunas.

/** Nó hast mínimo (sem depender dos tipos do hast). */
export interface HastLike {
  type: string
  tagName?: string
  value?: string
  children?: HastLike[]
}

const textLength = (n: HastLike): number =>
  n.type === 'text'
    ? (n.value ?? '').trim().length
    : (n.children ?? []).reduce((s, c) => s + textLength(c), 0)

/** Maior quantidade de caracteres por coluna (linhas de thead e tbody). */
export function columnLengths(table: HastLike): number[] {
  const cols: number[] = []
  const rows: HastLike[] = []
  const collect = (n: HastLike): void => {
    if (n.tagName === 'tr') rows.push(n)
    else for (const c of n.children ?? []) collect(c)
  }
  collect(table)
  for (const row of rows) {
    let i = 0
    for (const cell of row.children ?? []) {
      if (cell.tagName !== 'th' && cell.tagName !== 'td') continue
      cols[i] = Math.max(cols[i] ?? 0, textLength(cell))
      i++
    }
  }
  return cols
}

/** Largura mínima (em `em` da fonte da tabela): por coluna clamp(0,5em × caracteres, 4em, 14em) + padding. */
export function tableMinWidthEm(table: HastLike): number {
  const cols = columnLengths(table)
  const em = cols.reduce((s, n) => s + Math.min(14, Math.max(4, n * 0.5)) + 1.5, 0)
  return Math.round(em * 10) / 10
}
