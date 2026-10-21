// Configurações GLOBAIS de aprovação (settings `approvalModes` / `approvalLists`): leitura
// normalizada, atualização (Configurações → Aprovações) e inclusão de entradas pelo card
// ("Sim + whitelist" / "Não + blacklist"). Emite `approval-settings-updated`.
import {
  APPROVAL_LISTS_SETTING,
  APPROVAL_MODES_SETTING,
  normalizeApprovalLists,
  normalizeApprovalModes,
  normalizeApprovalSettings,
  validateListEntry
} from '@shared/approvalPolicy'
import { normalizeSmartDefaults, SMART_DEFAULTS_SETTING } from '@shared/smartDefaults'
import type { ApprovalListItem, ApprovalSettings } from '@shared/types'
import { emit } from './events'
import { settingsRepo } from './repo'

export function getApprovalSettings(): ApprovalSettings {
  return normalizeApprovalSettings(
    settingsRepo.get(APPROVAL_MODES_SETTING),
    settingsRepo.get(APPROVAL_LISTS_SETTING),
    settingsRepo.get(SMART_DEFAULTS_SETTING)
  )
}

const listeners = new Set<() => void>()
/** Avisado quando as listas mudam (runner reavalia aprovações pendentes). */
export function onApprovalListsChanged(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function changed(listsChanged: boolean): ApprovalSettings {
  const s = getApprovalSettings()
  emit({ type: 'approval-settings-updated', settings: s })
  if (listsChanged) for (const fn of listeners) fn()
  return s
}

/**
 * Substitui modos, listas e/ou os padrões do Smart-Approve (cada um inteiro). Entradas inválidas nas
 * listas → erro legível. `smart` é local (setting `smartApproveDefaults`, fora do sync).
 */
export function updateApprovalSettings(patch: Partial<ApprovalSettings>): ApprovalSettings {
  if (patch?.modes) settingsRepo.set(APPROVAL_MODES_SETTING, normalizeApprovalModes(patch.modes))
  if (patch?.smart) settingsRepo.set(SMART_DEFAULTS_SETTING, normalizeSmartDefaults(patch.smart))
  if (patch?.lists) {
    const lists = normalizeApprovalLists(patch.lists)
    for (const item of Object.keys(lists) as ApprovalListItem[]) {
      for (const e of [...lists[item].allow, ...lists[item].deny]) {
        const err = validateListEntry(item, e)
        if (err) throw new Error(`Entrada inválida "${e}": ${err}`)
      }
    }
    settingsRepo.set(APPROVAL_LISTS_SETTING, lists)
  }
  return changed(!!patch?.lists)
}

/**
 * Acrescenta entradas às listas globais (sem duplicar). Uma entrada que vai para a whitelist sai
 * da blacklist do mesmo item e vice-versa (a decisão mais recente vale).
 */
export function addListEntries(
  entries: { item: ApprovalListItem; list: 'allow' | 'deny'; entry: string }[]
): ApprovalSettings {
  if (!entries.length) return getApprovalSettings()
  const lists = getApprovalSettings().lists
  for (const { item, list, entry } of entries) {
    const e = entry.replace(/\s+/g, ' ').trim()
    const err = validateListEntry(item, e)
    if (err) throw new Error(`Entrada inválida "${e}": ${err}`)
    const other = list === 'allow' ? 'deny' : 'allow'
    lists[item][other] = lists[item][other].filter((x) => x !== e)
    if (!lists[item][list].includes(e)) lists[item][list].push(e)
  }
  settingsRepo.set(APPROVAL_LISTS_SETTING, lists)
  return changed(true)
}
