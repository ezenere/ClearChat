// Loop do agente por sessão: build → stream → persistir assistant → tools → [fila] → repetir.
// Ver SPEC.md → "Runner / fila / interrupção".
import { CONFIRM_TOOLS } from '@shared/types'
import type {
  ApiMessage,
  Chat,
  MessageMeta,
  QueuedMessage,
  Session,
  SessionStatus,
  StoredMessage,
  ToolCall,
  ToolName
} from '@shared/types'
import type { ApprovalDecision, CompactOptions, RequestPreview } from '@shared/ipc'
import type { ModelInfo } from '@shared/types'
import { DEFAULT_COMPACT_PROMPT } from '@shared/defaults'
import { clampToolOutput } from '@shared/limits'
import {
  compactThreshold,
  contextUsage,
  hasCompactableHistory,
  isContextLengthError,
  resolveContextWindow
} from '@shared/context'
import { emit } from '../events'
import { chatsRepo, messagesRepo, providersRepo, sessionsRepo } from '../repo'
import { parseToolArgs, runLocalTool, shellStateFor } from '../tools'
import { truncate, truncateHeadTail } from '../tools/util'
import { delegateEmptyText, delegateFailureText } from '../tools/models'
import { listModels } from '../providers'
import { accToDraft, finalizeToolCalls, newAccumulator, streamChat, throttle } from './llm'
import { availableTools, buildRequest, maskRequest } from './request'
import {
  buildCompactionRequest,
  cleanSummary,
  COMPACTION_MODES,
  compactionMeta
} from './compaction'
import { getApproval, listApprovals, requestApproval, resolveApproval } from './approvals'
import {
  drainQueue,
  enqueue,
  getQueue,
  hasQueued,
  requeueFront,
  takeQueued,
  clearQueue
} from './queue'
import { formatTextToolResult, parseTextToolCalls } from './textTools'
import { buildUserContent, truncateBodyForPreview, validateAttachments } from '../attachments'
import type { AttachmentInfo } from '@shared/types'

export const CANCELLED_TEXT = '[Interrompido pelo usuário antes de concluir]'
export const DENIED_TEXT = 'O usuário negou a execução desta ferramenta.'
const MAX_DEPTH = 2

type LoopOutcome =
  | { kind: 'final'; text: string }
  | { kind: 'aborted'; partial: string }
  | { kind: 'error'; error: string }

type StepResult =
  | { kind: 'final'; text: string }
  | { kind: 'continue' }
  | { kind: 'aborted'; partial: string }
  | { kind: 'error'; error: string }

interface CompactRequest {
  reason: 'manual' | 'auto'
  /** Depois de compactar, continua o turno ("Compactar e tentar de novo"). */
  retry?: boolean
}

type CompactionResult =
  { kind: 'ok' } | { kind: 'skipped' } | { kind: 'aborted' } | { kind: 'error'; error: string }

interface RunState {
  sessionId: string
  chatId: string
  depth: number
  controller: AbortController
  stopRequested: boolean
  forced: QueuedMessage[]
  done: Promise<LoopOutcome>
  /** Compactação pedida/agendada: roda no próximo limite de passo. */
  compact: CompactRequest | null
  /** Loop iniciado só para compactar (ocioso): termina depois, salvo fila/⚡/retry. */
  compactOnly: boolean
  /** Já houve compactação automática desde a última chamada bem-sucedida (evita laço). */
  autoCompactTried: boolean
}

interface ToolOutcome {
  content: string
  status: 'ok' | 'error' | 'denied' | 'cancelled'
  subSessionId?: string
  shellCwd?: string
  durationMs: number
}

const runs = new Map<string, RunState>()

const DEBUG = !!process.env['CLEARCHAT_DEBUG']
const dbg = (...a: unknown[]): void => {
  if (DEBUG) console.log('[clearchat:runner]', new Date().toISOString(), ...a)
}

// ---------------- helpers ----------------

/** true após before-quit: o loop abortado não toca mais no banco. */
let shuttingDown = false

function setStatus(sessionId: string, status: SessionStatus): void {
  if (shuttingDown) return
  const cur = sessionsRepo.get(sessionId)
  if (!cur || cur.status === status) return
  const s = sessionsRepo.setStatus(sessionId, status)
  if (s) emit({ type: 'session-updated', session: s })
}

function append(sessionId: string, message: ApiMessage, meta: MessageMeta = {}): StoredMessage {
  if (shuttingDown) throw new Error('Aplicativo encerrando.')
  const m = messagesRepo.append(sessionId, message, meta)
  emit({ type: 'message-added', message: m })
  const s = sessionsRepo.get(sessionId)
  if (s) chatsRepo.touch(s.chatId)
  return m
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/**
 * Persiste um erro HTTP/do modelo como mensagem só de exibição (sobrevive ao reinício).
 * meta.kind 'error' + synthetic → buildRequest a exclui do histórico enviado à API.
 */
function appendError(sessionId: string, error: string): void {
  if (shuttingDown || !sessionsRepo.get(sessionId)) return
  try {
    append(
      sessionId,
      { role: 'assistant', content: error },
      { synthetic: true, kind: 'error', error }
    )
  } catch (e) {
    console.error('[clearchat] appendError', e)
  }
}

/** Sessão + todos os descendentes (filhos antes dos pais na lista retornada). */
function subtree(chatId: string, rootIds: string[]): Session[] {
  const all = sessionsRepo.list(chatId)
  const out: Session[] = []
  const visit = (id: string): void => {
    for (const c of all.filter((s) => s.parentSessionId === id)) visit(c.id)
    const s = all.find((x) => x.id === id)
    if (s) out.push(s)
  }
  for (const id of rootIds) visit(id)
  return out
}

/**
 * Apaga as subsessões criadas pelos delegate_task destas mensagens (tool com meta.subSessionId ou
 * assistant com o tool_call de origem) — evita subsessões órfãs após regenerate/apagar mensagem.
 * Aborta as que estiverem rodando e emite `session-deleted` para cada uma (descendentes primeiro).
 */
export async function deleteSubSessionsOf(removed: StoredMessage[]): Promise<void> {
  if (!removed.length) return
  const parent = sessionsRepo.get(removed[0].sessionId)
  if (!parent) return
  const callIds = new Set<string>()
  const subIds = new Set<string>()
  for (const m of removed) {
    if (m.meta.subSessionId) subIds.add(m.meta.subSessionId)
    if (m.message.role === 'assistant')
      for (const tc of m.message.tool_calls ?? []) callIds.add(tc.id)
  }
  const roots = sessionsRepo
    .list(parent.chatId)
    .filter(
      (s) =>
        s.parentSessionId === parent.id &&
        (subIds.has(s.id) || (s.parentToolCallId != null && callIds.has(s.parentToolCallId)))
    )
    .map((s) => s.id)
  if (!roots.length) return
  const doomed = subtree(parent.chatId, roots)
  const live = doomed.map((s) => runs.get(s.id)).filter((x): x is RunState => !!x)
  for (const st of live) {
    st.stopRequested = true
    st.forced = []
    st.controller.abort()
  }
  await Promise.all(live.map((st) => waitDone(st, 5000)))
  for (const s of doomed) {
    for (const a of listApprovals()) if (a.sessionId === s.id) resolveApproval(a.id, 'cancel')
    clearQueue(s.id)
  }
  for (const id of roots) sessionsRepo.delete(id) // FK ON DELETE CASCADE leva descendentes e mensagens
  for (const s of doomed) emit({ type: 'session-deleted', sessionId: s.id, chatId: s.chatId })
}

/** Apaga uma mensagem do histórico (IPC messages.delete) + subsessões que ela originou. */
export async function deleteMessage(id: string): Promise<void> {
  const m = messagesRepo.delete(id)
  if (!m) return
  emit({ type: 'message-deleted', sessionId: m.sessionId, messageId: m.id })
  await deleteSubSessionsOf([m])
}

/**
 * Garante pareamento válido no fim do histórico: para cada tool_call do último assistant
 * sem resposta, adiciona msg `tool` sintética cancelada.
 */
export function repairTail(sessionId: string): void {
  const msgs = messagesRepo.list(sessionId)
  let idx = -1
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i].message
    if (m.role === 'assistant') {
      idx = i
      break
    }
    if (m.role === 'user') return
  }
  if (idx === -1) return
  const a = msgs[idx].message
  if (a.role !== 'assistant' || !a.tool_calls?.length) return
  const answered = new Set(
    msgs
      .slice(idx + 1)
      .map((m) => (m.message.role === 'tool' ? m.message.tool_call_id : null))
      .filter(Boolean)
  )
  for (const tc of a.tool_calls) {
    if (!answered.has(tc.id)) {
      append(
        sessionId,
        { role: 'tool', tool_call_id: tc.id, content: CANCELLED_TEXT },
        { synthetic: true, kind: 'tool-cancelled', toolStatus: 'cancelled' }
      )
    }
  }
}

function maybeSetTitle(session: Session, text: string): void {
  if (session.depth !== 0) return
  const chat = chatsRepo.get(session.chatId)
  if (!chat) return
  if (chat.title && chat.title !== 'Novo chat') return
  const hasUser = messagesRepo.list(session.id).some((m) => m.message.role === 'user')
  if (hasUser) return
  const line = text.replace(/\s+/g, ' ').trim()
  if (!line) return
  const title = line.length > 50 ? line.slice(0, 50).trimEnd() + '…' : line
  const { chat: updated } = chatsRepo.update(chat.id, { title })
  emit({ type: 'chat-updated', chat: updated })
}

function appendUser(
  session: Session,
  text: string,
  meta: MessageMeta = {},
  attachments: AttachmentInfo[] = []
): StoredMessage {
  maybeSetTitle(session, text.trim() ? text : attachments.map((a) => a.name).join(', '))
  return append(session.id, { role: 'user', content: buildUserContent(text, attachments) }, meta)
}

// ---------------- loop ----------------

function startLoop(
  session: Session,
  parentSignal?: AbortSignal,
  init: { compact?: CompactRequest; compactOnly?: boolean } = {}
): RunState {
  const st: RunState = {
    sessionId: session.id,
    chatId: session.chatId,
    depth: session.depth,
    controller: new AbortController(),
    stopRequested: false,
    forced: [],
    done: Promise.resolve({ kind: 'final', text: '' }),
    compact: init.compact ?? null,
    compactOnly: !!init.compactOnly,
    autoCompactTried: false
  }
  if (parentSignal) {
    if (parentSignal.aborted) st.controller.abort()
    else parentSignal.addEventListener('abort', () => st.controller.abort(), { once: true })
  }
  runs.set(session.id, st)
  setStatus(session.id, 'running')
  st.done = runLoop(st).catch((e): LoopOutcome => {
    const error = `Erro interno: ${errMsg(e)}`
    console.error('[clearchat] runner', e)
    appendError(st.sessionId, error)
    finish(st, 'error')
    emit({ type: 'error', sessionId: st.sessionId, error })
    return { kind: 'error', error }
  })
  return st
}

function finish(st: RunState, status: SessionStatus): void {
  if (runs.get(st.sessionId) === st) runs.delete(st.sessionId)
  if (st.compact) {
    st.compact = null
    emit({ type: 'compaction', sessionId: st.sessionId, state: null })
  }
  setStatus(st.sessionId, status)
}

// ---------------- compactação ----------------

const windowCache = new Map<string, { at: number; models: ModelInfo[] | null }>()

/** Janela de contexto da sessão (override do chat / contextLength do modelo via /models, em cache). */
async function contextWindowFor(chat: Chat, session: Session): Promise<number | null> {
  const provider = providersRepo.get(chat.config.providerId)
  let models: ModelInfo[] | null = null
  if (provider) {
    const c = windowCache.get(provider.id)
    if (c && Date.now() - c.at < 5 * 60_000) models = c.models
    else {
      try {
        models = await listModels(provider)
      } catch {
        models = null
      }
      windowCache.set(provider.id, { at: Date.now(), models })
    }
  }
  return resolveContextWindow(chat.config, session, models)
}

/** Subsessões compactam sempre ao atingir o limite; a principal só com autoCompact. */
function autoCompactAllowed(chat: Chat, depth: number): boolean {
  return depth > 0 || !!chat.config.autoCompact
}

async function shouldAutoCompact(st: RunState): Promise<boolean> {
  const session = sessionsRepo.get(st.sessionId)
  const chat = session && chatsRepo.get(session.chatId)
  if (!session || !chat || !autoCompactAllowed(chat, session.depth)) return false
  const history = messagesRepo.list(session.id)
  if (!hasCompactableHistory(history)) return false
  const usage = contextUsage(history)
  if (!usage) return false
  const window = await contextWindowFor(chat, session)
  return !!window && usage.used >= compactThreshold(chat.config) * window
}

/**
 * Resume o histórico ativo com o mesmo modelo (request normal + prompt de compactação no fim),
 * transmitindo o resumo (evento `compaction`), e persiste a fronteira `role: user`. Abortar
 * (Parar/⚡) cancela sem salvar nada.
 */
async function runCompaction(st: RunState, signal: AbortSignal): Promise<CompactionResult> {
  const session = sessionsRepo.get(st.sessionId)
  if (!session) return { kind: 'error', error: 'Sessão não encontrada.' }
  const chat = chatsRepo.get(session.chatId)
  if (!chat) return { kind: 'error', error: 'Chat não encontrado.' }
  const provider = providersRepo.get(chat.config.providerId)
  if (!provider) return { kind: 'error', error: 'Nenhum provider configurado para este chat.' }
  repairTail(session.id)
  const history = messagesRepo.list(session.id)
  if (!hasCompactableHistory(history)) return { kind: 'skipped' }
  const window = await contextWindowFor(chat, session)
  const prompt = chat.config.compactPrompt?.trim()
    ? chat.config.compactPrompt
    : DEFAULT_COMPACT_PROMPT
  emit({ type: 'compaction', sessionId: session.id, state: 'running', text: '' })
  dbg('compact', session.id.slice(0, 8), 'msgs', history.length)
  const t0 = Date.now()
  try {
    let acc = newAccumulator()
    let toolChoiceNone = false
    for (let i = 0; i < COMPACTION_MODES.length;) {
      let req
      try {
        req = buildCompactionRequest(chat, session, history, provider, prompt, {
          mode: COMPACTION_MODES[i],
          window,
          toolChoiceNone
        })
      } catch (e) {
        return { kind: 'error', error: errMsg(e) }
      }
      acc = newAccumulator()
      const cur = acc
      const tick = throttle(
        () =>
          emit({ type: 'compaction', sessionId: session.id, state: 'running', text: cur.content }),
        60
      )
      try {
        await streamChat(req, signal, acc, tick.call)
      } catch (e) {
        tick.cancel()
        if (signal.aborted) return { kind: 'aborted' }
        const error = errMsg(e)
        if (isContextLengthError(error) && i < COMPACTION_MODES.length - 1) {
          i++
          continue
        }
        return { kind: 'error', error }
      }
      tick.cancel()
      if (!acc.content.trim()) {
        if (!toolChoiceNone) {
          toolChoiceNone = true
          continue
        }
        return { kind: 'error', error: 'o modelo não retornou um resumo.' }
      }
      break
    }
    if (signal.aborted) return { kind: 'aborted' }
    const summary = cleanSummary(acc.content)
    const m = compactionMeta(chat, session, history, summary, acc.usage?.completionTokens)
    const meta: MessageMeta = {
      synthetic: true,
      kind: 'compaction',
      summaryOf: m.summaryOf,
      compactedCount: m.compactedCount,
      contextEstimate: m.contextEstimate,
      model: acc.model ?? session.model,
      durationMs: Date.now() - t0
    }
    const before = contextUsage(history)
    if (before) meta.usageBefore = before.used
    if (acc.usage) meta.compactUsage = acc.usage
    if (m.insertBeforeSeq != null) {
      // mensagens do usuário ainda sem resposta ficam depois da fronteira (intactas)
      if (shuttingDown) throw new Error('Aplicativo encerrando.')
      const r = messagesRepo.insertAt(
        session.id,
        m.insertBeforeSeq,
        { role: 'user', content: m.text },
        meta
      )
      for (const x of r.shifted) emit({ type: 'message-updated', message: x })
      emit({ type: 'message-added', message: r.message })
      chatsRepo.touch(session.chatId)
    } else append(session.id, { role: 'user', content: m.text }, meta)
    return { kind: 'ok' }
  } finally {
    emit({ type: 'compaction', sessionId: session.id, state: null })
  }
}

/** Abort (Parar/⚡) em qualquer ponto do loop: injeta forçados e continua, ou encerra. */
function onAborted(st: RunState, partial: string): 'continue' | LoopOutcome {
  repairTail(st.sessionId)
  if (!st.stopRequested && st.forced.length && sessionsRepo.get(st.sessionId)) {
    st.controller = new AbortController()
    st.compactOnly = false
    for (const f of st.forced.splice(0)) {
      const s = sessionsRepo.get(st.sessionId)
      if (s) appendUser(s, f.text, { kind: 'forced' }, f.attachments)
    }
    return 'continue'
  }
  finish(st, st.depth === 0 ? 'idle' : 'interrupted')
  return { kind: 'aborted', partial }
}

async function runLoop(st: RunState): Promise<LoopOutcome> {
  let lastText = ''
  for (;;) {
    // ---- compactação no limite de passo (pedida, agendada ou automática) ----
    if (!st.compact && !st.autoCompactTried && (await shouldAutoCompact(st)))
      st.compact = { reason: 'auto' }
    if (st.compact) {
      const req = st.compact
      st.compact = null
      if (req.reason === 'auto') st.autoCompactTried = true
      const signal = st.controller.signal
      let cr: CompactionResult
      try {
        cr = await runCompaction(st, signal)
      } catch (e) {
        cr = signal.aborted ? { kind: 'aborted' } : { kind: 'error', error: errMsg(e) }
      }
      if (shuttingDown) {
        if (runs.get(st.sessionId) === st) runs.delete(st.sessionId)
        return { kind: 'aborted', partial: '' }
      }
      if (signal.aborted || cr.kind === 'aborted') {
        const r = onAborted(st, '')
        if (r === 'continue') continue
        return r
      }
      if (cr.kind === 'error') {
        const error = `Falha ao compactar: ${cr.error}`
        appendError(st.sessionId, error)
        emit({ type: 'error', sessionId: st.sessionId, error })
        if (st.compactOnly) {
          finish(st, 'error')
          return { kind: 'error', error }
        }
      }
      if (st.compactOnly) {
        st.compactOnly = false
        const more =
          (req.retry && cr.kind !== 'error') ||
          st.forced.length > 0 ||
          (st.depth === 0 && hasQueued(st.sessionId))
        if (!more) {
          finish(st, st.depth === 0 ? 'idle' : 'done')
          return { kind: 'final', text: lastText }
        }
        for (const f of st.forced.splice(0)) {
          const s = sessionsRepo.get(st.sessionId)
          if (s) appendUser(s, f.text, { kind: 'forced' }, f.attachments)
        }
      }
    }

    if (st.depth === 0) {
      for (const q of drainQueue(st.sessionId)) {
        const s = sessionsRepo.get(st.sessionId)
        if (s) appendUser(s, q.text, { kind: 'queued' }, q.attachments)
      }
    }
    const signal = st.controller.signal
    let res: StepResult
    try {
      res = await step(st, signal)
    } catch (e) {
      res = signal.aborted ? { kind: 'aborted', partial: '' } : { kind: 'error', error: errMsg(e) }
    }

    if (shuttingDown) {
      if (runs.get(st.sessionId) === st) runs.delete(st.sessionId)
      return { kind: 'aborted', partial: '' }
    }
    if (signal.aborted || res.kind === 'aborted') {
      const r = onAborted(st, res.kind === 'aborted' ? res.partial : lastText)
      if (r === 'continue') continue
      return r
    }

    if (res.kind === 'error') {
      // Contexto estourado: compacta e tenta de novo (subsessões sempre; principal com autoCompact).
      if (isContextLengthError(res.error) && !st.autoCompactTried) {
        const chat = chatsRepo.get(st.chatId)
        if (chat && autoCompactAllowed(chat, st.depth)) {
          st.compact = { reason: 'auto' }
          continue
        }
      }
      repairTail(st.sessionId)
      appendError(st.sessionId, res.error)
      finish(st, 'error')
      emit({ type: 'error', sessionId: st.sessionId, error: res.error })
      return res
    }

    st.autoCompactTried = false // houve chamada bem-sucedida (usage nova)
    if (res.kind === 'continue') continue

    lastText = res.text
    // Compactação agendada durante o último passo: roda agora e encerra o turno (salvo fila/⚡).
    if (st.compact) {
      st.compactOnly = true
      continue
    }
    // Fim de turno: anexa forçados/fila e continua; senão encerra (checagem + finish síncronos).
    if (st.forced.length) {
      for (const f of st.forced.splice(0)) {
        const s = sessionsRepo.get(st.sessionId)
        if (s) appendUser(s, f.text, { kind: 'forced' }, f.attachments)
      }
      continue
    }
    if (st.depth === 0 && hasQueued(st.sessionId)) continue
    finish(st, st.depth === 0 ? 'idle' : 'done')
    return { kind: 'final', text: res.text }
  }
}

async function step(st: RunState, signal: AbortSignal): Promise<StepResult> {
  const session = sessionsRepo.get(st.sessionId)
  if (!session) return { kind: 'error', error: 'Sessão não encontrada (chat apagado?).' }
  const chat = chatsRepo.get(session.chatId)
  if (!chat) return { kind: 'error', error: 'Chat não encontrado.' }
  const provider = providersRepo.get(chat.config.providerId)
  if (!provider) return { kind: 'error', error: 'Nenhum provider configurado para este chat.' }
  if (!session.model) return { kind: 'error', error: 'Nenhum modelo selecionado para este chat.' }

  const history = messagesRepo.list(session.id)
  let req
  try {
    req = buildRequest(chat, session, history, provider)
  } catch (e) {
    return { kind: 'error', error: errMsg(e) }
  }

  dbg('step', session.id.slice(0, 8), 'model', session.model, 'msgs', history.length)
  const acc = newAccumulator()
  const draft = throttle(
    () => emit({ type: 'draft', sessionId: session.id, draft: accToDraft(acc) }),
    40
  )
  const t0 = Date.now()
  try {
    await streamChat(req, signal, acc, draft.call)
  } catch (e) {
    draft.cancel()
    emit({ type: 'draft', sessionId: session.id, draft: null })
    dbg('stream fail', session.id.slice(0, 8), signal.aborted ? 'aborted' : errMsg(e))
    if (signal.aborted) {
      if (acc.content.trim()) {
        append(
          session.id,
          {
            role: 'assistant',
            content: acc.content,
            ...(acc.reasoning.trim() ? { reasoning: acc.reasoning } : {})
          },
          { interrupted: true, model: acc.model ?? session.model, durationMs: Date.now() - t0 }
        )
      }
      return { kind: 'aborted', partial: acc.content }
    }
    return { kind: 'error', error: errMsg(e) }
  }
  draft.cancel()
  emit({ type: 'draft', sessionId: session.id, draft: null })
  dbg(
    'stream ok',
    session.id.slice(0, 8),
    Date.now() - t0,
    'ms',
    acc.finishReason,
    'tool_calls',
    acc.toolCalls.length
  )

  const calls: ToolCall[] = finalizeToolCalls(acc).map((t) => ({
    id: t.id,
    type: 'function',
    function: { name: t.name, arguments: t.arguments }
  }))
  const assistant: ApiMessage = {
    role: 'assistant',
    content: acc.content ? acc.content : calls.length ? null : '',
    ...(calls.length ? { tool_calls: calls } : {}),
    ...(acc.reasoning.trim() ? { reasoning: acc.reasoning } : {})
  }
  const meta: MessageMeta = { model: acc.model ?? session.model, durationMs: Date.now() - t0 }
  if (acc.usage) meta.usage = acc.usage
  append(session.id, assistant, meta)

  // ---- tools nativas ----
  if (calls.length) {
    for (const call of calls) {
      if (signal.aborted) break
      const r = await executeTool(
        st,
        session,
        call.id,
        call.function.name,
        call.function.arguments,
        signal
      )
      const tmeta: MessageMeta = { toolStatus: r.status, durationMs: r.durationMs }
      if (r.subSessionId) tmeta.subSessionId = r.subSessionId
      if (r.shellCwd) tmeta.shellCwd = r.shellCwd
      if (r.status === 'cancelled') {
        tmeta.synthetic = true
        tmeta.kind = 'tool-cancelled'
      }
      append(session.id, { role: 'tool', tool_call_id: call.id, content: r.content }, tmeta)
      if (r.status === 'cancelled' && signal.aborted) break
    }
    if (signal.aborted) return { kind: 'aborted', partial: '' }
    return { kind: 'continue' }
  }

  // ---- modo texto (sem tools nativas) ----
  if (!chat.config.nativeTools && availableTools(chat, session).length && acc.content) {
    const parsed = parseTextToolCalls(acc.content, availableTools(chat, session))
    if (parsed.length) {
      const parts: string[] = []
      let subSessionId: string | undefined
      for (let i = 0; i < parsed.length; i++) {
        const p = parsed[i]
        if (signal.aborted) {
          parts.push(formatTextToolResult(p.name, CANCELLED_TEXT))
          continue
        }
        if (p.error) {
          parts.push(formatTextToolResult(p.name, `Erro: ${p.error}`))
          continue
        }
        const id = `text_${Date.now().toString(36)}_${i}`
        const r = await executeTool(st, session, id, p.name, p.args, signal)
        if (r.subSessionId) subSessionId = r.subSessionId
        parts.push(formatTextToolResult(p.name, r.content))
      }
      const umeta: MessageMeta = { synthetic: true }
      if (subSessionId) umeta.subSessionId = subSessionId
      append(session.id, { role: 'user', content: parts.join('\n\n') }, umeta)
      if (signal.aborted) return { kind: 'aborted', partial: '' }
      return { kind: 'continue' }
    }
  }

  return { kind: 'final', text: acc.content }
}

async function executeTool(
  st: RunState,
  session: Session,
  toolCallId: string,
  rawName: string,
  rawArgs: string | Record<string, unknown>,
  signal: AbortSignal
): Promise<ToolOutcome> {
  const t0 = Date.now()
  const done = (o: Omit<ToolOutcome, 'durationMs'>): ToolOutcome => ({
    ...o,
    durationMs: Date.now() - t0
  })
  const chat = chatsRepo.get(session.chatId)
  if (!chat) return done({ content: 'Erro: chat não encontrado.', status: 'error' })
  const name = rawName as ToolName
  if (!availableTools(chat, session).includes(name)) {
    return done({
      content: `Erro: a ferramenta "${rawName}" não está disponível nesta sessão.`,
      status: 'error'
    })
  }
  let args: Record<string, unknown>
  try {
    args = parseToolArgs(rawArgs)
  } catch (e) {
    return done({ content: `Erro: ${errMsg(e)}`, status: 'error' })
  }

  if (CONFIRM_TOOLS.includes(name) && !chat.config.autoApprove.includes(name)) {
    setStatus(session.id, 'awaiting_approval')
    const outcome = await requestApproval(
      { chatId: chat.id, sessionId: session.id, toolCallId, toolName: name, args },
      signal
    )
    if (!signal.aborted) setStatus(session.id, 'running')
    if (outcome === 'deny') return done({ content: DENIED_TEXT, status: 'denied' })
    if (outcome === 'cancel' || signal.aborted)
      return done({ content: CANCELLED_TEXT, status: 'cancelled' })
  }
  if (signal.aborted) return done({ content: CANCELLED_TEXT, status: 'cancelled' })

  emit({ type: 'tool-running', sessionId: session.id, toolCallId, running: true })
  let latest = ''
  const out = throttle(
    () =>
      emit({
        type: 'tool-running',
        sessionId: session.id,
        toolCallId,
        running: true,
        output: latest.length > 20_000 ? latest.slice(-20_000) : latest
      }),
    150
  )
  try {
    if (name === 'delegate_task') {
      return done(await runDelegate(st, session, chat, toolCallId, args, signal))
    }
    const root = chat.config.cwd
    const provider = name === 'list_models' ? providersRepo.get(chat.config.providerId) : null
    const r = await runLocalTool(name, args, {
      cwd: root,
      confine: chat.config.confineToRoot !== false,
      maxOutput: clampToolOutput(chat.config.maxToolOutputChars),
      sandbox: !!chat.config.sandboxBash,
      shell:
        name === 'bash'
          ? shellStateFor(session.id, root, () => lastShellCwd(session.id))
          : undefined,
      cacheKey: session.id,
      models: provider
        ? { providerName: provider.name, current: session.model, list: () => listModels(provider) }
        : undefined,
      signal,
      onOutput: (partial) => {
        latest = partial
        out.call()
      }
    })
    return done({ content: r.content, status: r.status, shellCwd: r.meta?.shellCwd })
  } catch (e) {
    if (signal.aborted || (e as Error).name === 'AbortError') {
      return done({ content: CANCELLED_TEXT, status: 'cancelled' })
    }
    return done({ content: `Erro: ${errMsg(e)}`, status: 'error' })
  } finally {
    out.cancel()
    emit({ type: 'tool-running', sessionId: session.id, toolCallId, running: false })
  }
}

/** Modelo do subagente: o pedido pelo modelo chamador, se existir no provider; senão o da sessão. */
async function resolveSubagentModel(
  chat: Chat,
  session: Session,
  requested: unknown
): Promise<string> {
  const req = typeof requested === 'string' ? requested.trim() : ''
  if (!req || req === session.model) return session.model
  const provider = providersRepo.get(chat.config.providerId)
  if (!provider) return session.model
  try {
    const models = await listModels(provider)
    return models.some((m) => m.id === req) ? req : session.model
  } catch {
    return req // sem lista de modelos: confia no pedido
  }
}

async function runDelegate(
  _parent: RunState,
  session: Session,
  chat: Chat,
  toolCallId: string,
  args: Record<string, unknown>,
  signal: AbortSignal
): Promise<Omit<ToolOutcome, 'durationMs'>> {
  if (session.depth >= MAX_DEPTH) {
    return { content: 'Erro: profundidade máxima de subagentes atingida.', status: 'error' }
  }
  const task = typeof args.task === 'string' ? args.task.trim() : ''
  if (!task) return { content: 'Erro: argumento obrigatório "task" ausente.', status: 'error' }
  const model = await resolveSubagentModel(chat, session, args.model)
  const rawTitle =
    (typeof args.title === 'string' && args.title.trim()) || task.replace(/\s+/g, ' ')
  const title = rawTitle.length > 60 ? rawTitle.slice(0, 60).trimEnd() + '…' : rawTitle

  const child = sessionsRepo.create({
    chatId: chat.id,
    parentSessionId: session.id,
    parentToolCallId: toolCallId,
    depth: (session.depth + 1) as 1 | 2,
    model,
    title,
    task,
    status: 'running'
  })
  emit({ type: 'session-created', session: child })
  append(child.id, { role: 'user', content: task }, { synthetic: true })

  const cst = startLoop(child, signal)
  const outcome = await cst.done
  const max = clampToolOutput(chat.config.maxToolOutputChars)
  if (outcome.kind === 'final') {
    return {
      content: truncateHeadTail(outcome.text.trim() || delegateEmptyText(model), max, 0.5),
      status: 'ok',
      subSessionId: child.id
    }
  }
  if (outcome.kind === 'aborted') {
    if (signal.aborted)
      return { content: CANCELLED_TEXT, status: 'cancelled', subSessionId: child.id }
    const partial = outcome.partial.trim()
    return {
      content: `[Subagente interrompido pelo usuário]${partial ? `\n\nResposta parcial:\n${truncate(partial)}` : ''}`,
      status: 'cancelled',
      subSessionId: child.id
    }
  }
  return {
    content: delegateFailureText(model, outcome.error),
    status: 'error',
    subSessionId: child.id
  }
}

/** Último diretório do shell salvo nesta sessão (restaura o `cd` do bash após reiniciar o app). */
function lastShellCwd(sessionId: string): string | undefined {
  const msgs = messagesRepo.list(sessionId)
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].meta.shellCwd) return msgs[i].meta.shellCwd
  return undefined
}

// ---------------- API pública (IPC) ----------------

/**
 * Compactar (só sessão principal; subsessões compactam sozinhas). Ociosa → roda já (loop só de
 * compactação); rodando → agenda para o próximo limite de passo.
 */
export function compact(sessionId: string, opts: CompactOptions = {}): { scheduled: boolean } {
  const session = sessionsRepo.get(sessionId)
  if (!session) throw new Error('Sessão não encontrada.')
  if (session.depth !== 0)
    throw new Error('Subsessões são somente leitura (compactam automaticamente).')
  const req: CompactRequest = { reason: 'manual', retry: !!opts.retry }
  const st = runs.get(sessionId)
  if (st) {
    if (st.stopRequested) throw new Error('A sessão está parando; tente novamente.')
    st.compact = req
    emit({ type: 'compaction', sessionId, state: 'scheduled' })
    return { scheduled: true }
  }
  repairTail(sessionId)
  if (!hasCompactableHistory(messagesRepo.list(sessionId)))
    throw new Error('Nada para compactar ainda (nenhuma resposta desde a última compactação).')
  startLoop(session, undefined, { compact: req, compactOnly: true })
  return { scheduled: false }
}

export function send(
  sessionId: string,
  text: string,
  attachmentsInput?: AttachmentInfo[]
): { queued: boolean } {
  const session = sessionsRepo.get(sessionId)
  if (!session) throw new Error('Sessão não encontrada.')
  if (session.depth !== 0) throw new Error('Subsessões são somente leitura.')
  const attachments = validateAttachments(attachmentsInput)
  text = typeof text === 'string' ? text : ''
  if (!text.trim() && !attachments.length) throw new Error('Mensagem vazia.')
  if (runs.has(sessionId)) {
    enqueue(sessionId, text, attachments)
    return { queued: true }
  }
  repairTail(sessionId)
  appendUser(session, text, {}, attachments)
  startLoop(session)
  return { queued: false }
}

export function forceSend(queuedId: string): void {
  const item = takeQueued(queuedId)
  if (!item) return
  const st = runs.get(item.sessionId)
  if (st && !st.stopRequested) {
    st.forced.push(item)
    st.controller.abort()
    return
  }
  const session = sessionsRepo.get(item.sessionId)
  if (!session) return
  if (st) {
    // ainda parando: volta para a fila; o usuário pode tentar de novo
    requeueFront(item.sessionId, [item])
    return
  }
  repairTail(session.id)
  appendUser(session, item.text, {}, item.attachments)
  startLoop(session)
}

export function removeQueued(queuedId: string): void {
  takeQueued(queuedId)
}

export { getQueue }

async function waitDone(st: RunState, ms = 15_000): Promise<void> {
  await Promise.race([st.done.then(() => undefined), new Promise<void>((r) => setTimeout(r, ms))])
}

export async function stop(sessionId: string): Promise<void> {
  const st = runs.get(sessionId)
  if (!st) return
  st.stopRequested = true
  if (st.forced.length) requeueFront(sessionId, st.forced.splice(0))
  st.controller.abort()
  await waitDone(st)
}

export async function regenerate(sessionId: string): Promise<void> {
  const session = sessionsRepo.get(sessionId)
  if (!session) throw new Error('Sessão não encontrada.')
  if (session.depth !== 0) throw new Error('Subsessões são somente leitura.')
  if (runs.has(sessionId)) await stop(sessionId)
  if (runs.has(sessionId)) throw new Error('A sessão ainda está parando; tente novamente.')
  const msgs = messagesRepo.list(sessionId)
  let idx = -1
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].message.role === 'user' && !msgs[i].meta.synthetic) {
      idx = i
      break
    }
  }
  if (idx === -1) throw new Error('Não há mensagem do usuário para regenerar.')
  const removed = msgs.slice(idx + 1)
  for (const m of removed) {
    messagesRepo.delete(m.id)
    emit({ type: 'message-deleted', sessionId, messageId: m.id })
  }
  await deleteSubSessionsOf(removed)
  if (runs.has(sessionId)) return
  startLoop(session)
}

export function approve(requestId: string, decision: ApprovalDecision): void {
  const req = getApproval(requestId)
  if (!req) return
  if (decision === 'always') {
    const chat = chatsRepo.get(req.chatId)
    if (chat && !chat.config.autoApprove.includes(req.toolName)) {
      const { chat: updated } = chatsRepo.update(chat.id, {
        config: { autoApprove: [...chat.config.autoApprove, req.toolName] }
      })
      emit({ type: 'chat-updated', chat: updated })
    }
    resolveApproval(requestId, 'allow')
    // outras solicitações pendentes da mesma tool neste chat também são liberadas
    for (const other of listApprovals()) {
      if (other.chatId === req.chatId && other.toolName === req.toolName)
        resolveApproval(other.id, 'allow')
    }
    return
  }
  resolveApproval(requestId, decision === 'allow' ? 'allow' : 'deny')
}

export function pendingApprovals(): ReturnType<typeof listApprovals> {
  return listApprovals()
}

export function previewRequest(sessionId: string): RequestPreview {
  const session = sessionsRepo.get(sessionId)
  if (!session) throw new Error('Sessão não encontrada.')
  const chat = chatsRepo.get(session.chatId)
  if (!chat) throw new Error('Chat não encontrado.')
  const provider = providersRepo.get(chat.config.providerId)
  if (!provider) throw new Error('Nenhum provider configurado para este chat.')
  const req = buildRequest(chat, session, messagesRepo.list(sessionId), provider)
  const masked = maskRequest(req, provider.apiKey)
  // anexos: o base64 aparece encurtado (a request real leva o arquivo inteiro)
  const { body, truncated } = truncateBodyForPreview(masked.body)
  if (!truncated) return masked
  return {
    ...masked,
    body,
    notes: [
      `Base64 de ${truncated} anexo${truncated > 1 ? 's' : ''} encurtado nesta visualização (…(tamanho)); a request real envia o arquivo inteiro.`
    ]
  }
}

export function runningSessions(): string[] {
  return [...runs.keys()]
}

export function isRunning(sessionId: string): boolean {
  return runs.has(sessionId)
}

/** Aborta todas as sessões de um chat (antes de apagá-lo). */
export async function stopChat(chatId: string): Promise<void> {
  const sts = [...runs.values()].filter((s) => s.chatId === chatId)
  for (const st of sts) {
    st.stopRequested = true
    st.forced = []
    st.controller.abort()
  }
  await Promise.all(sts.map((st) => waitDone(st, 5000)))
  for (const st of sts) clearQueue(st.sessionId)
  for (const s of sessionsRepo.list(chatId)) clearQueue(s.id)
}

/** Inicialização: sessões que ficaram 'running'/'awaiting_approval' → 'interrupted' (+ repara pareamento). */
export function initRunner(): void {
  for (const id of sessionsRepo.markStaleInterrupted()) {
    try {
      repairTail(id)
    } catch (e) {
      console.error('[clearchat] repairTail', id, e)
    }
  }
}

/**
 * Encerramento do app (before-quit): aborta tudo (mata process groups do bash) e marca as sessões
 * em andamento como 'interrupted', reparando o pareamento tool_calls ↔ tool de forma síncrona.
 */
export function shutdownRunner(): void {
  const ids = [...runs.keys()]
  for (const id of ids) {
    try {
      repairTail(id)
      const s = sessionsRepo.setStatus(id, 'interrupted')
      if (s) emit({ type: 'session-updated', session: s })
    } catch (e) {
      console.error('[clearchat] shutdown', id, e)
    }
  }
  shuttingDown = true
  for (const st of runs.values()) {
    st.stopRequested = true
    st.forced = []
    st.controller.abort()
  }
}
