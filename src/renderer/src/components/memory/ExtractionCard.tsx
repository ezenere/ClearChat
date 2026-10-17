// Card da extração de memórias (mensagem só de exibição `meta.kind: 'memory-extraction'`): contagem,
// lista de mudanças (links), modelo/custo, (i) com a request exata. Não é enviado à API.
import { BrainCircuit, ChevronRight, CircleAlert, Trash2 } from 'lucide-react'
import { useState } from 'react'
import type { StoredMessage } from '@shared/types'
import { api } from '../../lib/api'
import { formatTime, formatFullDateTime } from '../../lib/dates'
import { cn, formatCost, formatTokens } from '../../lib/format'
import { extractionCounts, extractionOf } from '../../lib/memory'
import { useStore } from '../../store'
import { ExtractionMessageInfo } from '../apiDocs'
import { ModelLabel } from '../ui/ModelLabel'
import { Tip } from '../ui/Tooltip'
import { MemoryChangeChips } from './MemoryToolCard'

export function ExtractionCard({
  msg,
  canEdit
}: {
  msg: StoredMessage
  canEdit: boolean
}): React.JSX.Element | null {
  const ex = extractionOf(msg.meta)
  const cols = useStore((s) => s.memoryCollections)
  const run = useStore((s) => s.run)
  const [open, setOpen] = useState(false)
  const [confirm, setConfirm] = useState(false)
  if (!ex) return null
  const failed = !!ex.error
  const total = ex.created + ex.updated + ex.deleted
  const cost = formatCost(ex.usage?.cost)
  const tokens = ex.usage ? ex.usage.promptTokens + ex.usage.completionTokens : 0
  return (
    <div
      data-testid="memory-extraction-card"
      data-failed={failed || undefined}
      className={cn(
        'group/msg my-2 animate-slide-up overflow-hidden rounded-xl border bg-surface/60',
        failed ? 'border-danger/25' : 'border-border'
      )}
      onMouseLeave={() => setConfirm(false)}
    >
      <div className="flex min-h-9 items-center gap-2 pr-3">
        <button
          type="button"
          aria-expanded={open}
          disabled={total === 0}
          onClick={() => setOpen((o) => !o)}
          className="flex min-w-0 flex-1 items-center gap-2 self-stretch py-1.5 pl-3 text-left enabled:hover:bg-white/[0.015]"
        >
          <ChevronRight
            className={cn(
              'size-3.5 shrink-0 text-faint transition-transform duration-150',
              open && 'rotate-90',
              total === 0 && 'opacity-0'
            )}
          />
          {failed ? (
            <CircleAlert className="size-3.5 shrink-0 text-danger" />
          ) : (
            <BrainCircuit className="size-3.5 shrink-0 text-accent-strong" />
          )}
          <span className="shrink-0 text-[12.5px] font-medium text-fg/90">
            Extração de memórias
          </span>
          <span
            data-testid="memory-extraction-summary"
            className={cn(
              'min-w-0 flex-1 truncate text-[12px]',
              failed ? 'text-danger/90' : 'text-subtle'
            )}
          >
            · {failed ? 'falhou' : total ? extractionCounts(ex) : 'nada novo para gravar'}
            <span className="text-faint">
              {' '}
              · {ex.trigger === 'compaction' ? 'após compactar' : 'manual'}
            </span>
          </span>
        </button>
        <span className="flex shrink-0 items-center gap-1.5">
          {ex.model && (
            <ModelLabel
              providerId={ex.providerId}
              model={ex.model}
              short
              className="max-w-[170px] text-[11px] text-faint"
              modelClassName="font-mono"
            />
          )}
          {(cost || tokens > 0) && (
            <Tip
              label={
                ex.usage
                  ? `${formatTokens(ex.usage.promptTokens)} entrada · ${formatTokens(ex.usage.completionTokens)} saída${cost ? ` · ${cost}` : ''}`
                  : ''
              }
            >
              <span className="text-[11px] text-faint tabular-nums">
                {cost ?? `${formatTokens(tokens)} tok`}
              </span>
            </Tip>
          )}
          <ExtractionMessageInfo extraction={ex} side="left" />
          {canEdit &&
            (confirm ? (
              <button
                type="button"
                onClick={() => void run(() => api.messages.delete(msg.id), 'Erro ao apagar o card')}
                className="rounded-md bg-danger/10 px-1.5 py-0.5 text-[11px] text-danger hover:bg-danger/20"
              >
                Apagar card?
              </button>
            ) : (
              <Tip label="Apagar card (as memórias continuam)">
                <button
                  type="button"
                  aria-label="Apagar card da extração"
                  onClick={() => setConfirm(true)}
                  className="rounded-md p-1 text-subtle opacity-0 transition-opacity group-hover/msg:opacity-100 hover:bg-hover hover:text-danger focus-visible:opacity-100"
                >
                  <Trash2 className="size-3.5" />
                </button>
              </Tip>
            ))}
        </span>
      </div>
      {failed && (
        <p className="border-t border-danger/15 bg-danger/[0.04] px-3.5 py-2 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-danger/90">
          {ex.error}
        </p>
      )}
      {open && total > 0 && (
        <div className="animate-fade-in border-t border-border/70 px-3.5 py-2.5">
          <MemoryChangeChips changes={ex.changes} cols={cols} />
        </div>
      )}
      <div className="flex items-center gap-2 border-t border-border/50 px-3.5 py-1 text-[10.5px] text-faint">
        <span>Só exibição — não é enviado à API</span>
        <Tip label={formatFullDateTime(msg.createdAt)}>
          <span className="ml-auto tabular-nums">{formatTime(msg.createdAt)}</span>
        </Tip>
      </div>
    </div>
  )
}
