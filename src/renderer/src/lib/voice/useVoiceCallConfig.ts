// Config da chamada de voz do chat atual (persona→chat→global + ★/herança) para o dock e o painel
// de timeline (`VoiceCallDock`/`VoiceCallPanel`): resolve `ChatConfig.voice` contra `voiceCallDefaults`
// e grava overrides por `patchConfig` (a opção ★ = padrão global remove o override). Os padrões
// globais vêm do espelho reativo `useVoiceSettings` (nunca uma cópia do primeiro mount). Ver SPEC →
// "Chamada de voz → Modo sombra e timeline".
import { useEffect, useMemo } from 'react'
import {
  DEFAULT_VOICE_CALL_CONFIG,
  resolveVoiceCallConfig,
  type InterjectionPolicy,
  type ResolvedVoiceCall,
  type VoiceCallConfig,
  type VoiceCallDefaults,
  type VoiceFillers
} from '@shared/voice'
import { useStore } from '../../store'
import { loadVoiceSettings, useVoiceSettings } from './voiceSettings'

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
  // padrões globais do espelho único (`voiceSettings`): Configurações → Áudio grava por lá e o ★
  // acompanha na hora; relê ao abrir a chamada (outra tela pode ter mudado)
  const defaults = useVoiceSettings((s) => s.view.voiceCallDefaults)
  useEffect(() => {
    if (chatId) void loadVoiceSettings()
  }, [chatId])
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
