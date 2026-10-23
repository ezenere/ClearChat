// Botão de chamada de voz do composer (meia-duplex): telefone entra/sai da chamada do chat atual.
// Só aparece em sessões principais com `window.api.voice`; some quando `VoiceCallConfig.enabled`
// resolve desligado (persona/chat/global — `resolveVoiceCallConfig`, padrões do espelho reativo
// `useVoiceSettings`: desligar em Configurações → Áudio esconde na hora). Com a chamada ativa em
// OUTRO chat, fica desabilitado (uma chamada por vez — o microfone é único). Chat executado em
// OUTRO dispositivo (host remoto): desabilitado com o motivo no tooltip (o turno de voz roda no
// host; o ditado continua valendo). Antes de entrar, `voiceCallReadiness` confere STT/TTS (e, com
// `voice.runtime.status()`, os runtimes locais — espeak-ng etc.) — o que faltar vira toast com o
// caminho em Configurações → Áudio (nunca uma chamada que falha calada).
// Testids: `voice-call-button` (com `voice-call-button-active` quando na chamada).
import { Phone, PhoneOff } from 'lucide-react'
import { useState } from 'react'
import type { Session } from '@shared/types'
import { resolveVoiceCallConfig } from '@shared/voice'
import { api } from '../../lib/api'
import { cn } from '../../lib/format'
import { useStore } from '../../store'
import { voiceCallReadiness } from '../../lib/voice/callReadiness'
import { loadVoiceSettings, useVoiceSettings } from '../../lib/voice/voiceSettings'
import { useHostInfo } from '../sync/hooks'
import { Tip } from '../ui/Tooltip'

export function VoiceCallButton({ session }: { session: Session }): React.JSX.Element | null {
  const defaults = useVoiceSettings((s) => s.view.voiceCallDefaults)
  const call = useStore((s) => s.voiceCall)
  const startVoiceCall = useStore((s) => s.startVoiceCall)
  const stopVoiceCall = useStore((s) => s.stopVoiceCall)
  const toast = useStore((s) => s.toast)
  const chat = useStore((s) => s.chats.find((c) => c.id === session.chatId))
  const host = useHostInfo(session.chatId)
  const [checking, setChecking] = useState(false)

  if (!api.voice || session.depth > 0 || !chat) return null
  const enabled = resolveVoiceCallConfig(chat.config.voice, defaults).enabled
  if (!enabled) return null
  const mine = call.active && call.sessionId === session.id
  const busy = call.active && !mine
  const remote = host?.mode === 'remote' && !mine
  const disabled = busy || remote || checking

  const start = async (): Promise<void> => {
    setChecking(true)
    try {
      const view = await loadVoiceSettings()
      // probe dos runtimes locais (whisper/onnxruntime/espeak-ng) só quando algum motor local conta
      const needsLocal = view.ttsSettings.backend === 'local' || view.sttSettings.mode !== 'api'
      const runtime = needsLocal ? await api.voice?.runtime?.status().catch(() => null) : null
      const problems = voiceCallReadiness(view, runtime)
      if (problems.length) {
        toast(`Chamada de voz indisponível — ${problems.join(' ')}`, 'error')
        return
      }
      await startVoiceCall(session.id)
    } finally {
      setChecking(false)
    }
  }

  return (
    <Tip
      label={
        remote
          ? `A chamada de voz roda no dispositivo que executa este chat (${host?.host?.name ?? 'outro dispositivo'}) — use-a por lá ou execute o chat aqui. O ditado continua disponível.`
          : busy
            ? 'Já existe uma chamada em andamento'
            : mine
              ? 'Encerrar chamada de voz'
              : 'Chamada de voz (falar com o agente)'
      }
    >
      {/* span: o tooltip continua funcionando com o botão desabilitado */}
      <span className="flex shrink-0">
        <button
          type="button"
          data-testid="voice-call-button"
          disabled={disabled}
          aria-label={mine ? 'Encerrar chamada de voz' : 'Iniciar chamada de voz'}
          aria-pressed={mine}
          onClick={(e) => {
            e.stopPropagation()
            void (mine ? stopVoiceCall() : start())
          }}
          className={cn(
            'flex size-7 shrink-0 items-center justify-center rounded-lg text-subtle transition-colors hover:bg-hover hover:text-fg',
            mine && 'voice-call-button-active bg-accent/15 text-accent-strong hover:bg-accent/25',
            (busy || remote) && 'opacity-40'
          )}
        >
          {mine ? <PhoneOff className="size-4" /> : <Phone className="size-4" />}
        </button>
      </span>
    </Tip>
  )
}
