// Pré-checagem da chamada de voz (função PURA — testada em `e2e/voiceCall.test.ts`): antes de
// entrar na chamada, confere nas settings de voz (as do `voice:settings:get`, chaves mascaradas)
// se a transcrição e a fala têm o mínimo para funcionar. Sem isso a chamada "entrava" e falhava
// em silêncio no primeiro turno (sem chave de STT, Kokoro não instalado…). Com o probe de runtime
// do main (`voice.runtime.status()` — whisper/onnxruntime/espeak-ng carregáveis de verdade) os
// motores locais também são conferidos; sem ele, o que só o main sabe chega como erro legível do
// `voice:call:start`/TTS.
import type { VoiceRuntimeStatus } from '@shared/ipc'
import type { SttSettings, TtsSettings } from '@shared/voice'

/** Endpoint local (não exige chave — ex.: servidor whisper/TTS no próprio computador). */
function isLocalUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]'
  } catch {
    return false
  }
}

function sttApiProblem(stt: SttSettings): string | null {
  if (!stt.api.baseUrl.trim() || !stt.api.model.trim())
    return 'configure o endpoint e o modelo de transcrição'
  if (!stt.api.apiKey && !stt.api.providerId && !isLocalUrl(stt.api.baseUrl))
    return 'configure a chave de API da transcrição'
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
  runtime?: VoiceRuntimeStatus | null
): string[] {
  const out: string[] = []
  const { sttSettings: stt, ttsSettings: tts } = view
  // motor local de STT "pronto" = modelo instalado E runtime carregável (quando o probe existe)
  const localStt = !!stt.local?.installed && (runtime ? runtime.sttLocal.available : true)
  if (stt.mode === 'api') {
    const p = sttApiProblem(stt)
    if (p) out.push(`Transcrição: ${p} (Configurações → Áudio → Transcrição).`)
  } else if (stt.mode === 'local') {
    if (stt.local?.installed && runtime && !runtime.sttLocal.available)
      out.push(
        `Transcrição: o motor local não está pronto — ${runtime.sttLocal.reason ?? 'runtime indisponível'}.`
      )
    else if (!localStt)
      out.push(
        'Transcrição: instale um modelo do motor local (Configurações → Áudio → Transcrição → Motor local).'
      )
  } else if (!localStt && sttApiProblem(stt)) {
    out.push(
      `Transcrição (híbrido): ${sttApiProblem(stt)} ou instale um modelo local (Configurações → Áudio).`
    )
  }
  if (tts.backend === 'local') {
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
    if (!tts.api.baseUrl.trim() || !tts.api.model.trim())
      out.push('Fala: configure o endpoint e o modelo de síntese (Configurações → Áudio → Fala).')
    else if (!tts.api.apiKey && !tts.api.providerId && !isLocalUrl(tts.api.baseUrl))
      out.push('Fala: configure a chave de API da síntese (Configurações → Áudio → Fala).')
  }
  return out
}
