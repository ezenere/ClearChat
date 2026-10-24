// "Modo avançado (GPU local)" — sonda de hardware SEM Python (main, sem Electron): GPUs NVIDIA
// pelo `nvidia-smi` (nome/VRAM/driver/compute + "CUDA Version" do cabeçalho), AMD/Intel pelo
// `lspci`/CIM (melhor esforço), Apple Silicon pela arquitetura, disco livre da pasta do userData e
// RAM. Os parsers são puros (testados em `e2e/gpuVoice.test.ts` com saídas reais e de casos sem
// GPU/driver antigo/pouca VRAM). As REGRAS ficam em `@shared/gpuVoice` (`evaluate*Compat`).
import { spawn } from 'node:child_process'
import { statfs } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname } from 'node:path'
import os from 'node:os'
import type { GpuComputeApp, GpuInfo, GpuProbe } from '@shared/gpuVoice'

/** Resultado de um comando da sonda (null = não existe / não rodou). */
export interface ProbeRun {
  code: number | null
  stdout: string
  stderr: string
}

export type ProbeRunner = (
  cmd: string,
  args: string[],
  timeoutMs: number
) => Promise<ProbeRun | null>

/** Roda um comando sem shell, com timeout e teto de saída (ENOENT → null). */
export const defaultProbeRunner: ProbeRunner = (cmd, args, timeoutMs) =>
  new Promise((resolve) => {
    let out = ''
    let err = ''
    let done = false
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch {
      resolve(null)
      return
    }
    const finish = (v: ProbeRun | null): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(v)
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(null)
    }, timeoutMs)
    child.stdout?.on('data', (b: Buffer) => {
      if (out.length < 256_000) out += b.toString('utf8')
    })
    child.stderr?.on('data', (b: Buffer) => {
      if (err.length < 64_000) err += b.toString('utf8')
    })
    child.on('error', () => finish(null))
    child.on('close', (code) => finish({ code, stdout: out, stderr: err }))
  })

const num = (v: string | undefined): number | null => {
  const n = Number(String(v ?? '').trim())
  return Number.isFinite(n) ? n : null
}

/**
 * CSV do `nvidia-smi --query-gpu=name,memory.total,memory.used,driver_version[,compute_cap]
 * --format=csv,noheader,nounits` → GPUs (MiB). Linhas inválidas são ignoradas.
 */
export function parseNvidiaSmiCsv(csv: string, cudaMax: string | null): GpuInfo[] {
  const out: GpuInfo[] = []
  for (const line of csv.split(/\r?\n/)) {
    if (!line.trim() || /^name\s*,/i.test(line)) continue
    const cols = line.split(',').map((c) => c.trim())
    if (cols.length < 4) continue
    const [name, total, used, driver, cc] = cols
    const t = num(total.replace(/\s*MiB$/i, ''))
    const u = num(used.replace(/\s*MiB$/i, ''))
    if (!name) continue
    out.push({
      vendor: 'nvidia',
      name,
      vramTotalMb: t,
      vramFreeMb: t !== null && u !== null ? Math.max(0, t - u) : null,
      driver: driver && !/not supported|n\/a/i.test(driver) ? driver : null,
      cudaMax,
      computeCap: cc && /^\d+\.\d+$/.test(cc) ? cc : null
    })
  }
  return out
}

/**
 * "CUDA Version" do cabeçalho do `nvidia-smi` (formato clássico `CUDA Version: 12.4` e o novo
 * `CUDA UMD Version: 13.4` dos drivers 6xx). null quando não aparece.
 */
export function parseNvidiaSmiCudaVersion(text: string): string | null {
  const m = /CUDA(?:\s+UMD)?\s+Version\s*:\s*(\d+\.\d+)/i.exec(text)
  return m ? m[1] : null
}

/** Linhas de vídeo do `lspci` → GPUs não-NVIDIA (AMD/Intel/outras), melhor esforço. */
export function parseLspci(text: string): GpuInfo[] {
  const out: GpuInfo[] = []
  for (const line of text.split(/\r?\n/)) {
    const m = /(VGA compatible controller|3D controller|Display controller)[^:]*:\s*(.+)$/i.exec(
      line
    )
    if (!m) continue
    const name = m[2].trim()
    const vendor: GpuInfo['vendor'] = /nvidia/i.test(name)
      ? 'nvidia'
      : /\b(amd|ati|radeon)\b/i.test(name)
        ? 'amd'
        : /intel/i.test(name)
          ? 'intel'
          : 'other'
    out.push({ vendor, name, vramTotalMb: null, vramFreeMb: null, driver: null, cudaMax: null })
  }
  return out
}

function vendorOf(name: string): GpuInfo['vendor'] {
  if (/nvidia|geforce|quadro|rtx|tesla/i.test(name)) return 'nvidia'
  if (/\b(amd|ati|radeon)\b/i.test(name)) return 'amd'
  if (/intel/i.test(name)) return 'intel'
  if (/apple/i.test(name)) return 'apple'
  return 'other'
}

/**
 * CSV do `nvidia-smi --query-compute-apps=pid,used_memory,gpu_uuid --format=csv,noheader,nounits`
 * → processos com contexto CUDA. `used_memory` "[N/A]"/"[Not Supported]" (Windows WDDM) → null.
 */
export function parseComputeAppsCsv(csv: string): GpuComputeApp[] {
  const out: GpuComputeApp[] = []
  for (const line of csv.split(/\r?\n/)) {
    if (!line.trim() || /^pid\s*,/i.test(line) || /no running/i.test(line)) continue
    const [pid, used, uuid] = line.split(',').map((c) => c.trim())
    const p = num(pid)
    if (p === null || p <= 0) continue
    const u = num((used ?? '').replace(/\s*MiB$/i, ''))
    out.push({ pid: p, usedMb: u, gpuUuid: uuid && /^GPU-/i.test(uuid) ? uuid : null })
  }
  return out
}

/** Processos CUDA de todas as GPUs NVIDIA ([] sem driver / falha). */
export async function probeComputeApps(
  run: ProbeRunner = defaultProbeRunner
): Promise<GpuComputeApp[]> {
  const r = await run(
    'nvidia-smi',
    ['--query-compute-apps=pid,used_memory,gpu_uuid', '--format=csv,noheader,nounits'],
    8000
  )
  return r && r.code === 0 ? parseComputeAppsCsv(r.stdout) : []
}

/**
 * VRAM (MB) que os processos `pids` (o servidor do app) ocupam em cada GPU (por UUID; sem UUID →
 * chave ''). Processo nosso sem `used_memory` informado conta como `fallbackMb(pid)`.
 */
export function ownVramByGpu(
  apps: readonly GpuComputeApp[],
  pids: ReadonlySet<number>,
  fallbackMb: (pid: number) => number = () => 0
): Map<string, number> {
  const out = new Map<string, number>()
  for (const a of apps) {
    if (!pids.has(a.pid)) continue
    const k = a.gpuUuid ?? ''
    out.set(k, (out.get(k) ?? 0) + (a.usedMb ?? fallbackMb(a.pid)))
  }
  return out
}

/** NVIDIA pelo `nvidia-smi` (sem driver/sem GPU → []). */
export async function probeNvidia(run: ProbeRunner = defaultProbeRunner): Promise<GpuInfo[]> {
  const fields = 'name,memory.total,memory.used,driver_version'
  let q = await run(
    'nvidia-smi',
    [`--query-gpu=${fields},compute_cap`, '--format=csv,noheader,nounits'],
    8000
  )
  // drivers antigos não conhecem `compute_cap` (erro "not a valid field")
  if (!q || q.code !== 0)
    q = await run('nvidia-smi', [`--query-gpu=${fields}`, '--format=csv,noheader,nounits'], 8000)
  if (!q || q.code !== 0) return []
  const head = await run('nvidia-smi', [], 8000)
  const cuda = head && head.code === 0 ? parseNvidiaSmiCudaVersion(head.stdout) : null
  const gpus = parseNvidiaSmiCsv(q.stdout, cuda)
  // UUIDs na mesma ordem (casam os processos do --query-compute-apps em máquinas multi-GPU)
  const u = await run('nvidia-smi', ['--query-gpu=uuid', '--format=csv,noheader'], 8000)
  const uuids =
    u && u.code === 0
      ? u.stdout
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => /^GPU-/i.test(l))
      : []
  if (uuids.length === gpus.length) gpus.forEach((g, i) => (g.uuid = uuids[i]))
  return gpus
}

/** GPUs da máquina (NVIDIA detalhada + demais por SO, melhor esforço). */
export async function probeGpus(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  run: ProbeRunner = defaultProbeRunner
): Promise<GpuInfo[]> {
  const nv = platform === 'darwin' ? [] : await probeNvidia(run)
  const others: GpuInfo[] = []
  if (platform === 'linux') {
    const r = await run('lspci', [], 5000)
    if (r && r.code === 0) others.push(...parseLspci(r.stdout).filter((g) => g.vendor !== 'nvidia'))
  } else if (platform === 'win32') {
    const r = await run(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', '(Get-CimInstance Win32_VideoController).Name'],
      8000
    )
    if (r && r.code === 0)
      for (const name of r.stdout
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean)) {
        const vendor = vendorOf(name)
        if (vendor !== 'nvidia')
          others.push({
            vendor,
            name,
            vramTotalMb: null,
            vramFreeMb: null,
            driver: null,
            cudaMax: null
          })
      }
  } else if (platform === 'darwin' && arch === 'arm64') {
    // memória unificada: a "VRAM" é a RAM do sistema
    const ram = Math.round(os.totalmem() / 2 ** 20)
    others.push({
      vendor: 'apple',
      name: (os.cpus()[0]?.model ?? 'Apple Silicon').trim(),
      vramTotalMb: ram,
      vramFreeMb: Math.round(os.freemem() / 2 ** 20),
      driver: null,
      cudaMax: null
    })
  }
  return [...nv, ...others]
}

/** Espaço livre (MB) do disco que guarda `dir` (sobe até um ancestral que exista). 0 = desconhecido. */
export async function diskFreeMb(dir: string): Promise<number> {
  let d = dir
  while (!existsSync(d) && dirname(d) !== d) d = dirname(d)
  try {
    const s = await statfs(d)
    return Math.floor((Number(s.bavail) * Number(s.bsize)) / 2 ** 20)
  } catch {
    return 0
  }
}

/** Sonda completa (plataforma + GPUs + disco + RAM). */
export async function probeSystem(
  baseDir: string,
  deps: { platform?: NodeJS.Platform; arch?: string; run?: ProbeRunner } = {}
): Promise<GpuProbe> {
  const platform = deps.platform ?? process.platform
  const arch = deps.arch ?? process.arch
  const [gpus, free] = await Promise.all([probeGpus(platform, arch, deps.run), diskFreeMb(baseDir)])
  const computeApps = gpus.some((g) => g.vendor === 'nvidia')
    ? await probeComputeApps(deps.run)
    : []
  return {
    platform: { os: platform, arch, diskFreeMb: free },
    gpus,
    ramMb: Math.round(os.totalmem() / 2 ** 20),
    computeApps
  }
}
