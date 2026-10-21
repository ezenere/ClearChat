// Padrões globais do Smart-Approve/aprovações (setting LOCAL `smartApproveDefaults` — não
// sincroniza; ver SPEC) e limites da coleta automática de contexto. Sem dependências (approvalPolicy
// e contextCapture importam daqui).
import type { ContextCaptureConfig, SmartApproveDefaults } from './types'

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
  return {
    enabled: c.enabled === true,
    providerId: str(c.providerId),
    model: str(c.model),
    maxTokens:
      typeof c.maxTokens === 'number' && Number.isFinite(c.maxTokens)
        ? clampInt(c.maxTokens, L.minMaxTokens, L.maxMaxTokens, L.defaultMaxTokens)
        : null,
    lookback: clampInt(c.lookback, 1, L.maxLookback, L.defaultLookback)
  }
}

/** Padrões globais (setting local `smartApproveDefaults`). Aceitar edições: desligado. */
export function normalizeSmartDefaults(v: unknown): SmartApproveDefaults {
  const d = (v && typeof v === 'object' ? v : {}) as Partial<SmartApproveDefaults>
  return {
    environment: typeof d.environment === 'string' ? d.environment : '',
    acceptEditsInRoot: d.acceptEditsInRoot === true,
    capture: normalizeCapture(d.capture)
  }
}
