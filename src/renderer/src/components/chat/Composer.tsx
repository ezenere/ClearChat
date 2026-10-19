import { ArrowUp, Lightbulb, Paperclip, Square, TriangleAlert, X, Zap } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { modalityWarning } from '@shared/attachments'
import type { QueuedMessage, Session } from '@shared/types'
import { api } from '../../lib/api'
import { cn } from '../../lib/format'
import { splitInterChatText } from '@shared/interChat'
import {
  isBusy,
  selectPendingAttachments,
  selectPendingSkills,
  selectQueue,
  useStore
} from '../../store'
import { ComposerInfo, QueueInfo } from '../apiDocs'
import { Tip } from '../ui/Tooltip'
import { AutoTextarea } from '../ui/controls'
import { ComposerAttachmentChip } from './Attachments'
import { useAttachmentSupport } from './attachmentSupport'
import { CompactBanner, ContextMeter } from './ContextMeter'
import { QuestionForm } from './AskUser'
import { RetryForm } from './RetryCard'
import { PendingBar } from './PendingBar'
import { SkillChip, SkillPickerButton } from '../skills/SkillPicker'
import { skillsConfigOf } from '../../lib/skills'
import { HostComposerLine, HostOfflineCard, RemoteHint } from '../sync/ChatHost'
import { useHostInfo } from '../sync/hooks'

/** Nome para imagens coladas da área de transferência (o navegador entrega sempre "image.png"). */
function pastedName(file: File, i: number): File {
  if (file.name && file.name !== 'image.png') return file
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  const ext = (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg')
  const name = `colado-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${i ? `-${i + 1}` : ''}.${ext}`
  return new File([file], name, { type: file.type })
}

/** Origem de um item da fila que não foi digitado pelo usuário (outro chat, pai, subagente). */
function queueOrigin(item: QueuedMessage): { label: string; text: string } | null {
  const kind = item.meta?.kind
  if (kind === 'inter-chat')
    return {
      label: `De: ${item.meta?.fromChatTitle || 'outro chat'}`,
      text: splitInterChatText(item.text).body
    }
  if (kind === 'parent-message')
    return { label: 'Agente pai', text: item.text.replace(/^\[Mensagem do agente pai\]\n/, '') }
  if (kind === 'subagent-callback')
    return { label: 'Resultado de subagente', text: item.text.split('\n')[0] }
  return null
}

function QueueChip({ item }: { item: QueuedMessage }): React.JSX.Element {
  const run = useStore((s) => s.run)
  const origin = queueOrigin(item)
  return (
    <div className="group relative max-w-[280px] min-w-[140px] animate-pop-in rounded-xl border border-border bg-elevated/90 py-2 pr-12 pl-3 shadow-[0_4px_16px_-8px_rgb(0_0_0/0.6)]">
      {origin && (
        <p className="mb-0.5 truncate text-[10.5px] font-medium text-accent-strong/90">
          {origin.label}
        </p>
      )}
      <p className="line-clamp-2 text-[12.5px] leading-snug text-fg/85">
        {origin ? origin.text : item.text}
      </p>
      {item.skillParts?.length ? (
        <p className="mt-0.5 flex items-center gap-1 truncate text-[11px] text-subtle">
          <Lightbulb className="size-3 shrink-0" />
          {item.skillParts
            .flatMap((p) => (p.type === 'text' && p._skill ? [p._skill.name] : []))
            .join(', ')}
        </p>
      ) : null}
      {item.attachments?.length ? (
        <p className="mt-0.5 flex items-center gap-1 truncate text-[11px] text-subtle">
          <Paperclip className="size-3 shrink-0" />
          {item.attachments.map((a) => a.name).join(', ')}
        </p>
      ) : null}
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
  /** Questionário (ask_user) pendente nesta sessão: substitui o campo de texto. */
  const question = useStore((s) => s.questions.find((q) => q.sessionId === session.id))
  /** Falha de conexão aguardando decisão nesta sessão: card no lugar do campo de texto. */
  const retry = useStore((s) => s.retries.find((r) => r.sessionId === session.id))
  const blocked = !!question || !!retry
  const host = useHostInfo(session.chatId)
  const hostOffline = host?.mode === 'host-offline'
  const [text, setText] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)
  const pending = useStore(selectPendingAttachments(session.id))
  const addFiles = useStore((s) => s.addFiles)
  const pickFiles = useStore((s) => s.pickFiles)
  const removeAttachment = useStore((s) => s.removeAttachment)
  const clearAttachments = useStore((s) => s.clearAttachments)
  const pendingSkillsRaw = useStore(selectPendingSkills(session.id))
  const setPendingSkills = useStore((s) => s.setPendingSkills)
  // skills desligadas no chat → os chips somem (e nada é enviado)
  const skillsOn = !!chat && skillsConfigOf(chat.config).enabled
  const pendingSkills = skillsOn ? pendingSkillsRaw : []
  const { supportOf, tooltip: attachTip } = useAttachmentSupport(session)
  /** Pediu para enviar com anexo que o modelo (talvez) não aceita: destaca a confirmação (por conjunto de avisos). */
  const [confirmKey, setConfirmKey] = useState<string | null>(null)

  useEffect(() => {
    if (autoFocus) ref.current?.focus()
  }, [autoFocus, session.id])

  const ready = pending.filter((a) => a.status === 'ready' && a.info)
  const loading = pending.some((a) => a.status === 'loading')
  const warnings = useMemo(() => {
    const out = new Set<string>()
    for (const a of ready) {
      const w = modalityWarning(a.info!.kind, supportOf(a.info!))
      if (w) out.add(w)
    }
    return [...out]
  }, [ready, supportOf])
  const warnKey = warnings.join('|')
  const confirming = !!warnKey && confirmKey === warnKey
  const canSend = !loading && (!!text.trim() || ready.length > 0 || pendingSkills.length > 0)

  const submit = async (force = false): Promise<void> => {
    const t = text.trim()
    if (!canSend) return
    if (warnings.length && !force) {
      setConfirmKey(warnKey)
      return
    }
    const atts = ready.map((a) => a.info!)
    const skills = [...pendingSkills]
    setText('')
    setConfirmKey(null)
    if (atts.length) clearAttachments(session.id)
    if (skills.length) setPendingSkills(session.id, [])
    const ok = await send(session.id, t, atts, skills)
    if (!ok) {
      setText(t)
      if (skills.length) setPendingSkills(session.id, skills)
      if (atts.length) {
        // devolve os anexos ao composer
        useStore.setState((s) => ({
          pendingAttachments: {
            ...s.pendingAttachments,
            [session.id]: [
              ...atts.map((info, i) => ({
                id: `retry-${Date.now()}-${i}`,
                name: info.name,
                size: info.size,
                status: 'ready' as const,
                info
              })),
              ...(s.pendingAttachments[session.id] ?? [])
            ]
          }
        }))
      }
    }
  }

  return (
    <div className="relative px-8 pb-5">
      {/* 90% da coluna de conteúdo (a mesma da lista: até 1920px); fora dele, cliques/rolagem passam para a lista */}
      <div className="mx-auto w-full max-w-[1920px]">
        <div data-testid="composer-column" className="pointer-events-auto mx-auto w-[90%]">
          {chat && <CompactBanner chat={chat} session={session} />}
          {queue.length > 0 && (
            <div className="mb-2" data-stack-extra>
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
          {chat && <HostComposerLine chat={chat} sessionId={session.id} />}
          <PendingBar session={session} blocked={blocked} />
          {hostOffline && chat ? (
            <HostOfflineCard chat={chat} />
          ) : (
            <div
              className={cn(
                'group relative rounded-2xl border border-border bg-surface shadow-[0_8px_30px_-12px_rgb(0_0_0/0.7)] transition-[border-color,box-shadow] duration-150',
                'focus-within:border-border-strong focus-within:shadow-[0_8px_30px_-12px_rgb(0_0_0/0.7),0_0_0_3px_rgb(139_92_246/0.08)]'
              )}
              onClick={() => ref.current?.focus()}
            >
              {question && <QuestionForm key={question.id} request={question} />}
              {!question && retry && <RetryForm key={retry.id} request={retry} />}
              {!blocked && (pending.length > 0 || pendingSkills.length > 0) && (
                <div
                  className="flex flex-wrap gap-2 px-3 pt-3"
                  onClick={(e) => e.stopPropagation()}
                >
                  {pendingSkills.map((n) => (
                    <SkillChip
                      key={`skill:${n}`}
                      name={n}
                      onRemove={() =>
                        setPendingSkills(
                          session.id,
                          pendingSkills.filter((x) => x !== n)
                        )
                      }
                    />
                  ))}
                  {pending.map((a) => (
                    <ComposerAttachmentChip
                      key={a.id}
                      item={a}
                      support={a.info ? supportOf(a.info) : undefined}
                      onRemove={() => removeAttachment(session.id, a.id)}
                    />
                  ))}
                </div>
              )}
              {!blocked && warnings.length > 0 && (
                <div
                  role="alert"
                  onClick={(e) => e.stopPropagation()}
                  className={cn(
                    'mx-3 mt-2 flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-[12px] transition-colors',
                    confirming
                      ? 'border-warning/45 bg-warning/[0.1] text-warning'
                      : 'border-warning/20 bg-warning/[0.05] text-warning/85'
                  )}
                >
                  <TriangleAlert className="size-3.5 shrink-0" />
                  <span className="min-w-0 flex-1">
                    {warnings.join(' · ')}.{' '}
                    <span className="text-subtle">
                      {confirming
                        ? 'Confirme para enviar assim mesmo.'
                        : 'A request pode falhar ou o anexo ser ignorado.'}
                    </span>
                  </span>
                  <button
                    type="button"
                    onClick={() => void submit(true)}
                    disabled={!canSend}
                    className="shrink-0 rounded-md border border-warning/30 px-2 py-0.5 text-[11.5px] font-medium text-warning transition-colors hover:bg-warning/15 disabled:opacity-50"
                  >
                    Enviar mesmo assim
                  </button>
                </div>
              )}
              {!blocked && (
                <AutoTextarea
                  ref={ref}
                  value={text}
                  minRows={1}
                  maxRows={14}
                  placeholder={
                    busy
                      ? 'Enviar para a fila…'
                      : session.depth > 0
                        ? 'Mensagem ao subagente…'
                        : 'Mensagem…'
                  }
                  onChange={(e) => setText(e.target.value)}
                  onPaste={(e) => {
                    const files = [...e.clipboardData.files]
                    if (!files.length) return
                    e.preventDefault()
                    void addFiles(session.id, files.map(pastedName))
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault()
                      void submit()
                    }
                  }}
                  className="block w-full bg-transparent px-4 pt-3.5 pb-1 text-[14px] leading-6 outline-none"
                />
              )}
              <div className="flex items-center gap-2 px-2.5 pb-2.5">
                {!blocked && (
                  <Tip label={attachTip}>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        void pickFiles(session.id)
                      }}
                      className="flex size-7 items-center justify-center rounded-lg text-subtle transition-colors hover:bg-hover hover:text-fg"
                      aria-label="Anexar arquivos"
                    >
                      <Paperclip className="size-4" />
                    </button>
                  </Tip>
                )}
                {!blocked && chat && <SkillPickerButton chat={chat} sessionId={session.id} />}
                <span className="flex items-center gap-1.5 text-[11px] text-faint">
                  <ComposerInfo running={busy} />
                  {chat && <RemoteHint chat={chat} />}
                  {busy ? (
                    <span className="flex items-center gap-1.5 text-subtle">
                      <span className="size-1.5 animate-pulse-soft rounded-full bg-accent-strong" />
                      {question || session.status === 'awaiting_input'
                        ? 'Aguardando sua resposta'
                        : retry || session.status === 'awaiting_retry'
                          ? 'Aguardando sua decisão (falha de conexão)'
                          : session.status === 'awaiting_approval'
                            ? 'Aguardando aprovação'
                            : session.status === 'waiting'
                              ? 'Aguardando subagentes'
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
                  {!blocked && (
                    <Tip label={busy ? 'Adicionar à fila' : 'Enviar'} shortcut="Enter">
                      <button
                        type="button"
                        disabled={!canSend}
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
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
