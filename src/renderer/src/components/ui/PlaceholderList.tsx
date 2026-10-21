import type { ReactNode } from 'react'
import { HelpTip } from './Tooltip'

export interface PlaceholderItem {
  key: string
  desc: string
  required?: boolean
}

export interface PlaceholderGroup {
  title: string
  items: readonly PlaceholderItem[]
}

/**
 * Placeholders de um prompt/template: os nomes ficam à vista (chips `{{chave}}`, para copiar ao
 * editar); a descrição de cada um (e uma nota opcional) fica no (?) do primeiro grupo.
 */
export function PlaceholderList({
  groups,
  note,
  testId
}: {
  groups: readonly PlaceholderGroup[]
  note?: ReactNode
  testId?: string
}): React.JSX.Element {
  const help = (
    <>
      {groups.map((g) => (
        <div key={g.title}>
          {groups.length > 1 && <div className="mb-0.5 font-medium text-fg/90">{g.title}</div>}
          <dl className="grid grid-cols-[auto_1fr] gap-x-2.5 gap-y-0.5 text-[11px]">
            {g.items.map((p) => (
              <div key={p.key} className="contents">
                <dt className="font-mono text-accent-strong">{`{{${p.key}}}`}</dt>
                <dd>
                  {p.desc}
                  {p.required && <span className="text-warning/90"> · obrigatório</span>}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      ))}
      {note && <p className="text-faint">{note}</p>}
    </>
  )
  return (
    <div data-testid={testId} className="space-y-1">
      {groups.map((g, i) => (
        <div key={g.title} className="flex flex-wrap items-center gap-1 text-[10.5px]">
          <span className="mr-0.5 font-medium text-subtle">{g.title}</span>
          {i === 0 && (
            <HelpTip label="Placeholders" wide side="left" className="mr-0.5">
              {help}
            </HelpTip>
          )}
          {g.items.map((p) => (
            <code
              key={p.key}
              title={p.required ? `${p.desc} · obrigatório` : p.desc}
              className="rounded bg-white/[0.04] px-1 py-px font-mono text-[10.5px] text-accent-strong/90"
            >
              {`{{${p.key}}}`}
              {p.required && <span className="text-warning/90">*</span>}
            </code>
          ))}
        </div>
      ))}
    </div>
  )
}
