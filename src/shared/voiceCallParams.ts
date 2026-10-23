// Raciocínio nos turnos da chamada de voz (função pura — `applyVoiceCallChat` em `@shared/voice`).
// Na conversa falada o raciocínio só atrasa a 1ª frase e, com `max_tokens` nos params, pode comer a
// resposta inteira (caso real: `anthropic/claude-haiku-5.5` pensa por padrão — 108 dos 120 tokens
// foram raciocínio e a fala parou em "Eu sou a Diana, sua"). Política: a das chamadas laterais
// (`sideReasoning` — onde dá para desligar, desliga; obrigatório → esforço mínimo; sem informação →
// nada), salvo quando os params do MODELO DA CHAMADA definem `reasoning_effort` (escolha explícita).
// Não importa `@shared/voice` (sem ciclo).
import { anthropicThinkingRule, safeExtraBody } from './modelParams'
import type { ProviderKind } from './providerKinds'
import { sideReasoning, type SideReasoning } from './sideReasoning'
import type { ChatParams, ModelInfo } from './types'

/** O que o runner sabe do provedor/modelo do turno (tipo e item do /models em cache). */
export interface VoiceReasoningRules {
  kind: ProviderKind
  info?: ModelInfo
}

export interface VoiceReasoningPlan {
  params: ChatParams
  reasoning: SideReasoning | null
  /** Notas curtas (pt-BR) — o que foi mudado e por quê. */
  notes: string[]
}

/**
 * Política de raciocínio para o modelo do turno de voz: `sideReasoning` e, no OpenRouter sem
 * metadados do /models (lista ainda não carregada), a tabela da Anthropic para ids `anthropic/…`
 * (`claude-haiku-5.5` pensa por padrão e aceita desligar → `effort: "none"`).
 */
export function voiceReasoning(kind: ProviderKind, model: string, info?: ModelInfo): SideReasoning {
  const r = sideReasoning({ kind, model, info })
  if (r.mode !== 'unknown' || kind !== 'openrouter' || info) return r
  const m = /^anthropic\/(.+)$/i.exec(model.trim())
  if (!m) return r
  const rule = anthropicThinkingRule(m[1].replace(/\./g, '-'))
  if (!rule) return r
  if (rule.off === null)
    return {
      mode: 'minimal',
      mandatory: !rule.inferred,
      effort: 'low',
      note: `${model} sempre raciocina: effort "low" (mínimo).`
    }
  if (rule.off === 'disabled')
    return {
      mode: 'off',
      effort: 'none',
      explicitOff: true,
      note: `Raciocínio desligado: effort "none" (${model} pensa por padrão).`
    }
  return { mode: 'off', note: '' }
}

/**
 * Params do turno de voz com o raciocínio decidido: `explicit` (os params da chamada definem
 * `reasoning_effort`) → intocados; senão a política (`voiceReasoning`): `reasoning_effort` vira o
 * da política (ou sai — o do chat de texto não vale na chamada) e, na Anthropic nativa, o
 * `thinking` de desligar entra no `extraBody` (salvo se o `extraBody` já define `thinking`).
 * `max_tokens` nunca é imposto aqui (só vale o dos params, como qualquer parâmetro do modelo).
 */
export function planVoiceReasoning(input: {
  params: ChatParams
  explicit: boolean
  kind: ProviderKind
  model: string
  info?: ModelInfo
}): VoiceReasoningPlan {
  const params: ChatParams = { ...input.params }
  if (input.explicit) return { params, reasoning: null, notes: [] }
  const r = voiceReasoning(input.kind, input.model, input.info)
  const notes: string[] = []
  if (r.mode === 'unknown') {
    // sem informação: nada é enviado (um endpoint desconhecido poderia recusar o campo); o
    // reasoning_effort do chat de texto, se houver, segue (o usuário sabe que o modelo aceita)
    return { params, reasoning: r, notes }
  }
  if (r.effort) params.reasoning_effort = r.effort
  else delete params.reasoning_effort
  if (r.thinking) {
    const extra = safeExtraBody(params.extraBody) ?? {}
    if (!('thinking' in extra))
      params.extraBody = JSON.stringify({ ...extra, thinking: r.thinking })
  }
  if (r.note) notes.push(r.note)
  return { params, reasoning: r, notes }
}
