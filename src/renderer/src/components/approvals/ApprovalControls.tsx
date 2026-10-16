// Peças da UI de aprovações: seletor de modo (3 vias), aviso do Smart-Approve sem juiz e o
// campo editável "+ whitelist/blacklist" (com validação e aviso de padrão amplo).
import { AlertTriangle } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import {
  APPROVAL_MODES,
  broadPatternWarning,
  modeLabel,
  validateListEntry
} from '@shared/approvalPolicy'
import type { ApprovalItem, ApprovalListItem, ApprovalMode } from '@shared/types'
import { cn } from '../../lib/format'
import { Button } from '../ui/controls'

/** Segmented de 3 vias (+ opção "Padrão global (X)" quando `inherit` é passado). */
export function ModeSelector({
  item,
  value,
  onChange,
  inherit,
  label,
  testId
}: {
  item: ApprovalItem
  /** null = segue o padrão global (só com `inherit`). */
  value: ApprovalMode | null
  onChange: (v: ApprovalMode | null) => void
  /** Modo global (mostra a opção "Padrão global (X)"). */
  inherit?: ApprovalMode
  label: string
  testId?: string
}): React.JSX.Element {
  const opts: { v: ApprovalMode | null; text: string; title: string }[] = [
    ...(inherit
      ? [
          {
            v: null,
            text: `Padrão (${modeLabel(item, inherit)})`,
            title: `Segue o padrão global (Configurações → Aprovações): ${modeLabel(item, inherit)}`
          }
        ]
      : []),
    ...APPROVAL_MODES.map((m) => ({
      v: m as ApprovalMode | null,
      text: modeLabel(item, m),
      title:
        m === 'always'
          ? 'Roda sem perguntar (nem a blacklist vale)'
          : m === 'smart'
            ? 'O modelo juiz do Smart-Approve decide (sem juiz → pergunta)'
            : item === 'search'
              ? 'Pergunta a você a cada busca'
              : 'Whitelist libera, blacklist bloqueia; o resto pergunta'
    }))
  ]
  return (
    <div
      role="radiogroup"
      aria-label={label}
      data-testid={testId}
      className="flex rounded-lg border border-border bg-bg/60 p-0.5"
    >
      {opts.map((o) => (
        <button
          key={o.v ?? 'inherit'}
          type="button"
          role="radio"
          aria-checked={value === o.v}
          title={o.title}
          onClick={() => onChange(o.v)}
          className={cn(
            'min-w-0 flex-1 truncate rounded-md px-1.5 py-1 text-[11.5px] transition-colors',
            value === o.v ? 'bg-active text-fg shadow-sm' : 'text-subtle hover:text-fg'
          )}
        >
          {o.text}
        </button>
      ))}
    </div>
  )
}

export function SmartMissingNote({
  where,
  onConfigure
}: {
  where?: string
  onConfigure?: () => void
}): React.JSX.Element {
  return (
    <p
      data-testid="smart-missing"
      className="flex items-start gap-1.5 text-[11.5px] leading-snug text-warning/90"
    >
      <AlertTriangle className="mt-px size-3.5 shrink-0" />
      <span>
        Configure o modelo do Smart-Approve{where ? ` ${where}` : ''}
        {onConfigure && (
          <>
            {' '}
            (
            <button type="button" onClick={onConfigure} className="underline hover:text-warning">
              abrir
            </button>
            )
          </>
        )}
        . Sem juiz ligado, essas chamadas pedem sua confirmação.
      </span>
    </p>
  )
}

/** Campo editável de uma entrada de lista (pré-preenchido), com validação e aviso suave. */
export function ListEntryEditor({
  item,
  list,
  initial,
  onConfirm,
  onCancel,
  confirmLabel
}: {
  item: ApprovalListItem
  list: 'allow' | 'deny'
  initial: string
  onConfirm: (entry: string) => void | Promise<void>
  onCancel: () => void
  confirmLabel?: string
}): React.JSX.Element {
  const [value, setValue] = useState(initial)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])
  const error = validateListEntry(item, value)
  const warn = list === 'allow' && item !== 'pages' ? broadPatternWarning(value) : null
  return (
    <div data-testid="list-entry-editor" className="mt-1.5 space-y-1">
      <form
        className="flex items-center gap-1.5"
        onSubmit={(e) => {
          e.preventDefault()
          if (!error) void onConfirm(value.trim())
        }}
      >
        <input
          ref={ref}
          value={value}
          aria-label={list === 'allow' ? 'Padrão da whitelist' : 'Padrão da blacklist'}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && onCancel()}
          className="field h-7 min-w-0 flex-1 px-2 py-0 font-mono text-[11.5px]"
        />
        <Button
          type="submit"
          size="sm"
          variant={list === 'allow' ? 'primary' : 'danger'}
          disabled={!!error}
        >
          {confirmLabel ?? (list === 'allow' ? 'Salvar e permitir' : 'Salvar e negar')}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancelar
        </Button>
      </form>
      {error ? (
        <p className="text-[11px] text-danger/90">{error}</p>
      ) : warn ? (
        <p data-testid="broad-warning" className="text-[11px] leading-snug text-warning/90">
          {warn}
        </p>
      ) : (
        <p className="text-[11px] leading-snug text-faint">
          {item === 'pages'
            ? 'Domínio (github.com), subdomínios (*.github.com) ou prefixo de URL (https://github.com/org/).'
            : '“*” sozinho = qualquer quantidade de palavras; “*” dentro de uma palavra = curinga; sem “*” = exato.'}
        </p>
      )}
    </div>
  )
}
