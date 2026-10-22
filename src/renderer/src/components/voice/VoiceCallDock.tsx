// Chamada de voz ativa — dock fixo (canto inferior central, acima do composer, visível em qualquer
// chat): indicador de estado ("Ouvindo…/Transcrevendo…/Pensando…/Falando…"), waveform do microfone,
// mudo (captura pausada), volume da reprodução, "Encerrar" e o card de erro. A captura/reprodução
// vive em `lib/voice/useVoiceCall` (o controller roda AQUI, uma única vez por app); o chat continua
// normal por baixo (as mensagens do turno de voz aparecem como quaisquer outras).
// Testids: `voice-call-dock`, `voice-call-status`, `voice-call-waveform`, `voice-call-mute`,
// `voice-call-volume`, `voice-call-end`, `voice-call-error`, `voice-call-pending`.
import { Mic, MicOff, PhoneOff, TriangleAlert, Volume2, X } from 'lucide-react'
import type { VoiceCallPhase } from '@shared/voice'
import { cn } from '../../lib/format'
import { useStore } from '../../store'
import { useVoiceCall } from '../../lib/voice/useVoiceCall'
import { Tip } from '../ui/Tooltip'
import { Waveform } from './Waveform'

const MOCK = import.meta.env.VITE_CLEAR_MOCK === '1'

/** Rótulo da fase do turno ("Ouvindo…/Transcrevendo…/Pensando…/Falando…"). */
function phaseLabel(phase: VoiceCallPhase): string {
  switch (phase) {
    case 'transcribing':
      return 'Transcrevendo…'
    case 'thinking':
      return 'Pensando…'
    case 'speaking':
      return 'Falando…'
    default:
      return 'Ouvindo…'
  }
}

/** Dock da chamada de voz (só renderiza com a chamada ativa; o controller roda sempre aqui). */
export function VoiceCallDock(): React.JSX.Element | null {
  const call = useStore((s) => s.voiceCall)
  const stopVoiceCall = useStore((s) => s.stopVoiceCall)
  const controls = useVoiceCall()
  if (!call.active) return null
  const error = call.error ?? controls.error
  return (
    <>
      <div
        data-testid="voice-call-dock"
        className="pointer-events-auto fixed bottom-4 left-1/2 z-[80] flex -translate-x-1/2 items-center gap-2 rounded-2xl border border-border-strong/70 bg-elevated px-3 py-2 shadow-popover"
      >
        <span data-testid="voice-call-waveform" className="flex items-center">
          <Waveform
            level={controls.level}
            recording={!call.muted}
            simulate={MOCK}
            className="h-7 w-24 text-accent-strong"
          />
        </span>
        <span
          data-testid="voice-call-status"
          aria-live="polite"
          className={cn('min-w-0 text-[12.5px] text-fg/90', call.muted && 'text-subtle')}
        >
          {call.muted ? 'Microfone mudo' : phaseLabel(call.phase)}
        </span>
        {call.pendingText && (
          <span
            data-testid="voice-call-pending"
            className="max-w-[220px] truncate text-[11px] text-subtle"
            title={call.pendingText}
          >
            Próximo: {call.pendingText}
          </span>
        )}
        <div className="mx-1 h-5 w-px bg-border" />
        <Tip label={call.muted ? 'Ativar microfone' : 'Silenciar microfone'}>
          <button
            type="button"
            data-testid="voice-call-mute"
            aria-label={call.muted ? 'Ativar microfone' : 'Silenciar microfone'}
            aria-pressed={call.muted}
            onClick={() => void controls.toggleMute()}
            className={cn(
              'flex size-7 items-center justify-center rounded-lg text-subtle transition-colors hover:bg-hover hover:text-fg',
              call.muted && 'bg-danger/15 text-danger hover:bg-danger/25 hover:text-danger'
            )}
          >
            {call.muted ? <MicOff className="size-4" /> : <Mic className="size-4" />}
          </button>
        </Tip>
        <Tip label={`Volume da fala: ${Math.round(controls.volume * 100)}%`}>
          <label className="flex items-center gap-1.5 text-subtle">
            <Volume2 className="size-4" />
            <input
              type="range"
              min={0}
              max={100}
              value={Math.round(controls.volume * 100)}
              data-testid="voice-call-volume"
              aria-label="Volume da fala"
              onChange={(e) => controls.setVolume(Number(e.target.value) / 100)}
              className="w-16 accent-accent-strong"
            />
          </label>
        </Tip>
        <Tip label="Encerrar chamada">
          <button
            type="button"
            data-testid="voice-call-end"
            aria-label="Encerrar chamada"
            onClick={() => void stopVoiceCall()}
            className="flex size-7 items-center justify-center rounded-lg bg-danger/15 text-danger transition-colors hover:bg-danger/25"
          >
            <PhoneOff className="size-4" />
          </button>
        </Tip>
      </div>
      {error && (
        <div
          role="alert"
          data-testid="voice-call-error"
          className="pointer-events-auto fixed bottom-20 left-1/2 z-[80] flex w-[min(420px,90vw)] -translate-x-1/2 items-center gap-2 rounded-xl border border-danger/30 bg-danger/[0.08] px-3 py-2 text-[12px] text-danger shadow-popover"
        >
          <TriangleAlert className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 break-words">{error}</span>
          <button
            type="button"
            aria-label="Dispensar erro da chamada"
            onClick={controls.clearError}
            className="shrink-0 rounded-md p-1 transition-colors hover:bg-danger/15"
          >
            <X className="size-3.5" />
          </button>
        </div>
      )}
    </>
  )
}
