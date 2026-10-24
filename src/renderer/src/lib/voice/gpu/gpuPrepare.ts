// "Liga sozinho" do servidor da GPU no DITADO (transcrição `gpu`): ao começar a gravar, o servidor
// local sobe/aquece o whisper em segundo plano (`voice.gpu.startServer(['whisper-large-v3-turbo'])`
// — idempotente e rápido quando já está carregado). O microfone abre na hora (o áudio fica na
// sessão de transcrição do main e sai quando o servidor responde); só se o preparo demorar mais
// que `SHOW_AFTER_MS` o estado "preparando a GPU…" aparece — `useGpuPrepare((s) => s.dictation)`
// (ou `DictationControls.gpuPreparing`), para o composer mostrar no botão do microfone / linha
// fantasma. A chamada tem a própria fase ("Preparando a GPU…" na barra — `VoiceCallState.preparing`).
import { create } from 'zustand'
import type { SttSettings } from '@shared/voice'
import { gpuApi, onGpuProgress } from './types'

/** Preparo em andamento visível (null = nada). */
export interface GpuPrepareState {
  /** "Preparando a GPU…" + a fase do servidor ("Aquecendo Whisper large-v3-turbo…"). */
  text: string
}

export interface GpuPrepareStore {
  /** Ditado esperando a GPU (null = pronto/sem GPU). */
  dictation: GpuPrepareState | null
}

export const useGpuPrepare = create<GpuPrepareStore>(() => ({ dictation: null }))

/** Hook para o composer: o ditado está esperando a GPU? (texto curto para o botão/linha fantasma) */
export function useDictationGpuPreparing(): GpuPrepareState | null {
  return useGpuPrepare((s) => s.dictation)
}

/** Atraso antes de mostrar o estado (servidor já quente responde antes — sem piscar). */
export const SHOW_AFTER_MS = 300

let seq = 0

/**
 * Prepara a GPU para o ditado (transcrição `gpu`); resolve quando pronto. Erro (servidor não subiu,
 * OOM) → rejeita com a mensagem legível — o ditado mostra e a gravação segue (a transcrição falha
 * com o mesmo motivo, sem travar a UI). Sem modo `gpu` ou sem a API → resolve na hora.
 */
export async function prepareGpuForDictation(stt: Pick<SttSettings, 'mode'>): Promise<void> {
  const gpu = gpuApi()
  if (stt.mode !== 'gpu' || !gpu) return
  const mine = ++seq
  let phase: string | null = null
  const show = (): void => {
    if (mine !== seq) return
    useGpuPrepare.setState({
      dictation: { text: phase ? `Preparando a GPU… ${phase}` : 'Preparando a GPU…' }
    })
  }
  const timer = setTimeout(show, SHOW_AFTER_MS)
  const off = onGpuProgress((s) => {
    phase = s.server.phase ?? null
    if (mine === seq && useGpuPrepare.getState().dictation) show()
  })
  try {
    await gpu.startServer(['whisper-large-v3-turbo'])
  } finally {
    clearTimeout(timer)
    off()
    if (mine === seq) useGpuPrepare.setState({ dictation: null })
  }
}

/** Ditado cancelado/terminado antes do preparo acabar: some o estado (o servidor segue subindo). */
export function clearDictationGpuPreparing(): void {
  seq++
  useGpuPrepare.setState({ dictation: null })
}
