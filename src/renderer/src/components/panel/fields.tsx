// Peças visuais compartilhadas pelas abas do painel e pelo editor de personas.
import { useState, type ReactNode } from 'react'
import { cn } from '../../lib/format'
import { Switch } from '../ui/controls'

export function Section({
  title,
  children,
  aside,
  id
}: {
  title: string
  children: ReactNode
  aside?: ReactNode
  id?: string
}): React.JSX.Element {
  return (
    <section
      data-section={id}
      className="scroll-mt-2 border-b border-border/70 px-4 py-4 last:border-b-0"
    >
      <div className="mb-3 flex items-center gap-2">
        <h3 className="text-[11px] font-semibold tracking-[0.06em] text-subtle uppercase">
          {title}
        </h3>
        {aside && <div className="ml-auto flex items-center">{aside}</div>}
      </div>
      <div className="space-y-3">{children}</div>
    </section>
  )
}

export function ToggleRow({
  label,
  checked,
  onChange,
  info,
  description
}: {
  label: string
  checked: boolean
  onChange: (v: boolean) => void
  info?: ReactNode
  description?: string
}): React.JSX.Element {
  return (
    <div className="flex items-start gap-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-[13px] text-fg/90">
          {label}
          {info}
        </div>
        {description && (
          <p className="mt-0.5 text-[11.5px] leading-snug text-subtle">{description}</p>
        )}
      </div>
      <div className="pt-0.5">
        <Switch checked={checked} onChange={onChange} label={label} />
      </div>
    </div>
  )
}

export function NumberInput({
  value,
  disabled,
  step,
  min,
  max,
  int,
  wide,
  label,
  onCommit
}: {
  value: number | undefined
  disabled: boolean
  step: number
  min?: number
  max?: number
  int?: boolean
  wide?: boolean
  label?: string
  onCommit: (v: number) => void
}): React.JSX.Element {
  const [text, setText] = useState(value == null ? '' : String(value))
  const [prev, setPrev] = useState(value)
  if (prev !== value) {
    setPrev(value)
    setText(value == null ? '' : String(value))
  }
  return (
    <input
      type="number"
      value={text}
      step={step}
      min={min}
      max={max}
      disabled={disabled}
      aria-label={label}
      onChange={(e) => {
        setText(e.target.value)
        const n = int ? parseInt(e.target.value, 10) : parseFloat(e.target.value)
        if (!Number.isNaN(n)) onCommit(n)
      }}
      className={cn(
        'field h-7 px-2 py-0 text-right font-mono text-[12px] tabular-nums disabled:opacity-40 [&::-webkit-inner-spin-button]:opacity-40',
        wide ? 'w-[110px]' : 'w-[92px]'
      )}
    />
  )
}

function validateJson(text: string): string | null {
  if (!text.trim()) return null
  try {
    const v = JSON.parse(text)
    if (!v || typeof v !== 'object' || Array.isArray(v)) return 'Deve ser um objeto JSON'
    return null
  } catch (err) {
    return (err as Error).message.replace(/^JSON\.parse: /, '')
  }
}

export function ExtraBodyEditor({
  value,
  onChange
}: {
  value: string | undefined
  onChange: (v: string | undefined) => void
}): React.JSX.Element {
  const [text, setText] = useState(value ?? '')
  const [prev, setPrev] = useState(value)
  if (prev !== value) {
    setPrev(value)
    if ((value ?? '') !== text && validateJson(text) === null) setText(value ?? '')
  }
  const error = validateJson(text)
  return (
    <div>
      <textarea
        value={text}
        spellCheck={false}
        aria-label="Body extra (JSON)"
        placeholder={'{\n  "provider": { "order": ["anthropic"] }\n}'}
        onChange={(e) => {
          const t = e.target.value
          setText(t)
          if (validateJson(t) === null) onChange(t.trim() ? t : undefined)
        }}
        className={cn(
          'field min-h-[84px] resize-y font-mono text-[11.5px] leading-relaxed',
          error && 'border-danger/50 focus:border-danger/60'
        )}
      />
      <div className="mt-1 h-4 text-[11px]">
        {error ? (
          <span className="text-danger">{error} — não salvo</span>
        ) : text.trim() ? (
          <span className="text-success/80">JSON válido · mesclado no body</span>
        ) : (
          <span className="text-subtle">Vazio · nada é mesclado</span>
        )}
      </div>
    </div>
  )
}

/** Nota em destaque suave (ex.: subsessão somente leitura). */
export function Note({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <p className="rounded-lg border border-accent/20 bg-accent-soft/40 px-3 py-2 text-[11.5px] leading-snug text-muted">
      {children}
    </p>
  )
}
