// Modelo = par (provedor, id do modelo). O mesmo id pode existir em mais de um provedor (ex.: um
// Claude via OpenRouter e via Anthropic) — o que se escolhe é sempre o par. Funções puras.
import type { ChatConfig, Session } from './types'

export interface ModelRef {
  providerId: string
  model: string
}

/**
 * Par padrão de "Novos chats" (`defaultProviderId` + `defaultModel`). Provedor apagado (ou sem
 * modelo) → não definido (`{ providerId: '', model: '' }`): não existe "provedor padrão" sozinho.
 */
export function defaultModelRef(
  settings: { defaultProviderId?: string | null; defaultModel?: string | null },
  providerIds: readonly string[]
): ModelRef {
  const pid = settings.defaultProviderId ?? ''
  const model = (settings.defaultModel ?? '').trim()
  if (!pid || !model || !providerIds.includes(pid)) return { providerId: '', model: '' }
  return { providerId: pid, model }
}

/**
 * Par efetivo de uma persona. Persona sem modelo → o par padrão (o `providerId` sozinho é
 * ignorado). Persona com modelo mas sem `providerId` (antigas) → o modelo no provedor padrão.
 * Provedor da persona apagado → o par padrão, com `missingProvider` (a UI avisa).
 */
export function resolvePresetModel(
  base: ModelRef,
  preset: Pick<Partial<ChatConfig>, 'providerId' | 'model'> | null | undefined,
  providerIds: readonly string[]
): { ref: ModelRef; missingProvider: boolean } {
  const model = preset?.model?.trim() ?? ''
  if (!model) return { ref: { ...base }, missingProvider: false }
  const pid = preset?.providerId ?? ''
  if (!pid) return { ref: { providerId: base.providerId, model }, missingProvider: false }
  if (providerIds.includes(pid)) return { ref: { providerId: pid, model }, missingProvider: false }
  return { ref: { ...base }, missingProvider: true }
}

/**
 * Provedor de uma sessão: a principal segue o chat (trocar o modelo/provedor no meio do chat vale
 * na próxima request); subsessões guardam o provedor com que foram criadas (antigas, sem ele →
 * o do chat).
 */
export function sessionProviderId(
  config: Pick<ChatConfig, 'providerId'>,
  session: Pick<Session, 'depth' | 'providerId'> | null | undefined
): string {
  if (session && session.depth > 0 && session.providerId) return session.providerId
  return config.providerId
}
