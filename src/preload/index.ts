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
    send: (sessionId, text) => invoke(IPC.agent.send, sessionId, text),
    forceSend: (queuedId) => invoke(IPC.agent.forceSend, queuedId),
    removeQueued: (queuedId) => invoke(IPC.agent.removeQueued, queuedId),
    getQueue: (sessionId) => invoke(IPC.agent.getQueue, sessionId),
    stop: (sessionId) => invoke(IPC.agent.stop, sessionId),
    regenerate: (sessionId) => invoke(IPC.agent.regenerate, sessionId),
    approve: (requestId, decision) => invoke(IPC.agent.approve, requestId, decision),
    pendingApprovals: () => invoke(IPC.agent.pendingApprovals),
    previewRequest: (sessionId) => invoke(IPC.agent.previewRequest, sessionId),
    runningSessions: () => invoke(IPC.agent.runningSessions),
    compact: (sessionId, opts) => invoke(IPC.agent.compact, sessionId, opts)
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
  onEvent: (cb) => {
    const listener = (_e: IpcRendererEvent, event: AgentEvent): void => cb(event)
    ipcRenderer.on(EVENT_CHANNEL, listener)
    return () => {
      ipcRenderer.removeListener(EVENT_CHANNEL, listener)
    }
  }
}

contextBridge.exposeInMainWorld('api', api)
