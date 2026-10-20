// Arquivos buscados de OUTRO dispositivo (controle remoto) que o usuário pede para abrir no app
// padrão ou executar: cópia temporária em userData/tmp-viewer/<aleatório>/<nome> (pasta 0700; só o
// dono lê), apagada ao abrir e ao fechar o app. Sem Electron (testável). Ver SPEC → "Visualizador
// de arquivos".
import { randomBytes } from 'crypto'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { REMOTE_FS_LIMITS, safeFileName } from '@shared/remoteFs'
import { openBlockedReason } from '@shared/fileActions'

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

/** Grava `buf` em <dir>/<aleatório>/<nome> (pasta 0700, `wx`) e devolve o caminho. */
function writeTemp(safe: string, buf: Buffer, mode: number, dir: string | null): string {
  if (!dir) throw new Error('Pasta temporária indisponível.')
  const sub = join(dir, randomBytes(8).toString('hex'))
  mkdirSync(sub, { recursive: true, mode: 0o700 })
  const file = join(sub, safe)
  writeFileSync(file, buf, { mode, flag: 'wx' })
  return file
}

/**
 * Cópia para "Abrir no app" (0600). Recusa o que o sistema EXECUTARIA ao abrir — executável deste
 * sistema ("Executar…"), de outro sistema e os tipos que o app padrão roda (scripts do Windows
 * Script Host, atalhos, pacotes…): para esses, "Salvar como…". Ver @shared/fileActions.
 */
export function writeViewerTemp(
  name: string,
  bytes: unknown,
  dir = tempRoot,
  platform: string = process.platform
): string {
  if (!dir) throw new Error('Pasta temporária indisponível.')
  const safe = safeFileName(name)
  const blocked = openBlockedReason(safe, platform, { remote: true })
  if (blocked) throw new Error(blocked)
  return writeTemp(safe, checkedBytes(bytes), 0o600, dir)
}

/**
 * Cópia para "Executar…" (src/main/fileRun.ts, depois da confirmação): arquivo 0700 (o dono pode
 * executar — AppImage / .command), na mesma pasta privada. A classificação é do chamador.
 */
export function writeViewerTempForRun(safe: string, buf: Buffer, dir = tempRoot): string {
  return writeTemp(safeFileName(safe), buf, 0o700, dir)
}

/** Caminho que uma cópia teria (validação do plano antes da confirmação; nada é criado). */
export function viewerTempPathFor(safe: string, dir = tempRoot): string {
  if (!dir) throw new Error('Pasta temporária indisponível.')
  return join(dir, '0'.repeat(16), safeFileName(safe))
}
