// Catálogo de modelos/vozes do provedor escolhido em Configurações → Áudio (`voice.catalog.list` —
// o main busca e guarda em cache por 10 min; a chave nunca vem para cá). `reload(true)` ignora o
// cache ("Atualizar"/"Tentar de novo").
import { useCallback, useEffect, useRef, useState } from 'react'
import type { VoiceCapability, VoiceCatalogView } from '@shared/voiceCatalog'
import { api, errorMessage } from '../api'

export interface VoiceCatalogState {
  /** null = carregando, desligado ou API sem `catalog`. */
  catalog: VoiceCatalogView | null
  loading: boolean
  /** Falha do próprio IPC (a falha da listagem vem em `catalog.error`). */
  error: string | null
  reload: (refresh?: boolean) => void
}

interface Result {
  key: string
  catalog: VoiceCatalogView | null
  error: string | null
}

export function useVoiceCatalog(
  capability: VoiceCapability,
  providerId: string | null,
  /** false = não buscar (ex.: modo local) — evita requests à toa. */
  enabled: boolean,
  /** Muda quando o endpoint personalizado muda (refaz a busca com `providerId: null`). */
  customKey = ''
): VoiceCatalogState {
  const key = `${capability}|${providerId ?? ''}|${customKey}`
  const [result, setResult] = useState<Result | null>(null)
  /** "Atualizar" em voo para esta chave (a 1ª busca é o "sem resultado ainda"). */
  const [refreshing, setRefreshing] = useState<string | null>(null)
  const seq = useRef(0)

  // sem setState síncrono: o efeito só dispara a busca; os estados chegam na resposta
  const fetchCatalog = useCallback(
    (refresh: boolean) => {
      const catalogApi = api.voice?.catalog
      if (!enabled || !catalogApi) return
      const my = ++seq.current
      void catalogApi
        .list({ capability, providerId, refresh })
        .then((c) => {
          if (my !== seq.current) return
          setResult({ key, catalog: c, error: null })
          setRefreshing(null)
        })
        .catch((e) => {
          if (my !== seq.current) return
          setResult({ key, catalog: null, error: errorMessage(e) })
          setRefreshing(null)
        })
    },
    [capability, providerId, enabled, key]
  )

  useEffect(() => {
    fetchCatalog(false)
  }, [fetchCatalog])

  const reload = useCallback(
    (refresh = false) => {
      if (!enabled || !api.voice?.catalog) return
      setRefreshing(key)
      fetchCatalog(refresh)
    },
    [enabled, key, fetchCatalog]
  )

  // resultado de outro provedor/endpoint não vale para o atual
  const mine = enabled && result?.key === key ? result : null
  return {
    catalog: mine?.catalog ?? null,
    loading: enabled && !!api.voice?.catalog && (result?.key !== key || refreshing === key),
    error: mine?.error ?? null,
    reload
  }
}
