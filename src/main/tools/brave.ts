// Parse do HTML de https://search.brave.com/search?q=… (puro, sem Electron).
// A página é SSR (SvelteKit): cada resultado é um `<div class="snippet …" data-type="…">`.
// Só `data-type="web"` é resultado orgânico — vídeos/notícias/discussões vêm como `cluster`
// (ou outros tipos), "Find elsewhere", "Related queries", resumo de IA, infobox e paginação
// são `.snippet` com `id` e sem `data-type="web"`, e ficam de fora.
import { decodeEntities, type SearchResult } from './ddg'

const stripTags = (s: string): string =>
  decodeEntities(
    s
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<(script|style|svg)\b[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]*>/g, ' ')
  )
    .replace(/\s+/g, ' ')
    .trim()

/** Links do próprio Brave (ex.: `/a/redirect?url=…`) → URL real; links internos sem destino → null. */
export function unwrapBraveUrl(href: string): string | null {
  let u: URL
  try {
    u = new URL(decodeEntities(href), 'https://search.brave.com')
  } catch {
    return null
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  if (/(^|\.)brave\.com$/i.test(u.hostname) && /^(search|imgs|cdn)\./i.test(u.hostname)) {
    for (const k of ['url', 'u', 'target', 'q_url']) {
      const real = u.searchParams.get(k)
      if (real && /^https?:\/\//i.test(real)) return real
    }
    return null
  }
  return u.toString()
}

/** Primeira classe que contém `title` com atributo title="…" (o título completo, sem corte). */
function titleOf(block: string, anchorInner: string): string {
  const attr =
    /<[a-z]+[^>]*class="[^"]*\b(?:search-snippet-title|snippet-title|title)\b[^"]*"[^>]*\btitle="([^"]*)"/i.exec(
      block
    ) ?? /<[a-z]+[^>]*\btitle="([^"]*)"[^>]*class="[^"]*\btitle\b[^"]*"/i.exec(block)
  if (attr && attr[1].trim()) return stripTags(attr[1])
  const inner =
    /<[a-z]+[^>]*class="[^"]*\b(?:search-snippet-title|snippet-title|title)\b[^"]*"[^>]*>([\s\S]*?)<\/(?:div|span|h\d|a)>/i.exec(
      block
    )
  if (inner && stripTags(inner[1])) return stripTags(inner[1])
  // Último recurso: texto do link sem o bloco de site/URL (cite).
  return stripTags(anchorInner.replace(/<cite\b[\s\S]*?<\/cite>/gi, ' '))
}

function snippetOf(block: string, afterAnchor: string): string {
  const generic =
    /class="[^"]*\bgeneric-snippet\b[^"]*"[^>]*>\s*(?:<!--[\s\S]*?-->\s*)*<div[^>]*class="[^"]*\bcontent\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(
      block
    ) ?? /class="[^"]*\bsnippet-description\b[^"]*"[^>]*>([\s\S]*?)<\/(?:div|p)>/i.exec(block)
  if (generic && stripTags(generic[1])) return stripTags(generic[1])
  const qa =
    /class="[^"]*\binline-qa-question\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(block) ??
    /class="[^"]*\binline-qa-answer\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(block)
  if (qa && stripTags(qa[1])) return stripTags(qa[1])
  // Fallback genérico: o texto que vem depois do link do título.
  return stripTags(afterAnchor).slice(0, 600)
}

export function parseBraveHtml(html: string): SearchResult[] {
  const results: SearchResult[] = []
  const parts = html.split(/(?=<div\b[^>]*\bclass="snippet\b)/i).slice(1)
  for (const b of parts) {
    const open = /^<div\b[^>]*>/i.exec(b)?.[0] ?? ''
    if (!/\bdata-type="web"/i.test(open)) continue
    if (/\b(?:ad|ads|sponsored)\b/i.test(/class="([^"]*)"/i.exec(open)?.[1] ?? '')) continue
    const a = /<a\b[^>]*\bhref="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(b)
    if (!a) continue
    const url = unwrapBraveUrl(a[1])
    if (!url) continue
    const title = titleOf(b, a[2])
    const snippet = snippetOf(b, b.slice(a.index + a[0].length))
    if (title && !results.some((x) => x.url === url)) results.push({ title, url, snippet })
  }
  return results
}

/**
 * Página de bloqueio do Brave (captcha / "flagged as being suspicious" / rate limit)?
 * Só olha o texto visível (o HTML normal contém "captcha" nas traduções embutidas).
 * Use só quando `parseBraveHtml` não achou resultados (um snippet pode falar de "rate limit").
 */
export function isBraveBlocked(html: string, status?: number): boolean {
  if (status === 429 || status === 403) return true
  const text = stripTags(html).slice(0, 5000)
  return /flagged as being suspicious|schedule a captcha|captcha|verify (?:that )?you are (?:a )?human|are you a robot|too many requests|rate.?limit/i.test(
    text
  )
}
