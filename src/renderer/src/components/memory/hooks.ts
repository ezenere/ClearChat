// Hooks de dados da memória (coleções do store, preview da sessão).
import { useEffect, useState } from 'react'
import type { MemoryCollection, MemoryPreview } from '@shared/memory'
import { api } from '../../lib/api'
import { useStore } from '../../store'

/** Coleções de memória do store (carrega na primeira montagem; `memory-changed` recarrega). */
export function useMemoryCollections(): MemoryCollection[] {
  const cols = useStore((s) => s.memoryCollections)
  const load = useStore((s) => s.loadMemoryCollections)
  useEffect(() => {
    void load()
  }, [load])
  return cols
}

/**
 * O que a memória manda na próxima request da sessão (`memory.preview`). Recarrega quando `deps`
 * muda (config de memória) — depois de salvar o patch pendente (o main lê a config do banco) — e a
 * cada `memory-changed`.
 */
export function useMemoryPreview(
  chatId: string | null,
  sessionId: string | null,
  deps: string
): { preview: MemoryPreview | null; reload: () => void; setPreview: (p: MemoryPreview) => void } {
  const tick = useStore((s) => s.memoryTick)
  const flushConfig = useStore((s) => s.flushConfig)
  const [preview, setPreview] = useState<MemoryPreview | null>(null)
  const [nonce, setNonce] = useState(0)
  useEffect(() => {
    if (!sessionId || !chatId) return
    let alive = true
    const t = setTimeout(() => {
      void (async () => {
        try {
          await flushConfig(chatId)
          const p = await api.memory.preview(sessionId)
          if (alive) setPreview(p)
        } catch {
          /* preview indisponível: o (i) mostra a regra calculada na UI */
        }
      })()
    }, 250)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [chatId, sessionId, deps, tick, nonce, flushConfig])
  return { preview, reload: () => setNonce((n) => n + 1), setPreview }
}
