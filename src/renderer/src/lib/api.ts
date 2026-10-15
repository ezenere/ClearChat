import type { ClearApi } from '@shared/ipc'

/**
 * Acesso ao `window.api` (preload). É uma binding mutável apenas para que o build de
 * desenvolvimento com `VITE_CLEAR_MOCK=1` possa instalar um mock (ver main.tsx). Em produção
 * o mock nunca é importado e `api === window.api`.
 */
export let api: ClearApi = window.api

export function installApi(next: ClearApi): void {
  api = next
}

/** Mensagem legível de um erro vindo do IPC (remove o prefixo "Error invoking remote method"). */
export function errorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  return raw.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}
