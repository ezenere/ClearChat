// Tipos do sync compartilhados entre main e renderer (IPC `sync:*` e eventos). O protocolo em si
// está em docs/SYNC_PROTOCOL.md; o cliente roda no main (src/main/sync/).
import type { Session, StoredMessage } from './types'

/** Servidor oficial (padrão). Qualquer instância self-host funciona igual (§20). */
export const OFFICIAL_SYNC_URL = 'https://clear.ezenere.com'
export const OFFICIAL_SYNC_LABEL = 'clear.ezenere.com'
/** Faixa de versões do protocolo que este app fala. */
export const SYNC_PROTOCOL = 1

export type SyncServerKind = 'official' | 'self'

/** `GET <base>/api/info` validado. */
export interface SyncServerInfo {
  url: string
  name: string
  serverVersion?: string
  protocol: { min: number; max: number; version?: string }
  signupOpen: boolean
  captcha: boolean
  signupUrl?: string
  /** `http://` (sem criptografia de transporte). */
  insecure: boolean
}

export type SyncConnection = 'disabled' | 'offline' | 'connecting' | 'online' | 'error'

/**
 * Fase da conta neste dispositivo:
 * - signed-out: sem conta
 * - locked: logado (tokens), mas a DEK não está em memória (pede a senha de criptografia)
 * - keys-not-ready: conta sem chaves (definir senha de criptografia no site)
 * - merge: desbloqueado, aguardando a escolha do primeiro login (priorizar online/local)
 * - ready: sincronizando
 */
export type SyncPhase = 'signed-out' | 'locked' | 'keys-not-ready' | 'merge' | 'ready'

export interface SyncMergeInfo {
  local: { providers: number; chats: number; presets: number; memories: number }
  online: { providers: number; chats: number; presets: number; memories: number }
  /** Chats que existem nos dois lados com histórias diferentes (a versão não priorizada é apagada). */
  conflictingChats: number
}

/** Pergunta pendente do sync (diálogo). */
export type SyncPrompt = {
  kind: 'chat-gone'
  chatId: string
  title: string
}

export interface SyncStatus {
  phase: SyncPhase
  server: { kind: SyncServerKind; url: string; name: string | null; envOverride: boolean }
  account: { userId: string; email: string; name: string } | null
  device: { id: string; name: string } | null
  connection: SyncConnection
  /** Última sincronização completa (pull + push sem erro). */
  lastSyncAt: number | null
  /** Mudanças locais ainda não aceitas pelo servidor. */
  pending: number
  error: string | null
  /** Cota excedida: o app para de enviar (continua recebendo). */
  quota: string | null
  /** "Lembrar neste computador" (DEK no chaveiro do SO). */
  remember: boolean
  merge: SyncMergeInfo | null
  prompts: SyncPrompt[]
  /** Protocolo incompatível com o servidor (não sincroniza). */
  protocolError: string | null
}

export interface SyncDevice {
  id: string
  name: string
  platform: string
  client: string
  appVersion: string
  canHost: boolean
  createdAt: string
  lastSeenAt: string | null
  lastIp: string | null
  online: boolean
  current: boolean
}

export type HostStatus = 'online' | 'grace' | 'offline'

/**
 * Como este dispositivo trata o chat (§8):
 * - off: sync desligado / bloqueado — tudo local
 * - local: este dispositivo é (ou será) o host
 * - remote: outro dispositivo online é o host → controle remoto
 * - host-offline: o host é outro dispositivo e está offline/caiu → só "Executar neste dispositivo"
 * - offline: sem conexão com o servidor — execução local (reconciliada depois)
 * - diverged: versões divergentes; nada sincroniza até escolher
 */
export type ChatHostMode = 'off' | 'local' | 'remote' | 'host-offline' | 'offline' | 'diverged'

export interface ChatHostInfo {
  chatId: string
  mode: ChatHostMode
  host: { deviceId: string; name: string; status: HostStatus; self: boolean } | null
  running: boolean
  pinned: boolean
  epoch: number
  handover: {
    toDeviceId: string
    toName: string
    mode: 'next_turn' | 'force'
    self: boolean
  } | null
  diverged: {
    divergenceId: string
    deviceId: string
    deviceName: string
    since: string
    /** Este dispositivo tem a versão local divergente. */
    self: boolean
  } | null
  usesLocalTools: boolean
  /** Raiz do chat no host (informativo). */
  hostCwd: { deviceId: string; path: string } | null
  /** Este dispositivo ainda não escolheu a raiz local do chat (pedir ao virar host). */
  needsCwd: boolean
}

export interface CloudSkill {
  name: string
  description: string
  recordId: string
  size: number
  files: number
  updatedAt: number
  /** Neste dispositivo: pasta de origem acompanhada, cópia baixada ou nada. */
  local: 'source' | 'copy' | null
}

export interface DivergenceVersion {
  sessions: Session[]
  messages: Record<string, StoredMessage[]>
}

export interface DivergenceDetails {
  chatId: string
  online: DivergenceVersion
  /** Só no dispositivo que tem a versão local divergente. */
  local: DivergenceVersion | null
  /** Mensagens que só existem em cada versão (+ data da mais antiga delas). */
  onlyOnline: { count: number; since: number | null }
  onlyLocal: { count: number; since: number | null }
}

/** O que mudou nas tabelas locais por causa do sync (o renderer recarrega). */
export type SyncScope =
  'providers' | 'presets' | 'settings' | 'chats' | 'memory' | 'skills' | 'approvals' | 'webSearch'

export interface TakeoverOptions {
  mode: 'next_turn' | 'force'
  confirmPinned?: boolean
}
