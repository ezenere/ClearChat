// Prévia de script no card de aprovação (main): lê o começo dos arquivos que os sub-comandos
// executam (`python3 x.py`, `./run.sh`…), relativo ao diretório em que o comando vai rodar (o cwd
// do shell da sessão; `cd dir && …` no começo da linha é seguido). Leitura limitada a 64 KiB, só
// arquivo regular; binário/inexistente viram um aviso. A detecção é pura (@shared/scriptPreview).
import { open, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, resolve } from 'node:path'
import { looksBinary, SCRIPT_PREVIEW, scriptHead } from '@shared/scriptPreview'
import type { ApprovalCheck, ApprovalScript } from '@shared/types'

const unquote = (t: string): string => t.replace(/^(['"])(.*)\1$/, '$2')

/** Caminho como o shell resolveria (`~` → home; relativo → `dir`). */
export function resolveScriptPath(p: string, dir: string): string {
  const t = unquote(p.trim())
  if (t === '~' || t.startsWith('~/')) return resolve(homedir(), t.slice(2))
  return isAbsolute(t) ? t : resolve(dir, t)
}

/** Lê o começo de um arquivo de script (≤ 64 KiB) e monta a prévia. Nunca lança. */
export async function readScriptPreview(
  script: ApprovalScript,
  dir: string
): Promise<ApprovalScript> {
  if (script.status !== 'pending' || !script.path) return script
  const resolved = resolveScriptPath(script.path, dir)
  const out: ApprovalScript = { ...script, resolved }
  try {
    const st = await stat(resolved)
    if (!st.isFile()) return { ...out, status: 'notfile' }
    const fh = await open(resolved, 'r')
    try {
      const len = Math.min(st.size, SCRIPT_PREVIEW.readBytes)
      const buf = Buffer.alloc(len)
      const { bytesRead } = await fh.read(buf, 0, len, 0)
      const text = buf.subarray(0, bytesRead).toString('utf8')
      if (looksBinary(text)) return { ...out, status: 'binary' }
      const h = scriptHead(text, SCRIPT_PREVIEW.cardLines, SCRIPT_PREVIEW.cardChars)
      return {
        ...out,
        status: 'ok',
        content: h.head,
        lines: h.lines,
        ...(st.size > SCRIPT_PREVIEW.readBytes ? { partial: true } : {}),
        ...(h.truncated || st.size > SCRIPT_PREVIEW.readBytes ? { truncated: true } : {})
      }
    } finally {
      await fh.close()
    }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    return { ...out, status: code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'error' }
  }
}

/**
 * Preenche as prévias pendentes de um card (cópia). `dir` = onde o comando roda; um `cd <dir>`
 * literal no nível de cima, antes do item, muda o diretório dos seguintes (`cd app && python x.py`).
 */
export async function fillScriptPreviews(
  check: ApprovalCheck,
  dir: string
): Promise<ApprovalCheck> {
  if (!check.items.some((i) => i.script?.status === 'pending')) return check
  let cur = dir
  const items = []
  for (const it of check.items) {
    const cd = !it.depth && !it.group ? /^cd\s+(\S+)$/.exec(it.text) : null
    if (cd) cur = resolveScriptPath(cd[1], cur)
    items.push(
      it.script?.status === 'pending'
        ? { ...it, script: await readScriptPreview(it.script, cur) }
        : it
    )
  }
  return { ...check, items }
}
