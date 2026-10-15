import type { ApiMessage, ContentPart, ModelInfo, Session } from '@shared/types'
import { contentText } from '@shared/attachments'

export { clsx as cn } from 'clsx'

/** Texto da mensagem (parts de anexo ficam de fora). */
export function messageText(content: string | ContentPart[] | null | undefined): string {
  return contentText(content)
}

/**
 * Substitui o texto de uma mensagem preservando o formato (string vs. content parts) e os anexos:
 * os parts de anexo ficam intactos (mesma ordem) e o texto digitado vira um único text part no fim.
 */
export function withText(message: ApiMessage, text: string): ApiMessage {
  if (message.role === 'tool' && typeof message.content === 'string')
    return { ...message, content: text }
  if (message.role === 'assistant') return { ...message, content: text }
  if (typeof message.content === 'string') return { ...message, content: text }
  const parts = message.content
  const attachments = parts.filter((p) => p._attachment)
  if (!attachments.length) {
    if (parts.length === 0) return { ...message, content: text }
    const first = parts.find((p) => p.type === 'text') ?? { type: 'text' as const, text: '' }
    return { ...message, content: [{ ...first, text } as ContentPart] }
  }
  // tool (read_file de imagem/PDF): texto primeiro, como foi gravado
  if (message.role === 'tool')
    return { ...message, content: [{ type: 'text', text }, ...attachments] }
  const next: ContentPart[] = [...attachments]
  if (text.trim()) next.push({ type: 'text', text })
  return { ...message, content: next }
}

export function formatTokens(n: number | undefined): string {
  if (n == null) return '–'
  if (n < 1000) return String(n)
  if (n < 10_000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k'
  if (n < 1_000_000) return Math.round(n / 1000) + 'k'
  return (n / 1_000_000).toFixed(2).replace(/\.?0+$/, '') + 'M'
}

export function formatCost(cost: number | undefined): string | null {
  if (cost == null) return null
  if (cost === 0) return '$0'
  if (cost < 0.0001) return '<$0.0001'
  if (cost < 0.01) return '$' + cost.toFixed(4)
  return '$' + cost.toFixed(3)
}

export function formatDuration(ms: number | undefined): string | null {
  if (ms == null) return null
  if (ms < 1000) return `${ms}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  return `${Math.floor(s / 60)}m${Math.round(s % 60)}s`
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/**
 * Preço por 1M tokens. Provedores (ex.: OpenRouter) informam preço por token; se o valor já
 * parecer "por milhão" (≥ 0.01) é usado como está.
 */
export function pricePerMillion(p: number | undefined): string | null {
  if (p == null || Number.isNaN(p) || p < 0) return null
  const perM = p < 0.01 ? p * 1_000_000 : p
  if (perM === 0) return 'grátis'
  return '$' + (perM < 1 ? perM.toFixed(2) : perM.toFixed(perM < 10 ? 2 : 1)).replace(/\.00$/, '')
}

export function modelMeta(m: ModelInfo): string[] {
  const out: string[] = []
  if (m.contextLength) out.push(`${formatTokens(m.contextLength)} ctx`)
  const ip = pricePerMillion(m.promptPrice)
  const op = pricePerMillion(m.completionPrice)
  if (ip === 'grátis' && op === 'grátis') out.push('grátis')
  else if (ip || op) out.push(`${ip ?? '–'} / ${op ?? '–'} por 1M`)
  return out
}

export function relativeTime(ts: number): string {
  const diff = Date.now() - ts
  const min = Math.floor(diff / 60000)
  if (min < 1) return 'agora'
  if (min < 60) return `${min} min`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h} h`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d} d`
  return new Date(ts).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' })
}

export function prettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}

export function shortPath(path: string, home: string | null): string {
  if (home && path.startsWith(home)) return '~' + path.slice(home.length)
  return path
}

/** shortPath + elisão no início quando longo: "…/projetos/app/src" (o fim é o que importa). */
export function compactPath(path: string, home: string | null, max = 44): string {
  const p = shortPath(path, home)
  if (p.length <= max) return p
  const segs = p.split('/')
  let out = segs.pop() ?? p
  while (segs.length && out.length + segs[segs.length - 1].length + 3 <= max) {
    out = `${segs.pop()}/${out}`
  }
  return `…/${out}`
}

export const isMac = typeof navigator !== 'undefined' && /Mac/.test(navigator.userAgent)

export function sessionLabel(s: Session): string {
  return s.depth === 0 ? 'Principal' : s.title || s.task?.slice(0, 40) || 'Subagente'
}
