// Arquivos do HOST vistos de um controle remoto (aba Arquivos + visualizador): tetos e formatos
// dos comandos remotos `fs.list` / `fs.read` (docs/SYNC_PROTOCOL.md §8.6, desde 1.3.0). Puro —
// usado pelo host (main), pelo controle remoto (main → IPC) e pela fonte remota do renderer.
// Ver SPEC.md → "Visualizador de arquivos (present_file)" → "Controle remoto".

export const REMOTE_FS_LIMITS = {
  /**
   * Bytes crus por `fs.read`. Em base64 dentro do JSON cifrado dá ~700 KB de envelope — abaixo do
   * `COMMAND_MAX_BYTES` (1 MiB) que o servidor aplica ao `remote.result` e bem abaixo do frame de
   * 4 MiB do WebSocket. O host corta pedidos maiores para este teto.
   */
  chunkBytes: 512 * 1024,
  /** Teto do total buscado de um arquivo (o host recusa ler além disto). */
  maxFileBytes: 200 * 1024 * 1024,
  /** Pedaços em voo ao mesmo tempo (fila do servidor: ~0,7 MB cada, bem abaixo de 8 MiB). */
  concurrency: 3,
  /** Entradas por `fs.list` (acima: `truncated`) e orçamento do JSON da resposta. */
  listMaxEntries: 5000,
  listMaxJsonBytes: 600 * 1024,
  /** Tempo de espera do controle remoto por resposta (o servidor desiste em 30 s). */
  timeoutMs: 35_000,
  /** Cache em memória do renderer: últimos arquivos buscados (bytes) e o teto total. */
  cacheFiles: 6,
  cacheBytes: 64 * 1024 * 1024
} as const

/** Entrada de `fs.list` no fio (§8.6). */
export interface RemoteFsEntry {
  name: string
  kind: 'file' | 'dir'
  size?: number
  mtime?: number
}

/** Por que o pedido falhou (controle remoto). `unsupported` = host ou servidor antigo demais. */
export type RemoteFsFailureReason = 'host-offline' | 'denied' | 'missing' | 'unsupported' | 'error'

export interface RemoteFsFailure {
  ok: false
  reason: RemoteFsFailureReason
  /** Texto pronto (pt-BR). */
  message: string
  /** Nome do host (para "Arquivo no <host>"). */
  deviceName?: string
}

export type RemoteDirResult =
  | {
      ok: true
      /** Pasta listada (absoluta, no formato do host). */
      dir: string
      /** Raiz do chat no host e se a navegação fica confinada a ela. */
      root: string
      confine: boolean
      /** Pasta com mais entradas do que cabem numa resposta. */
      truncated: boolean
      entries: RemoteFsEntry[]
    }
  | RemoteFsFailure

export type RemoteReadResult =
  | {
      ok: true
      /** Tamanho e mtime atuais do arquivo no host (mudou no meio → recomeçar). */
      size: number
      mtime: number
      mime?: string
      offset: number
      data: Uint8Array
    }
  | RemoteFsFailure

/** Códigos de recusa que o host manda junto com o `error` em pt-BR (§8.6). */
export type RemoteFsRejectCode = 'denied' | 'missing' | 'invalid' | 'too_large'

/** Nome seguro para um arquivo local (temporário / sugestão do "Salvar como…"). */
export function safeFileName(name: string): string {
  const base = String(name ?? '')
    .split(/[\\/]/)
    .pop()!
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f<>:"|?*]/g, '_')
    .trim()
    .slice(0, 180)
  return base && base !== '.' && base !== '..' ? base : 'arquivo'
}

/**
 * Extensões que o sistema EXECUTA em vez de abrir (atalhos, scripts, instaladores, apps): "Abrir no
 * app" de um arquivo vindo de outro dispositivo recusa — o usuário pode "Salvar como…" e decidir.
 */
const EXECUTABLE_EXTS = new Set(
  (
    'exe com bat cmd msi msp msc scr pif cpl lnk url ps1 psm1 vbs vbe js jse wsf wsh hta reg ' +
    'jar app command tool desktop sh bash zsh csh run bin appimage deb rpm pkg dmg scpt workflow'
  ).split(/\s+/)
)

export function isExecutableName(name: string): boolean {
  const base = safeFileName(name).toLowerCase()
  const i = base.lastIndexOf('.')
  return i > 0 && EXECUTABLE_EXTS.has(base.slice(i + 1))
}
