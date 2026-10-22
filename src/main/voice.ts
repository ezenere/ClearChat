// Áudio/voz — ligação com o app: as settings globais (`audioInput`, `sttSettings`, `ttsSettings`,
// `voiceCallDefaults`) no settings genérico do banco, sempre lidas completas e normalizadas.
// Escrita tipada por `setVoiceSetting` (normaliza + grava + devolve o valor gravado). A `apiKey` de
// stt/tts fica no JSON da setting mas NUNCA sai daqui: a visão de IPC (`getVoiceSettingsView`) a
// devolve mascarada (`maskKey`) e a escrita por cima do valor mascarado preserva a chave real (o
// mesmo padrão de `webSearchApiKeys`/`PROTECTED_SETTINGS` — os dois grupos são settings protegidos
// do `settings:get/set` genérico). A transcrição vive em `voice/stt.ts` + `voice/session.ts`.
// Ver SPEC.md → "Áudio".
import type { VoiceSettingKind, VoiceSettingsMap, VoiceSettingsView } from '@shared/ipc'
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
import { maskKey } from '@shared/webSearchSettings'
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

// ---------------- visão para a UI (chaves de API mascaradas) ----------------

const maskStt = (s: SttSettings): SttSettings => ({
  ...s,
  api: { ...s.api, apiKey: maskKey(s.api.apiKey) ?? '' }
})
const maskTts = (s: TtsSettings): TtsSettings => ({
  ...s,
  api: { ...s.api, apiKey: maskKey(s.api.apiKey) ?? '' }
})

/**
 * Os 4 grupos como a UI os vê (`voice:settings:get`): completos e normalizados, com
 * `api.apiKey` **mascarada** (`maskKey`; `''` quando não há chave). A chave real nunca sai do main.
 */
export function getVoiceSettingsView(): VoiceSettingsView {
  const v = getVoiceSettings()
  return {
    audioInput: v.audioInput,
    sttSettings: maskStt(v.stt),
    ttsSettings: maskTts(v.tts),
    voiceCallDefaults: v.voiceCallDefaults
  }
}

// ---------------- escrita (voice:settings:set) ----------------

/**
 * O que fazer com a `api.apiKey` vinda num `set`:
 * - `undefined` (campo ausente), lixo, a própria chave ou o valor **mascarado** → preserva a chave
 *   salva (gravar por cima da máscara nunca apaga a chave real — padrão de `webSearchApiKeys`);
 * - `null` ou `''` → remove a chave;
 * - qualquer outra string (aparada) → nova chave.
 */
function resolveKeyWrite(incoming: unknown, stored: string): string | undefined {
  if (incoming === undefined) return undefined
  if (incoming === null) return ''
  if (typeof incoming !== 'string') return undefined // lixo nunca apaga a chave
  const v = incoming.trim()
  if (!v) return ''
  if (v === stored || v === (maskKey(stored) ?? '')) return undefined
  return v
}

const asObj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}

/** `raw` com `api.apiKey` resolvida (chave preservada/gravada/removida) antes do normalizador. */
function withResolvedKey(raw: unknown, stored: string): Record<string, unknown> {
  const api = asObj(asObj(raw).api)
  const write = resolveKeyWrite(api.apiKey, stored)
  return { ...asObj(raw), api: { ...api, apiKey: write === undefined ? stored : write } }
}

/**
 * Normaliza, grava um dos 4 grupos (pelas chaves de setting) e devolve o valor gravado — com
 * `api.apiKey` mascarada nos grupos stt/tts (mesma visão de `getVoiceSettingsView`). Grupo
 * desconhecido → erro legível.
 */
export function setVoiceSetting(kind: 'audioInput', value: unknown): AudioInputSettings
export function setVoiceSetting(kind: 'sttSettings', value: unknown): SttSettings
export function setVoiceSetting(kind: 'ttsSettings', value: unknown): TtsSettings
export function setVoiceSetting(kind: 'voiceCallDefaults', value: unknown): VoiceCallDefaults
export function setVoiceSetting(
  kind: VoiceSettingKind,
  value: unknown
): VoiceSettingsMap[VoiceSettingKind]
export function setVoiceSetting(
  kind: VoiceSettingKind,
  value: unknown
): VoiceSettingsMap[VoiceSettingKind] {
  switch (kind) {
    case 'audioInput': {
      const saved = normalizeAudioInput(value)
      settingsRepo.set(AUDIO_INPUT_SETTING, saved)
      return saved
    }
    case 'sttSettings': {
      const stored = normalizeSttSettings(settingsRepo.get(STT_SETTINGS_SETTING))
      const saved = normalizeSttSettings(withResolvedKey(value, stored.api.apiKey))
      settingsRepo.set(STT_SETTINGS_SETTING, saved)
      return maskStt(saved)
    }
    case 'ttsSettings': {
      const stored = normalizeTtsSettings(settingsRepo.get(TTS_SETTINGS_SETTING))
      const saved = normalizeTtsSettings(withResolvedKey(value, stored.api.apiKey))
      settingsRepo.set(TTS_SETTINGS_SETTING, saved)
      return maskTts(saved)
    }
    case 'voiceCallDefaults': {
      const saved = normalizeVoiceCallDefaults(value)
      settingsRepo.set(VOICE_CALL_DEFAULTS_SETTING, saved)
      return saved
    }
  }
  throw new Error(`Grupo de configuração de áudio desconhecido: ${String(kind)}.`)
}
