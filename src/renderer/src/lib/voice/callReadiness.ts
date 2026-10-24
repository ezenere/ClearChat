// Pré-checagem da chamada de voz (função PURA — testada em `e2e/voiceCall.test.ts`): antes de
// entrar na chamada, confere nas settings de voz (as do `voice:settings:get`) e nos provedores
// cadastrados se a transcrição e a fala têm o mínimo para funcionar. Sem isso a chamada "entrava" e
// falhava em silêncio no primeiro turno (sem provedor de STT, Kokoro não instalado…). Endereço e
// chave são do provedor (Configurações → Provedores): aqui basta um provedor escolhido que existe. Com o probe de runtime
// do main (`voice.runtime.status()` — whisper/onnxruntime/espeak-ng carregáveis de verdade) os
// motores locais também são conferidos; sem ele, o que só o main sabe chega como erro legível do
// `voice:call:start`/TTS. Backend/modo "Local (GPU)" (Modo avançado): com o status da GPU
// (`voice.gpu.status()`) confere runtime, motor (instalado/bloqueado/com problema), voz e o servidor
// local — cada problema aponta para Configurações → Áudio → Modo avançado (GPU local).
import type { VoiceRuntimeStatus } from '@shared/ipc'
import type { SttSettings, TtsSettings } from '@shared/voice'
import { providerSupportsVoice, type VoiceCapability } from '@shared/voiceCatalog'
import { gpuSttProblems, gpuTtsProblems } from './gpu/gpuUi'
import type { GpuStatus, SttSettingsGpu, TtsSettingsGpu } from './gpu/types'

/** Provedor cadastrado como a pré-checagem o vê (sem chave). */
export interface ReadinessProvider {
  id: string
  baseUrl: string
  kind?: string
}

/**
 * Problema do backend de API (provedor + modelo). `providers` ausente = não confere a existência
 * do provedor (o main recusa com erro legível se ele sumiu).
 */
function apiProblem(
  api: { providerId: string | null; model: string },
  capability: VoiceCapability,
  providers: readonly ReadinessProvider[] | null | undefined
): string | null {
  const what = capability === 'stt' ? 'transcrição' : 'fala'
  const usable = providers?.filter((p) => providerSupportsVoice(p, capability))
  if (!api.providerId)
    return usable && !usable.length
      ? `cadastre um provedor que sirva ${what} em Configurações → Provedores e escolha-o em Configurações → Áudio`
      : 'escolha um provedor em Configurações → Áudio'
  if (providers && !providers.some((p) => p.id === api.providerId))
    return 'o provedor escolhido não existe mais — escolha outro em Configurações → Áudio'
  if (!api.model.trim()) return `escolha o modelo de ${what} em Configurações → Áudio`
  return null
}

/**
 * Problemas que impedem a chamada (lista vazia = pronta), já em pt-BR para o usuário, apontando
 * onde resolver (Configurações → Áudio).
 */
export function voiceCallReadiness(
  view: {
    sttSettings: SttSettings
    ttsSettings: TtsSettings
  },
  runtime?: VoiceRuntimeStatus | null,
  /** Status do modo GPU (só consultado com backend/modo 'gpu'); null = sem backend da GPU. */
  gpu?: GpuStatus | null,
  /** Provedores cadastrados (Configurações → Provedores); ausente = não confere a existência. */
  providers?: readonly ReadinessProvider[] | null
): string[] {
  const out: string[] = []
  const { sttSettings: stt, ttsSettings: tts } = view
  const gstt = stt as SttSettingsGpu
  const gtts = tts as TtsSettingsGpu
  // só os problemas que impedem (avisos de compat e "o servidor sobe sozinho" não barram a chamada)
  const gpuErrors = (list: { level: string; text: string }[]): string[] =>
    list.filter((p) => p.level === 'error').map((p) => p.text)
  // motor local de STT "pronto" = modelo instalado E runtime carregável (quando o probe existe)
  const localStt = !!stt.local?.installed && (runtime ? runtime.sttLocal.available : true)
  if (gstt.mode === 'gpu') {
    // sem o status detalhado, o probe do main (`runtime.gpuStt`) basta
    if (!gpu && runtime?.gpuStt) {
      if (!runtime.gpuStt.available)
        out.push(`Transcrição (GPU local): ${runtime.gpuStt.reason ?? 'não está pronta'}.`)
    } else
      for (const p of gpuErrors(gpuSttProblems(gstt, gpu ?? null)))
        out.push(`Transcrição (GPU local): ${p}.`)
  } else if (stt.mode === 'api') {
    const p = apiProblem(stt.api, 'stt', providers)
    if (p) out.push(`Transcrição: ${p}.`)
  } else if (stt.mode === 'local') {
    if (stt.local?.installed && runtime && !runtime.sttLocal.available)
      out.push(
        `Transcrição: o motor local não está pronto — ${runtime.sttLocal.reason ?? 'runtime indisponível'}.`
      )
    else if (!localStt)
      out.push(
        'Transcrição: instale um modelo do motor local (Configurações → Áudio → Transcrição → Motor local).'
      )
  } else if (!localStt) {
    const p = apiProblem(stt.api, 'stt', providers)
    if (p) out.push(`Transcrição (híbrido): ${p} — ou instale um modelo local.`)
  }
  if (gtts.backend === 'gpu') {
    if (!gpu && runtime?.gpuTts) {
      if (!runtime.gpuTts.available)
        out.push(`Fala (GPU local): ${runtime.gpuTts.reason ?? 'não está pronta'}.`)
    } else
      for (const p of gpuErrors(gpuTtsProblems(gtts, gpu ?? null)))
        out.push(`Fala (GPU local): ${p}.`)
  } else if (tts.backend === 'local') {
    if (!tts.local || tts.local.engine !== 'kokoro')
      out.push(
        'Fala: escolha o motor local Kokoro ou o backend de API (Configurações → Áudio → Fala).'
      )
    else if (!tts.local.installed)
      out.push('Fala: baixe o modelo Kokoro e uma voz (Configurações → Áudio → Fala).')
    else if (runtime && !runtime.ttsLocal.available)
      // ex.: espeak-ng ausente no sistema (fonemização pt-BR do Kokoro)
      out.push(
        `Fala: o motor local não está pronto — ${runtime.ttsLocal.reason ?? 'runtime indisponível'}.`
      )
  } else {
    const p = apiProblem(tts.api, 'tts', providers)
    if (p) out.push(`Fala: ${p}.`)
  }
  return out
}
