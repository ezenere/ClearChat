// browse_url: HTML renderizado → Markdown compacto do conteúdo principal (puro, sem Electron;
// testado em e2e/pageExtract.test.ts com páginas salvas em e2e/fixtures/pages/).
//
// 1. Limpeza básica (todos os modos): script/style/noscript/svg/template/iframe/form controls,
//    comentários e elementos ocultos (atributo hidden, aria-hidden="true", display:none /
//    visibility:hidden inline) — salvo se o oculto tiver boa parte do texto da página (modais que
//    marcam o app inteiro como aria-hidden não apagam o conteúdo).
// 2. mode "main" (padrão): remove menus/boilerplate (nav, aside, footer, header do site, roles
//    navigation/banner/contentinfo/complementary/search/dialog, banners de cookie/consentimento,
//    compartilhar, newsletter, anúncios, "pular para o conteúdo"…) e escolhe a raiz do conteúdo:
//    <main>/[role=main]/<article> se tiver ≥ 60% do texto restante; senão desce do <body> pelo
//    filho com ≥ 75% do texto (texto de links pesa 0,2 — listas de links pesam pouco).
//    Fallback: raiz com < 50% do texto restante (ou o próprio body) → a página inteira sem menus,
//    avisando. Nada de conteúdo some em silêncio.
// 3. mode "full": só a limpeza básica (menus, cabeçalho e rodapé incluídos).
// Markdown: títulos, parágrafos, listas, tabelas (Markdown, números preservados), código cercado,
// citações, links absolutos `[texto](url)`, `[imagem: alt]`, listas de definição; cabeçalho com
// título, URL, canônica, descrição, datas e dados estruturados (JSON-LD Product/Offer/Article…).
import { parse, type DefaultTreeAdapterTypes as T } from 'parse5'
import { fmtNum } from './util'

type Node = T.Node
type Element = T.Element
type ParentNode = T.ParentNode

export type ExtractMode = 'main' | 'full'

export interface ExtractOptions {
  mode?: ExtractMode
  /** Acrescenta a seção "Links da página" (links da página inteira, menus inclusos). */
  links?: boolean
  maxLinks?: number
}

export interface PageLink {
  text: string
  href: string
}

export interface ExtractedPage {
  title: string
  url: string
  canonical?: string
  description?: string
  published?: string
  modified?: string
  /** Linhas compactas de dados estruturados (JSON-LD / meta de produto). */
  structured: string[]
  /** Corpo em Markdown. */
  markdown: string
  mode: ExtractMode
  /** main: conteúdo principal; fallback: página inteira sem menus; full: página inteira. */
  strategy: 'main' | 'fallback' | 'full'
  /** De onde veio o conteúdo principal (ex.: "<main>", "<article>", "densidade de texto"). */
  via: string
  /** Por que caiu no fallback. */
  reason?: string
  /** Caracteres de texto visível da página inteira (menus inclusos) e do conteúdo devolvido. */
  pageChars: number
  contentChars: number
  links?: PageLink[]
}

// ---------------- helpers de árvore ----------------

const isEl = (n: Node): n is Element => 'tagName' in n
const isText = (n: Node): n is T.TextNode => n.nodeName === '#text'

function attr(el: Element, name: string): string | undefined {
  for (const a of el.attrs) if (a.name === name) return a.value
  return undefined
}

function kids(n: ParentNode): Node[] {
  return (n as { childNodes?: Node[] }).childNodes ?? []
}

function remove(n: Node): void {
  const p = (n as { parentNode?: ParentNode | null }).parentNode
  if (!p) return
  const list = kids(p)
  const i = list.indexOf(n as T.ChildNode)
  if (i !== -1) list.splice(i, 1)
  ;(n as { parentNode?: ParentNode | null }).parentNode = null
}

function* elements(root: ParentNode): Generator<Element> {
  for (const c of kids(root)) {
    if (isEl(c)) {
      yield c
      yield* elements(c)
    }
  }
}

function find(root: ParentNode, pred: (e: Element) => boolean): Element | null {
  for (const e of elements(root)) if (pred(e)) return e
  return null
}

function rawText(n: Node): string {
  if (isText(n)) return n.value
  if (!isEl(n) && n.nodeName !== '#document' && n.nodeName !== '#document-fragment') return ''
  let s = ''
  for (const c of kids(n as ParentNode)) s += rawText(c)
  return s
}

const squash = (s: string): string => s.replace(/\s+/g, ' ').trim()

/** Texto (sem espaços repetidos) e quanto dele está dentro de links. */
interface Stats {
  text: number
  link: number
}

function statsOf(n: Node, memo: Map<Node, Stats>, inLink = false): Stats {
  const hit = memo.get(n)
  if (hit && !inLink) return hit
  let st: Stats
  if (isText(n)) {
    const len = squash(n.value).length
    st = { text: len, link: inLink ? len : 0 }
  } else if (isEl(n)) {
    const link = inLink || n.tagName === 'a'
    st = { text: 0, link: 0 }
    for (const c of n.childNodes) {
      const s = statsOf(c, memo, link)
      st.text += s.text
      st.link += s.link
    }
  } else st = { text: 0, link: 0 }
  if (!inLink) memo.set(n, st)
  return st
}

/** Peso do texto: fora de links conta inteiro, dentro de links 0,2. */
const weight = (s: Stats): number => s.text - s.link + s.link * 0.2
const linkDensity = (s: Stats): number => (s.text ? s.link / s.text : 0)

// ---------------- limpeza ----------------

const DROP_TAGS = new Set([
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'canvas',
  'video',
  'audio',
  'source',
  'track',
  'map',
  'link',
  'meta',
  'base',
  'head',
  'input',
  'select',
  'option',
  'optgroup',
  'textarea',
  'datalist',
  'output',
  'progress',
  'meter',
  'slot'
])

function isHidden(el: Element): boolean {
  const hidden = attr(el, 'hidden')
  if (hidden !== undefined && hidden !== 'until-found') return true
  if (attr(el, 'aria-hidden') === 'true') return true
  const style = attr(el, 'style')
  if (style && /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\b/i.test(style))
    return true
  if (el.tagName === 'dialog' && attr(el, 'open') === undefined) return true
  return false
}

/** Limpeza comum a todos os modos. `guard`: texto total da página (oculto grande fica). */
function baseClean(body: Element): void {
  const memo = new Map<Node, Stats>()
  const total = Math.max(1, statsOf(body, memo).text)
  const doomed: Node[] = []
  const visit = (n: ParentNode): void => {
    for (const c of kids(n)) {
      if (c.nodeName === '#comment' || c.nodeName === '#documentType') {
        doomed.push(c)
        continue
      }
      if (!isEl(c)) continue
      // botões curtos ("Copiar", "Menu", "Aceitar") saem; pergunta de acordeão (texto longo) fica
      if (DROP_TAGS.has(c.tagName) || (c.tagName === 'button' && squash(rawText(c)).length < 25)) {
        doomed.push(c)
        continue
      }
      if (isHidden(c)) {
        const t = statsOf(c, memo).text
        // modal aberto marca o app inteiro como aria-hidden: não apaga o conteúdo
        if (!(t >= 1500 && t >= total * 0.4)) {
          doomed.push(c)
          continue
        }
      }
      visit(c)
    }
  }
  visit(body)
  for (const n of doomed) remove(n)
}

const BOILER_ROLES = new Set([
  'navigation',
  'contentinfo',
  'complementary',
  'search',
  'menu',
  'menubar',
  'dialog',
  'alertdialog',
  'tablist',
  'toolbar'
])

// id/classe: sempre boilerplate (pequeno ou não)
const ALWAYS_RE =
  /(?:^|[-_ ])(?:cookies?|cookie-?banner|consent|gdpr|onetrust|cmp|newsletter|subscribe|adsbygoogle|advert(?:isement)?s?|ads?|ad-?slot|sponsor(?:ed)?|share|sharing|social|skip-?(?:link|nav|to-content)|sr-only-focusable|paywall-?prompt)(?:$|[-_ ])/i
// id/classe: boilerplate se for pequeno ou cheio de links (evita apagar um "menu" de restaurante)
const SOFT_RE =
  /(?:^|[-_ ])(?:nav|navbar|navigation|menu|mega-?menu|sidebar|side-?bar|sidenav|toc|table-of-contents|breadcrumbs?|footer|site-?header|masthead|topbar|top-?bar|header-?nav|related|recommended|more-stories|popular|trending|widget|promo|popup|modal|overlay|toolbar|pagination|pager|comments?|disqus|author-?bio|tags|tag-?list|feedback|rating-?widget|edit-?(?:this-)?page|print)(?:$|[-_ ])/i

const KEEP_TAGS = new Set(['main', 'article', 'body', 'html'])

function idClass(el: Element): string {
  return `${attr(el, 'id') ?? ''} ${attr(el, 'class') ?? ''}`.trim()
}

/** header com título próprio (h1/h2 fora de link) é o cabeçalho do artigo, não do site. */
function isArticleHeader(el: Element): boolean {
  for (const h of elements(el)) {
    if (h.tagName !== 'h1' && h.tagName !== 'h2') continue
    let p: ParentNode | null = h.parentNode
    let linked = false
    for (const e of elements(h)) if (e.tagName === 'a') linked = true
    while (p && p !== el) {
      if (isEl(p as Node) && (p as Element).tagName === 'a') linked = true
      p = (p as Element).parentNode
    }
    if (!linked && squash(rawText(h))) return true
  }
  return false
}

function insideTag(el: Element, tags: Set<string>): boolean {
  let p = el.parentNode
  while (p && isEl(p as Node)) {
    if (tags.has((p as Element).tagName)) return true
    if (attr(p as Element, 'role') === 'main') return true
    p = (p as Element).parentNode
  }
  return false
}

const MAIN_TAGS = new Set(['main', 'article'])

function boilerReason(el: Element, memo: Map<Node, Stats>): boolean {
  const tag = el.tagName
  const role = (attr(el, 'role') ?? '').toLowerCase()
  if (tag === 'nav' || tag === 'aside' || tag === 'footer') return true
  if (BOILER_ROLES.has(role)) return true
  if (tag === 'header' || role === 'banner') {
    if (insideTag(el, MAIN_TAGS) && role !== 'banner') return false
    return !isArticleHeader(el)
  }
  if (KEEP_TAGS.has(tag) || role === 'main') return false
  // "pular para o conteúdo"
  if (tag === 'a') {
    const href = attr(el, 'href') ?? ''
    if (href.startsWith('#') && /^(skip|pular|ir para|saltar|jump to)/i.test(squash(rawText(el))))
      return true
  }
  const ic = idClass(el)
  if (!ic) return false
  if (ALWAYS_RE.test(ic)) {
    const st = statsOf(el, memo)
    return st.text < 1500 || linkDensity(st) > 0.3
  }
  if (SOFT_RE.test(ic)) {
    const st = statsOf(el, memo)
    return st.text < 250 || linkDensity(st) > 0.4
  }
  return false
}

/** Remove menus e boilerplate (modes main / fallback). Nunca remove um bloco com ≥ 50% do texto. */
function stripBoilerplate(body: Element): void {
  const memo = new Map<Node, Stats>()
  const total = Math.max(1, weight(statsOf(body, memo)))
  const doomed: Element[] = []
  const visit = (n: ParentNode): void => {
    for (const c of kids(n)) {
      if (!isEl(c)) continue
      if (boilerReason(c, memo) && weight(statsOf(c, memo)) < total * 0.5) {
        doomed.push(c)
        continue
      }
      visit(c)
    }
  }
  visit(body)
  for (const e of doomed) remove(e)
}

// ---------------- conteúdo principal ----------------

const MAIN_SHARE = 0.6
const DESCEND_SHARE = 0.75
const FALLBACK_SHARE = 0.5

function pickMain(body: Element): { root: Element; via: string } | { fail: string } {
  const memo = new Map<Node, Stats>()
  const total = weight(statsOf(body, memo))
  if (total <= 0) return { fail: 'a página não tem texto fora dos menus' }
  // 1. candidatos explícitos
  const mains = [...elements(body)].filter(
    (e) => e.tagName === 'main' || attr(e, 'role') === 'main'
  )
  const articles = [...elements(body)].filter((e) => e.tagName === 'article')
  const best = (list: Element[]): Element | null =>
    list.reduce<Element | null>(
      (a, e) => (!a || weight(statsOf(e, memo)) > weight(statsOf(a, memo)) ? e : a),
      null
    )
  const main = best(mains)
  let explicitNote = ''
  if (main) {
    const share = weight(statsOf(main, memo)) / total
    if (share >= MAIN_SHARE)
      return { root: main, via: main.tagName === 'main' ? '<main>' : '[role=main]' }
    explicitNote = `o <main> da página tem só ${Math.round(share * 100)}% do texto`
  }
  const art = best(articles)
  if (art) {
    const artTotal = articles.reduce((a, e) => a + weight(statsOf(e, memo)), 0)
    const share = weight(statsOf(art, memo)) / total
    // várias <article> parecidas = listagem: não escolhe uma só
    if (share >= MAIN_SHARE && weight(statsOf(art, memo)) >= artTotal * 0.6)
      return { root: art, via: '<article>' }
  }
  // 2. densidade: desce enquanto um filho concentra o texto
  let node = body
  for (;;) {
    let top: Element | null = null
    let topW = 0
    for (const c of node.childNodes) {
      if (!isEl(c)) continue
      const w = weight(statsOf(c, memo))
      if (w > topW) {
        top = c
        topW = w
      }
    }
    if (!top || topW < weight(statsOf(node, memo)) * DESCEND_SHARE) break
    // só deixa os irmãos de fora se forem "menu": pouco texto fora de links e nenhum <h1>
    // (título, preço e afins ao lado do bloco principal continuam)
    const own = statsOf(node, memo)
    const sub = statsOf(top, memo)
    const leftOut = own.text - own.link - (sub.text - sub.link)
    const hasH1 = node.childNodes.some(
      (c) => c !== top && isEl(c) && (c.tagName === 'h1' || !!find(c, (e) => e.tagName === 'h1'))
    )
    if (hasH1 || leftOut > Math.max(80, (own.text - own.link) * 0.1)) break
    node = top
  }
  if (node === body)
    return {
      fail: explicitNote || 'o texto está espalhado em vários blocos, sem um bloco principal'
    }
  const share = weight(statsOf(node, memo)) / total
  if (share < FALLBACK_SHARE)
    return {
      fail: `o bloco mais denso tem só ${Math.round(share * 100)}% do texto${explicitNote ? `; ${explicitNote}` : ''}`
    }
  return { root: node, via: 'densidade de texto' }
}

// ---------------- Markdown ----------------

const BLOCK_TAGS = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'body',
  'center',
  'details',
  'dialog',
  'dd',
  'div',
  'dl',
  'dt',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hgroup',
  'hr',
  'li',
  'main',
  'menu',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'summary',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'ul',
  'legend',
  'caption'
])

interface Ctx {
  base: URL
  pageUrl: string
}

type Block = { kind: 'p' | 'h' | 'list' | 'table' | 'code' | 'quote' | 'hr' | 'other'; md: string }

function resolveHref(href: string, ctx: Ctx): string | null {
  const h = href.trim()
  if (!h || /^(javascript|data|vbscript):/i.test(h)) return null
  if (h.startsWith('#')) return null
  let u: URL
  try {
    u = new URL(h, ctx.base)
  } catch {
    return null
  }
  if (!/^(https?|mailto|tel|ftp):$/.test(u.protocol)) return null
  // âncora na própria página: só o texto
  if (u.hash && u.href.slice(0, -u.hash.length) === ctx.pageUrl.split('#')[0]) return null
  return u.href
}

const escLinkText = (s: string): string => s.replace(/([[\]])/g, '\\$1')

function inline(nodes: Node[], ctx: Ctx, inLink = false): string {
  let s = ''
  for (const n of nodes) s += inlineNode(n, ctx, inLink)
  return s
}

function wrapMark(mark: string, inner: string): string {
  const t = inner.trim()
  if (!t) return inner
  const lead = inner.startsWith(' ') ? ' ' : ''
  const trail = inner.endsWith(' ') ? ' ' : ''
  return `${lead}${mark}${t}${mark}${trail}`
}

function inlineNode(n: Node, ctx: Ctx, inLink: boolean): string {
  if (isText(n)) return n.value.replace(/\s+/g, ' ')
  if (!isEl(n)) return ''
  const tag = n.tagName
  switch (tag) {
    case 'br':
      return '\n'
    case 'img': {
      const alt = squash(attr(n, 'alt') ?? '')
      if (!alt) return ''
      return inLink ? alt : `[imagem: ${alt}]`
    }
    case 'a': {
      const text = squash(inline(n.childNodes, ctx, true)) || squash(attr(n, 'aria-label') ?? '')
      const href = attr(n, 'href')
      const abs = href ? resolveHref(href, ctx) : null
      if (!text) return ''
      // espaços em volta do link vêm dos nós de texto (o HTML já os tem)
      const raw = rawText(n)
      const lead = /^\s/.test(raw) ? ' ' : ''
      const trail = /\s$/.test(raw) ? ' ' : ''
      if (!abs || inLink) return `${lead}${text}${trail}`
      if (text === abs || text === abs.replace(/\/$/, '')) return `${lead}${abs}${trail}`
      return `${lead}[${escLinkText(text)}](${abs.replace(/\)/g, '%29').replace(/ /g, '%20')})${trail}`
    }
    case 'math': {
      const alt = squash(attr(n, 'alttext') ?? '') || squash(rawText(n))
      return alt ? `\`${alt}\`` : ''
    }
    case 'code':
    case 'kbd':
    case 'samp':
    case 'tt': {
      const t = rawText(n).replace(/\s+/g, ' ')
      if (!t.trim()) return ''
      const fence = t.includes('`') ? '``' : '`'
      return `${fence}${t.trim()}${fence}`
    }
    case 'strong':
    case 'b':
      return wrapMark('**', inline(n.childNodes, ctx, inLink))
    case 'em':
    case 'i':
    case 'cite':
      return wrapMark('*', inline(n.childNodes, ctx, inLink))
    case 'del':
    case 's':
    case 'strike':
      return wrapMark('~~', inline(n.childNodes, ctx, inLink))
    case 'pre':
      return ` ${rawText(n).replace(/\s+/g, ' ')} `
    default:
      if (BLOCK_TAGS.has(tag)) return ` ${inline(n.childNodes, ctx, inLink)} `
      return inline(n.childNodes, ctx, inLink)
  }
}

/** Limpa uma linha de texto inline (espaços, espaço antes de pontuação). */
function tidy(s: string): string {
  return s
    .split('\n')
    .map((l) => l.replace(/[ \t\u00a0]+/g, ' ').trim())
    .filter((l, i, a) => l || (i > 0 && a[i - 1]))
    .join('\n')
    .trim()
}

/** Quebra parágrafos muito longos (read_file corta linhas > 2000 chars) em fronteira de palavra. */
function wrapLong(s: string, width = 900): string {
  return s
    .split('\n')
    .map((line) => {
      if (line.length <= width) return line
      const out: string[] = []
      let cur = ''
      for (const w of line.split(' ')) {
        if (cur && cur.length + 1 + w.length > width) {
          out.push(cur)
          cur = w
        } else cur = cur ? `${cur} ${w}` : w
      }
      if (cur) out.push(cur)
      return out.join('\n')
    })
    .join('\n')
}

function codeLang(el: Element): string {
  const own = attr(el, 'class') ?? ''
  const code = find(el, (e) => e.tagName === 'code')
  const cls = `${own} ${code ? (attr(code, 'class') ?? '') : ''} ${attr(el, 'data-lang') ?? ''}`
  const m = /(?:^|\s)(?:language|lang|highlight-source|highlight)-([\w+#.-]+)/.exec(cls)
  if (m) return m[1]
  const d = attr(el, 'data-lang') ?? attr(el, 'data-language')
  return d && /^[\w+#.-]+$/.test(d) ? d : ''
}

function renderPre(el: Element): string {
  const text = rawText(el)
    .replace(/\r\n?/g, '\n')
    .replace(/^\n+|\s+$/g, '')
  if (!text) return ''
  let fence = '```'
  while (text.includes(fence)) fence += '`'
  return `${fence}${codeLang(el)}\n${text}\n${fence}`
}

function cellText(cell: Element, ctx: Ctx): string {
  return tidy(inline(cell.childNodes, ctx)).replace(/\n+/g, ' ').replace(/\|/g, '\\|')
}

function tableRows(table: Element): { cells: Element[]; head: boolean }[] {
  const rows: { cells: Element[]; head: boolean }[] = []
  const visit = (n: Element, inHead: boolean): void => {
    for (const c of n.childNodes) {
      if (!isEl(c)) continue
      if (c.tagName === 'tr') {
        const cells = c.childNodes.filter(
          (x): x is Element => isEl(x) && (x.tagName === 'td' || x.tagName === 'th')
        )
        rows.push({
          cells,
          head: inHead || (cells.length > 0 && cells.every((x) => x.tagName === 'th'))
        })
      } else if (c.tagName === 'thead') visit(c, true)
      else if (c.tagName === 'tbody' || c.tagName === 'tfoot') visit(c, false)
    }
  }
  visit(table, false)
  return rows
}

function renderTable(table: Element, ctx: Ctx): Block[] {
  const rows = tableRows(table)
  const layout =
    rows.length === 0 ||
    rows.every((r) => r.cells.length <= 1) ||
    !!find(table, (e) => e.tagName === 'table')
  if (layout) {
    // tabela de layout: conteúdo das células como blocos
    const out: Block[] = []
    for (const r of rows) for (const c of r.cells) out.push(...blocks(c, ctx))
    return out
  }
  // grade com colspan/rowspan (rowspan repete o valor: cada linha se lê sozinha)
  const grid: string[][] = []
  const carry: { text: string; left: number }[] = []
  for (const r of rows) {
    const line: string[] = []
    let col = 0
    const take = (): void => {
      while (carry[col] && carry[col].left > 0) {
        line.push(carry[col].text)
        carry[col].left--
        col++
      }
    }
    for (const cell of r.cells) {
      take()
      const text = cellText(cell, ctx)
      const span = Math.min(50, Math.max(1, Number(attr(cell, 'colspan')) || 1))
      const rs = Math.min(500, Math.max(1, Number(attr(cell, 'rowspan')) || 1))
      for (let k = 0; k < span; k++) {
        line.push(k === 0 ? text : '')
        if (rs > 1) carry[col] = { text: k === 0 ? text : '', left: rs - 1 }
        col++
      }
    }
    take()
    grid.push(line)
  }
  const width = Math.max(...grid.map((l) => l.length))
  if (width === 0) return []
  const pad = (l: string[]): string[] => [...l, ...Array(width - l.length).fill('')]
  const fmtRow = (l: string[]): string => `| ${pad(l).join(' | ')} |`
  const headIdx = rows[0]?.head ? 0 : -1
  const header = headIdx === 0 ? grid[0] : Array(width).fill('')
  const body = headIdx === 0 ? grid.slice(1) : grid
  const lines = [
    fmtRow(header),
    `|${Array(width).fill('---').join('|')}|`,
    ...body.filter((l) => l.some((c) => c)).map(fmtRow)
  ]
  const caption = find(table, (e) => e.tagName === 'caption')
  const cap = caption ? tidy(inline(caption.childNodes, ctx)) : ''
  const out: Block[] = []
  if (cap) out.push({ kind: 'p', md: `**${cap}**` })
  out.push({ kind: 'table', md: lines.join('\n') })
  return out
}

function renderList(el: Element, ctx: Ctx): string {
  const ordered = el.tagName === 'ol'
  let n = Math.floor(Number(attr(el, 'start'))) || 1
  const items: string[] = []
  for (const c of el.childNodes) {
    let body: string
    if (isEl(c) && c.tagName === 'li') {
      body = blocks(c, ctx)
        .map((b) => b.md)
        .join('\n')
    } else if (isEl(c) && (c.tagName === 'ul' || c.tagName === 'ol')) {
      // lista aninhada solta (HTML inválido comum): indenta junto ao item anterior
      const nested = renderList(c, ctx)
      if (nested && items.length) items[items.length - 1] += `\n${nested.replace(/^/gm, '  ')}`
      continue
    } else if (isText(c) && c.value.trim()) {
      body = tidy(c.value)
    } else continue
    if (!body.trim()) continue
    const marker = ordered ? `${n++}. ` : '- '
    const indent = ' '.repeat(marker.length)
    items.push(marker + body.replace(/\n/g, `\n${indent}`))
  }
  return items.join('\n')
}

function renderDl(el: Element, ctx: Ctx): string {
  const out: string[] = []
  let terms: string[] = []
  const items = el.childNodes.flatMap((c) => (isEl(c) && c.tagName === 'div' ? c.childNodes : [c]))
  for (const c of items) {
    if (!isEl(c)) continue
    if (c.tagName === 'dt') terms.push(tidy(inline(c.childNodes, ctx)))
    else if (c.tagName === 'dd') {
      const def = blocks(c, ctx)
        .map((b) => b.md)
        .join(' ')
      const t = terms.filter(Boolean).join(' / ')
      out.push(t ? `- **${t}**: ${def}` : `  ${def}`)
      terms = []
    }
  }
  for (const t of terms) if (t) out.push(`- **${t}**`)
  return out.join('\n')
}

function blocks(root: Element, ctx: Ctx): Block[] {
  const out: Block[] = []
  let buf: Node[] = []
  const flush = (): void => {
    if (!buf.length) return
    const md = tidy(inline(buf, ctx))
    buf = []
    if (md) out.push({ kind: 'p', md: wrapLong(md) })
  }
  for (const c of root.childNodes) {
    if (!isEl(c) || !BLOCK_TAGS.has(c.tagName)) {
      buf.push(c)
      continue
    }
    flush()
    const tag = c.tagName
    if (/^h[1-6]$/.test(tag)) {
      const t = tidy(inline(c.childNodes, ctx)).replace(/\n+/g, ' ')
      if (t) out.push({ kind: 'h', md: `${'#'.repeat(Number(tag[1]))} ${t}` })
    } else if (tag === 'p') {
      const t = tidy(inline(c.childNodes, ctx))
      if (t) out.push({ kind: 'p', md: wrapLong(t) })
    } else if (tag === 'hr') out.push({ kind: 'hr', md: '---' })
    else if (tag === 'pre') {
      const t = renderPre(c)
      if (t) out.push({ kind: 'code', md: t })
    } else if (tag === 'ul' || tag === 'ol' || tag === 'menu') {
      const t = renderList(c, ctx)
      if (t) out.push({ kind: 'list', md: t })
    } else if (tag === 'dl') {
      const t = renderDl(c, ctx)
      if (t) out.push({ kind: 'list', md: t })
    } else if (tag === 'table') out.push(...renderTable(c, ctx))
    else if (tag === 'blockquote') {
      const inner = blocks(c, ctx)
        .map((b) => b.md)
        .join('\n\n')
      if (inner) out.push({ kind: 'quote', md: inner.replace(/^/gm, '> ') })
    } else if (tag === 'summary' || tag === 'figcaption' || tag === 'legend' || tag === 'caption') {
      const t = tidy(inline(c.childNodes, ctx))
      if (t) out.push({ kind: 'p', md: tag === 'figcaption' ? `*${t}*` : `**${t}**` })
    } else out.push(...blocks(c, ctx))
  }
  flush()
  return out
}

/** Junta blocos, tira repetidos (consecutivos; parágrafos curtos que se repetem ≥ 3 vezes). */
function joinBlocks(list: Block[]): string {
  const count = new Map<string, number>()
  for (const b of list)
    if (b.kind === 'p' && b.md.length < 80) count.set(b.md, (count.get(b.md) ?? 0) + 1)
  const seen = new Set<string>()
  const out: string[] = []
  let prev = ''
  for (const b of list) {
    if (b.md === prev) continue
    if (b.kind === 'p' && (count.get(b.md) ?? 0) >= 3) {
      if (seen.has(b.md)) continue
      seen.add(b.md)
    }
    out.push(b.md)
    prev = b.md
  }
  return out
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function toMarkdown(root: Element, ctx: Ctx): string {
  return joinBlocks(blocks(root, ctx))
}

// ---------------- metadados ----------------

interface Meta {
  title: string
  description?: string
  canonical?: string
  published?: string
  modified?: string
  base?: string
  structured: string[]
}

const short = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

function asArray<V>(v: V | V[] | undefined | null): V[] {
  return v == null ? [] : Array.isArray(v) ? v : [v]
}

function nameOf(v: unknown): string {
  if (typeof v === 'string') return v
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    if (typeof o.name === 'string') return o.name
  }
  return ''
}

function typesOf(o: Record<string, unknown>): string[] {
  return asArray(o['@type'] as string | string[]).filter((t): t is string => typeof t === 'string')
}

const AVAIL: Record<string, string> = {
  InStock: 'em estoque',
  OutOfStock: 'esgotado',
  PreOrder: 'pré-venda',
  BackOrder: 'sob encomenda',
  LimitedAvailability: 'estoque limitado',
  SoldOut: 'esgotado',
  Discontinued: 'descontinuado',
  OnlineOnly: 'só online',
  InStoreOnly: 'só na loja'
}

function offerText(v: unknown): string {
  const parts: string[] = []
  for (const o of asArray(v as Record<string, unknown> | Record<string, unknown>[])) {
    if (!o || typeof o !== 'object') continue
    const cur = typeof o.priceCurrency === 'string' ? ` ${o.priceCurrency}` : ''
    let price = ''
    if (o.price != null && o.price !== '') price = `${String(o.price)}${cur}`
    else if (o.lowPrice != null)
      price = `${String(o.lowPrice)}${o.highPrice != null ? `–${String(o.highPrice)}` : ''}${cur}`
    const spec = o.priceSpecification as Record<string, unknown> | undefined
    if (!price && spec && spec.price != null)
      price = `${String(spec.price)}${typeof spec.priceCurrency === 'string' ? ` ${spec.priceCurrency}` : cur}`
    const av = typeof o.availability === 'string' ? o.availability.replace(/^.*\//, '') : ''
    const name = typeof o.name === 'string' ? `${o.name}: ` : ''
    if (price || av) parts.push(`${name}${price || '?'}${av ? ` (${AVAIL[av] ?? av})` : ''}`)
    if (parts.length >= 6) break
  }
  return parts.join('; ')
}

function ldLine(o: Record<string, unknown>): string | null {
  const types = typesOf(o)
  const is = (...t: string[]): boolean => types.some((x) => t.includes(x))
  const bits: string[] = []
  if (is('Product', 'SoftwareApplication', 'Book', 'Course', 'Service', 'Vehicle')) {
    const name = nameOf(o.name)
    if (name) bits.push(`"${short(name, 120)}"`)
    const offers = offerText(o.offers)
    if (offers) bits.push(`preço ${offers}`)
    const brand = nameOf(o.brand)
    if (brand) bits.push(`marca ${short(brand, 60)}`)
    if (typeof o.sku === 'string') bits.push(`sku ${o.sku}`)
    const r = o.aggregateRating as Record<string, unknown> | undefined
    if (r && r.ratingValue != null)
      bits.push(
        `nota ${String(r.ratingValue)}${r.bestRating != null ? `/${String(r.bestRating)}` : ''}${r.reviewCount != null || r.ratingCount != null ? ` (${String(r.reviewCount ?? r.ratingCount)} avaliações)` : ''}`
      )
    return bits.length ? `${types[0]}: ${bits.join(' · ')}` : null
  }
  if (is('Offer', 'AggregateOffer')) {
    const t = offerText(o)
    return t ? `${types[0]}: ${t}` : null
  }
  if (is('Article', 'NewsArticle', 'BlogPosting', 'TechArticle', 'Report', 'ScholarlyArticle')) {
    const h = typeof o.headline === 'string' ? o.headline : nameOf(o.name)
    if (h) bits.push(`"${short(h, 160)}"`)
    const authors = asArray(o.author).map(nameOf).filter(Boolean)
    if (authors.length) bits.push(`por ${short(authors.join(', '), 120)}`)
    if (typeof o.datePublished === 'string') bits.push(`publicado ${o.datePublished}`)
    if (typeof o.dateModified === 'string') bits.push(`atualizado ${o.dateModified}`)
    return bits.length ? `${types[0]}: ${bits.join(' · ')}` : null
  }
  if (is('Event')) {
    const name = nameOf(o.name)
    if (name) bits.push(`"${short(name, 120)}"`)
    if (typeof o.startDate === 'string') bits.push(`início ${o.startDate}`)
    const loc = nameOf(o.location)
    if (loc) bits.push(`local ${short(loc, 80)}`)
    const offers = offerText(o.offers)
    if (offers) bits.push(`ingressos ${offers}`)
    return bits.length ? `Event: ${bits.join(' · ')}` : null
  }
  if (is('FAQPage')) {
    const n = asArray(o.mainEntity).length
    return n ? `FAQPage: ${n} pergunta(s)` : null
  }
  return null
}

function parseLd(text: string): unknown[] {
  const clean = text
    .trim()
    .replace(/^<!\[CDATA\[|\]\]>$/g, '')
    .replace(/^\s*\/\/.*$/gm, '')
  try {
    return asArray(JSON.parse(clean) as unknown)
  } catch {
    return []
  }
}

function flattenLd(items: unknown[], out: Record<string, unknown>[], depth = 0): void {
  if (depth > 4) return
  for (const it of items) {
    if (!it || typeof it !== 'object') continue
    const o = it as Record<string, unknown>
    if (Array.isArray(o['@graph'])) flattenLd(o['@graph'] as unknown[], out, depth + 1)
    if (o['@type']) out.push(o)
    // Product aninhado em WebPage.mainEntity etc.
    const me = o.mainEntity
    if (me && typeof me === 'object' && !Array.isArray(me)) flattenLd([me], out, depth + 1)
  }
}

function readMeta(doc: T.Document): Meta {
  const meta: Meta = { title: '', structured: [] }
  const metas = new Map<string, string>()
  const ld: Record<string, unknown>[] = []
  for (const e of elements(doc)) {
    const tag = e.tagName
    if (tag === 'title' && !meta.title && e.namespaceURI === 'http://www.w3.org/1999/xhtml')
      meta.title = squash(rawText(e))
    else if (tag === 'meta') {
      const key = (
        attr(e, 'property') ??
        attr(e, 'name') ??
        attr(e, 'itemprop') ??
        ''
      ).toLowerCase()
      const content = attr(e, 'content')
      if (key && content && !metas.has(key)) metas.set(key, squash(content))
    } else if (tag === 'link') {
      const rel = (attr(e, 'rel') ?? '').toLowerCase().split(/\s+/)
      if (rel.includes('canonical') && attr(e, 'href') && !meta.canonical)
        meta.canonical = attr(e, 'href')
    } else if (tag === 'base' && attr(e, 'href') && !meta.base) meta.base = attr(e, 'href')
    else if (tag === 'script' && (attr(e, 'type') ?? '').toLowerCase() === 'application/ld+json')
      flattenLd(parseLd(rawText(e)), ld)
  }
  if (!meta.title) meta.title = metas.get('og:title') ?? ''
  meta.description =
    metas.get('description') ?? metas.get('og:description') ?? metas.get('twitter:description')
  meta.published =
    metas.get('article:published_time') ??
    metas.get('datepublished') ??
    metas.get('date') ??
    metas.get('dc.date') ??
    metas.get('dcterms.created')
  meta.modified =
    metas.get('article:modified_time') ??
    metas.get('og:updated_time') ??
    metas.get('datemodified') ??
    metas.get('last-modified') ??
    metas.get('dcterms.modified')
  const seen = new Set<string>()
  for (const o of ld) {
    const line = ldLine(o)
    if (line && !seen.has(line)) {
      seen.add(line)
      meta.structured.push(short(line, 400))
    }
    if (!meta.published && typeof o.datePublished === 'string') meta.published = o.datePublished
    if (!meta.modified && typeof o.dateModified === 'string') meta.modified = o.dateModified
    if (meta.structured.length >= 8) break
  }
  const amount = metas.get('product:price:amount') ?? metas.get('og:price:amount')
  if (amount && !meta.structured.some((l) => l.includes('preço'))) {
    const cur = metas.get('product:price:currency') ?? metas.get('og:price:currency') ?? ''
    meta.structured.push(`Preço (meta): ${amount}${cur ? ` ${cur}` : ''}`)
  }
  return meta
}

// ---------------- links ----------------

function collectLinks(root: Element, ctx: Ctx, max: number): PageLink[] {
  const seen = new Set<string>()
  const out: PageLink[] = []
  for (const e of elements(root)) {
    if (e.tagName !== 'a') continue
    const href = attr(e, 'href')
    const abs = href ? resolveHref(href, ctx) : null
    if (!abs || !/^https?:/.test(abs) || seen.has(abs)) continue
    const text = short(
      squash(inline(e.childNodes, ctx, true)) ||
        squash(attr(e, 'aria-label') ?? attr(e, 'title') ?? ''),
      120
    )
    if (!text) continue
    seen.add(abs)
    out.push({ text, href: abs })
    if (out.length >= max) break
  }
  return out
}

// ---------------- API ----------------

const textLen = (md: string): number =>
  squash(md.replace(/\]\([^)]*\)/g, ']').replace(/[#*`|>[\]-]+/g, ' ')).length

/** HTML (renderizado) → página extraída. `url` = URL final (base dos links relativos). */
export function extractPage(html: string, url: string, opts: ExtractOptions = {}): ExtractedPage {
  const mode: ExtractMode = opts.mode === 'full' ? 'full' : 'main'
  const doc = parse(html)
  const meta = readMeta(doc)
  let base: URL
  try {
    base = new URL(meta.base ?? url, url)
  } catch {
    base = new URL('about:blank')
  }
  const ctx: Ctx = { base, pageUrl: url }
  const body =
    find(doc, (e) => e.tagName === 'body') ??
    ({
      nodeName: 'body',
      tagName: 'body',
      attrs: [],
      namespaceURI: 'http://www.w3.org/1999/xhtml',
      parentNode: null,
      childNodes: []
    } as unknown as Element)
  baseClean(body)
  const fullMd = toMarkdown(body, ctx)
  const pageChars = textLen(fullMd)
  const links = opts.links ? collectLinks(body, ctx, opts.maxLinks ?? 150) : undefined

  let markdown: string
  let strategy: ExtractedPage['strategy']
  let via: string
  let reason: string | undefined
  if (mode === 'full') {
    markdown = fullMd
    strategy = 'full'
    via = 'página inteira'
  } else {
    stripBoilerplate(body)
    const pick = pickMain(body)
    if ('root' in pick) {
      markdown = toMarkdown(pick.root, ctx)
      strategy = 'main'
      via = pick.via
    } else {
      markdown = toMarkdown(body, ctx)
      strategy = 'fallback'
      via = 'página sem menus'
      reason = pick.fail
    }
    // nunca devolve menos que o menu: se a limpeza comeu tudo, volta à página inteira
    if (!markdown.trim() && fullMd.trim()) {
      markdown = fullMd
      strategy = 'fallback'
      via = 'página inteira'
      reason = 'a limpeza de menus não deixou texto'
    }
  }
  let canonical: string | undefined
  if (meta.canonical) {
    try {
      canonical = new URL(meta.canonical, base).href
    } catch {
      /* ignora */
    }
  }
  return {
    title: meta.title,
    url,
    canonical,
    description: meta.description,
    published: meta.published,
    modified: meta.modified,
    structured: meta.structured,
    markdown,
    mode,
    strategy,
    via,
    reason,
    pageChars,
    contentChars: textLen(markdown),
    links
  }
}

export interface FormatInfo {
  timedOut?: boolean
  timeoutS?: number
  fromCache?: boolean
  /** Legado (antes da saída em arquivo): posição em caracteres do corpo. */
  offset?: number
}

/** Texto devolvido ao modelo (cabeçalho + Markdown + links). Grande → arquivo (runToolImpl). */
export function formatExtracted(p: ExtractedPage, info: FormatInfo = {}): string {
  const head: string[] = [`# ${p.title || '(sem título)'}`, `URL: ${p.url}`]
  if (p.canonical && p.canonical !== p.url) head.push(`Canônica: ${p.canonical}`)
  if (p.description) head.push(`Descrição: ${short(p.description, 400)}`)
  const dates = [
    p.published && `publicado ${short(p.published, 40)}`,
    p.modified && p.modified !== p.published && `atualizado ${short(p.modified, 40)}`
  ].filter(Boolean)
  if (dates.length) head.push(`Data: ${dates.join(' · ')}`)
  if (p.structured.length)
    head.push(`Dados estruturados:\n${p.structured.map((l) => `- ${l}`).join('\n')}`)
  if (info.timedOut)
    head.push(
      `[aviso: a página não terminou de carregar em ${info.timeoutS ?? 25}s; conteúdo parcial]`
    )
  const cached = info.fromCache ? ' (do cache, sem recarregar)' : ''
  if (p.strategy === 'main')
    head.push(
      `[conteúdo principal (${p.via}): ${fmtNum(p.contentChars)} de ${fmtNum(p.pageChars)} caracteres de texto da página — menus, cabeçalho, rodapé e barras laterais omitidos; use mode="full" para a página inteira${cached}]`
    )
  else if (p.strategy === 'fallback')
    head.push(
      `[conteúdo principal não identificado com segurança (${p.reason ?? 'sem bloco principal'}) — mostrando a página inteira sem menus (${fmtNum(p.contentChars)} de ${fmtNum(p.pageChars)} caracteres); use mode="full" para incluir os menus${cached}]`
    )
  else
    head.push(
      `[página inteira (mode="full"), menus e rodapé inclusos: ${fmtNum(p.pageChars)} caracteres de texto${cached}]`
    )
  let body = p.markdown || '(página sem texto visível)'
  const off = Math.max(0, Math.floor(info.offset ?? 0))
  if (off > 0) {
    head.push(
      off >= body.length
        ? `[offset=${off} passa do fim do texto (${fmtNum(body.length)} caracteres)]`
        : `[a partir do caractere ${fmtNum(off + 1)} de ${fmtNum(body.length)}]`
    )
    body = body.slice(off)
  }
  const links =
    p.links && p.links.length
      ? `\n\n## Links da página\n${p.links.map((l) => `- [${escLinkText(l.text)}](${l.href})`).join('\n')}`
      : ''
  return `${head.join('\n')}\n\n${body}${links}`
}
