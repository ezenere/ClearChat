// Cards-âncora da conversa aberta (ver lib/approvalAnchors.ts): um tracker por janela — só existe
// uma lista de mensagens na tela por vez; as chaves levam o id da sessão.
import { useEffect, useRef, type RefObject } from 'react'
import { useStore } from '../store'
import { AnchorTracker } from './approvalAnchors'

export const anchorTracker = new AnchorTracker((patch) => useStore.getState().setAnchorVis(patch))

/** Registra o elemento como âncora `id` enquanto montado (id null = não registra). */
export function useAnchor<T extends Element>(id: string | null): RefObject<T | null> {
  const ref = useRef<T>(null)
  useEffect(() => {
    const el = ref.current
    if (!el || !id) return
    anchorTracker.add(el, id)
    return () => anchorTracker.remove(el)
  }, [id])
  return ref
}

/** Usa o scroller da lista como raiz do IntersectionObserver. */
export function useAnchorRoot(ref: RefObject<Element | null>): void {
  useEffect(() => {
    const el = ref.current
    if (!el) return
    anchorTracker.attach(el)
    return () => anchorTracker.detach()
  }, [ref])
}
