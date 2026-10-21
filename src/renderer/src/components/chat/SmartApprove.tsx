// Smart-Approve no chat: linha compacta da avaliação do juiz (cards de tool e de aprovação) e o (i)
// com a request exata enviada ao juiz.
import { ShieldAlert, ShieldCheck, ShieldQuestion, ShieldX } from 'lucide-react'
import { categoryLabel } from '@shared/smartApprove'
import type { SmartApproveRecord } from '@shared/types'
import { cn, formatCost, formatDuration } from '../../lib/format'
import { useStore } from '../../store'
import { api } from '../../lib/api'
import { Button } from '../ui/controls'
import { ModelLabel } from '../ui/ModelLabel'
import { ApiInfo, C } from '../ui/Tooltip'

const FALLBACK_LABEL: Record<NonNullable<SmartApproveRecord['fallback']>, string> = {
  timeout: 'tempo esgotado',
  error: 'erro na chamada',
  ambiguous: 'resposta ambígua'
}

export function SmartApproveInfo({ rec }: { rec: SmartApproveRecord }): React.JSX.Element {
  return (
    <ApiInfo
      title="Chamada ao Smart-Approve"
      side="left"
      code={rec.request ? JSON.stringify(rec.request, null, 2) : undefined}
      codeLabel="Request exata (POST; key mascarada):"
      wide
    >
      <p>
        Uma request <strong className="text-fg">separada</strong>, só para julgar esta chamada: não
        entra no histórico do chat nem no contexto do agente. System = prompt do Smart-Approve; a
        mensagem <C>{'role: "user"'}</C> é o template com os placeholders preenchidos.
      </p>
      {rec.decision === 'reject' && (
        <p>
          Ao agente vai só o resultado <C>{'role: "tool"'}</C>:{' '}
          <C>Rejeitado pelo Smart-Approve (modelo): motivo</C>.
        </p>
      )}
      {rec.wouldReject && (
        <p>
          O juiz respondeu o rótulo de negar; com “O juiz pode negar” desligado, a decisão ficou com
          você (o motivo aparece como dica).
        </p>
      )}
      {rec.judged && rec.judged.length > 0 && (
        <p>
          Avaliou só o que as listas não decidiram: <C>{rec.judged.join(' · ')}</C>.
        </p>
      )}
      {rec.error && <p className="text-warning/90">{rec.error}</p>}
      {rec.response != null && (
        <div>
          <div className="mb-1 text-[11px] text-subtle">Resposta do juiz:</div>
          <pre className="max-h-40 overflow-auto rounded-lg border border-border bg-bg/80 p-2 font-mono text-[11px] whitespace-pre-wrap text-fg/90">
            {rec.response || '(vazia)'}
          </pre>
        </div>
      )}
    </ApiInfo>
  )
}

/** Custo + duração do juiz ("$0.0001 · 820ms"). */
function costText(rec: SmartApproveRecord): string {
  return [formatCost(rec.usage?.cost), formatDuration(rec.durationMs)].filter(Boolean).join(' · ')
}

/**
 * Linha do card de tool. `messageId` (resultado) habilita "Executar mesmo assim" nas rejeições.
 * `pending` = card de aprovação aberto (o juiz pediu a decisão do usuário).
 */
export function SmartApproveLine({
  rec,
  messageId,
  pending
}: {
  rec: SmartApproveRecord
  messageId?: string
  pending?: boolean
}): React.JSX.Element {
  const run = useStore((s) => s.run)
  const head =
    rec.decision === 'approve'
      ? { icon: ShieldCheck, text: 'Liberado pelo Smart-Approve', cls: 'text-success/90' }
      : rec.decision === 'reject'
        ? { icon: ShieldX, text: 'Negado pelo Smart-Approve', cls: 'text-danger/90' }
        : rec.fallback
          ? {
              icon: ShieldAlert,
              text: `Smart-Approve não decidiu (${FALLBACK_LABEL[rec.fallback]})`,
              cls: 'text-warning/90'
            }
          : {
              icon: ShieldQuestion,
              text: 'Smart-Approve sugeriu perguntar',
              cls: 'text-warning/90'
            }
  const Icon = head.icon
  const reason = (rec.fallback ? rec.error : rec.reason) ?? ''
  const meta = costText(rec)
  const action =
    rec.decision === 'reject' && messageId ? (
      rec.overridden ? (
        <span data-testid="smart-overridden" className="shrink-0 pt-px text-[11.5px] text-subtle">
          Liberado · o agente pode repetir esta chamada uma vez
        </span>
      ) : (
        <Button
          size="sm"
          variant="secondary"
          className="-mt-0.5"
          onClick={() => void run(() => api.agent.smartOverride(messageId), 'Falha ao liberar')}
        >
          Executar mesmo assim
        </Button>
      )
    ) : null
  return (
    <div
      data-testid="smart-approve-line"
      data-decision={rec.decision}
      className={cn(
        'px-3.5 py-2',
        !pending && 'border-t border-border/70',
        rec.decision === 'approve' && 'bg-success/[0.035]',
        rec.decision === 'reject' && 'bg-danger/[0.04]'
      )}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[12px]">
        <Icon className={cn('size-3.5 shrink-0', head.cls)} />
        <span className={cn('shrink-0 font-medium', head.cls)}>{head.text}</span>
        <span className="shrink-0 text-faint">·</span>
        <ModelLabel
          providerId={rec.providerId}
          model={rec.model}
          short
          className="max-w-full shrink-0 text-[11.5px]"
          modelClassName="font-mono text-muted"
        />
        {meta && (
          <span className="shrink-0 text-[11px] whitespace-nowrap text-faint tabular-nums">
            · {meta}
          </span>
        )}
        <SmartApproveInfo rec={rec} />
        {rec.category && (
          <span
            data-testid="smart-category"
            data-category={rec.category}
            title="Categoria dada pelo juiz"
            className="shrink-0 rounded bg-hover px-1.5 py-px text-[10.5px] text-muted"
          >
            {categoryLabel(rec.category)}
          </span>
        )}
        {rec.wouldReject && (
          <span
            data-testid="smart-would-reject"
            title="O juiz respondeu negar, mas “O juiz pode negar” está desligado (aba Tools → Smart-Approve → Avançado): a decisão fica com você."
            className="shrink-0 rounded bg-warning/10 px-1.5 py-px text-[10.5px] text-warning/90"
          >
            teria negado
          </span>
        )}
      </div>
      {rec.judged && rec.judged.length > 0 && rec.decision !== 'approve' && (
        <p
          className="mt-0.5 truncate pl-5 font-mono text-[11px] text-subtle"
          title={rec.judged.join('\n')}
        >
          avaliou: {rec.judged.join(' · ')}
        </p>
      )}
      {(reason || action) && (
        <div className="mt-1 flex min-w-0 items-start gap-3 pl-5">
          <p
            data-testid="smart-approve-reason"
            className="line-clamp-3 min-w-0 flex-1 text-[12px] leading-relaxed text-muted"
          >
            {reason}
          </p>
          {action}
        </div>
      )}
    </div>
  )
}
