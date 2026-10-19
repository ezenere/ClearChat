// Descoberta das skills nos locais configurados (fs, sem Electron — testável). Cada local é uma
// pasta cujas subpastas com `SKILL.md` são skills (ou a própria pasta, se tiver um SKILL.md).
// Precedência: a ordem dos locais (o primeiro vence em conflito de nome); as skills de projeto
// (`<raiz do chat>/.claude/skills`) vêm por último. Parse em cache por (mtime, tamanho) do SKILL.md;
// "Reescanear" limpa o cache. Ver SPEC.md → "Skills".
import { promises as fs } from 'fs'
import { homedir } from 'os'
import { basename, isAbsolute, join, relative, resolve, sep } from 'path'
import {
  PROJECT_LOCATION_ID,
  PROJECT_SKILLS_SUBDIR,
  SKILL_LIMITS,
  type SkillInfo,
  type SkillLocationScan,
  type SkillsDiscovery,
  type SkillsSettings
} from '@shared/skills'
import { parseSkillMd, type ParsedSkill } from './parse'

/** Expande `~` (home injetável nos testes). */
export function expandHome(p: string, home: string = homedir()): string {
  const s = p.trim()
  if (s === '~') return home
  if (s.startsWith('~/')) return join(home, s.slice(2))
  return isAbsolute(s) ? resolve(s) : resolve(home, s)
}

/** Caminho para exibição com `~` no lugar da home. */
export function tildePath(p: string, home: string = homedir()): string {
  if (p === home) return '~'
  return p.startsWith(home + sep) ? `~${p.slice(home.length)}` : p
}

interface CacheEntry {
  mtimeMs: number
  size: number
  parsed: ParsedSkill
}
const cache = new Map<string, CacheEntry>()

export function clearSkillsCache(): void {
  cache.clear()
}

async function statOrNull(p: string): Promise<import('fs').Stats | null> {
  try {
    return await fs.stat(p)
  } catch {
    return null
  }
}

/** Lê e faz o parse de um SKILL.md (com cache por mtime+tamanho). */
export async function readSkillFile(
  file: string,
  dirName: string,
  rescan = false
): Promise<{ parsed: ParsedSkill; mtimeMs: number; size: number }> {
  const st = await fs.stat(file)
  const hit = cache.get(file)
  if (!rescan && hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size)
    return { parsed: hit.parsed, mtimeMs: st.mtimeMs, size: st.size }
  let parsed: ParsedSkill
  if (st.size > SKILL_LIMITS.skillMdMaxBytes) {
    parsed = {
      meta: null,
      body: '',
      content: '',
      warnings: [],
      error: `SKILL.md grande demais (${Math.round(st.size / 1024)} KB; máx. ${SKILL_LIMITS.skillMdMaxBytes / 1024} KB)`
    }
  } else parsed = parseSkillMd(await fs.readFile(file, 'utf8'), dirName)
  cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, parsed })
  return { parsed, mtimeMs: st.mtimeMs, size: st.size }
}

export interface SkillFile {
  /** Relativo à pasta da skill, com `/`. */
  path: string
  size: number
}

const SKIP_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'venv'])

/**
 * Arquivos da pasta da skill (recursivo, ordenado; pula .git/node_modules/__pycache__ e pastas
 * ocultas; não segue links de pasta). Limites: SKILL_LIMITS.maxFiles / maxDepth.
 */
export async function listSkillFiles(
  dir: string
): Promise<{ files: SkillFile[]; truncated: boolean; total: number; size: number }> {
  const files: SkillFile[] = []
  let total = 0
  let size = 0
  let truncated = false
  const walk = async (d: string, depth: number): Promise<void> => {
    let ents: import('fs').Dirent[]
    try {
      ents = await fs.readdir(d, { withFileTypes: true })
    } catch {
      return
    }
    ents.sort((a, b) => a.name.localeCompare(b.name))
    for (const e of ents) {
      const p = join(d, e.name)
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue
        if (depth >= SKILL_LIMITS.maxDepth) {
          truncated = true
          continue
        }
        await walk(p, depth + 1)
        continue
      }
      if (e.name === '.DS_Store') continue
      const st = await statOrNull(p) // segue links de arquivo
      if (!st || !st.isFile()) continue
      total++
      size += st.size
      if (files.length < SKILL_LIMITS.maxFiles)
        files.push({ path: relative(dir, p).split(sep).join('/'), size: st.size })
      else truncated = true
    }
  }
  await walk(dir, 0)
  // SKILL.md primeiro, depois a ordem alfabética por caminho
  files.sort((a, b) =>
    a.path === 'SKILL.md' ? -1 : b.path === 'SKILL.md' ? 1 : a.path.localeCompare(b.path)
  )
  return { files, truncated, total, size }
}

interface LocationInput {
  id: string
  path: string
  label: string
  enabled: boolean
  kind: 'global' | 'project'
}

async function scanLocation(
  loc: LocationInput,
  home: string,
  opts: { counts?: boolean; rescan?: boolean }
): Promise<SkillLocationScan> {
  const resolved = expandHome(loc.path, home)
  const scan: SkillLocationScan = { ...loc, resolved, exists: false, skills: [] }
  const st = await statOrNull(resolved)
  if (!st) return scan
  if (!st.isDirectory()) {
    scan.error = 'não é uma pasta'
    return scan
  }
  scan.exists = true
  // a própria pasta é uma skill?
  const own = await statOrNull(join(resolved, 'SKILL.md'))
  let dirs: string[]
  if (own?.isFile()) dirs = [resolved]
  else {
    let names: string[]
    try {
      names = (await fs.readdir(resolved)).filter((n) => !n.startsWith('.')).sort()
    } catch (e) {
      scan.error = `não foi possível ler a pasta (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})`
      return scan
    }
    dirs = []
    for (const n of names) {
      const d = join(resolved, n)
      const s = await statOrNull(join(d, 'SKILL.md')) // segue links de pasta (skills linkadas)
      if (s?.isFile()) dirs.push(d)
      if (dirs.length >= SKILL_LIMITS.maxSkillsPerLocation) {
        scan.error = `mais de ${SKILL_LIMITS.maxSkillsPerLocation} skills — as demais foram ignoradas`
        break
      }
    }
  }
  for (const dir of dirs) {
    const file = join(dir, 'SKILL.md')
    const dirName = basename(dir)
    let info: SkillInfo
    try {
      const { parsed, mtimeMs, size } = await readSkillFile(file, dirName, opts.rescan)
      info = {
        name: parsed.meta?.name ?? dirName,
        description: parsed.meta?.description ?? '',
        dir,
        file,
        locationId: loc.id,
        locationLabel: loc.label,
        ...(parsed.meta ? { meta: parsed.meta } : {}),
        warnings: parsed.warnings,
        ...(parsed.error ? { error: parsed.error } : {}),
        mtime: mtimeMs,
        size
      }
    } catch (e) {
      info = {
        name: dirName,
        description: '',
        dir,
        file,
        locationId: loc.id,
        locationLabel: loc.label,
        warnings: [],
        error: `não foi possível ler o SKILL.md (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})`
      }
    }
    if (opts.counts) info.files = (await listSkillFiles(dir)).total
    scan.skills.push(info)
  }
  return scan
}

export interface DiscoverInput {
  settings: SkillsSettings
  /** Locais do app (skills baixadas pelo sync), depois dos locais do usuário. */
  appLocations?: { id: string; path: string; label: string }[]
  /** Diretório raiz do chat (skills de projeto, se `settings.projectSkills`). */
  cwd?: string | null
  counts?: boolean
  rescan?: boolean
  home?: string
}

/** Local de projeto de um diretório raiz. */
export function projectLocation(cwd: string): LocationInput {
  return {
    id: PROJECT_LOCATION_ID,
    path: join(cwd, PROJECT_SKILLS_SUBDIR),
    label: `projeto · ${PROJECT_SKILLS_SUBDIR}`,
    enabled: true,
    kind: 'project'
  }
}

/**
 * Escaneia todos os locais (inclusive desabilitados, para a UI) e calcula as skills efetivas:
 * válidas, de locais habilitados, primeira ocorrência de cada nome (as demais ganham `shadowedBy`).
 */
export async function discoverSkills(input: DiscoverInput): Promise<SkillsDiscovery> {
  const home = input.home ?? homedir()
  if (input.rescan) clearSkillsCache()
  const locs: LocationInput[] = input.settings.locations.map((l) => ({
    id: l.id,
    path: l.path,
    label: l.path.startsWith('~') ? l.path : tildePath(expandHome(l.path, home), home),
    enabled: l.enabled,
    kind: 'global'
  }))
  for (const a of input.appLocations ?? []) {
    if (locs.some((l) => expandHome(l.path, home) === expandHome(a.path, home))) continue
    locs.push({ id: a.id, path: a.path, label: a.label, enabled: true, kind: 'global' })
  }
  if (input.settings.projectSkills && input.cwd) {
    const p = projectLocation(input.cwd)
    const resolvedP = expandHome(p.path, home)
    // a raiz do chat é a home (ou outro local já listado) → não duplica
    if (!locs.some((l) => expandHome(l.path, home) === resolvedP)) locs.push(p)
  }
  const opts = { counts: input.counts, rescan: false }
  const locations = await Promise.all(locs.map((l) => scanLocation(l, home, opts)))
  const winners = new Map<string, SkillInfo>()
  const skills: SkillInfo[] = []
  for (const loc of locations) {
    for (const s of loc.skills) {
      if (s.error || !loc.enabled) continue
      const w = winners.get(s.name)
      if (w) {
        s.shadowedBy = w.locationLabel
        continue
      }
      winners.set(s.name, s)
      skills.push(s)
    }
  }
  return { locations, skills }
}

/** Acha uma skill efetiva pelo nome (exato; senão sem caixa; senão pelo nome da pasta). */
export function findSkill(skills: SkillInfo[], name: string): SkillInfo | undefined {
  const n = name.trim()
  return (
    skills.find((s) => s.name === n) ??
    skills.find((s) => s.name.toLowerCase() === n.toLowerCase()) ??
    skills.find((s) => basename(s.dir) === n)
  )
}
