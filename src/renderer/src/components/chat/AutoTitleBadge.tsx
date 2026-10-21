// Custo do título automático, sob a mensagem que deu nome ao chat ("título $0.00002"), como o
// "juiz $x" no rodapé das respostas: chamada fora do histórico, não somada ao uso da resposta.
// Ver SPEC.md → "Título automático".
import type { AutoTitleRecord } from '@shared/autoTitle'
import { formatCost, formatDuration, formatTokens } from '../../lib/format'
import { useStore } from '../../store'
import { Tip } from '../ui/Tooltip'

export function AutoTitleBadge({ rec }: { rec?: AutoTitleRecord }): React.JSX.Element | null {
  const provider = useStore((s) =>
    rec ? s.providers.find((p) => p.id === rec.providerId)?.name : undefined
  )
  if (!rec) return null
  const u = rec.usage
  const cost = formatCost(u?.cost)
  return (
    <Tip
      label={
        <span>
          Título do chat {rec.trigger === 'manual' ? 'gerado (Gerar título)' : 'gerado'} por{' '}
          {provider ? `${provider} · ` : ''}
          {rec.model}: “{rec.title}”{rec.applied ? '' : ' — não aplicado (o chat foi renomeado)'}
          {u
            ? ` · ${formatTokens(u.promptTokens)} in · ${formatTokens(u.completionTokens)} out`
            : ''}
          {cost ? ` · ${cost}` : ''}
          {formatDuration(rec.durationMs) ? ` · ${formatDuration(rec.durationMs)}` : ''} — fora do
          histórico, o agente não vê
        </span>
      }
    >
      <span
        data-testid="auto-title-usage"
        className="shrink-0 cursor-default text-[11px] whitespace-nowrap text-faint tabular-nums transition-colors select-none group-hover/msg:text-subtle"
      >
        título {cost ?? (u ? `${formatTokens(u.completionTokens)} out` : 'gerado')}
      </span>
    </Tip>
  )
}
