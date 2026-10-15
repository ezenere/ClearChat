import {
  Ban,
  Bot,
  Check,
  ChevronRight,
  CircleX,
  Cpu,
  FilePen,
  FilePlus,
  FileSearch,
  FileText,
  FolderOpen,
  FolderSearch,
  FolderTree,
  Globe,
  Hand,
  Search,
  Terminal,
  Wrench,
  ArrowUpRight,
  type LucideIcon
} from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { TOOL_LABELS } from '@shared/tools'
import { approxTokens } from '@shared/limits'
import type { ApprovalRequest, Session, StoredMessage, ToolName } from '@shared/types'
import { cn, formatTokens, prettyJson } from '../../lib/format'
import { useStore, type ToolRun } from '../../store'
import { MessageInfo, TaskInfo } from '../apiDocs'
import { ApiInfo, C, Tip } from '../ui/Tooltip'
import { Button, Spinner } from '../ui/controls'
import { CopyButton } from './Markdown'

const ICONS: Record<ToolName, LucideIcon> = {
  list_dir: FolderTree,
  read_file: FileText,
  search_files: FileSearch,
  find_files: FolderSearch,
  write_file: FilePlus,
  edit_file: FilePen,
  bash: Terminal,
  web_search: Search,
  browse_url: Globe,
  list_models: Cpu,
  delegate_task: Bot
}

export interface ToolCallView {
  id: string
  name: string
  arguments: string
}

function parseArgs(raw: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(raw)
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function summary(name: string, args: Record<string, unknown> | null): string {
  if (!args) return ''
  const pick = (k: string): string => (typeof args[k] === 'string' ? (args[k] as string) : '')
  switch (name) {
    case 'bash':
      return pick('command')
    case 'web_search':
      return pick('query')
    case 'browse_url':
      return pick('url')
    case 'delegate_task':
      return pick('title') || pick('task')
    case 'search_files': {
      const where = [pick('glob'), pick('path')].filter(Boolean).join(' · ')
      return `/${pick('pattern')}/${where ? `  ${where}` : ''}`
    }
    case 'list_models':
      return [
        pick('query') && `"${pick('query')}"`,
        args.tools_only === true && 'tools',
        args.free_only === true && 'grátis',
        pick('sort') && `por ${pick('sort')}`,
        args.limit != null && `limite ${String(args.limit)}`
      ]
        .filter(Boolean)
        .join(' · ')
    case 'find_files':
      return pick('glob') + (pick('path') ? `  ${pick('path')}` : '')
    case 'read_file': {
      const o = Number(args.offset ?? 1) || 1
      const l = args.limit != null ? Number(args.limit) : null
      const range =
        args.offset == null && l == null
          ? ''
          : l
            ? `  · linhas ${o}–${o + l - 1}`
            : `  · a partir da linha ${o}`
      return pick('path') + range
    }
    default:
      return pick('path') || (name === 'list_dir' ? '.' : '')
  }
}

type Status =
  'streaming' | 'running' | 'approval' | 'ok' | 'error' | 'denied' | 'cancelled' | 'pending'

function StatusChip({ status }: { status: Status }): React.JSX.Element | null {
  const map: Record<Status, { label: string; cls: string; icon: ReactNode }> = {
    streaming: { label: 'gerando', cls: 'text-subtle', icon: <Spinner className="size-3" /> },
    running: {
      label: 'executando',
      cls: 'text-accent-strong',
      icon: <Spinner className="size-3 text-accent-strong" />
    },
    approval: {
      label: 'aguardando aprovação',
      cls: 'text-warning',
      icon: <Hand className="size-3" />
    },
    ok: { label: 'ok', cls: 'text-success/90', icon: <Check className="size-3" /> },
    error: { label: 'erro', cls: 'text-danger', icon: <CircleX className="size-3" /> },
    denied: { label: 'negada', cls: 'text-danger/90', icon: <Ban className="size-3" /> },
    cancelled: { label: 'interrompida', cls: 'text-subtle', icon: <Ban className="size-3" /> },
    pending: { label: 'pendente', cls: 'text-faint', icon: null }
  }
  const s = map[status]
  return (
    <span className={cn('inline-flex shrink-0 items-center gap-1 text-[11px]', s.cls)}>
      {s.icon}
      {s.label}
    </span>
  )
}

function ApprovalPrompt({
  request,
  fromSubagent
}: {
  request: ApprovalRequest
  fromSubagent?: boolean
}): React.JSX.Element {
  const approve = useStore((s) => s.approve)
  const detail = fromSubagent
    ? summary(request.toolName, request.args as Record<string, unknown>)
    : ''
  return (
    <div className="border-t border-warning/20 bg-warning/[0.045] px-3.5 py-3">
      <div className="flex items-center gap-2 text-[13px] text-fg">
        <Hand className="size-3.5 shrink-0 text-warning" />
        <span className="min-w-0">
          Permitir que {fromSubagent ? 'o subagente' : 'o agente'} execute <C>{request.toolName}</C>
          ?
        </span>
      </div>
      {detail && (
        <pre className="mt-2 max-h-40 overflow-auto rounded-lg bg-bg/70 px-3 py-2 font-mono text-[11.5px] whitespace-pre-wrap text-fg/85">
          {detail}
        </pre>
      )}
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <Button variant="primary" size="sm" onClick={() => void approve(request.id, 'allow')}>
          Permitir
        </Button>
        <Button variant="secondary" size="sm" onClick={() => void approve(request.id, 'deny')}>
          Negar
        </Button>
        <Button variant="ghost" size="sm" onClick={() => void approve(request.id, 'always')}>
          Sempre neste chat
        </Button>
      </div>
    </div>
  )
}

function Section({
  label,
  info,
  text,
  live
}: {
  label: string
  info?: ReactNode
  text: string
  live?: boolean
}): React.JSX.Element {
  return (
    <div className="px-3.5 py-2.5">
      <div className="mb-1.5 flex items-center gap-1.5">
        <span className="text-[11px] font-medium text-subtle">{label}</span>
        {info}
        {live && <span className="size-1.5 animate-pulse-soft rounded-full bg-accent-strong" />}
        <CopyButton text={text} className="-my-1 ml-auto" />
      </div>
      <pre className="max-h-80 overflow-auto rounded-lg bg-bg/70 px-3 py-2 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-fg/85">
        {text || <span className="text-faint italic">(vazio)</span>}
      </pre>
    </div>
  )
}

export function ToolCard({
  call,
  result,
  run,
  approval,
  subApproval,
  streaming,
  subSession,
  chatId
}: {
  call: ToolCallView
  result?: StoredMessage
  run?: ToolRun
  approval?: ApprovalRequest
  /** Aprovação pendente na subsessão criada por este delegate_task. */
  subApproval?: ApprovalRequest
  streaming?: boolean
  /** (legado; o status agora vem de `tool-running`) */
  sessionBusy?: boolean
  subSession?: Session
  chatId: string
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const openChat = useStore((s) => s.openChat)
  const args = parseArgs(call.arguments)
  const name = call.name as ToolName
  const Icon = ICONS[name] ?? Wrench
  const isDelegate = name === 'delegate_task'
  const resultText = result && result.message.role === 'tool' ? result.message.content : ''

  // Tools rodam em sequência: sem `tool-running` ainda, a chamada está só na fila ('pendente').
  const status: Status = streaming
    ? 'streaming'
    : approval || subApproval
      ? 'approval'
      : run?.running
        ? 'running'
        : result
          ? (result.meta.toolStatus ?? 'ok')
          : 'pending'

  const expanded = open || !!approval
  const subId = result?.meta.subSessionId ?? subSession?.id
  const label = TOOL_LABELS[name] ?? call.name
  const sum = summary(call.name, args)
  const root = useStore((s) => s.chats.find((c) => c.id === chatId)?.config.cwd)
  const shellCwd = result?.meta.shellCwd
  const shellRel =
    shellCwd && root
      ? shellCwd === root
        ? '.'
        : shellCwd.startsWith(root + '/')
          ? './' + shellCwd.slice(root.length + 1)
          : shellCwd
      : null

  return (
    <div
      className={cn(
        'my-2 overflow-hidden rounded-xl border bg-surface/70 transition-colors',
        approval ? 'border-warning/35 shadow-[0_0_0_3px_rgb(245_181_68/0.06)]' : 'border-border'
      )}
    >
      <div
        role="button"
        tabIndex={0}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => e.key === 'Enter' && setOpen((o) => !o)}
        className="group flex h-9 items-center gap-2.5 px-3 hover:bg-white/[0.015]"
      >
        <ChevronRight
          className={cn(
            'size-3.5 shrink-0 text-faint transition-transform duration-150',
            expanded && 'rotate-90'
          )}
        />
        <Icon
          className={cn('size-3.5 shrink-0', isDelegate ? 'text-accent-strong' : 'text-muted')}
        />
        <span className="shrink-0 text-[12.5px] font-medium text-fg/90">{label}</span>
        {sum && (
          <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-subtle">{sum}</span>
        )}
        {!sum && <span className="flex-1" />}
        {shellRel && (
          <Tip
            label={`Diretório do shell após o comando: ${shellCwd} — a próxima chamada começa aqui`}
          >
            <span
              data-testid="shell-cwd"
              className="flex max-w-[160px] shrink-0 items-center gap-1 truncate font-mono text-[10.5px] text-faint"
            >
              <FolderOpen className="size-3 shrink-0" />
              <span className="truncate">{shellRel}</span>
            </span>
          </Tip>
        )}
        {result && (
          <Tip
            label={`Enviado ao modelo: ${resultText.length.toLocaleString('pt-BR')} caracteres ≈ ${approxTokens(resultText.length).toLocaleString('pt-BR')} tokens (caracteres ÷ 4)`}
          >
            <span
              data-testid="tool-size"
              className="shrink-0 text-[10.5px] tabular-nums text-faint"
            >
              ~{formatTokens(approxTokens(resultText.length))} tok
            </span>
          </Tip>
        )}
        <StatusChip status={status} />
      </div>

      {isDelegate && !streaming && (
        <div className="flex items-center gap-3 border-t border-border/70 px-3.5 py-2.5">
          <p className="line-clamp-2 min-w-0 flex-1 text-[12.5px] leading-relaxed text-muted">
            {typeof args?.task === 'string' ? args.task : ''}
          </p>
          <TaskInfo task={typeof args?.task === 'string' ? args.task : null} side="left" />
          {subId && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => void openChat(chatId, subId)}
              icon={<ArrowUpRight className="size-3.5" />}
            >
              Abrir subsessão
            </Button>
          )}
        </div>
      )}

      {expanded && (
        <div className="animate-fade-in divide-y divide-border/70 border-t border-border/70">
          <Section
            label="Argumentos"
            text={prettyJson(call.arguments)}
            info={
              <ApiInfo title="Argumentos da chamada">
                <p>
                  Gerados pelo modelo e mantidos no histórico dentro de{' '}
                  <C>tool_calls[].function.arguments</C> (string JSON) da mensagem{' '}
                  <C>{'role: "assistant"'}</C>, id <C>{call.id}</C>.
                </p>
              </ApiInfo>
            }
          />
          {run?.running && run.output != null && !result && (
            <Section label="Saída (ao vivo)" text={run.output} live />
          )}
          {result && (
            <Section
              label={`Resultado · ${resultText.length.toLocaleString('pt-BR')} caracteres ≈ ${approxTokens(resultText.length).toLocaleString('pt-BR')} tokens`}
              text={resultText}
              info={<MessageInfo msg={result} side="left" />}
            />
          )}
        </div>
      )}
      {approval && <ApprovalPrompt request={approval} />}
      {!approval && subApproval && <ApprovalPrompt request={subApproval} fromSubagent />}
    </div>
  )
}

export function OrphanApproval({ request }: { request: ApprovalRequest }): React.JSX.Element {
  return (
    <div className="my-2 overflow-hidden rounded-xl border border-warning/35 bg-surface/70">
      <div className="px-3.5 pt-3 font-mono text-[11.5px] whitespace-pre-wrap text-muted">
        {JSON.stringify(request.args, null, 2)}
      </div>
      <ApprovalPrompt request={request} />
    </div>
  )
}
