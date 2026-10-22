// Parse e casamento de hotkeys do push-to-talk (funções puras, sem DOM) — testado em
// `e2e/audio.test.ts`. Formato aceito: modificadores + tecla, separados por '+', case-insensitive:
// 'Ctrl+Shift+Space', 'F8', 'Alt+K', 'Meta+Enter' etc.

/** Estado relevante de um evento de teclado (compatível com `KeyboardEvent`). */
export interface HotkeyEvent {
  key: string
  code?: string
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  metaKey: boolean
}

/** Hotkey parseada: modificadores explícitos + nome normalizado da tecla. */
export interface Hotkey {
  ctrl: boolean
  shift: boolean
  alt: boolean
  meta: boolean
  key: string
}

const MODIFIER_ALIASES: Record<string, 'ctrl' | 'shift' | 'alt' | 'meta'> = {
  ctrl: 'ctrl',
  control: 'ctrl',
  shift: 'shift',
  alt: 'alt',
  option: 'alt',
  meta: 'meta',
  cmd: 'meta',
  command: 'meta',
  win: 'meta',
  super: 'meta'
}

// Aliases de tecla → nome normalizado (comparação sempre minúscula/aparada).
const KEY_ALIASES: Record<string, string> = {
  ' ': 'space',
  spacebar: 'space',
  esc: 'escape',
  del: 'delete',
  ins: 'insert',
  return: 'enter',
  up: 'arrowup',
  down: 'arrowdown',
  left: 'arrowleft',
  right: 'arrowright'
}

/** Normaliza o nome de uma tecla (minúsculas, aliases aplicados). */
function normalizeKeyName(name: string): string {
  const s = name.trim().toLowerCase()
  return KEY_ALIASES[s] ?? s
}

/** Nome normalizado da tecla de um evento (`key`, com fallback no `code` quando inútil). */
function eventKeyName(event: HotkeyEvent): string {
  const key = normalizeKeyName(event.key ?? '')
  if (key && key !== 'unidentified') return key
  // Fallback pelo code: 'KeyK' → 'k', 'Digit1' → '1', 'Space' → 'space', 'F8' → 'f8'.
  const code = normalizeKeyName(event.code ?? '')
  if (code.startsWith('key')) return code.slice(3)
  if (code.startsWith('digit')) return code.slice(5)
  return code
}

/**
 * Faz o parse de uma hotkey no formato `'Ctrl+Shift+Space'` / `'F8'` (case-insensitive).
 * Modificadores aceitos: Ctrl/Control, Shift, Alt/Option, Meta/Cmd/Command/Win/Super.
 * Devolve `null` para hotkey vazia, sem tecla, com tecla '+' literal ou com partes inválidas
 * (ex.: duas teclas, ou um modificador como tecla final).
 */
export function parseHotkey(hotkey: string | null | undefined): Hotkey | null {
  if (typeof hotkey !== 'string') return null
  const parts = hotkey
    .split('+')
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
  if (parts.length === 0) return null
  const parsed: Hotkey = { ctrl: false, shift: false, alt: false, meta: false, key: '' }
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i].toLowerCase()
    const mod = MODIFIER_ALIASES[part]
    const isLast = i === parts.length - 1
    if (mod) {
      // Modificador só vale fora da posição final ('Ctrl+Shift' sem tecla não é hotkey).
      if (isLast) return null
      parsed[mod] = true
      continue
    }
    // Fora da posição final só aceitamos modificadores (uma tecla só, por fim).
    if (!isLast) return null
    parsed.key = normalizeKeyName(parts[i])
    if (!parsed.key) return null
  }
  return parsed.key ? parsed : null
}

/**
 * Verifica se um evento de teclado corresponde à hotkey (casamento exato também nos modificadores:
 * `'Ctrl+Space'` NÃO casa com Ctrl+Shift+Space). Hotkey inválida/nula → `false`.
 */
export function matchesHotkey(event: HotkeyEvent, hotkey: string | null | undefined): boolean {
  const parsed = parseHotkey(hotkey)
  if (!parsed) return false
  return (
    parsed.ctrl === !!event.ctrlKey &&
    parsed.shift === !!event.shiftKey &&
    parsed.alt === !!event.altKey &&
    parsed.meta === !!event.metaKey &&
    parsed.key === eventKeyName(event)
  )
}
