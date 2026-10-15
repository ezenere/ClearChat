// Ícone de persona: nome de ícone lucide (lista curada em presetIcons.ts) ou emoji/texto curto.
import { Sparkles } from 'lucide-react'
import { cn } from '../../lib/format'
import { PRESET_EMOJIS, PRESET_ICON_NAMES, PRESET_LUCIDE } from './presetIcons'

export function PresetIcon({
  icon,
  className,
  size = 'md'
}: {
  icon: string | undefined
  className?: string
  size?: 'sm' | 'md' | 'lg'
}): React.JSX.Element {
  const key = (icon ?? '').trim()
  const Lucide = PRESET_LUCIDE[key.toLowerCase()] ?? (key ? null : Sparkles)
  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-lg border border-border bg-elevated text-accent-strong',
        size === 'sm' && 'size-6 text-[13px] [&_svg]:size-3.5',
        size === 'md' && 'size-8 text-[16px] [&_svg]:size-4',
        size === 'lg' && 'size-10 text-[20px] [&_svg]:size-5',
        className
      )}
    >
      {Lucide ? (
        <Lucide strokeWidth={1.75} />
      ) : (
        <span className="leading-none">{key.slice(0, 4)}</span>
      )}
    </span>
  )
}

/** Grade de ícones (lucide + emojis) + campo livre para qualquer emoji. */
export function IconPicker({
  value,
  onChange
}: {
  value: string
  onChange: (icon: string) => void
}): React.JSX.Element {
  const cell = (id: string): React.JSX.Element => (
    <button
      key={id}
      type="button"
      aria-label={`Ícone ${id}`}
      aria-pressed={value === id}
      onClick={() => onChange(id)}
      className={cn(
        'flex size-8 items-center justify-center rounded-lg border transition-colors',
        value === id
          ? 'border-accent/60 bg-accent-soft/60'
          : 'border-transparent hover:border-border hover:bg-hover'
      )}
    >
      <PresetIcon icon={id} size="sm" className="border-0 bg-transparent" />
    </button>
  )
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-0.5">{PRESET_ICON_NAMES.map(cell)}</div>
      <div className="flex flex-wrap items-center gap-0.5">
        {PRESET_EMOJIS.map(cell)}
        <input
          value={PRESET_ICON_NAMES.includes(value) || PRESET_EMOJIS.includes(value) ? '' : value}
          onChange={(e) => onChange(e.target.value.trim().slice(0, 8))}
          placeholder="emoji…"
          aria-label="Emoji personalizado"
          className="field ml-1 h-8 w-[84px] px-2 py-0 text-center text-[13px]"
        />
      </div>
    </div>
  )
}
