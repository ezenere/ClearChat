import * as RT from '@radix-ui/react-tooltip'
import { Info } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '../../lib/format'

type Side = 'top' | 'right' | 'bottom' | 'left'

/** Tooltip simples de texto (rótulo de botões etc.). */
export function Tip({
  label,
  children,
  side = 'top',
  shortcut
}: {
  label: ReactNode
  children: ReactNode
  side?: Side
  shortcut?: string
}): React.JSX.Element {
  return (
    <RT.Root>
      <RT.Trigger asChild>{children}</RT.Trigger>
      <RT.Portal>
        <RT.Content
          side={side}
          sideOffset={6}
          collisionPadding={8}
          className="z-[100] flex animate-fade-in items-center gap-2 rounded-md border border-border bg-elevated px-2 py-1 text-xs text-fg shadow-popover select-none"
        >
          {label}
          {shortcut && (
            <kbd className="rounded border border-border-strong px-1 font-sans text-[10px] text-muted">
              {shortcut}
            </kbd>
          )}
        </RT.Content>
      </RT.Portal>
    </RT.Root>
  )
}

/** Código inline para usar dentro dos textos de (i). */
export function C({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <code className="rounded bg-white/[0.06] px-1 py-px font-mono text-[11px] text-accent-strong">
      {children}
    </code>
  )
}

/**
 * Ícone (i) que explica exatamente o que é enviado para a API e como.
 * Use em TODO lugar que vira parte do prompt/request.
 */
export function ApiInfo({
  title,
  children,
  code,
  codeLabel,
  side = 'top',
  className,
  wide
}: {
  title?: ReactNode
  children?: ReactNode
  /** Texto exato enviado (mostrado em bloco mono). */
  code?: string
  codeLabel?: string
  side?: Side
  className?: string
  wide?: boolean
}): React.JSX.Element {
  return (
    <RT.Root delayDuration={120}>
      <RT.Trigger asChild>
        <button
          type="button"
          aria-label="O que é enviado para a API"
          onClick={(e) => e.preventDefault()}
          className={cn(
            'no-drag inline-flex size-4 shrink-0 items-center justify-center rounded-full text-faint transition-colors hover:text-accent-strong focus-visible:text-accent-strong',
            className
          )}
        >
          <Info className="size-3.5" strokeWidth={2} />
        </button>
      </RT.Trigger>
      <RT.Portal>
        <RT.Content
          side={side}
          sideOffset={6}
          collisionPadding={12}
          className={cn(
            'z-[100] max-h-[min(70vh,520px)] animate-pop-in overflow-y-auto rounded-xl border border-border-strong/70 bg-elevated p-3 text-xs leading-relaxed text-muted shadow-popover',
            wide || code ? 'w-[min(460px,90vw)]' : 'w-[300px]'
          )}
        >
          <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold tracking-[0.08em] text-accent-strong uppercase">
            <span className="size-1.5 rounded-full bg-accent" />
            Enviado à API
          </div>
          {title && <div className="mb-1 text-[13px] font-medium text-fg">{title}</div>}
          {children && <div className="space-y-1.5">{children}</div>}
          {code !== undefined && (
            <div className="mt-2">
              {codeLabel && <div className="mb-1 text-[11px] text-subtle">{codeLabel}</div>}
              <pre className="max-h-72 overflow-auto rounded-lg border border-border bg-bg/80 p-2.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-fg/90">
                {code === '' ? <span className="text-subtle italic">(vazio)</span> : code}
              </pre>
            </div>
          )}
        </RT.Content>
      </RT.Portal>
    </RT.Root>
  )
}

export const TooltipProvider = RT.Provider
