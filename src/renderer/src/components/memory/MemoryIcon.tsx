// Ícones da memória: categoria (fixo) e coleção (ícone escolhido ou o da categoria).
import {
  FolderKanban,
  Lightbulb,
  MessageSquare,
  SlidersHorizontal,
  UserRound,
  UsersRound,
  type LucideIcon
} from 'lucide-react'
import type { MemoryCategory, MemoryCollection } from '@shared/memory'
import { cn } from '../../lib/format'
import { PresetIcon } from '../presets/PresetIcon'

export const CATEGORY_ICON: Record<MemoryCategory, LucideIcon> = {
  profile: UserRound,
  topics: Lightbulb,
  areas: FolderKanban,
  people: UsersRound,
  preferences: SlidersHorizontal
}

export function CollectionIcon({
  collection,
  size = 'sm',
  className
}: {
  collection: Pick<MemoryCollection, 'icon' | 'category' | 'scope'>
  size?: 'xs' | 'sm' | 'md'
  className?: string
}): React.JSX.Element {
  if (collection.icon && collection.scope === 'shared')
    return (
      <PresetIcon
        icon={collection.icon}
        size={size === 'md' ? 'md' : 'sm'}
        className={cn(size === 'xs' && 'size-5 text-[11px] [&_svg]:size-3', className)}
      />
    )
  const Icon = collection.scope === 'chat' ? MessageSquare : CATEGORY_ICON[collection.category]
  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-lg border border-border bg-elevated text-muted',
        size === 'xs' && 'size-5 [&_svg]:size-3',
        size === 'sm' && 'size-6 [&_svg]:size-3.5',
        size === 'md' && 'size-8 [&_svg]:size-4',
        className
      )}
    >
      <Icon strokeWidth={1.75} />
    </span>
  )
}
