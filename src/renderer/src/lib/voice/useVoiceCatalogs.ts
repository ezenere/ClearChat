// Catálogos de modelos/vozes de TODOS os provedores de voz de uma capacidade (Configurações →
// Áudio): o seletor de modelo é o mesmo do chat (`ModelPicker`, agrupado por provedor), então cada
// provedor tem a sua listagem (`voice.catalog.list` — o main busca e guarda em cache por 10 min; a
// chave nunca vem para cá). `load(id)` é idempotente (não refaz o que já carregou/está carregando);
// `load(id, true)` ignora o cache ("Recarregar"/"tentar de novo"). `stateFor(id)` dá a visão de um
// provedor no formato do antigo `useVoiceCatalog` (aviso de modelo lento, correção de apelido…).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { VoiceCapability, VoiceCatalogView } from '@shared/voiceCatalog'
import { api, errorMessage } from '../api'

export interface VoiceCatalogEntry {
  status: 'loading' | 'ok' | 'error'
  catalog: VoiceCatalogView | null
  /** Falha do próprio IPC (a falha da listagem vem em `catalog.error`). */
  error: string | null
}

export interface VoiceCatalogState {
  /** null = carregando, sem provedor ou API sem `catalog`. */
  catalog: VoiceCatalogView | null
  loading: boolean
  error: string | null
  reload: (refresh?: boolean) => void
}

export interface VoiceCatalogs {
  entries: Record<string, VoiceCatalogEntry | undefined>
  load: (providerId: string, force?: boolean) => void
  stateFor: (providerId: string | null) => VoiceCatalogState
}

export function useVoiceCatalogs(
  capability: VoiceCapability,
  /** Provedor atual: carregado já (o resto carrega ao abrir o seletor). */
  currentId: string | null
): VoiceCatalogs {
  const [entries, setEntries] = useState<Record<string, VoiceCatalogEntry | undefined>>({})
  const inflight = useRef(new Map<string, number>())
  const loaded = useRef(new Set<string>())
  const seq = useRef(0)

  const load = useCallback(
    (providerId: string, force = false) => {
      const catalogApi = api.voice?.catalog
      if (!catalogApi || !providerId) return
      if (!force && (inflight.current.has(providerId) || loaded.current.has(providerId))) return
      const my = ++seq.current
      inflight.current.set(providerId, my)
      setEntries((e) => ({
        ...e,
        [providerId]: { status: 'loading', catalog: e[providerId]?.catalog ?? null, error: null }
      }))
      void catalogApi
        .list({ capability, providerId, refresh: force })
        .then((catalog) => {
          if (inflight.current.get(providerId) !== my) return
          inflight.current.delete(providerId)
          loaded.current.add(providerId)
          setEntries((e) => ({
            ...e,
            [providerId]: {
              status: catalog.models.length || !catalog.error ? 'ok' : 'error',
              catalog,
              error: null
            }
          }))
        })
        .catch((err) => {
          if (inflight.current.get(providerId) !== my) return
          inflight.current.delete(providerId)
          loaded.current.add(providerId)
          setEntries((e) => ({
            ...e,
            [providerId]: { status: 'error', catalog: null, error: errorMessage(err) }
          }))
        })
    },
    [capability]
  )

  useEffect(() => {
    if (currentId) load(currentId)
  }, [currentId, load])

  const stateFor = useCallback(
    (providerId: string | null): VoiceCatalogState => {
      const e = providerId ? entries[providerId] : undefined
      return {
        catalog: e?.catalog ?? null,
        loading: !!providerId && !!api.voice?.catalog && (!e || e.status === 'loading'),
        error: e?.error ?? null,
        reload: (refresh = false) => providerId && load(providerId, refresh)
      }
    },
    [entries, load]
  )

  return useMemo(() => ({ entries, load, stateFor }), [entries, load, stateFor])
}
