// "Executar…" do visualizador de arquivos (main, sem Electron — testável com dependências falsas):
// reclassifica o arquivo pela extensão + sistema (nunca confia na classe que o renderer mostrou),
// monta o plano de execução (argumentos em lista; o caminho nunca é interpolado numa string de
// shell), pede confirmação (diálogo nativo do main, padrão Cancelar) e roda. Só arquivos concedidos
// ao visualizador (token do ViewerRegistry) ou cópias temporárias privadas de arquivos do host
// (controle remoto). Ver SPEC.md → "Visualizador de arquivos" → "Ações por tipo".
import { spawn } from 'child_process'
import { accessSync, constants as fsc, promises as fs, statSync } from 'fs'
import { basename, delimiter, dirname, isAbsolute, join, win32 } from 'path'
import {
  classifyFileAction,
  hostOsOf,
  openBlockedReason,
  otherOsNote,
  type FileAction,
  type RunMethod
} from '@shared/fileActions'
import { formatSize } from '@shared/attachments'
import { safeFileName } from '@shared/remoteFs'
import { grantedPath, viewerRegistry, type ViewerRegistry } from './fileViewer'
import { checkedBytes, viewerTempPathFor, writeViewerTempForRun } from './viewerTemp'

// ---------------- plano (puro) ----------------

/** O que o plano precisa saber da máquina (testes injetam). */
export interface PlanEnv {
  /** `process.platform`. */
  platform: string
  /** Caminho absoluto de um executável no PATH (null = não há). */
  which(cmd: string): string | null
  /** %SystemRoot% (Windows) — cmd.exe/powershell.exe pelo caminho absoluto, nunca pela pasta atual. */
  systemRoot?: string
}

export type RunPlan =
  | { kind: 'open'; file: string }
  | {
      kind: 'spawn'
      file: string
      command: string
      args: string[]
      cwd: string
      /** Variáveis a mais (Windows: o caminho vai por variável, entre aspas, nunca na linha). */
      env?: Record<string, string>
      /** Windows: linha de comando montada por nós (regras do cmd). */
      verbatim?: boolean
      /** chmod u+x antes (AppImage, .command/.sh do macOS). */
      chmod?: boolean
    }
  | { kind: 'error'; message: string }

/** Variável com o caminho do arquivo (Windows: `"%CLEARCHAT_RUN_FILE%"` dentro de aspas). */
export const RUN_FILE_ENV = 'CLEARCHAT_RUN_FILE'

/** Terminais do Linux, na ordem de preferência, e como cada um recebe o comando (lista). */
export const LINUX_TERMINALS: readonly { bin: string; args: (cmd: string[]) => string[] }[] = [
  { bin: 'x-terminal-emulator', args: (c) => ['-e', ...c] },
  { bin: 'gnome-terminal', args: (c) => ['--', ...c] },
  { bin: 'konsole', args: (c) => ['-e', ...c] },
  { bin: 'xfce4-terminal', args: (c) => ['-x', ...c] },
  { bin: 'kitty', args: (c) => c },
  { bin: 'alacritty', args: (c) => ['-e', ...c] },
  { bin: 'wezterm', args: (c) => ['start', '--', ...c] },
  { bin: 'xterm', args: (c) => ['-e', ...c] }
]

/** Primeiro terminal disponível rodando `cmd` (null = nenhum). */
export function linuxTerminalCommand(
  which: (cmd: string) => string | null,
  cmd: string[]
): { command: string; args: string[] } | null {
  for (const t of LINUX_TERMINALS) {
    const path = which(t.bin)
    if (path) return { command: path, args: t.args(cmd) }
  }
  return null
}

// O caminho chega como $1 (bash -c SCRIPT clearchat <arquivo>): nunca entra no texto do script.
const HOLD =
  's=$?; echo; printf \'%s\' "[terminou com código $s] Pressione Enter para fechar…"; read -r _'
export const TERMINAL_BASH_SCRIPT = `cd -- "\${1%/*}" 2>/dev/null; bash -- "$1"; ${HOLD}`
export const TERMINAL_EXEC_SCRIPT = `cd -- "\${1%/*}" 2>/dev/null; "$1"; ${HOLD}`

const NO_TERMINAL =
  'Nenhum terminal encontrado (x-terminal-emulator, gnome-terminal, konsole, xfce4-terminal, kitty, alacritty, wezterm, xterm) — use “Salvar como…” (ou “Mostrar na pasta”) e rode pelo seu terminal.'

/** Plano de execução de `file` (absoluto) pelo método da classificação. */
export function buildRunPlan(file: string, method: RunMethod, env: PlanEnv): RunPlan {
  const cwd = dirname(file)
  switch (method) {
    case 'open':
      return { kind: 'open', file }
    case 'cmd':
    case 'powershell': {
      // o cmd expande %…% mesmo entre aspas: caminho com % ou aspas não passa
      if (/["%\r\n\0]/.test(file))
        return {
          kind: 'error',
          message:
            'O caminho do arquivo tem caracteres que o Prompt de Comando interpretaria (% ou aspas) — renomeie o arquivo ou use “Salvar como…”.'
        }
      const sys = win32.join(env.systemRoot || 'C:\\Windows', 'System32')
      const cmdExe = win32.join(sys, 'cmd.exe')
      const target = `"%${RUN_FILE_ENV}%"`
      // `start` abre uma janela de console nova e visível; o 1º argumento entre aspas é o título.
      // `/k call "<arquivo>"`: começa sem aspas → o cmd mantém as aspas (& etc. ficam literais).
      const inner =
        method === 'cmd'
          ? [`"${cmdExe}"`, '/d', '/v:off', '/k', 'call', target]
          : [
              `"${win32.join(sys, 'WindowsPowerShell', 'v1.0', 'powershell.exe')}"`,
              '-NoExit',
              '-ExecutionPolicy',
              'Bypass',
              '-File',
              target
            ]
      return {
        kind: 'spawn',
        file,
        command: cmdExe,
        args: ['/d', '/c', 'start', '"ClearChat"', ...inner],
        cwd,
        env: { [RUN_FILE_ENV]: file },
        verbatim: true
      }
    }
    case 'terminal-bash':
    case 'terminal-exec': {
      const script = method === 'terminal-bash' ? TERMINAL_BASH_SCRIPT : TERMINAL_EXEC_SCRIPT
      const bash = env.which('bash') ?? 'bash'
      const t = linuxTerminalCommand(env.which, [bash, '-c', script, 'clearchat', file])
      if (!t) return { kind: 'error', message: NO_TERMINAL }
      return { kind: 'spawn', file, command: t.command, args: t.args, cwd }
    }
    case 'appimage':
      return { kind: 'spawn', file, command: file, args: [], cwd, chmod: true }
    case 'mac-terminal':
      return {
        kind: 'spawn',
        file,
        command: '/usr/bin/open',
        args: ['-a', 'Terminal', file],
        cwd,
        chmod: true
      }
  }
}

/** Texto do diálogo de confirmação (nome, tamanho, origem/pasta, como roda). */
export function runConfirmText(o: {
  name: string
  size: number
  method: RunMethod
  platform: string
  /** Arquivo local: a pasta dele. */
  dir?: string
  /** Arquivo do host (controle remoto): o nome do host. */
  origin?: string
}): { message: string; detail: string } {
  const how: Record<RunMethod, string> = {
    open:
      hostOsOf(o.platform) === 'macos'
        ? 'Abre com o instalador/montador do macOS.'
        : 'Abre com o Windows: o programa ou instalador roda com as suas permissões.',
    cmd: 'Roda numa janela do Prompt de Comando (cmd), que fica aberta no fim.',
    powershell:
      'Roda numa janela do PowerShell com ExecutionPolicy Bypass (a política de execução de scripts do sistema é ignorada para este arquivo).',
    'terminal-bash': 'Abre um terminal e roda o script com bash.',
    'terminal-exec': 'Abre um terminal e executa o arquivo.',
    appimage: 'Marca o arquivo como executável e abre o aplicativo.',
    'mac-terminal': 'Marca o arquivo como executável e roda no Terminal.'
  }
  const lines = [
    `Tamanho: ${formatSize(o.size)}`,
    o.origin
      ? `Veio de ${o.origin} — roda uma cópia temporária neste computador.`
      : `Pasta: ${o.dir ?? '?'}`,
    how[o.method],
    '',
    'Só execute arquivos em que você confia: o programa roda com as suas permissões (arquivos, rede).'
  ]
  return { message: `Executar “${o.name}”?`, detail: lines.join('\n') }
}

// ---------------- execução ----------------

export interface RunDeps extends PlanEnv {
  /** Diálogo nativo (botões Cancelar | Executar, padrão Cancelar). true = executar. */
  confirm(text: { message: string; detail: string }): Promise<boolean>
  /** shell.openPath ('' = ok; senão a mensagem de erro). */
  openPath(path: string): Promise<string>
  /** Processo destacado, sem stdio, sem esperar (spawnDetached). */
  spawn(
    command: string,
    args: string[],
    opts: { cwd: string; env?: Record<string, string>; verbatim?: boolean }
  ): Promise<void>
  /** chmod u+x. */
  chmodX(path: string): Promise<void>
  log(message: string): void
}

function notRunnable(a: FileAction): string {
  return a.class === 'executable-other-os'
    ? `${otherOsNote(a.os)}.`
    : 'Este arquivo não é um executável deste sistema.'
}

async function execute(plan: Exclude<RunPlan, { kind: 'error' }>, deps: RunDeps): Promise<void> {
  if (plan.kind === 'open') {
    const err = await deps.openPath(plan.file)
    if (err) throw new Error(err)
    return
  }
  if (plan.chmod) await deps.chmodX(plan.file)
  await deps.spawn(plan.command, plan.args, {
    cwd: plan.cwd,
    ...(plan.env ? { env: plan.env } : {}),
    ...(plan.verbatim ? { verbatim: true } : {})
  })
}

/**
 * "Executar…" de um arquivo LOCAL concedido ao visualizador (token). Lança se o token não foi
 * concedido, se o arquivo mudou de lugar ou não é executável deste sistema. false = cancelado.
 */
export async function runGrantedFile(
  token: unknown,
  deps: RunDeps,
  registry: ViewerRegistry = viewerRegistry
): Promise<boolean> {
  const file = grantedPath(token as string, registry)
  const current = async (): Promise<{ size: number; mode: number }> => {
    if ((await fs.realpath(file)) !== file)
      throw new Error('O arquivo mudou de lugar (abra-o de novo).')
    const st = await fs.stat(file)
    if (!st.isFile()) throw new Error('Não é um arquivo comum.')
    return { size: st.size, mode: st.mode }
  }
  const st = await current()
  const name = basename(file)
  const action = classifyFileAction(name, deps.platform, {
    localExecutable: (st.mode & 0o111) !== 0
  })
  if (action.class !== 'executable-here' || !action.method) throw new Error(notRunnable(action))
  const plan = buildRunPlan(file, action.method, deps)
  if (plan.kind === 'error') throw new Error(plan.message)
  const ok = await deps.confirm(
    runConfirmText({
      name,
      size: st.size,
      method: action.method,
      platform: deps.platform,
      dir: dirname(file)
    })
  )
  if (!ok) {
    deps.log(`cancelado: ${file}`)
    return false
  }
  // trocado enquanto o diálogo estava aberto → não roda
  if ((await current()).size !== st.size) throw new Error('O arquivo mudou — abra-o de novo.')
  deps.log(`${action.method}: ${file}`)
  await execute(plan, deps)
  return true
}

/**
 * "Executar…" de um arquivo buscado do host (controle remoto): `origin` = nome do host do chat
 * (null = o chat não está em controle remoto → recusa). Classifica pelo nome (sem bit de execução),
 * confirma, grava a cópia privada (pasta 0700, arquivo 0700) e roda. false = cancelado.
 */
export async function runRemoteBytes(
  name: unknown,
  bytes: unknown,
  origin: string | null,
  deps: RunDeps,
  dir?: string
): Promise<boolean> {
  if (!origin) throw new Error('Só arquivos do host de um chat em controle remoto.')
  const safe = safeFileName(String(name ?? ''))
  const action = classifyFileAction(safe, deps.platform)
  if (action.class !== 'executable-here' || !action.method) throw new Error(notRunnable(action))
  const buf = checkedBytes(bytes)
  // falta de terminal etc. antes de perguntar (o caminho real só existe depois da confirmação)
  const pre = buildRunPlan(viewerTempPathFor(safe, dir), action.method, deps)
  if (pre.kind === 'error') throw new Error(pre.message)
  const ok = await deps.confirm(
    runConfirmText({
      name: safe,
      size: buf.length,
      method: action.method,
      platform: deps.platform,
      origin
    })
  )
  if (!ok) {
    deps.log(`cancelado: ${safe} (de ${origin})`)
    return false
  }
  const file = writeViewerTempForRun(safe, buf, dir)
  const plan = buildRunPlan(file, action.method, deps)
  if (plan.kind === 'error') throw new Error(plan.message)
  deps.log(`${action.method} (de ${origin}): ${file}`)
  await execute(plan, deps)
  return true
}

/** "Abrir no app" de um arquivo local concedido: recusa executáveis (deste sistema ou de outro). */
export async function assertCanOpenLocal(file: string, platform: string): Promise<void> {
  const st = await fs.stat(file)
  const why = openBlockedReason(basename(file), platform, {
    localExecutable: (st.mode & 0o111) !== 0
  })
  if (why) throw new Error(why)
}

// ---------------- implementações reais (ipc.ts liga) ----------------

/** `which`: primeiro executável com esse nome nas pastas ABSOLUTAS do PATH. */
export function whichSync(cmd: string, pathEnv: string = process.env.PATH ?? ''): string | null {
  for (const d of pathEnv.split(delimiter)) {
    if (!d || !isAbsolute(d)) continue
    const p = join(d, cmd)
    try {
      if (!statSync(p).isFile()) continue
      accessSync(p, fsc.X_OK)
      return p
    } catch {
      /* não está aqui */
    }
  }
  return null
}

/** Processo destacado (sem stdio, não espera); rejeita se não conseguir iniciar. */
export function spawnDetached(
  command: string,
  args: string[],
  opts: { cwd: string; env?: Record<string, string>; verbatim?: boolean }
): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      const child = spawn(command, args, {
        cwd: opts.cwd,
        env: opts.env ? { ...process.env, ...opts.env } : process.env,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        windowsVerbatimArguments: !!opts.verbatim
      })
      child.once('error', reject)
      child.once('spawn', () => {
        child.unref()
        resolve()
      })
    } catch (e) {
      reject(e)
    }
  })
}

/** chmod u+x (mantém o resto das permissões). */
export async function chmodX(path: string): Promise<void> {
  const st = await fs.stat(path)
  if ((st.mode & 0o100) === 0) await fs.chmod(path, (st.mode & 0o7777) | 0o100)
}
