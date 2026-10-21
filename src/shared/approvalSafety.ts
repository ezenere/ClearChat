// Aprovações — regras FIXAS de segurança (tabelas únicas, funções puras; main e renderer). Ver
// SPEC.md → "Aprovações → Leitura sempre liberada / Caminhos protegidos / Aceitar edições".
//
// 1. Comandos SÓ DE LEITURA (READ_ONLY_COMMANDS): um sub-comando que só lê (ls, cat, git status…)
//    é liberado em qualquer modo, sem card e sem juiz — mas só quando NÃO é `unsafe` (nada de
//    redirecionar para arquivo, eval…), não roda sob sudo/su/container e, dentro de um ssh, só se a
//    conexão estiver na whitelist. A blacklist continua bloqueando. Não é configurável (só pela
//    blacklist). Ler um caminho protegido (credenciais, .env…) não conta como leitura liberada.
// 2. CAMINHOS PROTEGIDOS (PROTECTED_PATHS + RM_CRITICAL): escrever/apagar/mover/mudar permissão
//    nesses caminhos SEMPRE pergunta — mesmo com whitelist, no modo Smart-Approve (sem juiz), em
//    "Sempre permitir" e com "Aceitar edições dentro da raiz". A blacklist continua bloqueando.
// 3. "Aceitar edições dentro da raiz do chat" (isInsideRoot): write_file/edit_file cujo caminho
//    resolvido fica dentro da raiz (e não é protegido) rodam sem perguntar nem chamar o juiz.
//
// Caminhos: tudo é comparado depois de `normalizePath` (expande ~ e $HOME, resolve relativos pelo
// diretório do comando, colapsa . e ..). Sem `node:path` (o renderer usa no "Testar comando").
import type { ShellCommand } from './shellParse'

export interface SafetyCtx {
  /** Diretório home (expande `~`, `$HOME`). Ausente = `~` fica literal (os padrões também). */
  home?: string
  /** Diretório em que o comando roda / base dos caminhos relativos (padrão: `root`). */
  cwd?: string
  /** Raiz do chat (rm -r da raiz ou de um ancestral dela = crítico). */
  root?: string
  /** Pastas de dados do app (userData) — protegidas além de ~/.config/ClearChat. */
  appData?: string[]
}

// ---------------- caminhos ----------------

/** Junta e normaliza (colapsa `.`, `..`, barras repetidas) um caminho POSIX. */
function collapse(p: string): string {
  const abs = p.startsWith('/')
  const out: string[] = []
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop()
      else if (!abs) out.push('..')
      continue
    }
    out.push(seg)
  }
  return (abs ? '/' : '') + out.join('/') || (abs ? '/' : '.')
}

const homeOf = (ctx: SafetyCtx): string => (ctx.home ? collapse(ctx.home) : '~')

/**
 * Caminho como o shell/as tools veriam: `~`, `~/x`, `$HOME/x`, `${HOME}/x` → home; `~user/x` →
 * /home/user/x; relativo → a partir de `cwd` (ou `root`). Vazio → ''.
 */
export function normalizePath(raw: string, ctx: SafetyCtx = {}): string {
  let p = String(raw ?? '').trim()
  if (!p) return ''
  const home = homeOf(ctx)
  const hm = /^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/.exec(p)
  if (hm) p = home + p.slice(hm[0].length)
  else if (/^~[A-Za-z0-9._-]+(?=\/|$)/.test(p)) p = `/home/${p.slice(1)}`
  if (!p.startsWith('/') && !p.startsWith('~')) {
    const base = ctx.cwd || ctx.root
    if (base) p = `${normalizePath(base, { ...ctx, cwd: undefined, root: undefined })}/${p}`
  }
  return collapse(p)
}

/** `p` está dentro de `root` (ou é o próprio root)? Ambos já normalizados/absolutos. */
export function isInsideRoot(root: string, p: string): boolean {
  const r = collapse(root)
  const q = collapse(p)
  if (!r || !q) return false
  return q === r || q.startsWith(r === '/' ? '/' : `${r}/`)
}

const segs = (p: string): string[] => p.split('/').filter(Boolean)
const base = (p: string): string => segs(p).pop() ?? ''

// ---------------- caminhos protegidos ----------------

export interface ProtectedRule {
  id: string
  /** Padrão como aparece na UI/SPEC. */
  pattern: string
  /** Por que é protegido (curto, pt-BR). */
  label: string
  test: (p: string, ctx: SafetyCtx) => boolean
}

const SHELL_STARTUP = new Set([
  '.bashrc',
  '.bash_profile',
  '.bash_login',
  '.bash_logout',
  '.profile',
  '.zshrc',
  '.zshenv',
  '.zprofile',
  '.zlogin',
  '.zlogout',
  '.kshrc',
  '.mkshrc'
])
const HOME_CREDENTIALS = [
  '.aws/credentials',
  '.aws/config',
  '.netrc',
  '.git-credentials',
  '.npmrc',
  '.pypirc',
  '.docker/config.json',
  '.kube/config',
  '.config/gh/hosts.yml'
]
const under = (p: string, dir: string): boolean => p === dir || p.startsWith(`${dir}/`)
const inHome = (p: string, ctx: SafetyCtx, rel: string): boolean =>
  under(p, `${homeOf(ctx)}/${rel}`)

/**
 * Tabela ÚNICA dos caminhos protegidos (escrever, apagar, mover, chmod/chown → sempre pergunta).
 * Padrões com `**` valem em qualquer lugar (inclusive dentro de um ssh — o caminho remoto é
 * comparado do mesmo jeito).
 */
export const PROTECTED_PATHS: ProtectedRule[] = [
  {
    id: 'ssh',
    pattern: '**/.ssh/** (~/.ssh)',
    label: 'chaves e config do SSH',
    test: (p) => segs(p).includes('.ssh')
  },
  {
    id: 'env',
    pattern: '**/.env, **/.env.*, **/.envrc',
    label: 'variáveis de ambiente / segredos',
    test: (p) => /^\.env(rc)?(\..+)?$/.test(base(p))
  },
  {
    id: 'git-config',
    pattern: '**/.git/config',
    label: 'config do git (remotes, hooks, credenciais)',
    test: (p) => /(^|\/)\.git\/config$/.test(p)
  },
  {
    id: 'git-hooks',
    pattern: '**/.git/hooks/**',
    label: 'hooks do git (rodam sozinhos em commit/checkout)',
    test: (p) => /(^|\/)\.git\/hooks(\/|$)/.test(p)
  },
  {
    id: 'shell-startup',
    pattern:
      '~/.bashrc, ~/.bash_profile, ~/.profile, ~/.zshrc, ~/.zshenv, ~/.zprofile… (qualquer pasta), ~/.config/fish/**, /etc/profile, /etc/profile.d/**, /etc/bash.bashrc, /etc/zshrc, /etc/zsh/**',
    label: 'inicialização do shell (roda em todo terminal)',
    test: (p, ctx) =>
      SHELL_STARTUP.has(base(p)) ||
      inHome(p, ctx, '.config/fish') ||
      ['/etc/profile', '/etc/bash.bashrc', '/etc/zshrc', '/etc/zshenv'].includes(p) ||
      under(p, '/etc/profile.d') ||
      under(p, '/etc/zsh')
  },
  {
    id: 'app-data',
    pattern: '~/.config/ClearChat/** (dados do app, userData)',
    label: 'dados do próprio ClearChat',
    test: (p, ctx) =>
      inHome(p, ctx, '.config/ClearChat') ||
      inHome(p, ctx, '.config/clearchat') ||
      inHome(p, ctx, 'Library/Application Support/ClearChat') ||
      (ctx.appData ?? []).some((d) => d && under(p, collapse(d)))
  },
  {
    id: 'credentials',
    pattern:
      '~/.aws/credentials, ~/.aws/config, ~/.netrc, ~/.git-credentials, ~/.npmrc, ~/.pypirc, ~/.docker/config.json, ~/.kube/config, ~/.config/gh/hosts.yml, ~/.gnupg/**',
    label: 'credenciais',
    test: (p, ctx) =>
      HOME_CREDENTIALS.some((rel) => p === `${homeOf(ctx)}/${rel}`) || inHome(p, ctx, '.gnupg')
  },
  {
    id: 'keys',
    pattern: '**/*.pem, **/*.key, **/id_rsa|id_dsa|id_ecdsa|id_ed25519[_sk][.pub]',
    label: 'chave privada / certificado',
    test: (p) =>
      /\.(pem|key)$/i.test(base(p)) || /^id_(rsa|dsa|ecdsa|ed25519)(_sk)?(\.pub)?$/.test(base(p))
  },
  {
    id: 'sudoers',
    pattern: '/etc/sudoers, /etc/sudoers.d/**',
    label: 'permissões de sudo',
    test: (p) => under(p, '/etc/sudoers') || under(p, '/etc/sudoers.d')
  }
]

/** Regra que protege `p` (já normalizado), se houver. */
export function protectedRule(p: string, ctx: SafetyCtx = {}): ProtectedRule | null {
  if (!p) return null
  return PROTECTED_PATHS.find((r) => r.test(p, ctx)) ?? null
}

/** Pastas cujo `rm -r` é sempre crítico (além de `~`, da raiz do chat e dos ancestrais dela). */
export const RM_CRITICAL_DIRS = [
  '/',
  '/home',
  '/etc',
  '/usr',
  '/bin',
  '/sbin',
  '/boot',
  '/lib',
  '/lib64',
  '/opt',
  '/root',
  '/var',
  '/srv',
  '/sys',
  '/proc',
  '/dev',
  '/mnt',
  '/media',
  '/Users',
  '/System',
  '/Applications',
  '/Library'
]

/**
 * `rm -r` deste alvo é crítico? `/`, `~`/$HOME, as pastas de RM_CRITICAL_DIRS, a raiz do chat e
 * qualquer ancestral dela ou do home. `x/*` e `x/.` contam como `x`.
 */
export function isCriticalRmTarget(raw: string, ctx: SafetyCtx = {}): boolean {
  const t = String(raw ?? '').trim()
  if (!t) return false
  // `dir/*`, `dir/.*`, `*` → a própria pasta
  const stripped =
    t.replace(/(^|\/)\.?\*$/, '$1').replace(/\/+$/, '') || (t.startsWith('/') ? '/' : '.')
  const p = normalizePath(stripped, ctx)
  if (!p) return false
  if (RM_CRITICAL_DIRS.includes(p)) return true
  const home = homeOf(ctx)
  const isAncestorOrSelf = (dir: string): boolean => !!dir && isInsideRoot(p, dir)
  if (p === home || p === '~' || isAncestorOrSelf(home)) return true
  if (ctx.root && isAncestorOrSelf(normalizePath(ctx.root, { home: ctx.home }))) return true
  return false
}

// ---------------- alvos de escrita de um sub-comando ----------------

export interface ProtectedHit {
  /** Caminho como escrito no comando. */
  target: string
  /** Normalizado. */
  path: string
  /** Por que pergunta. */
  why: string
}

/** Argumentos posicionais (pula opções; `--` encerra as opções). `withArg` = opções que levam valor. */
function positional(args: string[], withArg: string[] = []): string[] {
  const out: string[] = []
  let opts = true
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (opts && a === '--') {
      opts = false
      continue
    }
    if (opts && a.startsWith('-') && a !== '-') {
      if (withArg.includes(a)) i++
      continue
    }
    out.push(a)
  }
  return out
}

/** Valor de uma opção (`-t DIR`, `--target-directory=DIR`). */
function optValue(args: string[], short: string, long: string): string | null {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === short && i + 1 < args.length) return args[i + 1]
    if (args[i].startsWith(`${long}=`)) return args[i].slice(long.length + 1)
    if (args[i].startsWith(short) && args[i].length > short.length && !args[i].startsWith('--'))
      return args[i].slice(short.length)
  }
  return null
}

const progOf = (t: string | undefined): string => (t ?? '').slice((t ?? '').lastIndexOf('/') + 1)
const hasShort = (args: string[], ch: string): boolean =>
  args.some((a) => /^-[A-Za-z]+$/.test(a) && a.includes(ch))

/**
 * Caminhos que o sub-comando escreve/apaga/move/muda permissão (o suficiente para os caminhos
 * protegidos): redirecionamentos de saída, rm/rmdir/unlink/shred/truncate, mv (origem e destino),
 * cp/install/ln (destino), tee, chmod/chown/chgrp, dd of=, sed -i, git config (gravação → .git/config).
 */
export function writeTargets(c: Pick<ShellCommand, 'tokens' | 'writes'>): {
  target: string
  op: 'write' | 'delete' | 'move' | 'perm'
  recursive?: boolean
}[] {
  const out: { target: string; op: 'write' | 'delete' | 'move' | 'perm'; recursive?: boolean }[] =
    []
  for (const w of c.writes ?? []) out.push({ target: w, op: 'write' })
  const prog = progOf(c.tokens[0])
  const args = c.tokens.slice(1)
  switch (prog) {
    case 'rm': {
      const recursive = hasShort(args, 'r') || hasShort(args, 'R') || args.includes('--recursive')
      for (const t of positional(args)) out.push({ target: t, op: 'delete', recursive })
      break
    }
    case 'rmdir':
    case 'unlink':
    case 'shred':
      for (const t of positional(args, ['-n', '-s', '--iterations', '--size']))
        out.push({ target: t, op: 'delete' })
      break
    case 'truncate':
      for (const t of positional(args, ['-s', '-r', '--size', '--reference']))
        out.push({ target: t, op: 'write' })
      break
    case 'mv': {
      const dir = optValue(args, '-t', '--target-directory')
      for (const t of positional(args, ['-t', '-S', '--suffix']))
        out.push({ target: t, op: 'move' })
      if (dir) out.push({ target: dir, op: 'move' })
      break
    }
    case 'cp':
    case 'install':
    case 'ln':
    case 'rsync': {
      const dir = optValue(args, '-t', '--target-directory')
      const pos = positional(args, ['-t', '-S', '--suffix', '-m', '--mode', '-o', '-g', '-e'])
      if (dir) out.push({ target: dir, op: 'write' })
      else if (pos.length) out.push({ target: pos[pos.length - 1], op: 'write' })
      break
    }
    case 'tee':
      for (const t of positional(args)) out.push({ target: t, op: 'write' })
      break
    case 'chmod':
    case 'chown':
    case 'chgrp': {
      const pos = positional(args)
      const ref = args.some((a) => a.startsWith('--reference='))
      for (const t of ref ? pos : pos.slice(1)) out.push({ target: t, op: 'perm' })
      break
    }
    case 'dd':
      for (const a of args) if (a.startsWith('of=')) out.push({ target: a.slice(3), op: 'write' })
      break
    case 'sed':
      if (hasShort(args, 'i') || args.some((a) => a.startsWith('--in-place'))) {
        const scripted = args.some((a) => a === '-e' || a === '-f' || a.startsWith('--expression'))
        const pos = positional(args, ['-e', '-f', '--expression', '--file', '-l'])
        for (const t of scripted ? pos : pos.slice(1)) out.push({ target: t, op: 'write' })
      }
      break
    case 'git': {
      // git [-C dir] config <set>: grava .git/config (leitura: --get/--list…)
      let i = 0
      let dir = '.'
      while (i < args.length && args[i].startsWith('-')) {
        if (args[i] === '-C' && i + 1 < args.length) dir = args[++i]
        i++
      }
      if (args[i] !== 'config') break
      const rest = args.slice(i + 1)
      const read = rest.some((a) =>
        /^(--get|--get-all|--get-regexp|--list|-l|--show-origin|--show-scope|--name-only)$/.test(a)
      )
      if (read || rest.some((a) => /^(--global|--system)$/.test(a))) break
      const file = optValue(rest, '-f', '--file')
      if (
        positional(rest, ['-f', '--file', '--type', '--default']).length >= 2 ||
        rest.some((a) =>
          /^(--unset|--unset-all|--add|--replace-all|--rename-section|--remove-section|-e|--edit)$/.test(
            a
          )
        )
      )
        out.push({ target: file ?? `${dir}/.git/config`, op: 'write' })
      break
    }
  }
  return out
}

/** Caminhos protegidos que o sub-comando toca (escrita/apagar/mover/permissão; rm -r crítico). */
export function protectedHits(
  c: Pick<ShellCommand, 'tokens' | 'writes'>,
  ctx: SafetyCtx = {}
): ProtectedHit[] {
  const hits: ProtectedHit[] = []
  for (const w of writeTargets(c)) {
    const path = normalizePath(w.target, ctx)
    if (w.op === 'delete' && w.recursive && isCriticalRmTarget(w.target, ctx)) {
      hits.push({ target: w.target, path, why: 'rm -r de uma pasta crítica' })
      continue
    }
    const rule = protectedRule(path, ctx)
    if (rule) hits.push({ target: w.target, path, why: rule.label })
  }
  return hits
}

/** Texto do motivo ("caminho protegido: ~/.ssh/config (chaves e config do SSH)"). */
export function protectedText(hits: ProtectedHit[]): string {
  return hits.map((h) => `${h.target} (${h.why})`).join(', ')
}

// ---------------- comandos só de leitura ----------------

type ArgCheck = (args: string[]) => boolean
export interface ReadOnlyRule {
  /** Explicação curta (tabela da SPEC/UI). */
  note?: string
  /** Opções que tiram o comando da lista (escrevem arquivo / executam algo). */
  deny?: string[]
  /** Máximo de argumentos posicionais (ex.: `uniq in out` grava `out`). */
  maxPositional?: number
  /** Regra própria (subcomandos do git, script do sed…). */
  check?: ArgCheck
}

/** `deny`: `-x` casa também agrupado (`-io`); `--long` casa `--long=…`; `-exec` (find) exato. */
function hasDenied(args: string[], deny: string[]): boolean {
  for (const a of args) {
    if (a === '--') break
    for (const d of deny) {
      if (a === d) return true
      if (d.startsWith('--') && a.startsWith(`${d}=`)) return true
      if (/^-[A-Za-z]$/.test(d) && /^-[A-Za-z]+$/.test(a) && a.includes(d[1])) return true
    }
  }
  return false
}

const GIT_GLOBAL_OK = new Set(['--no-pager', '-P', '--no-optional-locks', '--literal-pathspecs'])
const GIT_READ_SUBS = new Set([
  'status',
  'log',
  'show',
  'diff',
  'rev-parse',
  'ls-files',
  'ls-tree',
  'ls-remote',
  'cat-file',
  'blame',
  'describe',
  'shortlog',
  'merge-base',
  'grep',
  'show-ref',
  'rev-list',
  'count-objects',
  'check-ignore',
  'name-rev',
  'cherry',
  'version',
  'whatchanged',
  'show-branch',
  'for-each-ref'
])

/** git só de leitura: subcomandos de consulta e as formas de listagem de branch/tag/remote/stash. */
function gitReadOnly(args: string[]): boolean {
  let i = 0
  while (i < args.length && args[i].startsWith('-')) {
    const a = args[i]
    if (a === '-C' && i + 1 < args.length) i += 2
    else if (GIT_GLOBAL_OK.has(a)) i++
    else return false // -c k=v (core.pager, core.fsmonitor… executam), --exec-path, --git-dir…
  }
  const sub = args[i]
  const rest = args.slice(i + 1)
  if (!sub) return false
  if (GIT_READ_SUBS.has(sub))
    return !hasDenied(rest, ['--output', '--ext-diff', '-O', '--open-files-in-pager', '--exec'])
  const has = (...f: string[]): boolean => rest.some((a) => f.includes(a))
  switch (sub) {
    case 'branch':
      if (
        hasDenied(rest, [
          '-d',
          '-D',
          '-m',
          '-M',
          '-c',
          '-C',
          '-f',
          '-u',
          '-t',
          '--delete',
          '--move',
          '--copy',
          '--force',
          '--set-upstream-to',
          '--unset-upstream',
          '--edit-description',
          '--track',
          '--no-track',
          '--create-reflog'
        ])
      )
        return false
      return (
        positional(rest, [
          '--sort',
          '--format',
          '--contains',
          '--merged',
          '--no-merged',
          '--points-at'
        ]).length === 0 || has('-l', '--list', '-a', '--all', '-r', '--remotes')
      )
    case 'remote':
      return (
        rest.every((a) => a === '-v' || a === '--verbose') || ['show', 'get-url'].includes(rest[0])
      )
    case 'tag':
      return (
        rest.length === 0 ||
        (has('-l', '--list') &&
          !hasDenied(rest, [
            '-d',
            '-a',
            '-s',
            '-u',
            '-f',
            '-m',
            '-F',
            '--delete',
            '--annotate',
            '--sign',
            '--force',
            '--message',
            '--file'
          ]))
      )
    case 'stash':
      return rest[0] === 'list' || rest[0] === 'show'
    case 'worktree':
      return rest[0] === 'list'
    case 'reflog':
      return rest.length === 0 || rest[0] === 'show'
    case 'config':
      return (
        has('--get', '--get-all', '--get-regexp', '--list', '-l') &&
        !hasDenied(rest, [
          '--edit',
          '-e',
          '--unset',
          '--unset-all',
          '--add',
          '--replace-all',
          '--rename-section',
          '--remove-section'
        ])
      )
    default:
      return false
  }
}

/** Um script do sed só com impressão/endereços/`s///` sem as flags `w`/`e` (que gravam/executam). */
const SED_ADDR = String.raw`(?:\d+|\$|/(?:[^/\\]|\\.)*/)`
const SED_CMD = new RegExp(
  String.raw`^(?:${SED_ADDR}(?:,${SED_ADDR})?)?!?(?:[pdq=]|s(.)(?:(?!\1)[^\\]|\\.)*\1(?:(?!\1)[^\\]|\\.)*\1[gpiI0-9]*)$`
)
function sedReadOnly(args: string[]): boolean {
  if (hasDenied(args, ['-i', '--in-place', '-f', '--file', '-s', '--separate', '-z'])) return false
  const scripts: string[] = []
  const files: string[] = []
  let explicit = false
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '-e' || a === '--expression') {
      explicit = true
      scripts.push(args[++i] ?? '')
    } else if (a.startsWith('--expression=')) {
      explicit = true
      scripts.push(a.slice(13))
    } else if (a.startsWith('-') && a !== '-') {
      if (
        !/^-[nrEu]+$/.test(a) &&
        !['--quiet', '--silent', '--regexp-extended', '--posix', '--debug'].includes(a)
      )
        return false
    } else files.push(a)
  }
  if (!explicit) {
    if (!files.length) return false
    scripts.push(files.shift()!)
  }
  return scripts.every((s) =>
    s
      .split(/[;\n]/)
      .map((x) => x.trim())
      .filter(Boolean)
      .every((x) => SED_CMD.test(x))
  )
}

/**
 * Só checagem de sintaxe (nunca executa o arquivo): `bash|sh|zsh|dash|ksh -n arquivo` (opções
 * agrupadas só com n/v/x — `-nv` —, sem -c/-s/-i), `node --check|-c arquivo`, `php -l arquivo`.
 * Ficam de FORA: `perl -c` (roda blocos BEGIN/CHECK), `ruby -c` (na dúvida), `python -m
 * py_compile` (grava __pycache__) e qualquer código inline.
 */
const shellSyntaxOnly: ArgCheck = (a) => {
  const flags = a.filter((x) => x.startsWith('-'))
  const pos = a.filter((x) => !x.startsWith('-'))
  return (
    pos.length === 1 &&
    flags.length > 0 &&
    flags.every((f) => /^-[nvx]+$/.test(f)) &&
    flags.some((f) => f.includes('n'))
  )
}
const onlyFlag =
  (...ok: string[]): ArgCheck =>
  (a) =>
    a.filter((x) => !x.startsWith('-')).length === 1 &&
    a.some((x) => ok.includes(x)) &&
    a.filter((x) => x.startsWith('-')).every((x) => ok.includes(x))

/** Variáveis que costumam guardar segredos (printenv delas não é "só leitura" liberada). */
const SECRET_VAR = /(KEY|TOKEN|SECRET|PASSW|CRED|AUTH|COOKIE|PRIVATE|SESSION)/i

/**
 * Tabela ÚNICA dos comandos só de leitura (nome exato do programa — `./ls` ou `/tmp/ls` não
 * contam). `true` = qualquer argumento. Ficam de FORA de propósito: less/more/man (pagers
 * interativos; a tool não tem terminal e o pager pode executar `!cmd`/LESSOPEN), awk (system(),
 * print > arquivo), env/printenv sem argumento (despeja segredos para o modelo), xargs/watch/bash
 * (são desmontados: vale o comando interno), find com -exec/-delete, sed -i/w/e, git que muda algo.
 */
export const READ_ONLY_COMMANDS: Record<string, ReadOnlyRule | true> = {
  ls: true,
  pwd: true,
  cd: { note: 'muda só o diretório do shell da sessão' },
  cat: true,
  head: true,
  tail: true,
  wc: true,
  file: { deny: ['-C', '--compile'] },
  stat: true,
  du: true,
  df: true,
  which: true,
  whereis: true,
  type: true,
  echo: true,
  printf: true,
  date: {
    deny: ['-s', '--set'],
    check: (a) =>
      positional(a, ['-d', '--date', '-r', '--reference', '-f', '--file']).every((x) =>
        x.startsWith('+')
      )
  },
  uname: true,
  whoami: true,
  id: true,
  groups: true,
  hostname: {
    check: (a) => a.every((x) => x.startsWith('-') && !/^(-F|--file|-b|--boot)/.test(x))
  },
  uptime: true,
  free: true,
  lsblk: true,
  nproc: true,
  arch: true,
  lscpu: true,
  ps: true,
  pgrep: true,
  pidof: true,
  who: true,
  w: true,
  ss: { deny: ['-K', '--kill'] },
  netstat: true,
  lsof: true,
  top: {
    note: 'só em lote: top -b -n N',
    check: (a) => a.some((x) => /^-[A-Za-z]*b/.test(x)) && a.some((x) => /^-[A-Za-z]*n/.test(x))
  },
  tree: { deny: ['-o'] },
  sort: { deny: ['-o', '--output', '--compress-program'] },
  uniq: { maxPositional: 1 },
  cut: true,
  tr: true,
  column: true,
  nl: true,
  fold: true,
  rev: true,
  tac: true,
  seq: true,
  paste: true,
  join: true,
  comm: true,
  expand: true,
  unexpand: true,
  fmt: true,
  od: true,
  hexdump: true,
  strings: true,
  xxd: { maxPositional: 1 },
  base64: { deny: ['-o', '--output'] },
  grep: true,
  egrep: true,
  fgrep: true,
  rg: { deny: ['--pre'] },
  find: {
    deny: [
      '-exec',
      '-execdir',
      '-ok',
      '-okdir',
      '-delete',
      '-fprint',
      '-fprint0',
      '-fprintf',
      '-fls'
    ]
  },
  sed: { note: 'só impressão (-n, p, s/// sem w/e), sem -i', check: sedReadOnly },
  jq: { check: (a) => !a.some((x) => /\benv\b|\$ENV|\binput_filename\b/.test(x)) },
  yq: { deny: ['-i', '--inplace'] },
  diff: true,
  cmp: true,
  md5sum: true,
  sha1sum: true,
  sha224sum: true,
  sha256sum: true,
  sha384sum: true,
  sha512sum: true,
  b2sum: true,
  shasum: true,
  cksum: true,
  basename: true,
  dirname: true,
  realpath: true,
  readlink: true,
  printenv: {
    note: 'só com nomes de variáveis que não parecem segredo',
    check: (a) => a.length > 0 && a.every((x) => !x.startsWith('-') && !SECRET_VAR.test(x))
  },
  true: true,
  false: true,
  test: true,
  '[': true,
  sleep: true,
  tty: true,
  locale: true,
  git: {
    note: 'status, diff, log, show, branch (listar), remote -v, rev-parse, tag -l…',
    check: gitReadOnly
  },
  // só checagem de sintaxe (não executa o arquivo)
  bash: { note: 'só bash -n arquivo (checa a sintaxe)', check: shellSyntaxOnly },
  sh: { note: 'só sh -n arquivo', check: shellSyntaxOnly },
  zsh: { note: 'só zsh -n arquivo', check: shellSyntaxOnly },
  dash: { note: 'só dash -n arquivo', check: shellSyntaxOnly },
  ksh: { note: 'só ksh -n arquivo', check: shellSyntaxOnly },
  node: { note: 'só node --check arquivo', check: onlyFlag('--check', '-c') },
  php: { note: 'só php -l arquivo', check: onlyFlag('-l', '--syntax-check') },
  shellcheck: true
}

/**
 * O sub-comando (tokens) só lê? Não considera o contexto (unsafe, wrappers, ssh) — ver
 * `readOnlyItem` / evaluateCommand. Ler um caminho protegido (cat ~/.ssh/id_rsa, .env) não conta.
 */
export function isReadOnlyTokens(tokens: string[], ctx: SafetyCtx = {}): boolean {
  if (!tokens.length) return false
  const prog = tokens[0]
  if (!Object.prototype.hasOwnProperty.call(READ_ONLY_COMMANDS, prog)) return false
  const rule = READ_ONLY_COMMANDS[prog]
  const args = tokens.slice(1)
  if (rule !== true) {
    if (rule.deny && hasDenied(args, rule.deny)) return false
    if (rule.maxPositional !== undefined && positional(args).length > rule.maxPositional)
      return false
    if (rule.check && !rule.check(args)) return false
  }
  // credenciais/segredos: ler também passa pelo fluxo normal (o conteúdo iria para o modelo)
  for (const a of args) {
    if (a.startsWith('-') && !a.includes('/')) continue
    const v = a.includes('=') && a.startsWith('-') ? a.slice(a.indexOf('=') + 1) : a
    if (protectedRule(normalizePath(v, ctx), ctx)) return false
  }
  return true
}
