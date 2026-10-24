// Falhas das APIs de voz durante a chamada (main, sem Electron — testável). Toda falha de STT/TTS
// da chamada é classificada: FATAL (chave inválida, créditos/cota esgotados, modelo/voz
// inexistente, configuração/motor local ausente) encerra a chamada na hora com um motivo legível;
// TRANSITÓRIA (rede, tempo esgotado, 5xx, 429 sem menção a cota, WebSocket caiu) é repetida UMA
// vez por quem chamou — falhou de novo, encerra. Ver SPEC → "Chamada de voz → Falhas das APIs".
import { SttError } from './stt'
import { TtsError } from './tts'

export type VoiceFailureSource = 'stt' | 'tts'

export interface VoiceFailure {
  /** true = encerra a chamada já; false = vale UMA nova tentativa. */
  fatal: boolean
  /** Motivo curto e legível (pt-BR) — vai para "Chamada encerrada: <motivo>". */
  reason: string
  /** Mensagem original (log/timeline). */
  detail: string
}

/** Texto que indica créditos/cota esgotados (não um limite de taxa passageiro). */
const QUOTA_TEXT =
  /quota|credit|cr[eé]dito|insufficient|exceed|balance|saldo|billing|payment|plan limit|limite (do plano|mensal)|character limit/i

const what = (source: VoiceFailureSource): string => (source === 'stt' ? 'transcrição' : 'voz')

/** "do OpenRouter" / "da ElevenLabs" (marcas femininas na fala do usuário). */
const of = (label: string): string => (/^elevenlabs$/i.test(label) ? `da ${label}` : `do ${label}`)

const isAbort = (e: unknown): boolean =>
  !!e && typeof e === 'object' && (e as { name?: string }).name === 'AbortError'

/**
 * Classifica uma falha de STT/TTS da chamada (`label` = nome do provedor — "OpenRouter",
 * "ElevenLabs", "motor local"…). null = cancelamento (não é falha).
 */
export function classifyVoiceError(
  e: unknown,
  source: VoiceFailureSource,
  label: string
): VoiceFailure | null {
  if (isAbort(e)) return null
  const detail = e instanceof Error ? e.message : String(e)
  const typed = e instanceof SttError || e instanceof TtsError ? e : null
  const kind = typed?.kind
  const status = typed?.status
  const local = typed?.backend === 'local'
  const who = local ? 'o motor local' : label
  if (kind === 'auth')
    return {
      fatal: true,
      reason: `chave ${of(label)} inválida ou sem permissão (${what(source)})`,
      detail
    }
  if (kind === 'quota' || status === 402) {
    if (status === 402 || QUOTA_TEXT.test(detail))
      return { fatal: true, reason: `créditos ${of(label)} esgotados (${what(source)})`, detail }
    return { fatal: false, reason: `limite de requisições ${of(label)} (${what(source)})`, detail }
  }
  // formato de saída fora do plano (ElevenLabs 403 `output_format_not_allowed`): a mensagem já diz
  // o que fazer ("…escolha outro formato em Configurações → Áudio → Parâmetros")
  if (kind === 'config' && /formato de saída/i.test(detail))
    return { fatal: true, reason: detail.replace(/^TtsError: /, ''), detail }
  if (kind === 'config')
    return {
      fatal: true,
      reason: local
        ? `${what(source)} local indisponível — ${detail}`
        : `${what(source)} não configurada — ${detail}`,
      detail
    }
  if (kind === 'http' && status != null) {
    if (status >= 500)
      return { fatal: false, reason: `falha ${of(who)} (${what(source)}, HTTP ${status})`, detail }
    if (status === 400 || status === 404 || status === 422)
      return {
        fatal: true,
        reason:
          source === 'tts'
            ? `modelo ou voz indisponível ${of(label).replace(/^d/, 'n')}`
            : `modelo de transcrição indisponível ${of(label).replace(/^d/, 'n')}`,
        detail
      }
    return { fatal: true, reason: `${what(source)} recusada (${label}, HTTP ${status})`, detail }
  }
  if (kind === 'network' || kind === 'timeout')
    return { fatal: false, reason: `falha de conexão com a ${what(source)} (${who})`, detail }
  // mensagens de cota/créditos em erros sem tipo (ex.: frame de erro do WebSocket)
  if (QUOTA_TEXT.test(detail))
    return { fatal: true, reason: `créditos ${of(label)} esgotados (${what(source)})`, detail }
  if (/inv[aá]lid.*(key|chave)|unauthori[sz]ed|api key/i.test(detail))
    return { fatal: true, reason: `chave ${of(label)} inválida (${what(source)})`, detail }
  // resto (2xx sem áudio, motor local que caiu, erro desconhecido): uma nova tentativa
  return {
    fatal: false,
    reason: `falha na ${what(source)} (${who}): ${detail.slice(0, 120)}`,
    detail
  }
}

/** A falha merece UMA nova tentativa imediata (STT/TTS)? */
export function isTransientVoiceError(e: unknown, source: VoiceFailureSource): boolean {
  const c = classifyVoiceError(e, source, '')
  return !!c && !c.fatal
}

/** Nome do provedor pelo endpoint (motivos legíveis): OpenRouter, Groq, ElevenLabs, OpenAI… */
export function voiceProviderLabel(baseUrl: string | null | undefined, local = false): string {
  if (local) return 'motor local'
  const host = (() => {
    try {
      return new URL(String(baseUrl ?? '')).hostname
    } catch {
      return ''
    }
  })()
  if (/openrouter\.ai$/i.test(host)) return 'OpenRouter'
  if (/groq\.com$/i.test(host)) return 'Groq'
  if (/elevenlabs\.io$/i.test(host)) return 'ElevenLabs'
  if (/openai\.com$/i.test(host)) return 'OpenAI'
  return host || 'provedor de voz'
}
