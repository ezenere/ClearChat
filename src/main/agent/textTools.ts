// Modo sem tools nativas: parse de <tool_call>{"name": "...", "arguments": {...}}</tool_call> no texto.
// Tolerante a erros comuns de modelos fracos: `<tool_call{...}`, tag de fechamento ausente,
// cercas ```json e chaves extras no fim.

export interface TextToolCall {
  name: string
  args: Record<string, unknown>
  raw: string
  error?: string
}

/** Extrai o primeiro objeto JSON balanceado a partir de `start` (respeitando strings). */
function balancedObject(s: string, start: number): { json: string; end: number } | null {
  const i0 = s.indexOf('{', start)
  if (i0 === -1) return null
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = i0; i < s.length; i++) {
    const c = s[i]
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') inStr = true
    else if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return { json: s.slice(i0, i + 1), end: i + 1 }
    }
  }
  return null
}

/**
 * Fallback: a resposta inteira é só o objeto JSON da chamada, sem as tags (erro comum de modelos
 * pequenos), opcionalmente em cerca ```json. Só aceita se `name` for uma tool conhecida.
 */
function bareJsonCall(content: string, known?: readonly string[]): TextToolCall | null {
  const t = content
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim()
  if (!t.startsWith('{') || !t.endsWith('}')) return null
  try {
    const v = JSON.parse(t) as { name?: unknown; arguments?: unknown }
    if (typeof v.name !== 'string' || !(known ?? []).includes(v.name)) return null
    let args = v.arguments ?? {}
    if (typeof args === 'string') args = args.trim() ? JSON.parse(args) : {}
    if (!args || typeof args !== 'object' || Array.isArray(args)) return null
    return { name: v.name, args: args as Record<string, unknown>, raw: t }
  } catch {
    return null
  }
}

export function parseTextToolCalls(content: string, known?: readonly string[]): TextToolCall[] {
  if (!/<tool_call/.test(content)) {
    const bare = bareJsonCall(content, known)
    return bare ? [bare] : []
  }
  const out: TextToolCall[] = []
  const re = /<tool_call>?/g
  let m: RegExpExecArray | null
  while ((m = re.exec(content))) {
    const after = m.index + m[0].length
    const close = content.indexOf('</tool_call>', after)
    const nextOpen = content.indexOf('<tool_call', after)
    const limit = [close, nextOpen]
      .filter((x) => x !== -1)
      .reduce((a, b) => Math.min(a, b), content.length)
    const segment = content.slice(after, limit)
    const obj = balancedObject(segment, 0)
    re.lastIndex = close !== -1 && close === limit ? close + '</tool_call>'.length : limit
    if (!obj) {
      out.push({
        name: '',
        args: {},
        raw: segment.trim(),
        error: 'JSON ausente ou incompleto em <tool_call>.'
      })
      continue
    }
    const raw = obj.json
    try {
      const v = JSON.parse(raw) as { name?: unknown; arguments?: unknown; parameters?: unknown }
      const name = typeof v.name === 'string' ? v.name : ''
      let args = v.arguments ?? v.parameters ?? {}
      if (typeof args === 'string') args = args.trim() ? JSON.parse(args) : {}
      if (!name) out.push({ name: '', args: {}, raw, error: 'Campo "name" ausente.' })
      else if (!args || typeof args !== 'object' || Array.isArray(args))
        out.push({ name, args: {}, raw, error: '"arguments" deve ser um objeto JSON.' })
      else out.push({ name, args: args as Record<string, unknown>, raw })
    } catch (e) {
      out.push({
        name: '',
        args: {},
        raw,
        error: `JSON inválido em <tool_call>: ${(e as Error).message}`
      })
    }
  }
  return out
}

export function formatTextToolResult(name: string, content: string): string {
  return `<tool_result name="${name || 'desconhecida'}">\n${content}\n</tool_result>`
}
