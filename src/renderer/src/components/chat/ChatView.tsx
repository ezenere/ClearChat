import {
  ArrowLeft,
  Bot,
  ChevronRight,
  FolderOpen,
  PanelRight,
  ShieldOff,
  Sparkles
} from 'lucide-react'
import { TOOL_LABELS } from '@shared/tools'
import { CONFIRM_TOOLS } from '@shared/types'
import type { Chat, Session } from '@shared/types'
import { cn, compactPath, sessionLabel } from '../../lib/format'
import { useStore } from '../../store'
import { TaskInfo } from '../apiDocs'
import { TopBar } from '../TopBar'
import { IconButton } from '../ui/controls'
import { Tip } from '../ui/Tooltip'
import { Composer } from './Composer'
import { ContextMeter } from './ContextMeter'
import { MessageList } from './MessageList'
import { SessionSwitcher, StatusDot } from './SessionSwitcher'

function ModelPill({ model }: { model: string }): React.JSX.Element {
  const setPanel = useStore((s) => s.setPanel)
  const [vendor, name] = model.includes('/')
    ? [model.split('/')[0], model.split('/').slice(1).join('/')]
    : ['', model]
  return (
    <Tip label="Modelo · abrir configurações do chat" side="bottom">
      <button
        type="button"
        onClick={() => setPanel(true, 'config')}
        className="no-drag flex h-7 max-w-[260px] min-w-0 shrink items-center gap-1.5 rounded-lg border border-border bg-surface px-2.5 text-xs transition-colors hover:border-border-strong hover:bg-hover max-[1179px]:max-w-[180px]"
      >
        <Sparkles className="size-3 shrink-0 text-accent-strong" />
        {vendor && <span className="shrink-0 text-subtle max-[1179px]:hidden">{vendor}/</span>}
        <span className="truncate font-medium text-fg/90">{name || 'sem modelo'}</span>
      </button>
    </Tip>
  )
}

function EmptyChat({ chat }: { chat: Chat }): React.JSX.Element {
  const homeDir = useStore((s) => s.homeDir)
  const setPanel = useStore((s) => s.setPanel)
  return (
    <div className="flex animate-fade-in flex-col items-center pt-[16vh] text-center">
      <div className="mb-5 flex size-11 items-center justify-center rounded-2xl border border-border bg-surface">
        <Sparkles className="size-5 text-accent-strong" strokeWidth={1.75} />
      </div>
      <h2 className="text-[19px] font-semibold tracking-tight">Pronto para conversar</h2>
      <p className="mt-1.5 text-[13px] text-muted">Escreva sua primeira mensagem abaixo.</p>
      <div className="mt-5 flex flex-wrap items-center justify-center gap-2 text-[11.5px]">
        <button
          type="button"
          onClick={() => setPanel(true, 'config')}
          className="rounded-full border border-border px-2.5 py-1 font-mono text-muted hover:border-border-strong hover:text-fg"
        >
          {chat.config.model || 'sem modelo'}
        </button>
        <button
          type="button"
          onClick={() => setPanel(true, 'files')}
          className="flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 font-mono text-muted hover:border-border-strong hover:text-fg"
        >
          <FolderOpen className="size-3 shrink-0" />
          <span title={chat.config.cwd}>{compactPath(chat.config.cwd, homeDir, 56)}</span>
        </button>
      </div>
    </div>
  )
}

function AutoApproveBadge({ chat }: { chat: Chat }): React.JSX.Element | null {
  const setPanel = useStore((s) => s.setPanel)
  const tools = CONFIRM_TOOLS.filter((t) => chat.config.autoApprove.includes(t))
  if (tools.length === 0) return null
  return (
    <Tip
      side="bottom"
      label={
        <span>Executam sem pedir confirmação: {tools.map((t) => TOOL_LABELS[t]).join(', ')}</span>
      }
    >
      <button
        type="button"
        onClick={() => setPanel(true, 'config')}
        aria-label="Auto-aprovação"
        className="no-drag flex h-7 shrink-0 items-center gap-1.5 rounded-lg border border-warning/25 bg-warning/[0.06] px-2 text-xs text-warning/90 transition-colors hover:bg-warning/[0.12]"
      >
        <ShieldOff className="size-3.5" />
        <span className="max-[1179px]:hidden">
          {tools.length === CONFIRM_TOOLS.length
            ? 'Auto-aprovação'
            : `Auto-aprovação · ${tools.length}`}
        </span>
      </button>
    </Tip>
  )
}

export function ChatHeader({
  chat,
  session
}: {
  chat: Chat
  session: Session | undefined
}): React.JSX.Element {
  const panelOpen = useStore((s) => s.panelOpen)
  const setPanel = useStore((s) => s.setPanel)
  const openSession = useStore((s) => s.openSession)
  const isSub = !!session && session.depth > 0
  return (
    <TopBar
      right={
        <IconButton
          label={panelOpen ? 'Fechar painel' : 'Abrir painel'}
          side="bottom"
          size="sm"
          active={panelOpen}
          onClick={() => setPanel(!panelOpen)}
        >
          <PanelRight />
        </IconButton>
      }
    >
      <div className="flex min-w-0 items-center gap-1.5">
        {isSub ? (
          <>
            <button
              type="button"
              onClick={() => void openSession(chat.mainSessionId)}
              className="no-drag max-w-[220px] truncate text-[13px] text-subtle hover:text-fg"
            >
              {chat.title || 'Novo chat'}
            </button>
            <ChevronRight className="size-3.5 shrink-0 text-faint" />
            <span className="truncate text-[13px] font-medium">{sessionLabel(session)}</span>
          </>
        ) : (
          <span className="truncate text-[13px] font-medium">{chat.title || 'Novo chat'}</span>
        )}
      </div>
      <ModelPill model={isSub ? session.model : chat.config.model} />
      <SessionSwitcher chatId={chat.id} currentId={session?.id ?? chat.mainSessionId} />
      <AutoApproveBadge chat={chat} />
    </TopBar>
  )
}

function SubBanner({ chat, session }: { chat: Chat; session: Session }): React.JSX.Element {
  const openSession = useStore((s) => s.openSession)
  const parent = useStore((s) =>
    session.parentSessionId ? s.sessions[session.parentSessionId] : undefined
  )
  return (
    <div className="shrink-0 border-b border-border/70 bg-accent-soft/40 px-8">
      <div className="mx-auto flex h-10 max-w-[780px] items-center gap-2 text-[12.5px]">
        <Bot className="size-3.5 text-accent-strong" />
        <span className="font-medium text-fg/90">Subagente</span>
        <span className="text-faint">·</span>
        <span className="text-muted">somente leitura</span>
        <StatusDot status={session.status} className="ml-1" />
        <TaskInfo task={session.task} />
        <div className="ml-auto flex items-center gap-1">
          <ContextMeter chat={chat} session={session} />
          {parent && parent.depth > 0 && (
            <button
              type="button"
              onClick={() => void openSession(parent.id)}
              className="no-drag rounded-md px-2 py-1 text-xs text-muted hover:bg-hover hover:text-fg"
            >
              Sessão-pai
            </button>
          )}
          <button
            type="button"
            onClick={() => void openSession(chat.mainSessionId)}
            className="no-drag flex items-center gap-1 rounded-md px-2 py-1 text-xs text-accent-strong hover:bg-accent-soft"
          >
            <ArrowLeft className="size-3.5" /> Voltar à principal
          </button>
        </div>
      </div>
    </div>
  )
}

export function ChatView({
  chat,
  sessionId
}: {
  chat: Chat
  sessionId: string
}): React.JSX.Element {
  const session = useStore((s) => s.sessions[sessionId])
  if (!session) {
    return <div className="flex-1" />
  }
  const isSub = session.depth > 0
  return (
    <div className={cn('flex min-h-0 min-w-0 flex-1 flex-col')}>
      {isSub && <SubBanner chat={chat} session={session} />}
      <MessageList
        chatId={chat.id}
        session={session}
        readOnly={isSub}
        empty={!isSub && <EmptyChat chat={chat} />}
      />
      {!isSub && <Composer session={session} autoFocus />}
    </div>
  )
}
