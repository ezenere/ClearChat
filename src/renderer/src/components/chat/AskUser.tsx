// Questionário (tool ask_user): formulário passo a passo no lugar do composer e partes do card no
// histórico. Imagens sempre via <img> do store (clearchat-attachment://) — SVG nunca executa script.
// Ver SPEC.md → "Questionário (ask_user)".
import { Check, ChevronLeft, ChevronRight, CircleHelp, PenLine, Send, X } from 'lucide-react'
import { DynamicIcon, iconNames, type IconName } from 'lucide-react/dynamic'
import { useEffect, useRef, useState } from 'react'
import type {
  AskUserHelp,
  AskUserIcon,
  AskUserOption,
  AskUserQuestion,
  QuestionAnswer,
  QuestionRequest
} from '@shared/types'
import { cn } from '../../lib/format'
import { useStore } from '../../store'
import { Popover } from '../ui/layers'
import { Button, Kbd } from '../ui/controls'

const LUCIDE_NAMES = new Set<string>(iconNames)

/** Ícone de uma opção (lucide carregado sob demanda, emoji ou imagem pequena). Nome desconhecido → nada. */
export function OptionIcon({
  icon,
  className
}: {
  icon: AskUserIcon | undefined
  className?: string
}): React.JSX.Element | null {
  const [broken, setBroken] = useState(false)
  if (!icon) return null
  if (icon.kind === 'lucide') {
    if (!LUCIDE_NAMES.has(icon.name)) return null
    return (
      <span className={cn('flex size-5 shrink-0 items-center justify-center', className)}>
        <DynamicIcon name={icon.name as IconName} className="size-[18px]" strokeWidth={1.75} />
      </span>
    )
  }
  if (icon.kind === 'text')
    return (
      <span
        className={cn(
          'flex size-5 shrink-0 items-center justify-center text-[16px] leading-none',
          className
        )}
      >
        {icon.text}
      </span>
    )
  if (broken) return null
  return (
    <img
      src={icon.url}
      alt=""
      draggable={false}
      onError={() => setBroken(true)}
      className={cn('size-5 shrink-0 rounded-[4px] object-contain', className)}
    />
  )
}

/** Conteúdo do popover de ajuda: texto monoespaçado (preserva espaços) ou imagem. */
function HelpContent({ help }: { help: AskUserHelp }): React.JSX.Element {
  if (help.kind === 'image')
    return (
      <img src={help.url} alt="Ajuda" className="max-h-[60vh] w-full rounded-lg object-contain" />
    )
  return (
    <pre className="max-h-[60vh] overflow-auto font-mono text-[12px] leading-[1.45] whitespace-pre text-fg/90">
      {help.text}
    </pre>
  )
}

function HelpButton({ help }: { help: AskUserHelp }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLButtonElement>(null)
  return (
    <>
      <button
        ref={ref}
        type="button"
        aria-label="Ajuda sobre esta opção"
        aria-expanded={open}
        tabIndex={-1}
        onClick={(e) => {
          e.stopPropagation()
          setOpen((o) => !o)
        }}
        className="flex size-6 shrink-0 items-center justify-center rounded-md text-subtle transition-colors hover:bg-hover hover:text-fg"
      >
        <CircleHelp className="size-3.5" />
      </button>
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchor={ref}
        width={help.kind === 'image' ? 520 : 560}
        align="end"
        maxHeight={520}
        className="p-3"
      >
        <div data-testid="ask-help" onClick={(e) => e.stopPropagation()}>
          <HelpContent help={help} />
        </div>
      </Popover>
    </>
  )
}

/** Imagem grande ao passar o mouse sobre a opção (acima do formulário). */
function HoverImage({ url, anchor }: { url: string; anchor: HTMLElement }): React.JSX.Element {
  const r = anchor.getBoundingClientRect()
  const w = Math.min(420, window.innerWidth - 24)
  const left = Math.max(12, Math.min(r.left, window.innerWidth - w - 12))
  return (
    <div
      data-testid="ask-hover-image"
      className="pointer-events-none fixed z-50 animate-fade-in rounded-xl border border-border-strong bg-elevated p-2 shadow-popover"
      style={{ left, bottom: window.innerHeight - r.top + 8, width: w }}
    >
      <img src={url} alt="" className="max-h-[50vh] w-full rounded-lg object-contain" />
    </div>
  )
}

function OptionRow({
  option,
  index,
  checked,
  multiple,
  onToggle
}: {
  option: AskUserOption
  index: number
  checked: boolean
  multiple: boolean
  onToggle: () => void
}): React.JSX.Element {
  const [hover, setHover] = useState<HTMLElement | null>(null)
  return (
    <div
      role={multiple ? 'checkbox' : 'radio'}
      aria-checked={checked}
      tabIndex={-1}
      data-testid="ask-option"
      onClick={(e) => {
        // cliques dentro do popover de ajuda (portal) não marcam a opção
        if (e.currentTarget.contains(e.target as Node)) onToggle()
      }}
      onMouseEnter={(e) => option.image && setHover(e.currentTarget)}
      onMouseLeave={() => setHover(null)}
      className={cn(
        'group flex cursor-pointer items-start gap-2.5 rounded-xl border px-3 py-2 transition-colors select-none',
        checked
          ? 'border-accent/55 bg-accent-soft/50'
          : 'border-border bg-bg/30 hover:border-border-strong hover:bg-hover/60'
      )}
    >
      <span
        className={cn(
          'mt-0.5 flex size-4 shrink-0 items-center justify-center border transition-colors',
          multiple ? 'rounded-[5px]' : 'rounded-full',
          checked ? 'border-accent bg-accent text-white' : 'border-border-strong'
        )}
      >
        {checked &&
          (multiple ? (
            <Check className="size-3" strokeWidth={3} />
          ) : (
            <span className="size-1.5 rounded-full bg-white" />
          ))}
      </span>
      {option.icon && <OptionIcon icon={option.icon} className="text-accent-strong" />}
      <div className="min-w-0 flex-1">
        <div className="text-[13.5px] leading-5 text-fg">{option.title}</div>
        {option.description && (
          <div className="mt-0.5 text-[12px] leading-snug text-subtle">{option.description}</div>
        )}
      </div>
      {option.help && <HelpButton help={option.help} />}
      <Kbd>{index + 1}</Kbd>
      {hover && option.image && <HoverImage url={option.image} anchor={hover} />}
    </div>
  )
}

interface Draft {
  selected: number[]
  otherOn: boolean
  other: string
}

const answered = (d: Draft): boolean => d.selected.length > 0 || (d.otherOn && !!d.other.trim())

/** Formulário passo a passo — substitui o campo de texto do composer enquanto está pendente. */
export function QuestionForm({ request }: { request: QuestionRequest }): React.JSX.Element {
  const answerQuestion = useStore((s) => s.answerQuestion)
  const cancelQuestion = useStore((s) => s.cancelQuestion)
  const qs = request.questions
  const [step, setStep] = useState(0)
  const [drafts, setDrafts] = useState<Draft[]>(() =>
    qs.map(() => ({ selected: [], otherOn: false, other: '' }))
  )
  const [sending, setSending] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const otherRef = useRef<HTMLTextAreaElement>(null)
  const q: AskUserQuestion = qs[step]
  const d = drafts[step]
  const last = step === qs.length - 1
  const canNext = answered(d)

  // foco no formulário (teclas 1–6 / Enter / Esc) ao abrir e a cada passo
  useEffect(() => {
    rootRef.current?.focus()
  }, [request.id, step])

  const patch = (fn: (d: Draft) => Draft): void =>
    setDrafts((all) => all.map((x, i) => (i === step ? fn(x) : x)))

  const toggle = (i: number): void =>
    patch((x) =>
      q.multiple
        ? {
            ...x,
            selected: x.selected.includes(i)
              ? x.selected.filter((n) => n !== i)
              : [...x.selected, i].sort((a, b) => a - b)
          }
        : { ...x, selected: [i], otherOn: false }
    )

  const toggleOther = (): void => {
    const on = q.multiple ? !d.otherOn : true
    patch((x) => (q.multiple ? { ...x, otherOn: on } : { ...x, selected: [], otherOn: true }))
    if (on) setTimeout(() => otherRef.current?.focus())
  }

  const submit = async (): Promise<void> => {
    if (sending || !drafts.every(answered)) return
    const answers: QuestionAnswer[] = drafts.map((x) => {
      const other = x.otherOn ? x.other.trim() : ''
      return other ? { selected: x.selected, other } : { selected: x.selected }
    })
    setSending(true)
    const ok = await answerQuestion(request.id, answers)
    if (!ok) setSending(false)
  }

  const next = (): void => {
    if (!canNext) return
    if (last) void submit()
    else setStep((s) => s + 1)
  }
  const back = (): void => {
    if (step > 0) setStep((s) => s - 1)
  }
  const cancel = (): void => {
    void cancelQuestion(request.id)
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.nativeEvent.isComposing) return
    const inText = e.target instanceof HTMLTextAreaElement
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      cancel()
      return
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      next()
      return
    }
    if (inText) return
    if (/^[1-9]$/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const n = Number(e.key) - 1
      if (n < q.options.length) {
        e.preventDefault()
        toggle(n)
      } else if (n === q.options.length) {
        e.preventDefault()
        toggleOther()
      }
    } else if (e.key === 'ArrowLeft' && step > 0) {
      e.preventDefault()
      back()
    } else if (e.key === 'ArrowRight' && canNext && !last) {
      e.preventDefault()
      next()
    }
  }

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      data-testid="question-form"
      role="group"
      aria-label={`Questionário: pergunta ${step + 1} de ${qs.length}`}
      onKeyDown={onKeyDown}
      onClick={(e) => e.stopPropagation()}
      className="px-4 pt-3.5 pb-1 outline-none"
    >
      <div className="mb-2 flex items-center gap-2 text-[11px] text-subtle">
        <span className="font-medium text-accent-strong">Pergunta do agente</span>
        {qs.length > 1 && (
          <span data-testid="ask-step" className="tabular-nums">
            {step + 1}/{qs.length}
          </span>
        )}
        <span>{q.multiple ? '· marque uma ou mais' : '· escolha uma'}</span>
        <button
          type="button"
          onClick={cancel}
          className="ml-auto flex items-center gap-1 rounded-md px-1.5 py-0.5 text-subtle transition-colors hover:bg-hover hover:text-fg"
          aria-label="Cancelar questionário"
        >
          <X className="size-3" /> Cancelar <Kbd>Esc</Kbd>
        </button>
      </div>
      <h3
        id={`ask-q-${request.id}-${step}`}
        className="text-[14.5px] leading-snug font-medium text-fg"
      >
        {q.title}
      </h3>
      {q.description && (
        <p className="mt-1 text-[12.5px] leading-relaxed whitespace-pre-wrap text-muted">
          {q.description}
        </p>
      )}
      <div
        role={q.multiple ? 'group' : 'radiogroup'}
        aria-labelledby={`ask-q-${request.id}-${step}`}
        className="mt-2.5 flex max-h-[46vh] flex-col gap-1.5 overflow-y-auto pr-0.5"
      >
        {q.options.map((o, i) => (
          <OptionRow
            key={`${step}-${i}`}
            option={o}
            index={i}
            multiple={q.multiple}
            checked={d.selected.includes(i)}
            onToggle={() => toggle(i)}
          />
        ))}
        <div
          role={q.multiple ? 'checkbox' : 'radio'}
          aria-checked={d.otherOn}
          tabIndex={-1}
          data-testid="ask-other"
          onClick={() => {
            if (!d.otherOn || q.multiple) toggleOther()
          }}
          className={cn(
            'flex cursor-pointer flex-col rounded-xl border px-3 py-2 transition-colors select-none',
            d.otherOn
              ? 'border-accent/55 bg-accent-soft/50'
              : 'border-border bg-bg/30 hover:border-border-strong hover:bg-hover/60'
          )}
        >
          <div className="flex items-center gap-2.5">
            <span
              className={cn(
                'flex size-4 shrink-0 items-center justify-center border transition-colors',
                q.multiple ? 'rounded-[5px]' : 'rounded-full',
                d.otherOn ? 'border-accent bg-accent text-white' : 'border-border-strong'
              )}
            >
              {d.otherOn &&
                (q.multiple ? (
                  <Check className="size-3" strokeWidth={3} />
                ) : (
                  <span className="size-1.5 rounded-full bg-white" />
                ))}
            </span>
            <PenLine className="size-[18px] shrink-0 text-subtle" strokeWidth={1.75} />
            <span className="flex-1 text-[13.5px] text-fg">Outro</span>
            <Kbd>{q.options.length + 1}</Kbd>
          </div>
          {d.otherOn && (
            <textarea
              ref={otherRef}
              data-testid="ask-other-text"
              value={d.other}
              rows={2}
              aria-label="Sua resposta"
              placeholder="Escreva sua resposta (ou por que não quer responder)…"
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => {
                const v = e.target.value
                patch((x) => ({ ...x, other: v }))
              }}
              className="field mt-2 w-full resize-none px-2.5 py-1.5 text-[13px] leading-5"
            />
          )}
        </div>
      </div>
      {request.notes?.length ? (
        <p className="mt-1.5 text-[11px] text-faint">
          {request.notes.length === 1
            ? '1 imagem não pôde ser carregada.'
            : `${request.notes.length} imagens não puderam ser carregadas.`}
        </p>
      ) : null}
      <div className="mt-2.5 flex items-center gap-2">
        <span className="text-[11px] text-faint">
          <span className="text-subtle">1–{q.options.length + 1}</span> escolhe ·{' '}
          <span className="text-subtle">Enter</span> {last ? 'envia' : 'avança'}
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          {step > 0 && (
            <Button
              size="sm"
              variant="ghost"
              onClick={back}
              icon={<ChevronLeft className="size-3.5" />}
            >
              Voltar
            </Button>
          )}
          {last ? (
            <Button
              size="sm"
              variant="primary"
              data-testid="ask-submit"
              disabled={!drafts.every(answered)}
              loading={sending}
              onClick={() => void submit()}
              icon={<Send className="size-3.5" />}
            >
              Enviar respostas
            </Button>
          ) : (
            <Button
              size="sm"
              variant="primary"
              data-testid="ask-next"
              disabled={!canNext}
              onClick={next}
            >
              Próximo <ChevronRight className="size-3.5" />
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

/** Lista "pergunta → resposta(s)" do card respondido. */
export function AskUserAnswers({
  questions,
  answers
}: {
  questions: AskUserQuestion[]
  answers: QuestionAnswer[]
}): React.JSX.Element {
  return (
    <ol data-testid="ask-answers" className="space-y-2">
      {questions.map((q, i) => {
        const a = answers[i] ?? { selected: [] }
        return (
          <li key={i} className="text-[12.5px] leading-relaxed">
            <div className="text-muted">
              <span className="mr-1 tabular-nums text-faint">{i + 1}.</span>
              {q.title}
            </div>
            <div className="mt-1 flex flex-wrap gap-1.5 pl-4">
              {a.selected.map((n) => {
                const o = q.options[n]
                return (
                  <span
                    key={n}
                    className="inline-flex items-center gap-1.5 rounded-md border border-border bg-elevated px-2 py-0.5 text-fg/90"
                  >
                    {o?.icon && <OptionIcon icon={o.icon} className="size-4 [&_svg]:size-3.5" />}
                    {o?.title ?? `opção ${n + 1}`}
                  </span>
                )
              })}
              {a.other && (
                <span className="inline-flex items-start gap-1.5 rounded-md border border-border bg-elevated px-2 py-0.5 whitespace-pre-wrap text-fg/90">
                  <PenLine className="mt-1 size-3 shrink-0 text-subtle" />
                  <span>
                    <span className="text-subtle">Outro: </span>
                    {a.other}
                  </span>
                </span>
              )}
            </div>
          </li>
        )
      })}
    </ol>
  )
}

/** Perguntas sem resposta (card pendente / cancelado). */
export function AskUserQuestionsList({
  questions
}: {
  questions: { title: string }[]
}): React.JSX.Element {
  return (
    <ol className="space-y-0.5 text-[12.5px] leading-relaxed text-muted">
      {questions.map((q, i) => (
        <li key={i}>
          <span className="mr-1 tabular-nums text-faint">{i + 1}.</span>
          {q.title}
        </li>
      ))}
    </ol>
  )
}
