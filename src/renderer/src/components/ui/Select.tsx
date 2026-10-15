import { Check, ChevronDown } from 'lucide-react'
import { useRef, useState, type ReactNode } from 'react'
import { cn } from '../../lib/format'
import { Popover } from './layers'

export interface SelectOption<T extends string> {
  value: T
  label: ReactNode
  description?: ReactNode
}

export function Select<T extends string>({
  value,
  options,
  onChange,
  placeholder = 'Selecionar…',
  className,
  disabled
}: {
  value: T | null | undefined
  options: SelectOption<T>[]
  onChange: (v: T) => void
  placeholder?: string
  className?: string
  disabled?: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [hi, setHi] = useState(0)
  const anchor = useRef<HTMLButtonElement>(null)
  const current = options.find((o) => o.value === value)

  const pick = (v: T): void => {
    onChange(v)
    setOpen(false)
    anchor.current?.focus()
  }

  return (
    <>
      <button
        ref={anchor}
        type="button"
        disabled={disabled}
        onClick={() => {
          setHi(
            Math.max(
              0,
              options.findIndex((o) => o.value === value)
            )
          )
          setOpen((o) => !o)
        }}
        onKeyDown={(e) => {
          if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
            e.preventDefault()
            setOpen(true)
            return
          }
          if (!open) return
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            setHi((h) => Math.min(options.length - 1, h + 1))
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setHi((h) => Math.max(0, h - 1))
          } else if (e.key === 'Enter' && options[hi]) {
            e.preventDefault()
            pick(options[hi].value)
          }
        }}
        className={cn(
          'field no-drag flex items-center gap-2 text-left disabled:opacity-50',
          open && 'border-border-strong',
          className
        )}
      >
        <span className={cn('min-w-0 flex-1 truncate', !current && 'text-subtle')}>
          {current ? current.label : placeholder}
        </span>
        <ChevronDown
          className={cn('size-3.5 shrink-0 text-subtle transition-transform', open && 'rotate-180')}
        />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor}>
        <div className="overflow-y-auto p-1">
          {options.length === 0 && (
            <div className="px-2.5 py-2 text-xs text-subtle">Nenhuma opção</div>
          )}
          {options.map((o, i) => (
            <button
              key={o.value}
              type="button"
              onMouseEnter={() => setHi(i)}
              onClick={() => pick(o.value)}
              className={cn(
                'flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px]',
                i === hi ? 'bg-hover text-fg' : 'text-fg/90'
              )}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate">{o.label}</span>
                {o.description && (
                  <span className="block truncate text-[11px] text-subtle">{o.description}</span>
                )}
              </span>
              {o.value === value && <Check className="size-3.5 shrink-0 text-accent-strong" />}
            </button>
          ))}
        </div>
      </Popover>
    </>
  )
}
