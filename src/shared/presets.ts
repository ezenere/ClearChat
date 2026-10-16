// Personas (presets de chat): quais campos de ChatConfig um preset guarda e como é aplicado.
// Funções puras — usadas pelo main (sanitizar ao salvar) e pelo renderer (snapshot/aplicar).
import type { ChatConfig, ChatParams, Preset } from './types'
import { migrateConfigTools } from './toolRename'
import { migrateApprovalConfig, normalizeChatModes } from './approvalPolicy'

export type PresetConfig = Partial<ChatConfig>

/** Nome do preset criado na primeira execução (config vazia = segue os padrões de "Novos chats"). */
export const DEFAULT_PRESET_NAME = 'Padrão'
export const DEFAULT_PRESET_ICON = 'sparkles'
/** Settings: id da persona selecionada por padrão no Novo chat. */
export const DEFAULT_PRESET_SETTING = 'defaultPresetId'
/** Settings: marca que o preset "Padrão" já foi criado (apagá-lo não o recria). */
export const PRESETS_SEEDED_SETTING = 'presetsSeeded'

/**
 * Campos de ChatConfig que uma persona guarda. Ficam de fora: `cwd` (opcional — "incluir
 * diretório raiz") e `presetId` (informativo, do chat).
 */
export const PRESET_FIELDS = [
  'providerId',
  'model',
  'systemPrompt',
  'params',
  'enabledTools',
  'nativeTools',
  'toolsInPrompt',
  'toolsPromptText',
  'envInPrompt',
  'cacheEnabled',
  'subagentSystemPrompt',
  'approvalModes',
  'smartApprove',
  'appSignature',
  'appSignatureCustom',
  'contextWindow',
  'compactThreshold',
  'autoCompact',
  'compactPrompt',
  'maxToolOutputChars',
  'confineToRoot',
  'sandboxBash'
] as const satisfies readonly (keyof ChatConfig)[]

export type PresetField = (typeof PRESET_FIELDS)[number]

const clone = <T>(v: T): T => (v && typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : v)

function cleanParams(p: ChatParams | undefined): ChatParams {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(p ?? {})) {
    if (v === undefined || v === null || (typeof v === 'number' && Number.isNaN(v))) continue
    out[k] = v
  }
  return out as ChatParams
}

/**
 * Mantém só os campos de persona (e `cwd`, se for string não vazia); descarta `undefined`,
 * chaves desconhecidas e `presetId`. Params nulos são removidos. Retorna uma cópia.
 */
export function sanitizePresetConfig(cfg: unknown): PresetConfig {
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return {}
  // alias de leitura: autoApprove (≤ 0.3.0) → approvalModes
  const src = migrateApprovalConfig(migrateConfigTools(cfg as PresetConfig)) as Record<
    string,
    unknown
  >
  const out: Record<string, unknown> = {}
  for (const k of PRESET_FIELDS) {
    if (src[k] === undefined) continue
    out[k] =
      k === 'params'
        ? cleanParams(src[k] as ChatParams)
        : k === 'approvalModes'
          ? normalizeChatModes(src[k])
          : clone(src[k])
  }
  if (out.approvalModes && !Object.keys(out.approvalModes as object).length)
    delete out.approvalModes
  if (typeof src.cwd === 'string' && src.cwd.trim()) out.cwd = src.cwd
  return out as PresetConfig
}

/** Cópia sanitizada sem `cwd`. */
export function withoutCwd(cfg: PresetConfig | null | undefined): PresetConfig {
  const out = sanitizePresetConfig(cfg ?? {})
  delete out.cwd
  return out
}

/** Snapshot da config de um chat como persona. `includeCwd` (padrão false) guarda o diretório raiz. */
export function snapshotPreset(
  config: Partial<ChatConfig>,
  opts: { includeCwd?: boolean } = {}
): PresetConfig {
  const { cwd, ...rest } = config
  return sanitizePresetConfig(opts.includeCwd ? { ...rest, cwd } : rest)
}

/**
 * Aplica uma persona sobre uma config base (padrões do app): campos definidos na persona vencem;
 * `params` é mesclado (persona por cima). Retorna uma config completa nova (base não é alterada).
 */
export function applyPreset(base: ChatConfig, preset: PresetConfig | null | undefined): ChatConfig {
  const p = sanitizePresetConfig(preset ?? {})
  return {
    ...clone(base),
    ...p,
    params: { ...cleanParams(base.params), ...(p.params ?? {}) }
  }
}

/** Mescla um patch (com semântica de chat: params nulos = remover) num rascunho de persona. */
export function patchPresetConfig(draft: PresetConfig, patch: Partial<ChatConfig>): PresetConfig {
  const next: Record<string, unknown> = { ...draft }
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue
    next[k] = k === 'params' ? cleanParams({ ...(draft.params ?? {}), ...(v as ChatParams) }) : v
  }
  return sanitizePresetConfig(next)
}

/** Igualdade estrutural simples (JSON) — para detectar "personalizado". */
export function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
}

/** Nome para uma cópia: "X (cópia)", "X (cópia 2)"… sem repetir nomes existentes. */
export function copyName(name: string, existing: Pick<Preset, 'name'>[]): string {
  const base = name.replace(/ \(cópia(?: \d+)?\)$/, '')
  const taken = new Set(existing.map((p) => p.name))
  let n = 1
  let candidate = `${base} (cópia)`
  while (taken.has(candidate)) candidate = `${base} (cópia ${++n})`
  return candidate
}
