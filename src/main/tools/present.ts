// present_file: mostra arquivos ao usuário (cards no chat + painel de arquivo). Só leitura — nada
// do conteúdo volta ao modelo; o resultado só confirma o que foi apresentado. Mesmas regras de
// caminho do read_file (raiz do chat, `~`, confinamento após realpath). Sem Electron (testável):
// a allowlist do protocolo e o dispositivo são aplicados pelo runner com `meta.presentFiles`.
import { promises as fs } from 'fs'
import { basename } from 'path'
import type { PresentedFile } from '@shared/types'
import {
  detectViewerKind,
  parsePresentFileArgs,
  presentResultText,
  VIEWER_LIMITS
} from '@shared/fileViewer'
import {
  displayPath,
  fail,
  resolveToolPath,
  ToolError,
  type ToolContext,
  type ToolResult
} from './util'

/** Erro curto (pt-BR) de um arquivo que não pôde ser apresentado. */
export function presentErrorText(e: unknown): string {
  if (e instanceof ToolError) {
    return /fora do diretório raiz/.test(e.message)
      ? 'fora do diretório raiz (acesso negado)'
      : e.message.replace(/^Erro:\s*/, '')
  }
  const code = (e as NodeJS.ErrnoException).code
  if (code === 'ENOENT' || code === 'ENOTDIR') return 'não encontrado'
  if (code === 'EACCES' || code === 'EPERM') return 'permissão negada'
  if (code === 'ELOOP') return 'laço de links simbólicos'
  return (e as Error).message ?? String(e)
}

async function readHead(path: string): Promise<Uint8Array> {
  const fh = await fs.open(path, 'r')
  try {
    const buf = Buffer.alloc(VIEWER_LIMITS.sniffBytes)
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
    return buf.subarray(0, bytesRead)
  } finally {
    await fh.close()
  }
}

export async function presentFileTool(
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  const parsed = parsePresentFileArgs(args)
  if ('error' in parsed) return fail(`Erro: ${parsed.error}`)
  const files: PresentedFile[] = []
  const entries: { shown: string; error?: string }[] = []
  for (const req of parsed.files) {
    const base: PresentedFile = {
      path: req.path,
      name: basename(req.path),
      ...(req.title ? { title: req.title } : {}),
      ...(req.description ? { description: req.description } : {})
    }
    try {
      const abs = await resolveToolPath(ctx, req.path)
      base.path = abs
      base.name = basename(abs)
      const st = await fs.stat(abs)
      if (st.isDirectory()) throw new ToolError('é um diretório')
      if (!st.isFile()) throw new ToolError('não é um arquivo comum')
      base.size = st.size
      base.kind = detectViewerKind(abs, await readHead(abs))
      files.push(base)
      entries.push({ shown: displayPath(ctx.cwd, abs) })
    } catch (e) {
      const error = presentErrorText(e)
      files.push({ ...base, error })
      entries.push({ shown: req.path, error })
    }
  }
  const r = presentResultText(entries)
  return {
    content: r.text,
    status: r.ok ? 'ok' : 'error',
    meta: { presentFiles: { files } }
  }
}
