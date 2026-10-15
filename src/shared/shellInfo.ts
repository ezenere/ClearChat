// Shell do usuário (detectado no main no start do app) — usado na descrição da tool `shell` para o
// modelo usar a sintaxe certa. Puro/compartilhado: o main injeta (setToolShellInfo) ao detectar; o
// renderer recebe via app.capabilities().shell e injeta igual (mesma descrição no (i) / preview).
// A descrição é determinística por máquina (só nome, versão e SO) — estável para cache de prompt.

/** 'pwsh' reservado para o futuro (Windows) — hoje o main só escolhe zsh ou bash. */
export type ShellKind = 'zsh' | 'bash' | 'pwsh'

export interface ShellInfoLite {
  name: ShellKind
  /** Ex.: "5.9", "3.2.57". Ausente = ainda não detectada / falhou. */
  version?: string
  /** Ex.: "macOS", "Linux". */
  os?: string
}

const major = (v: string | undefined): number => {
  const n = v ? parseInt(v, 10) : NaN
  return Number.isFinite(n) ? n : NaN
}

/** "zsh 5.9 (macOS)" */
export function shellInfoLabel(info: ShellInfoLite): string {
  return `${info.name}${info.version ? ` ${info.version}` : ''}${info.os ? ` (${info.os})` : ''}`
}

/** Uma linha de dicas de sintaxe (vazia quando não há nada especial). */
export function shellSyntaxTips(info: ShellInfoLite): string {
  if (info.name === 'zsh')
    return 'use sintaxe zsh: arrays começam em 1; glob sem correspondência é erro (nomatch — use aspas ou `setopt nullglob`); $var não sofre word splitting (use ${=var} para dividir).'
  if (info.name === 'bash' && major(info.version) < 4)
    return 'bash 3.2 antigo: sem arrays associativos (declare -A), mapfile/readarray, ${var,,}/${var^^} nem `|&`.'
  if (info.name === 'pwsh') return 'use sintaxe PowerShell.'
  return ''
}

/** Prefixo da descrição da tool `shell` com o shell detectado. */
export function shellDescriptionPrefix(info: ShellInfoLite | null): string {
  if (!info) return 'Executa um comando no shell do usuário (zsh ou bash)'
  const tips = shellSyntaxTips(info)
  return `Executa um comando no shell do usuário: ${shellInfoLabel(info)}${tips ? ` — ${tips}` : ''}`
}

let current: ShellInfoLite | null = null

/** Injeta o shell detectado (main no start; renderer a partir de app.capabilities). */
export function setToolShellInfo(info: ShellInfoLite | null): void {
  current = info ? { ...info } : null
}

export function toolShellInfo(): ShellInfoLite | null {
  return current
}
