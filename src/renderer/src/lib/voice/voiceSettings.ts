// Settings de voz no renderer (espelho único de `voice:settings:get`): o ditado (`useDictation`),
// o botão/painel da chamada (`VoiceCallButton`, `useVoiceCallConfig`) e Configurações → Áudio leem
// daqui e quem grava (`saveVoiceSetting`) atualiza todos de uma vez — sem cópias locais que ficam
// velhas (o ★ dos padrões globais e o botão de telefone seguiam o valor do primeiro mount). O main
// não emite evento de mudança dessas settings: além das gravações feitas por aqui, `loadVoiceSettings`
// é chamado ao fechar as Configurações e antes de começar uma gravação/chamada.
import { create } from 'zustand'
import type { VoiceSettingKind, VoiceSettingsMap, VoiceSettingsView } from '@shared/ipc'
import {
  DEFAULT_AUDIO_INPUT,
  DEFAULT_STT_SETTINGS,
  DEFAULT_TTS_SETTINGS,
  DEFAULT_VOICE_CALL_DEFAULTS
} from '@shared/voice'
import { api } from '../api'

/** Padrões enquanto a primeira leitura não chega (ou sem `window.api.voice`). */
export const DEFAULT_VOICE_SETTINGS_VIEW: VoiceSettingsView = {
  audioInput: { ...DEFAULT_AUDIO_INPUT },
  sttSettings: { ...DEFAULT_STT_SETTINGS },
  ttsSettings: { ...DEFAULT_TTS_SETTINGS },
  voiceCallDefaults: { ...DEFAULT_VOICE_CALL_DEFAULTS }
}

interface VoiceSettingsState {
  view: VoiceSettingsView
  /** A leitura do main já chegou ao menos uma vez. */
  loaded: boolean
}

export const useVoiceSettings = create<VoiceSettingsState>(() => ({
  view: DEFAULT_VOICE_SETTINGS_VIEW,
  loaded: false
}))

let inflight: Promise<VoiceSettingsView> | null = null

/** Relê os 4 grupos do main (chamadas simultâneas compartilham a request). */
export function loadVoiceSettings(): Promise<VoiceSettingsView> {
  const voice = api.voice
  if (!voice) return Promise.resolve(useVoiceSettings.getState().view)
  inflight ??= voice.settings
    .get()
    .then((view) => {
      useVoiceSettings.setState({ view, loaded: true })
      return view
    })
    .catch(() => useVoiceSettings.getState().view)
    .finally(() => {
      inflight = null
    })
  return inflight
}

/** Aplica um grupo já gravado (valor normalizado devolvido pelo main) no espelho. */
export function applyVoiceSetting<K extends VoiceSettingKind>(
  kind: K,
  value: VoiceSettingsMap[K]
): void {
  useVoiceSettings.setState((s) => ({ view: { ...s.view, [kind]: value } }))
}

/**
 * Grava um grupo (`voice:settings:set`) e publica o valor normalizado para todos os consumidores.
 * Rejeita com o erro do main (quem chama mostra — gravação nunca falha em silêncio).
 */
export async function saveVoiceSetting<K extends VoiceSettingKind>(
  kind: K,
  value: unknown
): Promise<VoiceSettingsMap[K]> {
  const voice = api.voice
  if (!voice) throw new Error('API de voz indisponível neste build.')
  const saved = await voice.settings.set(kind, value)
  applyVoiceSetting(kind, saved)
  return saved
}
