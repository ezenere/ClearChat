// "Modo avançado (GPU local)" — contrato compartilhado main ↔ renderer: tipos do status
// (`window.api.voice.gpu.status()` / evento `voice:gpu:progress`), catálogo dos motores (tamanhos,
// VRAM, licença, pt-BR) e as REGRAS de compatibilidade de hardware (puras, testadas em
// `e2e/gpuVoice.test.ts`). Os nomes espelham `src/renderer/src/lib/voice/gpu/types.ts` (o espelho
// local da UI). Nada aqui toca disco/rede. Ver SPEC.md → "Áudio → Modo avançado (GPU local)".

export type GpuEngineId =
  | 'omnivoice'
  | 'xtts-v2'
  | 'vibevoice-realtime'
  | 'qwen3-tts-0.6b'
  | 'qwen3-tts-1.7b'
  | 'whisper-large-v3-turbo'

export type GpuTtsEngineId = Exclude<GpuEngineId, 'whisper-large-v3-turbo'>

export const GPU_STT_ENGINE_ID = 'whisper-large-v3-turbo' as const
export const GPU_TTS_ENGINE_IDS: readonly GpuTtsEngineId[] = [
  'omnivoice',
  'xtts-v2',
  'vibevoice-realtime',
  'qwen3-tts-0.6b',
  'qwen3-tts-1.7b'
]
export const GPU_ENGINE_IDS: readonly GpuEngineId[] = [...GPU_TTS_ENGINE_IDS, GPU_STT_ENGINE_ID]

export const isGpuEngineId = (v: unknown): v is GpuEngineId =>
  typeof v === 'string' && (GPU_ENGINE_IDS as readonly string[]).includes(v)
export const isGpuTtsEngineId = (v: unknown): v is GpuTtsEngineId =>
  typeof v === 'string' && (GPU_TTS_ENGINE_IDS as readonly string[]).includes(v)

export type GpuInstallState = 'absent' | 'installing' | 'installed' | 'broken'
export type GpuCompatLevel = 'ok' | 'warn' | 'blocked'

export interface GpuCompat {
  level: GpuCompatLevel
  /** Motivos legíveis (pt-BR), um por item (avisos de qualidade do pt-BR entram aqui também). */
  reasons: string[]
}

export interface GpuVoice {
  id: string
  label: string
  source: 'builtin' | 'cc0' | 'user'
  accent?: 'pt-BR' | 'pt-PT' | 'other'
}

export interface GpuProgress {
  phase: string
  pct: number | null
  bytes?: number
}

export interface GpuEngineStatus {
  id: GpuEngineId
  kind: 'tts' | 'stt'
  label: string
  license: { name: string; url: string; commercial: boolean }
  /** Download (pesos + camada de pacotes do motor), em MB. */
  sizeMb: number
  /** VRAM do processo medida no laboratório (contexto CUDA incluso), em MB. */
  vramMb: number
  languages: string[]
  ptBR: 'native' | 'ok' | 'pt-PT-accent' | 'experimental'
  streaming: boolean
  voices: GpuVoice[]
  install: { state: GpuInstallState; progress?: GpuProgress; error?: string | null }
  compat: GpuCompat
  /** Último autoteste NESTA máquina (pelo caminho de áudio do app). */
  measured?: { firstAudioMs: number; rtf: number; at: string; wer?: number }
  /** OmniVoice: passos de difusão (padrão 16). */
  options?: { steps?: number }
}

export interface GpuInfo {
  vendor: 'nvidia' | 'amd' | 'apple' | 'intel' | 'other'
  name: string
  vramTotalMb: number | null
  vramFreeMb: number | null
  driver: string | null
  /** CUDA máximo que o driver aceita (cabeçalho do nvidia-smi). */
  cudaMax: string | null
  /** Compute capability (ex.: '8.6'), quando o nvidia-smi informa. Aditivo. */
  computeCap?: string | null
}

export interface GpuStatus {
  platform: { os: 'linux' | 'darwin' | 'win32'; arch: string; diskFreeMb: number }
  gpus: GpuInfo[]
  runtime: {
    state: GpuInstallState
    version: string | null
    sizeMb: number | null
    progress?: GpuProgress
    error?: string | null
    /** Veredito do próprio runtime neste sistema (bloqueado = não instala). Aditivo. */
    compat?: GpuCompat
  }
  engines: GpuEngineStatus[]
  server: {
    state: 'stopped' | 'starting' | 'running' | 'error'
    engines: string[]
    error?: string | null
    /**
     * O que o servidor está fazendo agora (subida sob demanda: "Iniciando OmniVoice…",
     * "Aquecendo OmniVoice + Whisper…"); null/ausente = nada em andamento. Aditivo.
     */
    phase?: string | null
  }
}

export interface GpuSelfTestResult {
  firstAudioMs: number
  rtf: number
  wer?: number
}

/** Config da fala pela GPU (`ttsSettings.gpu`). */
export interface TtsGpuConfig {
  engine: GpuTtsEngineId
  /** Voz do motor (builtin/cc0/user); null = a padrão do motor. */
  voice: string | null
  /** Só OmniVoice: passos de difusão (16 padrão; 32 = mais qualidade, mais lento). */
  steps?: number
}

/** Config da transcrição pela GPU (`sttSettings.gpu`). */
export interface SttGpuConfig {
  engine: 'whisper-large-v3-turbo'
}

export const OMNIVOICE_DEFAULT_STEPS = 16
export const DEFAULT_TTS_GPU: TtsGpuConfig = { engine: 'omnivoice', voice: null }
export const DEFAULT_STT_GPU: SttGpuConfig = { engine: GPU_STT_ENGINE_ID }

/** Passos válidos do OmniVoice (4–64; inválido → ausente = 16). */
export function normalizeOmniSteps(v: unknown): number | undefined {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : NaN
  return Number.isNaN(n) ? undefined : Math.max(4, Math.min(64, n))
}

// ---------------- catálogo ----------------

/** Camada de pacotes (venv sobre o runtime base) de cada motor — conflitos de `transformers`. */
export type GpuEngineGroup = 'base' | 'xtts' | 'qwen' | 'omni' | 'vibe'

export interface GpuEngineCatalogEntry {
  id: GpuEngineId
  kind: 'tts' | 'stt'
  label: string
  group: GpuEngineGroup
  license: { name: string; url: string; commercial: boolean }
  /** Pesos baixados (MB, publicados pelo HF nas revisões fixadas). */
  weightsMb: number
  /** Camada de pacotes do grupo instalada (MB, medida) — 0 no grupo base. */
  layerMb: number
  vramMb: number
  languages: string[]
  ptBR: GpuEngineStatus['ptBR']
  streaming: boolean
  /** Clona voz de referência (CC0/do usuário). */
  clones: boolean
  /** A clonagem precisa da transcrição da referência (ICL). */
  needsTranscript: boolean
  builtinVoices: GpuVoice[]
  /** Notas de qualidade (pt-BR) — sempre em `compat.reasons`. */
  notes: string[]
  /** Nota extra no macOS (Apple Silicon): `blocked` impede, `warn` só avisa. */
  mac: { level: 'warn' | 'blocked'; reason: string }
}

const NC = false
export const GPU_ENGINE_CATALOG: readonly GpuEngineCatalogEntry[] = [
  {
    id: 'omnivoice',
    kind: 'tts',
    label: 'OmniVoice (k2-fsa)',
    group: 'omni',
    license: {
      name: 'código Apache-2.0 · pesos CC BY-NC 4.0 (não comercial)',
      url: 'https://huggingface.co/k2-fsa/OmniVoice',
      commercial: NC
    },
    weightsMb: 3116,
    layerMb: 200,
    vramMb: 5100,
    languages: ['pt', 'pt-BR', 'en', 'mul'],
    ptBR: 'native',
    streaming: false,
    clones: true,
    needsTranscript: true,
    builtinVoices: [
      { id: 'omni-feminina', label: 'Feminina (desenho de voz)', source: 'builtin' },
      { id: 'omni-masculina', label: 'Masculina (desenho de voz)', source: 'builtin' }
    ],
    notes: [
      'Sem streaming: sintetiza frase a frase (~0,4 s por frase com 16 passos nesta classe de GPU).'
    ],
    mac: {
      level: 'warn',
      reason: 'No Mac (MPS) é experimental e bem mais lento que numa GPU NVIDIA.'
    }
  },
  {
    id: 'xtts-v2',
    kind: 'tts',
    label: 'XTTS-v2 (Coqui)',
    group: 'xtts',
    license: {
      name: 'Coqui Public Model License (CPML, não comercial) · código MPL-2.0',
      url: 'https://huggingface.co/tts-hub/XTTS-v2/blob/main/LICENSE.txt',
      commercial: NC
    },
    weightsMb: 1790,
    layerMb: 340,
    vramMb: 3700,
    languages: ['pt', 'pt-BR', 'en', 'es', 'fr', 'de', 'it', 'mul'],
    ptBR: 'native',
    streaming: true,
    clones: true,
    needsTranscript: false,
    builtinVoices: [
      {
        id: 'xtts-ana-florence',
        label: 'Ana Florence (estúdio)',
        source: 'builtin',
        accent: 'other'
      },
      { id: 'xtts-alma-maria', label: 'Alma María (estúdio)', source: 'builtin', accent: 'other' },
      {
        id: 'xtts-claribel-dervla',
        label: 'Claribel Dervla (estúdio)',
        source: 'builtin',
        accent: 'other'
      },
      {
        id: 'xtts-gilberto-mathias',
        label: 'Gilberto Mathias (estúdio)',
        source: 'builtin',
        accent: 'other'
      },
      { id: 'xtts-luis-moray', label: 'Luis Moray (estúdio)', source: 'builtin', accent: 'other' },
      {
        id: 'xtts-marcos-rudaski',
        label: 'Marcos Rudaski (estúdio)',
        source: 'builtin',
        accent: 'other'
      }
    ],
    notes: [
      'As vozes de estúdio do XTTS não são brasileiras (sotaque não verificado em pt); para pt-BR use a voz CC0 ou a sua.'
    ],
    mac: {
      level: 'warn',
      reason: 'No Mac (MPS) é experimental e bem mais lento que numa GPU NVIDIA.'
    }
  },
  {
    id: 'vibevoice-realtime',
    kind: 'tts',
    label: 'VibeVoice-Realtime 0.5B (Microsoft)',
    group: 'vibe',
    license: {
      name: 'MIT · model card: uso de pesquisa, não recomendado para produto',
      url: 'https://huggingface.co/microsoft/VibeVoice-Realtime-0.5B',
      commercial: NC
    },
    weightsMb: 1958,
    layerMb: 230,
    vramMb: 3100,
    languages: ['en', 'pt'],
    ptBR: 'experimental',
    streaming: true,
    clones: false,
    needsTranscript: false,
    builtinVoices: [
      { id: 'vibe-pt-woman', label: 'Mulher (embutida, pt)', source: 'builtin', accent: 'pt-BR' },
      { id: 'vibe-pt-man', label: 'Homem (embutida, pt)', source: 'builtin', accent: 'pt-BR' }
    ],
    notes: [
      'Português experimental (modelo treinado para inglês): pronúncia irregular em frases curtas e ~0,2–0,5 s de silêncio no começo; sem clonagem — só as vozes embutidas.'
    ],
    mac: {
      level: 'warn',
      reason: 'No Mac (MPS) é experimental e bem mais lento que numa GPU NVIDIA.'
    }
  },
  {
    id: 'qwen3-tts-0.6b',
    kind: 'tts',
    label: 'Qwen3-TTS 0.6B',
    group: 'qwen',
    license: {
      name: 'Apache-2.0',
      url: 'https://huggingface.co/Qwen/Qwen3-TTS-12Hz-0.6B-Base',
      commercial: true
    },
    weightsMb: 2400,
    layerMb: 150,
    vramMb: 2700,
    languages: ['pt', 'en', 'zh', 'es', 'fr', 'de', 'it', 'ja', 'ko', 'ru'],
    ptBR: 'pt-PT-accent',
    streaming: true,
    clones: true,
    needsTranscript: true,
    builtinVoices: [],
    notes: [
      'Só clona (sem vozes prontas neste checkpoint): sem uma referência brasileira o sotaque tende ao de Portugal — use a voz CC0 pt-BR ou a sua (com a transcrição).',
      'RTF ~0,4 (≈2,4× tempo real): pouca folga se a GPU estiver dividida.'
    ],
    mac: {
      level: 'warn',
      reason: 'No Mac (MPS) é experimental e bem mais lento que numa GPU NVIDIA.'
    }
  },
  {
    id: 'qwen3-tts-1.7b',
    kind: 'tts',
    label: 'Qwen3-TTS 1.7B',
    group: 'qwen',
    license: {
      name: 'Apache-2.0',
      url: 'https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-Base',
      commercial: true
    },
    weightsMb: 4334,
    layerMb: 150,
    vramMb: 7100,
    languages: ['pt', 'en', 'zh', 'es', 'fr', 'de', 'it', 'ja', 'ko', 'ru'],
    ptBR: 'pt-PT-accent',
    streaming: true,
    clones: true,
    needsTranscript: true,
    builtinVoices: [],
    notes: [
      'Só clona (sem vozes prontas neste checkpoint): sem uma referência brasileira o sotaque tende ao de Portugal — use a voz CC0 pt-BR ou a sua (com a transcrição).',
      'No laboratório 1 em 15 sínteses entrou em laço sem fim; o servidor limita o tamanho da geração ao do texto.'
    ],
    mac: {
      level: 'warn',
      reason: 'No Mac (MPS) é experimental e bem mais lento que numa GPU NVIDIA.'
    }
  },
  {
    id: 'whisper-large-v3-turbo',
    kind: 'stt',
    label: 'Whisper large-v3-turbo (faster-whisper, int8)',
    group: 'base',
    license: {
      name: 'MIT',
      url: 'https://huggingface.co/mobiuslabsgmbh/faster-whisper-large-v3-turbo',
      commercial: true
    },
    weightsMb: 1547,
    layerMb: 0,
    vramMb: 1500,
    languages: ['pt', 'pt-BR', 'mul'],
    ptBR: 'native',
    streaming: false,
    clones: false,
    needsTranscript: false,
    builtinVoices: [],
    notes: [],
    mac: {
      level: 'warn',
      reason: 'No Mac roda na CPU (int8, o CTranslate2 não usa a GPU da Apple): ~1–2 s por frase.'
    }
  }
]

export const gpuEngineEntry = (id: GpuEngineId): GpuEngineCatalogEntry =>
  GPU_ENGINE_CATALOG.find((e) => e.id === id)!

/** Nome curto do motor para mensagens ("OmniVoice", "XTTS-v2", "Whisper large-v3-turbo"). */
export const gpuEngineShortLabel = (id: string): string => {
  const e = GPU_ENGINE_CATALOG.find((x) => x.id === id)
  return e ? e.label.replace(/\s*\(.*\)\s*$/, '') : id
}

/** Nomes curtos unidos por " + " ("OmniVoice + Whisper large-v3-turbo"). */
export const gpuEnginesLabel = (ids: readonly string[]): string =>
  ids.map(gpuEngineShortLabel).join(' + ')

/**
 * O servidor local sai sozinho depois deste tempo sem requests (`server.py --idle-exit-s`, padrão
 * 900 s) — devolve a VRAM; a próxima fala/chamada/ditado sobe de novo.
 */
export const GPU_SERVER_IDLE_EXIT_MIN = 15

/** Download total de um motor (pesos + camada do grupo quando ainda não instalada). */
export const gpuEngineSizeMb = (e: GpuEngineCatalogEntry): number => e.weightsMb + e.layerMb

/** Versão do runtime (Python + torch) — muda quando os requisitos mudam (reinstalação). */
export const GPU_RUNTIME_VERSION = 'py3.11.17-torch2.8.0-1'
/** Runtime base instalado (Python + torch + faster-whisper + servidor), em MB — medido. */
export const GPU_RUNTIME_DISK_MB: Record<'cuda' | 'cpu', number> = { cuda: 7700, cpu: 1500 }
/** Folga de disco exigida além do download (temporários do pip/HF). */
export const GPU_DISK_MARGIN_MB = 2048
/** CUDA do runtime (wheels cu128 do PyTorch 2.8). */
export const GPU_CUDA_REQUIRED = '12.8'

// ---------------- voz CC0 pt-BR ----------------

export interface GpuCc0Voice {
  id: string
  name: string
  url: string
  sha256: string
  size: number
  transcript: string
  /** Duração do clipe (s) — RTF do autoteste do whisper. */
  durationS: number
  license: string
  attribution: string
}

/**
 * Referências pt-BR em domínio público (CC0) do dataset Nabu Casa / OHF-Voice (as vozes do Piper
 * pt_BR) — 1º clipe de cada locutor, commit fixado. Licença CC0 declarada no README do repositório.
 */
const OHF =
  'https://raw.githubusercontent.com/OHF-Voice/voice-datasets/8ff029a74869772db4bf3271b40ab5237275c17b/pt_BR'
const OHF_TEXT =
  'Os descontos chegam a setenta e oito por cento e correspondem aos impostos que incidem sobre as mercadorias.'
const OHF_LICENSE = 'CC0 1.0 (domínio público) — github.com/OHF-Voice/voice-datasets'
export const GPU_CC0_VOICES: readonly GpuCc0Voice[] = [
  {
    id: 'cc0-faber',
    name: 'Faber (CC0, pt-BR)',
    url: `${OHF}/faber/0000000001.mp3`,
    sha256: '7c855959fa4013f00b933f016b8cd360bc35f460816868c9ea97017ba9647b8b',
    size: 89440,
    transcript: OHF_TEXT,
    durationS: 7.56,
    license: OHF_LICENSE,
    attribution: 'Nabu Casa / OHF-Voice voice-datasets, locutor "faber" (pt_BR)'
  },
  {
    id: 'cc0-cadu',
    name: 'Cadu (CC0, pt-BR)',
    url: `${OHF}/cadu/0000000001.mp3`,
    sha256: '3ae10ab7b89c99941c2cddeb7b1656a52b1af134c50045e8767baddb3977b4d1',
    size: 112768,
    transcript: OHF_TEXT,
    durationS: 6.98,
    license: OHF_LICENSE,
    attribution: 'Nabu Casa / OHF-Voice voice-datasets, locutor "cadu" (pt_BR)'
  },
  {
    id: 'cc0-jeff',
    name: 'Jeff (CC0, pt-BR)',
    url: `${OHF}/jeff/0000000001.mp3`,
    sha256: '655aa986f0147a1551affd574edde40014f2f0392fe0e38d4a3e31665fc4cc13',
    size: 104320,
    transcript: OHF_TEXT,
    durationS: 6.46,
    license: OHF_LICENSE,
    attribution: 'Nabu Casa / OHF-Voice voice-datasets, locutor "jeff" (pt_BR)'
  }
]

// ---------------- compatibilidade (regras puras) ----------------

/** Sonda de hardware (main, sem Python). */
export interface GpuProbe {
  platform: { os: string; arch: string; diskFreeMb: number }
  gpus: GpuInfo[]
  ramMb: number
}

/** "12.8" → 12.8 (null/lixo → null). */
export function cudaNumber(v: string | null | undefined): number | null {
  const m = /^(\d+)\.(\d+)/.exec(String(v ?? '').trim())
  if (!m) return null
  return Number(m[1]) + Number(m[2]) / (Number(m[2]) >= 10 ? 100 : 10)
}

const gb = (mb: number): string => `${(mb / 1024).toFixed(1).replace('.', ',')} GB`

/** Melhor GPU NVIDIA (mais VRAM) da sonda. */
export function bestNvidia(probe: GpuProbe): GpuInfo | null {
  const nv = probe.gpus.filter((g) => g.vendor === 'nvidia')
  if (!nv.length) return null
  return nv.reduce((a, b) => ((b.vramTotalMb ?? 0) > (a.vramTotalMb ?? 0) ? b : a))
}

/** Onde o runtime vai rodar nesta máquina. */
export type GpuAccel = 'cuda' | 'cuda-old-driver' | 'mps' | 'cpu'

export function gpuAccel(probe: GpuProbe): GpuAccel {
  if (probe.platform.os === 'darwin') return probe.platform.arch === 'arm64' ? 'mps' : 'cpu'
  const nv = bestNvidia(probe)
  if (!nv) return 'cpu'
  const cuda = cudaNumber(nv.cudaMax)
  // driver sem CUDA 12 → as wheels cu128 não acham GPU: torch cai na CPU
  if (cuda !== null && cuda < 12.0) return 'cuda-old-driver'
  return 'cuda'
}

/**
 * Veredito do RUNTIME (Python + torch) neste sistema: plataforma/arquitetura sem wheels do
 * PyTorch → bloqueado; disco insuficiente → bloqueado com o quanto precisa; sem GPU NVIDIA →
 * aviso (CPU, muito lento para chamada) — nunca bloqueia por desempenho.
 */
export function evaluateRuntimeCompat(probe: GpuProbe): GpuCompat {
  const reasons: string[] = []
  let level = 'ok' as GpuCompatLevel
  const warn = (r: string): void => {
    if (level === 'ok') level = 'warn'
    reasons.push(r)
  }
  const block = (r: string): void => {
    level = 'blocked'
    reasons.push(r)
  }
  const { os, arch } = probe.platform
  if (os === 'darwin') {
    if (arch !== 'arm64')
      block(
        'Mac Intel não é suportado: o PyTorch não publica mais pacotes para macOS x86_64 (só Apple Silicon).'
      )
    else
      warn(
        'macOS (Apple Silicon): roda pela GPU da Apple (MPS) em caráter experimental — bem mais lento que numa GPU NVIDIA; não testado.'
      )
  } else if (os === 'linux' || os === 'win32') {
    if (arch !== 'x64' && !(os === 'linux' && arch === 'arm64'))
      block(
        `Arquitetura ${arch} sem pacotes do PyTorch para ${os === 'linux' ? 'Linux' : 'Windows'}.`
      )
    else if (arch === 'arm64')
      warn(
        'Linux ARM64: pacotes do PyTorch existem, mas este modo não foi testado nesta arquitetura.'
      )
  } else {
    block(`Sistema ${os} não suportado.`)
  }
  if (level !== 'blocked' && os !== 'darwin') {
    const nv = bestNvidia(probe)
    const other = probe.gpus.find((g) => g.vendor === 'amd' || g.vendor === 'intel')
    if (!nv) {
      warn(
        `Sem GPU NVIDIA${other ? ` (achei ${other.name} — AMD/Intel não são suportadas)` : ''}: vai rodar na CPU, muito lento para chamada de voz.`
      )
    } else {
      const cuda = cudaNumber(nv.cudaMax)
      if (cuda !== null && cuda < 12.0)
        warn(
          `Driver NVIDIA${nv.driver ? ` ${nv.driver}` : ''} só aceita CUDA ${nv.cudaMax}: o runtime precisa de CUDA ${GPU_CUDA_REQUIRED} — até atualizar o driver (≥ 570) vai rodar na CPU, muito lento.`
        )
      else if (cuda !== null && cuda < 12.8)
        warn(
          `Driver NVIDIA com CUDA ${nv.cudaMax} (o runtime usa ${GPU_CUDA_REQUIRED}): deve funcionar pela compatibilidade do CUDA 12, mas recomendo atualizar o driver (≥ 570).`
        )
      const cc = cudaNumber(nv.computeCap ?? null)
      if (cc !== null && cc < 7.5)
        warn(
          `GPU ${nv.name} (compute ${nv.computeCap}) é anterior à série RTX 20: os pacotes CUDA 12.8 do PyTorch podem não ter kernels para ela — pode cair na CPU.`
        )
    }
  }
  const need = GPU_RUNTIME_DISK_MB[gpuAccel(probe) === 'cuda' ? 'cuda' : 'cpu'] + GPU_DISK_MARGIN_MB
  if (probe.platform.diskFreeMb > 0 && probe.platform.diskFreeMb < need)
    block(
      `Espaço insuficiente: o runtime precisa de ~${gb(need)} livres e há ${gb(probe.platform.diskFreeMb)}.`
    )
  return { level, reasons }
}

/**
 * Veredito de UM motor: herda os bloqueios do runtime; disco para o motor (+ runtime se ainda não
 * instalado); VRAM total/livre da melhor NVIDIA (pouca → aviso); CPU/MPS → aviso; notas de pt-BR
 * sempre nos motivos (VibeVoice experimental → aviso).
 */
export function evaluateEngineCompat(
  entry: GpuEngineCatalogEntry,
  probe: GpuProbe,
  opts: { runtimeInstalled: boolean; layerInstalled: boolean; installed: boolean }
): GpuCompat {
  const rt = evaluateRuntimeCompat(probe)
  const reasons: string[] = []
  let level = 'ok' as GpuCompatLevel
  const warn = (r: string): void => {
    if (level === 'ok') level = 'warn'
    reasons.push(r)
  }
  if (rt.level === 'blocked') {
    // só os bloqueios de plataforma (o de disco do runtime é recalculado abaixo com o motor)
    const plat = rt.reasons.filter((r) => !r.startsWith('Espaço insuficiente'))
    if (plat.length) return { level: 'blocked', reasons: plat }
  }
  const accel = gpuAccel(probe)
  if (accel === 'mps') warn(entry.mac.reason)
  if (accel === 'mps' && entry.mac.level === 'blocked') level = 'blocked'
  if (accel === 'cpu' && probe.platform.os !== 'darwin')
    warn('Sem GPU NVIDIA utilizável: vai rodar na CPU — muito lento para chamada de voz.')
  if (accel === 'cuda-old-driver')
    warn('Driver NVIDIA antigo demais para CUDA 12.8: vai rodar na CPU até atualizar o driver.')
  if (accel === 'cuda') {
    const nv = bestNvidia(probe)!
    if (nv.vramTotalMb !== null && nv.vramTotalMb < entry.vramMb)
      warn(
        `A GPU tem ${gb(nv.vramTotalMb)} de VRAM e este motor usa ~${gb(entry.vramMb)}: não cabe — vai faltar memória (ou rodar muito devagar).`
      )
    else if (nv.vramFreeMb !== null && nv.vramFreeMb < entry.vramMb)
      warn(
        `VRAM livre agora: ${gb(nv.vramFreeMb)} (este motor usa ~${gb(entry.vramMb)}) — feche programas que usam a GPU antes da chamada.`
      )
  }
  if (!opts.installed) {
    const need =
      entry.weightsMb +
      (opts.layerInstalled ? 0 : entry.layerMb) +
      (opts.runtimeInstalled ? 0 : GPU_RUNTIME_DISK_MB[accel === 'cuda' ? 'cuda' : 'cpu']) +
      GPU_DISK_MARGIN_MB
    if (probe.platform.diskFreeMb > 0 && probe.platform.diskFreeMb < need)
      return {
        level: 'blocked',
        reasons: [
          `Espaço insuficiente: precisa de ~${gb(need)} livres${opts.runtimeInstalled ? '' : ' (com o runtime)'} e há ${gb(probe.platform.diskFreeMb)}.`,
          ...reasons
        ]
      }
  }
  if (entry.ptBR === 'experimental') warn(entry.notes[0] ?? 'Português experimental.')
  for (const n of entry.notes) if (!reasons.includes(n)) reasons.push(n)
  return { level, reasons }
}
