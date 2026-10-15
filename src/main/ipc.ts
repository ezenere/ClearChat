// Registro dos handlers IPC (ipcMain.handle) — um para cada canal em `IPC` (src/shared/ipc.ts).
// Handlers recebem os argumentos posicionais na mesma ordem da API do preload.
import { BrowserWindow, dialog, ipcMain } from 'electron'
import {
  ALL_CHANNELS,
  IPC,
  type AppCapabilities,
  type ApprovalDecision,
  type AttachmentAddInput,
  type AttachmentPickResult,
  type CompactOptions,
  type ChatCreateInput,
  type ChatUpdateInput,
  type ProviderInput,
  type ProviderPatch,
  type ProviderTestInput
} from '@shared/ipc'
import type { ApiMessage, AttachmentInfo, Chat } from '@shared/types'
import { emit } from './events'
import { chatsRepo, messagesRepo, providersRepo, sessionsRepo, settingsRepo } from './repo'
import { invalidateModels, listModels, testProvider } from './providers'
import * as fsapi from './fsapi'
import * as runner from './agent/runner'
import { bwrapAvailable } from './tools/bash'
import { ripgrepAvailable } from './tools/search'
import { readFile as readFileAsync, stat } from 'fs/promises'
import { basename } from 'path'
import { ATTACHMENT_LIMITS } from '@shared/limits'
import { formatSize } from '@shared/attachments'
import { saveAttachment } from './attachments'

type Handler = (...args: never[]) => unknown

function validateMessage(m: unknown): ApiMessage {
  if (!m || typeof m !== 'object') throw new Error('Mensagem inválida.')
  const msg = m as ApiMessage
  if (!['system', 'user', 'assistant', 'tool'].includes(msg.role)) throw new Error('role inválido.')
  if (msg.role === 'tool' && typeof msg.tool_call_id !== 'string')
    throw new Error('tool_call_id ausente.')
  return msg
}

export function registerIpc(): void {
  const handlers: Record<string, Handler> = {
    // ---- providers ----
    [IPC.providers.list]: () => providersRepo.list(),
    [IPC.providers.create]: (p: ProviderInput) => providersRepo.create(p),
    [IPC.providers.update]: (id: string, patch: ProviderPatch) => {
      invalidateModels(id)
      return providersRepo.update(id, patch ?? {})
    },
    [IPC.providers.delete]: (id: string) => {
      invalidateModels(id)
      providersRepo.delete(id)
    },
    [IPC.providers.listModels]: async (providerId: string) => {
      const p = providersRepo.get(providerId)
      if (!p) throw new Error('Provider não encontrado.')
      return listModels(p)
    },
    [IPC.providers.test]: (p: ProviderTestInput) => testProvider(p),

    // ---- settings ----
    [IPC.settings.get]: (key: string) => settingsRepo.get(key),
    [IPC.settings.set]: (key: string, value: unknown) => settingsRepo.set(key, value),

    // ---- chats ----
    [IPC.chats.list]: () => chatsRepo.list(),
    [IPC.chats.get]: (id: string) => chatsRepo.get(id),
    [IPC.chats.create]: (input: ChatCreateInput) => {
      const { chat, session } = chatsRepo.create(input ?? {})
      emit({ type: 'session-created', session })
      emit({ type: 'chat-updated', chat })
      return chat
    },
    [IPC.chats.update]: (id: string, patch: ChatUpdateInput): Chat => {
      const { chat, modelChanged } = chatsRepo.update(id, patch ?? {})
      if (modelChanged && chat.mainSessionId) {
        const s = sessionsRepo.setModel(chat.mainSessionId, chat.config.model)
        if (s) emit({ type: 'session-updated', session: s })
      }
      emit({ type: 'chat-updated', chat })
      return chat
    },
    [IPC.chats.delete]: async (id: string) => {
      await runner.stopChat(id)
      chatsRepo.delete(id)
    },

    // ---- sessions ----
    [IPC.sessions.list]: (chatId: string) => sessionsRepo.list(chatId),
    [IPC.sessions.messages]: (sessionId: string) => messagesRepo.list(sessionId),

    // ---- messages ----
    [IPC.messages.update]: (id: string, message: ApiMessage) => {
      const m = messagesRepo.update(id, validateMessage(message))
      emit({ type: 'message-updated', message: m })
      return m
    },
    [IPC.messages.delete]: (id: string) => runner.deleteMessage(id),

    // ---- agent ----
    [IPC.agent.send]: (sessionId: string, text: string, attachments?: AttachmentInfo[]) =>
      runner.send(sessionId, text, attachments),
    [IPC.agent.forceSend]: (queuedId: string) => runner.forceSend(queuedId),
    [IPC.agent.removeQueued]: (queuedId: string) => runner.removeQueued(queuedId),
    [IPC.agent.getQueue]: (sessionId: string) => runner.getQueue(sessionId),
    [IPC.agent.stop]: (sessionId: string) => runner.stop(sessionId),
    [IPC.agent.regenerate]: (sessionId: string) => runner.regenerate(sessionId),
    [IPC.agent.approve]: (requestId: string, decision: ApprovalDecision) =>
      runner.approve(requestId, decision),
    [IPC.agent.pendingApprovals]: () => runner.pendingApprovals(),
    [IPC.agent.previewRequest]: (sessionId: string) => runner.previewRequest(sessionId),
    [IPC.agent.runningSessions]: () => runner.runningSessions(),
    [IPC.agent.compact]: (sessionId: string, opts?: CompactOptions) =>
      runner.compact(sessionId, opts ?? {}),

    // ---- fs ----
    [IPC.fs.listDir]: (path: string) => fsapi.listDir(path),
    [IPC.fs.readFile]: (path: string) => fsapi.readFile(path),
    [IPC.fs.pickDirectory]: async () => {
      const win = BrowserWindow.getFocusedWindow()
      const opts: Electron.OpenDialogOptions = {
        title: 'Escolher diretório raiz',
        properties: ['openDirectory', 'createDirectory']
      }
      const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
      return r.canceled || !r.filePaths[0] ? null : r.filePaths[0]
    },
    [IPC.fs.homeDir]: () => fsapi.homeDir(),
    [IPC.fs.mkdir]: (path: string) => fsapi.mkdir(path),

    // ---- anexos ----
    [IPC.attachments.pick]: async (): Promise<AttachmentPickResult> => {
      const win = BrowserWindow.getFocusedWindow()
      const opts: Electron.OpenDialogOptions = {
        title: 'Anexar arquivos',
        properties: ['openFile', 'multiSelections']
      }
      const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
      const out: AttachmentPickResult = { items: [], errors: [] }
      if (r.canceled) return out
      for (const path of r.filePaths) {
        const name = basename(path)
        try {
          const st = await stat(path)
          if (!st.isFile()) throw new Error(`"${name}" não é um arquivo.`)
          if (st.size > ATTACHMENT_LIMITS.maxFileBytes)
            throw new Error(
              `"${name}" tem ${formatSize(st.size)} — o limite por arquivo é ${formatSize(ATTACHMENT_LIMITS.maxFileBytes)}.`
            )
          out.items.push(saveAttachment({ name, data: await readFileAsync(path) }))
        } catch (e) {
          out.errors.push((e as Error).message)
        }
      }
      return out
    },
    [IPC.attachments.add]: (input: AttachmentAddInput) => {
      if (!input || !(input.data instanceof Uint8Array)) throw new Error('Arquivo inválido.')
      return saveAttachment(input)
    },

    // ---- app ----
    [IPC.app.capabilities]: (): AppCapabilities => ({
      bwrap: bwrapAvailable(),
      ripgrep: ripgrepAvailable()
    })
  }

  const missing = ALL_CHANNELS.filter((c) => !handlers[c])
  if (missing.length) throw new Error(`[clearchat] canais IPC sem handler: ${missing.join(', ')}`)

  for (const [channel, fn] of Object.entries(handlers)) {
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, (_e, ...args: unknown[]) =>
      (fn as (...a: unknown[]) => unknown)(...args)
    )
  }
}
