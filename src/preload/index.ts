import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { EVENT_CHANNEL, IPC, type ClearApi } from '@shared/ipc'
import type { AgentEvent } from '@shared/types'

const invoke = ipcRenderer.invoke.bind(ipcRenderer)

const api: ClearApi = {
  providers: {
    list: () => invoke(IPC.providers.list),
    create: (p) => invoke(IPC.providers.create, p),
    update: (id, patch) => invoke(IPC.providers.update, id, patch),
    delete: (id) => invoke(IPC.providers.delete, id),
    listModels: (providerId) => invoke(IPC.providers.listModels, providerId),
    test: (p) => invoke(IPC.providers.test, p)
  },
  settings: {
    get: (key) => invoke(IPC.settings.get, key),
    set: (key, value) => invoke(IPC.settings.set, key, value)
  },
  chats: {
    list: () => invoke(IPC.chats.list),
    get: (id) => invoke(IPC.chats.get, id),
    create: (input) => invoke(IPC.chats.create, input),
    update: (id, patch) => invoke(IPC.chats.update, id, patch),
    delete: (id) => invoke(IPC.chats.delete, id)
  },
  sessions: {
    list: (chatId) => invoke(IPC.sessions.list, chatId),
    messages: (sessionId) => invoke(IPC.sessions.messages, sessionId)
  },
  messages: {
    update: (id, message) => invoke(IPC.messages.update, id, message),
    delete: (id) => invoke(IPC.messages.delete, id)
  },
  agent: {
    send: (sessionId, text, attachments, skills) =>
      invoke(IPC.agent.send, sessionId, text, attachments, skills),
    forceSend: (queuedId) => invoke(IPC.agent.forceSend, queuedId),
    removeQueued: (queuedId) => invoke(IPC.agent.removeQueued, queuedId),
    getQueue: (sessionId) => invoke(IPC.agent.getQueue, sessionId),
    stop: (sessionId) => invoke(IPC.agent.stop, sessionId),
    regenerate: (sessionId) => invoke(IPC.agent.regenerate, sessionId),
    approve: (requestId, decision, items) => invoke(IPC.agent.approve, requestId, decision, items),
    pendingApprovals: () => invoke(IPC.agent.pendingApprovals),
    previewRequest: (sessionId) => invoke(IPC.agent.previewRequest, sessionId),
    runningSessions: () => invoke(IPC.agent.runningSessions),
    compact: (sessionId, opts) => invoke(IPC.agent.compact, sessionId, opts),
    stopSubagents: (chatId) => invoke(IPC.agent.stopSubagents, chatId),
    smartOverride: (messageId) => invoke(IPC.agent.smartOverride, messageId),
    smartApproveTest: (input) => invoke(IPC.agent.smartApproveTest, input)
  },
  fs: {
    listDir: (path) => invoke(IPC.fs.listDir, path),
    readFile: (path) => invoke(IPC.fs.readFile, path),
    pickDirectory: () => invoke(IPC.fs.pickDirectory),
    homeDir: () => invoke(IPC.fs.homeDir),
    mkdir: (path) => invoke(IPC.fs.mkdir, path)
  },
  app: {
    capabilities: () => invoke(IPC.app.capabilities)
  },
  memory: {
    listCollections: () => invoke(IPC.memory.listCollections),
    createCollection: (input) => invoke(IPC.memory.createCollection, input),
    updateCollection: (id, patch) => invoke(IPC.memory.updateCollection, id, patch),
    deleteCollection: (id) => invoke(IPC.memory.deleteCollection, id),
    list: (query) => invoke(IPC.memory.list, query),
    create: (input) => invoke(IPC.memory.create, input),
    update: (id, patch) => invoke(IPC.memory.update, id, patch),
    delete: (id) => invoke(IPC.memory.delete, id),
    preview: (sessionId) => invoke(IPC.memory.preview, sessionId),
    refreshSnapshot: (sessionId) => invoke(IPC.memory.refreshSnapshot, sessionId),
    extractNow: (sessionId) => invoke(IPC.memory.extractNow, sessionId)
  },
  skills: {
    getSettings: () => invoke(IPC.skills.getSettings),
    updateSettings: (patch) => invoke(IPC.skills.updateSettings, patch),
    discover: (opts) => invoke(IPC.skills.discover, opts),
    read: (file) => invoke(IPC.skills.read, file),
    pickFolder: () => invoke(IPC.skills.pickFolder),
    openFolder: (path) => invoke(IPC.skills.openFolder, path)
  },
  presets: {
    list: () => invoke(IPC.presets.list),
    create: (input) => invoke(IPC.presets.create, input),
    update: (id, patch) => invoke(IPC.presets.update, id, patch),
    delete: (id) => invoke(IPC.presets.delete, id),
    duplicate: (id) => invoke(IPC.presets.duplicate, id)
  },
  attachments: {
    pick: () => invoke(IPC.attachments.pick),
    add: (input) => invoke(IPC.attachments.add, input)
  },
  questions: {
    answer: (id, answers) => invoke(IPC.questions.answer, id, answers),
    cancel: (id) => invoke(IPC.questions.cancel, id),
    pending: () => invoke(IPC.questions.pending)
  },
  retries: {
    retry: (id) => invoke(IPC.retries.retry, id),
    cancel: (id) => invoke(IPC.retries.cancel, id),
    pending: () => invoke(IPC.retries.pending)
  },
  processes: {
    list: (chatId) => invoke(IPC.processes.list, chatId),
    stop: (chatId, id) => invoke(IPC.processes.stop, chatId, id),
    logs: (chatId, id, tail) => invoke(IPC.processes.logs, chatId, id, tail)
  },
  approvals: {
    getSettings: () => invoke(IPC.approvals.getSettings),
    updateSettings: (patch) => invoke(IPC.approvals.updateSettings, patch)
  },
  webSearch: {
    getSettings: () => invoke(IPC.webSearch.getSettings),
    updateEngines: (engines) => invoke(IPC.webSearch.updateEngines, engines),
    setKey: (engine, key) => invoke(IPC.webSearch.setKey, engine, key),
    revealKey: (engine) => invoke(IPC.webSearch.revealKey, engine),
    test: (engine) => invoke(IPC.webSearch.test, engine)
  },
  onEvent: (cb) => {
    const listener = (_e: IpcRendererEvent, event: AgentEvent): void => cb(event)
    ipcRenderer.on(EVENT_CHANNEL, listener)
    return () => {
      ipcRenderer.removeListener(EVENT_CHANNEL, listener)
    }
  }
}

contextBridge.exposeInMainWorld('api', api)
