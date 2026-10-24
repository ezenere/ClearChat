// Linhas do editor "Parâmetros" dos modelos remotos (lógica PURA — testada em
// `e2e/voiceModelOptions.test.ts`): valor mostrado, "da voz (conta)" quando o padrão é não enviar,
// padrão legível e o rascunho com um parâmetro trocado. Specs em `@shared/voiceParams`.
import type { VoiceCapability, VoiceProviderSupport } from '@shared/voiceCatalog'
import {
  normalizeVoiceParamValues,
  type VoiceParamSpec,
  type VoiceParamValue,
  type VoiceParamValues
} from '@shared/voiceParams'

export interface ApiParamRow {
  spec: VoiceParamSpec
  value: VoiceParamValue
  changed: boolean
  display: string
  defaultDisplay: string
  unset: boolean
  hint?: string
}

/** Valor legível (pt-BR; velocidade com "×"). */
export function formatApiParam(spec: VoiceParamSpec, v: VoiceParamValue): string {
  if (spec.kind === 'boolean') return v ? 'ligado' : 'desligado'
  if (spec.kind === 'select') return spec.options?.find((o) => o.value === v)?.label ?? String(v)
  if (spec.kind === 'text') return String(v)
  const n = typeof v === 'number' ? v : Number(v)
  const t = n.toFixed(spec.decimals ?? 2).replace('.', ',')
  return spec.key === 'speed' ? `${t}×` : t
}

/** Linhas do editor para as specs do modelo e os valores salvos da família. */
export function apiParamRows(specs: VoiceParamSpec[], values: VoiceParamValues): ApiParamRow[] {
  return specs.map((spec) => {
    const saved = values[spec.key]
    const unset = saved === undefined && spec.default === null
    const fallback = spec.default ?? spec.neutral ?? (spec.kind === 'text' ? '' : 0)
    let value: VoiceParamValue = saved ?? fallback
    // faixa do modelo (ex.: speed 0,7–1,2) — o salvo de outra faixa aparece no limite
    if (spec.kind === 'number' && typeof value === 'number')
      value = Math.max(spec.min ?? -Infinity, Math.min(spec.max ?? Infinity, value))
    const unsetLabel = spec.unsetLabel ?? 'não enviar'
    return {
      spec,
      value,
      unset,
      changed: saved !== undefined && saved !== spec.default,
      display: unset ? unsetLabel : formatApiParam(spec, value),
      defaultDisplay: spec.default === null ? unsetLabel : formatApiParam(spec, spec.default),
      // não definido: o padrão documentado da API ao lado (o controle mostra esse valor)
      ...(unset && spec.neutral !== undefined && spec.kind !== 'text'
        ? { hint: `API: ${formatApiParam(spec, spec.neutral)}` }
        : {})
    }
  })
}

/** Valores da família com `key` = `v` (null = volta ao padrão — a chave sai). */
export function setApiParamValue(
  cap: VoiceCapability,
  family: VoiceProviderSupport,
  values: VoiceParamValues,
  key: string,
  v: VoiceParamValue | null
): VoiceParamValues {
  const next: Record<string, unknown> = { ...values }
  if (v === null) delete next[key]
  else next[key] = v
  return normalizeVoiceParamValues(cap, family, next)
}
