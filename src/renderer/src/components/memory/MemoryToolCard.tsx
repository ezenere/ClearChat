// Corpo dos cards das tools de memória (memory_search/read/write/rewrite/delete): mudanças feitas
// (chips com link para Configurações → Memórias), memórias encontradas/lidas e as operações pedidas.
import {
  BookOpenText,
  BookSearch,
  Eraser,
  FilePlus2,
  NotebookPen,
  PencilLine,
  Replace,
  Trash2,
  type LucideIcon
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { MEMORY_CATEGORY_LABELS, type Memory, type MemoryCollection } from '@shared/memory'
import type { StoredMessage } from '@shared/types'
import { api } from '../../lib/api'
import { cn } from '../../lib/format'
import {
  CHANGE_LABEL,
  memoryChangesOf,
  memoryIdsIn,
  plainMemoryText,
  type MemoryChange,
  type MemoryToolName
} from '../../lib/memory'
import { useStore } from '../../store'

export const MEMORY_TOOL_ICONS: Record<MemoryToolName, LucideIcon> = {
  memory_search: BookSearch,
  memory_read: BookOpenText,
  memory_write: NotebookPen,
  memory_rewrite: Replace,
  memory_delete: Eraser
}

// Lista de memórias compartilhada pelos cards (uma busca por `memory-changed`, não uma por card).
let cache: { tick: number; promise: Promise<Memory[]> } | null = null
function useKnownMemories(enabled: boolean): Memory[] | null {
  const tick = useStore((s) => s.memoryTick)
  const [list, setList] = useState<Memory[] | null>(null)
  useEffect(() => {
    if (!enabled) return
    if (!cache || cache.tick !== tick)
      cache = { tick, promise: api.memory.list().catch(() => [] as Memory[]) }
    let alive = true
    void cache.promise.then((l) => alive && setList(l))
    return () => {
      alive = false
    }
  }, [tick, enabled])
  return list
}

const OP_ICON: Record<MemoryChange['op'], LucideIcon> = {
  create: FilePlus2,
  update: PencilLine,
  delete: Trash2
}

/** Chips das mudanças (`meta.memoryChanges` ou `changes` da extração). */
export function MemoryChangeChips({
  changes,
  cols,
  className
}: {
  changes: MemoryChange[]
  cols: MemoryCollection[]
  className?: string
}): React.JSX.Element | null {
  const openMemory = useStore((s) => s.openMemory)
  if (!changes.length) return null
  return (
    <div data-testid="memory-changes" className={cn('flex flex-wrap gap-1.5', className)}>
      {changes.map((c, i) => {
        const Icon = OP_ICON[c.op]
        const col = cols.find((x) => x.id === c.collectionId)
        const where = col ? (col.scope === 'chat' ? 'Este chat' : col.name) : null
        const body = (
          <>
            <Icon className="size-3 shrink-0" />
            <span className="text-[10.5px] opacity-80">{CHANGE_LABEL[c.op]}</span>
            <span className="max-w-[220px] truncate">{c.title || c.memoryId}</span>
            {where && <span className="text-[10.5px] text-faint">· {where}</span>}
          </>
        )
        const cls = cn(
          'inline-flex max-w-full items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11.5px]',
          c.op === 'create' && 'border-success/25 bg-success/[0.06] text-success/95',
          c.op === 'update' && 'border-accent/25 bg-accent-soft/40 text-accent-strong',
          c.op === 'delete' && 'border-border bg-bg/40 text-subtle line-through decoration-faint'
        )
        return c.op === 'delete' ? (
          <span key={i} data-op={c.op} className={cls}>
            {body}
          </span>
        ) : (
          <button
            key={i}
            type="button"
            data-op={c.op}
            title="Abrir em Configurações → Memórias"
            onClick={() => openMemory({ memoryId: c.memoryId })}
            className={cn(cls, 'hover:brightness-125')}
          >
            {body}
          </button>
        )
      })}
    </div>
  )
}

/** Linhas de memórias (encontradas / lidas) com link. */
function MemoryLinks({
  ids,
  known,
  cols
}: {
  ids: string[]
  known: Memory[]
  cols: MemoryCollection[]
}): React.JSX.Element | null {
  const openMemory = useStore((s) => s.openMemory)
  if (!ids.length) return null
  return (
    <div data-testid="memory-found" className="space-y-0.5">
      {ids.slice(0, 8).map((id) => {
        const m = known.find((x) => x.id === id)
        const col = m ? cols.find((c) => c.id === m.collectionId) : undefined
        return (
          <button
            key={id}
            type="button"
            disabled={!m}
            onClick={() => openMemory({ memoryId: id })}
            className="flex w-full items-baseline gap-2 rounded-md px-1.5 py-0.5 text-left text-[12px] hover:bg-hover/50 disabled:hover:bg-transparent"
          >
            <span className={cn('min-w-0 truncate', m ? 'text-fg/90' : 'font-mono text-subtle')}>
              {m ? m.title : id}
            </span>
            {m && (
              <span className="min-w-0 flex-1 truncate text-[11px] text-subtle">
                {plainMemoryText(m.summary, known)}
              </span>
            )}
            {m && (
              <span className="shrink-0 text-[10.5px] text-faint">
                {MEMORY_CATEGORY_LABELS[m.category]}
                {col ? ` · ${col.scope === 'chat' ? 'Este chat' : col.name}` : ''}
              </span>
            )}
          </button>
        )
      })}
      {ids.length > 8 && <p className="px-1.5 text-[11px] text-faint">+ {ids.length - 8}</p>}
    </div>
  )
}

type Op = { op?: unknown; fact?: unknown; with?: unknown }

/** Operações pedidas por memory_write/memory_rewrite (prévia compacta; os argumentos completos ficam no expandir). */
function OpsPreview({ args }: { args: Record<string, unknown> | null }): React.JSX.Element | null {
  const ops = (Array.isArray(args?.ops) ? (args.ops as Op[]) : []).filter(
    (o) => o && typeof o.fact === 'string'
  )
  const facts = Array.isArray(args?.facts)
    ? (args.facts as unknown[]).filter((f): f is string => typeof f === 'string')
    : []
  const summary = typeof args?.summary === 'string' ? args.summary : ''
  if (!ops.length && !facts.length && !summary) return null
  const sign = (op: unknown): string => (op === 'add' ? '+' : op === 'remove' ? '−' : '~')
  const lines = ops.length
    ? ops.map((o) =>
        o.op === 'replace' && typeof o.with === 'string'
          ? `~ ${String(o.fact)} → ${o.with}`
          : `${sign(o.op)} ${String(o.fact)}`
      )
    : facts.map((f) => `• ${f}`)
  return (
    <div className="space-y-0.5 text-[12px] leading-relaxed">
      {summary && <p className="text-muted">{summary}</p>}
      {lines.slice(0, 5).map((l, i) => (
        <p
          key={i}
          className={cn(
            'truncate font-mono text-[11.5px]',
            l.startsWith('+')
              ? 'text-success/85'
              : l.startsWith('−')
                ? 'text-danger/80'
                : 'text-fg/80'
          )}
        >
          {l}
        </p>
      ))}
      {lines.length > 5 && <p className="text-[11px] text-faint">+ {lines.length - 5}</p>}
    </div>
  )
}

export function MemoryToolBody({
  name,
  args,
  result,
  resultText
}: {
  name: MemoryToolName
  args: Record<string, unknown> | null
  result?: StoredMessage
  resultText: string
}): React.JSX.Element | null {
  const cols = useStore((s) => s.memoryCollections)
  const changes = memoryChangesOf(result?.meta)
  const lookup = name === 'memory_search' || name === 'memory_read'
  const known = useKnownMemories(lookup && !!result)
  const ok = result?.meta.toolStatus == null || result.meta.toolStatus === 'ok'
  let ids: string[] = []
  if (lookup && result && ok && known) {
    ids = memoryIdsIn(resultText, known)
    if (name === 'memory_read' && Array.isArray(args?.ids))
      for (const x of args.ids) if (typeof x === 'string' && !ids.includes(x)) ids.push(x)
  }
  const ops = name === 'memory_write' || name === 'memory_rewrite'
  const nothingFound =
    name === 'memory_search' && !!result && ok && !!known?.length && ids.length === 0
  const content =
    changes.length > 0 || ids.length > 0 || nothingFound || (ops && !changes.length && !!args)
  if (!content) return null
  return (
    <div
      data-testid="memory-tool-body"
      className="space-y-2 border-t border-border/70 px-3.5 py-2.5"
    >
      {ops && !changes.length && <OpsPreview args={args} />}
      <MemoryChangeChips changes={changes} cols={cols} />
      {lookup && <MemoryLinks ids={ids} known={known ?? []} cols={cols} />}
      {nothingFound && <p className="text-[11.5px] text-subtle">Nenhuma memória encontrada.</p>}
    </div>
  )
}
