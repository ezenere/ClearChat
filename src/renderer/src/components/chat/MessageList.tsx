import {
  ArrowDown,
  Brain,
  ChevronRight,
  CircleAlert,
  Clock,
  Cpu,
  Layers,
  Maximize2,
  Minimize2,
  Pencil,
  RotateCcw,
  Trash2,
  X,
  Zap
} from 'lucide-react'
import { isContextLengthError, latestBoundaryIndex } from '@shared/context'
import { messageAttachments } from '@shared/attachments'
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { ApprovalRequest, Session, StoredMessage, StreamDraft } from '@shared/types'
import { api } from '../../lib/api'
import {
  cn,
  formatCost,
  formatDuration,
  formatTokens,
  messageText,
  withText
} from '../../lib/format'
import {
  isBusy,
  selectMessages,
  selectRuns,
  useStore,
  type CompactionState,
  type ToolRun
} from '../../store'
import { CompactionMessageInfo, MessageInfo } from '../apiDocs'
import { ApiInfo } from '../ui/Tooltip'
import { AutoTextarea, Button, Spinner } from '../ui/controls'
import { Tip } from '../ui/Tooltip'
import { CopyButton, Markdown } from './Markdown'
import { OrphanApproval, ToolCard } from './ToolCard'
import { MessageAttachments } from './Attachments'

// ---------- Bits ----------

type ReasoningView = 'closed' | 'box' | 'full'
/** Estado por mensagem (sobrevive a remontagens enquanto o app está aberto). */
const reasoningViews = new Map<string, ReasoningView>()

/**
 * Raciocínio da mensagem: fechado (só o cabeçalho) → caixa compacta com rolagem própria →
 * "expandir tudo" (texto inteiro na altura natural, sem rolagem interna). Enquanto o modelo
 * pensa, a caixa aparece sozinha; no modo expandido ela só cresce.
 */
function Reasoning({
  text,
  live,
  id
}: {
  text: string
  live?: boolean
  /** id da mensagem, para lembrar o estado; rascunhos não têm. */
  id?: string
}): React.JSX.Element {
  const [view, setViewState] = useState<ReasoningView>(
    () => (id && reasoningViews.get(id)) || 'closed'
  )
  const setView = (v: ReasoningView): void => {
    if (id) reasoningViews.set(id, v)
    setViewState(v)
  }
  const shown: ReasoningView = view === 'closed' && live ? 'box' : view
  const full = shown === 'full'
  return (
    <div className="mb-2">
      <div className="group/rsn -ml-1 flex items-center gap-0.5">
        <button
          type="button"
          onClick={() => setView(shown === 'closed' ? 'box' : 'closed')}
          aria-expanded={shown !== 'closed'}
          className="inline-flex items-center gap-1.5 rounded-md px-1 py-0.5 text-[12px] text-subtle hover:text-fg"
        >
          <Brain className={cn('size-3.5', live && 'animate-pulse-soft text-accent-strong')} />
          {live ? 'Pensando…' : 'Raciocínio'}
          <ChevronRight
            className={cn('size-3 transition-transform', shown !== 'closed' && 'rotate-90')}
          />
        </button>
        <Tip label={full ? 'Voltar para a caixa' : 'Expandir tudo'}>
          <button
            type="button"
            onClick={() => setView(full ? 'box' : 'full')}
            aria-label={full ? 'Voltar para a caixa' : 'Expandir tudo'}
            className={cn(
              'grid size-5 place-items-center rounded-md text-faint transition-opacity hover:bg-hover hover:text-fg',
              shown === 'closed' &&
                'opacity-0 group-hover/rsn:opacity-100 focus-visible:opacity-100'
            )}
          >
            {full ? <Minimize2 className="size-3" /> : <Maximize2 className="size-3" />}
          </button>
        </Tip>
      </div>
      {shown !== 'closed' && (
        <div
          className={cn(
            'mt-1.5 animate-fade-in border-l-2 border-border-strong pl-3.5 text-[12.5px] leading-relaxed whitespace-pre-wrap text-subtle',
            !full && 'max-h-72 overflow-y-auto'
          )}
        >
          {text}
        </div>
      )}
    </div>
  )
}

function UsageFooter({ msg }: { msg: StoredMessage }): React.JSX.Element | null {
  const u = msg.meta.usage
  const parts: ReactNode[] = []
  if (msg.meta.model)
    parts.push(
      <span key="m" className="truncate">
        {msg.meta.model}
      </span>
    )
  if (u) {
    parts.push(
      <Tip key="u" label="Tokens de entrada / saída / lidos do cache">
        <span className="tabular-nums">
          {formatTokens(u.promptTokens)} in · {formatTokens(u.completionTokens)} out
          {u.cachedTokens ? (
            <span className="text-success/70"> · {formatTokens(u.cachedTokens)} cache</span>
          ) : null}
          {u.reasoningTokens ? <> · {formatTokens(u.reasoningTokens)} raciocínio</> : null}
        </span>
      </Tip>
    )
    const cost = formatCost(u.cost)
    if (cost)
      parts.push(
        <span key="c" className="tabular-nums">
          {cost}
        </span>
      )
  }
  const d = formatDuration(msg.meta.durationMs)
  if (d)
    parts.push(
      <span key="d" className="tabular-nums">
        {d}
      </span>
    )
  if (parts.length === 0) return null
  return (
    <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-faint transition-colors group-hover/msg:text-subtle">
      <Cpu className="size-3 shrink-0" />
      {parts.map((p, i) => (
        <span key={i} className="flex min-w-0 items-center gap-1.5">
          {i > 0 && <span className="text-faint/60">·</span>}
          {p}
        </span>
      ))}
    </div>
  )
}

function ActionBtn({
  label,
  onClick,
  children,
  danger
}: {
  label: string
  onClick: () => void
  children: ReactNode
  danger?: boolean
}): React.JSX.Element {
  return (
    <Tip label={label}>
      <button
        type="button"
        onClick={onClick}
        aria-label={label}
        className={cn(
          'rounded-md p-1 text-subtle transition-colors hover:bg-hover',
          danger ? 'hover:text-danger' : 'hover:text-fg'
        )}
      >
        {children}
      </button>
    </Tip>
  )
}

function MessageActions({
  msg,
  canEdit,
  onEdit,
  onRegenerate,
  align = 'start'
}: {
  msg: StoredMessage
  canEdit: boolean
  onEdit: () => void
  onRegenerate?: () => void
  align?: 'start' | 'end'
}): React.JSX.Element {
  const run = useStore((s) => s.run)
  const [confirm, setConfirm] = useState(false)
  const text = messageText(msg.message.role === 'tool' ? msg.message.content : msg.message.content)
  return (
    <div
      className={cn(
        'flex items-center gap-0.5 opacity-0 transition-opacity group-hover/msg:opacity-100 focus-within:opacity-100',
        align === 'end' && 'justify-end',
        confirm && 'opacity-100'
      )}
      onMouseLeave={() => setConfirm(false)}
    >
      <MessageInfo msg={msg} />
      {text && <CopyButton text={text} label="" className="px-1" />}
      {canEdit && (
        <ActionBtn label="Editar" onClick={onEdit}>
          <Pencil className="size-3.5" />
        </ActionBtn>
      )}
      {canEdit &&
        (confirm ? (
          <button
            type="button"
            onClick={() => void run(() => api.messages.delete(msg.id), 'Erro ao apagar mensagem')}
            className="rounded-md bg-danger/10 px-1.5 py-0.5 text-[11px] text-danger hover:bg-danger/20"
          >
            Apagar?
          </button>
        ) : (
          <ActionBtn label="Apagar mensagem" onClick={() => setConfirm(true)} danger>
            <Trash2 className="size-3.5" />
          </ActionBtn>
        ))}
      {onRegenerate && (
        <ActionBtn label="Regenerar resposta" onClick={onRegenerate}>
          <RotateCcw className="size-3.5" />
        </ActionBtn>
      )}
    </div>
  )
}

function InlineEditor({
  initial,
  onCancel,
  onSave
}: {
  initial: string
  onCancel: () => void
  onSave: (text: string) => void
}): React.JSX.Element {
  const [text, setText] = useState(initial)
  return (
    <div className="w-full animate-fade-in">
      <AutoTextarea
        autoFocus
        value={text}
        minRows={2}
        maxRows={20}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation()
            onCancel()
          }
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) onSave(text)
        }}
        className="field leading-relaxed"
      />
      <div className="mt-2 flex items-center justify-end gap-2">
        <span className="mr-auto text-[11px] text-subtle">
          Edita o histórico salvo — não reenvia nada.
        </span>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancelar
        </Button>
        <Button size="sm" variant="primary" onClick={() => onSave(text)}>
          Salvar
        </Button>
      </div>
    </div>
  )
}

// ---------- Mensagens ----------

function UserMessage({
  msg,
  canEdit
}: {
  msg: StoredMessage
  canEdit: boolean
}): React.JSX.Element {
  const run = useStore((s) => s.run)
  const [editing, setEditing] = useState(false)
  const text = msg.message.role === 'user' ? messageText(msg.message.content) : ''
  const hasAttachments = messageAttachments(msg.message).length > 0
  const kind = msg.meta.kind
  return (
    <div className="group/msg flex animate-slide-up flex-col items-end gap-1 py-2">
      {editing ? (
        <InlineEditor
          initial={text}
          onCancel={() => setEditing(false)}
          onSave={(t) => {
            setEditing(false)
            void run(() => api.messages.update(msg.id, withText(msg.message, t)), 'Erro ao editar')
          }}
        />
      ) : (
        <>
          {(kind === 'queued' || kind === 'forced') && (
            <span className="flex items-center gap-1 text-[10.5px] text-subtle">
              {kind === 'forced' ? <Zap className="size-3 text-warning" /> : null}
              {kind === 'forced' ? 'enviada agora (interrompeu o agente)' : 'da fila'}
            </span>
          )}
          {msg.message.role === 'user' && Array.isArray(msg.message.content) && (
            <MessageAttachments parts={msg.message.content} />
          )}
          {(text || !hasAttachments) && (
            <div className="max-w-[85%] rounded-2xl rounded-br-md border border-border bg-elevated px-4 py-2.5 text-[14px] leading-relaxed whitespace-pre-wrap text-fg shadow-[0_1px_0_rgb(255_255_255/0.03)_inset]">
              {text}
            </div>
          )}
          <MessageActions msg={msg} canEdit={canEdit} onEdit={() => setEditing(true)} align="end" />
        </>
      )}
    </div>
  )
}

function SyntheticMessage({
  msg,
  canEdit
}: {
  msg: StoredMessage
  canEdit: boolean
}): React.JSX.Element {
  const m = msg.message
  const text = m.role === 'tool' ? m.content : messageText(m.content as string)
  const isToolResult = /^<tool_result/.test(text)
  return (
    <div className="group/msg flex items-center gap-2 py-1.5 pl-1 text-[12px] text-subtle">
      <span className="h-px w-4 bg-border-strong" />
      <span className="shrink-0">
        {isToolResult ? 'Resultado de tool (texto)' : 'Mensagem do app'} ·{' '}
        <span className="font-mono">{m.role}</span>
      </span>
      <MessageInfo msg={msg} />
      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-faint">{text}</span>
      {canEdit && (
        <span className="opacity-0 transition-opacity group-hover/msg:opacity-100">
          <ActionBtn
            label="Apagar mensagem"
            onClick={() => void useStore.getState().run(() => api.messages.delete(msg.id))}
            danger
          >
            <Trash2 className="size-3.5" />
          </ActionBtn>
        </span>
      )}
    </div>
  )
}

function ErrorRow({
  text,
  onDismiss,
  action
}: {
  text: string
  onDismiss?: () => void
  action?: ReactNode
}): React.JSX.Element {
  return (
    <div className="my-2 flex animate-slide-up items-start gap-2.5 rounded-xl border border-danger/25 bg-danger/[0.06] px-3.5 py-2.5 text-[12.5px] text-danger">
      <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="font-mono text-[11.5px] leading-relaxed break-words whitespace-pre-wrap">
          {text}
        </div>
        {action && <div className="mt-2">{action}</div>}
      </div>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          className="rounded p-0.5 text-danger/70 hover:text-danger"
        >
          <X className="size-3.5" />
        </button>
      )}
    </div>
  )
}

/** Erro HTTP/do modelo persistido (meta.kind 'error'): só exibição, nunca enviado à API. */
function ErrorMessage({ msg, ctx }: { msg: StoredMessage; ctx: Ctx }): React.JSX.Element {
  const run = useStore((s) => s.run)
  const text =
    msg.meta.error ??
    (msg.message.role === 'tool' ? msg.message.content : messageText(msg.message.content ?? ''))
  const canEdit = !ctx.readOnly && !ctx.busy
  const isLast = msg.id === ctx.lastAssistantId
  const ctxError = isLast && !ctx.readOnly && !ctx.busy && isContextLengthError(text)
  return (
    <div className="group/msg py-1">
      <ErrorRow
        text={text}
        action={ctxError ? <CompactRetryButton sessionId={ctx.sessionId} /> : undefined}
      />
      {canEdit && (
        <div className="-mt-1 flex items-center gap-0.5 opacity-0 transition-opacity group-hover/msg:opacity-100 focus-within:opacity-100">
          <MessageInfo msg={msg} />
          <ActionBtn
            label="Apagar mensagem"
            onClick={() => void run(() => api.messages.delete(msg.id), 'Erro ao apagar mensagem')}
            danger
          >
            <Trash2 className="size-3.5" />
          </ActionBtn>
          {isLast && (
            <ActionBtn
              label="Tentar de novo (regenerar)"
              onClick={() =>
                void run(() => api.agent.regenerate(ctx.sessionId), 'Erro ao regenerar')
              }
            >
              <RotateCcw className="size-3.5" />
            </ActionBtn>
          )}
        </div>
      )}
    </div>
  )
}

/** "Compactar e tentar de novo" — para erros de contexto excedido. */
function CompactRetryButton({ sessionId }: { sessionId: string }): React.JSX.Element {
  const compact = useStore((s) => s.compact)
  return (
    <Button
      size="sm"
      variant="secondary"
      icon={<Layers className="size-3.5 text-accent-strong" />}
      onClick={() => void compact(sessionId, true)}
    >
      Compactar e tentar de novo
    </Button>
  )
}

/** Conteúdo do resumo (entre as tags <conversation_summary>). */
function summaryOf(text: string): string {
  const m = /<conversation_summary>\n?([\s\S]*?)\n?<\/conversation_summary>/.exec(text)
  return (m ? m[1] : text).trim()
}

/** Fronteira de compactação: resumo enviado como role:user no início do histórico ativo. */
function CompactionCard({
  msg,
  canEdit,
  stale
}: {
  msg: StoredMessage
  canEdit: boolean
  /** Fronteira antiga (antes da mais recente): também não é mais enviada. */
  stale?: boolean
}): React.JSX.Element {
  const run = useStore((s) => s.run)
  const [open, setOpen] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const text = msg.message.role === 'user' ? messageText(msg.message.content) : ''
  const summary = summaryOf(text)
  const meta = msg.meta
  const u = meta.compactUsage
  const cost = formatCost(u?.cost)
  return (
    <div
      data-testid="compaction-card"
      className="group/msg my-3 animate-slide-up overflow-hidden rounded-xl border border-accent/25 bg-accent-soft/25"
    >
      <div className="flex items-center gap-2 px-3.5 pt-2.5 pb-1.5">
        <Layers className="size-3.5 shrink-0 text-accent-strong" />
        <span className="text-[12.5px] font-medium text-fg/90">Resumo da conversa</span>
        {stale ? (
          <span className="text-[11px] text-subtle">· substituído por um resumo mais recente</span>
        ) : (
          <span className="text-[11px] text-subtle">· início do histórico enviado</span>
        )}
        <CompactionMessageInfo msg={msg} side="left" />
        <div className="ml-auto flex items-center gap-0.5 opacity-0 transition-opacity group-hover/msg:opacity-100 focus-within:opacity-100">
          <CopyButton text={summary} label="" className="px-1" />
          {canEdit &&
            (confirm ? (
              <button
                type="button"
                onClick={() =>
                  void run(() => api.messages.delete(msg.id), 'Erro ao apagar o resumo')
                }
                onMouseLeave={() => setConfirm(false)}
                className="rounded-md bg-danger/10 px-1.5 py-0.5 text-[11px] text-danger hover:bg-danger/20"
              >
                Apagar? (volta a enviar tudo)
              </button>
            ) : (
              <ActionBtn
                label="Apagar resumo (desfaz a compactação)"
                onClick={() => setConfirm(true)}
                danger
              >
                <Trash2 className="size-3.5" />
              </ActionBtn>
            ))}
        </div>
      </div>
      <div className={cn('relative px-3.5 text-[13px]', !open && 'max-h-[132px] overflow-hidden')}>
        <Markdown text={summary} />
        {!open && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-[#16131f] to-transparent" />
        )}
      </div>
      <div className="flex items-center gap-2 px-3.5 pt-1 pb-2.5 text-[11px] text-subtle">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="shrink-0 rounded-md px-1 py-0.5 whitespace-nowrap text-accent-strong hover:bg-accent-soft"
        >
          {open ? 'Recolher' : 'Ver resumo completo'}
        </button>
        <span className="ml-auto flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap tabular-nums text-faint">
          {meta.usageBefore != null && (
            <>
              <Tip label="Contexto antes → estimativa logo depois (system + resumo)">
                <span>
                  {formatTokens(meta.usageBefore)} → ~{formatTokens(meta.contextEstimate)} tokens
                </span>
              </Tip>
            </>
          )}
          {meta.model && (
            <>
              <span>·</span>
              <span className="truncate">{meta.model}</span>
            </>
          )}
          {cost && (
            <>
              <span>·</span>
              <span>{cost}</span>
            </>
          )}
          {formatDuration(meta.durationMs) && (
            <>
              <span>·</span>
              <span>{formatDuration(meta.durationMs)}</span>
            </>
          )}
        </span>
      </div>
    </div>
  )
}

/** Compactação em andamento (resumo transmitido ao vivo) ou agendada. */
function LiveCompaction({ state }: { state: CompactionState }): React.JSX.Element {
  if (state.state === 'scheduled') {
    return (
      <div className="my-2 flex items-center gap-2 py-1 pl-1 text-[12px] text-subtle">
        <Clock className="size-3.5 text-accent-strong" />
        Compactação agendada para o próximo passo do agente.
      </div>
    )
  }
  return (
    <div
      data-testid="compaction-live"
      className="my-3 overflow-hidden rounded-xl border border-accent/25 bg-accent-soft/20"
    >
      <div className="flex items-center gap-2 px-3.5 pt-2.5 pb-1.5 text-[12.5px]">
        <Spinner className="size-3.5 text-accent-strong" />
        <span className="font-medium text-fg/90">Compactando conversa…</span>
        <span className="text-[11px] text-subtle">
          o modelo está resumindo o histórico (esta request não entra no histórico)
        </span>
      </div>
      {state.text && (
        <div className="max-h-72 overflow-y-auto px-3.5 pb-3 text-[13px]">
          <Markdown text={state.text} streaming />
        </div>
      )}
    </div>
  )
}

interface Ctx {
  chatId: string
  sessionId: string
  busy: boolean
  readOnly: boolean
  results: Map<string, StoredMessage>
  runs: Record<string, ToolRun>
  approvals: ApprovalRequest[]
  /** Aprovações de todas as sessões (para mostrar a do subagente no card de delegate). */
  allApprovals: ApprovalRequest[]
  childByToolCall: Map<string, Session>
  lastAssistantId: string | null
}

function AssistantMessage({ msg, ctx }: { msg: StoredMessage; ctx: Ctx }): React.JSX.Element {
  const run = useStore((s) => s.run)
  const [editing, setEditing] = useState(false)
  if (msg.message.role !== 'assistant') return <></>
  const m = msg.message
  const content = m.content ?? ''
  const canEdit = !ctx.readOnly && !ctx.busy
  const isLast = msg.id === ctx.lastAssistantId
  return (
    <div className="group/msg animate-slide-up py-2">
      {m.reasoning && <Reasoning text={m.reasoning} id={msg.id} />}
      {editing ? (
        <InlineEditor
          initial={content}
          onCancel={() => setEditing(false)}
          onSave={(t) => {
            setEditing(false)
            void run(() => api.messages.update(msg.id, withText(msg.message, t)), 'Erro ao editar')
          }}
        />
      ) : (
        content && <Markdown text={content} />
      )}
      {msg.meta.interrupted && (
        <div className="mt-1.5 inline-flex items-center gap-1 rounded-md bg-white/[0.04] px-1.5 py-0.5 text-[11px] text-subtle">
          <X className="size-3" /> Interrompida pelo usuário
        </div>
      )}
      {m.tool_calls?.map((tc) => {
        const sub = ctx.childByToolCall.get(tc.id)
        return (
          <ToolCard
            key={tc.id}
            call={{ id: tc.id, name: tc.function.name, arguments: tc.function.arguments }}
            result={ctx.results.get(tc.id)}
            run={ctx.runs[tc.id]}
            approval={ctx.approvals.find((a) => a.toolCallId === tc.id)}
            subApproval={sub ? ctx.allApprovals.find((a) => a.sessionId === sub.id) : undefined}
            sessionBusy={ctx.busy}
            subSession={sub}
            chatId={ctx.chatId}
          />
        )
      })}
      {msg.meta.error && <ErrorRow text={msg.meta.error} />}
      {!editing && (
        <div className="mt-1.5 flex min-h-6 items-center gap-3">
          <UsageFooter msg={msg} />
          <MessageActions
            msg={msg}
            canEdit={canEdit}
            onEdit={() => setEditing(true)}
            onRegenerate={
              isLast && canEdit
                ? () => void run(() => api.agent.regenerate(ctx.sessionId), 'Erro ao regenerar')
                : undefined
            }
          />
        </div>
      )}
    </div>
  )
}

function OrphanTool({ msg, canEdit }: { msg: StoredMessage; canEdit: boolean }): React.JSX.Element {
  const text = msg.message.role === 'tool' ? msg.message.content : ''
  return (
    <div className="group/msg py-1.5">
      <div className="rounded-xl border border-border bg-surface/70 px-3.5 py-2.5">
        <div className="mb-1 flex items-center gap-1.5 text-[11px] text-subtle">
          Resultado de tool <MessageInfo msg={msg} />
        </div>
        <pre className="max-h-60 overflow-auto font-mono text-[11.5px] whitespace-pre-wrap text-fg/80">
          {text}
        </pre>
      </div>
      <div className="mt-1">
        <MessageActions msg={msg} canEdit={canEdit} onEdit={() => {}} />
      </div>
    </div>
  )
}

const DraftView = memo(function DraftView({
  draft,
  ctx
}: {
  draft: StreamDraft
  ctx: Ctx
}): React.JSX.Element {
  return (
    <div className="py-2">
      {draft.reasoning && (
        <Reasoning text={draft.reasoning} live={!draft.content && !draft.toolCalls.length} />
      )}
      {(draft.content || (!draft.reasoning && !draft.toolCalls.length)) && (
        <Markdown text={draft.content} streaming={!draft.toolCalls.length} />
      )}
      {draft.toolCalls.map((tc, i) => (
        <ToolCard key={tc.id || i} call={tc} streaming sessionBusy chatId={ctx.chatId} />
      ))}
    </div>
  )
})

function Thinking(): React.JSX.Element {
  return (
    <div className="flex items-center gap-1 py-3 pl-0.5">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="size-1.5 animate-pulse-soft rounded-full bg-subtle"
          style={{ animationDelay: `${i * 160}ms` }}
        />
      ))}
    </div>
  )
}

// ---------- Lista ----------

export function MessageList({
  chatId,
  session,
  readOnly,
  empty
}: {
  chatId: string
  session: Session
  readOnly: boolean
  empty?: ReactNode
}): React.JSX.Element {
  const sessionId = session.id
  const messages = useStore(selectMessages(sessionId))
  const loaded = useStore((s) => sessionId in s.messages)
  const draft = useStore((s) => s.drafts[sessionId] ?? null)
  const runs = useStore(selectRuns(sessionId))
  const allApprovals = useStore((s) => s.approvals)
  const sessions = useStore((s) => s.sessions)
  const error = useStore((s) => s.errors[sessionId])
  const dismissError = useStore((s) => s.dismissError)
  const compaction = useStore((s) => s.compactions[sessionId])
  const [showOld, setShowOld] = useState(true)
  const busy = isBusy(session.status)
  const boundary = useMemo(() => latestBoundaryIndex(messages), [messages])

  const ctx = useMemo<Ctx>(() => {
    const results = new Map<string, StoredMessage>()
    for (const m of messages) if (m.message.role === 'tool') results.set(m.message.tool_call_id, m)
    const childByToolCall = new Map<string, Session>()
    for (const s of Object.values(sessions))
      if (s.parentSessionId === sessionId && s.parentToolCallId)
        childByToolCall.set(s.parentToolCallId, s)
    let lastAssistantId: string | null = null
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].message.role === 'assistant') {
        lastAssistantId = messages[i].id
        break
      }
      if (messages[i].message.role === 'user' && !messages[i].meta.synthetic) break
      if (messages[i].meta.kind === 'compaction') break
    }
    return {
      chatId,
      sessionId,
      busy,
      readOnly,
      results,
      runs,
      approvals: allApprovals.filter((a) => a.sessionId === sessionId),
      allApprovals,
      childByToolCall,
      lastAssistantId
    }
  }, [messages, sessions, sessionId, chatId, busy, readOnly, runs, allApprovals])

  // Tool calls conhecidas (para não duplicar resultados/aprovações).
  const knownCalls = useMemo(() => {
    const set = new Set<string>()
    for (const m of messages)
      if (m.message.role === 'assistant')
        for (const tc of m.message.tool_calls ?? []) set.add(tc.id)
    return set
  }, [messages])

  // ---- auto-scroll ----
  const scroller = useRef<HTMLDivElement>(null)
  const inner = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  const [atBottom, setAtBottom] = useState(true)

  useLayoutEffect(() => {
    pinned.current = true
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
  }, [sessionId, loaded])

  useEffect(() => {
    const el = scroller.current
    const content = inner.current
    if (!el || !content) return
    const ro = new ResizeObserver(() => {
      if (pinned.current) el.scrollTop = el.scrollHeight
    })
    ro.observe(content)
    return () => ro.disconnect()
  }, [])

  const onScroll = (): void => {
    const el = scroller.current
    if (!el) return
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60
    pinned.current = bottom
    if (bottom !== atBottom) setAtBottom(bottom)
  }

  // O erro do evento `error` também é persistido como mensagem (meta.kind 'error'): não duplica.
  const persistedError =
    !!error && messages.some((m) => m.meta.kind === 'error' && m.meta.error === error)

  const showThinking =
    busy &&
    !draft &&
    compaction?.state !== 'running' &&
    Object.values(runs).every((r) => !r.running) &&
    ctx.approvals.length === 0
  const canEdit = !readOnly && !busy

  const renderMessage = (m: StoredMessage, old: boolean): ReactNode => {
    const role = m.message.role
    if (m.meta.kind === 'compaction')
      return <CompactionCard key={m.id} msg={m} canEdit={canEdit} stale={old} />
    if (m.meta.kind === 'error') return <ErrorMessage key={m.id} msg={m} ctx={ctx} />
    if (m.meta.synthetic && role !== 'assistant') {
      if (role === 'tool' && knownCalls.has(m.message.tool_call_id)) return null
      return <SyntheticMessage key={m.id} msg={m} canEdit={canEdit} />
    }
    if (role === 'user') return <UserMessage key={m.id} msg={m} canEdit={canEdit} />
    if (role === 'assistant') return <AssistantMessage key={m.id} msg={m} ctx={ctx} />
    if (role === 'tool') {
      if (knownCalls.has(m.message.tool_call_id)) return null
      return <OrphanTool key={m.id} msg={m} canEdit={canEdit} />
    }
    return (
      <div key={m.id} className="flex items-center gap-1.5 py-1 text-[12px] text-subtle">
        system <ApiInfo code={messageText(m.message.content)} />
      </div>
    )
  }
  const oldMsgs = boundary > 0 ? messages.slice(0, boundary) : []
  const activeMsgs = boundary > 0 ? messages.slice(boundary) : messages
  const oldCount = oldMsgs.filter((m) => m.meta.kind !== 'error').length

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={scroller} onScroll={onScroll} className="absolute inset-0 overflow-y-auto">
        <div ref={inner} className="mx-auto w-full max-w-[780px] px-8 pt-6 pb-10">
          {loaded && messages.length === 0 && !draft && !busy && empty}
          {oldMsgs.length > 0 && showOld && (
            <div
              data-testid="compacted-old"
              className="opacity-[0.55] transition-opacity duration-200 hover:opacity-80"
            >
              {oldMsgs.map((m) => renderMessage(m, true))}
            </div>
          )}
          {oldMsgs.length > 0 && (
            <div data-testid="compaction-divider" className="my-4 flex items-center gap-3">
              <span className="h-px flex-1 bg-gradient-to-r from-transparent to-border-strong" />
              <span className="flex items-center gap-1.5 text-[11.5px] text-subtle">
                <Layers className="size-3.5 text-accent-strong/80" />
                <span className="font-medium text-muted">Conversa compactada</span>
                <span className="text-faint">·</span>
                {oldCount} {oldCount === 1 ? 'mensagem resumida' : 'mensagens resumidas'}
                <span className="text-faint">·</span>
                não são mais enviadas à API
                <button
                  type="button"
                  onClick={() => setShowOld((v) => !v)}
                  className="ml-1 rounded-md px-1.5 py-0.5 text-accent-strong hover:bg-accent-soft"
                >
                  {showOld ? 'Ocultar' : 'Mostrar'}
                </button>
              </span>
              <span className="h-px flex-1 bg-gradient-to-l from-transparent to-border-strong" />
            </div>
          )}
          {activeMsgs.map((m) => renderMessage(m, false))}
          {compaction && <LiveCompaction state={compaction} />}
          {draft && <DraftView draft={draft} ctx={ctx} />}
          {ctx.approvals
            .filter((a) => !knownCalls.has(a.toolCallId))
            .map((a) => (
              <OrphanApproval key={a.id} request={a} />
            ))}
          {showThinking && <Thinking />}
          {error && !persistedError && (
            <ErrorRow
              text={error}
              onDismiss={() => dismissError(sessionId)}
              action={
                !readOnly && !busy && isContextLengthError(error) ? (
                  <CompactRetryButton sessionId={sessionId} />
                ) : undefined
              }
            />
          )}
        </div>
      </div>
      {!atBottom && (
        <button
          type="button"
          onClick={() => {
            const el = scroller.current
            if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
          }}
          className="absolute bottom-3 left-1/2 flex size-8 -translate-x-1/2 animate-pop-in items-center justify-center rounded-full border border-border-strong bg-elevated text-muted shadow-popover hover:text-fg"
          aria-label="Ir para o fim"
        >
          <ArrowDown className="size-4" />
        </button>
      )}
    </div>
  )
}
