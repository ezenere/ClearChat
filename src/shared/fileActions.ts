// Ações por tipo de arquivo no visualizador (barra do painel, painel sem prévia, cards de
// present_file, duplo clique da aba Arquivos) — pela EXTENSÃO e pelo SISTEMA deste computador:
// - `document`: abre no app padrão ("Abrir no app");
// - `executable-here`: roda neste sistema → "Executar…" (sempre com confirmação no main);
// - `executable-other-os`: executável de outro sistema → só "Salvar como…" / "Mostrar na pasta";
// - `unknown`: sem tipo conhecido (ou um tipo que o sistema executa ao abrir e que não tem caminho
//   de execução próprio aqui) → comportamento de antes ("Abrir no app"; remoto recusa os perigosos).
// Puro (main e renderer). O main reclassifica antes de abrir/rodar — nunca confia na classe que o
// renderer mostrou. Ver SPEC.md → "Visualizador de arquivos" → "Ações por tipo".
import { fileExtOf, kindFromName } from './fileViewer'

export type HostOs = 'windows' | 'linux' | 'macos'

export type FileActionClass = 'document' | 'executable-here' | 'executable-other-os' | 'unknown'

/** Como o main roda um `executable-here` (ver src/main/fileRun.ts). */
export type RunMethod =
  /** shell.openPath — programa/instalador do Windows; .pkg/.dmg/.app: instalador/montador do macOS. */
  | 'open'
  /** Janela visível do Prompt de Comando (`cmd /k`) — .bat/.cmd. */
  | 'cmd'
  /** Janela visível do PowerShell (`-NoExit -ExecutionPolicy Bypass -File`) — .ps1. */
  | 'powershell'
  /** Terminal visível com `bash <arquivo>` e "pressione Enter" no fim — .sh/.run (Linux). */
  | 'terminal-bash'
  /** Terminal visível executando o próprio arquivo — sem extensão e marcado executável (Linux, local). */
  | 'terminal-exec'
  /** chmod +x e roda destacado — .AppImage. */
  | 'appimage'
  /** chmod +x e `open -a Terminal <arquivo>` — .command/.sh (macOS). */
  | 'mac-terminal'

export interface FileAction {
  class: FileActionClass
  /** `executable-here`: como rodar. */
  method?: RunMethod
  /** `executable-other-os`: de qual sistema ("Windows", "macOS", "Linux/macOS"). */
  os?: string
}

export const OS_LABEL: Record<HostOs, string> = {
  windows: 'Windows',
  linux: 'Linux',
  macos: 'macOS'
}

const ALL_OS: HostOs[] = ['windows', 'linux', 'macos']

/** `process.platform` → sistema (BSDs e afins contam como Linux). */
export function hostOsOf(platform: string): HostOs {
  return platform === 'win32' ? 'windows' : platform === 'darwin' ? 'macos' : 'linux'
}

/** Extensões executáveis por sistema → como rodar. `.bin` fica de fora (quase sempre é dado). */
export const RUN_EXTS: Record<HostOs, Readonly<Record<string, RunMethod>>> = {
  windows: {
    exe: 'open',
    msi: 'open',
    com: 'open',
    appx: 'open',
    msix: 'open',
    appxbundle: 'open',
    msixbundle: 'open',
    bat: 'cmd',
    cmd: 'cmd',
    ps1: 'powershell'
  },
  linux: { sh: 'terminal-bash', run: 'terminal-bash', appimage: 'appimage' },
  macos: { command: 'mac-terminal', sh: 'mac-terminal', pkg: 'open', dmg: 'open', app: 'open' }
}

/**
 * Tipos que o app padrão do sistema EXECUTA (ou instala) ao abrir e para os quais não há caminho
 * de execução com confirmação aqui: ficam `unknown` (comportamento antigo — local abre; cópia de
 * outro dispositivo é recusada: "Salvar como…").
 */
const OPENS_AS_PROGRAM: Record<HostOs, ReadonlySet<string>> = {
  windows: new Set(
    (
      'js jse vbs vbe wsf wsh hta scr pif cpl msc msp reg lnk url jar psm1 inf scf application ' +
      'appref-ms settingcontent-ms gadget'
    ).split(' ')
  ),
  linux: new Set('desktop jar deb rpm bash zsh csh'.split(' ')),
  macos: new Set('tool terminal scpt scptd workflow action jar bash zsh csh'.split(' '))
}

/**
 * Classe do arquivo neste sistema. `localExecutable` = o arquivo LOCAL tem bit de execução (só o
 * main sabe; vale para arquivo sem extensão no Linux — nunca para cópia de outro dispositivo).
 */
export function classifyFileAction(
  name: string,
  platform: string,
  opts: { localExecutable?: boolean } = {}
): FileAction {
  const os = hostOsOf(platform)
  const ext = fileExtOf(name)
  const here = ext ? RUN_EXTS[os][ext] : undefined
  if (here) return { class: 'executable-here', method: here }
  if (!ext && os === 'linux' && opts.localExecutable)
    return { class: 'executable-here', method: 'terminal-exec' }
  const others = ext ? ALL_OS.filter((o) => o !== os && RUN_EXTS[o][ext]) : []
  if (others.length)
    return { class: 'executable-other-os', os: others.map((o) => OS_LABEL[o]).join('/') }
  if (ext && OPENS_AS_PROGRAM[os].has(ext)) return { class: 'unknown' }
  return { class: kindFromName(name) ? 'document' : 'unknown' }
}

/** Nota curta de um executável de outro sistema ("Executável de Windows — não roda neste sistema"). */
export const otherOsNote = (os: string | undefined): string =>
  `Executável de ${os ?? 'outro sistema'} — não roda neste sistema`

/**
 * Por que "Abrir no app" (shell.openPath) é recusado; null = pode abrir. `remote` = cópia
 * temporária de um arquivo de outro dispositivo (controle remoto), que também recusa os tipos que
 * o sistema executa ao abrir.
 */
export function openBlockedReason(
  name: string,
  platform: string,
  opts: { remote?: boolean; localExecutable?: boolean } = {}
): string | null {
  const a = classifyFileAction(name, platform, opts.remote ? {} : opts)
  if (a.class === 'executable-here')
    return opts.remote
      ? 'Arquivo executável — use “Executar…” (pede confirmação) ou “Salvar como…”.'
      : 'Arquivo executável — use “Executar…” (pede confirmação).'
  if (a.class === 'executable-other-os')
    return `${otherOsNote(a.os)}.${opts.remote ? ' Use “Salvar como…”.' : ''}`
  if (opts.remote && OPENS_AS_PROGRAM[hostOsOf(platform)].has(fileExtOf(name)))
    return 'Por segurança, este tipo de arquivo (o sistema o executa ao abrir) não é aberto direto quando vem de outro dispositivo — use “Salvar como…”.'
  return null
}
