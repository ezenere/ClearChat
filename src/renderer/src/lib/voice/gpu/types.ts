// Tipos do "Modo avançado (GPU local)" no renderer: reexporta o contrato compartilhado
// (`@shared/gpuVoice`, `VoiceGpuApi` de `@shared/ipc`) e dá o acesso opcional à API (`gpuApi()` →
// null = backend ausente neste build/mock) e ao evento de progresso. Os aliases `*SettingsGpu` e
// `asGpu*`/`fromGpu*` ficaram da fase em que o backend ainda não tinha `'gpu'` em `voice.ts` (hoje
// são identidade — mantidos para não espalhar casts).
import type { VoiceGpuApi } from '@shared/ipc'
import type { GpuStatus } from '@shared/gpuVoice'
import type { SttSettings, TtsSettings } from '@shared/voice'
import { api } from '../../api'

export type {
  GpuCompat,
  GpuCompatLevel,
  GpuEngineId,
  GpuEngineStatus,
  GpuInfo,
  GpuInstallState,
  GpuSelfTestResult,
  GpuStatus,
  GpuTtsEngineId,
  GpuVoice,
  SttGpuConfig,
  TtsGpuConfig
} from '@shared/gpuVoice'
export type { VoiceGpuApi } from '@shared/ipc'

export type TtsSettingsGpu = TtsSettings
export type SttSettingsGpu = SttSettings

export const asGpuTts = (t: TtsSettings): TtsSettingsGpu => t
export const asGpuStt = (s: SttSettings): SttSettingsGpu => s
export const fromGpuTts = (t: TtsSettingsGpu): TtsSettings => t
export const fromGpuStt = (s: SttSettingsGpu): SttSettings => s

/** API da GPU, se o build/preload a expõe (null = modo avançado indisponível). */
export function gpuApi(): VoiceGpuApi | null {
  return api.voice?.gpu ?? null
}

/** Assina o progresso (`onVoiceGpuProgress`, status completo atualizado); no-op sem backend. */
export function onGpuProgress(cb: (s: GpuStatus) => void): () => void {
  return api.onVoiceGpuProgress ? api.onVoiceGpuProgress(cb) : () => void 0
}
