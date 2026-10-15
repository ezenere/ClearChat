import { Hand } from 'lucide-react'
import { type ReactNode } from 'react'
import { useStore } from '../store'
import { Tip } from './ui/Tooltip'

/** Indicador global e discreto de aprovações pendentes em sessões que não estão na tela. */
function ApprovalIndicator(): React.JSX.Element | null {
  const approvals = useStore((s) => s.approvals)
  const view = useStore((s) => s.view)
  const chats = useStore((s) => s.chats)
  const openChat = useStore((s) => s.openChat)
  const elsewhere = approvals.filter(
    (a) => !(view.kind === 'chat' && view.sessionId === a.sessionId)
  )
  if (elsewhere.length === 0) return null
  const first = elsewhere[0]
  const chat = chats.find((c) => c.id === first.chatId)
  return (
    <Tip
      label={
        <span>
          <span className="text-warning">{first.toolName}</span> aguardando aprovação em “
          {chat?.title ?? 'chat'}”
        </span>
      }
      side="bottom"
    >
      <button
        type="button"
        onClick={() => void openChat(first.chatId, first.sessionId)}
        className="no-drag flex h-7 animate-pop-in items-center gap-1.5 rounded-full border border-warning/30 bg-warning/[0.08] pr-2.5 pl-2 text-xs text-warning transition-colors hover:bg-warning/[0.14]"
      >
        <Hand className="size-3.5" />
        {elsewhere.length === 1 ? 'Aprovação pendente' : `${elsewhere.length} aprovações pendentes`}
      </button>
    </Tip>
  )
}

export function TopBar({
  children,
  right
}: {
  children?: ReactNode
  right?: ReactNode
}): React.JSX.Element {
  return (
    <header className="drag flex h-titlebar shrink-0 items-center gap-2 border-b border-border/70 pl-4">
      <div className="flex min-w-0 flex-1 items-center gap-2">{children}</div>
      <div className="flex items-center gap-1.5 pr-2">
        <ApprovalIndicator />
        {right}
      </div>
      <div className="overlay-spacer h-full" />
    </header>
  )
}
