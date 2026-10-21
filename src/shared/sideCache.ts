// Cache do prompt nas chamadas laterais (juiz do Smart-Approve e resumidor da coleta de contexto).
// Função pura (main monta a request; o renderer mostra o body exato no (i)).
// Ver SPEC.md → "Parâmetros por modelo → Chamadas laterais → Cache do prompt".
//
// Até 2 breakpoints `cache_control: {type: "ephemeral"}` por chamada: (1) fim do system prompt e (2)
// fim da parte estável da mensagem user — onde o template tem o marcador {{cache_break}} (renderiza
// para nada). Sem marcador: só o system. Cache desligado ou provedor sem `cache_control` → o body de
// sempre (strings, sem divisão).
import type { ProviderKind } from './providerKinds'
import type { ContentPart } from './types'

/** Placeholder invisível do 2º breakpoint (juiz e resumidor). */
export const CACHE_BREAK_KEY = 'cache_break'

/** Descrição do marcador para a lista de placeholders (opcional). */
export const CACHE_BREAK_PLACEHOLDER = {
  key: CACHE_BREAK_KEY,
  desc: 'opcional, invisível: fim da parte estável da mensagem — com “Cache do prompt”, o que vem antes é cacheado (2º breakpoint; sem ele, só o system)'
}

/** Valor do placeholder na renderização: um separador que não aparece em texto normal. */
export const CACHE_BREAK_SENTINEL = '\u0000cache_break\u0000'

/** Mensagem de uma chamada lateral: texto completo + onde termina a parte estável (opcional). */
export interface SideMessage {
  role: 'system' | 'user'
  content: string
  /** Índice em `content` onde termina o prefixo estável (2º breakpoint); ausente = sem marcador. */
  cacheAt?: number
}

/**
 * Texto renderizado (com CACHE_BREAK_SENTINEL no lugar de {{cache_break}}) → mensagem sem o
 * separador + `cacheAt` (1ª ocorrência). Prefixo ou resto vazio (só espaços) = sem breakpoint.
 */
export function sideMessage(role: SideMessage['role'], rendered: string): SideMessage {
  const at = rendered.indexOf(CACHE_BREAK_SENTINEL)
  const content = rendered.split(CACHE_BREAK_SENTINEL).join('')
  if (at < 0) return { role, content }
  const head = content.slice(0, at)
  const tail = content.slice(at)
  return head.trim() && tail.trim() ? { role, content, cacheAt: at } : { role, content }
}

/**
 * O provedor/modelo recebe `cache_control`? Anthropic nativa: sempre. OpenRouter: modelos
 * Anthropic e Gemini (o mesmo formato de parts do chat principal — applyCacheBreakpoints);
 * os demais (OpenAI, DeepSeek…) fazem cache automático do prefixo → strings. openai genérico: não.
 */
export function sideCacheable(kind: ProviderKind, model: string): boolean {
  if (kind === 'anthropic') return true
  if (kind === 'openrouter') return /^(anthropic|google)\//i.test(model.trim())
  return false
}

export type SideWireMessage = { role: 'system' | 'user'; content: string | ContentPart[] }

const EPHEMERAL = { type: 'ephemeral' } as const

/**
 * Mensagens como vão no fio. Cache ligado + provedor que aceita: system → 1 text part com
 * `cache_control`; user com `cacheAt` → [parte estável com `cache_control`, resto]. Senão (ou cache
 * desligado): as strings de sempre. No máximo 2 breakpoints (a Anthropic aceita 4).
 */
export function sideWireMessages(
  messages: SideMessage[],
  opts: { cache: boolean; kind: ProviderKind; model: string }
): SideWireMessage[] {
  const on = opts.cache && sideCacheable(opts.kind, opts.model)
  return messages.map((m) => {
    if (!on) return { role: m.role, content: m.content }
    if (m.role === 'system')
      return m.content
        ? { role: 'system', content: [{ type: 'text', text: m.content, cache_control: EPHEMERAL }] }
        : { role: 'system', content: m.content }
    if (m.cacheAt === undefined) return { role: m.role, content: m.content }
    return {
      role: m.role,
      content: [
        { type: 'text', text: m.content.slice(0, m.cacheAt), cache_control: EPHEMERAL },
        { type: 'text', text: m.content.slice(m.cacheAt) }
      ]
    }
  })
}

/** Nota para o "Ver request" (vazia = nada marcado). */
export function sideCacheNote(wire: SideWireMessage[]): string {
  let n = 0
  let split = false
  for (const m of wire)
    if (Array.isArray(m.content)) {
      n += m.content.filter((p) => p.cache_control).length
      if (m.role === 'user') split = true
    }
  if (!n) return ''
  return `Cache do prompt: cache_control em ${n} ponto${n > 1 ? 's' : ''} (fim do system${split ? ' e da parte estável da mensagem, no {{cache_break}}' : ''}).`
}
