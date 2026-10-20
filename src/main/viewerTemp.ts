// Arquivos buscados de OUTRO dispositivo (controle remoto) que o usuário pede para abrir no app
// padrão: cópia temporária em userData/tmp-viewer/<aleatório>/<nome> (só leitura para o dono),
// apagada ao abrir e ao fechar o app. Sem Electron (testável). Ver SPEC → "Visualizador de arquivos".
import { randomBytes } from 'crypto'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { isExecutableName, REMOTE_FS_LIMITS, safeFileName } from '@shared/remoteFs'

let tempRoot: string | null = null

/** index.ts define a pasta (userData/tmp-viewer) e já limpa o que sobrou da execução anterior. */
export function setViewerTempDir(dir: string): void {
  tempRoot = dir
  cleanViewerTemp()
}

/** Apaga todos os temporários (startup / saída). */
export function cleanViewerTemp(): void {
  if (!tempRoot) return
  try {
    rmSync(tempRoot, { recursive: true, force: true })
  } catch {
    /* arquivo aberto em outro app (Windows): fica para a próxima limpeza */
  }
}

/** Bytes vindos do renderer (IPC) → Buffer, conferindo tipo e teto. */
export function checkedBytes(bytes: unknown): Buffer {
  if (!(bytes instanceof Uint8Array)) throw new Error('Conteúdo inválido.')
  if (bytes.length > REMOTE_FS_LIMITS.maxFileBytes)
    throw new Error(
      `Arquivo grande demais (máximo ${Math.round(REMOTE_FS_LIMITS.maxFileBytes / 1024 / 1024)} MB).`
    )
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length)
}

/**
 * Grava a cópia temporária e devolve o caminho. Recusa tipos que o sistema EXECUTA (scripts,
 * instaladores, atalhos): para esses, "Salvar como…".
 */
export function writeViewerTemp(name: string, bytes: unknown, dir = tempRoot): string {
  if (!dir) throw new Error('Pasta temporária indisponível.')
  const safe = safeFileName(name)
  if (isExecutableName(safe))
    throw new Error(
      'Por segurança, arquivos executáveis de outro dispositivo não são abertos direto — use “Salvar como…”.'
    )
  const buf = checkedBytes(bytes)
  const sub = join(dir, randomBytes(8).toString('hex'))
  mkdirSync(sub, { recursive: true, mode: 0o700 })
  const file = join(sub, safe)
  writeFileSync(file, buf, { mode: 0o600, flag: 'wx' })
  return file
}
