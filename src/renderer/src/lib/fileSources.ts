// Fontes de arquivos do renderer — PLUGÁVEIS. A UI (painel de arquivo, cards de present_file, aba
// Arquivos) nunca chama `api.viewer`/`api.fs` direto: pede uma fonte para o chat (`sourcesFor`).
//
// - FileSource: bytes/metadados de um arquivo para o visualizador.
// - DirSource: listagem de pastas da aba Arquivos.
//
// LOCAL: protocolo clearchat-file:// + IPC do main. REMOTA (chat em controle remoto: o host é
// outro dispositivo): lib/remoteFiles.ts, registrada em lib/remoteSourcesSetup.ts via
// `registerRemoteSources` — busca do host pelo WebSocket (comandos E2EE fs.list / fs.read, em
// pedaços) e devolve os mesmos tipos com `resourceFromBytes` (blob URL / texto com os tetos de
// VIEWER_LIMITS). Ver SPEC.md → "Visualizador de arquivos (present_file)".
import type { PresentFilesRecord } from '@shared/types'
import type { ViewerFile } from '@shared/ipc'
import type { ChatHostMode } from '@shared/sync'
import { api, errorMessage } from './api'
import type { DirSource, FileSource, ViewerResource } from './fileResource'

// tipos + bytes → recurso ficam em fileResource.ts (sem window.api: a fonte remota e os testes usam)
export * from './fileResource'

// ---------------- implementação local ----------------

/** Resolve `rel` contra o arquivo base (só URLs relativas; esquemas/absolutas → null). */
function relativeAsset(baseUrl: string, rel: string): string | null {
  if (!rel || /^[a-z][a-z0-9+.-]*:/i.test(rel) || rel.startsWith('/') || rel.startsWith('#'))
    return null
  try {
    const u = new URL(rel, baseUrl)
    return u.href.startsWith(baseUrl.slice(0, baseUrl.indexOf('/', 'clearchat-file://'.length)))
      ? u.href
      : null
  } catch {
    return null
  }
}

function localResource(file: ViewerFile): ViewerResource {
  const { token, url, ...info } = file
  return {
    info,
    url,
    readText: () => api.viewer.readText(token),
    assetUrl: (rel) => (file.kind === 'markdown' ? relativeAsset(url, rel) : null),
    openExternal: () => api.viewer.openExternal(token),
    showInFolder: () => api.viewer.showInFolder(token),
    dispose: () => {}
  }
}

export const localFileSource: FileSource = {
  id: 'local',
  capabilities: { reveal: true, openNative: true, saveAs: false },
  async open(target) {
    try {
      const r = await api.viewer.open(target)
      return r.ok ? { ok: true, resource: localResource(r.file) } : r
    } catch (e) {
      return { ok: false, reason: 'error', message: errorMessage(e) }
    }
  },
  check: (chatId, messageId) => api.viewer.check(chatId, messageId).catch(() => [])
}

export const localDirSource: DirSource = {
  id: 'local',
  async listDir(_chatId, path) {
    try {
      return { ok: true, dir: path, entries: await api.fs.listDir(path) }
    } catch (e) {
      return { ok: false, reason: 'error', message: errorMessage(e) }
    }
  }
}

// ---------------- escolha da fonte ----------------

interface RemoteFactories {
  /** Fonte de arquivos do host para um chat em controle remoto (null = não disponível). */
  file?: (chatId: string) => FileSource | null
  dir?: (chatId: string) => DirSource | null
}
let remote: RemoteFactories = {}

/** O pacote do controle remoto registra aqui as fontes que falam com o host. */
export function registerRemoteSources(f: RemoteFactories): void {
  remote = f
}

/** Modo do chat que usa o host remoto (os bytes estão em outro dispositivo). */
export const isRemoteMode = (mode: ChatHostMode | undefined): boolean =>
  mode === 'remote' || mode === 'host-offline'

/** Fontes do chat: remotas se o chat roda em outro dispositivo e houver implementação; senão locais. */
export function sourcesFor(
  chatId: string,
  mode: ChatHostMode | undefined
): { file: FileSource; dir: DirSource } {
  const useRemote = isRemoteMode(mode)
  return {
    file: (useRemote && remote.file?.(chatId)) || localFileSource,
    dir: (useRemote && remote.dir?.(chatId)) || localDirSource
  }
}

/**
 * Onde estão os arquivos de uma chamada de present_file, só pelo registro sincronizado (sem
 * perguntar ao main): `local` (este computador), ou `remote` com o nome do dispositivo.
 */
export function presentedPlace(
  rec: PresentFilesRecord,
  myDeviceId: string | null | undefined,
  host: { mode?: ChatHostMode; name?: string | null }
): { where: 'local' } | { where: 'remote'; deviceName: string } {
  if (rec.deviceId && myDeviceId)
    return rec.deviceId === myDeviceId
      ? { where: 'local' }
      : { where: 'remote', deviceName: rec.deviceName ?? 'outro dispositivo' }
  if (isRemoteMode(host.mode)) return { where: 'remote', deviceName: host.name ?? 'host' }
  return { where: 'local' }
}

/**
 * Pode abrir sozinho no painel (present_file acabou de rodar)? Local, ou no HOST atual do chat
 * com fonte remota e o chat aberto na tela (`visible` — buscar do host custa rede); arquivo de um
 * terceiro dispositivo não abre sozinho ("Arquivo no <outro>").
 */
export function canAutoOpen(
  rec: PresentFilesRecord,
  chatId: string,
  myDeviceId: string | null | undefined,
  host: { mode?: ChatHostMode; name?: string | null; deviceId?: string | null },
  visible = true
): boolean {
  const place = presentedPlace(rec, myDeviceId, host)
  if (place.where === 'local') return true
  if (!visible || !isRemoteMode(host.mode) || !remote.file?.(chatId)) return false
  return !rec.deviceId || !host.deviceId || rec.deviceId === host.deviceId
}

/** Ações disponíveis para um recurso aberto: capacidade da fonte E a função presente no recurso. */
export function resourceActions(
  source: FileSource,
  resource: ViewerResource | null
): {
  openExternal?: () => Promise<void>
  showInFolder?: () => Promise<void>
  saveAs?: () => Promise<void>
} {
  if (!resource) return {}
  const c = source.capabilities
  return {
    ...(c.openNative && resource.openExternal ? { openExternal: resource.openExternal } : {}),
    ...(c.reveal && resource.showInFolder ? { showInFolder: resource.showInFolder } : {}),
    ...(c.saveAs && resource.saveAs ? { saveAs: resource.saveAs } : {})
  }
}
