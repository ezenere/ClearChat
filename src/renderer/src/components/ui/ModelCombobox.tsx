import { Check, ChevronDown, CornerDownLeft, RefreshCw, Search } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ModelInfo } from '@shared/types'
import { cn, modelMeta } from '../../lib/format'
import { useStore } from '../../store'
import { Popover } from './layers'
import { Spinner } from './controls'

const MAX_ROWS = 150

function matches(m: ModelInfo, tokens: string[]): boolean {
  const hay = `${m.id} ${m.name ?? ''}`.toLowerCase()
  return tokens.every((t) => hay.includes(t))
}

/** Combobox pesquisável de modelos (`providers.listModels`) que aceita texto livre. */
export function ModelCombobox({
  providerId,
  value,
  onChange,
  autoFocus,
  className
}: {
  providerId: string | null
  value: string
  onChange: (model: string) => void
  autoFocus?: boolean
  className?: string
}): React.JSX.Element {
  const entry = useStore((s) => (providerId ? s.models[providerId] : undefined))
  const loadModels = useStore((s) => s.loadModels)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [hi, setHi] = useState(0)
  const anchor = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (providerId) void loadModels(providerId)
  }, [providerId, loadModels])

  const models = useMemo(() => entry?.list ?? [], [entry])
  const filtered = useMemo(() => {
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean)
    const res = tokens.length ? models.filter((m) => matches(m, tokens)) : models
    return res.slice(0, MAX_ROWS)
  }, [models, query])
  const selected = models.find((m) => m.id === value)
  const freeText = query.trim()
  const showFree = freeText.length > 0 && !models.some((m) => m.id === freeText)
  const rows = showFree ? filtered.length + 1 : filtered.length

  useEffect(() => {
    if (!open) return
    list.current
      ?.querySelector<HTMLElement>(`[data-row="${hi}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [hi, open])

  const openList = (): void => {
    setQuery('')
    const idx = models.findIndex((m) => m.id === value)
    setHi(Math.max(0, idx))
    setOpen(true)
    requestAnimationFrame(() => input.current?.focus())
  }
  const commit = (id: string): void => {
    onChange(id)
    setOpen(false)
    setQuery('')
  }

  return (
    <>
      <div
        ref={anchor}
        role="combobox"
        aria-expanded={open}
        tabIndex={0}
        autoFocus={autoFocus}
        onClick={() => (open ? setOpen(false) : openList())}
        onKeyDown={(e) => {
          if (!open && (e.key === 'Enter' || e.key === 'ArrowDown' || e.key === ' ')) {
            e.preventDefault()
            openList()
          }
        }}
        className={cn(
          'field no-drag flex cursor-default items-center gap-2',
          open && 'border-border-strong',
          className
        )}
      >
        <span className="min-w-0 flex-1 truncate">
          {value ? (
            <>
              <span className="text-fg">{selected?.name ?? value}</span>
              {selected?.name && selected.name !== value && (
                <span className="ml-2 font-mono text-[11px] text-subtle">{value}</span>
              )}
            </>
          ) : (
            <span className="text-subtle">Escolha um modelo…</span>
          )}
        </span>
        {entry?.status === 'loading' ? (
          <Spinner />
        ) : (
          <ChevronDown
            className={cn(
              'size-3.5 shrink-0 text-subtle transition-transform',
              open && 'rotate-180'
            )}
          />
        )}
      </div>
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchor={anchor}
        maxHeight={420}
        className="min-w-[320px]"
      >
        <div className="flex items-center gap-2 border-b border-border px-3">
          <Search className="size-3.5 shrink-0 text-subtle" />
          <input
            ref={input}
            value={query}
            placeholder="Buscar ou digitar o ID do modelo…"
            onChange={(e) => {
              setQuery(e.target.value)
              setHi(0)
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setHi((h) => Math.min(rows - 1, h + 1))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setHi((h) => Math.max(0, h - 1))
              } else if (e.key === 'Enter') {
                e.preventDefault()
                if (hi < filtered.length) commit(filtered[hi].id)
                else if (showFree) commit(freeText)
              }
            }}
            className="h-10 min-w-0 flex-1 bg-transparent text-[13px] outline-none"
          />
          {providerId && (
            <button
              type="button"
              title="Recarregar lista"
              onClick={() => void loadModels(providerId, true)}
              className="rounded p-1 text-subtle hover:bg-hover hover:text-fg"
            >
              <RefreshCw
                className={cn('size-3.5', entry?.status === 'loading' && 'animate-spin')}
              />
            </button>
          )}
        </div>
        <div ref={list} className="min-h-0 flex-1 overflow-y-auto p-1">
          {entry?.status === 'error' && (
            <div className="px-2.5 py-2 text-xs text-warning/90">
              Não foi possível listar os modelos ({entry.error}). Digite o ID manualmente.
            </div>
          )}
          {entry?.status === 'loading' && models.length === 0 && (
            <div className="flex items-center gap-2 px-2.5 py-2 text-xs text-subtle">
              <Spinner /> Carregando modelos…
            </div>
          )}
          {filtered.map((m, i) => {
            const meta = modelMeta(m)
            return (
              <button
                key={m.id}
                type="button"
                data-row={i}
                onMouseMove={() => setHi(i)}
                onClick={() => commit(m.id)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left',
                  i === hi ? 'bg-hover' : ''
                )}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] text-fg">{m.name ?? m.id}</span>
                  <span className="block truncate font-mono text-[10.5px] text-subtle">{m.id}</span>
                </span>
                {meta.length > 0 && (
                  <span className="shrink-0 text-right text-[10.5px] leading-tight text-subtle tabular-nums">
                    {meta.map((t) => (
                      <span key={t} className="block">
                        {t}
                      </span>
                    ))}
                  </span>
                )}
                {m.id === value && <Check className="size-3.5 shrink-0 text-accent-strong" />}
              </button>
            )
          })}
          {showFree && (
            <button
              type="button"
              data-row={filtered.length}
              onMouseMove={() => setHi(filtered.length)}
              onClick={() => commit(freeText)}
              className={cn(
                'flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px]',
                hi === filtered.length ? 'bg-hover' : ''
              )}
            >
              <CornerDownLeft className="size-3.5 text-subtle" />
              <span className="text-muted">Usar</span>
              <span className="truncate font-mono text-xs text-fg">{freeText}</span>
            </button>
          )}
          {!showFree && filtered.length === 0 && entry?.status === 'ok' && (
            <div className="px-2.5 py-2 text-xs text-subtle">Nenhum modelo encontrado.</div>
          )}
          {!providerId && (
            <div className="px-2.5 py-2 text-xs text-subtle">Escolha um provedor primeiro.</div>
          )}
        </div>
      </Popover>
    </>
  )
}
