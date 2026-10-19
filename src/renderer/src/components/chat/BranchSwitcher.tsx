// ‹ i/n › — troca entre as versões de uma mensagem (ramos da conversa; ver src/shared/branches.ts).
// Sempre visível (sinaliza que existem outras versões); grupo focável: ←/→ trocam com ele em foco.
import { ChevronLeft, ChevronRight } from 'lucide-react'
import type { SiblingInfo } from '@shared/branches'
import { cn } from '../../lib/format'
import { versionLabel } from '../../lib/branchView'
import { Tip } from '../ui/Tooltip'

export function BranchSwitcher({
  info,
  group,
  onSelect,
  disabledReason,
  local,
  className
}: {
  info: SiblingInfo
  /** Chave do grupo de versões (para manter a posição na tela depois da troca). */
  group?: string
  onSelect: (messageId: string) => void
  /** Motivo de não poder trocar agora (tooltip); null/undefined = pode. */
  disabledReason?: string | null
  /** Troca só nesta tela (view só de leitura): rótulo "só nesta tela". */
  local?: boolean
  className?: string
}): React.JSX.Element {
  const disabled = !!disabledReason
  const go = (id: string | null): void => {
    if (id && !disabled) onSelect(id)
  }
  const nav = (dir: 'prev' | 'next'): React.JSX.Element => {
    const target = dir === 'prev' ? info.prevId : info.nextId
    const label = dir === 'prev' ? 'Versão anterior' : 'Próxima versão'
    const btn = (
      <button
        type="button"
        tabIndex={-1}
        aria-label={label}
        disabled={disabled || !target}
        onClick={() => go(target)}
        className="grid size-5 place-items-center rounded-md text-subtle transition-colors hover:bg-hover hover:text-fg disabled:pointer-events-none disabled:opacity-35"
      >
        {dir === 'prev' ? (
          <ChevronLeft className="size-3.5" />
        ) : (
          <ChevronRight className="size-3.5" />
        )}
      </button>
    )
    return disabled ? btn : <Tip label={label}>{btn}</Tip>
  }
  const body = (
    <div
      role="group"
      tabIndex={0}
      aria-label={versionLabel(info)}
      aria-disabled={disabled || undefined}
      data-testid="branch-switcher"
      data-branch-group={group}
      data-index={info.index + 1}
      data-count={info.count}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft') {
          e.preventDefault()
          e.stopPropagation()
          go(info.prevId)
        } else if (e.key === 'ArrowRight') {
          e.preventDefault()
          e.stopPropagation()
          go(info.nextId)
        }
      }}
      className={cn(
        'inline-flex shrink-0 items-center gap-0.5 rounded-md text-[11px] text-subtle outline-none select-none focus-visible:ring-2 focus-visible:ring-accent/50',
        disabled && 'cursor-default',
        className
      )}
    >
      {nav('prev')}
      <span
        data-testid="branch-position"
        className={cn('min-w-[2.25rem] text-center tabular-nums', disabled && 'text-faint')}
      >
        {info.index + 1}/{info.count}
      </span>
      {nav('next')}
      {local && (
        <span className="ml-1 text-[10.5px] whitespace-nowrap text-faint">só nesta tela</span>
      )}
    </div>
  )
  return disabled ? <Tip label={disabledReason}>{body}</Tip> : body
}
