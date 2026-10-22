// Métricas simples da chamada de voz a partir da timeline (funções puras, sem DOM — SPEC →
// "Modo sombra e timeline"); alimentam o painel do dock (`VoiceCallDock`). A timeline junta os
// eventos do main (`voice:call:timeline`) e do sensor (renderer) — ver `VoiceCallTimelineEvent`.
import type { VoiceCallTimelineEvent } from './ipc'

/** Latência decisão→início do áudio (ms) em percentis; null quando não há pares. */
export interface DecisionLatency {
  p50: number
  p95: number
}

export interface VoiceCallMetrics {
  /** Duração da chamada coberta pela timeline (ms). */
  elapsedMs: number
  /** Decisões de interjeição (todas: tocadas, sombra e descartadas). */
  decisions: number
  /** Decisões que tocaram de fato. */
  played: number
  /** Interjeições por minuto da chamada (decisões/elapsed; 0 sem tempo). */
  interjectionsPerMin: number
  /** Latência decisão→início do áudio da utterance decidida (p50/p95). */
  decisionToAudioMs: DecisionLatency | null
}

/** Percentil por ordem (p em [0,1]; lista não vazia e já ordenada). */
function percentile(sorted: number[], p: number): number {
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))
  return sorted[idx]
}

/**
 * Métricas da chamada atual: interjeições/min (decisões de interjeição, sem fillers) e p50/p95 da
 * latência decisão→áudio (pareia cada `decision` com o `clip-start` da MESMA utterance `id`).
 * `now` (ms) fecha o tempo da chamada; padrão: o ts do último evento.
 */
export function computeVoiceCallMetrics(
  events: readonly VoiceCallTimelineEvent[],
  now?: number
): VoiceCallMetrics {
  const list = [...events].sort((a, b) => a.ts - b.ts)
  const first = list[0]?.ts ?? 0
  const last = now ?? list[list.length - 1]?.ts ?? first
  const elapsedMs = Math.max(0, last - first)
  const decisions = list.filter((e) => e.kind === 'decision' && e.class !== 'FILLER')
  const played = decisions.filter((e) => e.played)
  const minutes = elapsedMs / 60_000
  // pares decisão → início do áudio (mesma utterance; o primeiro início vence)
  const starts = new Map<string, number>()
  for (const e of list) {
    if (e.kind === 'clip-start' && e.id && !starts.has(e.id)) starts.set(e.id, e.ts)
  }
  const latencies: number[] = []
  for (const d of decisions) {
    if (!d.id || !d.played) continue
    const start = starts.get(d.id)
    if (start != null && start >= d.ts) latencies.push(start - d.ts)
  }
  latencies.sort((a, b) => a - b)
  return {
    elapsedMs,
    decisions: decisions.length,
    played: played.length,
    interjectionsPerMin: minutes > 0 ? Math.round((decisions.length / minutes) * 10) / 10 : 0,
    decisionToAudioMs: latencies.length
      ? { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95) }
      : null
  }
}
