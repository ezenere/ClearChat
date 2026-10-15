import { Bot, Check, ChevronDown, ChevronRight, MessageSquare, Square } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import type { Session, SessionStatus } from '@shared/types'
import { cn, sessionLabel } from '../../lib/format'
import { isBusy, useStore } from '../../store'
import { api } from '../../lib/api'
import { Popover } from '../ui/layers'
import { ModelLabel } from '../ui/ModelLabel'
import { sessionProviderId } from '@shared/models'

const STATUS_LABEL: Record<SessionStatus, string> = {
  idle: 'ociosa',
  running: 'executando',
  awaiting_approval: 'aguardando aprovação',
  awaiting_input: 'aguardando sua resposta',
  done: 'concluída',
  error: 'erro',
  interrupted: 'interrompida',
  waiting: 'aguardando subagentes'
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
        status === 'waiting' && 'bg-accent-strong/50 ring-2 ring-accent-strong/20',
        (status === 'awaiting_approval' || status === 'awaiting_input') && 'bg-warning',
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
  const run = useStore((s) => s.run)
  const [open, setOpen] = useState(false)
  /** Nós recolhidos (sessões com subagentes). */
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
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
  const activeSubs = subs.filter((s) => isBusy(s.status)).length
  const counts = new Map<SessionStatus, number>()
  for (const s of subs) counts.set(s.status, (counts.get(s.status) ?? 0) + 1)
  const countText = (
    [
      ['running', 'executando'],
      ['awaiting_approval', 'aprovação'],
      ['awaiting_input', 'aguardando resposta'],
      ['waiting', 'aguardando'],
      ['done', 'concluídas'],
      ['error', 'erro'],
      ['interrupted', 'interrompidas']
    ] as [SessionStatus, string][]
  )
    .filter(([k]) => counts.get(k))
    .map(([k, l]) => `${counts.get(k)} ${l}`)
    .join(' · ')

  const toggle = (id: string): void =>
    setCollapsed((c) => {
      const n = new Set(c)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })

  const renderNode = (s: Session): React.JSX.Element => {
    const kids = children.get(s.id) ?? []
    const isCollapsed = collapsed.has(s.id)
    const busyKids = kids.filter((k) => isBusy(k.status)).length
    return (
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
          {kids.length > 0 && s.depth > 0 ? (
            <span
              role="button"
              tabIndex={-1}
              aria-label={isCollapsed ? 'Expandir' : 'Recolher'}
              onClick={(e) => {
                e.stopPropagation()
                toggle(s.id)
              }}
              className="-ml-4 rounded p-0.5 text-faint hover:text-fg"
            >
              <ChevronRight
                className={cn('size-3 transition-transform', !isCollapsed && 'rotate-90')}
              />
            </span>
          ) : null}
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
          {kids.length > 0 && s.depth > 0 && (
            <span className="shrink-0 rounded bg-white/[0.06] px-1 text-[10px] tabular-nums text-subtle">
              {busyKids ? `${busyKids}/${kids.length}` : kids.length}
            </span>
          )}
          <StatusDot status={s.status} />
          {s.id === currentId && <Check className="size-3.5 shrink-0 text-accent-strong" />}
        </button>
        {!isCollapsed && kids.map(renderNode)}
      </div>
    )
  }

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
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchor={anchor}
        width={380}
        maxHeight={520}
      >
        <div className="shrink-0 px-3 pt-2.5 pb-1">
          <div className="text-[11px] font-medium text-subtle">
            Sessões deste chat · {subs.length} {subs.length === 1 ? 'subagente' : 'subagentes'}
          </div>
          {countText && (
            <div data-testid="session-counts" className="mt-0.5 text-[10.5px] text-faint">
              {countText}
            </div>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-1 pt-0">{roots.map(renderNode)}</div>
        {activeSubs > 0 && (
          <div className="shrink-0 border-t border-border p-1">
            <button
              type="button"
              onClick={() => {
                setOpen(false)
                void run(() => api.agent.stopSubagents(chatId), 'Falha ao parar subagentes')
              }}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12.5px] text-danger/90 hover:bg-danger/10"
            >
              <Square className="size-3" fill="currentColor" />
              Parar todos os subagentes
              <span className="ml-auto text-[10.5px] text-faint tabular-nums">
                {activeSubs} ativos
              </span>
            </button>
          </div>
        )}
      </Popover>
    </>
  )
}
