// "<Provedor> · <modelo>" (provedor esmaecido) — onde quer que um modelo apareça fora do seletor.
import { cn } from '../../lib/format'
import { useStore } from '../../store'

/** Nome do provedor (`null` = id vazio; `undefined` = provedor apagado). */
function useProviderName(providerId: string | null | undefined): string | null | undefined {
  return useStore((s) => (providerId ? s.providers.find((p) => p.id === providerId)?.name : null))
}

export function ModelLabel({
  providerId,
  model,
  className,
  modelClassName,
  short
}: {
  providerId: string | null | undefined
  model: string
  className?: string
  modelClassName?: string
  /** Mostra só o fim do id ("openai/gpt-4.1" → "gpt-4.1"). */
  short?: boolean
}): React.JSX.Element {
  const name = useProviderName(providerId)
  const shown = short ? model.split('/').pop() || model : model
  return (
    <span className={cn('inline-flex min-w-0 items-baseline gap-1', className)}>
      {name !== null && (
        <>
          <span
            className={cn(
              'max-w-[45%] shrink-0 truncate',
              name === undefined ? 'text-warning/80' : 'text-subtle'
            )}
          >
            {name ?? 'provedor removido'}
          </span>
          <span className="shrink-0 text-faint">·</span>
        </>
      )}
      <span className={cn('min-w-0 truncate', modelClassName)}>{shown || 'sem modelo'}</span>
    </span>
  )
}
