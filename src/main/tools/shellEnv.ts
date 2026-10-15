// Shell do usuário para a tool `shell` e para process_start.
// - Escolha: $SHELL se for zsh ou bash (e existir); senão bash (fish, sh, … → bash).
// - Ambiente do usuário resolvido UMA VEZ (como o VS Code): `<shell> -ilc` imprime o env entre
//   marcadores (o .zshrc pode poluir stdout); cacheado. Falha/timeout → process.env (e log).
// - Com o env resolvido, cada comando roda com `<shell> -c` (sem -l): o env já tem o efeito do
//   login + interativo, e no macOS um `zsh -l` reordenaria o PATH (path_helper em /etc/zprofile),
//   pondo /usr/local/bin na frente do nvm. Sem env resolvido (fallback) → `<shell> -lc`.
import { spawn, spawnSync } from 'child_process'
import { existsSync } from 'fs'
import { basename } from 'path'
import { setToolShellInfo, type ShellInfoLite, type ShellKind } from '@shared/shellInfo'

/** Shells suportados hoje (escolhidos por pickShell); ShellKind já reserva 'pwsh' (futuro). */
export type ShellName = Extract<ShellKind, 'zsh' | 'bash'>

export interface ShellInfo {
  path: string
  name: ShellName
  /** Ex.: "5.9" (zsh) ou "3.2.57" (bash); ausente se `--version` falhar. */
  version?: string
}

/** Escolha pura do shell (testável): `$SHELL` zsh/bash existente; senão bash. */
export function pickShell(
  envShell: string | undefined,
  exists: (p: string) => boolean = existsSync
): { path: string; name: ShellName } {
  const s = (envShell ?? '').trim()
  const base = s ? basename(s) : ''
  if ((base === 'zsh' || base === 'bash') && exists(s)) return { path: s, name: base }
  for (const p of ['/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash', '/opt/homebrew/bin/bash'])
    if (exists(p)) return { path: p, name: 'bash' }
  return { path: 'bash', name: 'bash' } // via PATH
}

/** Versão a partir da saída de `--version`. */
export function parseShellVersion(name: ShellName, out: string): string | undefined {
  const m =
    name === 'zsh' ? /zsh\s+(\d+(?:\.\d+)*)/.exec(out) : /version\s+(\d+(?:\.\d+)*)/.exec(out)
  return m?.[1]
}

let shellCache: ShellInfo | null = null

/** Shell escolhido (cacheado; versão via `<shell> --version` uma vez). */
export function resolveShell(): ShellInfo {
  if (shellCache) return shellCache
  const picked = pickShell(process.env.SHELL)
  let version: string | undefined
  try {
    const r = spawnSync(picked.path, ['--version'], { encoding: 'utf8', timeout: 3000 })
    version = parseShellVersion(picked.name, `${r.stdout ?? ''}${r.stderr ?? ''}`)
  } catch {
    /* sem versão */
  }
  shellCache = { ...picked, ...(version ? { version } : {}) }
  return shellCache
}

/** Rótulo para o bloco <environment> (ex.: "zsh 5.9"); fallback "bash". */
export function shellLabel(): string {
  try {
    const s = resolveShell()
    return s.version ? `${s.name} ${s.version}` : s.name
  } catch {
    return 'bash'
  }
}

/** Nome do SO para a descrição da tool (estável). */
export function osName(platform: NodeJS.Platform = process.platform): string {
  return platform === 'darwin'
    ? 'macOS'
    : platform === 'linux'
      ? 'Linux'
      : platform === 'win32'
        ? 'Windows'
        : platform
}

/** Info leve para a descrição da tool `shell` / renderer. */
export function shellInfoLite(): ShellInfoLite {
  const s = resolveShell()
  return { name: s.name, ...(s.version ? { version: s.version } : {}), os: osName() }
}

/**
 * Start do app: detecta o shell (síncrono, ~ms: `--version`), injeta na descrição da tool `shell`
 * e começa a resolver o ambiente do usuário em segundo plano.
 */
export function initShell(): void {
  // fallback imediato (sem versão) caso a detecção falhe
  const picked = pickShell(process.env.SHELL)
  setToolShellInfo({ name: picked.name, os: osName() })
  try {
    setToolShellInfo(shellInfoLite())
  } catch (e) {
    console.warn('[clearchat] detecção do shell', e)
  }
  warmUserEnv()
}

/** Testes: força um shell (ou null para voltar à detecção). */
export function _setShell(s: ShellInfo | null): void {
  shellCache = s
}

// ---------------- ambiente do usuário ----------------

export const ENV_MARKER = '__CLEAR_ENV_7f3a__'
/** Script que imprime o env (NUL-separado) entre marcadores. */
export const ENV_SCRIPT = `printf '%s' '${ENV_MARKER}'; command env -0 2>/dev/null || command env; printf '%s' '${ENV_MARKER}'`

/** Variáveis que não fazem sentido herdar do shell que resolveu o env. */
const DROP_KEYS = new Set([
  'SHLVL',
  'PWD',
  'OLDPWD',
  '_',
  'ELECTRON_RUN_AS_NODE',
  'CLEAR_START_DIR',
  'CLEAR_ROOT_DIR',
  'PS1',
  'PS2',
  'TERM_SESSION_ID'
])

/**
 * Extrai o env da saída (entre os marcadores; lixo antes/depois é ignorado). Aceita `env -0`
 * (NUL) ou, sem NUL, uma variável por linha. null se os marcadores não aparecerem.
 */
export function parseEnvOutput(out: string): Record<string, string> | null {
  const a = out.indexOf(ENV_MARKER)
  if (a === -1) return null
  const b = out.indexOf(ENV_MARKER, a + ENV_MARKER.length)
  if (b === -1) return null
  const body = out.slice(a + ENV_MARKER.length, b)
  const entries = body.includes('\0') ? body.split('\0') : body.split('\n')
  const env: Record<string, string> = {}
  for (const e of entries) {
    const i = e.indexOf('=')
    if (i <= 0) continue
    const k = e.slice(0, i)
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || DROP_KEYS.has(k)) continue
    env[k] = e.slice(i + 1)
  }
  return Object.keys(env).length ? env : null
}

export interface ResolvedEnv {
  /** null = falhou (usa process.env e roda com -lc). */
  env: Record<string, string> | null
  error?: string
  durationMs: number
}

/** Roda `<shell> -ilc ENV_SCRIPT` (detached, sem stdin) e devolve o env; nunca rejeita. */
export function resolveUserEnv(shellPath: string, timeoutMs = 10_000): Promise<ResolvedEnv> {
  const t0 = Date.now()
  return new Promise((resolveP) => {
    const env: NodeJS.ProcessEnv = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    let out = ''
    let done = false
    const finish = (r: Omit<ResolvedEnv, 'durationMs'>): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolveP({ ...r, durationMs: Date.now() - t0 })
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(shellPath, ['-ilc', ENV_SCRIPT], {
        env,
        // detached: sem terminal de controle (o zsh interativo não tenta pegar o tty)
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'ignore']
      })
    } catch (e) {
      finish({ env: null, error: (e as Error).message })
      return
    }
    const timer = setTimeout(() => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL')
      } catch {
        /* já saiu */
      }
      finish({ env: null, error: `tempo esgotado (${timeoutMs} ms)` })
    }, timeoutMs)
    child.stdout?.on('data', (d: Buffer) => {
      out += d.toString('utf8')
      if (out.length > 8_000_000) out = out.slice(-8_000_000)
    })
    child.on('error', (e) => finish({ env: null, error: e.message }))
    child.on('close', (code) => {
      const parsed = parseEnvOutput(out)
      finish(
        parsed
          ? { env: parsed }
          : { env: null, error: `saída sem o ambiente (exit code ${code ?? '?'})` }
      )
    })
  })
}

let envPromise: Promise<ResolvedEnv> | null = null

/** Env do usuário (resolvido uma vez; chamadas concorrentes compartilham a mesma resolução). */
export function userEnv(): Promise<ResolvedEnv> {
  if (!envPromise) {
    if (process.env.CLEARCHAT_SKIP_SHELL_ENV === '1') {
      envPromise = Promise.resolve({ env: null, error: 'desligado', durationMs: 0 })
    } else {
      const sh = resolveShell()
      envPromise = resolveUserEnv(sh.path).then((r) => {
        if (r.env) console.log(`[clearchat] ambiente do ${sh.name} resolvido em ${r.durationMs} ms`)
        else console.warn(`[clearchat] ambiente do ${sh.name} não resolvido: ${r.error}`)
        return r
      })
    }
  }
  return envPromise
}

/** Começa a resolver no start do app (não bloqueia). */
export function warmUserEnv(): void {
  void userEnv()
}

/** Testes: injeta (ou limpa) o env resolvido. */
export function _setUserEnv(r: ResolvedEnv | null): void {
  envPromise = r ? Promise.resolve(r) : null
}

/** Ambiente de execução + argumentos do shell (`-c` com env resolvido; `-lc` sem). */
export async function shellLaunch(
  extra: Record<string, string>
): Promise<{ shell: ShellInfo; env: NodeJS.ProcessEnv; flag: '-c' | '-lc' }> {
  const shell = resolveShell()
  const r = await userEnv()
  const env: NodeJS.ProcessEnv = { ...process.env, ...(r.env ?? {}), ...extra }
  delete env.ELECTRON_RUN_AS_NODE
  return { shell, env, flag: r.env ? '-c' : '-lc' }
}
