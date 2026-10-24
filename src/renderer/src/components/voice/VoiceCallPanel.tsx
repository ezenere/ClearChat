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
import { VoiceCallModelEditor } from './VoiceCallModelEditor'

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

/** Motivo de um ato de fala curta NÃO tocado → texto do painel (a "leitura de depuração"). */
const SKIP_LABELS: Record<string, string> = {
  disabled: 'desligado',
  stale: 'observação velha (chegou tarde)',
  'short-speech': 'fala curta demais',
  'below-min-speech': 'menos voz que a "Fala mínima"',
  'short-pause': 'pausa curta demais',
  cooldown: 'intervalo mínimo entre interjeições',
  'turn-end': 'fim de turno provável (pergunta/comando)',
  'tail-skip': 'cauda de negação/incerteza',
  'class-filtered': 'tipo não permitido',
  probability: 'sorteio (probabilidade)',
  'no-clip': 'clipe ausente — gere os clipes',
  blocked: 'assistente falando',
  shadow: 'modo sombra (decidiu, não tocou)',
  stopped: 'chamada encerrada',
  spoken: 'a resposta chegou antes',
  'fast-answer': 'a resposta ficou pronta antes da espera',
  'no-verdict':
    'sem veredito a tempo (STT pela API é lento; um motor local de transcrição resolve)',
  'late-verdict': 'o veredito chegou tarde (pausa já longa)',
  'assistant-audio': 'áudio do assistente tocando',
  'answer-speaking': 'a resposta está sendo falada',
  // frases de demora ("manter viva"/desculpa)
  'answer-first': 'a resposta chegou antes',
  'answer-coming': 'a resposta já está sintetizando',
  'not-ready': 'não ficou pronta antes da resposta',
  'keepalive-playing': '"manter viva" tocando',
  'keepalive-recent': '"manter viva" acabou de sair',
  'clip-playing': 'outro clipe tocando',
  'user-speaking': 'você falando',
  'barge-in': 'barge-in',
  'new-turn': 'turno novo',
  'response-done': 'a resposta terminou',
  'send-failed': 'o envio falhou',
  'no-response': 'sem resposta em voo',
  hangup: 'o agente encerrou a chamada',
  cancelled: 'resposta cancelada'
}

/** Motivo (com prefixo `delay/`/`tools/` dos preâmbulos ou `phase-…`) → texto. */
function skipLabel(reason: string): string {
  if (reason.startsWith('tts-error')) return `falha na síntese${reason.slice(9)}`
  const r = reason.includes('/') ? reason.slice(reason.lastIndexOf('/') + 1) : reason
  if (r.startsWith('phase-')) return `fase ${r.slice(6)}`
  return SKIP_LABELS[r] ?? r
}

/** Descrição curta de um evento da timeline (linha do painel). */
function describeTimelineEvent(e: VoiceCallTimelineEvent): string {
  switch (e.kind) {
    case 'decision': {
      if (e.class === 'NONE')
        return `interjeição não — ${skipLabel(e.reason ?? '?')}${e.text ? ` · "…${e.text.slice(-24)}"` : ''}`
      const state = e.played
        ? 'tocou'
        : e.reason === 'shadow' || (e.reason ?? '').includes('shadow')
          ? 'sombra'
          : `não tocou — ${skipLabel(e.reason ?? '?')}`
      return `decisão ${e.class ?? '?'}${e.variant ? ` v${e.variant}` : ''} — ${state}${
        e.text ? ` · "…${e.text.slice(-24)}"` : ''
      }`
    }
    case 'clip-emitted':
      return e.text
        ? `frase ${e.class ?? '?'} emitida: "${e.text.slice(0, 40)}"`
        : `clipe ${e.class ?? '?'} emitido`
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
    case 'playback-error':
      return `falha ao tocar ${e.class ?? ''}: ${e.reason ?? '?'}`
    case 'tts-latency':
      return `TTS 1º texto→1º áudio: ${e.latencyMs ?? 0} ms${e.reason ? ` (${e.reason})` : ''}`
    default:
      return e.kind
  }
}

/** Painel recolhível acima do dock (no mesmo fluxo da coluna do composer; só com a chamada ativa). */
export function VoiceCallPanel({ open }: { open: boolean }): React.JSX.Element | null {
  const timeline = useStore((s) => s.voiceCallTimeline)
  const { defaults, resolved, voice, persona, setInterjections, setFillers, setVoice } =
    useVoiceCallConfig()
  const chatModel = useStore(
    (s) => s.chats.find((c) => c.id === s.voiceCall.chatId)?.config.model ?? ''
  )
  const playbackErrors = timeline.filter((e) => e.kind === 'playback-error').length
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
        {metrics.delayPlayed.keepAlive + metrics.delayPlayed.apology > 0 && (
          <span data-testid="voice-call-delay-played">
            frases de demora: {metrics.delayPlayed.keepAlive} manter viva ·{' '}
            {metrics.delayPlayed.apology} desculpa
          </span>
        )}
        {playbackErrors > 0 && (
          <span data-testid="voice-call-playback-errors" className="text-danger">
            falhas ao tocar: {playbackErrors}
          </span>
        )}
      </div>
      <SkipReadout skipped={metrics.skipped} />
      <details data-testid="voice-call-panel-model" className="border-t border-border/60 pt-1.5">
        <summary className="cursor-pointer text-[11px] text-subtle select-none hover:text-fg">
          Modelo da chamada:{' '}
          <span className="text-fg/80">
            {resolved.model ? resolved.model.model : `o do chat (${chatModel || '—'})`}
          </span>
        </summary>
        <div className="mt-2">
          <VoiceCallModelEditor
            value={voice.model}
            onChange={(model) => setVoice({ model })}
            scope="call"
            compact
            inherited={
              persona?.model
                ? `o da persona (${persona.model.model})`
                : defaults.model
                  ? `o padrão global (${defaults.model.model})`
                  : `o modelo do chat (${chatModel || '—'})`
            }
          />
        </div>
      </details>
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

/** Por que os atos de fala curta não tocaram (motivo × vezes) — interjeições, preâmbulos e frases de demora. */
function SkipReadout({
  skipped
}: {
  skipped: {
    interjection: Record<string, number>
    filler: Record<string, number>
    delay: Record<string, number>
  }
}): React.JSX.Element | null {
  const row = (
    label: string,
    counts: Record<string, number>,
    testId: string
  ): React.JSX.Element | null => {
    const entries = Object.entries(counts).sort((a, b) => b[1] - a[1])
    if (!entries.length) return null
    return (
      <div data-testid={testId} className="flex flex-wrap gap-x-2 gap-y-0.5">
        <span className="text-fg/80">{label} não tocou:</span>
        {entries.map(([reason, n]) => (
          <span key={reason} data-reason={reason} title={reason}>
            {skipLabel(reason)} ×{n}
          </span>
        ))}
      </div>
    )
  }
  const a = row('Interjeição', skipped.interjection, 'voice-call-skips-interjection')
  const b = row('Preâmbulo', skipped.filler, 'voice-call-skips-filler')
  const c = row('Frase de demora', skipped.delay, 'voice-call-skips-delay')
  if (!a && !b && !c) return null
  return (
    <div data-testid="voice-call-skips" className="space-y-0.5 text-[10.5px] text-subtle">
      {a}
      {b}
      {c}
    </div>
  )
}
