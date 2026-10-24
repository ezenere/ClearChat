// "Parâmetros" de um motor do Modo avançado (GPU local): disclosure com um controle por parâmetro
// (faixa + valor + padrão + "?" do efeito), "Restaurar padrão" e a nota de quando vale. As specs vêm
// de `GPU_ENGINE_PARAMS` (`@shared/gpuVoice`); o que se grava são só os valores diferentes do padrão
// (`ttsSettings.gpu.params[motor]` / `sttSettings.gpu.params`) — locais, não sincronizam. Os
// valores vão no corpo de cada fala (o servidor não reinicia); o whisper recebe na próxima
// transcrição.
import { ChevronDown, ChevronRight, RotateCcw, SlidersHorizontal } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { cn } from '../../../lib/format'
import { gpuParamRows, setGpuParam } from '../../../lib/voice/gpu/gpuUi'
import type { GpuEngineId } from '../../../lib/voice/gpu/types'
import type { GpuParamValues } from '@shared/gpuVoice'
import { Button, Switch } from '../../ui/controls'
import { Select } from '../../ui/Select'
import { HelpTip } from '../../ui/Tooltip'

const sameParams = (a: GpuParamValues, b: GpuParamValues): boolean =>
  JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort())

export function GpuParamsEditor({
  engineId,
  engineLabel,
  value,
  onChange,
  testId,
  extra,
  extraChanged = false,
  onRestore,
  defaultOpen = false,
  kind
}: {
  engineId: GpuEngineId
  engineLabel: string
  /** Overrides salvos (só os diferentes do padrão). */
  value: GpuParamValues
  onChange: (next: GpuParamValues) => void
  testId: string
  /** Controles extras no topo (ex.: os passos do OmniVoice, que moram em `ttsSettings.gpu.steps`). */
  extra?: ReactNode
  /** O extra está fora do padrão (habilita "Restaurar padrão"). */
  extraChanged?: boolean
  /**
   * "Restaurar padrão" num commit só (parâmetros + extra — dois commits seguidos das settings se
   * sobrescreveriam). Ausente → grava os parâmetros vazios.
   */
  onRestore?: () => void
  defaultOpen?: boolean
  kind: 'tts' | 'stt'
}): React.JSX.Element | null {
  const [open, setOpen] = useState(defaultOpen)
  const [draft, setDraft] = useState<GpuParamValues>(value)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pending = useRef<GpuParamValues | null>(null)
  // as settings mudam entre o arrasto e o commit: sempre o onChange/valor mais recentes
  const latest = useRef({ onChange, value })
  useEffect(() => {
    latest.current = { onChange, value }
  })

  // valor externo mudou (outro painel, restaurar): segue, a não ser que haja um commit pendente
  useEffect(() => {
    if (!pending.current) setDraft(value)
  }, [value])
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
      if (pending.current) latest.current.onChange(pending.current)
    },
    []
  )

  const rows = gpuParamRows(engineId, draft)
  if (!rows.length && !extra) return null
  const changed = rows.some((r) => r.changed) || extraChanged
  const nChanged = rows.filter((r) => r.changed).length + (extraChanged ? 1 : 0)

  const commit = (next: GpuParamValues, now = false): void => {
    setDraft(next)
    pending.current = next
    if (timer.current) clearTimeout(timer.current)
    const flush = (): void => {
      timer.current = null
      const p = pending.current
      pending.current = null
      if (p && !sameParams(p, latest.current.value)) latest.current.onChange(p)
    }
    if (now) flush()
    else timer.current = setTimeout(flush, 350)
  }
  const set = (key: string, v: unknown, now = false): void =>
    commit(setGpuParam(engineId, draft, key, v), now)
  const restore = (): void => {
    if (!onRestore) return commit({}, true)
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    pending.current = null
    setDraft({})
    onRestore()
  }
  const restartRows = rows.filter((r) => r.spec.applies === 'restart')

  return (
    <div className="mt-2" data-testid={testId} data-open={open} data-changed={changed}>
      <button
        type="button"
        aria-expanded={open}
        data-testid={`${testId}-toggle`}
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 rounded-md text-[11.5px] font-medium text-muted hover:text-fg"
      >
        {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        <SlidersHorizontal className="size-3" />
        Parâmetros
        {nChanged > 0 && (
          <span className="font-normal text-accent-strong" data-testid={`${testId}-count`}>
            · {nChanged} {nChanged === 1 ? 'alterado' : 'alterados'}
          </span>
        )}
      </button>
      {open && (
        <div
          className="mt-2 space-y-2.5 rounded-lg border border-border/70 bg-bg/40 px-3 py-2.5"
          role="group"
          aria-label={`Parâmetros de ${engineLabel}`}
        >
          {extra}
          {rows.map((r) => (
            <div key={r.spec.key} data-testid={`${testId}-row-${r.spec.key}`}>
              <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                <span className="text-[11.5px] font-medium text-muted">{r.spec.label}</span>
                <HelpTip label={`${r.spec.label} (${engineLabel})`}>{r.spec.help}</HelpTip>
                {r.spec.kind === 'number' && (
                  <span
                    className={cn(
                      'ml-auto text-[11.5px] tabular-nums',
                      r.changed ? 'text-accent-strong' : 'text-fg/80'
                    )}
                    data-testid={`${testId}-${r.spec.key}-value`}
                  >
                    {r.display}
                  </span>
                )}
                <span className="text-[10.5px] text-faint">
                  {r.spec.kind === 'number' ? `padrão ${r.defaultDisplay}` : ''}
                  {r.spec.applies === 'restart' ? ' · aplica ao reiniciar o servidor' : ''}
                </span>
              </div>
              {r.spec.kind === 'number' && (
                <input
                  type="range"
                  min={r.spec.min}
                  max={r.spec.max}
                  step={r.spec.step}
                  value={Number(r.value)}
                  aria-label={`${r.spec.label} (${engineLabel})`}
                  aria-valuetext={r.display}
                  data-testid={`${testId}-${r.spec.key}`}
                  onChange={(e) => set(r.spec.key, Number(e.target.value))}
                  onPointerUp={() => pending.current && commit(pending.current, true)}
                  onKeyUp={() => pending.current && commit(pending.current, true)}
                  className="mt-1 w-full accent-accent-strong"
                />
              )}
              {r.spec.kind === 'boolean' && (
                <div className="mt-1" data-testid={`${testId}-${r.spec.key}`}>
                  <Switch
                    size="sm"
                    checked={r.value === true}
                    label={`${r.spec.label} (${engineLabel})`}
                    onChange={(v) => set(r.spec.key, v, true)}
                  />
                </div>
              )}
              {r.spec.kind === 'select' && (
                <div className="mt-1" data-testid={`${testId}-${r.spec.key}`}>
                  <Select
                    value={String(r.value)}
                    label={`${r.spec.label} (${engineLabel})`}
                    className="h-7 w-full max-w-[220px]"
                    options={(r.spec.options ?? []).map((o) => ({
                      value: o.value,
                      label: o.value === r.spec.default ? `${o.label} (padrão)` : o.label
                    }))}
                    onChange={(v) => set(r.spec.key, v, true)}
                  />
                </div>
              )}
            </div>
          ))}
          <div className="flex flex-wrap items-center gap-2 pt-0.5">
            <Button
              size="sm"
              variant="ghost"
              icon={<RotateCcw className="size-3" />}
              disabled={!changed}
              data-testid={`${testId}-restore`}
              onClick={restore}
            >
              Restaurar padrão
            </Button>
            <span className="text-[10.5px] text-subtle">
              {restartRows.length
                ? 'Os marcados aplicam ao reiniciar o servidor; os demais, '
                : 'Vale '}
              {kind === 'tts'
                ? 'na próxima fala (inclusive no “Testar”) — sem reiniciar o servidor.'
                : 'na próxima transcrição — sem reiniciar o servidor.'}
            </span>
          </div>
        </div>
      )}
    </div>
  )
}
