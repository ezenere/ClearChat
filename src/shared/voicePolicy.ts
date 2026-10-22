// Atos de fala curta da chamada de voz — política PURA (sem Electron/UI/IPC/fS): regras dos
// fillers (fase 1) e das interjeições/backchannel (fase 2), testáveis em `e2e/voiceCallActs.test.ts`.
// O consumo real: `src/main/voice/call.ts` (fillers/interjeições, sombra) e
// `src/renderer/src/lib/voice/useVoiceCall.ts` (detector de pausas/bargem-in). Ver SPEC.md →
// "Áudio → Chamada de voz (meia-duplex)" (subseções "Fillers" e "Interjeições (regras)").
//
// v1 é por REGRA (sem classificador treinado): os limiares abaixo + a cauda textual da transcrição
// parcial decidem. `VoiceFillers.prompt`/`InterjectionPolicy` existem na config; o `prompt` dos
// fillers NÃO é consumido em v1 — fica pronto para o classificador futuro (documentado na SPEC).

// ---------------- constantes de tempo ----------------

/** Espera da 1ª sentença da resposta antes de tocar um filler (ms). */
export const FILLER_DELAY_MS = 1200

/**
 * Fala do usuário curta DURANTE a reprodução (ms de fala detectada) = provável backchannel do
 * usuário ("uhum", "sim") — não cancela a resposta; acima disso é barge-in real (cancela).
 */
export const BACKCHANNEL_MAX_MS = 800

/**
 * Validade de uma decisão de interjeição (ms): decisão que "chega" > 600 ms tarde demais é
 * descartada (o momento da pausa passou — tocar depois vira interrupção).
 */
export const INTERJECTION_MAX_AGE_MS = 600

/** Cauda da transcrição parcial considerada pela regra de classe (caracteres). */
export const INTERJECTION_TAIL_CHARS = 80

/** Teto da cauda de texto guardada no log de avaliação (caracteres). */
export const EVAL_TAIL_MAX_CHARS = 80

// ---------------- fillers (fase 1) ----------------

/** Estado do filler do turno em andamento (quem decide = `fillerShouldFire`). */
export interface FillerState {
  /** Momento em que o turno do usuário foi disparado (ms); null = sem turno em andamento. */
  turnStartedAt: number | null
  /** Há tools em execução no turno (o espera costuma ser longa → filler já). */
  toolsRunning: boolean
  /** O agente já falou algo neste turno (1ª utterance de sentença emitida). */
  spokenThisTurn: boolean
  /** O filler deste turno já foi disparado (máximo 1 por turno). */
  usedThisTurn: boolean
  /** A resposta está em voo (sem resposta, não há o que esperar). */
  responseInFlight: boolean
  /** `fillers.enabled` resolvido (persona→chat→global). */
  enabled: boolean
}

/** Estado vazio (turno em repouso). */
export const EMPTY_FILLER_STATE: FillerState = {
  turnStartedAt: null,
  toolsRunning: false,
  spokenThisTurn: false,
  usedThisTurn: false,
  responseInFlight: false,
  enabled: true
}

/**
 * O filler deste turno deve tocar AGORA? Regra v1 (por regra, sem classificador):
 * - no máximo 1 por turno (`usedThisTurn`) e NUNCA depois da 1ª fala do agente (`spokenThisTurn`);
 * - com tools em execução, dispara já; senão após `delayMs` sem a 1ª sentença tocar;
 * - só com resposta em voo e filler habilitado.
 */
export function fillerShouldFire(
  s: FillerState,
  now: number,
  delayMs: number = FILLER_DELAY_MS
): boolean {
  if (!s.enabled || s.usedThisTurn || s.spokenThisTurn || !s.responseInFlight) return false
  if (s.turnStartedAt == null) return false
  if (s.toolsRunning) return true
  const wait = Number.isFinite(delayMs) && delayMs > 0 ? delayMs : FILLER_DELAY_MS
  return now - s.turnStartedAt >= wait
}

// ---------------- variantes de clipe ----------------

/**
 * Variante de clipe 1..`variants` com rotação sem repetir a última: sorteio uniforme via `rng`
 * (injetável — testes usam PRNG fake); caiu na última → a seguinte na rotação.
 */
export function pickClipVariant(rng: () => number, last: number | null, variants = 3): number {
  const n = Number.isFinite(variants) && variants >= 1 ? Math.floor(variants) : 1
  // rng chamado UMA vez (pode ser stateful); lixo/fora de [0,1) é aparado
  let r = typeof rng === 'function' ? Number(rng()) : NaN
  if (!Number.isFinite(r)) r = Math.random()
  const v = Math.min(n, Math.max(1, Math.floor(Math.min(Math.max(r, 0), 0.999999999) * n) + 1))
  if (last == null || v !== last) return v
  return (last % n) + 1
}
