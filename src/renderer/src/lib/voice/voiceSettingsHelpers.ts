// Helpers (não-componentes) das seções de STT/TTS de Configurações → Áudio: valor do "Endpoint
// personalizado" no seletor de provedor, família de API efetiva e o player dos bytes de áudio.
import { voiceProviderSupport, type VoiceProviderSupport } from '@shared/voiceCatalog'
import { errorMessage } from '../api'

/** Provedor cadastrado como a tela de Áudio o vê (sem chave — o main usa o `providerId`). */
export interface ProviderOption {
  id: string
  name: string
  baseUrl: string
  kind?: string
}

/** Valor do seletor de provedor para o endpoint personalizado (setting com `providerId: null`). */
export const CUSTOM_ENDPOINT = '__custom__'

/** Família de API efetiva do STT/TTS (provedor escolhido, ou a baseUrl do endpoint personalizado). */
export function effectiveFamily(
  provider: ProviderOption | null,
  baseUrl: string
): VoiceProviderSupport | null {
  if (provider) return voiceProviderSupport(provider)
  return baseUrl.trim() ? voiceProviderSupport({ baseUrl }) : null
}

// ---------------- reprodução ----------------

/**
 * Toca bytes de áudio (blob → `<audio>`; a CSP da janela libera `media-src blob:`); falhas viram
 * mensagem legível em pt-BR. Devolve o elemento + blob URL para o chamador PARAR.
 */
export function playAudioBytes(
  audio: Uint8Array,
  mime: string,
  onEnd: () => void,
  onError: (msg: string) => void
): { el: HTMLAudioElement; url: string } | null {
  const fail = (e: unknown): void => {
    const name = (e as { name?: string })?.name
    const kb = Math.max(1, Math.round(audio.byteLength / 1024))
    onError(
      name === 'NotAllowedError'
        ? 'o sistema bloqueou a reprodução de áudio — clique de novo em Testar voz'
        : name === 'NotSupportedError' || !name
          ? `o áudio sintetizado (${mime}, ${kb} KB) não pôde ser reproduzido`
          : `não foi possível reproduzir o áudio: ${errorMessage(e)}`
    )
  }
  try {
    if (!audio.byteLength) {
      onError('a síntese devolveu um áudio vazio')
      return null
    }
    // cópia: `Uint8Array<ArrayBuffer>` satisfaz `BlobPart` em qualquer origem do buffer
    const blob = new Blob([new Uint8Array(audio)], { type: mime })
    const url = URL.createObjectURL(blob)
    const el = new Audio(url)
    let failed = false
    el.onended = (): void => {
      URL.revokeObjectURL(url)
      onEnd()
    }
    el.onerror = (): void => {
      if (failed) return
      failed = true
      URL.revokeObjectURL(url)
      fail(null)
    }
    void el.play().catch((e: unknown) => {
      // pausa do "Parar" antes de começar não é erro
      if ((e as { name?: string })?.name === 'AbortError') return
      if (failed) return
      failed = true
      URL.revokeObjectURL(url)
      fail(e)
    })
    return { el, url }
  } catch (e) {
    fail(e)
    return null
  }
}
