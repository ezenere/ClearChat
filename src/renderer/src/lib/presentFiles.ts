// Arquivos de uma chamada de present_file para os cards (puro).
import type { PresentedFile, StoredMessage } from '@shared/types'
import { fileNameOf, parsePresentFileArgs, type PresentFileRequest } from '@shared/fileViewer'

/** Arquivos da chamada: do registro do resultado (meta) ou, antes dele, dos argumentos. */
export function presentedFilesOf(
  args: string,
  result?: StoredMessage
): { files: PresentedFile[]; fromResult: boolean } | null {
  const rec = result?.meta.presentFiles
  if (rec?.files.length) return { files: rec.files, fromResult: true }
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(args || '{}')
  } catch {
    return null
  }
  const r = parsePresentFileArgs(parsed)
  if ('error' in r) return null
  return {
    files: r.files.map((f: PresentFileRequest) => ({ ...f, name: fileNameOf(f.path) })),
    fromResult: false
  }
}
