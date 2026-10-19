// Memória modular — API do main (handlers IPC, runner, request). Liga o serviço (service.ts) ao
// banco do app e aos eventos. Ver SPEC.md → "Memória".
import type {
  Memory,
  MemoryCollection,
  MemoryCollectionInput,
  MemoryCollectionPatch,
  MemoryExtractionResult,
  MemoryInput,
  MemoryListQuery,
  MemoryPatch,
  MemoryPreview
} from '@shared/memory'
import type { Chat, Session, StoredMessage, ToolName } from '@shared/types'
import { sessionProviderId } from '@shared/models'
import { getDb } from '../db'
import { emit } from '../events'
import { chatsRepo, messagesRepo, providersRepo, sessionsRepo } from '../repo'
import { setMemorySources } from '../agent/request'
import { runMemoryTool, type MemoryToolResult } from '../tools/memory'
import { extractionSummaryText, runExtraction, type ExtractionTrigger } from './extraction'
import { MemoryService } from './service'
import type { ActiveMemory } from './config'

let service: MemoryService | null = null

/** Serviço sobre o banco do app (cria o schema na 1ª vez). */
export function memoryService(): MemoryService {
  const conn = getDb()
  if (service && service.conn === conn) return service
  service = new MemoryService(conn, {
    onChange: (collectionId, memoryId) => emit({ type: 'memory-changed', collectionId, memoryId })
  })
  return service
}

// fontes da request: índice/help no system prompt e tools de memória (ver agent/request.ts)
setMemorySources({
  prompt: (chat, session) => {
    try {
      return memoryService().promptParts(chat, session)
    } catch (e) {
      console.error('[clearchat] memória (prompt)', e)
      return null
    }
  },
  tools: (chat, session) => {
    try {
      return memoryService().active(chat, session).tools
    } catch (e) {
      console.error('[clearchat] memória (tools)', e)
      return []
    }
  }
})

const sessionAndChat = (sessionId: string): { session: Session; chat: Chat } => {
  const session = sessionsRepo.get(sessionId)
  if (!session) throw new Error('Sessão não encontrada.')
  const chat = chatsRepo.get(session.chatId)
  if (!chat) throw new Error('Chat não encontrado.')
  return { session, chat }
}

// ---------------- CRUD (IPC) ----------------

export function listCollections(): MemoryCollection[] {
  return memoryService().store.listCollections()
}
export function createCollection(input: MemoryCollectionInput): MemoryCollection {
  return memoryService().store.createCollection(input)
}
export function updateCollection(id: string, patch: MemoryCollectionPatch): MemoryCollection {
  return memoryService().store.updateCollection(id, patch)
}
export function deleteCollection(id: string): void {
  memoryService().store.deleteCollection(id)
}
export function listMemories(query?: MemoryListQuery): Memory[] {
  return memoryService().store.listMemories(query ?? {})
}
export function createMemory(input: MemoryInput): Memory {
  return memoryService().store.createMemory(input, { updatedBy: 'user' })
}
export function updateMemory(id: string, patch: MemoryPatch): Memory {
  return memoryService().store.updateMemory(id, patch, { updatedBy: 'user' })
}
export function deleteMemory(id: string): void {
  memoryService().store.deleteMemory(id)
}

// ---------------- request / snapshot ----------------

export function previewMemory(sessionId: string): MemoryPreview {
  const { session, chat } = sessionAndChat(sessionId)
  return memoryService().preview(chat, session)
}

/** "Atualizar memória": renova o snapshot do índice da sessão. */
export function refreshSnapshot(sessionId: string): MemoryPreview {
  const { session, chat } = sessionAndChat(sessionId)
  memoryService().refreshSnapshot(chat, session)
  return memoryService().preview(chat, session)
}

/** Runner, antes de cada chamada: congela o índice no 1º request da sessão. */
export function ensureSnapshot(chat: Chat, session: Session): void {
  try {
    memoryService().ensureSnapshot(chat, session)
  } catch (e) {
    console.error('[clearchat] memória (snapshot)', e)
  }
}

/** Memória ativa da sessão (tools: disponibilidade e regras). */
export function activeMemoryFor(chat: Chat, session: Pick<Session, 'depth'>): ActiveMemory {
  return memoryService().active(chat, session)
}

/** Runner: executa uma tool de memória chamada pelo agente (o gate de aprovação já passou). */
export function runMemoryToolFor(
  chat: Chat,
  session: Session,
  name: ToolName,
  args: Record<string, unknown>
): MemoryToolResult {
  const svc = memoryService()
  return runMemoryTool(name, args, {
    store: svc.store,
    am: svc.active(chat, session),
    by: { updatedBy: 'model', chatId: chat.id }
  })
}

// ---------------- extração ----------------

const running = new Map<string, Promise<MemoryExtractionResult>>()

async function extract(
  sessionId: string,
  trigger: ExtractionTrigger
): Promise<MemoryExtractionResult> {
  const { session, chat } = sessionAndChat(sessionId)
  if (session.depth !== 0) throw new Error('A extração de memórias só roda na sessão principal.')
  const svc = memoryService()
  const cfg = svc.active(chat, session).config.extraction
  const providerId = cfg.model
    ? (cfg.providerId ?? sessionProviderId(chat.config, session))
    : sessionProviderId(chat.config, session)
  const provider = providerId ? providersRepo.get(providerId) : null
  const model = cfg.model ?? session.model ?? chat.config.model
  const history: StoredMessage[] = messagesRepo.path(sessionId)
  const out = await runExtraction({
    service: svc,
    chat,
    sessionId,
    history,
    provider,
    model,
    trigger
  })
  if (out.empty) {
    return { ...out.record, error: 'Nada novo na conversa desde a última extração.' }
  }
  if (!out.record.error) svc.writeState(sessionId, { lastExtractedSeq: out.maxSeq })
  if (sessionsRepo.get(sessionId)) {
    try {
      const m = messagesRepo.append(
        sessionId,
        { role: 'assistant', content: extractionSummaryText(out.record) },
        { synthetic: true, kind: 'memory-extraction', memoryExtraction: out.record }
      )
      emit({ type: 'message-added', message: m })
      chatsRepo.touch(chat.id)
    } catch (e) {
      console.error('[clearchat] memória (card da extração)', e)
    }
  }
  return out.record
}

/** "Extrair memórias agora" (só sessão principal). Uma extração por sessão de cada vez. */
export function extractNow(
  sessionId: string,
  trigger: ExtractionTrigger = 'manual'
): Promise<MemoryExtractionResult> {
  const cur = running.get(sessionId)
  if (cur) return cur
  const p = extract(sessionId, trigger).finally(() => running.delete(sessionId))
  running.set(sessionId, p)
  return p
}

/**
 * Runner, depois de uma compactação bem-sucedida: renova o snapshot (o próximo request tira outro)
 * e, com `extraction.auto` (sessão principal, memória ativa com destino de escrita), dispara a
 * extração em segundo plano (resumo da compactação + mensagens recentes). Nunca lança.
 */
export function afterCompaction(sessionId: string): Promise<MemoryExtractionResult | null> {
  try {
    const { session, chat } = sessionAndChat(sessionId)
    const svc = memoryService()
    svc.clearSnapshot(sessionId)
    const am = svc.active(chat, session)
    if (session.depth !== 0 || !am.active || !am.canWrite || !am.config.extraction.auto)
      return Promise.resolve(null)
    return extractNow(sessionId, 'compaction').catch((e) => {
      console.error('[clearchat] memória (extração automática)', e)
      return null
    })
  } catch (e) {
    console.error('[clearchat] memória (pós-compactação)', e)
    return Promise.resolve(null)
  }
}
