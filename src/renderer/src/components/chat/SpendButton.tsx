// Gasto do chat (botão ao lado do medidor de contexto no composer): total até agora segundo os
// relatórios de uso do provedor, por origem (respostas, subagentes, Smart-Approve, coleta de
// contexto, título automático…). A soma é pura (lib/chatSpend.ts).
import { ChevronRight, Receipt } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Chat, Session } from '@shared/types'
import {
  computeChatSpend,
  formatIntPt,
  formatUsd,
  type ChatSpend,
  type SpendTotals,
  type VoiceSpend
} from '../../lib/chatSpend'
import { formatCallDuration } from '@shared/voiceCallMarks'
import { cn } from '../../lib/format'
import { useStore } from '../../store'
import { Popover } from '../ui/layers'
import { Tip } from '../ui/Tooltip'
import { barAttrs, useBarLevel } from '../../lib/useBarCollapse'

const plural = (n: number, one: string, many: string): string =>
  `${formatIntPt(n)} ${n === 1 ? one : many}`

/** "$0,42", "$0,42 + ?" (parte sem custo informado) ou "custo desconhecido". */
function costText(t: { cost: number; calls: number; costed: number }): string {
  if (!t.calls) return formatUsd(0)
  if (!t.costed) return 'custo desconhecido'
  return t.costed < t.calls ? `${formatUsd(t.cost)} + ?` : formatUsd(t.cost)
}

function Row({
  label,
  value,
  sub,
  testId
}: {
  label: string
  value: string
  sub?: boolean
  testId?: string
}): React.JSX.Element {
  return (
    <div
      data-testid={testId}
      className={cn(
        'flex items-baseline gap-2 text-[12px] leading-5',
        sub ? 'pl-3 text-subtle' : 'text-muted'
      )}
    >
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="shrink-0 tabular-nums">{value}</span>
    </div>
  )
}

/** Linhas de tokens de uma origem (entrada sem cache, cache lido/gravado, saída, raciocínio). */
function TokenRows({ t, id }: { t: SpendTotals; id: string }): React.JSX.Element {
  const tok = (v: number): string => `${formatIntPt(v)} tokens`
  return (
    <div className="mt-0.5">
      <Row sub testId={`spend-${id}-input`} label="Entrada (sem cache)" value={tok(t.input)} />
      {t.cacheRead > 0 && (
        <Row
          sub
          testId={`spend-${id}-cache-read`}
          label="Entrada do cache"
          value={tok(t.cacheRead)}
        />
      )}
      {t.cacheWrite > 0 && (
        <Row
          sub
          testId={`spend-${id}-cache-write`}
          label="Escrita de cache"
          value={tok(t.cacheWrite)}
        />
      )}
      <Row sub testId={`spend-${id}-output`} label="Saída" value={tok(t.output)} />
      {t.reasoning > 0 && (
        <Row
          sub
          testId={`spend-${id}-reasoning`}
          label="dos quais raciocínio"
          value={tok(t.reasoning)}
        />
      )}
    </div>
  )
}

function Section({
  id,
  title,
  t,
  detail,
  children
}: {
  id: string
  title: string
  t: SpendTotals
  /** Texto curto depois do título (nº de chamadas…). */
  detail?: string
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      data-testid={`spend-${id}`}
      className="border-t border-border/50 px-3 py-2 first:border-t-0"
    >
      <div className="flex items-baseline gap-2">
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-fg/90">
          {title}
          <span className="font-normal text-faint">
            {' · '}
            {detail ?? plural(t.calls, 'chamada', 'chamadas')}
          </span>
        </span>
        <span
          data-testid={`spend-${id}-cost`}
          className={cn(
            'shrink-0 text-[12.5px] tabular-nums',
            t.costed ? 'text-fg/90' : 'text-subtle'
          )}
        >
          {costText(t)}
        </span>
      </div>
      {children}
    </div>
  )
}

/**
 * "Chamadas de voz": as respostas dos turnos da chamada (fora de "Respostas" — nunca em dobro),
 * transcrição/voz dos marcadores de fim e os tempos. A voz pelo preço de lista (≈) fica fora do total.
 */
function VoiceSection({ v }: { v: VoiceSpend }): React.JSX.Element {
  const usd = formatUsd
  const stt =
    v.stt.apiRequests === 0
      ? v.stt.localCalls
        ? 'local (grátis)'
        : '—'
      : v.stt.costedRequests
        ? `${usd(v.stt.cost)}${v.stt.costedRequests < v.stt.apiRequests ? ' + ?' : ''}`
        : 'custo não informado'
  const tts: string[] = []
  if (v.tts.cost > 0) tts.push(usd(v.tts.cost))
  if (v.tts.estimated > 0) tts.push(`≈ ${usd(v.tts.estimated)}`)
  if (v.tts.elevenChars > 0) tts.push(`${formatIntPt(v.tts.elevenChars)} caracteres ElevenLabs`)
  if (v.tts.unknownCalls > 0) tts.push('custo não informado')
  if (!tts.length) tts.push(v.tts.localCalls ? 'local (grátis)' : '—')
  return (
    <Section
      id="voice"
      title="Chamadas de voz"
      t={{ ...v.llm, cost: v.cost }}
      detail={`${plural(v.calls, 'chamada', 'chamadas')} · ${formatCallDuration(v.durationMs)}${v.open ? ` · ${v.open} em andamento` : ''}`}
    >
      <div className="mt-0.5">
        <Row
          sub
          testId="spend-voice-llm"
          label={`Modelo (${plural(v.llm.calls, 'resposta', 'respostas')})`}
          value={costText(v.llm)}
        />
        <Row sub testId="spend-voice-stt" label="Transcrição" value={stt} />
        <Row
          sub
          testId="spend-voice-tts"
          label={`Voz${v.tts.chars ? ` · ${formatIntPt(v.tts.chars)} caracteres` : ''}`}
          value={tts.join(' · ')}
        />
        <Row
          sub
          testId="spend-voice-time"
          label="Fala: você · voz"
          value={`${formatCallDuration(v.userSpeechMs)} · ${formatCallDuration(v.ttsAudioMs)}`}
        />
        {v.tts.estimated > 0 && (
          <p className="mt-0.5 pl-3 text-[11px] text-faint">
            ≈ = estimativa pelo preço de lista da voz (fora do total).
          </p>
        )}
      </div>
    </Section>
  )
}

function SpendPopoverBody({ spend }: { spend: ChatSpend }): React.JSX.Element {
  const [subsOpen, setSubsOpen] = useState(false)
  const { total } = spend
  const extra: [string, string, SpendTotals][] = [
    ['judge', 'Smart-Approve (juiz)', spend.judge],
    ['capture', 'Coleta de contexto', spend.capture],
    ['title', 'Título automático', spend.title],
    ['compaction', 'Compactação', spend.compaction],
    ['memory', 'Extração de memória', spend.memory]
  ]
  return (
    <div
      data-testid="spend-popover"
      className="flex min-h-0 flex-col"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex shrink-0 items-baseline gap-2 px-3 pt-2.5 pb-1.5">
        <span className="flex-1 text-[11px] font-semibold tracking-[0.06em] text-subtle uppercase">
          Gasto deste chat
        </span>
        <span data-testid="spend-total" className="text-[14px] font-semibold tabular-nums">
          {costText({ cost: total.cost, calls: total.calls, costed: total.calls - total.unknown })}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto border-y border-border/50">
        <Section id="main" title="Respostas" t={spend.main}>
          {spend.main.calls > 0 && <TokenRows t={spend.main} id="main" />}
          {spend.voice.llm.calls > 0 && (
            <p data-testid="spend-main-voice-note" className="mt-0.5 pl-3 text-[11px] text-faint">
              sem os turnos das chamadas de voz (em “Chamadas de voz”)
            </p>
          )}
        </Section>
        {spend.voice.calls > 0 && <VoiceSection v={spend.voice} />}
        {(spend.perSubagent.length > 0 || spend.missingSessions > 0) && (
          <Section
            id="subagents"
            title="Subagentes"
            t={spend.subagents}
            detail={`${plural(spend.perSubagent.length, 'sessão', 'sessões')} · ${plural(spend.subagents.calls, 'chamada', 'chamadas')}`}
          >
            {spend.subagents.calls > 0 && <TokenRows t={spend.subagents} id="subagents" />}
            {spend.perSubagent.length > 0 && (
              <button
                type="button"
                aria-expanded={subsOpen}
                onClick={() => setSubsOpen((o) => !o)}
                className="mt-1 -ml-1 flex items-center gap-1 rounded-md px-1 py-0.5 text-[11.5px] text-accent-strong hover:bg-accent-soft"
              >
                <ChevronRight
                  className={cn('size-3 transition-transform', subsOpen && 'rotate-90')}
                />
                Por subagente
              </button>
            )}
            {subsOpen && (
              <div data-testid="spend-per-subagent" className="mt-0.5">
                {spend.perSubagent.map((s) => (
                  <Row
                    key={s.sessionId}
                    sub
                    label={`${'· '.repeat(Math.max(0, s.depth - 1))}${s.label} · ${s.model.split('/').pop()}`}
                    value={costText(s.totals)}
                  />
                ))}
              </div>
            )}
            {spend.missingSessions > 0 && (
              <p className="mt-1 text-[11px] text-faint">Carregando subagentes…</p>
            )}
          </Section>
        )}
        {extra
          .filter(
            ([id, , t]) => t.calls > 0 || id === 'judge' || id === 'capture' || id === 'title'
          )
          .map(([id, title, t]) => (
            <Section key={id} id={id} title={title} t={t}>
              {t.calls > 0 && t.tokensKnown && (
                <Row
                  sub
                  label="Entrada · saída"
                  value={`${formatIntPt(t.input + t.cacheRead + t.cacheWrite)} · ${formatIntPt(t.output)} tokens`}
                />
              )}
            </Section>
          ))}
      </div>
      <div className="shrink-0 px-3 pt-1.5 pb-2.5 text-[11px] leading-snug text-faint">
        {total.unknown > 0 && (
          <p data-testid="spend-unknown" className="mb-1 text-warning/85">
            {plural(total.unknown, 'chamada', 'chamadas')} sem custo informado pelo provedor (fora
            do total).
          </p>
        )}
        <p>
          Valores dos relatórios de uso (<code className="font-mono">usage</code>) que o provedor
          devolve em cada chamada; o custo vem por chamada, sem divisão por tipo de token.
        </p>
      </div>
    </div>
  )
}

const EMPTY_SESSIONS: Session[] = []

/** Botão "$0,42" (recolhe para só o ícone) + popover com o gasto do chat. */
export function SpendButton({ chat }: { chat: Chat }): React.JSX.Element | null {
  const level = useBarLevel('spend')
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)
  const allSessions = useStore((s) => s.sessions)
  const messages = useStore((s) => s.messages)
  const loadMessages = useStore((s) => s.loadMessages)
  const sessions = useMemo(() => {
    const list = Object.values(allSessions).filter((s) => s.chatId === chat.id)
    return list.length ? list : EMPTY_SESSIONS
  }, [allSessions, chat.id])
  const spend = useMemo(
    () => computeChatSpend(chat, sessions, messages),
    [chat, sessions, messages]
  )
  // subsessões ainda não abertas: carrega as mensagens em segundo plano (o total inclui os
  // subagentes; dali em diante elas acompanham os eventos ao vivo)
  const missing = sessions
    .filter((s) => s.id !== chat.mainSessionId && !messages[s.id])
    .map((s) => s.id)
    .join(',')
  useEffect(() => {
    if (!missing) return
    const t = setTimeout(
      () => {
        for (const id of missing.split(',')) void loadMessages(id)
      },
      open ? 0 : 800
    )
    return () => clearTimeout(t)
  }, [missing, open, loadMessages])

  const { total } = spend
  if (!total.calls) return null
  const label = costText({
    cost: total.cost,
    calls: total.calls,
    costed: total.calls - total.unknown
  })
  const short = total.calls - total.unknown > 0 ? formatUsd(total.cost) : '$?'
  return (
    <>
      <Tip
        side="top"
        label={
          <span>
            Gasto deste chat: <span className="tabular-nums">{label}</span>
            <span className="block text-[11px] text-subtle">
              Segundo o provedor · clique para detalhar
            </span>
          </span>
        }
      >
        <button
          ref={anchor}
          type="button"
          data-testid="spend-button"
          {...barAttrs('spend', level)}
          aria-label={`Gasto deste chat: ${label}`}
          aria-expanded={open}
          onClick={(e) => {
            e.stopPropagation()
            setOpen((o) => !o)
          }}
          className={cn(
            'no-drag flex h-7 shrink-0 items-center gap-1 rounded-lg text-[11px] whitespace-nowrap tabular-nums text-subtle transition-colors hover:bg-hover hover:text-fg',
            level === 0 ? 'px-1.5' : 'w-7 justify-center',
            open && 'bg-hover text-fg'
          )}
        >
          <Receipt className="size-3.5 shrink-0" />
          {level === 0 && <span data-testid="spend-button-total">{short}</span>}
        </button>
      </Tip>
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchor={anchor}
        width={340}
        align="end"
        maxHeight={560}
      >
        <SpendPopoverBody spend={spend} />
      </Popover>
    </>
  )
}
