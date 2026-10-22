// Registro de avaliação dos atos de fala curta da chamada de voz (SPEC → "Modo sombra e
// timeline"): um JSONL por dia em `<userData>/voice-eval/<YYYY-MM-DD>.jsonl`, UMA LINHA POR
// DECISÃO (filler/interjeição — tocadas, em modo sombra ou descartadas) com ts, classe, variante,
// duração da fala/pausa, cauda da transcrição truncada e a latência decisão→tocaria. Serve à
// calibração futura das regras (v1 é por regra, sem classificador). Sem Electron — `baseDir`
// injetado; escrita tolerante (falha de disco nunca derruba a chamada). Nada de dado além disso
// é gravado (a cauda vem truncada a `EVAL_TAIL_MAX_CHARS`).
import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { EVAL_TAIL_MAX_CHARS } from '@shared/voicePolicy'

/** Uma decisão de ato de fala registrada no log de avaliação (uma linha JSON por decisão). */
export interface VoiceEvalEvent {
  /** Momento da decisão (ms desde epoch). */
  ts: number
  /** Origem da decisão. */
  kind: 'interjection' | 'filler'
  /** Classe do clipe decidido ('ACK' | 'AGREEMENT' | 'ENCOURAGEMENT' | 'THINKING' | 'FILLER'). */
  class: string
  /** Variante decidida (1..3). */
  variant: number
  /** Tocou de fato (false = modo sombra ou descartada). */
  played: boolean
  /** A chamada estava em modo sombra (`interjections.shadow`). */
  shadow: boolean
  /** Fala do usuário até a decisão (ms; null em fillers). */
  speechMs: number | null
  /** Pausa do usuário na decisão (ms; null em fillers). */
  pauseMs: number | null
  /** Cauda da transcrição parcial considerada (truncada; null em fillers). */
  tail: string | null
  /** Latência decisão→tocaria (ms — carga do clipe incluída). */
  latencyMs: number
  /** Motivo/regra (ex.: 'ok', 'delay', 'tools', 'shadow', 'stale', 'blocked'). */
  reason: string
}

const CLASSES = ['ACK', 'AGREEMENT', 'ENCOURAGEMENT', 'THINKING', 'FILLER']

const int = (v: unknown): number | null => {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : NaN
  return Number.isNaN(n) ? null : Math.max(0, n)
}

/**
 * Normaliza/valida uma linha do log (schema do `VoiceEvalEvent`): lixo → null; campos numéricos
 * são arredondados ≥ 0, `tail` truncado e classes fora da whitelist viram null. Testado em
 * `e2e/voiceCallEval.test.ts`.
 */
export function normalizeEvalEvent(v: unknown): VoiceEvalEvent | null {
  if (!v || typeof v !== 'object') return null
  const e = v as Record<string, unknown>
  const kind = e.kind === 'filler' ? 'filler' : e.kind === 'interjection' ? 'interjection' : null
  const cls = typeof e.class === 'string' && CLASSES.includes(e.class) ? e.class : null
  const variant = int(e.variant)
  const ts = int(e.ts)
  if (!kind || !cls || variant == null || variant < 1 || variant > 3 || ts == null) return null
  const tail = typeof e.tail === 'string' && e.tail ? e.tail.slice(0, EVAL_TAIL_MAX_CHARS) : null
  return {
    ts,
    kind,
    class: cls,
    variant,
    played: e.played === true,
    shadow: e.shadow === true,
    speechMs: int(e.speechMs),
    pauseMs: int(e.pauseMs),
    tail,
    latencyMs: int(e.latencyMs) ?? 0,
    reason: typeof e.reason === 'string' && e.reason ? e.reason.slice(0, 64) : ''
  }
}

/** Caminho do log do dia (`<baseDir>/voice-eval/<YYYY-MM-DD>.jsonl`, UTC). */
export function evalLogFile(baseDir: string, at: Date = new Date()): string {
  const day = Number.isNaN(at.getTime()) ? new Date() : at
  return join(baseDir, 'voice-eval', `${day.toISOString().slice(0, 10)}.jsonl`)
}

export interface EvalLogger {
  /** Registra uma decisão (serializado; falha de disco é engolida — nunca derruba a chamada). */
  log(event: VoiceEvalEvent): void
  /** Caminho do arquivo de uma data (padrão: hoje) — UI/testes. */
  file(at?: Date): string
}

/**
 * Logger do log de avaliação (escritas append serializadas; o arquivo do dia é criado sob
 * demanda). `onError` (opcional) recebe falhas de escrita para log local.
 */
export function createEvalLogger(baseDir: string, onError?: (e: unknown) => void): EvalLogger {
  let chain: Promise<void> = Promise.resolve()
  return {
    log(event) {
      const normalized = normalizeEvalEvent(event)
      if (!normalized) return
      const line = `${JSON.stringify(normalized)}\n`
      const file = evalLogFile(baseDir, new Date(normalized.ts))
      chain = chain.then(async () => {
        try {
          await mkdir(join(baseDir, 'voice-eval'), { recursive: true })
          await appendFile(file, line, 'utf8')
        } catch (e) {
          onError?.(e)
        }
      })
    },
    file(at) {
      return evalLogFile(baseDir, at)
    }
  }
}
