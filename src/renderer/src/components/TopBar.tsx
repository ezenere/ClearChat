import { Hand, MessageCircleQuestion, WifiOff } from 'lucide-react'
import { type ReactNode } from 'react'
import { useStore } from '../store'
import { Tip } from './ui/Tooltip'

/**
 * Aprovações pendentes em OUTROS chats (as do chat aberto ficam no card da conversa ou na fila acima
 * do composer). Clique → abre o chat da mais antiga (a fila aparece lá).
 */
function ApprovalIndicator(): React.JSX.Element | null {
  const approvals = useStore((s) => s.approvals)
  const view = useStore((s) => s.view)
  const chats = useStore((s) => s.chats)
  const openChat = useStore((s) => s.openChat)
  const elsewhere = approvals
    .filter((a) => !(view.kind === 'chat' && view.chatId === a.chatId))
    .sort((a, b) => a.createdAt - b.createdAt)
  if (elsewhere.length === 0) return null
  const first = elsewhere[0]
  const chat = chats.find((c) => c.id === first.chatId)
  const nChats = new Set(elsewhere.map((a) => a.chatId)).size
  return (
    <Tip
      label={
        <span>
          <span className="text-warning">{first.toolName}</span> aguardando aprovação em “
          {chat?.title ?? 'chat'}”{nChats > 1 ? ` (e em mais ${nChats - 1} chat(s))` : ''}
        </span>
      }
      side="bottom"
    >
      <button
        type="button"
        data-testid="approval-indicator"
        onClick={() => void openChat(first.chatId)}
        className="no-drag flex h-7 animate-pop-in items-center gap-1.5 rounded-full border border-warning/45 bg-warning/[0.16] pr-2.5 pl-2 text-xs font-medium text-warning shadow-[0_0_0_3px_rgb(245_181_68/0.08)] transition-colors hover:bg-warning/[0.24]"
      >
        <Hand className="size-3.5" />
        {elsewhere.length === 1 ? 'Aprovação pendente' : `${elsewhere.length} aprovações pendentes`}
      </button>
    </Tip>
  )
}

/** Questionário (ask_user) aguardando resposta num chat/sessão que não está na tela. */
function QuestionIndicator(): React.JSX.Element | null {
  const questions = useStore((s) => s.questions)
  const view = useStore((s) => s.view)
  const chats = useStore((s) => s.chats)
  const openChat = useStore((s) => s.openChat)
  const elsewhere = questions.filter(
    (q) => !(view.kind === 'chat' && view.sessionId === q.sessionId)
  )
  if (elsewhere.length === 0) return null
  const first = elsewhere[0]
  const chat = chats.find((c) => c.id === first.chatId)
  return (
    <Tip label={`Questionário aguardando sua resposta em “${chat?.title ?? 'chat'}”`} side="bottom">
      <button
        type="button"
        onClick={() => void openChat(first.chatId, first.sessionId)}
        className="no-drag flex h-7 animate-pop-in items-center gap-1.5 rounded-full border border-warning/30 bg-warning/[0.08] pr-2.5 pl-2 text-xs text-warning transition-colors hover:bg-warning/[0.14]"
      >
        <MessageCircleQuestion className="size-3.5" />
        {elsewhere.length === 1 ? 'Pergunta pendente' : `${elsewhere.length} perguntas pendentes`}
      </button>
    </Tip>
  )
}

/**
 * Falha de conexão aguardando "Tentar de novo / Cancelar" numa sessão que não está na tela (outro
 * chat, ou um subagente deste chat — o clique leva à subsessão).
 */
function RetryIndicator(): React.JSX.Element | null {
  const retries = useStore((s) => s.retries)
  const view = useStore((s) => s.view)
  const chats = useStore((s) => s.chats)
  const sessions = useStore((s) => s.sessions)
  const openChat = useStore((s) => s.openChat)
  const elsewhere = retries.filter((r) => !(view.kind === 'chat' && view.sessionId === r.sessionId))
  if (elsewhere.length === 0) return null
  const first = elsewhere[0]
  const chat = chats.find((c) => c.id === first.chatId)
  const sub = (sessions[first.sessionId]?.depth ?? 0) > 0
  const label =
    elsewhere.length > 1
      ? `${elsewhere.length} falhas de conexão`
      : sub
        ? 'Subagente aguardando decisão'
        : 'Falha de conexão'
  return (
    <Tip
      label={`${sub ? `Subagente “${sessions[first.sessionId]?.title || 'Subagente'}”` : 'Agente'} aguardando sua decisão (falha de conexão) em “${chat?.title ?? 'chat'}”`}
      side="bottom"
    >
      <button
        type="button"
        data-testid="retry-indicator"
        onClick={() => void openChat(first.chatId, first.sessionId)}
        className="no-drag flex h-7 animate-pop-in items-center gap-1.5 rounded-full border border-warning/30 bg-warning/[0.08] pr-2.5 pl-2 text-xs text-warning transition-colors hover:bg-warning/[0.14]"
      >
        <WifiOff className="size-3.5" />
        {label}
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
        <RetryIndicator />
        <QuestionIndicator />
        <ApprovalIndicator />
        {right}
      </div>
      <div className="overlay-spacer h-full" />
    </header>
  )
}
