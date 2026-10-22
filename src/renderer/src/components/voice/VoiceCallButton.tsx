// Botão de chamada de voz do composer (meia-duplex): telefone entra/sai da chamada do chat atual.
// Só aparece em sessões principais com `window.api.voice`; some quando `VoiceCallConfig.enabled`
// resolve desligado (persona/chat/global — `resolveVoiceCallConfig`). Com a chamada ativa em OUTRO
// chat, fica desabilitado (uma chamada por vez — o microfone é único).
// Testids: `voice-call-button` (com `voice-call-button-active` quando na chamada).
import { Phone, PhoneOff } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { Session } from '@shared/types'
import { DEFAULT_VOICE_CALL_DEFAULTS, resolveVoiceCallConfig } from '@shared/voice'
import { api } from '../../lib/api'
import { cn } from '../../lib/format'
import { useStore } from '../../store'
import { Tip } from '../ui/Tooltip'

export function VoiceCallButton({ session }: { session: Session }): React.JSX.Element | null {
  const [defaults, setDefaults] = useState(DEFAULT_VOICE_CALL_DEFAULTS)
  const call = useStore((s) => s.voiceCall)
  const startVoiceCall = useStore((s) => s.startVoiceCall)
  const stopVoiceCall = useStore((s) => s.stopVoiceCall)
  const chat = useStore((s) => s.chats.find((c) => c.id === session.chatId))

  useEffect(() => {
    let alive = true
    void api.voice?.settings
      .get()
      .then((all) => {
        if (alive) setDefaults(all.voiceCallDefaults)
      })
      .catch(() => {
        // sem settings segue o padrão (DEFAULT_VOICE_CALL_DEFAULTS)
      })
    return () => {
      alive = false
    }
  }, [])

  if (!api.voice || session.depth > 0 || !chat) return null
  const enabled = resolveVoiceCallConfig(chat.config.voice, defaults).enabled
  if (!enabled) return null
  const mine = call.active && call.sessionId === session.id
  const busy = call.active && !mine
  return (
    <Tip
      label={
        busy
          ? 'Já existe uma chamada em andamento'
          : mine
            ? 'Encerrar chamada de voz'
            : 'Chamada de voz (falar com o agente)'
      }
    >
      <button
        type="button"
        data-testid="voice-call-button"
        disabled={busy}
        aria-label={mine ? 'Encerrar chamada de voz' : 'Iniciar chamada de voz'}
        aria-pressed={mine}
        onClick={(e) => {
          e.stopPropagation()
          void (mine ? stopVoiceCall() : startVoiceCall(session.id))
        }}
        className={cn(
          'flex size-7 shrink-0 items-center justify-center rounded-lg text-subtle transition-colors hover:bg-hover hover:text-fg',
          mine && 'voice-call-button-active bg-accent/15 text-accent-strong hover:bg-accent/25',
          busy && 'opacity-40'
        )}
      >
        {mine ? <PhoneOff className="size-4" /> : <Phone className="size-4" />}
      </button>
    </Tip>
  )
}
