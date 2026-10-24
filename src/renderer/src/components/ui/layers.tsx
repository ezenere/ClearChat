import { X } from 'lucide-react'
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject
} from 'react'
import { createPortal } from 'react-dom'
import { cn } from '../../lib/format'
import { useEscapeLayer } from './escape'
import { IconButton } from './controls'

// ---- Modal ----
export function Modal({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
  width = 560,
  height,
  bodyClassName,
  bare
}: {
  open: boolean
  onClose: () => void
  title: ReactNode
  subtitle?: ReactNode
  children: ReactNode
  footer?: ReactNode
  width?: number
  /** Altura fixa (CSS — ex.: `min(800px, 84vh)`); sem ela o modal cresce com o conteúdo. */
  height?: string
  bodyClassName?: string
  /** Corpo sem padding nem rolagem própria (o conteúdo monta o próprio layout — ex.: Configurações). */
  bare?: boolean
}): React.JSX.Element | null {
  useEscapeLayer(open, onClose)
  if (!open) return null
  return createPortal(
    <div
      className="no-drag fixed inset-0 z-50 flex animate-fade-in items-start justify-center bg-black/55 px-6 pt-[9vh] pb-6 backdrop-blur-[2px]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="flex max-h-[84vh] w-full animate-pop-in flex-col overflow-hidden rounded-2xl border border-border-strong/60 bg-surface shadow-modal"
        style={{ maxWidth: width, height }}
      >
        <div className="flex shrink-0 items-start gap-3 px-5 pt-4 pb-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-[15px] font-semibold tracking-tight">{title}</h2>
            {subtitle && <p className="mt-0.5 text-xs text-subtle">{subtitle}</p>}
          </div>
          <IconButton label="Fechar" shortcut="Esc" size="sm" onClick={onClose} className="-mr-1.5">
            <X />
          </IconButton>
        </div>
        <div
          className={cn(
            'min-h-0 flex-1',
            bare ? 'flex overflow-hidden' : 'overflow-y-auto px-5 pb-5',
            bodyClassName
          )}
        >
          {children}
        </div>
        {footer && (
          <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border bg-bg/30 px-5 py-3">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body
  )
}

// ---- Popover ancorado (portal + posição fixa) ----
export function Popover({
  open,
  onClose,
  anchor,
  children,
  width = 'anchor',
  align = 'start',
  className,
  maxHeight = 360,
  minWidth = 0
}: {
  open: boolean
  onClose: () => void
  anchor: RefObject<HTMLElement | null>
  children: ReactNode
  width?: 'anchor' | number
  align?: 'start' | 'end'
  className?: string
  maxHeight?: number
  /** Com `width="anchor"`: largura mínima (limitada à janela). */
  minWidth?: number
}): React.JSX.Element | null {
  const ref = useRef<HTMLDivElement>(null)
  const [style, setStyle] = useState<CSSProperties | null>(null)
  useEscapeLayer(open, onClose)

  useLayoutEffect(() => {
    if (!open) return
    const place = (): void => {
      const a = anchor.current
      if (!a) return
      const r = a.getBoundingClientRect()
      const w = Math.min(
        window.innerWidth - 16,
        width === 'anchor' ? Math.max(r.width, minWidth) : width
      )
      const below = window.innerHeight - r.bottom - 12
      const above = r.top - 12
      const up = below < 220 && above > below
      let left = align === 'start' ? r.left : r.right - w
      left = Math.max(8, Math.min(left, window.innerWidth - w - 8))
      setStyle({
        position: 'fixed',
        left,
        width: w,
        ...(up ? { bottom: window.innerHeight - r.top + 4 } : { top: r.bottom + 4 }),
        maxHeight: Math.min(maxHeight, up ? above : below)
      })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open, anchor, width, align, maxHeight, minWidth])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Node
      if (ref.current?.contains(t) || anchor.current?.contains(t)) return
      onClose()
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open, onClose, anchor])

  if (!open || !style) return null
  return createPortal(
    <div
      ref={ref}
      style={style}
      className={cn(
        'no-drag z-[60] flex animate-pop-in flex-col overflow-hidden rounded-xl border border-border-strong/70 bg-elevated shadow-popover',
        className
      )}
    >
      {children}
    </div>,
    document.body
  )
}
