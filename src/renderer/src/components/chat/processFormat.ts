// Formatação de processos em segundo plano (chip/popover e ToolCard).
import type { ProcessInfo } from '@shared/types'

export function fmtUptime(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}min`
  const h = Math.floor(m / 60)
  return h < 24 ? `${h}h${m % 60 ? ` ${m % 60}min` : ''}` : `${Math.floor(h / 24)}d ${h % 24}h`
}

export function processState(p: ProcessInfo, now = Date.now()): string {
  if (p.status === 'running') return `rodando há ${fmtUptime(now - p.startedAt)}`
  return p.exitCode !== null
    ? `saiu (código ${p.exitCode})`
    : p.signal
      ? `encerrado (${p.signal})`
      : 'falhou ao iniciar'
}

/** Encerrado com falha (código ≠ 0, sinal ou erro ao iniciar). */
export const processFailed = (p: ProcessInfo): boolean => p.status === 'exited' && p.exitCode !== 0

export type ProcessesChip =
  { kind: 'running'; count: number } | { kind: 'finished'; count: number; failed: number } | null

/**
 * Chip do header a partir da lista do chat (a mesma do process_list): verde com os que rodam;
 * sem nenhum rodando mas com encerrados ainda listados → neutro (com aviso se algum falhou);
 * lista vazia → sem chip.
 */
export function processesChip(list: readonly ProcessInfo[]): ProcessesChip {
  const running = list.filter((p) => p.status === 'running').length
  if (running) return { kind: 'running', count: running }
  if (!list.length) return null
  return { kind: 'finished', count: list.length, failed: list.filter(processFailed).length }
}
