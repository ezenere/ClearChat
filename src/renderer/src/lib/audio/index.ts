// Fundação de captura de áudio da feature de voz (renderer) — API pública reutilizável.
// Consumidores: ditado (`lib/voice/useDictation.ts`), chamada de voz (`lib/voice/useVoiceCall.ts`)
// e Configurações → Áudio. Contrato de configuração: `src/shared/voice.ts`.
export * from './pcm'
export * from './silence'
export * from './hotkey'
export * from './capture'
export * from './devices'
export * from './usePushToTalk'
