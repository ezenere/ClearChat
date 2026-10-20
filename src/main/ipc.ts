// Registro dos handlers IPC (ipcMain.handle) — um para cada canal em `IPC` (src/shared/ipc.ts).
// Handlers recebem os argumentos posicionais na mesma ordem da API do preload.
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
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
  type PresetInput,
  type PresetPatch,
  type ProviderInput,
  type ProviderPatch,
  type ProviderTestInput,
  type SmartApproveTestInput
} from '@shared/ipc'
import type { ApiMessage, AttachmentInfo, Chat, QuestionAnswer } from '@shared/types'
import {
  chatOfMessage,
  chatOfSession,
  gateById,
  gateChat,
  gatedSend,
  syncEngine,
  syncHandlers
} from './sync'
import { emit } from './events'
import { isBranchEditable, pruneSel, selectionToReach } from '@shared/branches'
import {
  chatsRepo,
  messagesRepo,
  presetsRepo,
  providersRepo,
  sessionsRepo,
  settingsRepo
} from './repo'
import { invalidateModels, listModels, testProvider } from './providers'
import * as fsapi from './fsapi'
import {
  checkPresented,
  grantedPath,
  openViewerFile,
  readViewerText,
  viewerDevice,
  type ViewerDeps
} from './fileViewer'
import type { ViewerTarget } from '@shared/ipc'
import { checkedBytes, writeViewerTemp } from './viewerTemp'
import {
  assertCanOpenLocal,
  chmodX,
  runGrantedFile,
  runRemoteBytes,
  spawnDetached,
  whichSync,
  type RunDeps
} from './fileRun'
import { safeFileName } from '@shared/remoteFs'
import * as runner from './agent/runner'
import * as memory from './memory'
import { answerQuestion } from './agent/questions'
import { bwrapAvailable } from './tools/bash'
import { listProcesses, processLogLines, stopChatProcesses, stopProcess } from './tools/processes'
import { removeChatToolOutputs } from './tools/toolOutputs'
import { shellInfoLite } from './tools/shellEnv'
import { ripgrepAvailable } from './tools/search'
import { readFile as readFileAsync, stat, writeFile as writeFileAsync } from 'fs/promises'
import { basename, join } from 'path'
import { ATTACHMENT_LIMITS } from '@shared/limits'
import { formatSize } from '@shared/attachments'
import { saveAttachment } from './attachments'
import { getApprovalSettings, updateApprovalSettings } from './approvalSettings'
import type { ApprovalItemDecision } from '@shared/approvalPolicy'
import type { ApprovalSettings } from '@shared/types'
import {
  PROTECTED_SETTINGS,
  type EngineConfig,
  type SearchEngineId
} from '@shared/webSearchSettings'
import {
  getWebSearchSettings,
  revealWebSearchKey,
  setWebSearchKey,
  updateWebSearchEngines
} from './webSearchConfig'
import { testWebSearchEngine } from './tools/web'
import * as skills from './skills'
import { updateChecker } from './updates'
import { isReleaseUrl, RELEASES_PAGE, type UpdateStatus } from '@shared/updates'
import type { SkillsDiscoverOptions, SkillsSettings } from '@shared/skills'
import type {
  MemoryCollectionInput,
  MemoryCollectionPatch,
  MemoryInput,
  MemoryListQuery,
  MemoryPatch
} from '@shared/memory'

type Handler = (...args: never[]) => unknown

function validateMessage(m: unknown): ApiMessage {
  if (!m || typeof m !== 'object') throw new Error('Mensagem inválida.')
  const msg = m as ApiMessage
  if (!['system', 'user', 'assistant', 'tool'].includes(msg.role)) throw new Error('role inválido.')
  if (msg.role === 'tool' && typeof msg.tool_call_id !== 'string')
    throw new Error('tool_call_id ausente.')
  return msg
}

/** Processos rodam no host: no controle remoto a lista é só leitura (§11). */
function remoteProcessGuard(chatId: string): void {
  const e = syncEngine()
  if (e?.active && e.host.mode(chatId) === 'remote')
    throw new Error(`Os processos rodam no host (${e.host.hostName(chatId)}) — gerencie-os por lá.`)
}

/** Banco + sync para o visualizador de arquivos (fileViewer.ts é sem Electron). */
const viewerDeps: ViewerDeps = {
  chat: (id) => chatsRepo.get(id),
  message: (id) => messagesRepo.get(id),
  chatOfSession: (sid) => sessionsRepo.get(sid)?.chatId ?? null,
  localDevice: () => viewerDevice(),
  remoteHost: (chatId) => {
    const e = syncEngine()
    if (!e?.active) return null
    const mode = e.host.mode(chatId)
    return mode === 'remote' || mode === 'host-offline' ? e.host.hostName(chatId) : null
  }
}

/** "Executar…" do visualizador: diálogo nativo + processos reais (fileRun.ts é sem Electron). */
function runDeps(): RunDeps {
  return {
    platform: process.platform,
    which: (cmd) => whichSync(cmd),
    systemRoot: process.env.SystemRoot,
    confirm: async ({ message, detail }) => {
      const win = BrowserWindow.getFocusedWindow()
      const opts: Electron.MessageBoxOptions = {
        type: 'warning',
        title: 'Executar arquivo',
        message,
        detail,
        buttons: ['Cancelar', 'Executar'],
        defaultId: 0,
        cancelId: 0,
        noLink: true
      }
      const r = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts)
      return r.response === 1
    },
    openPath: (p) => shell.openPath(p),
    spawn: spawnDetached,
    chmodX,
    log: (m) => console.log(`[clearchat] executar: ${m}`)
  }
}

export function registerIpc(): void {
  presetsRepo.seed()
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
    // (as chaves de API dos buscadores não passam por aqui: só pelo domínio webSearch, mascaradas)
    [IPC.settings.get]: (key: string) => {
      if (PROTECTED_SETTINGS.includes(key)) throw new Error('Setting protegido.')
      return settingsRepo.get(key)
    },
    [IPC.settings.set]: (key: string, value: unknown) => {
      if (PROTECTED_SETTINGS.includes(key)) throw new Error('Setting protegido.')
      return settingsRepo.set(key, value)
    },

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
      // raiz escolhida neste dispositivo (chat vindo de outro): não pergunta mais ao virar host
      if (patch?.config?.cwd) syncEngine()?.setChatRow(id, { cwd_confirmed: 1 })
      if (modelChanged && chat.mainSessionId) {
        const s = sessionsRepo.setModel(chat.mainSessionId, chat.config.model)
        if (s) emit({ type: 'session-updated', session: s })
      }
      emit({ type: 'chat-updated', chat })
      return chat
    },
    [IPC.chats.delete]: async (id: string) => {
      const e = syncEngine()
      if (e?.active && e.host.mode(id) === 'remote' && e.chatInfo(id).running)
        throw new Error(
          `O chat está rodando em ${e.host.hostName(id)} — pare o turno antes de apagá-lo.`
        )
      await runner.stopChat(id)
      await stopChatProcesses(id)
      chatsRepo.delete(id)
      removeChatToolOutputs(id)
    },

    // ---- sessions ----
    [IPC.sessions.list]: (chatId: string) => sessionsRepo.list(chatId),
    [IPC.sessions.messages]: (sessionId: string) => messagesRepo.listAll(sessionId),

    // ---- messages ----
    [IPC.messages.update]: (id: string, message: ApiMessage) => {
      const msg = validateMessage(message)
      // mensagem digitada da principal: editar = nova versão (agent.editBranch), nunca no lugar
      const cur = messagesRepo.get(id)
      const owner = cur && sessionsRepo.get(cur.sessionId)
      if (cur && owner && isBranchEditable(cur, owner.depth))
        throw new Error(
          'Mensagens suas na conversa principal não são editadas no lugar: a edição vira uma nova versão (use “Editar” na mensagem).'
        )
      const local = (): ReturnType<typeof messagesRepo.update> => {
        const m = messagesRepo.update(id, msg)
        emit({ type: 'message-updated', message: m })
        return m
      }
      return gateChat(chatOfMessage(id), 'message.edit', { messageId: id, message: msg }, local, {
        purpose: 'edit',
        remote: () => ({ ...messagesRepo.get(id)!, message: msg })
      })
    },
    [IPC.messages.delete]: (id: string) =>
      gateChat(
        chatOfMessage(id),
        'message.delete',
        { messageId: id },
        () => runner.deleteMessage(id),
        {
          purpose: 'edit'
        }
      ),

    // ---- agent ----
    [IPC.agent.send]: (
      sessionId: string,
      text: string,
      attachments?: AttachmentInfo[],
      skills?: string[]
    ) => gatedSend(sessionId, text, attachments, skills),
    [IPC.agent.forceSend]: (queuedId: string) =>
      gateById(
        (e) => e.host.findQueued(queuedId)?.chatId ?? null,
        'queue.force',
        { queuedId },
        () => runner.forceSend(queuedId)
      ),
    [IPC.agent.removeQueued]: (queuedId: string) =>
      gateById(
        (e) => e.host.findQueued(queuedId)?.chatId ?? null,
        'queue.remove',
        { queuedId },
        () => runner.removeQueued(queuedId)
      ),
    [IPC.agent.getQueue]: (sessionId: string) =>
      syncEngine()?.host.mirrorQueue(sessionId) ?? runner.getQueue(sessionId),
    [IPC.agent.stop]: (sessionId: string) =>
      gateChat(chatOfSession(sessionId), 'stop', { sessionId }, () => runner.stop(sessionId), {
        content: false
      }),
    [IPC.agent.regenerate]: (sessionId: string, messageId?: string) =>
      gateChat(
        chatOfSession(sessionId),
        'branch.regenerate',
        { sessionId, ...(messageId ? { messageId } : {}) },
        () => runner.regenerate(sessionId, messageId || undefined),
        { purpose: 'run' }
      ),
    [IPC.agent.editBranch]: (messageId: string, message: ApiMessage) => {
      const msg = validateMessage(message)
      return gateChat(
        chatOfMessage(messageId),
        'branch.edit',
        { messageId, message: msg },
        () => runner.editBranch(messageId, msg),
        { purpose: 'run' }
      )
    },
    [IPC.agent.selectBranch]: (messageId: string) =>
      gateChat(
        chatOfMessage(messageId),
        'branch.select',
        { messageId },
        () => runner.selectBranch(messageId),
        {
          purpose: 'edit',
          // controle remoto: quem grava é o host; devolve a seleção esperada (o sync traz a real)
          remote: () => {
            const m = messagesRepo.get(messageId)
            const s = m && sessionsRepo.get(m.sessionId)
            if (!m || !s) throw new Error('Mensagem não encontrada.')
            const all = messagesRepo.listAll(s.id)
            return { ...s, branchSel: pruneSel(all, selectionToReach(all, s.branchSel, m.id)) }
          }
        }
      ),
    [IPC.agent.approve]: (
      requestId: string,
      decision: ApprovalDecision,
      items?: ApprovalItemDecision[]
    ) =>
      gateById(
        (e) => e.host.findApproval(requestId),
        'approval',
        { requestId, decision, ...(items?.length ? { items } : {}) },
        () => runner.approve(requestId, decision, items)
      ),
    [IPC.agent.pendingApprovals]: () => [
      ...runner.pendingApprovals(),
      ...(syncEngine()?.host.mirrorApprovals() ?? [])
    ],
    [IPC.agent.previewRequest]: (sessionId: string) => runner.previewRequest(sessionId),
    [IPC.agent.runningSessions]: () => [
      ...new Set([...runner.runningSessions(), ...(syncEngine()?.host.mirrorRunning() ?? [])])
    ],
    [IPC.agent.compact]: (sessionId: string, opts?: CompactOptions) =>
      gateChat(
        chatOfSession(sessionId),
        'compact',
        { sessionId, ...(opts ? { opts } : {}) },
        () => runner.compact(sessionId, opts ?? {}),
        { remote: (r) => ({ scheduled: !!r.queued }) }
      ),
    [IPC.agent.stopSubagents]: (chatId: string) =>
      gateChat(chatId, 'stop_subagents', {}, () => runner.stopSubagents(chatId), {
        content: false
      }),
    [IPC.agent.smartOverride]: (messageId: string) =>
      gateChat(chatOfMessage(messageId), 'smart_override', { messageId }, () =>
        runner.smartOverride(messageId)
      ),
    [IPC.agent.smartApproveTest]: (input: SmartApproveTestInput) => runner.smartApproveTest(input),

    // ---- aprovações (modos globais + listas) ----
    [IPC.approvals.getSettings]: () => getApprovalSettings(),
    [IPC.approvals.updateSettings]: (patch: Partial<ApprovalSettings>) =>
      updateApprovalSettings(patch ?? {}),

    // ---- buscadores do web_search ----
    [IPC.webSearch.getSettings]: () => getWebSearchSettings(),
    [IPC.webSearch.updateEngines]: (engines: EngineConfig[]) => updateWebSearchEngines(engines),
    [IPC.webSearch.setKey]: (engine: SearchEngineId, key: string | null) =>
      setWebSearchKey(engine, key),
    [IPC.webSearch.revealKey]: (engine: SearchEngineId) => revealWebSearchKey(engine),
    [IPC.webSearch.test]: (engine: SearchEngineId) => testWebSearchEngine(engine),

    // ---- skills (SPEC → Skills) ----
    [IPC.skills.getSettings]: () => skills.getSkillsSettings(),
    [IPC.skills.updateSettings]: (patch: Partial<SkillsSettings>) => {
      const next = skills.updateSkillsSettings(patch ?? {})
      emit({ type: 'skills-changed' })
      return next
    },
    [IPC.skills.discover]: async (opts?: SkillsDiscoverOptions) => {
      const r = await skills.discover(opts ?? {})
      if (opts?.rescan) emit({ type: 'skills-changed' })
      return r
    },
    [IPC.skills.read]: async (file: string) => {
      if (typeof file !== 'string' || basename(file) !== 'SKILL.md')
        throw new Error('Só arquivos SKILL.md.')
      return readFileAsync(file, 'utf8')
    },
    [IPC.skills.pickFolder]: async () => {
      const win = BrowserWindow.getFocusedWindow()
      const opts: Electron.OpenDialogOptions = {
        title: 'Escolher pasta de skills',
        properties: ['openDirectory', 'createDirectory', 'showHiddenFiles']
      }
      const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
      return r.canceled || !r.filePaths[0] ? null : r.filePaths[0]
    },
    [IPC.skills.openFolder]: async (path: string) => {
      const err = await shell.openPath(skills.resolveLocationPath(String(path ?? '')))
      if (err) throw new Error(err)
    },

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

    // ---- visualizador de arquivos (só a allowlist do main; ver fileViewer.ts) ----
    [IPC.viewer.open]: (target: ViewerTarget) => openViewerFile(target, viewerDeps),
    [IPC.viewer.check]: (chatId: string, messageId: string) =>
      checkPresented(chatId, messageId, viewerDeps),
    [IPC.viewer.readText]: (token: string) => readViewerText(token),
    [IPC.viewer.openExternal]: async (token: string) => {
      const file = grantedPath(token)
      // executável (deste sistema ou de outro) nunca abre direto: "Executar…" pede confirmação
      await assertCanOpenLocal(file, process.platform)
      const err = await shell.openPath(file)
      if (err) throw new Error(err)
    },
    [IPC.viewer.showInFolder]: (token: string) => shell.showItemInFolder(grantedPath(token)),
    // arquivo buscado de outro dispositivo (controle remoto): bytes vêm do renderer
    [IPC.viewer.saveBytes]: async (name: string, bytes: Uint8Array): Promise<boolean> => {
      const buf = checkedBytes(bytes)
      const win = BrowserWindow.getFocusedWindow()
      const opts: Electron.SaveDialogOptions = {
        title: 'Salvar como',
        defaultPath: join(app.getPath('downloads'), safeFileName(name))
      }
      const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
      if (r.canceled || !r.filePath) return false
      await writeFileAsync(r.filePath, buf)
      return true
    },
    [IPC.viewer.openBytes]: async (name: string, bytes: Uint8Array) => {
      const err = await shell.openPath(writeViewerTemp(name, bytes))
      if (err) throw new Error(err)
    },
    // "Executar…": o main reclassifica e confirma; só token concedido / chat em controle remoto
    [IPC.viewer.run]: (token: string) => runGrantedFile(token, runDeps()),
    [IPC.viewer.runBytes]: (chatId: string, name: string, bytes: Uint8Array) =>
      runRemoteBytes(
        name,
        bytes,
        typeof chatId === 'string' ? viewerDeps.remoteHost(chatId) : null,
        runDeps()
      ),

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
      ripgrep: ripgrepAvailable(),
      shell: shellInfoLite(),
      platform: process.platform
    }),

    // ---- atualizações (só aviso; nada é baixado) ----
    [IPC.updates.status]: (): UpdateStatus =>
      updateChecker()?.status() ?? { current: app.getVersion(), state: 'idle' },
    [IPC.updates.check]: (): Promise<UpdateStatus> | UpdateStatus =>
      updateChecker()?.check() ?? { current: app.getVersion(), state: 'idle' },
    [IPC.updates.openRelease]: async () => {
      // a URL vem do main (resposta do GitHub já validada), nunca do renderer
      const url = updateChecker()?.status().latest?.url
      await shell.openExternal(isReleaseUrl(url) ? url : RELEASES_PAGE)
    },

    // ---- questionários (ask_user) ----
    [IPC.questions.answer]: (id: string, answers: unknown) =>
      gateById(
        (e) => e.host.findQuestion(id),
        'question',
        { requestId: id, answers: answers as QuestionAnswer[] },
        () => answerQuestion(id, answers)
      ),
    [IPC.questions.cancel]: (id: string) =>
      gateById(
        (e) => e.host.findQuestion(id),
        'question',
        { requestId: id, cancel: true },
        () => runner.cancelQuestionRequest(id)
      ),
    [IPC.questions.pending]: () => [
      ...runner.pendingQuestions(),
      ...(syncEngine()?.host.mirrorQuestions() ?? [])
    ],

    // ---- falha de conexão com o provedor (Tentar de novo / Cancelar) ----
    [IPC.retries.retry]: (id: string) =>
      gateById(
        (e) => e.host.findRetry(id),
        'retry',
        { requestId: id, action: 'retry' },
        () => runner.retryRequest(id)
      ),
    [IPC.retries.cancel]: (id: string) =>
      gateById(
        (e) => e.host.findRetry(id),
        'retry',
        { requestId: id, action: 'cancel' },
        () => runner.cancelRetryRequest(id)
      ),
    [IPC.retries.pending]: () => [
      ...runner.pendingRetries(),
      ...(syncEngine()?.host.mirrorRetries() ?? [])
    ],

    // ---- processos em segundo plano (process_start) ----
    [IPC.processes.list]: (chatId: string) =>
      syncEngine()?.host.mirrorProcesses(chatId) ?? listProcesses(chatId),
    [IPC.processes.stop]: async (chatId: string, id: string) => {
      remoteProcessGuard(chatId)
      await stopProcess(chatId, id, 'SIGTERM')
    },
    [IPC.processes.logs]: (chatId: string, id: string, tail?: number) => {
      remoteProcessGuard(chatId)
      return processLogLines(chatId, id, tail)
    },

    // ---- presets (personas) ----
    [IPC.presets.list]: () => presetsRepo.list(),
    [IPC.presets.create]: (input: PresetInput) => presetsRepo.create(input),
    [IPC.presets.update]: (id: string, patch: PresetPatch) => presetsRepo.update(id, patch ?? {}),
    [IPC.presets.delete]: (id: string) => presetsRepo.delete(id),
    [IPC.presets.duplicate]: (id: string) => presetsRepo.duplicate(id),
    // ---- memória (SPEC → Memória) ----
    [IPC.memory.listCollections]: () => memory.listCollections(),
    [IPC.memory.createCollection]: (input: MemoryCollectionInput) => memory.createCollection(input),
    [IPC.memory.updateCollection]: (id: string, patch: MemoryCollectionPatch) =>
      memory.updateCollection(id, patch ?? {}),
    [IPC.memory.deleteCollection]: (id: string) => memory.deleteCollection(id),
    [IPC.memory.list]: (query?: MemoryListQuery) => memory.listMemories(query),
    [IPC.memory.create]: (input: MemoryInput) => memory.createMemory(input),
    [IPC.memory.update]: (id: string, patch: MemoryPatch) => memory.updateMemory(id, patch ?? {}),
    [IPC.memory.delete]: (id: string) => memory.deleteMemory(id),
    [IPC.memory.preview]: (sessionId: string) => memory.previewMemory(sessionId),
    [IPC.memory.refreshSnapshot]: (sessionId: string) => memory.refreshSnapshot(sessionId),
    [IPC.memory.extractNow]: (sessionId: string) =>
      gateChat(
        chatOfSession(sessionId),
        'memory.extract',
        { sessionId },
        () => memory.extractNow(sessionId),
        {
          remote: () => ({
            created: 0,
            updated: 0,
            deleted: 0,
            changes: [],
            error: 'A extração roda no host; o resultado aparece no chat quando terminar.'
          })
        }
      ),
    // ---- sync ----
    ...syncHandlers()
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
