// Estado aberto/fechado das seções recolhíveis (CollapsibleSection), lembrado por id em
// localStorage (`clearchat.collapse.<id>` = '1' aberta / '0' fechada; ausente → padrão da seção).
// O mesmo id vale no painel e no editor de personas (os editores são os mesmos). Instâncias
// montadas ao mesmo tempo ficam em sincronia (`subscribeCollapse` + useSyncExternalStore no
// componente). Sem React aqui (testado em e2e/unit.test.ts).

export const COLLAPSE_KEY_PREFIX = 'clearchat.collapse.'

const listeners = new Set<() => void>()
/** Cache da leitura (undefined = ainda não lido; null = sem preferência). */
const cache = new Map<string, boolean | null>()

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

/** Preferência salva da seção (null = nunca mexida → usa o padrão dela). */
export function readCollapse(id: string): boolean | null {
  if (cache.has(id)) return cache.get(id) ?? null
  let raw: string | null | undefined
  try {
    raw = storage()?.getItem(COLLAPSE_KEY_PREFIX + id)
  } catch {
    raw = null
  }
  const v = raw === '1' ? true : raw === '0' ? false : null
  cache.set(id, v)
  return v
}

/** Grava aberta/fechada e avisa as instâncias montadas. */
export function writeCollapse(id: string, open: boolean): void {
  cache.set(id, open)
  try {
    storage()?.setItem(COLLAPSE_KEY_PREFIX + id, open ? '1' : '0')
  } catch {
    /* sem storage (janela privada, preview): vale só nesta sessão */
  }
  for (const l of listeners) l()
}

/** Esquece o cache (testes / outra janela mudou o storage). */
export function resetCollapseCache(): void {
  cache.clear()
  for (const l of listeners) l()
}

/** Avisa quando alguma preferência muda (para useSyncExternalStore). */
export function subscribeCollapse(l: () => void): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}
