// Seletor compacto de persona (Novo chat): ícone + nome + modelo; popover com a lista.
import { Check, ChevronDown, Settings2 } from 'lucide-react'
import { useRef, useState } from 'react'
import type { ChatConfig, Preset } from '@shared/types'
import { cn } from '../../lib/format'
import { presetSummary } from '../../lib/presets'
import { useStore } from '../../store'
import { Popover } from '../ui/layers'
import { ModelLabel } from '../ui/ModelLabel'
import { PresetIcon } from './PresetIcon'

export function PresetPicker({
  presets,
  value,
  customized,
  resolve,
  onChange
}: {
  presets: Preset[]
  value: string | null
  /** Campos alterados depois de escolher a persona. */
  customized: boolean
  /** Config completa de uma persona (para mostrar o modelo). */
  resolve: (p: Preset) => ChatConfig
  onChange: (id: string) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const current = presets.find((p) => p.id === value) ?? null
  const cur = current ? resolve(current) : null

  return (
    <>
      <button
        ref={anchor}
        type="button"
        data-testid="preset-picker"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'no-drag group flex w-full min-w-0 items-center gap-3 rounded-xl border bg-surface px-3 py-2.5 text-left transition-colors hover:border-border-strong hover:bg-hover/60',
          open ? 'border-border-strong' : 'border-border'
        )}
      >
        <PresetIcon icon={current?.icon} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-fg">
            {current ? (customized ? 'Personalizado' : current.name) : 'Sem persona'}
          </span>
          <span className="block truncate text-[11.5px] text-subtle">
            {current
              ? customized
                ? `a partir de ${current.name}`
                : current.description || presetSummary(current)
              : presets.length
                ? 'Padrões do app'
                : 'Nenhuma persona salva ainda'}
          </span>
        </span>
        {cur && !customized && cur.model && (
          <ModelLabel
            providerId={cur.providerId}
            model={cur.model}
            className="max-w-[45%] text-[11px] text-subtle max-[1179px]:hidden"
            modelClassName="font-mono"
          />
        )}
        <ChevronDown
          className={cn('size-3.5 shrink-0 text-subtle transition-transform', open && 'rotate-180')}
        />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} maxHeight={400}>
        <div role="listbox" aria-label="Personas" className="min-h-0 overflow-y-auto p-1">
          {presets.length === 0 && (
            <div className="px-2.5 py-2 text-xs text-subtle">
              Nenhuma persona. Ajuste os campos e use “Salvar como persona”.
            </div>
          )}
          {presets.map((p) => {
            const c = resolve(p)
            return (
              <button
                key={p.id}
                type="button"
                role="option"
                aria-selected={p.id === value}
                onClick={() => {
                  onChange(p.id)
                  setOpen(false)
                }}
                className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-hover"
              >
                <PresetIcon icon={p.icon} size="sm" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] text-fg">{p.name}</span>
                  <span className="block truncate text-[10.5px] text-subtle">
                    {c.model ? (
                      <ModelLabel
                        providerId={c.providerId}
                        model={c.model}
                        className="max-w-full"
                        modelClassName="font-mono"
                      />
                    ) : (
                      'sem modelo'
                    )}
                  </span>
                </span>
                {p.id === value && <Check className="size-3.5 shrink-0 text-accent-strong" />}
              </button>
            )
          })}
        </div>
        <div className="border-t border-border p-1">
          <button
            type="button"
            onClick={() => {
              setOpen(false)
              setSettingsOpen(true, 'presets')
            }}
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12.5px] text-muted hover:bg-hover hover:text-fg"
          >
            <Settings2 className="size-3.5" /> Gerenciar personas…
          </button>
        </div>
      </Popover>
    </>
  )
}
