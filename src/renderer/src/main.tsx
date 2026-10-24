import './styles.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { installApi } from './lib/api'
import { setupRemoteSources } from './lib/remoteSourcesSetup'
import { installContextMenuBridge } from './lib/contextMenu'

async function start(): Promise<void> {
  // Mock de desenvolvimento (apenas para screenshots/design sem backend). A condição é
  // substituída em tempo de build: no build normal o módulo do mock nem entra no bundle.
  if (import.meta.env.VITE_CLEAR_MOCK === '1') {
    const { createMockApi } = await import('./dev/mockApi')
    const mockApi = createMockApi(new URLSearchParams(location.search).get('scenario') ?? 'chat')
    installApi(mockApi)
    // a API simulada acessível aos E2E do mock (ex.: simular um turno de voz)
    ;(window as unknown as { __clearMockApi?: typeof mockApi }).__clearMockApi = mockApi
    // estado do app acessível aos E2E contra o mock (só neste build)
    const { useStore } = await import('./store')
    ;(window as unknown as { __clearStore?: typeof useStore }).__clearStore = useStore
    // runtime da chamada de voz (transcrição ao vivo da barra) — E2E do mock
    const { useVoiceCallRuntime } = await import('./lib/voice/voiceCallRuntime')
    ;(
      window as unknown as { __clearVoiceRuntime?: typeof useVoiceCallRuntime }
    ).__clearVoiceRuntime = useVoiceCallRuntime
  }
  // fonte remota de arquivos (chat em controle remoto: busca do host pelo sync)
  setupRemoteSources()
  // botão direito: ações do app (mensagem, código, arquivo) no menu nativo do main
  installContextMenuBridge()
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>
  )
}

void start()
