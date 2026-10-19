// Skills — helpers puros da UI (seção do chat/persona, lâmpada do composer, cards). Sem React.
// Contrato: src/shared/skills.ts e SPEC.md → "Skills".
import { DEFAULT_SKILLS_SUPPORT_PROMPT } from '@shared/defaults'
import {
  normalizeSkillsConfig,
  type SkillInfo,
  type SkillsConfig,
  type SkillsDiscovery
} from '@shared/skills'
import type { ChatConfig } from '@shared/types'

export { DEFAULT_SKILLS_SUPPORT_PROMPT }

/** `ChatConfig.skills` completo (ausente/parcial → padrões). */
export function skillsConfigOf(
  cfg: Partial<Pick<ChatConfig, 'skills'>> | null | undefined
): SkillsConfig {
  return normalizeSkillsConfig(cfg?.skills)
}

/** Skills ativas (ligadas e não desligadas na config) a partir da descoberta. */
export function activeSkills(disc: SkillsDiscovery | null, sc: SkillsConfig): SkillInfo[] {
  if (!disc || !sc.enabled) return []
  const off = new Set(sc.disabled)
  return disc.skills.filter((s) => !off.has(s.name))
}

/** Liga/desliga uma skill na config (lista `disabled`). */
export function toggleSkill(sc: SkillsConfig, name: string, on: boolean): SkillsConfig {
  const disabled = on ? sc.disabled.filter((n) => n !== name) : [...new Set([...sc.disabled, name])]
  return { ...sc, disabled }
}

/** Texto do prompt de apoio que vai (null = não vai). */
export function supportPromptText(sc: SkillsConfig): string | null {
  if (!sc.enabled || !sc.supportPrompt.enabled) return null
  return sc.supportPrompt.text ?? DEFAULT_SKILLS_SUPPORT_PROMPT
}

const fold = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()

/** Filtro da lâmpada / listas: todos os termos no nome ou na descrição (sem acento/caixa). */
export function filterSkills(skills: SkillInfo[], query: string): SkillInfo[] {
  const terms = fold(query).split(/\s+/).filter(Boolean)
  if (!terms.length) return skills
  return skills.filter((s) => {
    const hay = fold(`${s.name} ${s.description}`)
    return terms.every((t) => hay.includes(t))
  })
}

/** Resumo do card das tools de skills (cabeçalho). */
export function skillToolSummary(name: string, args: Record<string, unknown> | null): string {
  if (!args) return ''
  const pick = (k: string): string => (typeof args[k] === 'string' ? (args[k] as string) : '')
  if (name === 'list_skills') return pick('query') ? `"${pick('query')}"` : ''
  if (name === 'skill_load') return pick('name')
  if (name === 'skill_read') {
    const range =
      args.offset != null || args.limit != null
        ? ` · linhas ${args.offset != null ? String(args.offset) : '1'}${args.limit != null ? `+${String(args.limit)}` : ''}`
        : ''
    return `${pick('name')}/${pick('path')}${range}`
  }
  return ''
}

export const isSkillTool = (name: string): boolean =>
  name === 'list_skills' || name === 'skill_load' || name === 'skill_read'

/** Nomes das skills listadas num resultado de list_skills (linhas "- nome — …"). */
export function listedSkillNames(result: string): string[] {
  return [...result.matchAll(/^- (\S+) — /gm)].map((m) => m[1])
}

/** Rótulo curto de um local (caminhos longos → `…/última-pasta`); o completo vai no title. */
export function shortLocation(label: string): string {
  if (label.length <= 26) return label
  const parts = label.split('/').filter(Boolean)
  return `…/${parts[parts.length - 1] ?? label}`
}
