import './styles.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { installApi } from './lib/api'

async function start(): Promise<void> {
  // Mock de desenvolvimento (apenas para screenshots/design sem backend). A condição é
  // substituída em tempo de build: no build normal o módulo do mock nem entra no bundle.
  if (import.meta.env.VITE_CLEAR_MOCK === '1') {
    const { createMockApi } = await import('./dev/mockApi')
    installApi(createMockApi(new URLSearchParams(location.search).get('scenario') ?? 'chat'))
    // estado do app acessível aos E2E contra o mock (só neste build)
    const { useStore } = await import('./store')
    ;(window as unknown as { __clearStore?: typeof useStore }).__clearStore = useStore
  }
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>
  )
}

void start()
