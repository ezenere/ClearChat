// Seletor ÚNICO de modelo de Transcrição/Fala (Configurações → Áudio — lógica PURA, testada em
// `e2e/voiceModelOptions.test.ts`): os grupos são os provedores cadastrados que servem a capacidade
// (com a lista curada de cada um) + "Local (CPU)" (whisper.cpp/Vosk/Nemotron instalados no STT;
// Kokoro no TTS) e "Local (GPU)" (motores instalados no Modo avançado). Os grupos locais só existem
// com pelo menos um modelo daquele tipo instalado (ou com a seleção atual neles — para o gatilho
// mostrar o nome e o aviso "não instalado"). Escolher um modelo grava TUDO de uma vez
// (modo/backend + provedor + motor + modelo). O "híbrido" do STT vira um interruptor visível só com
// um modelo de API escolhido e um modelo local (CPU) instalado.
import type { VoiceModelInfo } from '@shared/ipc'
import type { ModelRef } from '@shared/models'
import type { GpuEngineStatus, GpuStatus } from '@shared/gpuVoice'
import {
  DEFAULT_STT_GPU,
  DEFAULT_TTS_LOCAL,
  type SttSettings,
  type TtsSettings
} from '@shared/voice'
import { gpuConfigFor, sortGpuEngines } from './gpu/gpuUi'

/** Grupo "Local (CPU)" do seletor (id de provedor reservado — nunca um provedor cadastrado). */
export const LOCAL_CPU_GROUP = '__local_cpu__'
/** Grupo "Local (GPU)" do seletor. */
export const LOCAL_GPU_GROUP = '__local_gpu__'
export const LOCAL_CPU_LABEL = 'Local (CPU)'
export const LOCAL_GPU_LABEL = 'Local (GPU)'

/** Id do Kokoro no grupo "Local (CPU)" da Fala (um motor — os pesos/vozes ficam em Modelos locais). */
export const KOKORO_OPTION = 'kokoro'

export const isLocalGroup = (providerId: string | null | undefined): boolean =>
  providerId === LOCAL_CPU_GROUP || providerId === LOCAL_GPU_GROUP

/** Um modelo local no seletor. */
export interface LocalModelOption {
  id: string
  name: string
  /** Linha miúda (motor, tamanho…). */
  detail?: string
  /** false = a seleção atual aponta para ele, mas não está instalado (aviso no campo). */
  installed: boolean
}

/** Um grupo local do seletor (só aparece com opções). */
export interface LocalModelGroup {
  id: typeof LOCAL_CPU_GROUP | typeof LOCAL_GPU_GROUP
  name: string
  options: LocalModelOption[]
}

const ENGINE_LABEL: Record<string, string> = {
  'whisper.cpp': 'whisper.cpp',
  vosk: 'Vosk',
  nemotron: 'Nemotron'
}

const installedGpu = (s: GpuStatus | null, kind: 'stt' | 'tts'): GpuEngineStatus[] =>
  s
    ? sortGpuEngines(s.engines.filter((e) => e.kind === kind && e.install.state === 'installed'))
    : []

/** STT "Local (CPU)": os modelos instalados (whisper.cpp/Vosk/Nemotron) + o atual se não estiver. */
export function localCpuSttOptions(
  models: readonly VoiceModelInfo[],
  stt: SttSettings
): LocalModelOption[] {
  const out: LocalModelOption[] = models
    .filter((m) => m.kind === 'stt' && m.state === 'installed')
    .map((m) => ({
      id: m.id,
      name: m.name,
      detail: ENGINE_LABEL[m.engine] ?? m.engine,
      installed: true
    }))
  const cur = sttModelRef(stt)
  if (cur?.providerId === LOCAL_CPU_GROUP && !out.some((o) => o.id === cur.model)) {
    const m = models.find((x) => x.id === cur.model)
    out.push({
      id: cur.model,
      name: m?.name ?? cur.model,
      detail: ENGINE_LABEL[stt.local?.engine ?? ''] ?? stt.local?.engine,
      installed: false
    })
  }
  return out
}

/** TTS "Local (CPU)": o Kokoro quando algum peso dele está instalado (ou é a seleção atual). */
export function localCpuTtsOptions(
  models: readonly VoiceModelInfo[],
  tts: TtsSettings
): LocalModelOption[] {
  const weights = models.filter(
    (m) => m.kind === 'tts' && m.engine === 'kokoro' && !/voice/i.test(m.id)
  )
  const installed = weights.some((m) => m.state === 'installed')
  if (!installed && tts.backend !== 'local') return []
  return [{ id: KOKORO_OPTION, name: 'Kokoro-82M', detail: 'Kokoro (ONNX)', installed }]
}

/** "Local (GPU)": os motores instalados do tipo + o atual se não estiver. */
export function gpuOptions(
  status: GpuStatus | null,
  kind: 'stt' | 'tts',
  current: string | null
): LocalModelOption[] {
  const out: LocalModelOption[] = installedGpu(status, kind).map((e) => ({
    id: e.id,
    name: e.label,
    detail: 'GPU local',
    installed: true
  }))
  if (current && !out.some((o) => o.id === current)) {
    const e = status?.engines.find((x) => x.id === current)
    out.push({ id: current, name: e?.label ?? current, detail: 'GPU local', installed: false })
  }
  return out
}

/** Grupos locais do STT (vazios somem — sem modelo local instalado, nenhum grupo local). */
export function sttLocalGroups(
  models: readonly VoiceModelInfo[],
  status: GpuStatus | null,
  stt: SttSettings
): LocalModelGroup[] {
  const cpu = localCpuSttOptions(models, stt)
  const gpu = gpuOptions(
    status,
    'stt',
    stt.mode === 'gpu' ? (stt.gpu?.engine ?? DEFAULT_STT_GPU.engine) : null
  )
  return [
    ...(cpu.length ? [{ id: LOCAL_CPU_GROUP, name: LOCAL_CPU_LABEL, options: cpu } as const] : []),
    ...(gpu.length ? [{ id: LOCAL_GPU_GROUP, name: LOCAL_GPU_LABEL, options: gpu } as const] : [])
  ]
}

/** Grupos locais do TTS (vazios somem). */
export function ttsLocalGroups(
  models: readonly VoiceModelInfo[],
  status: GpuStatus | null,
  tts: TtsSettings
): LocalModelGroup[] {
  const cpu = localCpuTtsOptions(models, tts)
  const gpu = gpuOptions(status, 'tts', tts.backend === 'gpu' ? (tts.gpu?.engine ?? null) : null)
  return [
    ...(cpu.length ? [{ id: LOCAL_CPU_GROUP, name: LOCAL_CPU_LABEL, options: cpu } as const] : []),
    ...(gpu.length ? [{ id: LOCAL_GPU_GROUP, name: LOCAL_GPU_LABEL, options: gpu } as const] : [])
  ]
}

// ---------------- seleção atual ↔ settings ----------------

/** Seleção atual do STT no seletor (null = nenhum provedor escolhido). */
export function sttModelRef(stt: SttSettings): ModelRef | null {
  if (stt.mode === 'local')
    return {
      providerId: LOCAL_CPU_GROUP,
      model: stt.local?.model || stt.local?.engine || 'whisper.cpp'
    }
  if (stt.mode === 'gpu')
    return { providerId: LOCAL_GPU_GROUP, model: stt.gpu?.engine ?? DEFAULT_STT_GPU.engine }
  return stt.api.providerId && stt.api.model.trim()
    ? { providerId: stt.api.providerId, model: stt.api.model }
    : null
}

/** Seleção atual da Fala no seletor. */
export function ttsModelRef(tts: TtsSettings): ModelRef | null {
  if (tts.backend === 'local') return { providerId: LOCAL_CPU_GROUP, model: KOKORO_OPTION }
  if (tts.backend === 'gpu')
    return tts.gpu?.engine ? { providerId: LOCAL_GPU_GROUP, model: tts.gpu.engine } : null
  return tts.api.providerId && tts.api.model.trim()
    ? { providerId: tts.api.providerId, model: tts.api.model }
    : null
}

/**
 * Escolha no seletor → `sttSettings` completas: "Local (CPU)" = modo local com o motor/modelo da
 * linha; "Local (GPU)" = modo gpu; provedor = API (o híbrido continua se já estava).
 */
export function applySttPick(
  stt: SttSettings,
  ref: ModelRef,
  models: readonly VoiceModelInfo[]
): SttSettings {
  if (ref.providerId === LOCAL_CPU_GROUP) {
    const m = models.find((x) => x.id === ref.model && x.kind === 'stt')
    const engine = (m?.engine ?? stt.local?.engine ?? 'whisper.cpp') as NonNullable<
      SttSettings['local']
    >['engine']
    return {
      ...stt,
      mode: 'local',
      local: { engine, model: ref.model, installed: m?.state === 'installed' }
    }
  }
  if (ref.providerId === LOCAL_GPU_GROUP)
    return { ...stt, mode: 'gpu', gpu: stt.gpu ?? { ...DEFAULT_STT_GPU } }
  return {
    ...stt,
    mode: stt.mode === 'hybrid' ? 'hybrid' : 'api',
    api: { ...stt.api, providerId: ref.providerId, model: ref.model }
  }
}

/**
 * Escolha no seletor → `ttsSettings` completas: Kokoro = backend local; motor da GPU = backend gpu
 * (mantém a voz se o motor novo tiver); provedor = API (`voice` = a voz já ajustada ao modelo novo
 * pelo chamador, que conhece o catálogo).
 */
export function applyTtsPick(
  tts: TtsSettings,
  ref: ModelRef,
  ctx: { models: readonly VoiceModelInfo[]; gpu: GpuStatus | null; voice?: string | null }
): TtsSettings {
  if (ref.providerId === LOCAL_CPU_GROUP) {
    const installed = ctx.models.some(
      (m) =>
        m.kind === 'tts' && m.engine === 'kokoro' && m.state === 'installed' && !/voice/i.test(m.id)
    )
    return {
      ...tts,
      backend: 'local',
      local: {
        engine: 'kokoro',
        voice: tts.local?.voice || DEFAULT_TTS_LOCAL.voice,
        installed: installed || (tts.local?.engine === 'kokoro' && tts.local.installed)
      }
    }
  }
  if (ref.providerId === LOCAL_GPU_GROUP) {
    const e = ctx.gpu?.engines.find((x) => x.id === ref.model)
    const gpu = e ? gpuConfigFor(e, tts.gpu) : tts.gpu
    return { ...tts, backend: 'gpu', ...(gpu ? { gpu } : {}) }
  }
  return {
    ...tts,
    backend: 'api',
    api: {
      ...tts.api,
      providerId: ref.providerId,
      model: ref.model,
      ...(ctx.voice !== undefined ? { voice: ctx.voice } : {})
    }
  }
}

// ---------------- híbrido (STT) ----------------

/** Modelo local (CPU) de STT instalado que serve de parciais/reserva (o atual primeiro). */
export function hybridLocalModel(
  stt: SttSettings,
  models: readonly VoiceModelInfo[]
): VoiceModelInfo | null {
  const installed = models.filter((m) => m.kind === 'stt' && m.state === 'installed')
  return (
    installed.find((m) => m.id === stt.local?.model) ??
    installed.find((m) => m.engine === stt.local?.engine) ??
    installed[0] ??
    null
  )
}

/**
 * O interruptor "Motor local nas parciais e como reserva" aparece? Só com um modelo de API escolhido
 * e um modelo local de STT (CPU) instalado — o híbrido usa o motor da CPU.
 */
export function hybridToggleVisible(stt: SttSettings, models: readonly VoiceModelInfo[]): boolean {
  if (stt.mode !== 'api' && stt.mode !== 'hybrid') return false
  if (!stt.api.providerId || !stt.api.model.trim()) return false
  return !!hybridLocalModel(stt, models)
}

/** Liga/desliga o híbrido (ligar aponta `local` para um modelo instalado se o atual não estiver). */
export function setHybrid(
  stt: SttSettings,
  on: boolean,
  models: readonly VoiceModelInfo[]
): SttSettings {
  if (!on) return { ...stt, mode: 'api' }
  const m = hybridLocalModel(stt, models)
  const local =
    stt.local?.installed && m && stt.local.model === m.id
      ? stt.local
      : m
        ? {
            engine: m.engine as NonNullable<SttSettings['local']>['engine'],
            model: m.id,
            installed: true
          }
        : stt.local
  return { ...stt, mode: 'hybrid', local }
}
