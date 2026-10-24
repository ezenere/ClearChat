// "Modo avançado (GPU local)" — layout em disco (tudo sob o userData, nada no pacote do app) e o
// Python portátil fixado por plataforma (python-build-standalone, URL + sha256).
//
//   <userData>/gpu-runtime/
//     python/              Python 3.11 portátil + torch + base (faster-whisper, servidor, áudio)
//     layers/<grupo>/      venv `--system-site-packages` por motor (xtts/qwen/omni/vibe — conflitos
//                          de transformers: 4.57.3 / 4.57.3 / 5.20.2 / 4.51.3)
//     hf/                  HF_HOME (pesos nas revisões fixadas)
//     assets/              arquivos extras dos motores (vozes embutidas do VibeVoice, desenhos do OmniVoice)
//     logs/                server-<grupo>.log
//     tmp/                 downloads/extrações em andamento (apagado ao terminar)
//     state.json           o que está instalado (runtime, camadas, motores)
//     install.log          log das instalações (pip etc.)
//   <userData>/gpu-voices/<id>/   vozes de clonagem (CC0 e do usuário) — sobrevivem a "Remover runtime"
import { join } from 'node:path'
import type { GpuEngineGroup } from '@shared/gpuVoice'

export const GPU_RUNTIME_DIR = 'gpu-runtime'
export const GPU_VOICES_DIR = 'gpu-voices'

export interface GpuLayout {
  root: string
  python: string
  pythonExe: string
  layers: string
  hf: string
  assets: string
  logs: string
  tmp: string
  state: string
  installLog: string
  voices: string
  layer(group: Exclude<GpuEngineGroup, 'base'>): string
  layerPython(group: Exclude<GpuEngineGroup, 'base'>): string
}

export function gpuLayout(
  baseDir: string,
  platform: NodeJS.Platform = process.platform
): GpuLayout {
  const root = join(baseDir, GPU_RUNTIME_DIR)
  const python = join(root, 'python')
  const win = platform === 'win32'
  const layers = join(root, 'layers')
  return {
    root,
    python,
    pythonExe: win ? join(python, 'python.exe') : join(python, 'bin', 'python3'),
    layers,
    hf: join(root, 'hf'),
    assets: join(root, 'assets'),
    logs: join(root, 'logs'),
    tmp: join(root, 'tmp'),
    state: join(root, 'state.json'),
    installLog: join(root, 'install.log'),
    voices: join(baseDir, GPU_VOICES_DIR),
    layer: (g) => join(layers, g),
    layerPython: (g) =>
      win ? join(layers, g, 'Scripts', 'python.exe') : join(layers, g, 'bin', 'python')
  }
}

export interface PythonDist {
  url: string
  sha256: string
  size: number
}

const PBS = 'https://github.com/astral-sh/python-build-standalone/releases/download/20261013'
const PY = 'cpython-3.11.17%2B20261013'

/** Python 3.11.17 portátil (python-build-standalone 20261013, `install_only`) por plataforma. */
export const PYTHON_DISTS: Record<string, PythonDist> = {
  'linux-x64': {
    url: `${PBS}/${PY}-x86_64-unknown-linux-gnu-install_only.tar.gz`,
    sha256: '846bf682e2b67393f2affa5e5c0994e446abc3a7cc5bb699890c36346823644c',
    size: 48930886
  },
  'linux-arm64': {
    url: `${PBS}/${PY}-aarch64-unknown-linux-gnu-install_only.tar.gz`,
    sha256: '643954c07b04c18e215f812691cd5fa15d924fec1f3a5fdd9c1789484382ac24',
    size: 48977607
  },
  'darwin-arm64': {
    url: `${PBS}/${PY}-aarch64-apple-darwin-install_only.tar.gz`,
    sha256: 'd81d757a9785850393cd695a9a686c765a6370fbdc83738589ef2ecd3e5c44b3',
    size: 27121563
  },
  'win32-x64': {
    url: `${PBS}/${PY}-x86_64-pc-windows-msvc-install_only.tar.gz`,
    sha256: '7616ab1f74aab975bd91eb0a657a74a092a63a46cac38c5f3f9415c79fd781f5',
    size: 48191837
  }
}

export const pythonDistFor = (platform: string, arch: string): PythonDist | null =>
  PYTHON_DISTS[`${platform}-${arch}`] ?? null

/** Índice das wheels do torch: CUDA 12.8 no Linux/Windows x64; PyPI (MPS/CPU) no resto. */
export function torchIndexFor(platform: string, arch: string): string | null {
  if ((platform === 'linux' || platform === 'win32') && arch === 'x64')
    return 'https://download.pytorch.org/whl/cu128'
  if (platform === 'linux' && arch === 'arm64') return 'https://download.pytorch.org/whl/cu128'
  return null
}
