// Fontes de arquivos do renderer — PLUGÁVEIS. A UI (painel de arquivo, cards de present_file, aba
// Arquivos) nunca chama `api.viewer`/`api.fs` direto: pede uma fonte para o chat (`sourcesFor`).
//
// - FileSource: bytes/metadados de um arquivo para o visualizador.
// - DirSource: listagem de pastas da aba Arquivos.
//
// Hoje só existe a implementação LOCAL (protocolo clearchat-file:// + IPC do main). Num aparelho
// em controle remoto, um pacote futuro registra as remotas (`registerRemoteSources`) que buscam do
// host pelo WebSocket (comandos E2EE, em pedaços): elas devolvem os mesmos tipos e usam
// `resourceFromBytes` (blob URL / texto com os tetos de VIEWER_LIMITS) — sem mexer nos componentes.
// Ver SPEC.md → "Visualizador de arquivos (present_file)".
import type { DirEntry, PresentFilesRecord, ViewerKind } from '@shared/types'
import type {
  ViewerCheck,
  ViewerFile,
  ViewerTarget,
  ViewerText,
  ViewerUnavailable
} from '@shared/ipc'
import type { ChatHostMode } from '@shared/sync'
import { VIEWER_LIMITS } from '@shared/fileViewer'
import { api, errorMessage } from './api'

/** Metadados do arquivo aberto (iguais para qualquer fonte). */
export type ViewerFileInfo = Omit<ViewerFile, 'token' | 'url'>

/** Arquivo aberto no visualizador, independente de onde vêm os bytes. */
export interface ViewerResource {
  info: ViewerFileInfo
  /** URL carregável por <img>/<iframe> (local: clearchat-file://…; remota: blob:…). null = sem. */
  url: string | null
  /** Texto (markdown/código/texto), até VIEWER_LIMITS.textMaxBytes (`truncated` acima disso). */
  readText(signal?: AbortSignal): Promise<ViewerText>
  /** Link relativo do markdown (imagens) → URL carregável; null = indisponível. */
  assetUrl(rel: string): string | null
  /**
   * Ações (presentes conforme `FileSource.capabilities`): abrir no app padrão (local: direto;
   * remota: baixa para um temporário e abre), mostrar na pasta (só local), salvar como… (remota:
   * diálogo do main grava os bytes buscados).
   */
  openExternal?: () => Promise<void>
  showInFolder?: () => Promise<void>
  saveAs?: () => Promise<void>
  /** Libera recursos (blob URLs). Chamado ao trocar de arquivo / fechar. */
  dispose(): void
}

/** Por que não abriu: os motivos do main + "host offline" (fonte remota sem conexão). */
export type FileUnavailable = ViewerUnavailable | 'host-offline' | 'error'

export type FileOpenResult =
  | { ok: true; resource: ViewerResource }
  | { ok: false; reason: FileUnavailable; message: string; deviceName?: string }

export interface FileOpenOptions {
  signal?: AbortSignal
  /** Progresso (fonte remota em pedaços); `total` = tamanho, se conhecido. */
  onProgress?: (loaded: number, total?: number) => void
}

/** O que a UI pode oferecer para arquivos desta fonte (barra do painel, cards, tipo sem prévia). */
export interface FileSourceCapabilities {
  /** "Mostrar na pasta" / "Mostrar local do arquivo no explorador" — nunca para arquivo remoto. */
  reveal: boolean
  /** "Abrir no app" / "Abrir arquivo" (remota: baixa para temporário e abre). */
  openNative: boolean
  /** "Salvar como…" (remota: diálogo de salvar no main com os bytes buscados). */
  saveAs: boolean
}

export interface FileSource {
  readonly id: 'local' | 'remote'
  readonly capabilities: FileSourceCapabilities
  open(target: ViewerTarget, opts?: FileOpenOptions): Promise<FileOpenResult>
  /** Estado dos arquivos de uma chamada de present_file (cards), sem abrir nada. */
  check(chatId: string, messageId: string): Promise<ViewerCheck[]>
}

export type DirListResult =
  | { ok: true; dir: string; entries: DirEntry[] }
  | { ok: false; reason: 'host-offline' | 'denied' | 'error'; message: string }

export interface DirSource {
  readonly id: 'local' | 'remote'
  /** Lista `path` (absoluto) do chat — a fonte remota aplica a raiz/confinamento do host. */
  listDir(chatId: string, path: string, signal?: AbortSignal): Promise<DirListResult>
}

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

// ---------------- bytes → recurso (para a fonte remota) ----------------

/**
 * Monta um ViewerResource a partir dos BYTES do arquivo (fonte remota): imagem/PDF/HTML viram
 * blob URL; texto é decodificado com o teto de VIEWER_LIMITS (o chamador pode mandar só o começo
 * de um arquivo grande — `info.size` é o tamanho real). Assets relativos do markdown: `assetUrl`.
 * Precisa de `blob:` em img-src/frame-src no CSP quando for usada.
 */
export function resourceFromBytes(
  info: ViewerFileInfo,
  bytes: Uint8Array,
  opts: {
    assetUrl?: (rel: string) => string | null
    openExternal?: () => Promise<void>
    saveAs?: () => Promise<void>
  } = {}
): ViewerResource {
  let url: string | null = null
  const binaryKinds: ViewerKind[] = ['image', 'pdf', 'html']
  if (binaryKinds.includes(info.kind) && bytes.length <= VIEWER_LIMITS.binaryMaxBytes)
    url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: info.mime }))
  return {
    info,
    url,
    readText: async () => {
      const max = VIEWER_LIMITS.textMaxBytes
      const slice = bytes.subarray(0, Math.min(bytes.length, max))
      let content = new TextDecoder('utf-8').decode(slice)
      const truncated = info.size > slice.length
      if (truncated) content = content.replace(/�+$/, '')
      return { content, truncated, size: info.size }
    },
    assetUrl: opts.assetUrl ?? (() => null),
    ...(opts.openExternal ? { openExternal: opts.openExternal } : {}),
    ...(opts.saveAs ? { saveAs: opts.saveAs } : {}),
    dispose: () => {
      if (url) URL.revokeObjectURL(url)
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

/** Pode abrir sozinho no painel (present_file acabou de rodar)? Local, ou remoto com fonte remota. */
export function canAutoOpen(
  rec: PresentFilesRecord,
  chatId: string,
  myDeviceId: string | null | undefined,
  host: { mode?: ChatHostMode; name?: string | null }
): boolean {
  const place = presentedPlace(rec, myDeviceId, host)
  return place.where === 'local' || !!remote.file?.(chatId)
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
