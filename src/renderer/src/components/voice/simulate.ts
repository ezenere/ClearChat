// Modo de simulação de níveis para o mock de UI (VITE_CLEAR_MOCK): "fala" falsa determinística
// para alimentar o `Waveform` sem captura real. Função pura (mesmo frame = mesmo valor), extraída
// do componente para o Fast Refresh (um arquivo = um componente exportado).

/** Nível simulado (0..1) determinístico no tempo — envelope + harmônicos plausíveis de fala. */
export function simulatedLevel(timeMs: number): number {
  const t = (Number.isFinite(timeMs) ? Math.max(0, timeMs) : 0) / 1000
  const envelope = 0.55 + 0.45 * Math.sin(t * 1.7) * Math.sin(t * 0.6 + 1.2)
  const detail = 0.5 + 0.25 * Math.sin(t * 13.7) + 0.15 * Math.sin(t * 7.3 + 0.8)
  return Math.min(1, Math.max(0.02, envelope * detail))
}
