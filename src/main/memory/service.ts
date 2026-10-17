// Memória modular — serviço sobre uma conexão: repositório + resolução da config + snapshot do
// índice por sessão (token caching) + preview. Sem Electron (index.ts liga ao banco do app; os
// testes usam banco temporário). Ver SPEC.md → "Memória".
import type Database from 'better-sqlite3'
import { DEFAULT_MEMORY_HELP_PROMPT } from '@shared/defaults'
import type { MemoryPreview } from '@shared/memory'
import type { Chat, Session } from '@shared/types'
import { activeMemory, type ActiveMemory } from './config'
import { indexGroups, renderIndex, type RenderOptions } from './render'
import { ensureMemorySchema } from './schema'
import { MemoryStore, type MemoryStoreOptions } from './store'

/** Estado de memória da sessão (coluna sessions.memory_json). */
export interface SessionMemoryState {
  /** Snapshot do índice: tirado no 1º request; renovado em compactação / "Atualizar memória". */
  snapshot?: { at: number; key: string; index: string }
  /** Maior seq já considerado por uma extração bem-sucedida. */
  lastExtractedSeq?: number
}

/** O que a memória acrescenta à request (system prompt). */
export interface MemoryPromptParts {
  index: string | null
  help: string | null
  /** Quando o snapshot usado foi tirado (null = índice atual, ainda não congelado). */
  snapshotAt: number | null
}

export class MemoryService {
  readonly store: MemoryStore
  readonly conn: Database.Database

  constructor(conn: Database.Database, opts: MemoryStoreOptions = {}) {
    this.conn = conn
    ensureMemorySchema(conn)
    this.store = new MemoryStore(conn, opts)
  }

  active(chat: Pick<Chat, 'id' | 'config'>, session: Pick<Session, 'depth'>): ActiveMemory {
    return activeMemory(this.store, chat, session)
  }

  /** Índice atual (sem snapshot) das coleções ativas. */
  renderIndex(am: ActiveMemory, opts: RenderOptions = {}): string {
    return renderIndex(indexGroups(this.store, am), opts)
  }

  // ---------------- estado por sessão ----------------

  readState(sessionId: string): SessionMemoryState {
    const r = this.conn.prepare('SELECT memory_json FROM sessions WHERE id = ?').get(sessionId) as
      { memory_json: string | null } | undefined
    if (!r?.memory_json) return {}
    try {
      const v = JSON.parse(r.memory_json)
      return v && typeof v === 'object' ? (v as SessionMemoryState) : {}
    } catch {
      return {}
    }
  }

  writeState(sessionId: string, patch: Partial<SessionMemoryState>): SessionMemoryState {
    const next = { ...this.readState(sessionId), ...patch }
    for (const k of Object.keys(next) as (keyof SessionMemoryState)[])
      if (next[k] === undefined) delete next[k]
    this.conn
      .prepare('UPDATE sessions SET memory_json = ? WHERE id = ?')
      .run(Object.keys(next).length ? JSON.stringify(next) : null, sessionId)
    return next
  }

  /** Snapshot salvo ainda válido (mesma chave de config)? */
  private validSnapshot(
    sessionId: string | undefined,
    am: ActiveMemory
  ): SessionMemoryState['snapshot'] | null {
    if (!sessionId) return null
    const s = this.readState(sessionId).snapshot
    return s && s.key === am.key && typeof s.index === 'string' ? s : null
  }

  /**
   * Partes do system prompt (só sessão principal com memória ativa; senão null — nada vai).
   * Usa o snapshot da sessão se válido; senão o índice atual (sem gravar — ver ensureSnapshot).
   */
  promptParts(
    chat: Pick<Chat, 'id' | 'config'>,
    session: Pick<Session, 'depth'> & { id?: string }
  ): MemoryPromptParts | null {
    const am = this.active(chat, session)
    if (!am.active || !am.main) return null
    const snap = this.validSnapshot(session.id, am)
    const cfg = am.config
    return {
      index: snap ? snap.index : this.renderIndex(am),
      help: cfg.helpPrompt.enabled ? (cfg.helpPrompt.text ?? DEFAULT_MEMORY_HELP_PROMPT) : null,
      snapshotAt: snap ? snap.at : null
    }
  }

  /** Antes de cada chamada da sessão principal: tira o snapshot se não houver (ou se a config mudou). */
  ensureSnapshot(chat: Pick<Chat, 'id' | 'config'>, session: Pick<Session, 'id' | 'depth'>): void {
    const am = this.active(chat, session)
    if (!am.active || !am.main) return
    if (this.validSnapshot(session.id, am)) return
    this.writeState(session.id, {
      snapshot: { at: Date.now(), key: am.key, index: this.renderIndex(am) }
    })
  }

  /** Compactação: o próximo request tira um snapshot novo. */
  clearSnapshot(sessionId: string): void {
    if (this.readState(sessionId).snapshot) this.writeState(sessionId, { snapshot: undefined })
  }

  /** "Atualizar memória": renova o snapshot agora (memória inativa → limpa). */
  refreshSnapshot(chat: Pick<Chat, 'id' | 'config'>, session: Pick<Session, 'id' | 'depth'>): void {
    this.clearSnapshot(session.id)
    this.ensureSnapshot(chat, session)
  }

  /** O que vai para a API na próxima request desta sessão. */
  preview(
    chat: Pick<Chat, 'id' | 'config'>,
    session: Pick<Session, 'id' | 'depth'>
  ): MemoryPreview {
    const am = this.active(chat, session)
    const parts = this.promptParts(chat, session)
    return {
      active: am.active,
      index: parts?.index ?? null,
      help: parts?.help ?? null,
      tools: am.tools,
      snapshotAt: parts?.snapshotAt ?? null
    }
  }
}
