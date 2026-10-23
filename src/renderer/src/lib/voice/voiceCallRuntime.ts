// Estado de runtime da chamada de voz no renderer (fora do store principal: o nível do microfone
// muda a ~30 Hz e só o waveform do dock deve re-renderizar). O controller (`useVoiceCall`, montado
// uma única vez em `App` por `VoiceCallController`) publica aqui; a barra da chamada — que ocupa o
// lugar do composer do chat da chamada — só lê e chama as ações.
import { create } from 'zustand'

/** Clipes de interjeição/filler da voz atual (sem eles os atos de fala curta não tocam). */
export type VoiceClipsState = 'unknown' | 'missing' | 'ok' | 'generating'

export interface VoiceCallRuntime {
  /** Nível RMS ao vivo (0..1) para o `Waveform`. */
  level: number
  /** Erro legível da captura/transcrição durante a chamada (o do main vem em `voiceCall.error`). */
  error: string | null
  /** Volume da reprodução (0..1). */
  volume: number
  clips: VoiceClipsState
  /** Progresso da geração de clipes ("Gerar clipes" no dock). */
  clipsProgress: { done: number; total: number } | null
  toggleMute: () => Promise<void>
  setVolume: (volume: number) => void
  clearError: () => void
  generateClips: () => Promise<void>
}

export const useVoiceCallRuntime = create<VoiceCallRuntime>(() => ({
  level: 0,
  error: null,
  volume: 1,
  clips: 'unknown',
  clipsProgress: null,
  toggleMute: async () => {},
  setVolume: () => {},
  clearError: () => {},
  generateClips: async () => {}
}))
