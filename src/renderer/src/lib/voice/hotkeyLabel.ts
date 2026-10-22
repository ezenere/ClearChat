// Formatação de hotkeys do push-to-talk para exibição e captura de tecla (funções PURAS, sem DOM):
// `'Ctrl+Shift+Space'` → `'Ctrl + Shift + Espaço'` (rótulo) e evento de teclado → hotkey canônica
// gravável em `audioInput.pttKey`. Testado em `e2e/voiceDictation.test.ts`.
import { parseHotkey, type HotkeyEvent } from '../audio/hotkey'

/** Nome legível (pt-BR) das teclas especiais; o resto segue o próprio nome. */
const KEY_LABELS: Record<string, string> = {
  space: 'Espaço',
  escape: 'Esc',
  enter: 'Enter',
  tab: 'Tab',
  backspace: 'Backspace',
  delete: 'Delete',
  insert: 'Insert',
  home: 'Home',
  end: 'End',
  pageup: 'Page Up',
  pagedown: 'Page Down',
  arrowup: '↑',
  arrowdown: '↓',
  arrowleft: '←',
  arrowright: '→'
}

/** Nome gravável da tecla (parseável por `parseHotkey`): 'Space', 'F8', 'K', 'Enter'… */
function keyToken(name: string): string {
  if (/^f\d{1,2}$/.test(name)) return name.toUpperCase()
  if (name.length === 1) return name.toUpperCase()
  const special: Record<string, string> = {
    space: 'Space',
    escape: 'Esc',
    enter: 'Enter',
    tab: 'Tab',
    backspace: 'Backspace',
    delete: 'Delete',
    insert: 'Insert',
    home: 'Home',
    end: 'End',
    pageup: 'Page Up',
    pagedown: 'Page Down',
    arrowup: 'Up',
    arrowdown: 'Down',
    arrowleft: 'Left',
    arrowright: 'Right'
  }
  return special[name] ?? name.charAt(0).toUpperCase() + name.slice(1)
}

/**
 * Rótulo de exibição de uma hotkey salva ('Ctrl+Shift+Space' → 'Ctrl + Shift + Espaço').
 * Ordem canônica dos modificadores: Ctrl, Shift, Alt, Meta. Hotkey vazia/nula/inválida → ''
 * (inválida devolve o texto cru, sem inventar rótulo).
 */
export function formatHotkeyLabel(hotkey: string | null | undefined): string {
  if (typeof hotkey !== 'string' || !hotkey.trim()) return ''
  const parsed = parseHotkey(hotkey)
  if (!parsed) return hotkey.trim()
  const parts: string[] = []
  if (parsed.ctrl) parts.push('Ctrl')
  if (parsed.shift) parts.push('Shift')
  if (parsed.alt) parts.push('Alt')
  if (parsed.meta) parts.push('Meta')
  parts.push(KEY_LABELS[parsed.key] ?? keyToken(parsed.key))
  return parts.join(' + ')
}

/**
 * Hotkey canônica a partir de um evento de teclado (captura de tecla na Configurações):
 * 'Ctrl+Shift+Space', 'F8', 'Alt+K'… Modificador solto (só Ctrl/Shift/Alt/Meta) → `null`
 * (a captura espera a tecla principal).
 */
export function hotkeyFromEvent(event: HotkeyEvent): string | null {
  const raw = event.key ?? ''
  // ' ' (espaço) não pode passar pelo trim
  const key = raw === ' ' ? ' ' : raw.trim()
  if (!key) return null
  const mods: string[] = []
  if (event.ctrlKey) mods.push('Ctrl')
  if (event.shiftKey) mods.push('Shift')
  if (event.altKey) mods.push('Alt')
  if (event.metaKey) mods.push('Meta')
  // 'Control'/'Shift'/'Alt'/'Meta' sozinhos ainda não são hotkey
  if (/^(control|shift|alt|meta|altgraph|capslock)$/i.test(key)) return null
  const lower = key.toLowerCase()
  const name =
    lower === ' ' || lower === 'spacebar'
      ? 'Space'
      : lower === 'esc'
        ? 'Esc'
        : lower === 'return'
          ? 'Enter'
          : /^f\d{1,2}$/.test(lower)
            ? lower.toUpperCase()
            : key.length === 1
              ? key.toUpperCase()
              : keyToken(lower)
  return [...mods, name].join('+')
}
