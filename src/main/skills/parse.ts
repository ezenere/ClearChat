// Parse do SKILL.md (puro, sem fs): frontmatter YAML + corpo markdown. YAML: o subconjunto usado
// nas skills — `chave: valor` (simples, entre aspas, bloco `|`/`>`, multilinha), listas (`- x` e
// `[a, b]`) e um nível de mapa (`metadata:`). Campos desconhecidos são guardados como texto
// (mostrados na UI e ignorados). Ver SPEC.md → "Skills" → Formato.
import { SKILL_LIMITS, type SkillMeta } from '@shared/skills'

export type YamlValue = string | string[] | Record<string, string>

export class YamlError extends Error {}

const KEY_RE = /^([A-Za-z0-9_][\w.-]*)\s*:(?:\s+(.*)|\s*)$/
const indentOf = (l: string): number => l.length - l.trimStart().length
const isBlank = (l: string): boolean => !l.trim() || /^\s*#/.test(l)

/** Remove comentário ` # …` de um escalar simples. */
const stripComment = (s: string): string => s.replace(/\s+#.*$/, '')

function unquote(raw: string, lineNo: number): string {
  const s = raw.trim()
  const q = s[0]
  if (q === '"' || q === "'") {
    // fecha na aspa correspondente (\" no duplo, '' no simples); depois só espaço/comentário
    let i = 1
    let out = ''
    for (; i < s.length; i++) {
      const c = s[i]
      if (q === '"' && c === '\\' && i + 1 < s.length) {
        const n = s[++i]
        out += n === 'n' ? '\n' : n === 't' ? '\t' : n === 'r' ? '\r' : n === '0' ? '\0' : n
        continue
      }
      if (c === q) {
        if (q === "'" && s[i + 1] === "'") {
          out += "'"
          i++
          continue
        }
        break
      }
      out += c
    }
    if (i >= s.length) throw new YamlError(`aspas não fechadas na linha ${lineNo}`)
    const rest = s.slice(i + 1)
    if (rest.trim() && !/^\s+#/.test(rest))
      throw new YamlError(`texto depois das aspas na linha ${lineNo}`)
    return out
  }
  return stripComment(s).trim()
}

function flowList(raw: string, lineNo: number): string[] {
  const inner = raw.trim().slice(1, -1)
  if (!inner.trim()) return []
  const out: string[] = []
  let cur = ''
  let q: string | null = null
  for (const ch of inner) {
    if (q) {
      cur += ch
      if (ch === q) q = null
    } else if (ch === '"' || ch === "'") {
      q = ch
      cur += ch
    } else if (ch === ',') {
      out.push(unquote(cur, lineNo))
      cur = ''
    } else cur += ch
  }
  if (q) throw new YamlError(`aspas não fechadas na linha ${lineNo}`)
  if (cur.trim()) out.push(unquote(cur, lineNo))
  return out
}

/** Bloco `|` / `>`: linhas mais indentadas que a chave (ou em branco), sem a indentação comum. */
function blockScalar(
  lines: string[],
  start: number,
  keyIndent: number,
  folded: boolean
): [string, number] {
  let i = start
  const body: string[] = []
  while (i < lines.length && (!lines[i].trim() || indentOf(lines[i]) > keyIndent)) {
    body.push(lines[i])
    i++
  }
  while (body.length && !body[body.length - 1].trim()) body.pop()
  const ind = Math.min(...body.filter((l) => l.trim()).map(indentOf), Infinity)
  const text = body.map((l) => (l.trim() ? l.slice(ind === Infinity ? 0 : ind) : ''))
  if (!folded) return [text.join('\n'), i]
  // dobrado: linhas consecutivas viram uma (espaço); linha em branco = quebra
  const out: string[] = []
  let para: string[] = []
  for (const l of text) {
    if (!l) {
      if (para.length) out.push(para.join(' '))
      para = []
      out.push('')
    } else para.push(l)
  }
  if (para.length) out.push(para.join(' '))
  return [out.join('\n').replace(/\n\n/g, '\n'), i]
}

/** Parse do subconjunto de YAML do frontmatter. Lança YamlError com a linha (1 = 1ª do frontmatter). */
export function parseYaml(src: string): Record<string, YamlValue> {
  const lines = src.split('\n')
  const out: Record<string, YamlValue> = {}
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (isBlank(line)) {
      i++
      continue
    }
    if (indentOf(line) > 0) throw new YamlError(`indentação inesperada na linha ${i + 1}`)
    const m = KEY_RE.exec(line)
    if (!m) throw new YamlError(`linha ${i + 1} inválida: "${line.slice(0, 60)}"`)
    const key = m[1]
    const raw = (m[2] ?? '').trim()
    const lineNo = i + 1
    i++
    if (/^[|>][+-]?\d*$/.test(raw)) {
      const [v, next] = blockScalar(lines, i, 0, raw.startsWith('>'))
      out[key] = v
      i = next
      continue
    }
    if (raw.startsWith('[')) {
      if (!stripComment(raw).trim().endsWith(']'))
        throw new YamlError(`lista não fechada na linha ${lineNo}`)
      out[key] = flowList(stripComment(raw).trim(), lineNo)
      continue
    }
    if (raw && !raw.startsWith('#')) {
      // escalar (aspas podem continuar nas linhas seguintes; simples multilinha é dobrado)
      let text = raw
      const quote = raw[0] === '"' || raw[0] === "'" ? raw[0] : null
      const closed = (t: string): boolean => {
        if (!quote) return true
        try {
          unquote(t, lineNo)
          return true
        } catch {
          return false
        }
      }
      while (
        i < lines.length &&
        lines[i].trim() &&
        indentOf(lines[i]) > 0 &&
        (quote ? !closed(text) : true)
      ) {
        if (!quote && /(^|\s)[^\s]*:(\s|$)/.test(lines[i].trim()))
          throw new YamlError(`indentação inesperada na linha ${i + 1}`)
        text += ' ' + lines[i].trim()
        i++
      }
      out[key] = unquote(text, lineNo)
      continue
    }
    // vazio: lista ou mapa nas linhas indentadas seguintes (ou valor vazio)
    let j = i
    while (j < lines.length && isBlank(lines[j])) j++
    if (j >= lines.length || indentOf(lines[j]) === 0) {
      out[key] = ''
      i = j
      continue
    }
    const childIndent = indentOf(lines[j])
    if (lines[j].trim().startsWith('- ') || lines[j].trim() === '-') {
      const list: string[] = []
      i = j
      while (i < lines.length && (isBlank(lines[i]) || indentOf(lines[i]) >= childIndent)) {
        const t = lines[i].trim()
        if (!t || t.startsWith('#')) {
          i++
          continue
        }
        if (indentOf(lines[i]) !== childIndent || !(t.startsWith('- ') || t === '-'))
          throw new YamlError(`item de lista inválido na linha ${i + 1}`)
        list.push(unquote(t.slice(1), i + 1))
        i++
      }
      out[key] = list
      continue
    }
    const map: Record<string, string> = {}
    i = j
    while (i < lines.length && (isBlank(lines[i]) || indentOf(lines[i]) >= childIndent)) {
      const t = lines[i]
      if (isBlank(t)) {
        i++
        continue
      }
      if (indentOf(t) !== childIndent)
        throw new YamlError(`indentação inesperada na linha ${i + 1}`)
      const mm = KEY_RE.exec(t.trim())
      if (!mm) throw new YamlError(`linha ${i + 1} inválida: "${t.trim().slice(0, 60)}"`)
      const v = (mm[2] ?? '').trim()
      map[mm[1]] = v.startsWith('[')
        ? flowList(stripComment(v), i + 1).join(', ')
        : unquote(v, i + 1)
      i++
    }
    out[key] = map
  }
  return out
}

/** `name` válido pela spec: a-z, 0-9 e hífens; sem hífen no início/fim nem duplo; ≤ 64. */
export function isSpecName(name: string): boolean {
  return (
    name.length >= 1 &&
    name.length <= SKILL_LIMITS.nameChars &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)
  )
}

const asText = (v: YamlValue): string =>
  typeof v === 'string' ? v : Array.isArray(v) ? v.join(', ') : JSON.stringify(v)

export interface ParsedSkill {
  meta: SkillMeta | null
  /** Corpo markdown (depois do frontmatter). */
  body: string
  /** SKILL.md normalizado (sem BOM, quebras LF) — o que vai ao modelo. */
  content: string
  warnings: string[]
  /** Inválida (não é oferecida ao modelo). */
  error?: string
}

/** Normaliza o texto do SKILL.md (BOM, CRLF/CR → LF). */
export const normalizeSkillText = (text: string): string =>
  text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')

/**
 * Parse de um SKILL.md. `dirName` = nome da pasta (nome efetivo se faltar `name`; aviso se diferir).
 * Erro (inválida): sem frontmatter, frontmatter não fechado ou YAML ruim, `name` não textual, sem
 * `description`. Avisos: sem `name` (usa a pasta), nome fora do padrão da spec / ≠ pasta, descrição
 * ou compatibility longas.
 */
export function parseSkillMd(text: string, dirName: string): ParsedSkill {
  const content = normalizeSkillText(text)
  const warnings: string[] = []
  const fail = (error: string): ParsedSkill => ({
    meta: null,
    body: content,
    content,
    warnings,
    error
  })
  const lines = content.split('\n')
  if (lines[0]?.trim() !== '---')
    return fail('SKILL.md sem frontmatter YAML (o arquivo deve começar com uma linha ---)')
  let end = -1
  for (let k = 1; k < lines.length; k++)
    if (lines[k].trim() === '---' || lines[k].trim() === '...') {
      end = k
      break
    }
  if (end === -1) return fail('frontmatter não fechado (falta a linha --- depois dos campos)')
  let fm: Record<string, YamlValue>
  try {
    fm = parseYaml(lines.slice(1, end).join('\n'))
  } catch (e) {
    return fail(`frontmatter YAML inválido: ${(e as Error).message}`)
  }
  const body = lines
    .slice(end + 1)
    .join('\n')
    .replace(/^\n+/, '')
  let name: string
  if (fm.name === undefined || fm.name === '') {
    name = dirName
    warnings.push(`sem "name" no frontmatter — usando o nome da pasta (${dirName})`)
  } else if (typeof fm.name !== 'string') {
    return fail('"name" do frontmatter precisa ser texto')
  } else {
    name = fm.name.trim()
    if (name !== dirName)
      warnings.push(`"name" (${name}) é diferente do nome da pasta (${dirName})`)
  }
  if (!isSpecName(name))
    warnings.push(
      `nome "${name}" fora do padrão da spec (até ${SKILL_LIMITS.nameChars} caracteres: a-z, 0-9 e hífens)`
    )
  const desc = fm.description
  if (desc === undefined || (typeof desc === 'string' && !desc.trim()))
    return fail(
      'sem "description" no frontmatter (obrigatória: é com ela que o modelo escolhe a skill)'
    )
  const description = asText(desc).trim()
  if (description.length > SKILL_LIMITS.descriptionChars)
    warnings.push(
      `"description" com ${description.length} caracteres (a spec recomenda até ${SKILL_LIMITS.descriptionChars})`
    )
  const meta: SkillMeta = { name, description }
  const other: Record<string, string> = {}
  for (const [k, v] of Object.entries(fm)) {
    if (k === 'name' || k === 'description') continue
    if (k === 'license') meta.license = asText(v)
    else if (k === 'compatibility') {
      meta.compatibility = asText(v)
      if (meta.compatibility.length > SKILL_LIMITS.compatibilityChars)
        warnings.push(`"compatibility" com mais de ${SKILL_LIMITS.compatibilityChars} caracteres`)
    } else if (k === 'allowed-tools') meta.allowedTools = Array.isArray(v) ? v.join(' ') : asText(v)
    else if (k === 'metadata' && v && typeof v === 'object' && !Array.isArray(v)) meta.metadata = v
    else other[k] = asText(v)
  }
  if (Object.keys(other).length) meta.other = other
  return { meta, body, content, warnings }
}
