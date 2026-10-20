// list_skills / skill_load / skill_read (SPEC → Skills). Só leitura; recebem as skills ATIVAS do
// chat em `ctx.skills` (o runner resolve). skill_read fica confinado (realpath) à pasta da skill —
// vale mesmo com o chat confinado ao diretório raiz (as skills moram fora dele).
import { promises as fs } from 'fs'
import { isAbsolute, resolve } from 'path'
import { skillBlock, type SkillInfo } from '@shared/skills'
import { findSkill, listSkillFiles, tildePath } from '../skills/discovery'
import { normalizeSkillText } from '../skills/parse'
import { readFile } from './files'
import {
  fmtNum,
  fmtSize,
  isInside,
  maxOutputOf,
  ok,
  optString,
  realpathDeep,
  requireString,
  ToolError,
  type ToolContext,
  type ToolResult
} from './util'

const fold = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim()

function skillsOf(ctx: ToolContext): SkillInfo[] {
  return ctx.skills ?? []
}

function notFound(name: string, skills: SkillInfo[]): ToolError {
  const names = skills.map((s) => s.name)
  const list = names.length
    ? ` Disponíveis: ${names.slice(0, 30).join(', ')}${names.length > 30 ? `, … (+${names.length - 30})` : ''}.`
    : ' Nenhuma skill disponível neste chat.'
  return new ToolError(
    `Erro: skill "${name}" não encontrada.${list} Use list_skills para ver nomes e descrições.`
  )
}

export async function listSkillsTool(
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  const skills = skillsOf(ctx)
  const query = optString(args, 'query')?.trim()
  if (!skills.length)
    return ok(
      'Nenhuma skill disponível neste chat (o usuário instala/ativa skills em Configurações → Skills e na aba Tools do chat).'
    )
  const terms = query ? fold(query).split(/\s+/).filter(Boolean) : []
  const matches = terms.length
    ? skills.filter((s) => {
        const hay = fold(`${s.name} ${s.description}`)
        return terms.every((t) => hay.includes(t))
      })
    : skills
  if (!matches.length)
    return ok(
      `Nenhuma skill para "${query}" (${fmtNum(skills.length)} disponíveis — chame list_skills sem query para ver todas).`
    )
  const header = query
    ? `[${fmtNum(matches.length)} de ${fmtNum(skills.length)} skills para "${query}"]`
    : `[${fmtNum(skills.length)} skill${skills.length === 1 ? '' : 's'} disponíve${skills.length === 1 ? 'l' : 'is'} neste chat]`
  const footer = 'Carregue a que se aplica com skill_load {"name": "…"} antes de começar a tarefa.'
  const budget = maxOutputOf(ctx) - header.length - footer.length - 120
  const lines: string[] = []
  let used = 0
  for (const s of matches) {
    const line = `- ${s.name} — ${oneLine(s.description)} (${s.locationLabel})`
    if (lines.length && used + line.length + 1 > budget) break
    lines.push(line)
    used += line.length + 1
  }
  const rest = matches.length - lines.length
  return ok(
    [
      header,
      ...lines,
      ...(rest > 0 ? [`[… mais ${fmtNum(rest)} skills — refine com query]`] : []),
      footer
    ].join('\n')
  )
}

export async function skillLoadTool(
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  const skills = skillsOf(ctx)
  const name = requireString(args, 'name')
  const s = findSkill(skills, name)
  if (!s) throw notFound(name, skills)
  const raw = normalizeSkillText(await fs.readFile(s.file, 'utf8')).replace(/\n+$/, '')
  const listing = await listSkillFiles(s.dir)
  const max = maxOutputOf(ctx)
  const fileLines = listing.files.map((f) => `${f.path} (${fmtSize(f.size)})`)
  const hint = `Leia arquivos da skill com skill_read {"name": "${s.name}", "path": "<caminho relativo>"}; rode os scripts dela com a tool shell pelo caminho absoluto (${s.dir}/…).`
  const head = `\n\nPasta da skill: ${s.dir}\nArquivos (${fmtNum(listing.total)}${listing.truncated ? ', lista cortada' : ''}):\n`
  // a lista de arquivos usa no máx. 1/3 do teto
  let filesText = fileLines.join('\n')
  if (filesText.length > max / 3) {
    const kept: string[] = []
    let used = 0
    for (const l of fileLines) {
      if (used + l.length + 1 > max / 3) break
      kept.push(l)
      used += l.length + 1
    }
    filesText = `${kept.join('\n')}\n[… mais ${fmtNum(fileLines.length - kept.length)} arquivos]`
  }
  const tail = `${head}${filesText}\n\n${hint}`
  let content = raw
  const budget = Math.max(1000, max - tail.length - s.name.length - s.dir.length - 200)
  if (content.length > budget) {
    let cut = content.lastIndexOf('\n', budget)
    if (cut < budget * 0.7) cut = budget
    const shownLines = content.slice(0, cut).split('\n').length
    content = `${content.slice(0, cut)}\n[… SKILL.md cortado: mostrando ${fmtNum(cut)} de ${fmtNum(raw.length)} caracteres — leia o resto com skill_read {"name": "${s.name}", "path": "SKILL.md", "offset": ${shownLines + 1}}]`
  }
  // instruções a seguir à risca: nunca vão para arquivo (já limitadas pelo teto de saída)
  return { ...ok(`${skillBlock(s.name, s.dir, content)}${tail}`), noSpill: true }
}

export async function skillReadTool(
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  const skills = skillsOf(ctx)
  const name = requireString(args, 'name')
  const s = findSkill(skills, name)
  if (!s) throw notFound(name, skills)
  const p = requireString(args, 'path').trim()
  const abs = isAbsolute(p) ? resolve(p) : resolve(s.dir, p)
  const dirReal = await realpathDeep(s.dir)
  const real = await realpathDeep(abs)
  if (!isInside(dirReal, real))
    throw new ToolError(
      `Erro: acesso negado — "${p}" fica fora da pasta da skill "${s.name}" (${tildePath(s.dir)}). skill_read só lê arquivos da própria skill; use caminhos relativos a ela.`
    )
  // mesmo formato/limites do read_file, com a pasta da skill como base (caminhos exibidos relativos)
  return readFile({ ...args, path: abs }, { ...ctx, cwd: s.dir, confine: false })
}
