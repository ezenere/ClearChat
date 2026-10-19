// Skills (formato Agent Skills da Anthropic / Claude Code): uma skill é uma pasta com `SKILL.md`
// (frontmatter YAML `name` + `description` + campos opcionais, e o corpo em markdown) e arquivos
// extras opcionais (referências, scripts). NÃO existe índice de skills no contexto: com as skills
// ligadas no chat vão um prompt de apoio (opcional) e as tools list_skills / skill_load /
// skill_read. Locais globais em Configurações → Skills (setting `skillsSettings`); por chat/persona
// em `ChatConfig.skills`. Ver SPEC.md → "Skills".

/** Pasta padrão (Claude Code, skills pessoais). Guardada com `~` (expandida ao escanear). */
export const DEFAULT_SKILLS_DIR = '~/.claude/skills'
/** Subpasta das skills de projeto, dentro do diretório raiz do chat. */
export const PROJECT_SKILLS_SUBDIR = '.claude/skills'
/** Setting global com os locais. */
export const SKILLS_SETTING = 'skillsSettings'
/** Id do "local" das skills de projeto (resolvido por chat). */
export const PROJECT_LOCATION_ID = 'project'

export const SKILL_LIMITS = {
  /** Spec: name ≤ 64, description ≤ 1024, compatibility ≤ 500. */
  nameChars: 64,
  descriptionChars: 1024,
  compatibilityChars: 500,
  /** SKILL.md maior que isso não é lido (fica inválida). */
  skillMdMaxBytes: 1024 * 1024,
  /** Invocação manual (bloco <skill> na mensagem): teto de caracteres do SKILL.md. */
  manualMaxChars: 200_000,
  /** Listagem de arquivos de uma skill (skill_load / Configurações). */
  maxFiles: 500,
  maxDepth: 6,
  /** Skills por local (pastas além disso são ignoradas com aviso). */
  maxSkillsPerLocation: 500
} as const

export interface SkillLocation {
  id: string
  /** Caminho como o usuário escolheu (`~` permitido). */
  path: string
  enabled: boolean
}

export interface SkillsSettings {
  /** Ordem = precedência (o primeiro local vence em conflito de nome). */
  locations: SkillLocation[]
  /** Incluir `<diretório raiz do chat>/.claude/skills` (depois dos locais globais). */
  projectSkills: boolean
}

export function defaultSkillsSettings(): SkillsSettings {
  return {
    locations: [{ id: 'default', path: DEFAULT_SKILLS_DIR, enabled: true }],
    projectSkills: true
  }
}

/** Settings completas a partir de qualquer valor salvo (ausente → padrão; ids únicos; caminhos não vazios). */
export function normalizeSkillsSettings(v: unknown): SkillsSettings {
  const d = defaultSkillsSettings()
  if (!v || typeof v !== 'object' || Array.isArray(v)) return d
  const src = v as Record<string, unknown>
  const seenIds = new Set<string>()
  const seenPaths = new Set<string>()
  const locations: SkillLocation[] = []
  if (Array.isArray(src.locations)) {
    for (const x of src.locations) {
      if (!x || typeof x !== 'object') continue
      const l = x as Record<string, unknown>
      const path = typeof l.path === 'string' ? l.path.trim() : ''
      if (!path || seenPaths.has(path)) continue
      let id = typeof l.id === 'string' && l.id ? l.id : `loc-${locations.length + 1}`
      while (seenIds.has(id) || id === PROJECT_LOCATION_ID) id = `${id}-2`
      seenIds.add(id)
      seenPaths.add(path)
      locations.push({ id, path, enabled: l.enabled !== false })
    }
  } else locations.push(...d.locations)
  return {
    locations,
    projectSkills: typeof src.projectSkills === 'boolean' ? src.projectSkills : d.projectSkills
  }
}

/** Config por chat/persona (`ChatConfig.skills`). Ausente = desligada. */
export interface SkillsConfig {
  /** Desligado → NADA de skills vai para a API (sem prompt de apoio, sem tools, sem invocação manual). */
  enabled: boolean
  /** Skills desligadas neste chat/persona (por nome). Padrão: todas as dos locais habilitados. */
  disabled: string[]
  /** Prompt de apoio anexado ao system prompt (text null = DEFAULT_SKILLS_SUPPORT_PROMPT). */
  supportPrompt: { enabled: boolean; text: string | null }
  /** Subagentes recebem as mesmas tools + prompt de apoio (mesmas skills ativas do chat). */
  subagents: boolean
}

export function defaultSkillsConfig(): SkillsConfig {
  return {
    enabled: false,
    disabled: [],
    supportPrompt: { enabled: true, text: null },
    subagents: false
  }
}

export function normalizeSkillsConfig(v: unknown): SkillsConfig {
  const d = defaultSkillsConfig()
  if (!v || typeof v !== 'object' || Array.isArray(v)) return d
  const src = v as Record<string, unknown>
  const sp = (src.supportPrompt ?? {}) as Record<string, unknown>
  return {
    enabled: src.enabled === true,
    disabled: Array.isArray(src.disabled)
      ? [...new Set(src.disabled.filter((x): x is string => typeof x === 'string' && !!x))]
      : [],
    supportPrompt: {
      enabled: sp.enabled !== false,
      text: typeof sp.text === 'string' && sp.text.trim() ? sp.text : null
    },
    subagents: src.subagents === true
  }
}

/** As skills (tools + prompt de apoio) vão para a API nesta sessão? */
export function skillsActiveFor(cfg: SkillsConfig, session: { depth: number }): boolean {
  return cfg.enabled && (session.depth === 0 || cfg.subagents)
}

/** Campos do frontmatter que o app conhece (os demais são mostrados como "outros campos"). */
export interface SkillMeta {
  name: string
  description: string
  license?: string
  compatibility?: string
  /** `allowed-tools` (texto como veio; lista vira string separada por espaço). Só informativo. */
  allowedTools?: string
  metadata?: Record<string, string>
  /** Outros campos do frontmatter (chave → valor como texto), ignorados pelo app. */
  other?: Record<string, string>
}

export interface SkillInfo {
  /** Nome efetivo (frontmatter `name`, ou o nome da pasta se ausente). */
  name: string
  description: string
  /** Pasta da skill (absoluta, como encontrada). */
  dir: string
  /** `<dir>/SKILL.md`. */
  file: string
  locationId: string
  /** Rótulo do local (`~/.claude/skills`, `projeto · .claude/skills`). */
  locationLabel: string
  meta?: SkillMeta
  /** Avisos (nome ≠ pasta, nome fora do padrão, descrição longa…). A skill continua válida. */
  warnings: string[]
  /** Inválida (sem frontmatter, sem description, YAML ruim…): não é oferecida ao modelo. */
  error?: string
  /** Outra skill com o mesmo nome num local anterior vence: rótulo desse local. */
  shadowedBy?: string
  /** Quantidade de arquivos na pasta (só em discover com `counts`). */
  files?: number
  size?: number
  mtime?: number
}

export interface SkillLocationScan {
  id: string
  /** Como configurado (`~/.claude/skills`) — no projeto, `<raiz>/.claude/skills`. */
  path: string
  /** Caminho absoluto (com `~` expandido). */
  resolved: string
  label: string
  enabled: boolean
  kind: 'global' | 'project'
  exists: boolean
  error?: string
  skills: SkillInfo[]
}

export interface SkillsDiscovery {
  locations: SkillLocationScan[]
  /** Skills efetivas: válidas, de locais habilitados, sem as sobrescritas (ordem: local → nome). */
  skills: SkillInfo[]
}

export interface SkillsDiscoverOptions {
  /** Diretório raiz do chat (skills de projeto, se ligadas). */
  cwd?: string | null
  /** Conta os arquivos de cada skill (Configurações). */
  counts?: boolean
  /** Ignora o cache (botão "Reescanear"). */
  rescan?: boolean
}

/** Metadados privados do part de invocação manual (`_skill`, nunca enviado). */
export interface SkillPartMeta {
  name: string
  /** Pasta da skill (absoluta) — o mesmo que vai no atributo `path` do bloco. */
  path: string
  /** SKILL.md cortado no limite. */
  truncated?: boolean
}

/** Escapa `& " < >` para atributos `name="…"` / `path="…"`. */
const attr = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Bloco enviado (part `text`) na invocação manual e no início do resultado de skill_load. */
export function skillBlock(name: string, path: string, content: string): string {
  return `<skill name="${attr(name)}" path="${attr(path)}">\n${content}\n</skill>`
}

/** Conteúdo (SKILL.md) de um bloco <skill> — para o preview na UI. */
export function skillBlockBody(text: string): string {
  const m = /^<skill name="[^"]*" path="[^"]*">\n([\s\S]*)\n<\/skill>$/.exec(text)
  return m ? m[1] : text
}
