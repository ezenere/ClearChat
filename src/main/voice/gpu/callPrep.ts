// "Modo avançado (GPU local)" — preparo da GPU no início da chamada de voz (sem Electron; tudo
// injetado — testado com fakes em `e2e/gpuVoice.test.ts`). Com fala e/ou transcrição na GPU, o
// `voice:call:start` entra na chamada e, se os motores ainda não estão carregados, a chamada fica
// na fase "Preparando a GPU…" (`VoiceCallState.preparing` com o andamento) enquanto o servidor
// local sobe e aquece; o renderer só abre o microfone quando `preparing` some (a 1ª vez não paga a
// carga dos modelos). Falha (servidor não subiu, OOM, motor que não carregou) → a chamada termina
// com o motivo legível (política de erro da chamada) e a sugestão da voz na nuvem. Ver SPEC.md →
// "Modo avançado (GPU local) — backend" → "Liga sozinho".
import { gpuEnginesLabel, type GpuEngineId } from '@shared/gpuVoice'

export interface GpuCallPrepDeps {
  /** Motores que a chamada usa (fala `gpu` e/ou transcrição `gpu`); vazio = nada a preparar. */
  engines: readonly GpuEngineId[]
  /** Já carregados num processo rodando? (então nada de fase de preparo) */
  isWarm(ids: readonly GpuEngineId[]): Promise<boolean>
  /** Sobe + aquece (o `startServer` do gerenciador), relatando o andamento legível. */
  start(ids: readonly GpuEngineId[], onPhase: (text: string) => void): Promise<void>
  /** Texto da fase de preparo da chamada (null = pronta: o microfone pode abrir). */
  setPreparing(text: string | null): void
  /** A MESMA chamada ainda está ativa (o usuário não encerrou/reabriu no meio)? */
  stillActive(): boolean
  /** Encerra a chamada com o motivo (o renderer mostra "Chamada encerrada: …"). */
  fail(reason: string): void
}

export type GpuCallPrepResult = 'none' | 'warm' | 'ready' | 'failed' | 'aborted'

/** Motivo legível da falha do preparo + a saída (fechar programas / voz na nuvem). */
export function gpuCallFailureReason(e: unknown): string {
  const msg = (e instanceof Error ? e.message : String(e)).trim().replace(/[.\s]+$/, '')
  return `a GPU local não ficou pronta — ${msg}. Feche programas que usam a GPU e tente de novo, ou use uma voz na nuvem (Configurações → Áudio)`
}

export async function prepareGpuForCall(d: GpuCallPrepDeps): Promise<GpuCallPrepResult> {
  if (!d.engines.length) return 'none'
  if (await d.isWarm(d.engines).catch(() => false)) return 'warm'
  if (!d.stillActive()) return 'aborted'
  d.setPreparing(`Iniciando ${gpuEnginesLabel(d.engines)}…`)
  try {
    await d.start(d.engines, (text) => {
      if (d.stillActive()) d.setPreparing(text)
    })
  } catch (e) {
    if (!d.stillActive()) return 'aborted'
    d.fail(gpuCallFailureReason(e))
    return 'failed'
  }
  if (!d.stillActive()) return 'aborted'
  d.setPreparing(null)
  return 'ready'
}
