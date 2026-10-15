import { create } from 'zustand'
import type {
  AgentEvent,
  ApprovalRequest,
  AttachmentInfo,
  Chat,
  ChatConfig,
  ModelInfo,
  Preset,
  ProcessInfo,
  Provider,
  QueuedMessage,
  QuestionAnswer,
  QuestionRequest,
  Session,
  StoredMessage,
  StreamDraft
} from '@shared/types'
import type { AppCapabilities, ApprovalDecision, PresetInput } from '@shared/ipc'
import { api, errorMessage } from '../lib/api'
import { ATTACHMENT_LIMITS } from '@shared/limits'
import { contentText, formatSize } from '@shared/attachments'
import { setToolShellInfo } from '@shared/shellInfo'

export type View = { kind: 'new' } | { kind: 'chat'; chatId: string; sessionId: string }

export interface AppSettings {
  defaultProviderId: string | null
  defaultModel: string | null
  defaultSystemPrompt: string | null
  defaultCwd: string | null
  /** Persona selecionada por padrão no Novo chat. */
  defaultPresetId: string | null
}

export interface ToolRun {
  running: boolean
  output?: string
  /** Smart-Approve avaliando a chamada. */
  judging?: boolean
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

export type SettingsTab = 'providers' | 'presets' | 'defaults'

export type PanelTab = 'model' | 'chat' | 'tools' | 'files'

const PANEL_TABS: PanelTab[] = ['model', 'chat', 'tools', 'files']
const PANEL_TAB_KEY = 'clearchat.panelTab'

/** Seção do painel → aba onde ela mora (focusConfig). */
const SECTION_TAB: Record<string, PanelTab> = { contexto: 'chat' }

function loadPanelTab(): PanelTab {
  try {
    const v = localStorage.getItem(PANEL_TAB_KEY) as PanelTab | null
    return v && PANEL_TABS.includes(v) ? v : 'model'
  } catch {
    return 'model'
  }
}

function savePanelTab(tab: PanelTab): void {
  try {
    localStorage.setItem(PANEL_TAB_KEY, tab)
  } catch {
    /* armazenamento indisponível: só não lembra */
  }
}

/** Anexo no composer: carregando (indo para o store do main) ou pronto para enviar. */
export interface PendingAttachment {
  id: string
  name: string
  size: number
  status: 'loading' | 'ready'
  info?: AttachmentInfo
}

/** Compactação em andamento/agendada por sessão (evento `compaction`). */
export interface CompactionState {
  state: 'scheduled' | 'running'
  text: string
}

interface State {
  booted: boolean
  providers: Provider[]
  chats: Chat[]
  /** Personas (presets de chat). */
  presets: Preset[]
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
  /** Questionários pendentes (ask_user). */
  questions: QuestionRequest[]
  errors: Record<string, string | undefined>
  models: Record<string, ModelsEntry>
  panelOpen: boolean
  panelTab: PanelTab
  settingsOpen: boolean
  settingsTab: SettingsTab
  previewSessionId: string | null
  toasts: Toast[]
  compactions: Record<string, CompactionState | undefined>
  /** Incrementado a cada resultado de tool num chat (aba Arquivos recarrega). */
  fsTick: Record<string, number>
  capabilities: AppCapabilities
  /** Seção do painel Config para rolar até (ex.: 'contexto'). */
  configFocus: string | null
  /** Anexos ainda não enviados, por sessão (composer). */
  pendingAttachments: Record<string, PendingAttachment[]>
  /** Processos em segundo plano (process_start) por chat (evento `processes-updated`). */
  processes: Record<string, ProcessInfo[]>
}

interface Actions {
  boot(): Promise<void>
  refreshProviders(): Promise<void>
  refreshPresets(): Promise<void>
  /** Cria (sem id) ou atualiza uma persona; retorna a persona salva (ou null em erro). */
  savePreset(input: PresetInput, id?: string): Promise<Preset | null>
  deletePreset(id: string): Promise<void>
  duplicatePreset(id: string): Promise<Preset | null>
  setSetting<K extends keyof AppSettings>(key: K, value: AppSettings[K]): Promise<void>
  /** Várias de uma vez (ex.: o par defaultProviderId + defaultModel). */
  setSettings(patch: Partial<AppSettings>): Promise<void>
  goNew(): void
  openChat(chatId: string, sessionId?: string): Promise<void>
  openSession(sessionId: string): Promise<void>
  loadMessages(sessionId: string, force?: boolean): Promise<void>
  createChat(input: { title?: string; config: Partial<ChatConfig> }): Promise<Chat | null>
  renameChat(chatId: string, title: string): Promise<void>
  deleteChat(chatId: string): Promise<void>
  patchConfig(chatId: string, patch: Partial<ChatConfig>): void
  flushConfig(chatId: string): Promise<void>
  send(sessionId: string, text: string, attachments?: AttachmentInfo[]): Promise<boolean>
  /** Anexa arquivos (arrastar/colar) ao composer da sessão. */
  addFiles(sessionId: string, files: File[]): Promise<void>
  /** Seletor nativo de arquivos (main lê e salva). */
  pickFiles(sessionId: string): Promise<void>
  removeAttachment(sessionId: string, id: string): void
  clearAttachments(sessionId: string): void
  approve(id: string, decision: ApprovalDecision): Promise<void>
  /** Envia as respostas do questionário; false se falhou (o formulário continua). */
  answerQuestion(id: string, answers: QuestionAnswer[]): Promise<boolean>
  /** Cancela o questionário (o agente para). */
  cancelQuestion(id: string): Promise<void>
  loadModels(providerId: string, force?: boolean): Promise<void>
  setPanel(open: boolean, tab?: PanelTab): void
  setSettingsOpen(open: boolean, tab?: SettingsTab): void
  setPreview(sessionId: string | null): void
  toast(text: string, kind?: Toast['kind']): void
  dismissToast(id: number): void
  dismissError(sessionId: string): void
  /** Compactar a conversa (idle → já; rodando → agenda). */
  compact(sessionId: string, retry?: boolean): Promise<void>
  focusConfig(section: string | null): void
  /** Recarrega os processos em segundo plano do chat. */
  loadProcesses(chatId: string): Promise<void>
  stopProcess(chatId: string, id: string): Promise<void>
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
let attachmentSeq = 0
let unsubscribe: (() => void) | null = null

const SETTINGS_KEYS: (keyof AppSettings)[] = [
  'defaultProviderId',
  'defaultModel',
  'defaultSystemPrompt',
  'defaultCwd',
  'defaultPresetId'
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
  presets: [],
  settings: {
    defaultProviderId: null,
    defaultModel: null,
    defaultSystemPrompt: null,
    defaultCwd: null,
    defaultPresetId: null
  },
  homeDir: null,
  view: { kind: 'new' },
  sessions: {},
  messages: {},
  drafts: {},
  toolRuns: {},
  queues: {},
  approvals: [],
  questions: [],
  errors: {},
  models: {},
  panelOpen: true,
  panelTab: loadPanelTab(),
  settingsOpen: false,
  settingsTab: 'providers',
  previewSessionId: null,
  toasts: [],
  compactions: {},
  fsTick: {},
  capabilities: { bwrap: false, ripgrep: false },
  configFocus: null,
  pendingAttachments: {},
  processes: {},

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
    const [providers, chats, presets, homeDir, approvals, questions, capabilities, ...values] =
      await Promise.all([
        safe(() => api.providers.list(), [] as Provider[]),
        safe(() => api.chats.list(), [] as Chat[]),
        safe(() => api.presets.list(), [] as Preset[]),
        safe(() => api.fs.homeDir(), null as string | null),
        safe(() => api.agent.pendingApprovals(), [] as ApprovalRequest[]),
        safe(() => api.questions.pending(), [] as QuestionRequest[]),
        safe(() => api.app.capabilities(), { bwrap: false, ripgrep: false } as AppCapabilities),
        ...SETTINGS_KEYS.map((k) => safe(() => api.settings.get<string>(k), null))
      ])
    const settings = Object.fromEntries(
      SETTINGS_KEYS.map((k, i) => [k, values[i] ?? null])
    ) as unknown as AppSettings
    // descrição da tool `shell` com o shell detectado no main (mesmo texto da request)
    setToolShellInfo(capabilities.shell ?? null)
    set({
      providers,
      chats: sortChats(chats),
      presets,
      homeDir,
      approvals,
      questions,
      capabilities,
      settings,
      booted: true
    })
  },

  async refreshProviders() {
    const providers = await get().run(() => api.providers.list(), 'Erro ao carregar provedores')
    if (providers) set({ providers })
  },

  async refreshPresets() {
    const presets = await get().run(() => api.presets.list(), 'Erro ao carregar personas')
    if (presets) set({ presets })
  },

  async savePreset(input, id) {
    const preset = await get().run(
      () => (id ? api.presets.update(id, input) : api.presets.create(input)),
      'Erro ao salvar persona'
    )
    if (!preset) return null
    set((s) => ({
      presets: s.presets.some((p) => p.id === preset.id)
        ? s.presets.map((p) => (p.id === preset.id ? preset : p))
        : [...s.presets, preset]
    }))
    return preset
  },

  async deletePreset(id) {
    const ok = await get().run(async () => {
      await api.presets.delete(id)
      return true
    }, 'Erro ao apagar persona')
    if (!ok) return
    set((s) => ({
      presets: s.presets.filter((p) => p.id !== id),
      settings:
        s.settings.defaultPresetId === id ? { ...s.settings, defaultPresetId: null } : s.settings
    }))
  },

  async duplicatePreset(id) {
    const preset = await get().run(() => api.presets.duplicate(id), 'Erro ao duplicar persona')
    if (preset) set((s) => ({ presets: [...s.presets, preset] }))
    return preset ?? null
  },

  async setSetting(key, value) {
    set((s) => ({ settings: { ...s.settings, [key]: value } }))
    await get().run(() => api.settings.set(key, value), 'Erro ao salvar configuração')
  },

  async setSettings(patch) {
    set((s) => ({ settings: { ...s.settings, ...patch } }))
    await get().run(
      () => Promise.all(Object.entries(patch).map(([k, v]) => api.settings.set(k, v))),
      'Erro ao salvar configuração'
    )
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
    void get().loadProcesses(chatId)
    await get().loadMessages(target)
  },

  async loadProcesses(chatId) {
    try {
      const list = await api.processes.list(chatId)
      set((s) => ({ processes: { ...s.processes, [chatId]: list } }))
    } catch {
      /* sem processos */
    }
  },

  async stopProcess(chatId, id) {
    await get().run(() => api.processes.stop(chatId, id), 'Erro ao parar o processo')
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
        questions: s.questions.filter((q) => q.chatId !== chatId),
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

  async send(sessionId, text, attachments) {
    const session = get().sessions[sessionId]
    if (session) await get().flushConfig(session.chatId)
    set((s) => ({ errors: { ...s.errors, [sessionId]: undefined } }))
    const res = await get().run(
      () =>
        attachments?.length
          ? api.agent.send(sessionId, text, attachments)
          : api.agent.send(sessionId, text),
      'Falha ao enviar'
    )
    return res !== undefined
  },

  async addFiles(sessionId, files) {
    const setList = (fn: (l: PendingAttachment[]) => PendingAttachment[]): void =>
      set((s) => ({
        pendingAttachments: {
          ...s.pendingAttachments,
          [sessionId]: fn(s.pendingAttachments[sessionId] ?? [])
        }
      }))
    for (const file of files) {
      const count = get().pendingAttachments[sessionId]?.length ?? 0
      if (count >= ATTACHMENT_LIMITS.maxFiles) {
        get().toast(`No máximo ${ATTACHMENT_LIMITS.maxFiles} anexos por mensagem.`, 'error')
        return
      }
      if (file.size > ATTACHMENT_LIMITS.maxFileBytes) {
        get().toast(
          `"${file.name}" tem ${formatSize(file.size)} — o limite por arquivo é ${formatSize(ATTACHMENT_LIMITS.maxFileBytes)}.`,
          'error'
        )
        continue
      }
      const id = `att-${++attachmentSeq}`
      setList((l) => [...l, { id, name: file.name, size: file.size, status: 'loading' }])
      try {
        const data = new Uint8Array(await file.arrayBuffer())
        const info = await api.attachments.add({ name: file.name, mime: file.type, data })
        setList((l) => l.map((a) => (a.id === id ? { ...a, status: 'ready', info } : a)))
      } catch (err) {
        setList((l) => l.filter((a) => a.id !== id))
        get().toast(errorMessage(err), 'error')
      }
    }
  },

  async pickFiles(sessionId) {
    const r = await get().run(() => api.attachments.pick(), 'Falha ao anexar')
    if (!r) return
    for (const e of r.errors) get().toast(e, 'error')
    if (!r.items.length) return
    set((s) => {
      const cur = s.pendingAttachments[sessionId] ?? []
      const room = Math.max(0, ATTACHMENT_LIMITS.maxFiles - cur.length)
      if (r.items.length > room)
        setTimeout(() =>
          get().toast(`No máximo ${ATTACHMENT_LIMITS.maxFiles} anexos por mensagem.`, 'error')
        )
      const added = r.items.slice(0, room).map((info): PendingAttachment => ({
        id: `att-${++attachmentSeq}`,
        name: info.name,
        size: info.size,
        status: 'ready',
        info
      }))
      return { pendingAttachments: { ...s.pendingAttachments, [sessionId]: [...cur, ...added] } }
    })
  },

  removeAttachment(sessionId, id) {
    set((s) => ({
      pendingAttachments: {
        ...s.pendingAttachments,
        [sessionId]: (s.pendingAttachments[sessionId] ?? []).filter((a) => a.id !== id)
      }
    }))
  },

  clearAttachments(sessionId) {
    set((s) => ({ pendingAttachments: { ...s.pendingAttachments, [sessionId]: [] } }))
  },

  async approve(id, decision) {
    set((s) => ({ approvals: s.approvals.filter((a) => a.id !== id) }))
    await get().run(() => api.agent.approve(id, decision), 'Falha ao responder aprovação')
  },

  async answerQuestion(id, answers) {
    const ok = await get().run(async () => {
      await api.questions.answer(id, answers)
      return true
    }, 'Falha ao enviar as respostas')
    if (ok) set((s) => ({ questions: s.questions.filter((q) => q.id !== id) }))
    return !!ok
  },

  async cancelQuestion(id) {
    await get().run(() => api.questions.cancel(id), 'Falha ao cancelar o questionário')
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
    if (tab) savePanelTab(tab)
    set((s) => ({ panelOpen: open, panelTab: tab ?? s.panelTab }))
  },
  setSettingsOpen(open, tab) {
    set((s) => ({ settingsOpen: open, settingsTab: tab ?? s.settingsTab }))
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
    if (!section) return set({ configFocus: null })
    const panelTab = SECTION_TAB[section] ?? 'model'
    savePanelTab(panelTab)
    set({ configFocus: section, panelOpen: true, panelTab })
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
          questions: s.questions.filter((q) => q.sessionId !== e.sessionId),
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
            (m.role === 'user' && contentText(m.content).startsWith('<tool_result')))
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
        if (e.running && e.judging) runs[e.toolCallId] = { running: false, judging: true }
        else if (e.running)
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
    case 'question-requested':
      set((s) => ({
        questions: [...s.questions.filter((q) => q.id !== e.request.id), e.request]
      }))
      break
    case 'question-resolved':
      set((s) => ({ questions: s.questions.filter((q) => q.id !== e.id) }))
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
    case 'processes-updated':
      set((s) => ({ processes: { ...s.processes, [e.chatId]: e.processes } }))
      break
  }
}

// ---- Seletores ----

const EMPTY_MESSAGES: StoredMessage[] = []
const EMPTY_QUEUE: QueuedMessage[] = []
const EMPTY_RUNS: Record<string, ToolRun> = {}
const EMPTY_ATTACHMENTS: PendingAttachment[] = []

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

export const selectPendingAttachments =
  (sessionId: string) =>
  (s: Store): PendingAttachment[] =>
    s.pendingAttachments[sessionId] ?? EMPTY_ATTACHMENTS

export const isBusy = (status: Session['status'] | undefined): boolean =>
  status === 'running' ||
  status === 'awaiting_approval' ||
  status === 'awaiting_input' ||
  status === 'waiting'

export const currentChat = (s: Store): Chat | undefined =>
  s.view.kind === 'chat'
    ? s.chats.find((c) => c.id === (s.view as { chatId: string }).chatId)
    : undefined

const EMPTY_PROCESSES: ProcessInfo[] = []
export const selectProcesses =
  (chatId: string) =>
  (s: Store): ProcessInfo[] =>
    s.processes[chatId] ?? EMPTY_PROCESSES
