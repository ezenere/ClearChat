// Skills — resolução por chat e invocação manual (puro sobre o resultado da descoberta; sem
// Electron). Ver SPEC.md → "Skills".
import {
  normalizeSkillsConfig,
  SKILL_LIMITS,
  skillBlock,
  type SkillInfo,
  type SkillsDiscovery
} from '@shared/skills'
import type { ChatConfig, ContentPart } from '@shared/types'
import { normalizeSkillText } from './parse'
import { findSkill } from './discovery'

/** Skills ativas num chat/persona: as efetivas da descoberta menos as desligadas na config. */
export function activeFromDiscovery(
  disc: Pick<SkillsDiscovery, 'skills'>,
  cfg: Pick<ChatConfig, 'skills'>
): SkillInfo[] {
  const sc = normalizeSkillsConfig(cfg.skills)
  if (!sc.enabled) return []
  const off = new Set(sc.disabled)
  return disc.skills.filter((s) => !off.has(s.name))
}

/**
 * Part da invocação manual: `{type:'text', text:'<skill name path>…SKILL.md…</skill>', _skill}`
 * (o `_skill` é privado e sai na request). SKILL.md normalizado (LF) e cortado no limite.
 */
export function manualSkillPart(skill: Pick<SkillInfo, 'name' | 'dir'>, raw: string): ContentPart {
  let content = normalizeSkillText(raw).replace(/\n+$/, '')
  const truncated = content.length > SKILL_LIMITS.manualMaxChars
  if (truncated)
    content = `${content.slice(0, SKILL_LIMITS.manualMaxChars)}\n[… SKILL.md cortado: mostrando ${SKILL_LIMITS.manualMaxChars.toLocaleString('pt-BR')} de ${content.length.toLocaleString('pt-BR')} caracteres — leia o resto com skill_read]`
  return {
    type: 'text',
    text: skillBlock(skill.name, skill.dir, content),
    _skill: { name: skill.name, path: skill.dir, ...(truncated ? { truncated: true } : {}) }
  }
}

/**
 * Resolve os nomes escolhidos no composer contra as skills ativas e lê os SKILL.md AGORA (no envio).
 * Erro legível (a mensagem não é enviada): skills desligadas, skill inexistente/desligada, leitura.
 */
export async function resolveManualSkills(
  names: unknown,
  cfg: Pick<ChatConfig, 'skills'>,
  active: SkillInfo[],
  read: (file: string) => Promise<string>
): Promise<ContentPart[]> {
  if (names == null) return []
  if (!Array.isArray(names) || names.some((n) => typeof n !== 'string'))
    throw new Error('Lista de skills inválida.')
  const list = [...new Set(names as string[])].filter((n) => n.trim())
  if (!list.length) return []
  if (!normalizeSkillsConfig(cfg.skills).enabled)
    throw new Error(
      'As skills estão desligadas neste chat — ligue-as na aba Tools para carregar uma skill.'
    )
  const parts: ContentPart[] = []
  for (const name of list) {
    const s = findSkill(active, name)
    if (!s)
      throw new Error(
        `Skill "${name}" não está disponível neste chat (removida, desligada ou inválida). Remova o chip e escolha de novo.`
      )
    let raw: string
    try {
      raw = await read(s.file)
    } catch (e) {
      throw new Error(
        `Não foi possível ler a skill "${s.name}" (${s.file}): ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}. A mensagem não foi enviada.`,
        { cause: e }
      )
    }
    parts.push(manualSkillPart(s, raw))
  }
  return parts
}
