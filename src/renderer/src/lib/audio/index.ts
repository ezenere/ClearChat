// Fundação de captura de áudio da feature de voz (renderer) — API pública reutilizável.
// Nesta fatia não há integração com o Composer: os consumidores (Composer, settings, chamada de
// voz) entram nas fatias futuras. Contrato de configuração: `src/shared/voice.ts` (não alterado).
export * from './pcm'
export * from './silence'
export * from './hotkey'
export * from './capture'
export * from './devices'
export * from './usePushToTalk'
