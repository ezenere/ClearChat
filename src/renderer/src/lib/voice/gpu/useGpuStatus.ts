// Espelho ÚNICO do status do modo GPU no renderer (`voice.gpu.status()` + evento
// `onVoiceGpuProgress`): a seção "Modo avançado (GPU local)" e os painéis de Fala/Transcrição leem
// daqui, então um download em andamento aparece igual nos dois lugares. A assinatura do progresso
// é feita uma vez (no primeiro uso). Também guarda o "abrir a seção" pedido por um link
// ("instale no Modo avançado") — a seção expande e rola até a vista.
import { useEffect } from 'react'
import { create } from 'zustand'
import { errorMessage } from '../../api'
import { gpuApi, onGpuProgress, type GpuStatus } from './types'

interface GpuStore {
  /** null = ainda não leu (ou sem backend). */
  status: GpuStatus | null
  /** O backend existe neste build (`window.api.voice.gpu`). */
  available: boolean
  loading: boolean
  /** Falha ao ler o status (legível). */
  error: string | null
  /** Seção expandida (fechada por padrão — opção avançada). */
  expanded: boolean
  /** Contador de pedidos "abrir e mostrar a seção" (link dos painéis). */
  reveal: number
  /** Painel a destacar ao abrir pelo link ('engines' | 'voices' | null). */
  revealTarget: 'engines' | 'voices' | 'runtime' | null
  /** Formulário "Nova voz" (Minhas vozes) aberto. */
  cloneOpen: boolean
}

export const useGpuStore = create<GpuStore>(() => ({
  status: null,
  available: false,
  loading: false,
  error: null,
  expanded: false,
  reveal: 0,
  revealTarget: null,
  cloneOpen: false
}))

let subscribed = false
let inflight: Promise<GpuStatus | null> | null = null

/** Relê o status do backend (chamadas simultâneas compartilham a request). */
export function refreshGpuStatus(): Promise<GpuStatus | null> {
  const gpu = gpuApi()
  if (!gpu) {
    useGpuStore.setState({ available: false, status: null })
    return Promise.resolve(null)
  }
  if (inflight) return inflight
  useGpuStore.setState({ available: true, loading: true })
  inflight = gpu
    .status()
    .then((status) => {
      if (isNewer(status)) useGpuStore.setState({ status, error: null })
      else useGpuStore.setState({ error: null })
      return status
    })
    .catch((e) => {
      useGpuStore.setState({ error: `Não foi possível ler o status da GPU: ${errorMessage(e)}` })
      return null
    })
    .finally(() => {
      inflight = null
      useGpuStore.setState({ loading: false })
    })
  return inflight
}

/**
 * O status recebido é mais novo que o da tela? (`seq` crescente do main: um `status()` lento —
 * a sonda do nvidia-smi — que volta DEPOIS de um evento de progresso não pode desfazer o progresso
 * nem ressuscitar um estado velho. Sem `seq` (mock/versão antiga) → sempre aplica.)
 */
function isNewer(next: GpuStatus): boolean {
  const cur = useGpuStore.getState().status
  return next.seq == null || cur?.seq == null || next.seq >= cur.seq
}

/** Aplica um status vindo de evento/ação (descarta um mais velho que o da tela). */
export const setGpuStatus = (status: GpuStatus): void => {
  if (isNewer(status)) useGpuStore.setState({ status, available: true, error: null })
}

/** Atualiza o status localmente (estado otimista enquanto a ação não volta). */
export function patchGpuStatus(fn: (s: GpuStatus) => GpuStatus): void {
  const s = useGpuStore.getState().status
  if (s) useGpuStore.setState({ status: fn(s) })
}

export const setGpuSectionExpanded = (expanded: boolean): void => useGpuStore.setState({ expanded })

/** Link "instale no Modo avançado": expande a seção e pede para rolar até ela. */
export function revealGpuSection(target: GpuStore['revealTarget'] = null): void {
  useGpuStore.setState((s) => ({
    expanded: true,
    reveal: s.reveal + 1,
    revealTarget: target,
    ...(target === 'voices' ? { cloneOpen: true } : {})
  }))
}

export const setGpuCloneOpen = (cloneOpen: boolean): void => useGpuStore.setState({ cloneOpen })

/** Status da GPU (lê no 1º uso e assina o progresso uma vez). */
export function useGpuStatus(): GpuStore {
  const state = useGpuStore()
  useEffect(() => {
    if (!gpuApi()) return
    if (!subscribed) {
      subscribed = true
      onGpuProgress(setGpuStatus)
    }
    if (!useGpuStore.getState().status) void refreshGpuStatus()
  }, [])
  return state
}
