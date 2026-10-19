// Hooks de dados das skills (descoberta via IPC; `skills-changed` recarrega).
import { useEffect, useState } from 'react'
import type { SkillsDiscovery, SkillsSettings } from '@shared/skills'
import { api, errorMessage } from '../../lib/api'
import { useStore } from '../../store'

/**
 * Descoberta das skills (locais globais + projeto de `cwd`). `counts` conta os arquivos
 * (Configurações). Recarrega com `skills-changed`, com `cwd` e com `reload()`.
 */
export function useSkillsDiscovery(
  cwd: string | null | undefined,
  opts: { counts?: boolean; enabled?: boolean } = {}
): {
  disc: SkillsDiscovery | null
  error: string | null
  loading: boolean
  reload: (rescan?: boolean) => void
} {
  const tick = useStore((s) => s.skillsTick)
  const [disc, setDisc] = useState<SkillsDiscovery | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [nonce, setNonce] = useState<{ n: number; rescan: boolean }>({ n: 0, rescan: false })
  const enabled = opts.enabled !== false
  useEffect(() => {
    if (!enabled) return
    let alive = true
    // eslint-disable-next-line react-hooks/set-state-in-effect -- indicador de carregamento
    setLoading(true)
    api.skills
      .discover({ cwd: cwd ?? null, counts: !!opts.counts, rescan: nonce.rescan })
      .then((d) => {
        if (!alive) return
        setDisc(d)
        setError(null)
      })
      .catch((e) => alive && setError(errorMessage(e)))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [cwd, opts.counts, enabled, tick, nonce])
  return {
    disc,
    error,
    loading,
    reload: (rescan = false) => setNonce((x) => ({ n: x.n + 1, rescan }))
  }
}

/** Settings globais das skills (locais + projeto). */
export function useSkillsSettings(): {
  settings: SkillsSettings | null
  update: (patch: Partial<SkillsSettings>) => Promise<void>
} {
  const tick = useStore((s) => s.skillsTick)
  const run = useStore((s) => s.run)
  const [settings, setSettings] = useState<SkillsSettings | null>(null)
  useEffect(() => {
    let alive = true
    void api.skills.getSettings().then((s) => alive && setSettings(s))
    return () => {
      alive = false
    }
  }, [tick])
  return {
    settings,
    update: async (patch) => {
      const next = await run(() => api.skills.updateSettings(patch), 'Erro ao salvar as skills')
      if (next) setSettings(next)
    }
  }
}
