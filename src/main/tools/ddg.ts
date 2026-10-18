// Parse do HTML de https://html.duckduckgo.com/html/ (puro, sem Electron).

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  laquo: '«',
  raquo: '»',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“'
}

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code =
        e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : m
    }
    return ENTITIES[e.toLowerCase()] ?? m
  })
}

const stripTags = (s: string): string =>
  decodeEntities(s.replace(/<[^>]*>/g, ''))
    .replace(/\s+/g, ' ')
    .trim()

/** `//duckduckgo.com/l/?uddg=https%3A%2F%2F…&rut=…` → URL real. */
export function unwrapDdgUrl(href: string): string {
  let h = decodeEntities(href)
  if (h.startsWith('//')) h = 'https:' + h
  try {
    const u = new URL(h, 'https://duckduckgo.com')
    const real = u.searchParams.get('uddg')
    if (real) return real
    return u.toString()
  } catch {
    return h
  }
}

export interface SearchResult {
  title: string
  url: string
  snippet: string
  /** Data de publicação curta (AAAA-MM-DD ou "2 days ago"), quando o buscador informa. */
  date?: string
}

export function parseDdgHtml(html: string): SearchResult[] {
  const results: SearchResult[] = []
  const blocks = html.split(/<div[^>]+class="[^"]*\bresult\b[^"]*"/i).slice(1)
  for (const b of blocks) {
    if (/result--ad\b/.test(b.slice(0, 300)) || /badge--ad/.test(b)) continue
    const a =
      /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i.exec(b) ??
      /<a[^>]*href="([^"]*)"[^>]*class="[^"]*result__a[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(b)
    if (!a) continue
    const url = unwrapDdgUrl(a[1])
    if (/duckduckgo\.com\/y\.js/.test(url)) continue
    const sn = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|td)>/i.exec(b)
    const r = { title: stripTags(a[2]), url, snippet: sn ? stripTags(sn[1]) : '' }
    if (r.title && !results.some((x) => x.url === r.url)) results.push(r)
  }
  return results
}
