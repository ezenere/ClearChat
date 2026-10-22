// Áudio/voz — ligação com o app: as settings globais (`audioInput`, `sttSettings`, `ttsSettings`,
// `voiceCallDefaults`) no settings genérico do banco, sempre lidas completas e normalizadas.
// A UI, a captura de áudio, os backends STT/TTS e o sync (protocolo 1.5.0) entram em fatias
// futuras. Ver SPEC.md → "Áudio".
import {
  AUDIO_INPUT_SETTING,
  normalizeAudioInput,
  normalizeSttSettings,
  normalizeTtsSettings,
  normalizeVoiceCallDefaults,
  STT_SETTINGS_SETTING,
  TTS_SETTINGS_SETTING,
  VOICE_CALL_DEFAULTS_SETTING,
  type AudioInputSettings,
  type SttSettings,
  type TtsSettings,
  type VoiceCallDefaults
} from '@shared/voice'
import { settingsRepo } from './repo'

export interface VoiceSettings {
  /** Ditado: microfone, push-to-talk, silêncio e idioma (100% global). */
  audioInput: AudioInputSettings
  /** Voz em texto (STT): modo, endpoint de API e motor local. */
  stt: SttSettings
  /** Texto em voz (TTS): backend, endpoint de API e motor local. */
  tts: TtsSettings
  /** Padrões globais herdados por chats/personas quando `ChatConfig.voice` tem null. */
  voiceCallDefaults: VoiceCallDefaults
}

/** Settings de áudio/voz completas (ausente/inválido → os padrões de `@shared/voice`). */
export function getVoiceSettings(): VoiceSettings {
  return {
    audioInput: normalizeAudioInput(settingsRepo.get(AUDIO_INPUT_SETTING)),
    stt: normalizeSttSettings(settingsRepo.get(STT_SETTINGS_SETTING)),
    tts: normalizeTtsSettings(settingsRepo.get(TTS_SETTINGS_SETTING)),
    voiceCallDefaults: normalizeVoiceCallDefaults(settingsRepo.get(VOICE_CALL_DEFAULTS_SETTING))
  }
}
