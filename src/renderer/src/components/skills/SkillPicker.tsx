// Lâmpada do composer: escolher skills do chat para carregar na próxima mensagem (chip "Carregar
// skill X"). No envio o main lê o SKILL.md e o anexa à mensagem como bloco <skill> (SPEC → Skills).
import { Lightbulb, Search, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Chat } from '@shared/types'
import { cn } from '../../lib/format'
import { activeSkills, filterSkills, shortLocation, skillsConfigOf } from '../../lib/skills'
import { selectPendingSkills, useStore } from '../../store'
import { ApiInfo, C, Tip } from '../ui/Tooltip'
import { Popover } from '../ui/layers'
import { useSkillsDiscovery } from './hooks'

export function SkillPickerButton({
  chat,
  sessionId
}: {
  chat: Chat
  sessionId: string
}): React.JSX.Element | null {
  const sc = skillsConfigOf(chat.config)
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)
  if (!sc.enabled) return null
  return (
    <>
      <Tip label="Carregar uma skill nesta mensagem">
        <button
          ref={anchor}
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            setOpen((o) => !o)
          }}
          data-testid="skill-picker-button"
          className={cn(
            'flex size-7 items-center justify-center rounded-lg text-subtle transition-colors hover:bg-hover hover:text-fg',
            open && 'bg-hover text-fg'
          )}
          aria-label="Carregar skill"
        >
          <Lightbulb className="size-4" />
        </button>
      </Tip>
      {open && (
        <Popover
          open={open}
          onClose={() => setOpen(false)}
          anchor={anchor}
          width={380}
          maxHeight={380}
          className="p-0"
        >
          <PickerBody chat={chat} sessionId={sessionId} onClose={() => setOpen(false)} />
        </Popover>
      )}
    </>
  )
}

function PickerBody({
  chat,
  sessionId,
  onClose
}: {
  chat: Chat
  sessionId: string
  onClose: () => void
}): React.JSX.Element {
  const { disc, loading } = useSkillsDiscovery(chat.config.cwd)
  const chosen = useStore(selectPendingSkills(sessionId))
  const setPending = useStore((s) => s.setPendingSkills)
  const openSkills = useStore((s) => s.openSkills)
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const all = useMemo(() => activeSkills(disc, skillsConfigOf(chat.config)), [disc, chat.config])
  const list = useMemo(() => filterSkills(all, q), [all, q])
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => input.current?.focus(), [])
  const pick = (name: string): void => {
    if (!chosen.includes(name)) setPending(sessionId, [...chosen, name])
    onClose()
  }
  return (
    <div data-testid="skill-picker" onClick={(e) => e.stopPropagation()}>
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Search className="size-3.5 shrink-0 text-faint" />
        <input
          ref={input}
          value={q}
          placeholder="Buscar skill…"
          aria-label="Buscar skill"
          onChange={(e) => {
            setQ(e.target.value)
            setSel(0)
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setSel((i) => Math.min(list.length - 1, i + 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setSel((i) => Math.max(0, i - 1))
            } else if (e.key === 'Enter') {
              e.preventDefault()
              if (list[sel]) pick(list[sel].name)
            }
          }}
          className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-faint"
        />
        <span className="shrink-0 text-[10.5px] text-faint tabular-nums">
          {list.length}/{all.length}
        </span>
      </div>
      <div className="max-h-[300px] overflow-y-auto p-1">
        {loading && !disc ? (
          <p className="px-2.5 py-2 text-[12px] text-subtle">Carregando…</p>
        ) : !all.length ? (
          <div className="px-2.5 py-2 text-[12px] text-subtle">
            Nenhuma skill ativa neste chat.{' '}
            <button
              type="button"
              onClick={() => {
                onClose()
                openSkills()
              }}
              className="text-accent-strong hover:underline"
            >
              Configurar locais
            </button>
          </div>
        ) : !list.length ? (
          <p className="px-2.5 py-2 text-[12px] text-subtle">Nenhuma skill para “{q}”.</p>
        ) : (
          list.map((s, i) => {
            const already = chosen.includes(s.name)
            return (
              <button
                key={s.file}
                type="button"
                role="option"
                aria-selected={i === sel}
                data-skill={s.name}
                onMouseEnter={() => setSel(i)}
                onClick={() => pick(s.name)}
                className={cn(
                  'flex w-full items-start gap-2 rounded-lg px-2.5 py-1.5 text-left',
                  i === sel ? 'bg-hover' : 'hover:bg-hover/60'
                )}
              >
                <Lightbulb className="mt-0.5 size-3.5 shrink-0 text-accent-strong/80" />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate font-mono text-[12px] text-fg/90">{s.name}</span>
                    {already && (
                      <span className="text-[10.5px] text-accent-strong">na mensagem</span>
                    )}
                    <span
                      className="ml-auto max-w-[45%] shrink-0 truncate text-[10.5px] text-faint"
                      title={s.dir}
                    >
                      {shortLocation(s.locationLabel)}
                    </span>
                  </span>
                  <span className="line-clamp-2 text-[11.5px] leading-snug text-subtle">
                    {s.description}
                  </span>
                </span>
              </button>
            )
          })
        )}
      </div>
      <p className="border-t border-border px-3 py-1.5 text-[10.5px] text-faint">
        O SKILL.md é lido no envio e vai junto com a mensagem.{' '}
        <span className="text-subtle">↑/↓ Enter · Esc fecha</span>
      </p>
    </div>
  )
}

/** Chip "Carregar skill X" acima do campo do composer. */
export function SkillChip({
  name,
  onRemove
}: {
  name: string
  onRemove: () => void
}): React.JSX.Element {
  return (
    <div
      data-testid="skill-chip"
      data-skill={name}
      className="flex h-9 animate-pop-in items-center gap-2 rounded-xl border border-accent/30 bg-accent-soft/40 pr-1.5 pl-2.5 text-[12.5px]"
    >
      <Lightbulb className="size-3.5 shrink-0 text-accent-strong" />
      <span className="text-muted">
        Carregar skill <span className="font-mono text-fg/90">{name}</span>
      </span>
      <ApiInfo title={`Skill ${name}`} side="top">
        <p>
          No envio, o SKILL.md desta skill é lido e anexado à mensagem como um part <C>text</C>{' '}
          <C>{'<skill name="…" path="…">…</skill>'}</C>, antes do texto digitado. Se não puder ser
          lido, a mensagem não é enviada (erro legível).
        </p>
      </ApiInfo>
      <button
        type="button"
        onClick={onRemove}
        className="rounded-md p-0.5 text-subtle hover:bg-hover hover:text-fg"
        aria-label={`Remover skill ${name}`}
      >
        <X className="size-3.5" />
      </button>
    </div>
  )
}
