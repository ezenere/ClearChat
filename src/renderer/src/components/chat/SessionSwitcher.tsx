import { Bot, Check, ChevronDown, MessageSquare } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import type { Session, SessionStatus } from '@shared/types'
import { cn, sessionLabel } from '../../lib/format'
import { useStore } from '../../store'
import { Popover } from '../ui/layers'
import { ModelLabel } from '../ui/ModelLabel'
import { sessionProviderId } from '@shared/models'

const STATUS_LABEL: Record<SessionStatus, string> = {
  idle: 'ociosa',
  running: 'executando',
  awaiting_approval: 'aguardando aprovação',
  done: 'concluída',
  error: 'erro',
  interrupted: 'interrompida'
}

export function StatusDot({
  status,
  className
}: {
  status: SessionStatus
  className?: string
}): React.JSX.Element {
  return (
    <span
      title={STATUS_LABEL[status]}
      className={cn(
        'inline-block size-1.5 shrink-0 rounded-full',
        status === 'running' && 'animate-pulse-soft bg-accent-strong',
        status === 'awaiting_approval' && 'bg-warning',
        status === 'done' && 'bg-success/80',
        status === 'error' && 'bg-danger',
        status === 'interrupted' && 'bg-subtle',
        status === 'idle' && 'bg-faint',
        className
      )}
    />
  )
}

export function SessionSwitcher({
  chatId,
  currentId
}: {
  chatId: string
  currentId: string
}): React.JSX.Element | null {
  const all = useStore((s) => s.sessions)
  const chat = useStore((s) => s.chats.find((c) => c.id === chatId))
  const approvals = useStore((s) => s.approvals)
  const openSession = useStore((s) => s.openSession)
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)

  const { roots, children, list } = useMemo(() => {
    const list = Object.values(all)
      .filter((s) => s.chatId === chatId)
      .sort((a, b) => a.createdAt - b.createdAt)
    const children = new Map<string, Session[]>()
    for (const s of list) {
      if (!s.parentSessionId) continue
      const arr = children.get(s.parentSessionId) ?? []
      arr.push(s)
      children.set(s.parentSessionId, arr)
    }
    return { roots: list.filter((s) => !s.parentSessionId), children, list }
  }, [all, chatId])

  if (list.length <= 1) return null
  const current = all[currentId]
  const subs = list.filter((s) => s.depth > 0)
  const activeSubs = subs.filter(
    (s) => s.status === 'running' || s.status === 'awaiting_approval'
  ).length

  const renderNode = (s: Session): React.JSX.Element => (
    <div key={s.id}>
      <button
        type="button"
        onClick={() => {
          setOpen(false)
          void openSession(s.id)
        }}
        className={cn(
          'flex w-full items-center gap-2 rounded-lg py-1.5 pr-2 text-left text-[13px] hover:bg-hover',
          s.id === currentId && 'bg-hover/60'
        )}
        style={{ paddingLeft: 10 + s.depth * 18 }}
      >
        {s.depth === 0 ? (
          <MessageSquare className="size-3.5 shrink-0 text-muted" />
        ) : (
          <Bot className="size-3.5 shrink-0 text-accent-strong/80" />
        )}
        <span className="min-w-0 flex-1 truncate">{sessionLabel(s)}</span>
        {approvals.some((a) => a.sessionId === s.id) && (
          <span className="rounded bg-warning/10 px-1 text-[10px] text-warning">aprovação</span>
        )}
        <ModelLabel
          providerId={chat ? sessionProviderId(chat.config, s) : null}
          model={s.model}
          short
          className="max-w-[45%] shrink-0 text-[10px] text-faint"
          modelClassName="font-mono"
        />
        <StatusDot status={s.status} />
        {s.id === currentId && <Check className="size-3.5 shrink-0 text-accent-strong" />}
      </button>
      {(children.get(s.id) ?? []).map(renderNode)}
    </div>
  )

  return (
    <>
      <button
        ref={anchor}
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'no-drag flex h-7 shrink-0 items-center gap-1.5 rounded-lg border border-border px-2 text-xs text-muted transition-colors hover:border-border-strong hover:text-fg',
          open && 'border-border-strong text-fg'
        )}
      >
        {current?.depth ? (
          <Bot className="size-3.5 text-accent-strong" />
        ) : (
          <MessageSquare className="size-3.5" />
        )}
        <span className="max-w-[160px] truncate max-[1179px]:hidden">
          {current ? sessionLabel(current) : 'Sessão'}
        </span>
        <span className="rounded bg-white/[0.06] px-1 text-[10px] whitespace-nowrap tabular-nums text-subtle">
          {subs.length} sub
        </span>
        {activeSubs > 0 && <StatusDot status="running" />}
        <ChevronDown className="size-3 text-subtle" />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} width={360}>
        <div className="px-3 pt-2.5 pb-1 text-[11px] font-medium text-subtle">
          Sessões deste chat
        </div>
        <div className="overflow-y-auto p-1 pt-0">{roots.map(renderNode)}</div>
      </Popover>
    </>
  )
}
