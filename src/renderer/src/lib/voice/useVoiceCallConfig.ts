// Config da chamada de voz do chat atual (persona→chat→global + ★/herança) para o dock e o painel
// de timeline (`VoiceCallDock`/`VoiceCallPanel`): resolve `ChatConfig.voice` contra `voiceCallDefaults`
// e grava overrides por `patchConfig` (a opção ★ = padrão global remove o override). Ver SPEC →
// "Chamada de voz → Modo sombra e timeline".
import { useEffect, useMemo, useState } from 'react'
import {
  DEFAULT_VOICE_CALL_CONFIG,
  DEFAULT_VOICE_CALL_DEFAULTS,
  resolveVoiceCallConfig,
  type InterjectionPolicy,
  type ResolvedVoiceCall,
  type VoiceCallConfig,
  type VoiceCallDefaults,
  type VoiceFillers
} from '@shared/voice'
import { api } from '../api'
import { useStore } from '../../store'

/** Config da chamada do chat atual + padrões globais (★/herança). */
export function useVoiceCallConfig(): {
  chatId: string | null
  voice: VoiceCallConfig
  defaults: VoiceCallDefaults
  resolved: ResolvedVoiceCall
  setInterjections: (patch: Partial<InterjectionPolicy> | 'inherit') => void
  setFillers: (patch: Partial<VoiceFillers> | 'inherit') => void
} {
  const chatId = useStore((s) => s.voiceCall.chatId)
  const chat = useStore((s) => s.chats.find((c) => c.id === s.voiceCall.chatId) ?? null)
  const patchConfig = useStore((s) => s.patchConfig)
  const [defaults, setDefaults] = useState<VoiceCallDefaults>(DEFAULT_VOICE_CALL_DEFAULTS)
  useEffect(() => {
    void api.voice?.settings
      .get()
      .then((all) => setDefaults(all.voiceCallDefaults))
      .catch(() => void 0)
  }, [])
  const voice: VoiceCallConfig = chat?.config.voice ?? DEFAULT_VOICE_CALL_CONFIG
  const resolved = useMemo(() => resolveVoiceCallConfig(voice, defaults), [voice, defaults])
  const setInterjections = (patch: Partial<InterjectionPolicy> | 'inherit'): void => {
    if (!chatId) return
    patchConfig(chatId, {
      voice: {
        ...voice,
        // ★ ("inherit") remove o override do grupo inteiro (enabled+shadow andam juntos)
        interjections: patch === 'inherit' ? null : { ...resolved.interjections, ...patch }
      }
    })
  }
  const setFillers = (patch: Partial<VoiceFillers> | 'inherit'): void => {
    if (!chatId) return
    patchConfig(chatId, {
      voice: { ...voice, fillers: patch === 'inherit' ? null : { ...resolved.fillers, ...patch } }
    })
  }
  return { chatId, voice, defaults, resolved, setInterjections, setFillers }
}
