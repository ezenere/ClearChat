// Barra que recolhe os itens por prioridade (cabeçalho do chat, barra do composer). A ordem e os
// níveis ficam em lib/responsiveBar.ts; aqui só a medida e o contexto.
//
// Marcação dentro do contêiner medido:
//  - `data-bar-item="<id>"` + `data-bar-level` na raiz de cada item recolhível (use barAttrs);
//    um item no nível "some" continua no DOM (vazio) para a medida não oscilar;
//  - `data-bar-spacer`: o espaço livre (flex-1) — a folga da barra;
//  - `data-bar-clip`: elementos com overflow cortado — o que passa da borda é déficit;
//  - `data-bar-title`: o título (trunca por último: os itens recolhem até ele ter TITLE_WANT px).
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState
} from 'react'
import {
  BAR_ITEMS,
  planCollapse,
  type BarItemId,
  type BarLevel,
  type BarPlanItem,
  type BarWidths
} from './responsiveBar'

export type BarLevels = Partial<Record<BarItemId, BarLevel>>

/** Largura que o título tenta manter antes de os itens pararem de recolher. */
export const TITLE_WANT = 240

/** Níveis da barra em volta (`<BarLevelsContext.Provider value={levels}>`). */
export const BarLevelsContext = createContext<BarLevels | null>(null)

/** Nível do item na barra em volta (fora de uma barra: completo). */
export function useBarLevel(id: BarItemId): BarLevel {
  return useContext(BarLevelsContext)?.[id] ?? 0
}

/** Atributos de medida da raiz de um item. */
export function barAttrs(
  id: BarItemId,
  level: BarLevel
): { 'data-bar-item': BarItemId; 'data-bar-level': BarLevel } {
  return { 'data-bar-item': id, 'data-bar-level': level }
}

function same(a: BarLevels, b: BarLevels): boolean {
  const ka = Object.keys(a) as BarItemId[]
  if (ka.length !== Object.keys(b).length) return false
  return ka.every((k) => a[k] === b[k])
}

/**
 * Mede o contêiner (ref de callback) e devolve o nível de cada item. Mede a cada render do dono, a
 * cada mudança de tamanho do contêiner e a cada mudança no DOM de dentro (itens que aparecem,
 * rótulos que mudam). A largura de cada nível já renderizado fica em cache; os outros são
 * estimados e corrigidos na medida seguinte (layout effect — sem pintar o estado intermediário).
 */
export function useBarCollapse<T extends HTMLElement>(): [(el: T | null) => void, BarLevels] {
  const [el, setEl] = useState<T | null>(null)
  const [levels, setLevels] = useState<BarLevels>({})
  const cache = useRef(new Map<BarItemId, BarWidths>())
  const current = useRef<BarLevels>({})

  const measure = useCallback(() => {
    if (!el || !el.isConnected) return
    const items: BarPlanItem[] = []
    let used = 0
    for (const node of el.querySelectorAll<HTMLElement>('[data-bar-item]')) {
      const id = node.dataset.barItem as BarItemId
      if (!(id in BAR_ITEMS) || items.some((i) => i.id === id)) continue
      const level = Number(node.dataset.barLevel ?? 0) as BarLevel
      const w = node.offsetWidth
      const widths = { ...cache.current.get(id), [level]: w }
      cache.current.set(id, widths)
      used += w
      items.push({ id, widths })
    }
    let free = 0
    for (const sp of el.querySelectorAll<HTMLElement>('[data-bar-spacer]')) free += sp.offsetWidth
    const clips = [...el.querySelectorAll<HTMLElement>('[data-bar-clip]')]
    if (el.hasAttribute('data-bar-clip')) clips.push(el)
    for (const c of clips) free -= Math.max(0, c.scrollWidth - c.clientWidth)
    const title = el.querySelector<HTMLElement>('[data-bar-title]')
    if (title) free -= Math.max(0, Math.min(title.scrollWidth, TITLE_WANT) - title.clientWidth)
    const next = planCollapse(items, used + free)
    if (!same(next, current.current)) {
      current.current = next
      setLevels(next)
    }
  }, [el])

  // a cada render do dono (props/estado novos)
  useLayoutEffect(() => {
    measure()
  })

  useEffect(() => {
    if (!el) return
    let frame = 0
    const schedule = (): void => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        measure()
      })
    }
    const ro = new ResizeObserver(schedule)
    ro.observe(el)
    const mo = new MutationObserver(schedule)
    mo.observe(el, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['class', 'data-bar-level']
    })
    return () => {
      ro.disconnect()
      mo.disconnect()
      if (frame) cancelAnimationFrame(frame)
    }
  }, [el, measure])

  return [setEl, levels]
}
