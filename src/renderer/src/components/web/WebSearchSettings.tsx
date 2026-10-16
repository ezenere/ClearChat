// Configurações → Pesquisa na web: intervalo mínimo GLOBAL entre pesquisas do web_search
// (setting `webSearchMinIntervalSec`, lido pelo main a cada pesquisa).
import { useEffect, useRef, useState } from 'react'
import {
  normalizeSearchInterval,
  SEARCH_INTERVAL_DEFAULT_S,
  SEARCH_INTERVAL_MAX_S,
  SEARCH_INTERVAL_SETTING
} from '@shared/webSearchSettings'
import { api } from '../../lib/api'
import { useStore } from '../../store'
import { Label } from '../ui/controls'

export function WebSearchSettings(): React.JSX.Element {
  const run = useStore((s) => s.run)
  const [text, setText] = useState('')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    let alive = true
    void api.settings
      .get(SEARCH_INTERVAL_SETTING)
      .then((v) => alive && setText(String(normalizeSearchInterval(v))))
    return () => {
      alive = false
      if (timer.current) clearTimeout(timer.current)
    }
  }, [])

  const save = (raw: string, now = false): void => {
    if (timer.current) clearTimeout(timer.current)
    if (!raw.trim()) return
    const go = (): void =>
      void run(() => api.settings.set(SEARCH_INTERVAL_SETTING, normalizeSearchInterval(raw)))
    if (now) go()
    else timer.current = setTimeout(go, 400)
  }

  return (
    <div className="space-y-4" data-testid="web-search-settings">
      <div>
        <Label>Intervalo mínimo entre pesquisas (s)</Label>
        <input
          type="number"
          min={0}
          max={SEARCH_INTERVAL_MAX_S}
          step={1}
          value={text}
          aria-label="Intervalo mínimo entre pesquisas (s)"
          onChange={(e) => {
            setText(e.target.value)
            save(e.target.value)
          }}
          onBlur={() => {
            const v = text.trim() ? normalizeSearchInterval(text) : SEARCH_INTERVAL_DEFAULT_S
            setText(String(v))
            save(String(v), true)
          }}
          className="field h-8 w-[110px] px-2 py-0 text-right font-mono text-[12.5px] tabular-nums"
        />
        <p className="mt-2 text-xs leading-relaxed text-subtle">
          Vale para todas as chamadas de <span className="font-mono">web_search</span> de qualquer
          chat, sessão ou subagente: uma pesquisa que chega antes do intervalo espera o restante, e
          pesquisas simultâneas saem uma de cada vez. Espaçar as buscas evita o bloqueio anti-robô
          do DuckDuckGo; se ele bloquear mesmo assim, o fallback para o Brave Search roda na hora. 0
          = desligado · máx. {SEARCH_INTERVAL_MAX_S} s · padrão {SEARCH_INTERVAL_DEFAULT_S} s.
        </p>
      </div>
    </div>
  )
}
