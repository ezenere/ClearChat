/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** '1' = build de desenvolvimento com window.api simulado (src/dev/mockApi.ts). */
  readonly VITE_CLEAR_MOCK?: string
}
