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
  DEFAULT_TTS_LOCAL,
  normalizeAudioInput,
  normalizeSttSettings,
  normalizeTtsSettings,
  normalizeVoiceCallDefaults,
  STT_SETTINGS_SETTING,
  TTS_SETTINGS_SETTING,
  VOICE_CALL_DEFAULTS_SETTING,
  type AudioInputSettings,
  type SttLocalConfig,
  type SttLocalEngine,
  type SttSettings,
  type TtsLocalConfig,
  type TtsLocalEngine,
  type TtsSettings,
  type VoiceCallDefaults
} from '@shared/voice'
import { maskKey } from '@shared/webSearchSettings'
import { linkVoiceEndpointProvider, type VoiceCapability } from '@shared/voiceCatalog'
import type { Provider } from '@shared/types'
import { providerKind } from '@shared/providerKinds'
import type { LocalModelCatalogEntry } from './voice/catalog'
import { providersRepo, settingsRepo } from './repo'

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

/** Settings de áudio/voz como estão gravadas (normalizadas; `providerId` NÃO resolvido). */
function readVoiceSettings(): VoiceSettings {
  return {
    audioInput: normalizeAudioInput(settingsRepo.get(AUDIO_INPUT_SETTING)),
    stt: normalizeSttSettings(settingsRepo.get(STT_SETTINGS_SETTING)),
    tts: normalizeTtsSettings(settingsRepo.get(TTS_SETTINGS_SETTING)),
    voiceCallDefaults: normalizeVoiceCallDefaults(settingsRepo.get(VOICE_CALL_DEFAULTS_SETTING))
  }
}

/**
 * Endpoint efetivo de STT/TTS: com `providerId` apontando para um provedor salvo, `baseUrl` e
 * `apiKey` vêm do provedor (a chave dele nunca é copiada para a setting nem sai do main); provedor
 * ausente/apagado → os campos próprios da setting (endpoint avulso). Puro (lookup injetado).
 */
export function resolveVoiceEndpoint<
  T extends { providerId: string | null; baseUrl: string; apiKey: string }
>(api: T, lookup: (id: string) => Pick<Provider, 'baseUrl' | 'apiKey'> | null): T {
  const id = api.providerId?.trim()
  if (!id) return api
  const p = lookup(id)
  if (!p || !p.baseUrl.trim()) return api
  return { ...api, baseUrl: p.baseUrl.trim(), apiKey: p.apiKey.trim() }
}

/**
 * Settings de áudio/voz completas para os SERVIÇOS do main (ausente/inválido → os padrões de
 * `@shared/voice`), com o `providerId` de stt/tts resolvido para o endpoint/chave do provedor salvo.
 * Nunca vai ao renderer (a visão é `getVoiceSettingsView`, sem resolver e mascarada).
 */
export function getVoiceSettings(): VoiceSettings {
  const v = readVoiceSettings()
  const lookup = (id: string): Provider | null => providersRepo.get(id)
  return {
    ...v,
    stt: { ...v.stt, api: resolveVoiceEndpoint(v.stt.api, lookup) },
    tts: { ...v.tts, api: withTtsProviderKind(resolveVoiceEndpoint(v.tts.api, lookup), lookup) }
  }
}

/**
 * `providerKind` do provedor salvo no endpoint de fala resolvido (só para os serviços do main —
 * `'elevenlabs'` liga o cliente ElevenLabs direto; ver `voice/elevenlabs.ts`). Sem provedor → igual.
 */
export function withTtsProviderKind<T extends { providerId: string | null }>(
  api: T,
  lookup: (id: string) => Pick<Provider, 'baseUrl' | 'kind'> | null
): T & { providerKind?: string } {
  const id = api.providerId?.trim()
  const p = id ? lookup(id) : null
  return p ? { ...api, providerKind: providerKind(p) } : api
}

/**
 * Endpoint PERSONALIZADO salvo na setting da capacidade (baseUrl + chave própria, sem resolver o
 * `providerId`) — a descoberta de modelos (`voice:catalog:list` com `providerId: null`) lista com
 * ele. A chave nunca sai do main.
 */
export function getVoiceCustomEndpoint(capability: VoiceCapability): {
  baseUrl: string
  apiKey: string
} {
  const v = readVoiceSettings()
  const api = capability === 'stt' ? v.stt.api : v.tts.api
  return { baseUrl: api.baseUrl, apiKey: api.apiKey }
}

/** Flag da migração "endpoint avulso → provedor cadastrado" (uma vez por banco). */
export const VOICE_PROVIDER_LINK_FLAG = 'migration.voiceProviderLink'

/**
 * Migração (uma vez) da UI antiga de campos livres para provedor + modelo: liga `sttSettings.api`
 * / `ttsSettings.api` ao provedor cadastrado com a mesma `baseUrl` (só quando a chave própria está
 * vazia ou é a do provedor — senão fica "endpoint personalizado") e corrige o modelo sem prefixo
 * no OpenRouter (`whisper-large-v3-turbo` → `openai/whisper-large-v3-turbo`) — ver
 * `linkVoiceEndpointProvider`. Grava pelo `setVoiceSetting` (a chave própria é preservada).
 * Devolve o que mudou (para log).
 */
export function migrateVoiceProviderLinks(): string[] {
  if (settingsRepo.get(VOICE_PROVIDER_LINK_FLAG)) return []
  const providers = providersRepo.list()
  const v = readVoiceSettings()
  const changes: string[] = []
  const stt = linkVoiceEndpointProvider(v.stt.api, providers, 'stt')
  if (stt.linked || stt.model) {
    // chave ausente no `set` = preserva a chave própria salva
    const { apiKey: _k, ...api } = stt.api
    void _k
    setVoiceSetting('sttSettings', { ...v.stt, api })
    if (stt.linked) changes.push(`stt → provedor ${stt.linked}`)
    if (stt.model) changes.push(`stt modelo ${stt.model.from} → ${stt.model.to}`)
  }
  const tts = linkVoiceEndpointProvider(v.tts.api, providers, 'tts')
  if (tts.linked || tts.model) {
    const { apiKey: _k, ...api } = tts.api
    void _k
    setVoiceSetting('ttsSettings', { ...v.tts, api })
    if (tts.linked) changes.push(`tts → provedor ${tts.linked}`)
    if (tts.model) changes.push(`tts modelo ${tts.model.from} → ${tts.model.to}`)
  }
  settingsRepo.set(VOICE_PROVIDER_LINK_FLAG, 1)
  return changes
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
  // sem resolver o `providerId`: a chave do provedor nunca entra na visão (nem mascarada)
  const v = readVoiceSettings()
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

// ---------------- sincronia installed ↔ disco (SPEC → "Áudio → Componentes locais") ----------------

/**
 * Mantém `installed` de `sttSettings.local`/`ttsSettings.local` em sincronia com o disco quando um
 * modelo local é instalado/removido pelos canais `voice:models:*` (a escrita passa por
 * `setVoiceSetting`, então a `apiKey` nunca é tocada). Instalar **escolhe** o modelo como atual
 * (`installed: true`); remover o atual derruba o flag para `false` (a seleção engine/modelo fica —
 * a UI oferece "Baixar novamente"). Remover um modelo que não é o atual não mexe nas settings.
 * Idempotente; a SEMÂNTICA de "pronto para transcrever" não é o flag — é `deriveHasLocalReady`
 * (disco) na sessão de transcrição.
 */
export function syncLocalModelInstalled(entry: LocalModelCatalogEntry, installed: boolean): void {
  switch (entry.kind) {
    case 'stt': {
      const cur = normalizeSttSettings(settingsRepo.get(STT_SETTINGS_SETTING))
      const local: SttLocalConfig | null = cur.local
      if (installed) {
        setVoiceSetting('sttSettings', {
          ...cur,
          local: { engine: entry.engine as SttLocalEngine, model: entry.id, installed: true }
        })
        return
      }
      // só o modelo atual perde o flag (engine atual + id atual ou seleção "padrão do motor")
      if (
        local &&
        local.engine === entry.engine &&
        (local.model === entry.id || !local.model.trim())
      ) {
        setVoiceSetting('sttSettings', { ...cur, local: { ...local, installed: false } })
      }
      return
    }
    case 'tts': {
      const cur = normalizeTtsSettings(settingsRepo.get(TTS_SETTINGS_SETTING))
      const local: TtsLocalConfig | null = cur.local
      if (installed) {
        setVoiceSetting('ttsSettings', {
          ...cur,
          local: {
            engine: entry.engine as TtsLocalEngine,
            voice: local?.voice || DEFAULT_TTS_LOCAL.voice,
            installed: true
          }
        })
        return
      }
      if (local && local.engine === entry.engine) {
        setVoiceSetting('ttsSettings', { ...cur, local: { ...local, installed: false } })
      }
    }
  }
}
