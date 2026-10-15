import { ArrowUp, Square, X, Zap } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { QueuedMessage, Session } from '@shared/types'
import { api } from '../../lib/api'
import { cn } from '../../lib/format'
import { isBusy, selectQueue, useStore } from '../../store'
import { ComposerInfo, QueueInfo } from '../apiDocs'
import { Tip } from '../ui/Tooltip'
import { AutoTextarea } from '../ui/controls'
import { CompactBanner, ContextMeter } from './ContextMeter'

function QueueChip({ item }: { item: QueuedMessage }): React.JSX.Element {
  const run = useStore((s) => s.run)
  return (
    <div className="group relative max-w-[280px] min-w-[140px] animate-pop-in rounded-xl border border-border bg-elevated/90 py-2 pr-12 pl-3 shadow-[0_4px_16px_-8px_rgb(0_0_0/0.6)]">
      <p className="line-clamp-2 text-[12.5px] leading-snug text-fg/85">{item.text}</p>
      <div className="absolute top-1 right-1 flex items-center">
        <Tip label="Enviar agora (interrompe o agente)">
          <button
            type="button"
            onClick={() => void run(() => api.agent.forceSend(item.id), 'Falha ao forçar envio')}
            className="rounded-md p-1 text-warning/80 transition-colors hover:bg-warning/10 hover:text-warning"
            aria-label="Enviar agora"
          >
            <Zap className="size-3.5" fill="currentColor" fillOpacity={0.25} />
          </button>
        </Tip>
        <Tip label="Remover da fila">
          <button
            type="button"
            onClick={() => void run(() => api.agent.removeQueued(item.id), 'Falha ao remover')}
            className="rounded-md p-1 text-subtle transition-colors hover:bg-hover hover:text-fg"
            aria-label="Remover da fila"
          >
            <X className="size-3.5" />
          </button>
        </Tip>
      </div>
    </div>
  )
}

export function Composer({
  session,
  autoFocus
}: {
  session: Session
  autoFocus?: boolean
}): React.JSX.Element {
  const queue = useStore(selectQueue(session.id))
  const chat = useStore((s) => s.chats.find((c) => c.id === session.chatId))
  const compaction = useStore((s) => s.compactions[session.id])
  const send = useStore((s) => s.send)
  const run = useStore((s) => s.run)
  const busy = isBusy(session.status)
  const [text, setText] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (autoFocus) ref.current?.focus()
  }, [autoFocus, session.id])

  const submit = async (): Promise<void> => {
    const t = text.trim()
    if (!t) return
    setText('')
    const ok = await send(session.id, t)
    if (!ok) setText(t)
  }

  return (
    <div className="relative shrink-0 px-8 pb-5">
      <div className="pointer-events-none absolute inset-x-0 -top-6 h-6 bg-gradient-to-t from-bg to-transparent" />
      <div className="mx-auto w-full max-w-[780px]">
        {chat && <CompactBanner chat={chat} session={session} />}
        {queue.length > 0 && (
          <div className="mb-2">
            <div className="mb-1.5 flex items-center gap-1.5 pl-1 text-[11px] text-subtle">
              Na fila · enviadas no próximo passo do agente <QueueInfo />
            </div>
            <div className="flex flex-wrap gap-2">
              {queue.map((q) => (
                <QueueChip key={q.id} item={q} />
              ))}
            </div>
          </div>
        )}
        <div
          className={cn(
            'group relative rounded-2xl border border-border bg-surface shadow-[0_8px_30px_-12px_rgb(0_0_0/0.7)] transition-[border-color,box-shadow] duration-150',
            'focus-within:border-border-strong focus-within:shadow-[0_8px_30px_-12px_rgb(0_0_0/0.7),0_0_0_3px_rgb(139_92_246/0.08)]'
          )}
          onClick={() => ref.current?.focus()}
        >
          <AutoTextarea
            ref={ref}
            value={text}
            minRows={1}
            maxRows={14}
            placeholder={busy ? 'Enviar para a fila…' : 'Mensagem…'}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                void submit()
              }
            }}
            className="block w-full bg-transparent px-4 pt-3.5 pb-1 text-[14px] leading-6 outline-none"
          />
          <div className="flex items-center gap-2 px-2.5 pb-2.5">
            <span className="flex items-center gap-1.5 pl-1.5 text-[11px] text-faint">
              <ComposerInfo running={busy} />
              {busy ? (
                <span className="flex items-center gap-1.5 text-subtle">
                  <span className="size-1.5 animate-pulse-soft rounded-full bg-accent-strong" />
                  {session.status === 'awaiting_approval'
                    ? 'Aguardando aprovação'
                    : compaction?.state === 'running'
                      ? 'Compactando conversa…'
                      : 'Trabalhando…'}
                </span>
              ) : (
                <span>
                  <span className="text-subtle">Enter</span> envia ·{' '}
                  <span className="text-subtle">Shift+Enter</span> quebra linha
                </span>
              )}
            </span>
            <div className="ml-auto flex items-center gap-1.5">
              {chat && <ContextMeter chat={chat} session={session} className="mr-0.5" />}
              {busy && (
                <Tip label="Parar">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      void run(() => api.agent.stop(session.id), 'Falha ao parar')
                    }}
                    className="flex size-8 items-center justify-center rounded-xl border border-border-strong bg-elevated text-fg transition-colors hover:bg-hover"
                    aria-label="Parar"
                  >
                    <Square className="size-3" fill="currentColor" />
                  </button>
                </Tip>
              )}
              <Tip label={busy ? 'Adicionar à fila' : 'Enviar'} shortcut="Enter">
                <button
                  type="button"
                  disabled={!text.trim()}
                  onClick={(e) => {
                    e.stopPropagation()
                    void submit()
                  }}
                  className="flex size-8 items-center justify-center rounded-xl bg-accent text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.18)] transition-[background-color,opacity] hover:bg-[#9a70f8] disabled:bg-active disabled:text-faint disabled:shadow-none"
                  aria-label="Enviar"
                >
                  <ArrowUp className="size-4" strokeWidth={2.25} />
                </button>
              </Tip>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
