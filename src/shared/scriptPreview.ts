// Prévia de script no card de aprovação (e no contexto do Smart-Approve): quando um sub-comando
// executa um arquivo local (`python3 x.py`, `node x.js`, `bash x.sh`, `./script`…) o app mostra o
// começo do arquivo debaixo do item; com código inline (`python -c '…'`, `node -e '…'`), o código.
// Aqui fica a parte PURA (detecção a partir das palavras do comando e o recorte do texto); a leitura
// do arquivo (limitada a 64 KiB) é do main (src/main/scriptPreview.ts). Ver SPEC.md → "Aprovações
// → Prévia de script".
import type { ApprovalCheckItem } from './types'

/** Script detectado num sub-comando (antes da leitura). */
export type ScriptRef =
  | { kind: 'file'; path: string; interpreter: string }
  | { kind: 'inline'; code: string; interpreter: string }

export const SCRIPT_PREVIEW = {
  /** Card: até 15 linhas / 1.200 chars. */
  cardLines: 15,
  cardChars: 1200,
  /** Juiz: até 10 linhas / 800 chars. */
  judgeLines: 10,
  judgeChars: 800,
  /** Leitura máxima do arquivo (main). */
  readBytes: 64 * 1024
} as const

const base = (s: string): string => s.slice(s.lastIndexOf('/') + 1)

interface InterpSpec {
  /** Opções que consomem a palavra seguinte (ou `-Xvalor` colado). */
  withArg?: string[]
  /** Opções cujo valor é código inline (o resto não é arquivo). */
  inline?: string[]
  /** Opções que trocam o arquivo por outra coisa (`python -m mod`) → sem prévia. */
  stop?: string[]
  /** Subcomando obrigatório antes do arquivo (`deno run x.ts`). */
  sub?: string[]
  /** Subcomando opcional (`bun run x.ts` ou `bun x.ts`). */
  optSub?: string[]
  /** Opção que precede o arquivo (`pwsh -File x.ps1`). */
  fileFlag?: string[]
}

const PY: InterpSpec = { withArg: ['-W', '-X', '-Q'], inline: ['-c'], stop: ['-m'] }
const NODE: InterpSpec = {
  withArg: [
    '-r',
    '--require',
    '--import',
    '--loader',
    '--experimental-loader',
    '-C',
    '--conditions',
    '--env-file',
    '--title'
  ],
  inline: ['-e', '--eval', '-p', '--print']
}
const SHELL: InterpSpec = { withArg: ['-o', '-O', '+o', '+O'], stop: ['-c', '-s', '-i'] }

/** Interpretadores conhecidos (pelo basename do programa). */
const INTERPRETERS: Record<string, InterpSpec> = {
  python: PY,
  python2: PY,
  python3: PY,
  pypy: PY,
  pypy3: PY,
  node: NODE,
  nodejs: NODE,
  bash: SHELL,
  sh: SHELL,
  zsh: SHELL,
  dash: SHELL,
  ksh: SHELL,
  fish: { inline: ['-c', '--command'] },
  ruby: { withArg: ['-I', '-r', '-C', '-E'], inline: ['-e'] },
  perl: { withArg: ['-I', '-M', '-m'], inline: ['-e', '-E'] },
  php: { withArg: ['-d', '-c', '-z'], inline: ['-r'] },
  deno: { sub: ['run'], inline: [] },
  bun: { optSub: ['run'], inline: ['-e', '--eval'] },
  tsx: { withArg: ['--tsconfig'], inline: ['-e', '--eval', '-p', '--print'] },
  'ts-node': {
    withArg: ['-P', '--project', '-r', '--require', '-O', '--compiler-options'],
    inline: ['-e', '--eval', '-p', '--print']
  },
  rscript: { inline: ['-e'] },
  lua: { withArg: ['-l'], inline: ['-e'] },
  pwsh: { fileFlag: ['-File', '-f'], inline: ['-Command', '-c'] },
  powershell: { fileFlag: ['-File', '-f'], inline: ['-Command', '-c'] }
}

/** `python3.12`, `python3.11` → python3. */
function interpName(prog: string): string {
  const b = base(prog).toLowerCase()
  const py = /^(python[23]?)(\.\d+)*$/.exec(b)
  if (py) return py[1]
  return b === 'rscript' ? 'rscript' : b
}

/**
 * Detecta o script que um sub-comando executa (palavras sem aspas). `npx tsx x.ts` / `npx ts-node`
 * pulam o npx. Caminho executável (`./run.sh`, `bin/x`, `/abs/x`) também conta. Sem script (só o
 * interpretador, `python -m mod`, `bash -c`, que já é desmontado) → null.
 */
export function detectScript(tokens: string[]): ScriptRef | null {
  let t = tokens.filter((x) => x !== '')
  if (!t.length) return null
  // npx/pnpm dlx/bunx tsx …
  if (['npx', 'bunx'].includes(base(t[0])) || (base(t[0]) === 'pnpm' && t[1] === 'dlx')) {
    t = t.slice(base(t[0]) === 'pnpm' ? 2 : 1)
    while (t.length && t[0].startsWith('-')) t = t.slice(1)
    if (!t.length || !['tsx', 'ts-node'].includes(base(t[0]))) return null
  }
  const prog = t[0]
  const name = interpName(prog)
  const spec = INTERPRETERS[name]
  if (!spec) {
    // caminho executável: tem "/" (./x, bin/x, /abs/x) e não é um diretório óbvio
    // (programas do sistema por caminho absoluto — /bin/rm, /usr/bin/env — não são "scripts")
    if (
      prog.includes('/') &&
      !prog.endsWith('/') &&
      !/^\/(usr\/)?(local\/)?s?bin\//.test(prog) &&
      !prog.startsWith('/opt/homebrew/bin/')
    )
      return fileRef(prog, base(prog))
    return null
  }
  let i = 1
  if (spec.sub) {
    if (!spec.sub.includes(t[1] ?? '')) return null
    i = 2
  } else if (spec.optSub && spec.optSub.includes(t[1] ?? '')) i = 2
  const opt = (tok: string, list?: string[]): string | null => {
    for (const o of list ?? []) {
      if (tok === o) return o
      // valor colado: `-cprint(1)` (opção curta) ou `--eval=…`
      if (o.startsWith('--') ? tok.startsWith(`${o}=`) : o.length === 2 && tok.startsWith(o))
        return o
    }
    return null
  }
  for (; i < t.length; i++) {
    const tok = t[i]
    if (tok === '--') {
      i++
      break
    }
    // `python3 - arg…` / `node - arg…`: o script vem do stdin (heredoc, pipe) — o resto é argv
    if (tok === '-') return null
    if (spec.fileFlag) {
      const ff = spec.fileFlag.find((f) => f.toLowerCase() === tok.toLowerCase())
      if (ff) return fileRef(t[i + 1], name)
    }
    if (!tok.startsWith('-') && !tok.startsWith('+')) break
    const inl = opt(tok, spec.inline)
    if (inl) {
      const glued = tok.length > inl.length ? tok.slice(inl.length).replace(/^=/, '') : ''
      const code = glued || t[i + 1] || ''
      return code ? { kind: 'inline', code, interpreter: name } : null
    }
    if (opt(tok, spec.stop)) return null
    const wa = (spec.withArg ?? []).find((o) => tok === o)
    if (wa) i++ // valor na palavra seguinte
    // demais opções (`-u`, `--inspect`, `--inspect=9229`, `-A`, `--allow-read`): sem valor
  }
  if (spec.fileFlag) return null // pwsh sem -File: comando, não arquivo
  return fileRef(t[i], name)
}

/**
 * Arquivo do script — null sem caminho, `-` (stdin) ou com variável/substituição não resolvida
 * (`"$f"`, `` `x` ``): o valor só existe na execução; ler o nome literal daria "não encontrado".
 */
function fileRef(path: string | undefined, interpreter: string): ScriptRef | null {
  if (!path || path === '-' || /[$`]/.test(path)) return null
  return { kind: 'file', path, interpreter }
}

/** Recorte do começo de um texto: até `maxLines` linhas e `maxChars` chars. */
export function scriptHead(
  text: string,
  maxLines: number,
  maxChars: number
): { head: string; lines: number; truncated: boolean } {
  const norm = text.replace(/\r\n?/g, '\n')
  const all = norm.endsWith('\n') ? norm.slice(0, -1).split('\n') : norm.split('\n')
  let head = all.slice(0, maxLines).join('\n')
  let truncated = all.length > maxLines
  if (head.length > maxChars) {
    head = head.slice(0, maxChars)
    truncated = true
  }
  return { head, lines: norm ? all.length : 0, truncated }
}

/** Texto parece binário (NUL ou muitos caracteres de controle no começo). */
export function looksBinary(sample: string): boolean {
  if (sample.includes('\u0000')) return true
  const s = sample.slice(0, 4096)
  if (!s) return false
  let ctrl = 0
  for (let k = 0; k < s.length; k++) {
    const c = s.charCodeAt(k)
    if ((c < 9 || (c > 13 && c < 32)) && c !== 27) ctrl++
    if (c === 0xfffd) ctrl++ // UTF-8 inválido decodificado
  }
  return ctrl / s.length > 0.1
}

/** Bloco para o juiz debaixo do item (indentado), com o mesmo recorte do card, mais curto. */
export function scriptJudgeText(
  script: NonNullable<ApprovalCheckItem['script']>,
  pad: string
): string {
  const p = `${pad}    `
  const tag = (s: string): string => `${p}${s}`
  switch (script.status) {
    case 'ok':
    case 'inline': {
      const src = script.content ?? ''
      const h = scriptHead(src, SCRIPT_PREVIEW.judgeLines, SCRIPT_PREVIEW.judgeChars)
      const title =
        script.status === 'inline'
          ? `inline ${script.interpreter} code:`
          : `script file ${script.path} (${script.lines ?? h.lines} lines${script.partial ? '+' : ''}), first lines:`
      const body = h.head
        .split('\n')
        .map((l) => `${p}| ${l}`)
        .join('\n')
      return `\n${tag(title)}\n${body}${h.truncated || script.truncated ? `\n${p}| …` : ''}`
    }
    case 'missing':
      return `\n${tag(`script file ${script.path}: not found`)}`
    case 'binary':
      return `\n${tag(`script file ${script.path}: binary`)}`
    case 'remote':
      return `\n${tag(`script file ${script.path}: on the remote side (not read)`)}`
    default:
      return `\n${tag(`script file ${script.path}: could not be read`)}`
  }
}
