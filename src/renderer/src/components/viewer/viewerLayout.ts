// Layout do painel de arquivo (larguras, medida) e degraus de zoom — fora dos componentes.
import { useLayoutEffect, useState } from 'react'

export const VIEWER_MIN_WIDTH = 280

// ---------------- zoom ----------------

const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5]

/** Próximo degrau de zoom (dir = +1 / -1). */
export function stepZoom(z: number, dir: 1 | -1): number {
  if (dir > 0) return ZOOM_STEPS.find((s) => s > z + 0.001) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1]
  return [...ZOOM_STEPS].reverse().find((s) => s < z - 0.001) ?? ZOOM_STEPS[0]
}

/** Largura mínima que o chat mantém ao lado do painel de arquivo. */
export const CHAT_MIN_WIDTH = 380

/** Mede a largura de um elemento (ResizeObserver; ref de callback — o elemento pode aparecer depois). */
export function useWidth<T extends HTMLElement>(): [(el: T | null) => void, number] {
  const [el, setEl] = useState<T | null>(null)
  const [w, setW] = useState(0)
  useLayoutEffect(() => {
    if (!el) return
    // o ResizeObserver entrega a medida inicial logo ao observar
    const ro = new ResizeObserver(() => setW(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [el])
  return [setEl, w]
}
