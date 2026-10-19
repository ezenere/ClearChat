// Skills — API do main (IPC, runner): settings globais (setting `skillsSettings`), descoberta e
// skills ativas por chat, invocação manual e pastas do sandbox. Ver SPEC.md → "Skills".
import { promises as fs } from 'fs'
import {
  normalizeSkillsConfig,
  normalizeSkillsSettings,
  skillsActiveFor,
  SKILLS_SETTING,
  type SkillInfo,
  type SkillsDiscoverOptions,
  type SkillsDiscovery,
  type SkillsSettings
} from '@shared/skills'
import type { Chat, ChatConfig, ContentPart, Session } from '@shared/types'
import { settingsRepo } from '../repo'
import { discoverSkills, expandHome } from './discovery'
import { activeFromDiscovery, resolveManualSkills } from './config'

export function getSkillsSettings(): SkillsSettings {
  return normalizeSkillsSettings(settingsRepo.get(SKILLS_SETTING))
}

/** Substitui `locations` e/ou `projectSkills`. Caminho vazio/duplicado é descartado. */
export function updateSkillsSettings(patch: Partial<SkillsSettings>): SkillsSettings {
  if (!patch || typeof patch !== 'object') throw new Error('Configuração de skills inválida.')
  const cur = getSkillsSettings()
  if (patch.locations !== undefined && !Array.isArray(patch.locations))
    throw new Error('Lista de locais inválida.')
  const next = normalizeSkillsSettings({ ...cur, ...patch })
  settingsRepo.set(SKILLS_SETTING, next)
  return next
}

export function discover(opts: SkillsDiscoverOptions = {}): Promise<SkillsDiscovery> {
  return discoverSkills({
    settings: getSkillsSettings(),
    cwd: opts.cwd ?? null,
    counts: !!opts.counts,
    rescan: !!opts.rescan
  })
}

/** Skills ativas no chat (ligadas, locais habilitados + projeto, menos as desligadas). */
export async function activeSkillsFor(
  cfg: Pick<ChatConfig, 'skills' | 'cwd'>
): Promise<SkillInfo[]> {
  if (!normalizeSkillsConfig(cfg.skills).enabled) return []
  return activeFromDiscovery(await discover({ cwd: cfg.cwd }), cfg)
}

/** Skills ativas para as tools desta sessão (subagente só com `skills.subagents`). */
export async function sessionSkills(
  chat: Pick<Chat, 'config'>,
  session: Pick<Session, 'depth'>
): Promise<SkillInfo[]> {
  if (!skillsActiveFor(normalizeSkillsConfig(chat.config.skills), session)) return []
  return activeSkillsFor(chat.config)
}

/** Pastas montadas somente leitura no sandbox do shell (skills ativas da sessão). */
export async function sandboxSkillDirs(
  chat: Pick<Chat, 'config'>,
  session: Pick<Session, 'depth'>
): Promise<string[]> {
  try {
    return (await sessionSkills(chat, session)).map((s) => s.dir)
  } catch (e) {
    console.error('[clearchat] skills (sandbox)', e)
    return []
  }
}

/** Invocação manual: lê os SKILL.md escolhidos no composer (erro legível → mensagem não enviada). */
export async function manualSkillParts(
  chat: Pick<Chat, 'config'>,
  names: unknown
): Promise<ContentPart[]> {
  if (names == null || (Array.isArray(names) && !names.length)) return []
  const active = await activeSkillsFor(chat.config)
  return resolveManualSkills(names, chat.config, active, (f) => fs.readFile(f, 'utf8'))
}

/** Caminho absoluto de um local (para "Abrir pasta"). */
export function resolveLocationPath(path: string): string {
  return expandHome(path)
}
