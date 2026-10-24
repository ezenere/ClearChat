// Mock do "Modo avançado (GPU local)" (`window.api.voice.gpu` + `onVoiceGpuProgress`) para a UI
// (VITE_CLEAR_MOCK=1). Estado em memória com downloads simulados em timers (eventos de progresso
// com o status completo), autoteste com as latências medidas no lab (`gpu-tts-lab/RESULTS.md`,
// RTX 3080 Ti) e vozes do usuário. Cenários (`?scenario=`):
//   gpu-ok           → RTX 3080 Ti 12 GB, runtime ausente (padrão dos demais cenários)
//   gpu-installed    → runtime + OmniVoice + whisper instalados, servidor rodando, latências do lab
//   gpu-installing   → o runtime está baixando (progresso lento — dá para cancelar)
//   gpu-none         → sem GPU NVIDIA (só Intel integrada): tudo com aviso (CPU, lento)
//   gpu-lowvram      → GTX 1650 4 GB: OmniVoice/XTTS com aviso, Qwen 1.7B bloqueado (VRAM)
//   gpu-mac          → Apple M2 Pro: experimental (MPS) — aviso em todos os motores
//   gpu-incompatible → GPU Kepler sem CUDA 12: tudo bloqueado (runtime inclusive)
//   gpu-broken       → runtime com problema (erro + log)
//   gpu-call         → como gpu-installed, mas com o servidor PARADO e Fala/Transcrição na GPU
//                      (a chamada entra em "Preparando a GPU…" e o servidor liga sozinho)
//   gpu-call-lowvram → gpu-call com só 2,1 GB de VRAM livre (aviso, a chamada segue)
//   gpu-call-oom     → gpu-call em que o aquecimento estoura a VRAM (a chamada termina com o motivo)
//   gpu-own-vram     → caso real: o servidor do app (OmniVoice + Whisper carregados) ocupa a VRAM e
//                      sobra pouca livre — nenhum aviso de VRAM (a do app não conta; o carregado
//                      nunca avisa) e o XTTS instalado mostra "o app libera … ao trocar"
// A VRAM é recalculada a cada status (servidor ligado/parado muda a livre e os avisos).
import { GPU_CC0_VOICES, gpuEnginesLabel } from '@shared/gpuVoice'
import type {
  GpuCompat,
  GpuEngineId,
  GpuEngineStatus,
  GpuInfo,
  GpuStatus,
  GpuVoice,
  VoiceGpuApi
} from '../lib/voice/gpu/types'

type Delay = <T>(v: T, ms?: number) => Promise<T>

interface EngineSpec {
  id: GpuEngineId
  kind: 'tts' | 'stt'
  label: string
  license: GpuEngineStatus['license']
  sizeMb: number
  vramMb: number
  languages: string[]
  ptBR: GpuEngineStatus['ptBR']
  streaming: boolean
  builtin: GpuVoice[]
  clones: boolean
  /** Latência medida no lab (1º áudio / RTF) — RESULTS.md §3–§4. */
  lab: { firstAudioMs: number; rtf: number }
}

const ENGINES: EngineSpec[] = [
  {
    id: 'omnivoice',
    kind: 'tts',
    label: 'OmniVoice',
    license: {
      name: 'CC-BY-NC-4.0',
      url: 'https://huggingface.co/k2-fsa/OmniVoice',
      commercial: false
    },
    sizeMb: 3289,
    vramMb: 3800,
    languages: ['pt', 'en', 'es', 'zh', 'ja'],
    ptBR: 'native',
    streaming: false,
    builtin: [],
    clones: true,
    lab: { firstAudioMs: 315, rtf: 0.158 }
  },
  {
    id: 'xtts-v2',
    kind: 'tts',
    label: 'XTTS-v2',
    license: { name: 'CPML', url: 'https://coqui.ai/cpml', commercial: false },
    sizeMb: 2134,
    vramMb: 3700,
    languages: ['pt', 'en', 'es', 'fr', 'de', 'it'],
    ptBR: 'native',
    streaming: true,
    builtin: [
      { id: 'xtts-ana-florence', label: 'Ana Florence', source: 'builtin', accent: 'other' },
      { id: 'xtts-claribel', label: 'Claribel Dervla', source: 'builtin', accent: 'other' }
    ],
    clones: true,
    lab: { firstAudioMs: 115, rtf: 0.111 }
  },
  {
    id: 'vibevoice-realtime',
    kind: 'tts',
    label: 'VibeVoice-Realtime 0.5B',
    license: {
      name: 'MIT (research only)',
      url: 'https://huggingface.co/microsoft/VibeVoice-Realtime-0.5B',
      commercial: false
    },
    sizeMb: 2123,
    vramMb: 3100,
    languages: ['en', 'pt'],
    ptBR: 'experimental',
    streaming: true,
    builtin: [
      { id: 'pt-Spk0_woman', label: 'Mulher (pt)', source: 'builtin', accent: 'pt-BR' },
      { id: 'pt-Spk1_man', label: 'Homem (pt)', source: 'builtin', accent: 'pt-BR' }
    ],
    clones: false,
    lab: { firstAudioMs: 23, rtf: 0.147 }
  },
  {
    id: 'qwen3-tts-0.6b',
    kind: 'tts',
    label: 'Qwen3-TTS 0.6B',
    license: {
      name: 'Apache-2.0',
      url: 'https://huggingface.co/Qwen/Qwen3-TTS-12Hz-0.6B-Base',
      commercial: true
    },
    sizeMb: 2549,
    vramMb: 2700,
    languages: ['pt', 'en', 'zh', 'es', 'ja', 'ko'],
    ptBR: 'pt-PT-accent',
    streaming: true,
    builtin: [],
    clones: true,
    lab: { firstAudioMs: 170, rtf: 0.419 }
  },
  {
    id: 'qwen3-tts-1.7b',
    kind: 'tts',
    label: 'Qwen3-TTS 1.7B',
    license: {
      name: 'Apache-2.0',
      url: 'https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-Base',
      commercial: true
    },
    sizeMb: 4300,
    vramMb: 7100,
    languages: ['pt', 'en', 'zh', 'es', 'ja', 'ko'],
    ptBR: 'pt-PT-accent',
    streaming: true,
    builtin: [],
    clones: true,
    lab: { firstAudioMs: 186, rtf: 0.433 }
  },
  {
    id: 'whisper-large-v3-turbo',
    kind: 'stt',
    label: 'Whisper large-v3-turbo',
    license: {
      name: 'MIT',
      url: 'https://huggingface.co/openai/whisper-large-v3-turbo',
      commercial: true
    },
    sizeMb: 1600,
    vramMb: 1500,
    languages: ['pt', 'mul'],
    ptBR: 'native',
    streaming: false,
    builtin: [],
    clones: false,
    lab: { firstAudioMs: 102, rtf: 0.02 }
  }
]

/** Grupo de processo de cada motor (como o backend: um processo por grupo). */
const GROUP: Record<GpuEngineId, string> = {
  omnivoice: 'omni',
  'xtts-v2': 'xtts',
  'vibevoice-realtime': 'vibe',
  'qwen3-tts-0.6b': 'qwen',
  'qwen3-tts-1.7b': 'qwen',
  'whisper-large-v3-turbo': 'base'
}
const CTX_MB = 300

const RTX: GpuInfo = {
  vendor: 'nvidia',
  name: 'NVIDIA GeForce RTX 3080 Ti',
  vramTotalMb: 12288,
  vramFreeMb: 9420,
  driver: '615.78.08',
  cudaMax: '13.4',
  computeCap: '8.6'
}

/** As referências CC0 pt-BR do backend (`GPU_CC0_VOICES`; Faber é a padrão). */
const CC0_VOICES: GpuVoice[] = GPU_CC0_VOICES.map((c) => ({
  id: c.id,
  label: c.name,
  source: 'cc0' as const,
  accent: 'pt-BR' as const
}))

/** Compatibilidade do motor por cenário (as regras que o backend aplicaria). */
function compatFor(
  spec: EngineSpec,
  scenario: string,
  gpu: GpuInfo | null,
  vram: { loaded: boolean; reclaimMb: number } = { loaded: false, reclaimMb: 0 }
): GpuCompat {
  if (scenario === 'gpu-incompatible')
    return {
      level: 'blocked',
      reasons: [
        'GPU Kepler (CUDA até 9.1): os motores precisam de CUDA 12 — uma GPU NVIDIA de 2016+ (Pascal ou mais nova)'
      ]
    }
  if (scenario === 'gpu-mac') {
    if (spec.kind === 'stt')
      return {
        level: 'warn',
        reasons: ['faster-whisper não usa o Metal: roda na CPU (~1 s por frase)']
      }
    return {
      level: 'warn',
      reasons: ['Apple Silicon (MPS): suporte experimental — 2–4× mais lento que numa GPU NVIDIA']
    }
  }
  if (!gpu || gpu.vendor !== 'nvidia')
    return {
      level: 'warn',
      reasons: [
        spec.kind === 'stt'
          ? 'sem GPU NVIDIA: roda na CPU (~1–2 s por frase)'
          : 'sem GPU NVIDIA: roda na CPU — vários segundos até o 1º áudio, lento para chamada'
      ]
    }
  const total = gpu.vramTotalMb ?? 0
  // a VRAM do próprio servidor do app não conta (o app libera ao trocar); carregado nunca avisa
  const free = (gpu.vramFreeMb ?? total) + vram.reclaimMb
  const gb = (mb: number): string => `${(mb / 1024).toFixed(1).replace('.', ',')} GB`
  if (spec.vramMb > total)
    return {
      level: 'blocked',
      reasons: [`precisa de ~${gb(spec.vramMb)} de VRAM; sua GPU tem ${gb(total)}`]
    }
  if (!vram.loaded && spec.vramMb > free)
    return {
      level: 'warn',
      reasons: [
        `precisa de ~${gb(spec.vramMb)} de VRAM; há ${gb(free)} livres agora — pode faltar memória com outros apps abertos`
      ]
    }
  return { level: 'ok', reasons: [] }
}

export function createMockGpu(
  scenario: string,
  delay: Delay
): {
  api: VoiceGpuApi
  onProgress: (cb: (s: GpuStatus) => void) => () => void
  /** O que o main faz no `voice:call:start` com GPU: já quente? / sobe + aquece com fases. */
  isWarm: (ids: readonly GpuEngineId[]) => boolean
  warm: (ids: readonly GpuEngineId[], onPhase?: (t: string) => void) => Promise<void>
} {
  const listeners = new Set<(s: GpuStatus) => void>()
  const gpus: GpuInfo[] =
    scenario === 'gpu-none'
      ? [
          {
            vendor: 'intel',
            name: 'Intel UHD Graphics 630',
            vramTotalMb: null,
            vramFreeMb: null,
            driver: 'Mesa 26.1',
            cudaMax: null
          }
        ]
      : scenario === 'gpu-lowvram'
        ? [
            {
              vendor: 'nvidia',
              name: 'NVIDIA GeForce GTX 1650',
              vramTotalMb: 4096,
              vramFreeMb: 3480,
              driver: '580.95.05',
              cudaMax: '13.0'
            }
          ]
        : scenario === 'gpu-mac'
          ? [
              {
                vendor: 'apple',
                name: 'Apple M2 Pro',
                vramTotalMb: null,
                vramFreeMb: null,
                driver: null,
                cudaMax: null
              }
            ]
          : scenario === 'gpu-incompatible'
            ? [
                {
                  vendor: 'nvidia',
                  name: 'NVIDIA GeForce GTX 760',
                  vramTotalMb: 2048,
                  vramFreeMb: 1710,
                  driver: '391.35',
                  cudaMax: '9.1'
                }
              ]
            : scenario === 'gpu-call-lowvram'
              ? [{ ...RTX, vramFreeMb: 2150 }]
              : [{ ...RTX }]
  const nvidia = gpus.find((g) => g.vendor === 'nvidia') ?? null
  /** VRAM livre com o servidor do app DESLIGADO (o status desconta o que ele ocupa). */
  const freeIdle = scenario === 'gpu-own-vram' ? 9000 : (nvidia?.vramFreeMb ?? null)
  const callScenario = scenario.startsWith('gpu-call')
  const ownScenario = scenario === 'gpu-own-vram'
  const installed = scenario === 'gpu-installed' || callScenario || ownScenario
  const cc0 = installed
  const userVoices: GpuVoice[] = []
  let voiceSeq = 0

  const engines: GpuEngineStatus[] = ENGINES.map((spec) => ({
    id: spec.id,
    kind: spec.kind,
    label: spec.label,
    license: spec.license,
    sizeMb: spec.sizeMb,
    vramMb: spec.vramMb,
    languages: spec.languages,
    ptBR: spec.ptBR,
    streaming: spec.streaming,
    voices: [...spec.builtin, ...(spec.clones && cc0 ? CC0_VOICES.slice(0, 1) : [])],
    install: {
      state:
        installed &&
        (spec.id === 'omnivoice' ||
          spec.id === 'whisper-large-v3-turbo' ||
          (ownScenario && spec.id === 'xtts-v2'))
          ? 'installed'
          : 'absent'
    },
    compat: compatFor(spec, scenario, nvidia ?? gpus[0] ?? null),
    ...(installed && spec.id !== 'qwen3-tts-1.7b'
      ? { measured: { ...spec.lab, at: '2026-10-23T14:12:00.000Z', wer: 0 } }
      : {}),
    ...(spec.id === 'omnivoice' ? { options: { steps: 16 } } : {})
  }))

  const status: GpuStatus = {
    platform: {
      os: scenario === 'gpu-mac' ? 'darwin' : scenario === 'gpu-incompatible' ? 'win32' : 'linux',
      arch: scenario === 'gpu-mac' ? 'arm64' : 'x64',
      diskFreeMb: scenario === 'gpu-lowvram' ? 9200 : 214_000
    },
    gpus,
    runtime: {
      state: installed ? 'installed' : scenario === 'gpu-broken' ? 'broken' : 'absent',
      version: installed || scenario === 'gpu-broken' ? 'torch 2.8.0+cu128 · py3.11' : null,
      sizeMb: installed ? 7700 : 7680,
      error:
        scenario === 'gpu-broken'
          ? 'import torch falhou: libcudnn.so.9 não encontrada\nTraceback (most recent call last):\n  File "<string>", line 1, in <module>\nImportError: libcudnn.so.9: cannot open shared object file'
          : null,
      ...(scenario === 'gpu-incompatible'
        ? {
            compat: {
              level: 'blocked' as const,
              reasons: ['GPU Kepler sem CUDA 12 — o PyTorch do runtime não roda nesta placa']
            }
          }
        : {})
    },
    engines,
    server:
      installed && !callScenario
        ? { state: 'running', engines: ['omnivoice', 'whisper-large-v3-turbo'] }
        : { state: 'stopped', engines: [] }
  }

  /** VRAM como o backend calcula: a do servidor do app à parte; carregado não avisa. */
  const refreshVram = (): void => {
    const nv = status.gpus.find((g) => g.vendor === 'nvidia')
    const running = status.server.state === 'running' ? status.server.engines : []
    const specOf = (id: string): EngineSpec | undefined => ENGINES.find((x) => x.id === id)
    const own = running.length
      ? running.reduce((n, id) => n + (specOf(id)?.vramMb ?? 0), CTX_MB)
      : 0
    const procGroup =
      running.map((id) => GROUP[id as GpuEngineId]).find((g) => g && g !== 'base') ?? 'base'
    if (nv && freeIdle != null) {
      nv.vramFreeMb = Math.max(0, freeIdle - own)
      nv.vramOwnMb = own || null
    }
    for (const e of status.engines) {
      const spec = specOf(e.id)!
      const loaded = running.includes(e.id)
      const reclaimMb = spec.kind === 'tts' && running.length && procGroup !== GROUP[e.id] ? own : 0
      const releases = reclaimMb
        ? running.map((id) => specOf(id)?.label ?? id).filter((l) => l !== spec.label)
        : []
      e.vram = {
        loaded,
        availMb: nv?.vramFreeMb != null ? nv.vramFreeMb + reclaimMb : null,
        releases
      }
      e.compat = compatFor(spec, scenario, nv ?? gpus[0] ?? null, { loaded, reclaimMb })
    }
  }

  const snapshot = (): GpuStatus => {
    refreshVram()
    return structuredClone(status)
  }
  const emit = (): void => {
    const s = snapshot()
    listeners.forEach((l) => l(s))
  }
  const eng = (id: GpuEngineId): GpuEngineStatus => {
    const e = status.engines.find((x) => x.id === id)
    if (!e) throw new Error(`motor desconhecido: ${String(id)}`)
    return e
  }
  const syncVoices = (): void => {
    for (const e of status.engines) {
      const spec = ENGINES.find((s) => s.id === e.id)!
      if (!spec.clones) continue
      e.voices = [
        ...spec.builtin,
        ...CC0_VOICES.filter((v) => cc0Downloaded.has(v.id)),
        // Qwen só lista as vozes com transcrição (precisa do texto da referência)
        ...userVoices.filter((v) => !e.id.startsWith('qwen') || transcripts.has(v.id))
      ]
    }
  }
  const cc0Downloaded = new Set<string>(cc0 ? [CC0_VOICES[0].id] : [])
  const transcripts = new Set<string>()

  /** Tarefa simulada em andamento (uma por vez, como o backend). */
  let job: { cancel: () => void } | null = null

  /** Roda fases com progresso; resolve true ao terminar, false se cancelada. */
  const runJob = (
    phases: { phase: string; steps: number }[],
    onStep: (phase: string, pct: number, bytes: number) => void,
    stepMs: number,
    totalBytes: number
  ): Promise<boolean> =>
    new Promise((resolve) => {
      const total = phases.reduce((n, p) => n + p.steps, 0)
      let i = 0
      const timer = setInterval(() => {
        i++
        let acc = 0
        let phase = phases[phases.length - 1].phase
        for (const p of phases) {
          if (i <= acc + p.steps) {
            phase = p.phase
            break
          }
          acc += p.steps
        }
        const pct = Math.min(100, Math.round((i / total) * 100))
        onStep(phase, pct, Math.round((totalBytes * i) / total))
        emit()
        if (i >= total) {
          clearInterval(timer)
          job = null
          resolve(true)
        }
      }, stepMs)
      job = {
        cancel: () => {
          clearInterval(timer)
          job = null
          resolve(false)
        }
      }
    })

  const installRuntime = async (): Promise<void> => {
    if (job) throw new Error('já há uma instalação em andamento')
    if (status.runtime.compat?.level === 'blocked')
      throw new Error(status.runtime.compat.reasons[0])
    status.runtime = {
      ...status.runtime,
      state: 'installing',
      error: null,
      progress: { phase: 'preparando…', pct: 0 }
    }
    emit()
    const mb = status.runtime.sizeMb ?? 7680
    const slow = scenario === 'gpu-installing'
    const ok = await runJob(
      [
        { phase: 'Baixando o Python portátil', steps: 3 },
        { phase: 'Instalando o PyTorch (CUDA 12.8, ~3 GB)', steps: slow ? 400 : 12 },
        { phase: 'Instalando a base (servidor local e bibliotecas de áudio)', steps: 6 },
        { phase: 'Verificando o runtime', steps: 3 }
      ],
      (phase, pct, bytes) => {
        status.runtime.progress = { phase, pct, bytes }
      },
      slow ? 250 : 120,
      mb * 1048576
    )
    status.runtime = ok
      ? {
          ...status.runtime,
          state: 'installed',
          version: 'torch 2.8.0+cu128 · py3.11',
          progress: undefined,
          sizeMb: 7700
        }
      : { ...status.runtime, state: 'absent', progress: undefined }
    emit()
    return
  }

  const installEngine = async (id: GpuEngineId): Promise<void> => {
    const e = eng(id)
    if (job) throw new Error('já há uma instalação em andamento')
    // como o backend: instalar um motor sem o runtime instala o runtime antes
    if (e.compat.level === 'blocked') throw new Error(e.compat.reasons[0] ?? 'incompatível')
    if (status.runtime.state !== 'installed') {
      await installRuntime()
      if ((status.runtime.state as string) !== 'installed') return
    }
    e.install = { state: 'installing', progress: { phase: 'preparando…', pct: 0 } }
    emit()
    const ok = await runJob(
      [
        { phase: `baixando os pesos de ${e.label} (Hugging Face)`, steps: 12 },
        { phase: 'conferindo sha256', steps: 2 },
        { phase: 'carregando na GPU para testar', steps: 2 }
      ],
      (phase, pct) => {
        e.install = { state: 'installing', progress: { phase, pct } }
      },
      110,
      e.sizeMb * 1048576
    )
    e.install = { state: ok ? 'installed' : 'absent' }
    if (ok && e.id.startsWith('qwen')) {
      cc0Downloaded.add(CC0_VOICES[0].id)
      syncVoices()
    }
    emit()
    return
  }

  const api: VoiceGpuApi = {
    status: () => delay(snapshot(), 120),
    installRuntime,
    removeRuntime: async () => {
      await delay(undefined, 200)
      status.runtime = {
        ...status.runtime,
        state: 'absent',
        version: null,
        error: null,
        sizeMb: 7680
      }
      for (const e of status.engines) e.install = { state: 'absent' }
      status.server = { state: 'stopped', engines: [] }
      emit()
      return
    },
    installEngine,
    removeEngine: async (id) => {
      await delay(undefined, 200)
      eng(id).install = { state: 'absent' }
      status.server.engines = status.server.engines.filter((x) => x !== id)
      emit()
      return
    },
    cancel: async () => {
      job?.cancel()
      await delay(undefined, 50)
    },
    selfTest: async (id) => {
      const spec = ENGINES.find((s) => s.id === id)!
      const e = eng(id)
      if (e.install.state !== 'installed') throw new Error(`${e.label} não está instalado`)
      await delay(undefined, 700)
      e.measured = { ...spec.lab, at: new Date().toISOString() }
      if (status.server.state !== 'running' || !status.server.engines.includes(id))
        status.server = {
          state: 'running',
          engines: [...new Set([...status.server.engines, id])]
        }
      emit()
      return { firstAudioMs: spec.lab.firstAudioMs, rtf: spec.lab.rtf, wer: 0 }
    },
    startServer: async (ids) => warm(ids?.length ? (ids as GpuEngineId[]) : installedIds()),
    stopServer: async () => {
      await delay(undefined, 200)
      status.server = { state: 'stopped', engines: [] }
      emit()
      return
    },
    addUserVoice: async (input) => {
      if (!input?.name?.trim()) throw new Error('dê um nome à voz')
      if (!(input.audio instanceof ArrayBuffer) || input.audio.byteLength < 44)
        throw new Error('áudio inválido')
      await delay(undefined, 300)
      const id = `user-${++voiceSeq}`
      userVoices.push({ id, label: input.name.trim(), source: 'user', accent: 'pt-BR' })
      if (input.transcript?.trim()) transcripts.add(id)
      syncVoices()
      emit()
      return { id }
    },
    removeUserVoice: async (id) => {
      await delay(undefined, 150)
      const i = userVoices.findIndex((v) => v.id === id)
      if (i >= 0) userVoices.splice(i, 1)
      transcripts.delete(id)
      syncVoices()
      emit()
      return
    },
    downloadCc0Voice: async (input) => {
      const id = input?.id ?? CC0_VOICES[0].id
      if (!CC0_VOICES.some((v) => v.id === id)) throw new Error(`voz CC0 desconhecida: ${id}`)
      await delay(undefined, 600)
      cc0Downloaded.add(id)
      syncVoices()
      emit()
      return { id }
    },
    transcribe: async (input) => {
      if (!(input?.audio instanceof ArrayBuffer)) throw new Error('áudio inválido')
      await delay(undefined, 500)
      return { text: 'Olá! Esta é a minha voz para o ClearChat.' }
    },
    log: async () =>
      delay(
        [
          '[runtime] uv 0.9.4 · python 3.11.17',
          '[runtime] torch 2.8.0+cu128',
          '[probe] nvidia-smi: driver 615.78.08 · CUDA 13.4',
          status.runtime.error
            ? `[erro] ${status.runtime.error.split('\n')[0]}`
            : '[ok] torch.cuda.is_available() = True'
        ].join('\n'),
        150
      )
  }

  /** Liga o servidor "sozinho" com estes motores (fases como o backend: iniciando → aquecendo). */
  function installedIds(): GpuEngineId[] {
    return status.engines.filter((e) => e.install.state === 'installed').map((e) => e.id)
  }
  const isWarm = (ids: readonly GpuEngineId[]): boolean =>
    status.server.state === 'running' && ids.every((id) => status.server.engines.includes(id))
  async function warm(ids: readonly GpuEngineId[], onPhase?: (t: string) => void): Promise<void> {
    if (isWarm(ids)) return
    const names = gpuEnginesLabel(ids)
    const phase = (t: string): void => {
      status.server = { ...status.server, state: 'starting', phase: t }
      onPhase?.(t)
      emit()
    }
    phase(`Iniciando ${names}…`)
    await delay(undefined, 700)
    phase(`Aquecendo ${names}…`)
    await delay(undefined, 900)
    if (scenario === 'gpu-call-oom') {
      status.server = {
        state: 'error',
        engines: [],
        error: 'GPU sem memória (CUDA out of memory) ao carregar OmniVoice',
        phase: null
      }
      emit()
      throw new Error('OmniVoice não carregou na GPU: GPU sem memória (CUDA out of memory)')
    }
    status.server = {
      state: 'running',
      engines: [...new Set([...status.server.engines, ...ids])],
      phase: null
    }
    emit()
  }

  // ?scenario=gpu-installing: o runtime já está baixando ao abrir
  if (scenario === 'gpu-installing') void installRuntime()

  return {
    api,
    isWarm,
    warm,
    onProgress: (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    }
  }
}
