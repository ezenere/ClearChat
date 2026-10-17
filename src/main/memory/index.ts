// Memória modular — API do main usada pelos handlers IPC. STUB: o agente do backend implementa
// (repositório SQLite, FTS, snapshot por sessão, extração). Ver SPEC.md → "Memória".
/* eslint-disable @typescript-eslint/no-unused-vars -- stub: parâmetros usados pela implementação real */
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

const notImplemented = (): never => {
  throw new Error('Memória ainda não implementada')
}

export function listCollections(): MemoryCollection[] {
  return []
}
export function createCollection(_input: MemoryCollectionInput): MemoryCollection {
  return notImplemented()
}
export function updateCollection(_id: string, _patch: MemoryCollectionPatch): MemoryCollection {
  return notImplemented()
}
export function deleteCollection(_id: string): void {
  notImplemented()
}
export function listMemories(_query?: MemoryListQuery): Memory[] {
  return []
}
export function createMemory(_input: MemoryInput): Memory {
  return notImplemented()
}
export function updateMemory(_id: string, _patch: MemoryPatch): Memory {
  return notImplemented()
}
export function deleteMemory(_id: string): void {
  notImplemented()
}
export function previewMemory(_sessionId: string): MemoryPreview {
  return { active: false, index: null, help: null, tools: [], snapshotAt: null }
}
export function refreshSnapshot(sessionId: string): MemoryPreview {
  return previewMemory(sessionId)
}
export async function extractNow(_sessionId: string): Promise<MemoryExtractionResult> {
  return notImplemented()
}
