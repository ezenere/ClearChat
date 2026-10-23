// Painel da chamada de voz (dock — SPEC → "Chamada de voz → Modo sombra e timeline"): toggles
// rápidos de interjeições/sombra/fillers refletindo e gravando o `ChatConfig.voice` do chat da
// chamada (★ = segue o padrão global — escolher a opção ★ remove o override, como em
// `ChatApprovalSection`), indicador de modo sombra + contagem, métricas (interjeições/min e
// p50/p95 da latência decisão→áudio) e a timeline da chamada atual (sem visualização pós-chamada
// na v1 — a última chamada fica no log de avaliação `voice-eval/*.jsonl`).
import { Star } from 'lucide-react'
import { useMemo } from 'react'
import type { VoiceCallTimelineEvent } from '@shared/ipc'
import { computeVoiceCallMetrics } from '@shared/voiceTimeline'
import { cn } from '../../lib/format'
import { useStore } from '../../store'
import { useVoiceCallConfig } from '../../lib/voice/useVoiceCallConfig'

/** Linha Ligado/Desligado com ★ no padrão global (escolher a opção ★ = segue o global). */
function InheritToggle({
  label,
  value,
  globalValue,
  testId,
  onChange
}: {
  label: string
  value: boolean
  globalValue: boolean
  testId: string
  onChange: (v: boolean) => void
}): React.JSX.Element {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      data-testid={testId}
      data-inherit={value === globalValue ? 'true' : undefined}
      className="flex rounded-lg border border-border bg-bg/60 p-0.5"
    >
      {[true, false].map((v) => {
        const selected = value === v
        const star = globalValue === v
        return (
          <button
            key={String(v)}
            type="button"
            role="radio"
            aria-checked={selected}
            data-value={v ? 'on' : 'off'}
            data-global={star || undefined}
            title={star ? '★ Padrão global (escolher remove o override do chat)' : undefined}
            onClick={() => onChange(v)}
            className={cn(
              'flex min-w-0 flex-1 items-center justify-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] transition-colors',
              selected ? 'bg-active text-fg shadow-sm' : 'text-subtle hover:text-fg'
            )}
          >
            {v ? 'Ligado' : 'Desligado'}
            {star && <Star aria-hidden className="size-2.5 shrink-0 fill-current opacity-70" />}
          </button>
        )
      })}
    </div>
  )
}

/** Descrição curta de um evento da timeline (linha do painel). */
function describeTimelineEvent(e: VoiceCallTimelineEvent): string {
  switch (e.kind) {
    case 'decision': {
      const state = e.played
        ? 'tocou'
        : e.reason === 'shadow' || (e.reason ?? '').includes('shadow')
          ? 'sombra'
          : `descartada (${e.reason ?? '?'})`
      return `decisão ${e.class ?? '?'}${e.variant ? ` v${e.variant}` : ''} — ${state}${
        e.text ? ` · "…${e.text.slice(-24)}"` : ''
      }`
    }
    case 'clip-emitted':
      return `clipe ${e.class ?? '?'} emitido`
    case 'clip-cancelled':
      return `clipe ${e.class ?? '?'} cancelado`
    case 'sentence-emitted':
      return `sentença: "…${(e.text ?? '').slice(-24)}"`
    case 'turn-sent':
      return `turno enviado: "…${(e.text ?? '').slice(-24)}"`
    case 'speech-start':
      return 'fala detectada'
    case 'speech-end':
      return 'fim da fala'
    case 'pause':
      return `pausa de ${e.pauseMs ?? 0} ms`
    case 'clip-start':
      return 'clipe começou a tocar'
    case 'clip-end':
      return 'clipe terminou'
    case 'sentence-start':
      return 'sentença começou a tocar'
    case 'sentence-end':
      return 'sentença terminou'
    case 'barge-in':
      return 'barge-in (fala do assistente cancelada)'
    case 'backchannel':
      return `backchannel (${e.speechMs ?? 0} ms — não cancelou)`
    default:
      return e.kind
  }
}

/** Painel recolhível acima do dock (no mesmo fluxo da coluna do composer; só com a chamada ativa). */
export function VoiceCallPanel({ open }: { open: boolean }): React.JSX.Element | null {
  const timeline = useStore((s) => s.voiceCallTimeline)
  const { defaults, resolved, setInterjections, setFillers } = useVoiceCallConfig()
  const metrics = useMemo(() => computeVoiceCallMetrics(timeline), [timeline])
  const shadowCount = timeline.filter(
    (e) => e.kind === 'decision' && !e.played && (e.reason ?? '').includes('shadow')
  ).length
  if (!open) return null
  const t0 = timeline[0]?.ts ?? 0
  return (
    <div
      data-testid="voice-call-panel"
      className="flex w-full flex-col gap-2 rounded-2xl border border-border-strong/70 bg-elevated px-3 py-2.5 shadow-popover"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="text-[11.5px] font-medium text-fg/90">Atos de fala curta</span>
        {resolved.interjections.shadow && (
          <span
            data-testid="voice-call-shadow"
            className="rounded-full border border-warning/40 bg-warning/10 px-1.5 py-px text-[10px] text-warning"
            title="Modo sombra: o motor decide mas não toca (decisões no log de avaliação)"
          >
            modo sombra · {shadowCount}
          </span>
        )}
        <div className="flex items-center gap-1.5">
          <span className="text-[10.5px] text-subtle">Interjeições</span>
          <InheritToggle
            label="Interjeições"
            value={resolved.interjections.enabled}
            globalValue={defaults.interjections.enabled}
            testId="voice-call-toggle-interjections"
            onChange={(v) =>
              setInterjections(v === defaults.interjections.enabled ? 'inherit' : { enabled: v })
            }
          />
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-[10.5px] text-subtle">Sombra</span>
          <InheritToggle
            label="Modo sombra"
            value={resolved.interjections.shadow}
            globalValue={defaults.interjections.shadow}
            testId="voice-call-toggle-shadow"
            onChange={(v) =>
              setInterjections(v === defaults.interjections.shadow ? 'inherit' : { shadow: v })
            }
          />
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-[10.5px] text-subtle">Fillers</span>
          <InheritToggle
            label="Fillers"
            value={resolved.fillers.enabled}
            globalValue={defaults.fillers.enabled}
            testId="voice-call-toggle-fillers"
            onChange={(v) =>
              setFillers(v === defaults.fillers.enabled ? 'inherit' : { enabled: v })
            }
          />
        </div>
        <span className="ml-auto text-[10.5px] text-subtle">★ = padrão global</span>
      </div>
      <div
        data-testid="voice-call-metrics"
        className="flex flex-wrap items-center gap-x-3 gap-y-0.5 border-t border-border/60 pt-1.5 text-[10.5px] text-subtle"
      >
        <span>interjeições/min: {metrics.interjectionsPerMin}</span>
        <span>
          decisão→áudio:{' '}
          {metrics.decisionToAudioMs
            ? `p50 ${metrics.decisionToAudioMs.p50} ms · p95 ${metrics.decisionToAudioMs.p95} ms`
            : '—'}
        </span>
        <span>
          decisões: {metrics.decisions} ({metrics.played} tocadas)
        </span>
      </div>
      <ul
        data-testid="voice-call-timeline"
        className="max-h-[180px] space-y-0.5 overflow-y-auto font-mono text-[10.5px] leading-4 text-subtle"
      >
        {timeline.length === 0 && <li className="text-faint">sem eventos ainda</li>}
        {timeline.map((e, i) => (
          <li key={`${e.ts}-${i}`} className="flex gap-2">
            <span className="w-[52px] shrink-0 tabular-nums text-faint">
              +{((e.ts - t0) / 1000).toFixed(1)}s
            </span>
            <span className="min-w-0 break-words">{describeTimelineEvent(e)}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
