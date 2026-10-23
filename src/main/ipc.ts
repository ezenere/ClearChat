// Registro dos handlers IPC (ipcMain.handle) — um para cada canal em `IPC` (src/shared/ipc.ts).
// Handlers recebem os argumentos posicionais na mesma ordem da API do preload.
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import {
  ALL_CHANNELS,
  IPC,
  VOICE_CALL_STATE_CHANNEL,
  VOICE_CALL_TIMELINE_CHANNEL,
  VOICE_CALL_UTTERANCE_CANCEL_CHANNEL,
  VOICE_CALL_UTTERANCE_CHANNEL,
  VOICE_MODELS_PROGRESS_CHANNEL,
  VOICE_PARTIAL_CHANNEL,
  VOICE_TTS_CLIPS_PROGRESS_CHANNEL,
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
  type SmartApproveTestInput,
  type TtsClipsView,
  type TtsVoicesView,
  type VoiceModelInfo,
  type VoiceRuntimeStatus,
  type VoiceSettingKind
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
import { emit, onAgentEvent, sendToWindows } from './events'
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
import { setVoiceCallSource } from './agent/request'
import * as memory from './memory'
import { generateTitleNow } from './autoTitle'
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
import {
  getVoiceSettings,
  getVoiceSettingsView,
  setVoiceSetting,
  syncLocalModelInstalled
} from './voice'
import {
  clipVoiceId,
  generateClips,
  loadClipAudio,
  loadClips,
  type ClipsManifest
} from './voice/clips'
import { createEvalLogger } from './voice/evalLog'
import { findCatalogEntry } from './voice/catalog'
import {
  downloadLocalModel,
  listLocalModels,
  removeLocalModel,
  type LocalModelInfo
} from './voice/models'
import {
  cancelTranscribeSessions,
  deriveHasLocalReady,
  findTranscribeSession,
  startTranscribeSession,
  type TranscribeSession
} from './voice/session'
import {
  isSttEngineRuntimeAvailable,
  probeWhisperRuntime,
  releaseSttModel,
  sttEngineUnavailableReason
} from './voice/sttLocal'
import { synthesize, TTS_TEST_PHRASE } from './voice/tts'
import {
  createKokoroEngine,
  espeakMissingError,
  kokoroReadiness,
  probeEspeak,
  probeOnnxRuntime,
  type KokoroEngine
} from './voice/ttsLocal'
import { VoiceCallManager } from './voice/call'
import { isBusyStatus } from './voice/turnMachine'

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

/** Sessão de transcrição viva pelo id — erro legível para id desconhecido/encerrado/substituído. */
function requireTranscribeSession(sessionId: string): TranscribeSession {
  const s = typeof sessionId === 'string' ? findTranscribeSession(sessionId) : null
  if (!s)
    throw new Error('Sessão de transcrição não encontrada (encerrada, cancelada ou substituída).')
  return s
}

// ---- dono das chamadas de IPC (para o ciclo de vida da voz por janela) ----

/**
 * `webContents.id` de quem invocou o handler em execução (lido no começo SÍNCRONO do handler —
 * depois de um `await` já pode ser de outra chamada). null fora de um handler.
 */
let ipcSenderId: number | null = null

/** Chamada de voz e dono dela (o webContents que entrou) — limpos quando o renderer some. */
let voiceCallsRef: VoiceCallManager | null = null
let voiceCallOwner: number | null = null

/**
 * O renderer `webContentsId` recarregou, navegou, caiu ou a janela fechou: tudo de voz que ele
 * deixou aberto no main é encerrado — sessões de transcrição dele (a final em voo é abortada) e a
 * chamada de voz que ele abriu. Sem isso a sessão órfã segurava a vaga ("Já há uma transcrição…")
 * e a chamada seguia "ativa" sem ninguém ouvindo. Idempotente.
 */
export function resetVoiceForWebContents(webContentsId: number, reason: string): void {
  const n = cancelTranscribeSessions(webContentsId)
  let callStopped = false
  if (voiceCallsRef && voiceCallOwner === webContentsId && voiceCallsRef.state().active) {
    voiceCallsRef.stop()
    callStopped = true
  }
  if (voiceCallOwner === webContentsId) voiceCallOwner = null
  if (n || callStopped)
    console.log(
      `[clearchat] voz: renderer ${webContentsId} ${reason} — ${n} transcrição(ões) cancelada(s)${callStopped ? ', chamada encerrada' : ''}`
    )
}

// ---- modelos locais de áudio (SPEC → "Áudio → Componentes locais") ----

/**
 * userData do app — a API de modelos locais recebe o `baseDir` e instala em `<userData>/models`
 * (o `modelsDir` do gerenciador faz a junção; passar o caminho já montado dobraria o `models`).
 */
const localModelsBaseDir = (): string => app.getPath('userData')

/** Downloads de modelos locais em voo por id (cancelamento via `voice:models:cancel`). */
const localDownloads = new Map<string, AbortController>()

/** Progresso emitido no máximo a cada 100 ms por modelo (e sempre ao terminar). */
const PROGRESS_MIN_MS = 100
const lastProgressAt = new Map<string, number>()

/** Entrada do catálogo + estado em disco → visão do renderer (`VoiceModelInfo`). */
const toModelView = (info: LocalModelInfo): VoiceModelInfo => ({
  id: info.entry.id,
  kind: info.entry.kind,
  engine: info.entry.engine,
  name: info.entry.name,
  description: info.entry.description,
  languages: [...info.entry.languages],
  version: info.entry.version,
  sizeBytes: info.entry.sizeBytes,
  hasDownload: !!info.entry.url,
  state: info.state,
  installedBytes: info.installedBytes
})

/** `{ id }` dos canais `voice:models:*`, validado (id não vazio). */
function requireModelId(input: { id: string } | undefined): string {
  const id = input && typeof input.id === 'string' ? input.id.trim() : ''
  if (!id) throw new Error('Modelo não informado (esperado { id }).')
  return id
}

// ---- TTS: síntese de fala e clipes (`voice:tts:*` — SPEC → "Áudio → Serviço de TTS") ----

/** Motor local Kokoro (memoizado — mantém a sessão ONNX aquecida entre chamadas). */
let kokoro: KokoroEngine | null = null
const ttsLocalEngine = (): KokoroEngine =>
  (kokoro ??= createKokoroEngine({ baseDir: app.getPath('userData') }))

/** Prontidão dos runtimes locais (`voice:runtime:status`) — probes memoizados + estado em disco. */
async function voiceRuntimeStatus(): Promise<VoiceRuntimeStatus> {
  const v = getVoiceSettings()
  const [whisper, onnx, espeak, models] = await Promise.all([
    probeWhisperRuntime(),
    probeOnnxRuntime(),
    probeEspeak(),
    listLocalModels(localModelsBaseDir())
  ])
  const sttReady = deriveHasLocalReady(v.stt.local, models)
  const engine = v.stt.local?.engine
  const sttReason = sttReady
    ? null
    : !v.stt.local
      ? 'nenhum modelo local de transcrição escolhido'
      : !isSttEngineRuntimeAvailable(v.stt.local.engine)
        ? (sttEngineUnavailableReason(v.stt.local.engine) ??
          `o engine '${engine}' ainda não tem motor de inferência nesta versão`)
        : `nenhum modelo local instalado para o engine '${engine}'`
  const ttsLocal =
    v.tts.local?.engine === 'kokoro'
      ? await kokoroReadiness(localModelsBaseDir(), v.tts.local.voice)
      : {
          available: false,
          reason: v.tts.local
            ? `o motor '${v.tts.local.engine}' ainda não tem runtime nesta versão`
            : 'nenhum motor local de fala escolhido'
        }
  return {
    whisper: { available: whisper.available, reason: whisper.reason },
    onnxruntime: { available: onnx.available, reason: onnx.reason },
    espeak: espeak.available ? espeak : { available: false, reason: espeakMissingError().message },
    sttLocal: { available: sttReady, reason: sttReason },
    ttsLocal
  }
}

/** Sugestões livres de vozes para endpoints OpenAI-compatíveis (o campo aceita qualquer id). */
const TTS_API_VOICES: TtsVoicesView['api'] = [
  'alloy',
  'ash',
  'ballad',
  'coral',
  'echo',
  'fable',
  'nova',
  'onyx',
  'sage',
  'shimmer'
].map((id) => ({ id, label: id, engine: null }))

/** Manifest de clipes → visão do renderer (sem o hash da definição, que é interno). */
const toClipsView = (m: ClipsManifest): TtsClipsView => ({
  voiceId: m.voiceId,
  backend: m.backend,
  engine: m.engine,
  model: m.model,
  generatedAt: m.generatedAt,
  clips: m.clips.map((c) => ({ id: c.id, class: c.class, n: c.n, text: c.text }))
})

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
  // ---- chamada de voz meia-duplex: o dono do turno no main + os overrides de request ----
  // (o renderer é o "sensor": captura/silêncio/reprodução — SPEC → "Chamada de voz (meia-duplex)")
  // decisões de filler/interjeição também viram linhas no log de avaliação (modo sombra/calibração)
  const evalLogger = createEvalLogger(app.getPath('userData'), (e) =>
    console.log('[clearchat] voice-eval:', e)
  )
  const voiceCalls = new VoiceCallManager({
    sendTurn: (sessionId, text) => {
      // mesmo caminho do composer (`agent.send` → gatedSend → runner.send; fila/⚡ respeitadas)
      void gatedSend(sessionId, text, undefined, undefined).catch((e) =>
        voiceCalls.reportError(e instanceof Error ? e.message : String(e))
      )
    },
    synth: (text, signal) =>
      synthesize(
        { text, settings: getVoiceSettings().tts, format: 'wav' },
        { local: ttsLocalEngine(), signal }
      ),
    emitState: (state) => sendToWindows(VOICE_CALL_STATE_CHANNEL, state),
    emitUtterance: (u) => sendToWindows(VOICE_CALL_UTTERANCE_CHANNEL, u),
    emitUtteranceCancel: (id) => sendToWindows(VOICE_CALL_UTTERANCE_CANCEL_CHANNEL, { id }),
    emitTimeline: (event) => sendToWindows(VOICE_CALL_TIMELINE_CHANNEL, event),
    logEval: (event) => evalLogger.log(event),
    clip: (cls, n) =>
      loadClipAudio(app.getPath('userData'), clipVoiceId(getVoiceSettings().tts), cls, n),
    sessionInfo: (sessionId) => {
      const s = sessionsRepo.get(sessionId)
      return s ? { chatId: s.chatId, depth: s.depth, busy: isBusyStatus(s.status) } : null
    },
    chatConfig: (chatId) => chatsRepo.get(chatId)?.config ?? null,
    settings: () => {
      const v = getVoiceSettings()
      return { defaults: v.voiceCallDefaults, audioInput: v.audioInput, stt: v.stt, tts: v.tts }
    },
    onEvent: (cb) => onAgentEvent(cb)
  })
  voiceCallsRef = voiceCalls
  setVoiceCallSource((chat, session) => voiceCalls.callContextFor(chat, session))
  // sonda o runtime local em segundo plano (processo do worker + onnxruntime + espeak-ng): o
  // "pronto" dos canais já sai com o binding real; ninguém espera por isto aqui
  void probeWhisperRuntime().then((r) => {
    if (!r.available) console.warn(`[clearchat] STT local indisponível: ${r.reason}`)
  })
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
    // título automático: local (usa a config e o provedor deste dispositivo); o título sincroniza
    [IPC.chats.generateTitle]: (id: string) => generateTitleNow(id),

    // ---- sessions ----
    // chat executado em outro dispositivo: o status ao vivo (o banco guarda `running` como
    // interrupted — §4.3.7); sem isso, abrir/voltar ao chat no meio do turno o mostrava parado
    [IPC.sessions.list]: (chatId: string) => {
      const list = sessionsRepo.list(chatId)
      const host = syncEngine()?.host
      return host ? list.map((s) => host.displaySession(s)) : list
    },
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
    [IPC.agent.setCapturedContext]: (chatId: string, sessionId: string | null, text: string) =>
      runner.setCapturedContext(chatId, sessionId ?? null, String(text ?? '')),
    [IPC.agent.undoCapturedContext]: (chatId: string, sessionId: string | null) =>
      runner.undoCapturedContext(chatId, sessionId ?? null),

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
    // ---- voz: settings de áudio + sessão de transcrição (SPEC → "Áudio") ----
    // (as chaves de API de stt/tts não passam por aqui nem pelo settings genérico:
    //  PROTECTED_SETTINGS; saem mascaradas e só o main usa a chave real)
    [IPC.voice.settingsGet]: () => getVoiceSettingsView(),
    [IPC.voice.settingsSet]: (kind: VoiceSettingKind, value: unknown) =>
      setVoiceSetting(kind, value),
    [IPC.voice.transcribeStart]: async (language?: string) => {
      const owner = ipcSenderId // antes de qualquer await
      const v = getVoiceSettings()
      const lang =
        typeof language === 'string' && language.trim() ? language : v.audioInput.language
      const [models] = await Promise.all([
        listLocalModels(localModelsBaseDir()),
        // "pronto" = modelo instalado + binding que carrega de verdade (probe memoizado)
        v.stt.mode !== 'api' ? probeWhisperRuntime() : null
      ])
      return startTranscribeSession(
        { settings: v.stt, language: lang },
        {
          // coerência installed/hasLocalReady: a presença real de modelo instalado vem do disco
          hasLocalReady: deriveHasLocalReady(v.stt.local, models),
          onPartial: (e) => sendToWindows(VOICE_PARTIAL_CHANNEL, e),
          ownerId: owner ?? undefined
        }
      ).id
    },
    [IPC.voice.transcribePush]: (sessionId: string, pcm16: Uint8Array, sampleRate?: number) => {
      requireTranscribeSession(sessionId).push(pcm16, sampleRate)
    },
    [IPC.voice.transcribeStop]: (sessionId: string) => requireTranscribeSession(sessionId).stop(),
    // cancel é tolerante: encerrar uma sessão que já saiu (corrida com o fim natural) não é erro;
    // vale também para a sessão que está transcrevendo a final (aborta a final)
    [IPC.voice.transcribeCancel]: (sessionId: string) => {
      if (typeof sessionId === 'string') findTranscribeSession(sessionId)?.cancel()
    },
    // ---- modelos locais (catálogo + download/estado em disco) ----
    [IPC.voice.modelsList]: async (): Promise<VoiceModelInfo[]> =>
      (await listLocalModels(localModelsBaseDir())).map(toModelView),
    [IPC.voice.modelsDownload]: async (input: { id: string }): Promise<VoiceModelInfo | null> => {
      const id = requireModelId(input)
      if (localDownloads.has(id)) throw new Error(`download já em andamento para ${id}`)
      const controller = new AbortController()
      localDownloads.set(id, controller)
      const emitProgress = (bytes: number, total: number): void => {
        const now = Date.now()
        const last = lastProgressAt.get(id) ?? 0
        if (bytes < total && now - last < PROGRESS_MIN_MS) return
        lastProgressAt.set(id, now)
        sendToWindows(VOICE_MODELS_PROGRESS_CHANNEL, { id, bytes, total })
      }
      try {
        const info = await downloadLocalModel(localModelsBaseDir(), id, {
          signal: controller.signal,
          onProgress: emitProgress
        })
        emitProgress(info.installedBytes ?? info.entry.sizeBytes, info.entry.sizeBytes)
        syncLocalModelInstalled(info.entry, true)
        return toModelView(info)
      } catch (e) {
        // cancelado pelo usuário (abort limpa o `.part` no gerenciador) → null, não é erro
        if (controller.signal.aborted) return null
        throw e
      } finally {
        localDownloads.delete(id)
        lastProgressAt.delete(id)
      }
    },
    // cancel é tolerante: id desconhecido/já encerrado = sem efeito (o gerenciador limpa o `.part`)
    [IPC.voice.modelsCancel]: (input: { id: string }): void => {
      localDownloads.get(requireModelId(input))?.abort()
    },
    [IPC.voice.modelsRemove]: async (input: { id: string }): Promise<void> => {
      const id = requireModelId(input)
      const entry = findCatalogEntry(id)
      // solta o modelo carregado antes de apagar o arquivo (RAM de volta; nada lendo o arquivo)
      const before = (await listLocalModels(localModelsBaseDir())).find((m) => m.entry.id === id)
      if (entry?.kind === 'stt') releaseSttModel(before?.path ?? undefined)
      if (entry?.engine === 'kokoro' && kokoro) {
        const k = kokoro
        kokoro = null
        await k.release()
      }
      await removeLocalModel(localModelsBaseDir(), id)
      if (entry) syncLocalModelInstalled(entry, false)
    },

    // ---- TTS: síntese de fala + clipes de interjeição/filler ----
    // (a `apiKey` do endpoint de síntese fica no main — os handlers usam `getVoiceSettings()`)
    [IPC.voice.ttsSynth]: (input: { text: string; format?: 'wav' | 'mp3' }) => {
      const text = input && typeof input.text === 'string' ? input.text : ''
      if (!text.trim()) throw new Error('Texto para a síntese de fala está vazio.')
      return synthesize(
        {
          text,
          settings: getVoiceSettings().tts,
          format: input.format === 'mp3' ? 'mp3' : 'wav'
        },
        { local: ttsLocalEngine() }
      )
    },
    [IPC.voice.ttsTest]: () =>
      synthesize(
        { text: TTS_TEST_PHRASE, settings: getVoiceSettings().tts, format: 'wav' },
        { local: ttsLocalEngine() }
      ),
    [IPC.voice.ttsClipsGenerate]: async (): Promise<TtsClipsView> => {
      const manifest = await generateClips({
        baseDir: app.getPath('userData'),
        settings: getVoiceSettings().tts,
        local: ttsLocalEngine(),
        onProgress: (e) => sendToWindows(VOICE_TTS_CLIPS_PROGRESS_CHANNEL, e)
      })
      return toClipsView(manifest)
    },
    [IPC.voice.ttsClipsList]: async (): Promise<TtsClipsView | null> => {
      const m = await loadClips(app.getPath('userData'), clipVoiceId(getVoiceSettings().tts))
      return m ? toClipsView(m) : null
    },
    [IPC.voice.ttsVoices]: async (): Promise<TtsVoicesView> => {
      const v = getVoiceSettings().tts
      // chatterbox: motor ainda sem runtime nesta versão (a lista fica vazia na UI)
      if (v.local?.engine === 'chatterbox') return { local: [], api: TTS_API_VOICES }
      const local = await ttsLocalEngine().voices()
      return {
        local: local.map((x) => ({ ...x, engine: 'kokoro' as const })),
        api: TTS_API_VOICES
      }
    },

    // ---- chamada de voz (meia-duplex) — SPEC → "Áudio → Chamada de voz (meia-duplex)" ----
    [IPC.voice.callStart]: (input: { sessionId: string }) => {
      const sessionId = input && typeof input.sessionId === 'string' ? input.sessionId.trim() : ''
      if (!sessionId) throw new Error('Sessão não informada (esperado { sessionId }).')
      const owner = ipcSenderId
      // chamada órfã de um renderer que sumiu sem avisar (ex.: crash antes do hook): o mesmo dono
      // pedindo de novo reabre; outro dono ainda vivo segue recusado pelo manager
      if (voiceCalls.state().active && owner !== null && voiceCallOwner === owner) voiceCalls.stop()
      const state = voiceCalls.start(sessionId)
      voiceCallOwner = owner
      return state
    },
    [IPC.voice.callStop]: () => {
      voiceCallOwner = null
      return voiceCalls.stop()
    },
    [IPC.voice.callGetState]: () => voiceCalls.state(),
    [IPC.voice.runtimeStatus]: () => voiceRuntimeStatus(),
    [IPC.voice.callMute]: (input: { muted: boolean }) => voiceCalls.mute(!!input?.muted),
    [IPC.voice.callSpeechBegin]: () => voiceCalls.speechBegin(),
    [IPC.voice.callSpeechEnd]: () => voiceCalls.speechEnd(),
    [IPC.voice.callTurn]: (input: { text: string }) =>
      voiceCalls.turn(input && typeof input.text === 'string' ? input.text : ''),
    [IPC.voice.callPlaybackIdle]: () => voiceCalls.playbackIdle(),
    [IPC.voice.callBargeIn]: () => voiceCalls.bargeIn(),
    [IPC.voice.callInterjectionObserved]: (input: {
      speechMs: number
      pauseMs: number
      tail: string
      observedAt: number
    }) =>
      voiceCalls.interjectionObserved(
        input ?? { speechMs: 0, pauseMs: 0, tail: '', observedAt: 0 }
      ),
    [IPC.voice.callBackchannel]: (input: { ms: number }) =>
      voiceCalls.backchannel(input ?? { ms: 0 }),

    // ---- sync ----
    ...syncHandlers()
  }

  const missing = ALL_CHANNELS.filter((c) => !handlers[c])
  if (missing.length) throw new Error(`[clearchat] canais IPC sem handler: ${missing.join(', ')}`)

  for (const [channel, fn] of Object.entries(handlers)) {
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, (e, ...args: unknown[]) => {
      // o dono da chamada fica visível só durante a parte síncrona do handler
      ipcSenderId = e.sender.id
      try {
        return (fn as (...a: unknown[]) => unknown)(...args)
      } finally {
        ipcSenderId = null
      }
    })
  }
}
