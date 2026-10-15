// Chip "N processos" no header do chat (processos em segundo plano de process_start) + popover
// com nome, comando, tempo, Parar e "Ver logs" (últimas linhas).
import { Activity, ChevronRight, CircleStop, ScrollText } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { ProcessInfo } from '@shared/types'
import type { ProcessLogsResult } from '@shared/ipc'
import { cn } from '../../lib/format'
import { api, errorMessage } from '../../lib/api'
import { selectProcesses, useStore } from '../../store'
import { Popover } from '../ui/layers'
import { Tip } from '../ui/Tooltip'
import { CopyButton } from './Markdown'
import { processState } from './processFormat'

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [active])
  return now
}

function ProcessRow({
  chatId,
  p,
  now
}: {
  chatId: string
  p: ProcessInfo
  now: number
}): React.JSX.Element {
  const stopProcess = useStore((s) => s.stopProcess)
  const [logs, setLogs] = useState<ProcessLogsResult | null>(null)
  const [open, setOpen] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [stopping, setStopping] = useState(false)
  const running = p.status === 'running'
  // logs abertos: recarrega a cada 1,5 s enquanto roda
  useEffect(() => {
    if (!open) return
    let alive = true
    const load = (): void => {
      api.processes
        .logs(chatId, p.id, 200)
        .then((r) => alive && (setLogs(r), setErr(null)))
        .catch((e) => alive && setErr(errorMessage(e)))
    }
    load()
    const t = running ? setInterval(load, 1500) : null
    return () => {
      alive = false
      if (t) clearInterval(t)
    }
  }, [open, chatId, p.id, running])
  const text = logs ? logs.lines.map((l) => `${l.n}\t${l.text}`).join('\n') : ''
  return (
    <div data-testid="process-item" className="border-b border-border/60 px-3 py-2 last:border-b-0">
      <div className="flex items-center gap-2">
        <span
          className={cn(
            'size-1.5 shrink-0 rounded-full',
            running
              ? 'animate-pulse-soft bg-success'
              : p.exitCode === 0
                ? 'bg-faint'
                : 'bg-danger/80'
          )}
        />
        <span className="font-mono text-[11px] text-faint">{p.id}</span>
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-fg/90">
          {p.name || p.command.split(/\s+/)[0]}
        </span>
        <span className="shrink-0 text-[11px] tabular-nums text-subtle">
          {processState(p, now)}
        </span>
      </div>
      <Tip label={`${p.command}\n(cwd: ${p.cwd})`}>
        <p className="mt-1 truncate pl-3.5 font-mono text-[11px] text-muted">$ {p.command}</p>
      </Tip>
      {p.lastLine && !open && (
        <p className="mt-0.5 truncate pl-3.5 font-mono text-[10.5px] text-faint">{p.lastLine}</p>
      )}
      <div className="mt-1.5 flex items-center gap-1 pl-2.5">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11.5px] text-muted hover:bg-hover hover:text-fg"
        >
          <ChevronRight className={cn('size-3 transition-transform', open && 'rotate-90')} />
          <ScrollText className="size-3" />
          Ver logs
          <span className="text-faint">· {p.lines.toLocaleString('pt-BR')} linhas</span>
        </button>
        {running && (
          <button
            type="button"
            disabled={stopping}
            onClick={() => {
              setStopping(true)
              void stopProcess(chatId, p.id).finally(() => setStopping(false))
            }}
            className="ml-auto flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11.5px] text-danger/85 hover:bg-danger/10 hover:text-danger disabled:opacity-50"
          >
            <CircleStop className="size-3" />
            {stopping ? 'Parando…' : 'Parar'}
          </button>
        )}
      </div>
      {open && (
        <div className="mt-1.5">
          <div className="mb-1 flex items-center gap-2 text-[10.5px] text-faint">
            <span className="min-w-0 flex-1 truncate font-mono" title={p.logFile}>
              {p.logFile || 'log só em memória'}
            </span>
            <CopyButton text={text} className="-my-1" />
          </div>
          <pre
            data-testid="process-logs"
            className="max-h-64 overflow-auto rounded-lg bg-bg/70 px-2.5 py-2 font-mono text-[10.5px] leading-relaxed whitespace-pre-wrap text-fg/85"
          >
            {err ? (
              <span className="text-danger">{err}</span>
            ) : logs ? (
              text || <span className="text-faint italic">(sem saída)</span>
            ) : (
              <span className="text-faint italic">carregando…</span>
            )}
          </pre>
        </div>
      )}
    </div>
  )
}

export function ProcessesBadge({ chatId }: { chatId: string }): React.JSX.Element | null {
  const list = useStore(selectProcesses(chatId))
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)
  const running = list.filter((p) => p.status === 'running')
  const now = useNow(open)
  if (!running.length && !open) return null
  const n = running.length
  return (
    <>
      <Tip side="bottom" label="Processos em segundo plano deste chat (process_start)">
        <button
          ref={anchor}
          type="button"
          data-testid="processes-badge"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="no-drag flex h-7 shrink-0 items-center gap-1.5 rounded-lg border border-success/25 bg-success/[0.06] px-2 text-xs text-success/90 transition-colors hover:bg-success/[0.12]"
        >
          <Activity className="size-3.5" />
          <span className="max-[1179px]:hidden">
            {n} processo{n === 1 ? '' : 's'}
          </span>
          <span className="min-[1180px]:hidden">{n}</span>
        </button>
      </Tip>
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchor={anchor}
        width={420}
        align="end"
        maxHeight={520}
      >
        <div data-testid="processes-popover" className="flex flex-col py-1">
          <div className="px-3 pt-1 pb-1.5 text-[11px] font-semibold tracking-[0.06em] text-subtle uppercase">
            Processos em segundo plano
          </div>
          {list.length === 0 ? (
            <p className="px-3 pb-2 text-[12px] text-subtle">Nenhum processo.</p>
          ) : (
            [...list]
              .reverse()
              .map((p) => <ProcessRow key={p.id} chatId={chatId} p={p} now={now} />)
          )}
          <p className="px-3 pt-1.5 text-[11px] leading-snug text-faint">
            Continuam rodando entre turnos; são encerrados ao fechar o ClearChat ou apagar o chat.
          </p>
        </div>
      </Popover>
    </>
  )
}
