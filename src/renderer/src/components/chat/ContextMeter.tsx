import { Gauge, Layers, X } from 'lucide-react'
import { useState } from 'react'
import type { Chat, Session } from '@shared/types'
import { cn, formatTokens } from '../../lib/format'
import { useContextInfo } from '../../lib/useContextInfo'
import { isBusy, useStore } from '../../store'
import { Button } from '../ui/controls'
import { Tip } from '../ui/Tooltip'
import { barAttrs, useBarLevel } from '../../lib/useBarCollapse'

const fmtInt = (n: number): string => n.toLocaleString('pt-BR')

function levelClass(pct: number | null, threshold: number): string {
  if (pct == null) return 'text-subtle'
  if (pct >= threshold) return 'text-danger'
  if (pct >= 0.7) return 'text-warning'
  return 'text-subtle'
}

function Ring({ pct, className }: { pct: number | null; className?: string }): React.JSX.Element {
  const r = 5.5
  const c = 2 * Math.PI * r
  const p = Math.max(0, Math.min(1, pct ?? 0))
  return (
    <svg viewBox="0 0 14 14" className={cn('size-3.5 shrink-0 -rotate-90', className)}>
      <circle
        cx="7"
        cy="7"
        r={r}
        fill="none"
        stroke="currentColor"
        strokeOpacity={0.2}
        strokeWidth={2}
      />
      {pct != null && (
        <circle
          cx="7"
          cy="7"
          r={r}
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeDasharray={`${c * p} ${c}`}
          className="transition-[stroke-dasharray] duration-500"
        />
      )}
    </svg>
  )
}

/** Medidor compacto "38k / 200k · 19%" (anel + texto). Clique → seção Contexto da config. */
export function ContextMeter({
  chat,
  session,
  className
}: {
  chat: Chat
  session: Session
  className?: string
}): React.JSX.Element | null {
  const info = useContextInfo(chat, session)
  const focusConfig = useStore((s) => s.focusConfig)
  const level = useBarLevel('context-meter')
  const { usage, window, pct, threshold } = info
  if (!usage) return null
  const u = usage.usage
  const tip = (
    <div className="max-w-[300px] space-y-1 py-0.5 text-[11.5px] leading-relaxed">
      <div className="font-medium text-fg">
        Contexto {usage.estimated ? '(estimativa pós-compactação)' : 'em uso'}
      </div>
      <div className="text-muted">
        {fmtInt(usage.used)} tokens
        {u ? ` = ${fmtInt(u.promptTokens)} entrada + ${fmtInt(u.completionTokens)} resposta` : ''}
      </div>
      {u?.cachedTokens ? (
        <div className="text-success/80">{fmtInt(u.cachedTokens)} lidos do cache</div>
      ) : null}
      <div className="text-muted">
        {window
          ? `Janela: ${fmtInt(window)} tokens (${info.source === 'override' ? 'definida no chat' : 'do modelo'})`
          : 'Janela desconhecida — clique para definir'}
      </div>
      {window && (
        <div className="text-subtle">
          Sugere compactar a partir de {Math.round(threshold * 100)}%
          {session.depth > 0
            ? ' (subagente: automático)'
            : chat.config.autoCompact
              ? ' (automático)'
              : ''}
        </div>
      )}
    </div>
  )
  return (
    <Tip label={tip} side="top">
      <button
        type="button"
        data-testid="context-meter"
        {...barAttrs('context-meter', level)}
        aria-label="Contexto em uso"
        onClick={(e) => {
          e.stopPropagation()
          // janela desconhecida ("definir janela") → abre direto os ajustes de janela/compactação
          focusConfig(window ? 'contexto' : 'contexto-janela')
        }}
        className={cn(
          'no-drag flex h-7 shrink-0 items-center gap-1.5 rounded-lg px-1.5 text-[11px] whitespace-nowrap tabular-nums transition-colors hover:bg-hover',
          levelClass(pct, threshold),
          className
        )}
      >
        <Ring pct={pct} />
        {level === 1 && (
          <span>{window ? `${Math.round((pct ?? 0) * 100)}%` : formatTokens(usage.used)}</span>
        )}
        <span className={cn(level > 0 && 'hidden')}>
          {usage.estimated ? '~' : ''}
          {formatTokens(usage.used)}
          {window ? (
            <>
              <span className="text-faint"> / </span>
              {formatTokens(window)}
              <span className="text-faint"> · </span>
              {Math.round((pct ?? 0) * 100)}%
            </>
          ) : (
            <span className="text-faint"> tokens · definir janela</span>
          )}
        </span>
      </button>
    </Tip>
  )
}

/** Banner discreto acima do composer quando o contexto passa do limite. */
export function CompactBanner({
  chat,
  session
}: {
  chat: Chat
  session: Session
}): React.JSX.Element | null {
  const info = useContextInfo(chat, session)
  const compacting = useStore((s) => s.compactions[session.id])
  const compact = useStore((s) => s.compact)
  const [dismissed, setDismissed] = useState<number | null>(null)
  const busy = isBusy(session.status)
  const { pct, usage } = info
  if (compacting || pct == null || pct < info.threshold || !info.canCompact) return null
  if (usage && dismissed === usage.used) return null
  return (
    <div
      data-testid="compact-banner"
      data-stack-extra
      className="mb-2 flex animate-slide-up items-center gap-2.5 rounded-xl border border-warning/25 bg-warning/[0.06] py-1.5 pr-1.5 pl-3 text-[12.5px]"
    >
      <Gauge className="size-3.5 shrink-0 text-warning" />
      <span className="min-w-0 flex-1 truncate text-fg/90">
        Contexto em {Math.round(pct * 100)}%
        <span className="text-subtle">
          {' '}
          —{' '}
          {busy
            ? 'compacta no próximo passo do agente'
            : 'resuma a conversa para continuar com folga'}
        </span>
      </span>
      <Button
        size="sm"
        variant="secondary"
        icon={<Layers className="size-3.5 text-warning" />}
        onClick={() => void compact(session.id)}
      >
        Compactar conversa
      </Button>
      <button
        type="button"
        aria-label="Dispensar"
        onClick={() => setDismissed(usage?.used ?? null)}
        className="rounded-md p-1 text-subtle hover:bg-hover hover:text-fg"
      >
        <X className="size-3.5" />
      </button>
    </div>
  )
}
