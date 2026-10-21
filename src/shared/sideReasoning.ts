// Raciocínio nas chamadas "laterais" (fora do histórico): juiz do Smart-Approve, resumidor da coleta
// de contexto e título automático. Função pura (main monta a request; o renderer mostra a nota
// "thinking obrigatório" + o campo "Tokens de pensamento" e o body exato no (i)).
// Ver SPEC.md → "Parâmetros por modelo → Chamadas laterais".
//
// Política: onde dá para desligar o raciocínio, desliga ('off'); onde ele é obrigatório, esforço
// mínimo + "tokens de pensamento" somados ao max_tokens ('minimal' — o raciocínio conta no
// max_tokens, e com 300 o juiz podia gastar tudo pensando e responder vazio); sem informação,
// nada é enviado ('unknown' — um endpoint desconhecido poderia recusar o campo).
import {
  anthropicThinkingRule,
  paramSupport,
  type ParamRulesInput,
  type ParamSupport
} from './modelParams'
import type { SideWireMessage } from './sideCache'
import type { ChatParams, ReasoningEffort } from './types'

export type SideReasoningMode = 'off' | 'minimal' | 'unknown'

export interface SideReasoning {
  mode: SideReasoningMode
  /** Anthropic nativa: `thinking` enviado para desligar ("disabled" ou "between_tools"). */
  thinking?: { type: 'disabled' | 'between_tools' }
  /** reasoning_effort enviado (formato do provedor: effortWire). */
  effort?: ReasoningEffort
  /** minimal: false = presumido (modelo fora da tabela), não confirmado pela API/tabela. */
  mandatory?: boolean
  /** Algo foi enviado para desligar (thinking ou effort "none") — a UI mostra "raciocínio desligado". */
  explicitOff?: boolean
  /** Explicação curta (pt-BR) para as notas do "Ver request" (vazia = nada a dizer). */
  note: string
}

/**
 * "Tokens de pensamento" padrão (somados ao max_tokens só no modo 'minimal'). Com esforço mínimo,
 * uma classificação curta pensa poucas centenas de tokens; o padrão dá folga para o veredito
 * (juiz: 300) / o resumo (400) / o título (64) não serem cortados:
 * - juiz 2048 e resumidor 2048 (entradas de alguns milhares de chars, decisão com regras);
 * - título 1024 (tarefa trivial; a chamada é a cada chat novo).
 */
export const SIDE_THINKING = {
  judge: 2048,
  capture: 2048,
  title: 1024,
  min: 256,
  max: 32000
} as const

/** Valor salvo → número aceito (faixa SIDE_THINKING.min–max) ou null (= o padrão). */
export function normalizeThinkingTokens(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null
  return Math.min(SIDE_THINKING.max, Math.max(SIDE_THINKING.min, Math.round(v)))
}

const firstNonNone = (levels: ReasoningEffort[]): ReasoningEffort | undefined =>
  levels.find((e) => e !== 'none')

/**
 * Política de raciocínio da chamada lateral para o modelo (ver o topo do arquivo):
 * - Anthropic nativa: anthropicThinkingRule (tabela por família/versão) + effort mais baixo aceito
 *   (capabilities.effort / tabela; nunca xhigh/max — "disabled"/"between_tools" exigem ≤ high).
 * - OpenRouter / openai: metadados do /models (`reasoning.mandatory`, `supported_efforts`,
 *   `default_enabled`) ou a tabela conferida de modelos OpenAI: `none` aceito → `effort: "none"`;
 *   obrigatório (ou sem `none`) → o nível mais baixo; sem raciocínio → nada; níveis desconhecidos →
 *   nada (`default_enabled: false` = já desligado).
 */
export function sideReasoning(input: Omit<ParamRulesInput, 'extra'>): SideReasoning {
  const label = input.model || 'este modelo'
  const spec = paramSupport({ ...input, extra: null, params: {} }).effort
  if (input.kind === 'anthropic') {
    const rule = anthropicThinkingRule(input.model)
    if (!rule)
      return {
        mode: 'unknown',
        note: `${label} não é um id Claude conhecido: nenhum campo de raciocínio enviado.`
      }
    const effort = spec?.known ? firstNonNone(spec.levels) : undefined
    const eff = effort ? ` + effort "${effort}"` : ''
    if (rule.off === null)
      return {
        mode: 'minimal',
        mandatory: !rule.inferred,
        ...(effort ? { effort } : {}),
        note: rule.inferred
          ? `${label} está fora da tabela: o raciocínio pode estar ligado e não se sabe se dá para desligar — thinking omitido${eff} (mínimo).`
          : `${label} sempre raciocina (thinking não pode ser desligado): thinking omitido${eff} (mínimo).`
      }
    if (rule.off === 'omit')
      return {
        mode: 'off',
        ...(effort ? { effort } : {}),
        note: effort
          ? `Raciocínio desligado: ${label} não pensa sem o campo thinking (omitido); effort "${effort}".`
          : ''
      }
    return {
      mode: 'off',
      thinking: { type: rule.off },
      ...(effort ? { effort } : {}),
      explicitOff: true,
      note:
        rule.off === 'between_tools'
          ? `Raciocínio desligado: thinking {type: "between_tools"} (${label} não aceita "disabled"; sem tools, não pensa)${eff}.`
          : `Raciocínio desligado: thinking {type: "disabled"} (${label} pensa por padrão)${eff}.`
    }
  }
  if (!spec) return { mode: 'off', note: '' }
  if (spec.mandatory) {
    const effort = spec.known ? firstNonNone(spec.levels) : undefined
    return {
      mode: 'minimal',
      mandatory: true,
      ...(effort ? { effort } : {}),
      note: `${label} sempre raciocina (reasoning obrigatório): ${effort ? `effort "${effort}"` : 'níveis não informados, nenhum effort enviado'} (mínimo).`
    }
  }
  if (!spec.known)
    return input.info?.reasoning?.defaultEnabled === false
      ? { mode: 'off', note: '' }
      : {
          mode: 'unknown',
          note: ''
        }
  if (spec.levels.includes('none'))
    return {
      mode: 'off',
      effort: 'none',
      explicitOff: true,
      note: 'Raciocínio desligado: effort "none".'
    }
  const effort = firstNonNone(spec.levels)
  return {
    mode: 'minimal',
    mandatory: true,
    ...(effort ? { effort } : {}),
    note: `${label} não aceita desligar o raciocínio (níveis: ${spec.levels.join(', ')}): effort "${effort}" (mínimo).`
  }
}

export interface SidePlanInput extends Omit<ParamRulesInput, 'extra'> {
  /** max_tokens da chamada (sem os tokens de pensamento). */
  maxTokens: number
  /** Temperatura fixa (juiz/resumidor: 0); omitida quando o raciocínio é obrigatório. */
  temperature?: number
  /** "Tokens de pensamento" da config (null/ausente = `defaultThinkingTokens`). */
  thinkingTokens?: number | null
  defaultThinkingTokens: number
}

export interface SidePlan {
  reasoning: SideReasoning
  /** Params que vão (já filtrados pelo modelo: paramSupport). */
  send: ParamSupport['send']
  /** Tokens de pensamento somados ao max_tokens (0 fora do modo 'minimal'). */
  thinkingTokens: number
  /** Notas para o "Ver request" (omissões + raciocínio). */
  notes: string[]
}

/** O que vai na chamada lateral: max_tokens (+ pensamento), temperatura, effort e `thinking`. */
export function planSideCall(input: SidePlanInput): SidePlan {
  const reasoning = sideReasoning(input)
  const minimal = reasoning.mode === 'minimal'
  const thinkingTokens = minimal
    ? (normalizeThinkingTokens(input.thinkingTokens) ?? input.defaultThinkingTokens)
    : 0
  const params: ChatParams = { max_tokens: input.maxTokens + thinkingTokens }
  // raciocínio ligado: a Anthropic só aceita temperature 1 (e os de raciocínio da OpenAI nenhuma)
  if (input.temperature !== undefined && !minimal) params.temperature = input.temperature
  if (reasoning.effort) params.reasoning_effort = reasoning.effort
  const support = paramSupport({ ...input, extra: null, params })
  const notes = [...support.notes]
  if (input.temperature !== undefined && minimal)
    notes.push(
      `temperature omitido: com raciocínio obrigatório vale só o padrão do modelo (pedido: ${input.temperature}).`
    )
  if (reasoning.note) notes.push(reasoning.note)
  if (minimal && support.send.max_tokens != null)
    notes.push(
      `max_tokens = ${input.maxTokens} + ${thinkingTokens} tokens de pensamento = ${support.send.max_tokens}.`
    )
  return { reasoning, send: support.send, thinkingTokens, notes }
}

/**
 * Body OpenAI-compatible (openai/OpenRouter) da chamada lateral: system + user, os params do plano,
 * effort no formato do provedor (OpenRouter `reasoning: {effort}`; openai `reasoning_effort`),
 * streaming com usage.
 */
export function sideChatBody(
  kind: ParamRulesInput['kind'],
  model: string,
  messages: SideWireMessage[],
  send: ParamSupport['send']
): Record<string, unknown> {
  const body: Record<string, unknown> = { model, messages }
  if (send.temperature != null) body.temperature = send.temperature
  if (send.max_tokens != null) body.max_tokens = send.max_tokens
  const e = send.reasoning_effort
  if (e) {
    if (kind === 'openrouter') body.reasoning = { effort: e }
    else body.reasoning_effort = e
  }
  body.stream = true
  body.stream_options = { include_usage: true }
  if (kind === 'openrouter') body.usage = { include: true }
  return body
}

/**
 * Body nativo da Anthropic para a chamada lateral, igual ao que o main monta com buildAnthropicBody
 * (system + 1 user de texto, com os `cache_control` de sideWireMessages; conferido em
 * e2e/sideReasoning.test.ts) — usado só no (i) do renderer.
 */
export function sideAnthropicPreviewBody(
  model: string,
  messages: SideWireMessage[],
  plan: Pick<SidePlan, 'send' | 'reasoning'>
): Record<string, unknown> {
  const { send } = plan
  const blocks = (c: SideWireMessage['content']): Record<string, unknown>[] =>
    typeof c === 'string'
      ? c
        ? [{ type: 'text', text: c }]
        : []
      : c.flatMap((p) =>
          p.type === 'text' && p.text
            ? [
                {
                  type: 'text',
                  text: p.text,
                  ...(p.cache_control ? { cache_control: p.cache_control } : {})
                }
              ]
            : []
        )
  const system = messages.filter((m) => m.role === 'system').flatMap((m) => blocks(m.content))
  const body: Record<string, unknown> = { model, max_tokens: send.max_tokens }
  if (system.length) body.system = system
  body.messages = messages
    .filter((m) => m.role === 'user')
    .map((m) => ({ role: 'user', content: blocks(m.content) }))
  if (send.temperature != null) body.temperature = send.temperature
  if (send.reasoning_effort)
    body.output_config = {
      effort: send.reasoning_effort === 'minimal' ? 'low' : send.reasoning_effort
    }
  body.stream = true
  if (plan.reasoning.thinking) body.thinking = plan.reasoning.thinking
  return body
}
