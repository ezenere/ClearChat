// Abre Configurações → Áudio → "Modelos locais" (sub-tela) e, opcionalmente, rola até a parte da GPU
// pedida (`revealGpuSection`) — usado pelos links "instale em Modelos locais"/"gerenciar".
import { useStore } from '../../store'
import { revealGpuSection } from './gpu/useGpuStatus'

export function openGpuLocalModels(target: 'engines' | 'voices' | 'runtime' = 'engines'): void {
  useStore.getState().setSettingsOpen(true, 'audio:local')
  revealGpuSection(target)
}
