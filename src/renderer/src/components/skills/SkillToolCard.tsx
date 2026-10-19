// Corpo compacto dos cards de list_skills / skill_load / skill_read (o resultado completo continua
// no "Resultado" expandido do ToolCard, com o (i) role: tool).
import { ArrowUpRight, BookOpen, BookOpenText, Lightbulb, type LucideIcon } from 'lucide-react'
import type { StoredMessage, ToolName } from '@shared/types'
import { listedSkillNames } from '../../lib/skills'
import { useStore } from '../../store'

export const SKILL_TOOL_ICONS: Partial<Record<ToolName, LucideIcon>> = {
  list_skills: Lightbulb,
  skill_load: BookOpen,
  skill_read: BookOpenText
}

export function SkillToolBody({
  name,
  args,
  result,
  resultText
}: {
  name: string
  args: Record<string, unknown> | null
  result?: StoredMessage
  resultText: string
}): React.JSX.Element | null {
  const openSkills = useStore((s) => s.openSkills)
  if (!result || result.meta.toolStatus === 'error' || result.meta.toolStatus === 'denied') {
    return result && result.meta.toolStatus === 'error' ? (
      <p className="border-t border-border/70 px-3.5 py-2 text-[12px] text-danger/85">
        {resultText.split('\n')[0].slice(0, 300)}
      </p>
    ) : null
  }
  const link = (skill: string, label = skill): React.JSX.Element => (
    <button
      key={skill}
      type="button"
      onClick={() => openSkills(skill)}
      title="Ver em Configurações → Skills"
      className="inline-flex items-center gap-0.5 rounded-md border border-border bg-bg/50 px-1.5 py-0.5 font-mono text-[11px] text-muted hover:border-accent/40 hover:text-fg"
    >
      {label}
      <ArrowUpRight className="size-3 text-faint" />
    </button>
  )
  if (name === 'list_skills') {
    const names = listedSkillNames(resultText)
    const head = resultText.split('\n')[0]
    return (
      <div data-testid="skill-tool-body" className="border-t border-border/70 px-3.5 py-2">
        <p className="mb-1.5 text-[11.5px] text-subtle">{head.replace(/^\[|\]$/g, '')}</p>
        {names.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {names.slice(0, 16).map((n) => link(n))}
            {names.length > 16 && (
              <span className="text-[11px] text-faint">+{names.length - 16}</span>
            )}
          </div>
        )}
      </div>
    )
  }
  const skill = typeof args?.name === 'string' ? args.name : ''
  if (name === 'skill_load') {
    const files = /\nArquivos \(([\d.]+)/.exec(resultText)?.[1]
    const dir = /\nPasta da skill: (.+)/.exec(resultText)?.[1]
    return (
      <div
        data-testid="skill-tool-body"
        className="flex items-center gap-2 border-t border-border/70 px-3.5 py-2 text-[12px] text-muted"
      >
        <span className="min-w-0 flex-1 truncate">
          SKILL.md carregado{files ? ` · ${files} arquivo${files === '1' ? '' : 's'}` : ''}
          {dir && <span className="font-mono text-[11px] text-faint"> · {dir}</span>}
        </span>
        {skill && link(skill)}
      </div>
    )
  }
  if (name === 'skill_read') {
    const lines =
      /\[fim do arquivo · ([\d.]+) linhas\]/.exec(resultText)?.[1] ??
      /arquivo (?:grande: |com )([\d.]+) linhas/.exec(resultText)?.[1]
    const range = /mostrando (linhas [\d.]+–[\d.]+)/.exec(resultText)?.[1]
    return (
      <div
        data-testid="skill-tool-body"
        className="flex items-center gap-2 border-t border-border/70 px-3.5 py-2 text-[12px] text-muted"
      >
        <span className="min-w-0 flex-1 truncate">
          <span className="font-mono text-[11.5px]">
            {typeof args?.path === 'string' ? args.path : ''}
          </span>
          {lines && (
            <span className="text-subtle">
              {' '}
              · {range ? `${range} de ${lines}` : `${lines} linhas`}
            </span>
          )}
        </span>
        {skill && link(skill)}
      </div>
    )
  }
  return null
}
