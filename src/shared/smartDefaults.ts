// Padrões globais do Smart-Approve/aprovações (setting `smartApproveDefaults` — sincroniza desde o
// protocolo 1.4.0; ver SPEC → Sync) e limites da coleta automática de contexto. Sem dependências
// (approvalPolicy e contextCapture importam daqui).
import { normalizeThinkingTokens } from './sideReasoning'
import type { CapturePrompts, ContextCaptureConfig, SmartApproveDefaults } from './types'

export const SMART_DEFAULTS_SETTING = 'smartApproveDefaults'

export const CONTEXT_CAPTURE_LIMITS = {
  /** Tamanho máximo da descrição capturada. */
  maxChars: 1200,
  /** Texto do agente (contexto) no total / por mensagem. */
  agentChars: 1500,
  agentPerMessage: 900,
  /** Mensagens novas do usuário no total / por mensagem / quantidade. */
  userChars: 3000,
  userPerMessage: 1500,
  maxUserMessages: 8,
  /** Falas do agente antes da sua (padrão / máximo). */
  defaultLookback: 2,
  maxLookback: 10,
  /** max_tokens da chamada (padrão / limites). */
  defaultMaxTokens: 400,
  minMaxTokens: 64,
  maxMaxTokens: 4000,
  /** Espera antes de resumir (agrupa mensagens seguidas). */
  debounceMs: 1500,
  /** O juiz espera o resumo em andamento no máximo isso (depois julga com o que houver). */
  judgeWaitMs: 20_000,
  /** Tempo máximo da chamada ao resumidor. */
  timeoutMs: 60_000,
  /** Descrições de subagentes guardadas por chat (as mais antigas saem). */
  maxSessions: 30,
  /** Tarefa do subagente na derivação sem modelo. */
  taskChars: 400,
  /** Trava: trecho mínimo (normalizado) copiado do texto do agente para descartar a linha. */
  copyRun: 24
} as const

export const DEFAULT_CAPTURE: ContextCaptureConfig = {
  enabled: false,
  providerId: null,
  model: null,
  maxTokens: null,
  lookback: CONTEXT_CAPTURE_LIMITS.defaultLookback
}

const clampInt = (v: unknown, min: number, max: number, def: number): number => {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : def
  return Math.min(max, Math.max(min, n))
}
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)

export function normalizeCapture(v: unknown): ContextCaptureConfig {
  const c = (v && typeof v === 'object' ? v : {}) as Partial<ContextCaptureConfig>
  const L = CONTEXT_CAPTURE_LIMITS
  const thinkingTokens = normalizeThinkingTokens(c.thinkingTokens)
  return {
    enabled: c.enabled === true,
    providerId: str(c.providerId),
    model: str(c.model),
    maxTokens:
      typeof c.maxTokens === 'number' && Number.isFinite(c.maxTokens)
        ? clampInt(c.maxTokens, L.minMaxTokens, L.maxMaxTokens, L.defaultMaxTokens)
        : null,
    lookback: clampInt(c.lookback, 1, L.maxLookback, L.defaultLookback),
    // 0.8.8: só com valor (ausente/null = o padrão SIDE_THINKING.capture)
    ...(thinkingTokens != null ? { thinkingTokens } : {}),
    // 0.8.8: cache do prompt do resumidor; ausente = ligado (só o desligado é gravado)
    ...(c.cache === false ? { cache: false } : {})
  }
}

/** Prompts do resumidor: todos os padrões (null). */
export const DEFAULT_CAPTURE_PROMPTS: CapturePrompts = {
  prompt: null,
  template: null,
  derivePrompt: null
}

/** Texto personalizado ou null (vazio/só espaços = o padrão). */
const promptOrNull = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() ? v.replace(/\r/g, '') : null

export function normalizeCapturePrompts(v: unknown): CapturePrompts {
  const p = (v && typeof v === 'object' ? v : {}) as Partial<CapturePrompts>
  return {
    prompt: promptOrNull(p.prompt),
    template: promptOrNull(p.template),
    derivePrompt: promptOrNull(p.derivePrompt)
  }
}

/** Padrões globais (setting `smartApproveDefaults`). Aceitar edições: desligado. */
export function normalizeSmartDefaults(v: unknown): SmartApproveDefaults {
  const d = (v && typeof v === 'object' ? v : {}) as Partial<SmartApproveDefaults>
  return {
    environment: typeof d.environment === 'string' ? d.environment : '',
    acceptEditsInRoot: d.acceptEditsInRoot === true,
    capture: normalizeCapture(d.capture),
    capturePrompts: normalizeCapturePrompts(d.capturePrompts)
  }
}
