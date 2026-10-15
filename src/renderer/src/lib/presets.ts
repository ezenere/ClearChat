// Personas no renderer: config base de um chat novo (padrões de "Novos chats") e resolução de
// uma persona sobre ela.
import { DEFAULT_CHAT_CONFIG, supportsCacheControl } from '@shared/defaults'
import { providerKind } from '@shared/providerKinds'
import { defaultModelRef, resolvePresetModel } from '@shared/models'
import { DEFAULT_PRESET_NAME, applyPreset } from '@shared/presets'
import type { ChatConfig, Preset, Provider } from '@shared/types'
import type { AppSettings } from '../store'

/**
 * Config que um chat novo teria sem persona. Modelo = o par padrão (provedor + modelo) de "Novos
 * chats"; sem ele (ou com o provedor apagado), nenhum — o Novo chat pede para escolher.
 */
export function newChatBase(
  settings: AppSettings,
  providers: Provider[],
  homeDir: string | null
): ChatConfig {
  const ref = defaultModelRef(
    settings,
    providers.map((p) => p.id)
  )
  const provider = providers.find((p) => p.id === ref.providerId)
  return DEFAULT_CHAT_CONFIG(settings.defaultCwd ?? homeDir ?? '', {
    providerId: ref.providerId,
    model: ref.model,
    systemPrompt: settings.defaultSystemPrompt ?? undefined,
    baseUrl: provider?.baseUrl,
    kind: provider ? providerKind(provider) : undefined
  })
}

/**
 * Config completa de uma persona: persona sobre a base. Provedor + modelo andam juntos
 * (`resolvePresetModel`): sem modelo ou com o provedor apagado → o par padrão. Sem
 * `cacheEnabled` na persona → segue o provedor (OpenRouter e Anthropic ligam).
 */
export function resolvePreset(
  base: ChatConfig,
  preset: Pick<Preset, 'config'> | null | undefined,
  providers: Provider[]
): ChatConfig {
  const cfg = applyPreset(base, preset?.config)
  const { ref } = resolvePresetModel(
    { providerId: base.providerId, model: base.model },
    preset?.config,
    providers.map((p) => p.id)
  )
  cfg.providerId = ref.providerId
  cfg.model = ref.model
  if (preset?.config.cacheEnabled === undefined) {
    const prov = providers.find((p) => p.id === cfg.providerId)
    if (prov) cfg.cacheEnabled = supportsCacheControl(providerKind(prov))
  }
  return cfg
}

/** A persona define um modelo cujo provedor foi apagado (→ usa o par padrão; a UI avisa). */
export function presetProviderMissing(
  preset: Pick<Preset, 'config'> | null | undefined,
  providers: Provider[]
): boolean {
  return resolvePresetModel(
    { providerId: '', model: '' },
    preset?.config,
    providers.map((p) => p.id)
  ).missingProvider
}

/** Persona inicial do Novo chat: a padrão → "Padrão" → a primeira → nenhuma. */
export function initialPresetId(presets: Preset[], defaultPresetId: string | null): string | null {
  return (
    presets.find((p) => p.id === defaultPresetId)?.id ??
    presets.find((p) => p.name === DEFAULT_PRESET_NAME)?.id ??
    presets[0]?.id ??
    null
  )
}

const FIELD_LABELS: Record<string, string> = {
  providerId: 'modelo',
  model: 'modelo',
  systemPrompt: 'system prompt',
  params: 'parâmetros',
  enabledTools: 'tools',
  nativeTools: 'tools',
  toolsInPrompt: 'tools',
  toolsPromptText: 'tools',
  autoApprove: 'aprovação',
  subagentSystemPrompt: 'subagentes',
  envInPrompt: 'ambiente',
  cacheEnabled: 'cache',
  appSignature: 'assinatura',
  appSignatureCustom: 'assinatura',
  contextWindow: 'contexto',
  compactThreshold: 'contexto',
  autoCompact: 'contexto',
  compactPrompt: 'contexto',
  maxToolOutputChars: 'limites',
  confineToRoot: 'raiz',
  sandboxBash: 'raiz',
  cwd: 'diretório raiz'
}

/** Resumo do que a persona define (quando não há descrição). */
export function presetSummary(p: Pick<Preset, 'config'>): string {
  const labels = [...new Set(Object.keys(p.config).map((k) => FIELD_LABELS[k] ?? k))]
  if (!labels.length) return 'Segue os padrões de “Novos chats”'
  const shown = labels.slice(0, 3).join(', ')
  return `Define ${shown}${labels.length > 3 ? ` e mais ${labels.length - 3}` : ''}`
}
