import { FolderTree, SlidersHorizontal, X } from 'lucide-react'
import type { Chat } from '@shared/types'
import { cn } from '../../lib/format'
import { useStore, type PanelTab } from '../../store'
import { IconButton } from '../ui/controls'
import { ConfigTab } from './ConfigTab'
import { FilesTab } from './FilesTab'

const TABS: { id: PanelTab; label: string; icon: typeof SlidersHorizontal }[] = [
  { id: 'config', label: 'Config', icon: SlidersHorizontal },
  { id: 'files', label: 'Arquivos', icon: FolderTree }
]

export function RightPanel({
  chat,
  overlay
}: {
  chat: Chat
  /** Janela estreita: gaveta sobreposta ao chat em vez de coluna. */
  overlay?: boolean
}): React.JSX.Element {
  const tab = useStore((s) => s.panelTab)
  const setPanel = useStore((s) => s.setPanel)
  return (
    <aside
      data-testid="right-panel"
      className={cn(
        'flex w-[360px] max-w-[85%] shrink-0 animate-fade-in flex-col border-l border-border bg-surface',
        overlay && 'absolute inset-y-0 right-0 z-30 shadow-popover'
      )}
    >
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border/70 px-3">
        <div className="flex rounded-lg bg-bg/70 p-0.5">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setPanel(true, t.id)}
              className={cn(
                'flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors',
                tab === t.id ? 'bg-active text-fg shadow-sm' : 'text-subtle hover:text-fg'
              )}
            >
              <t.icon className="size-3.5" />
              {t.label}
            </button>
          ))}
        </div>
        <IconButton
          label="Fechar painel"
          size="sm"
          className="ml-auto"
          onClick={() => setPanel(false)}
        >
          <X />
        </IconButton>
      </div>
      <div
        className={cn('min-h-0 flex-1', tab === 'config' ? 'overflow-y-auto' : 'overflow-hidden')}
      >
        {tab === 'config' ? <ConfigTab chat={chat} /> : <FilesTab key={chat.id} chat={chat} />}
      </div>
    </aside>
  )
}
