// Mapeamento entidades locais ↔ plaintext dos registros do sync (docs/SYNC_PROTOCOL.md §4.3).
// Sem Electron: SQL direto na conexão (testável com banco temporário). Campos locais do dispositivo
// (§4.4: `cwd` de chats e personas) nunca saem daqui e são preservados ao aplicar.
import type Database from 'better-sqlite3'
import { homedir } from 'node:os'
import { providerKind } from '@shared/providerKinds'
import type { AgentEvent, ApiMessage, MessageMeta, Session, StoredMessage } from '@shared/types'
import type { SyncScope } from '@shared/sync'
import { toBranchSel, type BranchSel } from '@shared/branches'
import { indexMessage } from '../searchIndex'
import { ROOT_PARENT } from '../migrateBranches'

export type RecordType =
  | 'provider'
  | 'setting'
  | 'preset'
  | 'memory_collection'
  | 'memory'
  | 'chat'
  | 'session'
  | 'message'
  | 'skill'

export const RECORD_TYPES: RecordType[] = [
  'provider',
  'setting',
  'preset',
  'memory_collection',
  'memory',
  'chat',
  'session',
  'message',
  'skill'
]
export const isRecordType = (t: string): t is RecordType => (RECORD_TYPES as string[]).includes(t)

/** Tipos LWW por campo (merge 3-way em conflito, §7.5). */
export const FIELD_LWW: RecordType[] = ['provider', 'preset', 'memory_collection', 'memory', 'chat']
/** Conteúdo do chat (regras de host, §8). */
export const isContent = (t: string): boolean => t === 'session' || t === 'message'

export type Plain = Record<string, unknown>

/** Ids fixos dos registros `setting` (§4.3.2). */
export const SETTING_IDS = [
  'defaultModel',
  'defaultSystemPrompt',
  'defaultPresetId',
  'approvalModes',
  'approvalLists',
  'webSearchEngines',
  'webSearchApiKeys',
  'webSearchMinIntervalSec',
  // desde 1.4.0 (preferências; antes locais do dispositivo)
  'smartApproveDefaults',
  'autoTitle',
  'toolOutputSpillChars'
] as const

/**
 * Ids de `setting` que entraram depois do 1.0.0: um dispositivo que já sincronizava não marcou os
 * valores locais como sujos (os triggers não os viam) — o motor faz uma passada única depois do
 * primeiro pull (SyncEngine.backfillSettings). Mudou a lista → mudar a versão.
 */
export const SETTINGS_BACKFILL = {
  version: '1.4.0',
  ids: ['smartApproveDefaults', 'autoTitle', 'toolOutputSpillChars']
} as const

/** Status transitórios de sessão (exibidos como interrupted sem janela aberta, §4.3.7). */
export const TRANSIENT_STATUS = new Set([
  'running',
  'waiting',
  'awaiting_approval',
  'awaiting_input',
  'awaiting_retry'
])

const parse = <T>(s: string | null | undefined, fallback: T): T => {
  if (s == null) return fallback
  try {
    return JSON.parse(s) as T
  } catch {
    return fallback
  }
}

/** JSON canônico (chaves ordenadas) — comparação de plaintexts. */
export function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null)
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  const o = v as Record<string, unknown>
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
    .join(',')}}`
}

export const sameJson = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b)

/** Remove chaves undefined (escritores NÃO DEVEM enviar undefined). */
function clean<T extends Plain>(o: T): T {
  return JSON.parse(JSON.stringify(o)) as T
}

const settingValue = (conn: Database.Database, key: string): unknown => {
  const r = conn.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    { value: string | null } | undefined
  return r?.value == null ? null : parse<unknown>(r.value, null)
}

function setSetting(conn: Database.Database, key: string, value: unknown): void {
  if (value === undefined || value === null)
    conn.prepare('DELETE FROM settings WHERE key = ?').run(key)
  else
    conn
      .prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      )
      .run(key, JSON.stringify(value))
}

// Árvore de mensagens (§4.3.7/§4.3.8): coluna parent_id '' = raiz ↔ plaintext `parentId: null`;
// coluna NULL (legado: registro de cliente < 0.7 ou linha antiga) ↔ `parentId` AUSENTE — quem lê
// deriva "a anterior por seq" (src/shared/branches.ts) e nada é regravado por causa disso.

/** messages.parent_id → `parentId` do plaintext/StoredMessage (undefined = ausente/derivar). */
export const parentIdFromColumn = (v: string | null | undefined): string | null | undefined =>
  v == null ? undefined : v === ROOT_PARENT ? null : v

/** `parentId` do plaintext → messages.parent_id (ausente/inválido → NULL = derivar). */
export const parentIdToColumn = (v: unknown): string | null =>
  v === null ? ROOT_PARENT : typeof v === 'string' && v ? v : null

/** sessions.branch_sel_json → BranchSel normalizado ({} quando vazio/inválido). */
export const branchSelFromColumn = (v: string | null | undefined): BranchSel =>
  toBranchSel(parse<unknown>(v, {}))

/** Mãe derivada (§4.3.8) da mensagem (sessionId, seq): a anterior por seq (empate: maior id), ou raiz. */
function derivedParent(conn: Database.Database, sessionId: string, seq: number): string | null {
  const r = conn
    .prepare(
      'SELECT id FROM messages WHERE session_id = ? AND seq < ? AND seq > 0 ORDER BY seq DESC, id DESC LIMIT 1'
    )
    .get(sessionId, seq) as { id: string } | undefined
  return r?.id ?? null
}

/**
 * Igualdade de plaintexts (local × servidor) que ignora o que o leitor DERIVA de um registro antigo
 * (escritor < 1.2.0): `parentId` ausente no servidor vale a mãe derivada (a local preenchida pela
 * migração não é mudança) e `branchSel` ausente vale `{}`. Sem isso o app reenviaria (ou veria como
 * "história diferente") toda mensagem antiga só por causa do `parent_id` preenchido localmente.
 */
export function sameRecordPlain(
  conn: Database.Database,
  type: string,
  local: Plain,
  remote: Plain | null | undefined
): boolean {
  if (!remote) return false
  let l = local
  if (type === 'message' && !('parentId' in remote) && 'parentId' in l) {
    const seq = Number(l.seq)
    const sid = String(l.sessionId ?? '')
    if (l.parentId === derivedParent(conn, sid, seq)) {
      l = { ...l }
      delete l.parentId
    }
  } else if (type === 'session' && !('branchSel' in remote) && 'branchSel' in l) {
    const sel = l.branchSel
    if (sel && typeof sel === 'object' && !Object.keys(sel).length) {
      l = { ...l }
      delete l.branchSel
    }
  }
  return sameJson(l, remote)
}

const stripCwd = (cfg: Plain): Plain => {
  const out = { ...cfg }
  delete out.cwd
  return out
}

// ---------------- local → plaintext ----------------

export interface LocalRecord {
  scope: string | null
  plain: Plain
  /** Ids de blob citados (preenchido pelo engine, que tem a chave). */
  shas?: string[]
}

/** Estado local de um registro (null = não existe localmente → tombstone se já foi enviado). */
export function buildLocal(
  conn: Database.Database,
  type: string,
  id: string,
  extra: { hostCwd?: unknown } = {}
): LocalRecord | null {
  switch (type) {
    case 'provider': {
      const r = conn.prepare('SELECT * FROM providers WHERE id = ?').get(id) as
        | {
            name: string
            base_url: string
            kind?: string
            api_key: string
            headers_json: string
            created_at: number
          }
        | undefined
      if (!r) return null
      return {
        scope: null,
        plain: clean({
          sv: 1,
          name: r.name,
          kind: providerKind({ baseUrl: r.base_url, kind: r.kind }),
          baseUrl: r.base_url,
          apiKey: r.api_key,
          headers: parse<Record<string, string>>(r.headers_json, {}),
          createdAt: r.created_at
        })
      }
    }
    case 'setting': {
      if (id === 'defaultModel') {
        const providerId = settingValue(conn, 'defaultProviderId')
        const model = settingValue(conn, 'defaultModel')
        const value =
          providerId == null && model == null
            ? null
            : {
                providerId: typeof providerId === 'string' ? providerId : null,
                model: typeof model === 'string' ? model : null
              }
        return { scope: null, plain: { sv: 1, value } }
      }
      if (!(SETTING_IDS as readonly string[]).includes(id)) return null
      return { scope: null, plain: { sv: 1, value: settingValue(conn, id) } }
    }
    case 'preset': {
      const r = conn.prepare('SELECT * FROM presets WHERE id = ?').get(id) as
        | {
            name: string
            description: string
            icon: string
            config_json: string
            created_at: number
            updated_at: number
          }
        | undefined
      if (!r) return null
      return {
        scope: null,
        plain: clean({
          sv: 1,
          name: r.name,
          description: r.description,
          icon: r.icon,
          config: stripCwd(parse<Plain>(r.config_json, {})),
          createdAt: r.created_at,
          updatedAt: r.updated_at
        })
      }
    }
    case 'memory_collection': {
      const r = conn.prepare('SELECT * FROM memory_collections WHERE id = ?').get(id) as
        | {
            category: string
            name: string
            description: string
            icon: string | null
            created_at: number
            updated_at: number
          }
        | undefined
      if (!r) return null
      return {
        scope: null,
        plain: {
          sv: 1,
          category: r.category,
          name: r.name,
          description: r.description,
          icon: r.icon ?? null,
          createdAt: r.created_at,
          updatedAt: r.updated_at
        }
      }
    }
    case 'memory': {
      const r = conn.prepare('SELECT * FROM memories WHERE id = ?').get(id) as
        | {
            collection_id: string
            category: string
            title: string
            slug: string
            summary: string
            facts_json: string
            pinned: number
            created_at: number
            updated_at: number
            updated_by_chat_id: string | null
            updated_by: string
            supersedes_id: string | null
          }
        | undefined
      if (!r) return null
      return {
        scope: r.collection_id,
        plain: {
          sv: 1,
          collectionId: r.collection_id,
          category: r.category,
          title: r.title,
          slug: r.slug,
          summary: r.summary,
          facts: parse<string[]>(r.facts_json, []),
          pinned: !!r.pinned,
          createdAt: r.created_at,
          updatedAt: r.updated_at,
          updatedByChatId: r.updated_by_chat_id ?? null,
          updatedBy: r.updated_by,
          supersedesId: r.supersedes_id ?? null
        }
      }
    }
    case 'chat': {
      const r = conn.prepare('SELECT * FROM chats WHERE id = ?').get(id) as
        | {
            title: string
            config_json: string
            main_session_id: string | null
            created_at: number
            updated_at: number
          }
        | undefined
      if (!r) return null
      const plain: Plain = {
        sv: 1,
        title: r.title,
        config: stripCwd(parse<Plain>(r.config_json, {})),
        mainSessionId: r.main_session_id ?? '',
        createdAt: r.created_at,
        updatedAt: r.updated_at
      }
      if (extra.hostCwd !== undefined) plain.hostCwd = extra.hostCwd
      return { scope: id, plain: clean(plain) }
    }
    case 'session': {
      const r = conn.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as
        | {
            chat_id: string
            parent_session_id: string | null
            parent_tool_call_id: string | null
            depth: number
            model: string
            provider_id: string | null
            title: string
            task: string | null
            status: string
            created_at: number
            memory_json?: string | null
            branch_sel_json?: string | null
          }
        | undefined
      if (!r) return null
      return {
        scope: r.chat_id,
        plain: clean({
          sv: 1,
          chatId: r.chat_id,
          parentSessionId: r.parent_session_id ?? null,
          parentToolCallId: r.parent_tool_call_id ?? null,
          depth: Math.min(2, Math.max(0, r.depth)),
          model: r.model,
          providerId: r.provider_id ?? null,
          title: r.title,
          task: r.task ?? null,
          status: r.status,
          createdAt: r.created_at,
          memory: r.memory_json ? parse<Plain | null>(r.memory_json, null) : null,
          // SEMPRE enviado ({} quando vazio): a regravação mescla com a base do servidor e omitir
          // traria de volta uma seleção velha (§4.3.7)
          branchSel: branchSelFromColumn(r.branch_sel_json)
        })
      }
    }
    case 'message': {
      const r = conn
        .prepare(
          'SELECT m.*, s.chat_id AS chat_id FROM messages m JOIN sessions s ON s.id = m.session_id WHERE m.id = ?'
        )
        .get(id) as
        | {
            session_id: string
            seq: number
            message_json: string
            meta_json: string
            created_at: number
            chat_id: string
            parent_id?: string | null
          }
        | undefined
      if (!r) return null
      const plain: Plain = {
        sv: 1,
        sessionId: r.session_id,
        seq: r.seq,
        message: parse<ApiMessage>(r.message_json, { role: 'user', content: '' }),
        meta: parse<MessageMeta>(r.meta_json, {}),
        createdAt: r.created_at
      }
      // legado (NULL) fica sem parentId: os leitores derivam; null explícito na raiz (§4.3.8)
      const parentId = parentIdFromColumn(r.parent_id)
      if (parentId !== undefined) plain.parentId = parentId
      return {
        scope: r.chat_id,
        plain,
        shas: attachmentShas(r.message_json + '\n' + (r.meta_json ?? ''))
      }
    }
  }
  return null
}

/** sha256 dos anexos citados (`clearchat-attachment://<sha256>.<ext>`). */
export function attachmentShas(text: string): string[] {
  const out = new Set<string>()
  for (const m of text.matchAll(/clearchat-attachment:\/\/([0-9a-f]{64})(?:\.[a-z0-9]{1,10})?/g))
    out.add(m[1])
  return [...out]
}

/** Nomes de arquivo do store citados (`<sha256>.<ext>`). */
export function attachmentFiles(text: string): string[] {
  const out = new Set<string>()
  for (const m of text.matchAll(/clearchat-attachment:\/\/([0-9a-f]{64}(?:\.[a-z0-9]{1,10})?)/g))
    out.add(m[1])
  return [...out]
}

/** Todos os ids locais de um tipo (merge / upload inicial). */
export function listLocalIds(conn: Database.Database, type: RecordType): string[] {
  const col = (sql: string): string[] =>
    (conn.prepare(sql).all() as { id: string }[]).map((r) => r.id)
  switch (type) {
    case 'provider':
      return col('SELECT id FROM providers ORDER BY created_at')
    case 'preset':
      return col('SELECT id FROM presets ORDER BY created_at')
    case 'memory_collection':
      return col('SELECT id FROM memory_collections ORDER BY created_at')
    case 'memory':
      return col('SELECT id FROM memories ORDER BY created_at')
    case 'chat':
      return col('SELECT id FROM chats ORDER BY created_at')
    case 'session':
      return col('SELECT id FROM sessions ORDER BY depth, created_at')
    case 'message':
      return col('SELECT id FROM messages ORDER BY session_id, seq')
    case 'setting':
      return SETTING_IDS.filter((id) => {
        const r = buildLocal(conn, 'setting', id)
        return r && r.plain.value != null
      })
    default:
      return []
  }
}

// ---------------- merge 3-way (LWW por campo) ----------------

/**
 * Sobre o plaintext atual do servidor, aplica só os campos que mudaram localmente desde `base`
 * (para `config`, chave a chave). `updatedAt` = máximo. Campos desconhecidos do servidor ficam.
 */
export function merge3(server: Plain, base: Plain | null, local: Plain): Plain {
  const out: Plain = JSON.parse(JSON.stringify(server))
  const b = base ?? {}
  for (const k of new Set([...Object.keys(local), ...Object.keys(b)])) {
    if (k === 'sv' || k === 'updatedAt') continue
    if (k === 'config') {
      const lc = (local.config ?? {}) as Plain
      const bc = (b.config ?? {}) as Plain
      const oc = { ...((out.config ?? {}) as Plain) }
      for (const ck of new Set([...Object.keys(lc), ...Object.keys(bc)])) {
        if (sameJson(lc[ck], bc[ck])) continue
        if (lc[ck] === undefined) delete oc[ck]
        else oc[ck] = lc[ck]
      }
      out.config = oc
      continue
    }
    if (!(k in local)) continue
    if (!sameJson(local[k], b[k])) out[k] = local[k]
  }
  const ua = Number(server.updatedAt ?? 0)
  const ub = Number(local.updatedAt ?? 0)
  if (server.updatedAt !== undefined || local.updatedAt !== undefined)
    out.updatedAt = Math.max(ua, ub)
  return out
}

// ---------------- plaintext → local ----------------

export interface ApplyCtx {
  /** Chat com janela de escrita aberta (status transitórios vão "ao vivo" ao renderer). */
  windowOpen?: (chatId: string) => boolean
  /** Pasta padrão para chats novos vindos de outro dispositivo. */
  defaultCwd?: () => string
}

export interface ApplyResult {
  events: AgentEvent[]
  scopes: Set<SyncScope>
  /** Registros que o aplicador alterou localmente e precisam de nova revisão (colisão de slug). */
  redirty: { type: string; id: string }[]
  hostCwd?: unknown
}

const newResult = (): ApplyResult => ({ events: [], scopes: new Set(), redirty: [] })

function rowSession(conn: Database.Database, id: string): Session | null {
  const r = conn.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as
    | {
        id: string
        chat_id: string
        parent_session_id: string | null
        parent_tool_call_id: string | null
        depth: number
        model: string
        provider_id: string | null
        title: string
        task: string | null
        status: string
        created_at: number
        branch_sel_json?: string | null
      }
    | undefined
  if (!r) return null
  return {
    id: r.id,
    chatId: r.chat_id,
    parentSessionId: r.parent_session_id,
    parentToolCallId: r.parent_tool_call_id,
    depth: Math.min(2, Math.max(0, r.depth)) as 0 | 1 | 2,
    model: r.model,
    providerId: r.provider_id ?? null,
    title: r.title,
    task: r.task,
    status: r.status as Session['status'],
    createdAt: r.created_at,
    branchSel: branchSelFromColumn(r.branch_sel_json)
  }
}

export function rowMessage(conn: Database.Database, id: string): StoredMessage | null {
  const r = conn.prepare('SELECT * FROM messages WHERE id = ?').get(id) as
    | {
        id: string
        session_id: string
        seq: number
        message_json: string
        meta_json: string
        created_at: number
        parent_id?: string | null
      }
    | undefined
  if (!r) return null
  const m: StoredMessage = {
    id: r.id,
    sessionId: r.session_id,
    seq: r.seq,
    message: parse<ApiMessage>(r.message_json, { role: 'user', content: '' }),
    meta: parse<MessageMeta>(r.meta_json, {}),
    createdAt: r.created_at
  }
  const parentId = parentIdFromColumn(r.parent_id)
  if (parentId !== undefined) m.parentId = parentId
  return m
}

/** Session a partir do plaintext do registro `session` (visualização: status sempre o gravado). */
export function sessionFromPlain(id: string, p: Plain, chatId = String(p.chatId ?? '')): Session {
  return {
    id,
    chatId,
    parentSessionId: (p.parentSessionId as string) ?? null,
    parentToolCallId: (p.parentToolCallId as string) ?? null,
    depth: Number(p.depth ?? 0) as 0 | 1 | 2,
    model: String(p.model ?? ''),
    providerId: (p.providerId as string) ?? null,
    title: String(p.title ?? ''),
    task: (p.task as string) ?? null,
    status: String(p.status ?? 'idle') as Session['status'],
    createdAt: Number(p.createdAt ?? 0),
    branchSel: toBranchSel(p.branchSel)
  }
}

/** StoredMessage a partir do plaintext do registro `message` (parentId ausente = legado). */
export function messageFromPlain(id: string, p: Plain): StoredMessage {
  const m: StoredMessage = {
    id,
    sessionId: String(p.sessionId ?? ''),
    seq: Number(p.seq ?? 0),
    message: (p.message ?? { role: 'user', content: '' }) as ApiMessage,
    meta: (p.meta ?? {}) as MessageMeta,
    createdAt: Number(p.createdAt ?? 0)
  }
  if (p.parentId === null || (typeof p.parentId === 'string' && p.parentId)) m.parentId = p.parentId
  return m
}

const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d)
const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d)
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null)

/**
 * Grava um registro remoto nas tabelas locais (chamar dentro de `withApply`). Lança se uma
 * referência obrigatória faltar (FK) — o engine adia e tenta de novo.
 */
export function applyRemote(
  conn: Database.Database,
  type: string,
  id: string,
  p: Plain,
  ctx: ApplyCtx = {}
): ApplyResult {
  const res = newResult()
  switch (type) {
    case 'provider': {
      conn
        .prepare(
          `INSERT INTO providers (id, name, base_url, kind, api_key, headers_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET name = excluded.name, base_url = excluded.base_url, kind = excluded.kind,
           api_key = excluded.api_key, headers_json = excluded.headers_json, created_at = excluded.created_at`
        )
        .run(
          id,
          str(p.name, 'Provider'),
          str(p.baseUrl),
          providerKind({ baseUrl: str(p.baseUrl), kind: strOrNull(p.kind) ?? undefined }),
          str(p.apiKey),
          JSON.stringify(p.headers && typeof p.headers === 'object' ? p.headers : {}),
          num(p.createdAt, Date.now())
        )
      res.scopes.add('providers')
      break
    }
    case 'setting': {
      const value = p.value ?? null
      if (id === 'defaultModel') {
        const v = (value ?? {}) as { providerId?: unknown; model?: unknown }
        setSetting(conn, 'defaultProviderId', value ? strOrNull(v.providerId) : null)
        setSetting(conn, 'defaultModel', value ? strOrNull(v.model) : null)
      } else if ((SETTING_IDS as readonly string[]).includes(id)) setSetting(conn, id, value)
      res.scopes.add('settings')
      if (id === 'approvalModes' || id === 'approvalLists' || id === 'smartApproveDefaults')
        res.scopes.add('approvals')
      if (id.startsWith('webSearch')) res.scopes.add('webSearch')
      break
    }
    case 'preset': {
      const cur = conn.prepare('SELECT config_json FROM presets WHERE id = ?').get(id) as
        { config_json: string } | undefined
      const localCwd = cur ? parse<Plain>(cur.config_json, {}).cwd : undefined
      const cfg: Plain = { ...((p.config ?? {}) as Plain) }
      delete cfg.cwd
      if (typeof localCwd === 'string' && localCwd) cfg.cwd = localCwd
      conn
        .prepare(
          `INSERT INTO presets (id, name, description, icon, config_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description, icon = excluded.icon,
           config_json = excluded.config_json, created_at = excluded.created_at, updated_at = excluded.updated_at`
        )
        .run(
          id,
          str(p.name, 'Persona'),
          str(p.description),
          str(p.icon),
          JSON.stringify(cfg),
          num(p.createdAt, Date.now()),
          num(p.updatedAt, Date.now())
        )
      res.scopes.add('presets')
      break
    }
    case 'memory_collection': {
      conn
        .prepare(
          `INSERT INTO memory_collections (id, category, name, description, icon, scope, chat_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'shared', NULL, ?, ?)
           ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description, icon = excluded.icon,
           created_at = excluded.created_at, updated_at = excluded.updated_at`
        )
        .run(
          id,
          str(p.category, 'topics'),
          str(p.name, 'Coleção'),
          str(p.description),
          strOrNull(p.icon),
          num(p.createdAt, Date.now()),
          num(p.updatedAt, Date.now())
        )
      res.scopes.add('memory')
      res.events.push({ type: 'memory-changed', collectionId: id, memoryId: null })
      break
    }
    case 'memory': {
      const collectionId = str(p.collectionId)
      let slug = str(p.slug, id)
      const createdAt = num(p.createdAt, Date.now())
      // colisão de slug (§4.3.5): a de createdAt maior (empate: id maior) ganha sufixo
      const other = conn
        .prepare('SELECT id, created_at FROM memories WHERE slug = ? AND id <> ?')
        .get(slug, id) as { id: string; created_at: number } | undefined
      if (other) {
        const incomingLoses =
          createdAt > other.created_at || (createdAt === other.created_at && id > other.id)
        if (incomingLoses) {
          slug = slugSuffix(slug, id)
          res.redirty.push({ type: 'memory', id })
        } else {
          const otherRow = conn.prepare('SELECT slug FROM memories WHERE id = ?').get(other.id) as {
            slug: string
          }
          conn
            .prepare('UPDATE memories SET slug = ? WHERE id = ?')
            .run(slugSuffix(otherRow.slug, other.id), other.id)
          res.redirty.push({ type: 'memory', id: other.id })
        }
      }
      conn
        .prepare(
          `INSERT INTO memories (id, collection_id, category, title, slug, summary, facts_json, pinned, created_at, updated_at,
             updated_by_chat_id, updated_by, supersedes_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET collection_id = excluded.collection_id, category = excluded.category,
             title = excluded.title, slug = excluded.slug, summary = excluded.summary, facts_json = excluded.facts_json,
             pinned = excluded.pinned, created_at = excluded.created_at, updated_at = excluded.updated_at,
             updated_by_chat_id = excluded.updated_by_chat_id, updated_by = excluded.updated_by,
             supersedes_id = excluded.supersedes_id`
        )
        .run(
          id,
          collectionId,
          str(p.category, 'topics'),
          str(p.title),
          slug,
          str(p.summary),
          JSON.stringify(Array.isArray(p.facts) ? p.facts : []),
          p.pinned ? 1 : 0,
          createdAt,
          num(p.updatedAt, Date.now()),
          strOrNull(p.updatedByChatId),
          str(p.updatedBy, 'user'),
          strOrNull(p.supersedesId)
        )
      res.scopes.add('memory')
      res.events.push({ type: 'memory-changed', collectionId, memoryId: id })
      break
    }
    case 'chat': {
      const cur = conn.prepare('SELECT config_json FROM chats WHERE id = ?').get(id) as
        { config_json: string } | undefined
      const localCwd = cur ? parse<Plain>(cur.config_json, {}).cwd : undefined
      const cfg: Plain = { ...((p.config ?? {}) as Plain) }
      delete cfg.cwd
      cfg.cwd =
        typeof localCwd === 'string' && localCwd ? localCwd : (ctx.defaultCwd?.() ?? homedir())
      conn
        .prepare(
          `INSERT INTO chats (id, title, config_json, main_session_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET title = excluded.title, config_json = excluded.config_json,
           main_session_id = excluded.main_session_id, created_at = excluded.created_at, updated_at = excluded.updated_at`
        )
        .run(
          id,
          str(p.title),
          JSON.stringify(cfg),
          str(p.mainSessionId) || null,
          num(p.createdAt, Date.now()),
          num(p.updatedAt, Date.now())
        )
      res.hostCwd = p.hostCwd ?? null
      res.scopes.add('chats')
      break
    }
    case 'session': {
      const status = str(p.status, 'idle')
      const chatId = str(p.chatId)
      const stored = TRANSIENT_STATUS.has(status) ? 'interrupted' : status
      conn
        .prepare(
          `INSERT INTO sessions (id, chat_id, parent_session_id, parent_tool_call_id, depth, model, provider_id, title, task,
             status, created_at, memory_json, branch_sel_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET chat_id = excluded.chat_id, parent_session_id = excluded.parent_session_id,
             parent_tool_call_id = excluded.parent_tool_call_id, depth = excluded.depth, model = excluded.model,
             provider_id = excluded.provider_id, title = excluded.title, task = excluded.task, status = excluded.status,
             created_at = excluded.created_at, memory_json = excluded.memory_json,
             branch_sel_json = excluded.branch_sel_json`
        )
        .run(
          id,
          chatId,
          strOrNull(p.parentSessionId),
          strOrNull(p.parentToolCallId),
          Math.min(2, Math.max(0, num(p.depth))),
          str(p.model),
          strOrNull(p.providerId),
          str(p.title),
          strOrNull(p.task),
          stored,
          num(p.createdAt, Date.now()),
          p.memory && typeof p.memory === 'object' ? JSON.stringify(p.memory) : null,
          // ausente (escritor < 1.2.0) = {} (§4.3.7)
          JSON.stringify(toBranchSel(p.branchSel))
        )
      const s = rowSession(conn, id)
      if (s) {
        const live = TRANSIENT_STATUS.has(status) && ctx.windowOpen?.(chatId)
        res.events.push({
          type: 'session-updated',
          session: live ? { ...s, status: status as Session['status'] } : s
        })
      }
      break
    }
    case 'message': {
      const sessionId = str(p.sessionId)
      const seq = num(p.seq, 1)
      const existed = !!conn.prepare('SELECT 1 FROM messages WHERE id = ?').get(id)
      // unicidade (session_id, seq): a ocupante vai temporariamente para seq negativo (§7.3)
      const occ = conn
        .prepare('SELECT id FROM messages WHERE session_id = ? AND seq = ? AND id <> ?')
        .get(sessionId, seq, id) as { id: string } | undefined
      if (occ) conn.prepare('UPDATE messages SET seq = -ABS(seq) WHERE id = ?').run(occ.id)
      const message = (p.message ?? { role: 'user', content: '' }) as ApiMessage
      const meta = (p.meta ?? {}) as MessageMeta
      conn
        .prepare(
          `INSERT INTO messages (id, session_id, seq, message_json, meta_json, created_at, parent_id) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET session_id = excluded.session_id, seq = excluded.seq,
           message_json = excluded.message_json, meta_json = excluded.meta_json, created_at = excluded.created_at,
           parent_id = excluded.parent_id`
        )
        .run(
          id,
          sessionId,
          seq,
          JSON.stringify(message),
          JSON.stringify(meta),
          num(p.createdAt),
          // parentId ausente (cliente < 0.7) → NULL: derivado na leitura, nunca regravado (§4.3.8)
          parentIdToColumn(p.parentId)
        )
      indexMessage(conn, id, message, meta)
      const m = rowMessage(conn, id)
      if (m) res.events.push({ type: existed ? 'message-updated' : 'message-added', message: m })
      break
    }
  }
  return res
}

/** Normaliza mensagens que ficaram com seq negativo depois de um lote (§7.3). */
export function normalizeNegativeSeqs(conn: Database.Database): AgentEvent[] {
  const rows = conn.prepare('SELECT id, session_id, seq FROM messages WHERE seq < 0').all() as {
    id: string
    session_id: string
    seq: number
  }[]
  const events: AgentEvent[] = []
  for (const r of rows) {
    const want = -r.seq
    const busy = conn
      .prepare('SELECT 1 FROM messages WHERE session_id = ? AND seq = ?')
      .get(r.session_id, want)
    if (busy) continue // espera a próxima revisão
    conn.prepare('UPDATE messages SET seq = ? WHERE id = ?').run(want, r.id)
    const m = rowMessage(conn, r.id)
    if (m) events.push({ type: 'message-updated', message: m })
  }
  return events
}

function slugSuffix(slug: string, id: string): string {
  const tail = id
    .replace(/[^A-Za-z0-9]/g, '')
    .slice(-4)
    .toLowerCase()
  return `${slug}-${tail}`
}

/** Apaga localmente (tombstone remoto). Cascatas: chat → sessões/mensagens; coleção → memórias. */
export function deleteLocal(conn: Database.Database, type: string, id: string): ApplyResult {
  const res = newResult()
  switch (type) {
    case 'provider':
      conn.prepare('DELETE FROM providers WHERE id = ?').run(id)
      res.scopes.add('providers')
      break
    case 'preset':
      conn.prepare('DELETE FROM presets WHERE id = ?').run(id)
      res.scopes.add('presets')
      break
    case 'memory_collection':
      conn.prepare('DELETE FROM memory_collections WHERE id = ?').run(id)
      res.scopes.add('memory')
      res.events.push({ type: 'memory-changed', collectionId: id, memoryId: null })
      break
    case 'memory':
      conn.prepare('DELETE FROM memories WHERE id = ?').run(id)
      res.scopes.add('memory')
      res.events.push({ type: 'memory-changed', collectionId: null, memoryId: id })
      break
    case 'chat': {
      const had = conn.prepare('SELECT 1 FROM chats WHERE id = ?').get(id)
      conn.prepare('DELETE FROM chats WHERE id = ?').run(id)
      if (had) res.events.push({ type: 'chat-deleted', chatId: id })
      res.scopes.add('chats')
      break
    }
    case 'session': {
      const s = rowSession(conn, id)
      if (!s) break
      // descendentes primeiro (FK ON DELETE CASCADE apaga, mas os eventos são por sessão)
      const all = conn
        .prepare('SELECT id, parent_session_id FROM sessions WHERE chat_id = ?')
        .all(s.chatId) as { id: string; parent_session_id: string | null }[]
      const doomed: string[] = []
      const visit = (sid: string): void => {
        for (const c of all.filter((x) => x.parent_session_id === sid)) visit(c.id)
        doomed.push(sid)
      }
      visit(id)
      conn.prepare('DELETE FROM sessions WHERE id = ?').run(id)
      for (const sid of doomed)
        res.events.push({ type: 'session-deleted', sessionId: sid, chatId: s.chatId })
      break
    }
    case 'message': {
      const m = rowMessage(conn, id)
      if (!m) break
      conn.prepare('DELETE FROM messages WHERE id = ?').run(id)
      res.events.push({ type: 'message-deleted', sessionId: m.sessionId, messageId: id })
      break
    }
  }
  return res
}

/** O registro existe localmente? */
export function existsLocal(conn: Database.Database, type: string, id: string): boolean {
  const table: Record<string, string> = {
    provider: 'providers',
    preset: 'presets',
    memory_collection: 'memory_collections',
    memory: 'memories',
    chat: 'chats',
    session: 'sessions',
    message: 'messages'
  }
  if (type === 'setting') return true
  const t = table[type]
  return !!t && !!conn.prepare(`SELECT 1 FROM ${t} WHERE id = ?`).get(id)
}

/** O chat usa ferramentas locais (§8.9)? */
export const LOCAL_TOOLS = [
  'list_dir',
  'read_file',
  'search_files',
  'find_files',
  'write_file',
  'edit_file',
  'shell',
  'process_start',
  'process_logs',
  'process_list',
  'process_stop'
]
export function usesLocalTools(config: { enabledTools?: unknown; skills?: unknown }): boolean {
  const tools = Array.isArray(config.enabledTools) ? (config.enabledTools as string[]) : []
  const skills = (config.skills ?? {}) as { enabled?: unknown }
  return (
    tools.some((t) => LOCAL_TOOLS.includes(t === 'bash' ? 'shell' : t)) || skills.enabled === true
  )
}
