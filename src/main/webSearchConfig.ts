// Configuração dos buscadores do web_search (Configurações → Pesquisa na web): lista ordenada
// (setting `webSearchEngines`) e chaves de API (setting `webSearchApiKeys`, só no main — o renderer
// recebe a máscara "tvly-…abcd"; a chave em claro só sai por `revealKey`, a pedido).
import type { WebSearchEngineState, WebSearchSettingsState } from '@shared/ipc'
import {
  ENGINE_META,
  isApiEngine,
  maskKey,
  normalizeEngines,
  normalizeKeys,
  SEARCH_ENGINES_SETTING,
  SEARCH_KEYS_SETTING,
  type ApiEngineId,
  type EngineConfig,
  type SearchEngineId
} from '@shared/webSearchSettings'
import { settingsRepo } from './repo'
import type { PlanEntry } from './tools/webSearch'

const keys = (): Partial<Record<ApiEngineId, string>> =>
  normalizeKeys(settingsRepo.get(SEARCH_KEYS_SETTING))

export function getEngines(): EngineConfig[] {
  const k = keys()
  return normalizeEngines(settingsRepo.get(SEARCH_ENGINES_SETTING), (id) => !!k[id])
}

export function getWebSearchSettings(): WebSearchSettingsState {
  const k = keys()
  const engines: WebSearchEngineState[] = normalizeEngines(
    settingsRepo.get(SEARCH_ENGINES_SETTING),
    (id) => !!k[id]
  ).map((e) => {
    const key = isApiEngine(e.id) ? k[e.id] : undefined
    return { ...e, hasKey: !!key, keyMask: maskKey(key) }
  })
  return { engines }
}

/** Buscadores habilitados, na ordem, com as chaves (para o web_search). */
export function getSearchPlan(): PlanEntry[] {
  const k = keys()
  return getEngines()
    .filter((e) => e.enabled)
    .map((e) => ({ id: e.id, options: e.options, key: isApiEngine(e.id) ? k[e.id] : undefined }))
}

export function getEngineEntry(id: SearchEngineId): PlanEntry {
  if (!(id in ENGINE_META)) throw new Error('Buscador desconhecido.')
  const e = getEngines().find((x) => x.id === id)!
  return { id, options: e.options, key: isApiEngine(id) ? keys()[id] : undefined }
}

/**
 * Substitui a lista (ordem + liga/desliga + opções). Ligar um buscador que exige chave sem chave
 * salva é recusado com erro legível.
 */
export function updateWebSearchEngines(engines: EngineConfig[]): WebSearchSettingsState {
  if (!Array.isArray(engines)) throw new Error('Lista de buscadores inválida.')
  const k = keys()
  for (const e of engines) {
    if (e && e.enabled && e.id in ENGINE_META && isApiEngine(e.id) && !k[e.id])
      throw new Error(`Informe a chave de API para habilitar o ${ENGINE_META[e.id].label}.`)
  }
  settingsRepo.set(
    SEARCH_ENGINES_SETTING,
    normalizeEngines(engines, (id) => !!k[id])
  )
  return getWebSearchSettings()
}

/** Salva (ou, com null/vazio, remove) a chave de um buscador. Sem chave, o buscador é desligado. */
export function setWebSearchKey(id: SearchEngineId, key: string | null): WebSearchSettingsState {
  if (!(id in ENGINE_META) || !isApiEngine(id)) throw new Error('Este buscador não usa chave.')
  const k = keys()
  const v = typeof key === 'string' ? key.trim() : ''
  if (/\s/.test(v)) throw new Error('A chave não pode conter espaços.')
  if (v) k[id] = v
  else delete k[id]
  settingsRepo.set(SEARCH_KEYS_SETTING, Object.keys(k).length ? k : null)
  // re-normaliza a lista (sem chave → desligado)
  settingsRepo.set(SEARCH_ENGINES_SETTING, getEngines())
  return getWebSearchSettings()
}

/** Chave em claro (botão "mostrar" do campo, a pedido do usuário). */
export function revealWebSearchKey(id: SearchEngineId): string | null {
  return isApiEngine(id) ? (keys()[id] ?? null) : null
}
