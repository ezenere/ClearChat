// Peças pequenas do "Modo avançado (GPU local)": badge com tom, barra de progresso com a fase,
// erro com "ver log" e o seletor de passos do OmniVoice (a voz usa o `VoicePicker` compartilhado).
import { ChevronDown, ChevronRight, TriangleAlert } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { cn } from '../../../lib/format'
import {
  OMNIVOICE_DEFAULT_STEPS,
  OMNIVOICE_STEPS,
  progressPct,
  type Tone
} from '../../../lib/voice/gpu/gpuUi'
import { gpuApi } from '../../../lib/voice/gpu/types'
import { HelpTip } from '../../ui/Tooltip'

const TONES: Record<Tone, string> = {
  success: 'border-success/30 text-success',
  warning: 'border-warning/35 text-warning',
  danger: 'border-danger/35 text-danger',
  neutral: 'border-border text-subtle',
  accent: 'border-accent/40 text-accent-strong'
}

export function Badge({
  tone = 'neutral',
  children,
  title,
  testId,
  className
}: {
  tone?: Tone
  children: ReactNode
  title?: string
  testId?: string
  className?: string
}): React.JSX.Element {
  return (
    <span
      title={title}
      data-testid={testId}
      data-tone={tone}
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-px text-[10px] leading-4 whitespace-nowrap',
        TONES[tone],
        className
      )}
    >
      {children}
    </span>
  )
}

/** Barra de progresso com a fase em texto (pct null = indeterminada). */
export function GpuProgress({
  progress,
  label,
  testId
}: {
  progress: { phase: string; pct: number | null; bytes?: number } | undefined
  label: string
  testId: string
}): React.JSX.Element {
  const pct = progressPct(progress)
  return (
    <div className="mt-2" data-testid={testId}>
      <div
        className="h-1.5 overflow-hidden rounded-full bg-elevated"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct ?? undefined}
        aria-valuetext={progress?.phase}
      >
        <div
          className={cn(
            'h-full rounded-full bg-accent transition-[width] duration-200',
            pct == null && 'w-1/3 animate-pulse'
          )}
          style={pct == null ? undefined : { width: `${pct}%` }}
        />
      </div>
      <p className="mt-0.5 flex gap-2 text-[10.5px] text-subtle tabular-nums">
        <span className="min-w-0 flex-1 truncate" data-testid={`${testId}-phase`}>
          {progress?.phase || 'preparando…'}
        </span>
        {pct != null && <span>{pct}%</span>}
      </p>
    </div>
  )
}

/**
 * Erro legível (1ª linha) com "ver log": expande o texto completo e, quando o backend expõe
 * `gpu.log()`, as últimas linhas do log do runtime/servidor.
 */
export function GpuError({
  error,
  testId,
  prefix
}: {
  error: string | null | undefined
  testId: string
  prefix?: string
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const [log, setLog] = useState<string | null>(null)
  if (!error) return null
  const lines = error.split('\n').filter((l) => l.trim())
  const first = lines[0] ?? error
  const toggle = (): void => {
    const next = !open
    setOpen(next)
    if (next && log === null) {
      const fetchLog = gpuApi()?.log
      if (fetchLog)
        void fetchLog()
          .then((t) => setLog(t || ''))
          .catch(() => setLog(''))
      else setLog('')
    }
  }
  return (
    <div
      role="alert"
      data-testid={testId}
      className="mt-2 rounded-lg border border-danger/30 bg-danger/[0.06] px-2.5 py-1.5 text-[11.5px] text-danger"
    >
      <div className="flex items-start gap-1.5">
        <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 break-words">
          {prefix ? `${prefix}: ` : ''}
          {first}
        </span>
        <button
          type="button"
          aria-expanded={open}
          data-testid={`${testId}-log-toggle`}
          onClick={toggle}
          className="inline-flex shrink-0 items-center gap-0.5 rounded px-1 text-[11.5px] text-danger/90 underline-offset-2 hover:underline"
        >
          {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
          ver log
        </button>
      </div>
      {open && (
        <pre
          data-testid={`${testId}-log`}
          className="mt-1.5 max-h-48 overflow-auto rounded-md border border-border bg-bg/80 p-2 font-mono text-[10.5px] leading-relaxed whitespace-pre-wrap text-fg/85"
        >
          {[error, log ? `\n— log —\n${log}` : log === null ? '\ncarregando o log…' : '']
            .join('')
            .trim()}
        </pre>
      )}
    </div>
  )
}

/** "Passos" do OmniVoice (16 padrão; 32 = mais qualidade, mais lento). */
export function StepsControl({
  value,
  onChange,
  testId = 'gpu-omnivoice-steps'
}: {
  value: number | undefined
  onChange: (steps: number) => void
  testId?: string
}): React.JSX.Element {
  const cur = value ?? OMNIVOICE_DEFAULT_STEPS
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid={testId}>
      <span className="text-[11.5px] font-medium text-muted">Passos</span>
      <HelpTip label="Passos do OmniVoice">
        Passos de difusão por frase. 16 (padrão) soa praticamente igual a 32 com metade do tempo
        (~0,4 s contra ~0,8 s por frase curta numa RTX 3080 Ti). 32 = um pouco mais de qualidade,
        mais lento para a chamada.
      </HelpTip>
      <div
        role="radiogroup"
        aria-label="Passos do OmniVoice"
        className="inline-flex rounded-lg border border-border p-0.5"
      >
        {OMNIVOICE_STEPS.map((n) => (
          <button
            key={n}
            type="button"
            role="radio"
            aria-checked={cur === n}
            data-testid={`${testId}-${n}`}
            onClick={() => cur !== n && onChange(n)}
            className={cn(
              'rounded-md px-2 py-0.5 text-[11.5px] transition-colors',
              cur === n ? 'bg-accent/20 text-accent-strong' : 'text-subtle hover:text-fg'
            )}
          >
            {n}
            {n === OMNIVOICE_DEFAULT_STEPS ? ' · padrão' : ' · mais qualidade, mais lento'}
          </button>
        ))}
      </div>
    </div>
  )
}
