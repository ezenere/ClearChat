// "Modo avançado (GPU local)" — ponte entre as settings (`ttsSettings.backend: 'gpu'`) e os
// clientes OpenAI-compatíveis de sempre (`voice/tts.ts`, `voice/stt.ts`): o main registra um
// resolvedor (o `GpuVoiceManager`) que garante o servidor do motor no ar e devolve URL + token da
// sessão; a síntese segue pelo caminho de API inalterado (PCM em streaming, relay da chamada).
// URL/token só existem aqui dentro do main — nunca nas settings, na visão do renderer ou em logs.
import { DEFAULT_TTS_API, type TtsSettings } from '@shared/voice'
import { DEFAULT_TTS_GPU, type GpuTtsEngineId } from '@shared/gpuVoice'

export interface GpuEndpoint {
  baseUrl: string
  apiKey: string
}

/** Falha de prontidão do modo GPU — `kind` decide a política da chamada (config = fatal). */
export class GpuEndpointError extends Error {
  readonly kind: 'config' | 'network'
  constructor(message: string, kind: 'config' | 'network') {
    super(message)
    this.name = 'GpuEndpointError'
    this.kind = kind
  }
}

export interface GpuEndpointResolver {
  tts(engine: GpuTtsEngineId, opts: { steps?: number }): Promise<GpuEndpoint>
  stt(): Promise<GpuEndpoint>
}

let resolver: GpuEndpointResolver | null = null

/** O main registra o gerenciador (null = desliga — testes). */
export function setGpuEndpointResolver(r: GpuEndpointResolver | null): void {
  resolver = r
}

export function getGpuEndpointResolver(): GpuEndpointResolver | null {
  return resolver
}

/**
 * `ttsSettings` com backend `gpu` → as mesmas settings no backend `api` apontando para o servidor
 * local (modelo = id do motor; voz = a escolhida, null = a padrão do motor).
 */
export async function gpuTtsAsApi(settings: TtsSettings): Promise<TtsSettings> {
  if (!resolver)
    throw new GpuEndpointError(
      'o modo avançado (GPU local) não está disponível nesta execução',
      'config'
    )
  const gpu = settings.gpu ?? DEFAULT_TTS_GPU
  const ep = await resolver.tts(gpu.engine, { steps: gpu.steps })
  return {
    ...settings,
    backend: 'api',
    api: {
      ...DEFAULT_TTS_API,
      baseUrl: ep.baseUrl,
      apiKey: ep.apiKey,
      model: gpu.engine,
      voice: gpu.voice
    }
  }
}
