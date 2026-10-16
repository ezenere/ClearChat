// Configuração GLOBAL do web_search (setting genérico via settings:get/set): intervalo mínimo entre
// pesquisas, em segundos. Lido pelo main a cada pesquisa (tools/web.ts) e editado em Configurações.
export const SEARCH_INTERVAL_SETTING = 'webSearchMinIntervalSec'
export const SEARCH_INTERVAL_DEFAULT_S = 5
export const SEARCH_INTERVAL_MAX_S = 60

/** Número de 0 a 60 (1 casa decimal); ausente/inválido → padrão (5). */
export function normalizeSearchInterval(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN
  if (!Number.isFinite(n)) return SEARCH_INTERVAL_DEFAULT_S
  return Math.min(SEARCH_INTERVAL_MAX_S, Math.max(0, Math.round(n * 10) / 10))
}
