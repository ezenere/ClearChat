import { useEffect, useLayoutEffect, useRef } from 'react'

// ---- Pilha de camadas: Esc fecha só a mais recente (popover > modal) ----
const stack: { id: number; close: () => void }[] = []
let seq = 0
let listening = false

function onKey(e: KeyboardEvent): void {
  if (e.key !== 'Escape' || stack.length === 0) return
  e.preventDefault()
  e.stopPropagation()
  stack[stack.length - 1].close()
}

export function useEscapeLayer(active: boolean, close: () => void): void {
  const closeRef = useRef(close)
  useLayoutEffect(() => {
    closeRef.current = close
  })
  useEffect(() => {
    if (!active) return
    if (!listening) {
      window.addEventListener('keydown', onKey, true)
      listening = true
    }
    const id = ++seq
    stack.push({ id, close: () => closeRef.current() })
    return () => {
      const i = stack.findIndex((l) => l.id === id)
      if (i >= 0) stack.splice(i, 1)
    }
  }, [active])
}
