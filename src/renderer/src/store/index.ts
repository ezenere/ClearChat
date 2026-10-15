import { create } from 'zustand'
import type {
  AgentEvent,
  ApprovalRequest,
  Chat,
  ChatConfig,
  ModelInfo,
  Provider,
  QueuedMessage,
  Session,
  StoredMessage,
  StreamDraft
} from '@shared/types'
import type { AppCapabilities, ApprovalDecision } from '@shared/ipc'
import { api, errorMessage } from '../lib/api'

export type View = { kind: 'new' } | { kind: 'chat'; chatId: string; sessionId: string }

export interface AppSettings {
  defaultProviderId: string | null
  defaultModel: string | null
  defaultSystemPrompt: string | null
  defaultCwd: string | null
}

export interface ToolRun {
  running: boolean
  output?: string
}

export interface ModelsEntry {
  status: 'loading' | 'ok' | 'error'
  list: ModelInfo[]
  error?: string
}

export interface Toast {
  id: number
  kind: 'error' | 'info' | 'success'
  text: string
}

export type PanelTab = 'config' | 'files'

/** Compactação em andamento/agendada por sessão (evento `compaction`). */
export interface CompactionState {
  state: 'scheduled' | 'running'
  text: string
}

interface State {
  booted: boolean
  providers: Provider[]
  chats: Chat[]
  settings: AppSettings
  homeDir: string | null
  view: View
  /** Todas as sessões conhecidas, por id. */
  sessions: Record<string, Session>
  /** Mensagens por sessão (só sessões já carregadas). */
  messages: Record<string, StoredMessage[]>
  drafts: Record<string, StreamDraft | null>
  toolRuns: Record<string, Record<string, ToolRun>>
  queues: Record<string, QueuedMessage[]>
  approvals: ApprovalRequest[]
  errors: Record<string, string | undefined>
  models: Record<string, ModelsEntry>
  panelOpen: boolean
  panelTab: PanelTab
  settingsOpen: boolean
  previewSessionId: string | null
  toasts: Toast[]
  compactions: Record<string, CompactionState | undefined>
  /** Incrementado a cada resultado de tool num chat (aba Arquivos recarrega). */
  fsTick: Record<string, number>
  capabilities: AppCapabilities
  /** Seção do painel Config para rolar até (ex.: 'contexto'). */
  configFocus: string | null
}

interface Actions {
  boot(): Promise<void>
  refreshProviders(): Promise<void>
  setSetting<K extends keyof AppSettings>(key: K, value: AppSettings[K]): Promise<void>
  goNew(): void
  openChat(chatId: string, sessionId?: string): Promise<void>
  openSession(sessionId: string): Promise<void>
  loadMessages(sessionId: string, force?: boolean): Promise<void>
  createChat(input: { title?: string; config: Partial<ChatConfig> }): Promise<Chat | null>
  renameChat(chatId: string, title: string): Promise<void>
  deleteChat(chatId: string): Promise<void>
  patchConfig(chatId: string, patch: Partial<ChatConfig>): void
  flushConfig(chatId: string): Promise<void>
  send(sessionId: string, text: string): Promise<boolean>
  approve(id: string, decision: ApprovalDecision): Promise<void>
  loadModels(providerId: string, force?: boolean): Promise<void>
  setPanel(open: boolean, tab?: PanelTab): void
  setSettingsOpen(open: boolean): void
  setPreview(sessionId: string | null): void
  toast(text: string, kind?: Toast['kind']): void
  dismissToast(id: number): void
  dismissError(sessionId: string): void
  /** Compactar a conversa (idle → já; rodando → agenda). */
  compact(sessionId: string, retry?: boolean): Promise<void>
  focusConfig(section: string | null): void
  /** Executa uma chamada de API; em caso de erro mostra um toast e retorna undefined. */
  run<T>(fn: () => Promise<T>, label?: string): Promise<T | undefined>
}

export type Store = State & Actions

// Patches de config ainda não salvos (debounce), por chat.
const pending = new Map<
  string,
  { patch: Partial<ChatConfig>; timer: ReturnType<typeof setTimeout> }
>()
let toastSeq = 0
let unsubscribe: (() => void) | null = null

const SETTINGS_KEYS: (keyof AppSettings)[] = [
  'defaultProviderId',
  'defaultModel',
  'defaultSystemPrompt',
  'defaultCwd'
]

function sortChats(chats: Chat[]): Chat[] {
  return [...chats].sort((a, b) => b.updatedAt - a.updatedAt)
}

function upsertMessage(list: StoredMessage[], msg: StoredMessage): StoredMessage[] {
  const idx = list.findIndex((m) => m.id === msg.id)
  if (idx >= 0) {
    const next = [...list]
    next[idx] = msg
    return next
  }
  const next = [...list, msg]
  if (list.length && list[list.length - 1].seq > msg.seq) next.sort((a, b) => a.seq - b.seq)
  return next
}

/** Reaplica um patch local pendente sobre um chat que chegou do main. */
function withPending(chat: Chat): Chat {
  const p = pending.get(chat.id)
  return p ? { ...chat, config: { ...chat.config, ...p.patch } } : chat
}

export const useStore = create<Store>()((set, get) => ({
  booted: false,
  providers: [],
  chats: [],
  settings: {
    defaultProviderId: null,
    defaultModel: null,
    defaultSystemPrompt: null,
    defaultCwd: null
  },
  homeDir: null,
  view: { kind: 'new' },
  sessions: {},
  messages: {},
  drafts: {},
  toolRuns: {},
  queues: {},
  approvals: [],
  errors: {},
  models: {},
  panelOpen: true,
  panelTab: 'config',
  settingsOpen: false,
  previewSessionId: null,
  toasts: [],
  compactions: {},
  fsTick: {},
  capabilities: { bwrap: false, ripgrep: false },
  configFocus: null,

  async run(fn, label) {
    try {
      return await fn()
    } catch (err) {
      get().toast(label ? `${label}: ${errorMessage(err)}` : errorMessage(err), 'error')
      return undefined
    }
  },

  async boot() {
    if (!unsubscribe) unsubscribe = api.onEvent((e) => applyEvent(e))
    const safe = async <T>(p: () => Promise<T>, fallback: T): Promise<T> => {
      try {
        return await p()
      } catch (err) {
        console.warn('[clearchat] boot:', errorMessage(err))
        return fallback
      }
    }
    const [providers, chats, homeDir, approvals, capabilities, ...values] = await Promise.all([
      safe(() => api.providers.list(), [] as Provider[]),
      safe(() => api.chats.list(), [] as Chat[]),
      safe(() => api.fs.homeDir(), null as string | null),
      safe(() => api.agent.pendingApprovals(), [] as ApprovalRequest[]),
      safe(() => api.app.capabilities(), { bwrap: false, ripgrep: false } as AppCapabilities),
      ...SETTINGS_KEYS.map((k) => safe(() => api.settings.get<string>(k), null))
    ])
    const settings = Object.fromEntries(
      SETTINGS_KEYS.map((k, i) => [k, values[i] ?? null])
    ) as unknown as AppSettings
    set({
      providers,
      chats: sortChats(chats),
      homeDir,
      approvals,
      capabilities,
      settings,
      booted: true
    })
  },

  async refreshProviders() {
    const providers = await get().run(() => api.providers.list(), 'Erro ao carregar provedores')
    if (providers) set({ providers })
  },

  async setSetting(key, value) {
    set((s) => ({ settings: { ...s.settings, [key]: value } }))
    await get().run(() => api.settings.set(key, value), 'Erro ao salvar configuração')
  },

  goNew() {
    set({ view: { kind: 'new' } })
  },

  async openChat(chatId, sessionId) {
    const chat = get().chats.find((c) => c.id === chatId)
    if (!chat) return
    const target = sessionId ?? chat.mainSessionId
    set({ view: { kind: 'chat', chatId, sessionId: target } })
    const sessions = await get().run(() => api.sessions.list(chatId), 'Erro ao carregar sessões')
    if (sessions) {
      set((s) => {
        const next = { ...s.sessions }
        for (const ss of sessions) next[ss.id] = ss
        return { sessions: next }
      })
    }
    await get().loadMessages(target)
  },

  async openSession(sessionId) {
    const session = get().sessions[sessionId]
    if (!session) return
    set({ view: { kind: 'chat', chatId: session.chatId, sessionId } })
    await get().loadMessages(sessionId)
  },

  async loadMessages(sessionId, force) {
    if (!force && get().messages[sessionId]) return
    const [msgs, queue] = await Promise.all([
      get().run(() => api.sessions.messages(sessionId), 'Erro ao carregar mensagens'),
      api.agent.getQueue(sessionId).catch(() => [] as QueuedMessage[])
    ])
    set((s) => ({
      messages: { ...s.messages, [sessionId]: [...(msgs ?? [])].sort((a, b) => a.seq - b.seq) },
      queues: { ...s.queues, [sessionId]: queue }
    }))
  },

  async createChat(input) {
    const chat = await get().run(() => api.chats.create(input), 'Não foi possível criar o chat')
    if (!chat) return null
    set((s) => ({ chats: sortChats([chat, ...s.chats.filter((c) => c.id !== chat.id)]) }))
    await get().openChat(chat.id)
    return chat
  },

  async renameChat(chatId, title) {
    set((s) => ({ chats: s.chats.map((c) => (c.id === chatId ? { ...c, title } : c)) }))
    const chat = await get().run(() => api.chats.update(chatId, { title }), 'Erro ao renomear')
    if (chat) set((s) => ({ chats: s.chats.map((c) => (c.id === chatId ? withPending(chat) : c)) }))
  },

  async deleteChat(chatId) {
    const ok = await get().run(async () => {
      await api.chats.delete(chatId)
      return true
    }, 'Erro ao apagar chat')
    if (!ok) return
    set((s) => {
      const view =
        s.view.kind === 'chat' && s.view.chatId === chatId ? { kind: 'new' as const } : s.view
      const sessions = Object.fromEntries(
        Object.entries(s.sessions).filter(([, ss]) => ss.chatId !== chatId)
      )
      return {
        chats: s.chats.filter((c) => c.id !== chatId),
        sessions,
        approvals: s.approvals.filter((a) => a.chatId !== chatId),
        view
      }
    })
  },

  patchConfig(chatId, patch) {
    const prev = pending.get(chatId)
    if (prev) clearTimeout(prev.timer)
    const merged = { ...(prev?.patch ?? {}), ...patch }
    const timer = setTimeout(() => void get().flushConfig(chatId), 450)
    pending.set(chatId, { patch: merged, timer })
    set((s) => ({
      chats: s.chats.map((c) => (c.id === chatId ? { ...c, config: { ...c.config, ...patch } } : c))
    }))
  },

  async flushConfig(chatId) {
    const p = pending.get(chatId)
    if (!p) return
    clearTimeout(p.timer)
    pending.delete(chatId)
    const chat = await get().run(
      () => api.chats.update(chatId, { config: p.patch }),
      'Erro ao salvar configuração do chat'
    )
    if (chat) set((s) => ({ chats: s.chats.map((c) => (c.id === chatId ? withPending(chat) : c)) }))
  },

  async send(sessionId, text) {
    const session = get().sessions[sessionId]
    if (session) await get().flushConfig(session.chatId)
    set((s) => ({ errors: { ...s.errors, [sessionId]: undefined } }))
    const res = await get().run(() => api.agent.send(sessionId, text), 'Falha ao enviar')
    return res !== undefined
  },

  async approve(id, decision) {
    set((s) => ({ approvals: s.approvals.filter((a) => a.id !== id) }))
    await get().run(() => api.agent.approve(id, decision), 'Falha ao responder aprovação')
  },

  async loadModels(providerId, force) {
    const cur = get().models[providerId]
    if (!force && cur && cur.status !== 'error') return
    set((s) => ({
      models: { ...s.models, [providerId]: { status: 'loading', list: cur?.list ?? [] } }
    }))
    try {
      const list = await api.providers.listModels(providerId)
      const sorted = [...list].sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id))
      set((s) => ({ models: { ...s.models, [providerId]: { status: 'ok', list: sorted } } }))
    } catch (err) {
      set((s) => ({
        models: {
          ...s.models,
          [providerId]: { status: 'error', list: [], error: errorMessage(err) }
        }
      }))
    }
  },

  setPanel(open, tab) {
    set((s) => ({ panelOpen: open, panelTab: tab ?? s.panelTab }))
  },
  setSettingsOpen(open) {
    set({ settingsOpen: open })
  },
  setPreview(sessionId) {
    set({ previewSessionId: sessionId })
  },

  toast(text, kind = 'info') {
    const id = ++toastSeq
    set((s) => ({ toasts: [...s.toasts.slice(-3), { id, kind, text }] }))
    setTimeout(() => get().dismissToast(id), kind === 'error' ? 6000 : 3000)
  },
  dismissToast(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
  },
  dismissError(sessionId) {
    set((s) => ({ errors: { ...s.errors, [sessionId]: undefined } }))
  },

  async compact(sessionId, retry) {
    const session = get().sessions[sessionId]
    if (session) await get().flushConfig(session.chatId)
    set((s) => ({ errors: { ...s.errors, [sessionId]: undefined } }))
    const r = await get().run(
      () => api.agent.compact(sessionId, retry ? { retry: true } : undefined),
      'Não foi possível compactar'
    )
    if (r?.scheduled) get().toast('Compactação agendada para o próximo passo do agente.')
  },

  focusConfig(section) {
    set(
      section
        ? { configFocus: section, panelOpen: true, panelTab: 'config' }
        : { configFocus: null }
    )
  }
}))

function applyEvent(e: AgentEvent): void {
  const set = useStore.setState
  switch (e.type) {
    case 'session-created':
    case 'session-updated':
      set((s) => ({ sessions: { ...s.sessions, [e.session.id]: e.session } }))
      break
    case 'session-deleted':
      set((s) => {
        const drop = <T>(rec: Record<string, T>): Record<string, T> => {
          if (!(e.sessionId in rec)) return rec
          const next = { ...rec }
          delete next[e.sessionId]
          return next
        }
        let view = s.view
        if (view.kind === 'chat' && view.sessionId === e.sessionId) {
          const chat = s.chats.find((c) => c.id === e.chatId)
          view = chat ? { kind: 'chat', chatId: chat.id, sessionId: chat.mainSessionId } : view
        }
        return {
          sessions: drop(s.sessions),
          messages: drop(s.messages),
          drafts: drop(s.drafts),
          toolRuns: drop(s.toolRuns),
          queues: drop(s.queues),
          errors: drop(s.errors),
          approvals: s.approvals.filter((a) => a.sessionId !== e.sessionId),
          view
        }
      })
      {
        const v = useStore.getState().view
        if (v.kind === 'chat') void useStore.getState().loadMessages(v.sessionId)
      }
      break
    case 'message-added':
    case 'message-updated': {
      const sid = e.message.sessionId
      set((s) => {
        const list = s.messages[sid]
        // Resultado de tool (nativo ou em texto) → a aba Arquivos do chat recarrega.
        const m = e.message.message
        const isToolResult =
          e.type === 'message-added' &&
          (m.role === 'tool' ||
            (m.role === 'user' &&
              typeof m.content === 'string' &&
              m.content.startsWith('<tool_result')))
        const chatId = s.sessions[sid]?.chatId
        const fsTick =
          isToolResult && chatId ? { ...s.fsTick, [chatId]: (s.fsTick[chatId] ?? 0) + 1 } : s.fsTick
        if (!list) return fsTick === s.fsTick ? {} : { fsTick }
        return { messages: { ...s.messages, [sid]: upsertMessage(list, e.message) }, fsTick }
      })
      break
    }
    case 'compaction':
      set((s) => ({
        compactions: {
          ...s.compactions,
          [e.sessionId]: e.state
            ? {
                state: e.state,
                text:
                  e.text ?? (e.state === 'running' ? (s.compactions[e.sessionId]?.text ?? '') : '')
              }
            : undefined
        }
      }))
      break
    case 'message-deleted':
      set((s) => {
        const list = s.messages[e.sessionId]
        if (!list) return {}
        return {
          messages: { ...s.messages, [e.sessionId]: list.filter((m) => m.id !== e.messageId) }
        }
      })
      break
    case 'draft':
      set((s) => ({ drafts: { ...s.drafts, [e.sessionId]: e.draft } }))
      break
    case 'tool-running':
      set((s) => {
        const runs = { ...(s.toolRuns[e.sessionId] ?? {}) }
        if (e.running)
          runs[e.toolCallId] = { running: true, output: e.output ?? runs[e.toolCallId]?.output }
        else delete runs[e.toolCallId]
        return { toolRuns: { ...s.toolRuns, [e.sessionId]: runs } }
      })
      break
    case 'queue-updated':
      set((s) => ({ queues: { ...s.queues, [e.sessionId]: e.queue } }))
      break
    case 'approval-requested':
      set((s) => ({
        approvals: [...s.approvals.filter((a) => a.id !== e.request.id), e.request]
      }))
      break
    case 'approval-resolved':
      set((s) => ({ approvals: s.approvals.filter((a) => a.id !== e.id) }))
      break
    case 'chat-updated':
      set((s) => {
        const chat = withPending(e.chat)
        const exists = s.chats.some((c) => c.id === chat.id)
        return {
          chats: sortChats(
            exists ? s.chats.map((c) => (c.id === chat.id ? chat : c)) : [chat, ...s.chats]
          )
        }
      })
      break
    case 'error':
      set((s) => ({ errors: { ...s.errors, [e.sessionId]: e.error } }))
      break
  }
}

// ---- Seletores ----

const EMPTY_MESSAGES: StoredMessage[] = []
const EMPTY_QUEUE: QueuedMessage[] = []
const EMPTY_RUNS: Record<string, ToolRun> = {}

export const selectMessages =
  (sessionId: string) =>
  (s: Store): StoredMessage[] =>
    s.messages[sessionId] ?? EMPTY_MESSAGES
export const selectQueue =
  (sessionId: string) =>
  (s: Store): QueuedMessage[] =>
    s.queues[sessionId] ?? EMPTY_QUEUE
export const selectRuns =
  (sessionId: string) =>
  (s: Store): Record<string, ToolRun> =>
    s.toolRuns[sessionId] ?? EMPTY_RUNS

export const isBusy = (status: Session['status'] | undefined): boolean =>
  status === 'running' || status === 'awaiting_approval'

export const currentChat = (s: Store): Chat | undefined =>
  s.view.kind === 'chat'
    ? s.chats.find((c) => c.id === (s.view as { chatId: string }).chatId)
    : undefined
