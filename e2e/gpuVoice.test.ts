// "Modo avançado (GPU local)" — testes com FAKES (sem GPU, sem rede, sem Python): parsers da sonda
// (`nvidia-smi` com/sem GPU, driver antigo, pouca VRAM, cabeçalho novo/clássico, lspci), regras de
// compatibilidade, normalizadores das settings (`backend: 'gpu'`/`mode: 'gpu'`), extrator de tar,
// instalador (máquina de estados com pip/HTTP falsos: progresso, erros legíveis, checksum,
// cancelamento, remoção), ciclo de vida do servidor (servidor falso `e2e/fakes/gpuServerFake.mjs`:
// saúde com token, crash → 1 reinício → erro, saída por ociosidade), o resolvedor → cliente de TTS
// (PCM em streaming pelo caminho de API) e o token/URL que nunca chegam à visão do renderer.
// Rodar: npm run test:unit
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  GPU_ENGINE_CATALOG,
  GPU_ENGINE_PARAMS,
  GPU_RUNTIME_VERSION,
  XTTS_DEFAULT_SPEED,
  evaluateEngineCompat,
  evaluateRuntimeCompat,
  gpuEngineEntry,
  normalizeGpuParamOverrides,
  resolveGpuParams,
  type GpuInfo,
  type GpuProbe
} from '../src/shared/gpuVoice.ts'
import { normalizeSttSettings, normalizeTtsSettings } from '../src/shared/voice.ts'
import {
  parseLspci,
  parseNvidiaSmiCsv,
  parseNvidiaSmiCudaVersion,
  ownVramByGpu,
  parseComputeAppsCsv,
  probeNvidia,
  type ProbeRunner
} from '../src/main/voice/gpu/probe.ts'
import { extractTarGz, safeTarPath } from '../src/main/voice/gpu/tar.ts'
import { GpuInstaller, GpuInstallError } from '../src/main/voice/gpu/installer.ts'
import type { ProcessRunner } from '../src/main/voice/gpu/proc.ts'
import { GpuServerManager } from '../src/main/voice/gpu/server.ts'
import { GpuVoiceStore, parseWavInfo } from '../src/main/voice/gpu/voices.ts'
import { GpuVoiceManager, wordErrorRate } from '../src/main/voice/gpu/manager.ts'
import {
  GpuEndpointError,
  gpuTtsAsApi,
  setGpuEndpointResolver
} from '../src/main/voice/gpu/endpoint.ts'
import { gpuCallFailureReason, prepareGpuForCall } from '../src/main/voice/gpu/callPrep.ts'
import { VoiceCallManager } from '../src/main/voice/call.ts'
import type { ChatConfig } from '@shared/types'
import type { VoiceCallState } from '@shared/voice'
import {
  DEFAULT_AUDIO_INPUT,
  DEFAULT_STT_SETTINGS,
  DEFAULT_TTS_SETTINGS,
  DEFAULT_VOICE_CALL_DEFAULTS
} from '../src/shared/voice.ts'
import { synthesizeStream, TtsError } from '../src/main/voice/tts.ts'
import { chooseSttBackend } from '../src/main/voice/stt.ts'
import { clipVoiceId } from '../src/main/voice/clips.ts'
import { encodeWav } from '../src/main/voice/wav.ts'

const FAKE_SERVER = resolve(import.meta.dirname, 'fakes/gpuServerFake.mjs')
const tmp = (p: string): string => mkdtempSync(join(tmpdir(), `clearchat-gpu-${p}-`))

// ---------------- sonda ----------------

const SMI_NEW_HEADER = `Fri Oct 23 18:16:00 2026
+-----------------------------------------------------------------------------------------+
| NVIDIA-SMI 615.78.08              KMD Version: 615.78.08     CUDA UMD Version: 13.4     |
+-----------------------------------------+------------------------+----------------------+`
const SMI_OLD_HEADER = `| NVIDIA-SMI 535.183.01             Driver Version: 535.183.01   CUDA Version: 12.2     |`
const SMI_ANCIENT = `| NVIDIA-SMI 470.256.02   Driver Version: 470.256.02   CUDA Version: 11.4     |`

test('nvidia-smi: CSV e cabeçalhos (novo "CUDA UMD Version", clássico, antigo)', () => {
  assert.equal(parseNvidiaSmiCudaVersion(SMI_NEW_HEADER), '13.4')
  assert.equal(parseNvidiaSmiCudaVersion(SMI_OLD_HEADER), '12.2')
  assert.equal(parseNvidiaSmiCudaVersion(SMI_ANCIENT), '11.4')
  assert.equal(parseNvidiaSmiCudaVersion('lixo'), null)
  const g = parseNvidiaSmiCsv('NVIDIA GeForce RTX 3080 Ti, 12288, 2822, 615.78.08, 8.6\n', '13.4')
  assert.deepEqual(g, [
    {
      vendor: 'nvidia',
      name: 'NVIDIA GeForce RTX 3080 Ti',
      vramTotalMb: 12288,
      vramFreeMb: 9466,
      driver: '615.78.08',
      cudaMax: '13.4',
      computeCap: '8.6'
    }
  ])
  // sem compute_cap (driver antigo) e duas GPUs
  const two = parseNvidiaSmiCsv(
    'Tesla T4, 15360, 0, 470.256.02\nQuadro P400, 2048 MiB, 100 MiB, 470.256.02',
    '11.4'
  )
  assert.equal(two.length, 2)
  assert.equal(two[1].vramFreeMb, 1948)
  assert.equal(two[0].computeCap, null)
  assert.deepEqual(parseNvidiaSmiCsv('', null), [])
})

test('probeNvidia: sem nvidia-smi → []; campo compute_cap desconhecido → repete sem ele', async () => {
  const none: ProbeRunner = async () => null
  assert.deepEqual(await probeNvidia(none), [])
  const calls: string[][] = []
  const old: ProbeRunner = async (_cmd, args) => {
    calls.push(args)
    if (args.some((a) => a.includes('compute_cap')))
      return { code: 2, stdout: '', stderr: 'Field "compute_cap" is not a valid field to query.' }
    if (!args.length) return { code: 0, stdout: SMI_ANCIENT, stderr: '' }
    return { code: 0, stdout: 'GeForce GTX 1060 6GB, 6144, 300, 470.256.02\n', stderr: '' }
  }
  const g = await probeNvidia(old)
  assert.equal(g[0].name, 'GeForce GTX 1060 6GB')
  assert.equal(g[0].cudaMax, '11.4')
  // compute_cap (falha) → sem ele → cabeçalho → UUIDs
  assert.equal(calls.length, 4)
})

test('lspci: AMD/Intel/NVIDIA', () => {
  const out = parseLspci(`00:02.0 VGA compatible controller: Intel Corporation Alder Lake-P GT2
03:00.0 VGA compatible controller: Advanced Micro Devices, Inc. [AMD/ATI] Navi 23 [Radeon RX 6600]
01:00.0 3D controller: NVIDIA Corporation GA107M [GeForce RTX 3050 Mobile]
00:1f.3 Audio device: Intel Corporation`)
  assert.deepEqual(
    out.map((g) => g.vendor),
    ['intel', 'amd', 'nvidia']
  )
})

// ---------------- regras de compatibilidade ----------------

const nv = (over: Partial<GpuInfo> = {}): GpuInfo => ({
  vendor: 'nvidia',
  name: 'RTX 3080 Ti',
  vramTotalMb: 12288,
  vramFreeMb: 9000,
  driver: '615.78',
  cudaMax: '13.4',
  computeCap: '8.6',
  ...over
})
const probe = (over: Partial<GpuProbe['platform']> = {}, gpus: GpuInfo[] = [nv()]): GpuProbe => ({
  platform: { os: 'linux', arch: 'x64', diskFreeMb: 100_000, ...over },
  gpus,
  ramMb: 32_000
})
const fresh = { runtimeInstalled: false, layerInstalled: false, installed: false }

test('compat: NVIDIA moderna ok; sem NVIDIA → aviso de CPU (não bloqueia); AMD citada', () => {
  assert.equal(evaluateRuntimeCompat(probe()).level, 'ok')
  const omni = gpuEngineEntry('omnivoice')
  const ok = evaluateEngineCompat(omni, probe(), fresh)
  assert.equal(ok.level, 'ok')
  assert.ok(
    ok.reasons.some((r) => /Sem streaming/.test(r)),
    'nota de qualidade nos motivos'
  )
  const cpu = evaluateRuntimeCompat(probe({}, [{ ...nv(), vendor: 'amd', name: 'Radeon RX 6600' }]))
  assert.equal(cpu.level, 'warn')
  assert.match(cpu.reasons.join(' '), /CPU, muito lento/)
  assert.match(cpu.reasons.join(' '), /Radeon RX 6600/)
  assert.equal(evaluateEngineCompat(omni, probe({}, []), fresh).level, 'warn')
})

test('compat: driver antigo (<12.0 → CPU; 12.2 → aviso de compatibilidade), GPU antiga', () => {
  const old = evaluateRuntimeCompat(probe({}, [nv({ cudaMax: '11.4', driver: '470.256' })]))
  assert.equal(old.level, 'warn')
  assert.match(old.reasons[0], /≥ 570/)
  assert.match(
    evaluateEngineCompat(
      gpuEngineEntry('xtts-v2'),
      probe({}, [nv({ cudaMax: '11.4' })]),
      fresh
    ).reasons.join(' '),
    /CPU/
  )
  const mid = evaluateRuntimeCompat(probe({}, [nv({ cudaMax: '12.2' })]))
  assert.equal(mid.level, 'warn')
  assert.match(mid.reasons[0], /compatibilidade do CUDA 12/)
  assert.equal(evaluateRuntimeCompat(probe({}, [nv({ computeCap: '6.1' })])).level, 'warn')
})

test('compat: VRAM total insuficiente / livre baixa → aviso', () => {
  const big = gpuEngineEntry('qwen3-tts-1.7b') // ~7,1 GB
  const small = evaluateEngineCompat(
    big,
    probe({}, [nv({ vramTotalMb: 6144, vramFreeMb: 5000 })]),
    fresh
  )
  assert.equal(small.level, 'warn')
  assert.match(small.reasons[0], /não cabe/)
  const busy = evaluateEngineCompat(big, probe({}, [nv({ vramFreeMb: 3000 })]), fresh)
  assert.equal(busy.level, 'warn')
  assert.match(busy.reasons[0], /VRAM livre agora/)
})

test('compat: plataformas — Mac Intel bloqueado, Apple Silicon aviso, ARM Linux aviso, ia32 bloqueado', () => {
  const intelMac = evaluateRuntimeCompat(probe({ os: 'darwin', arch: 'x64' }, []))
  assert.equal(intelMac.level, 'blocked')
  assert.equal(
    evaluateEngineCompat(
      gpuEngineEntry('omnivoice'),
      probe({ os: 'darwin', arch: 'x64' }, []),
      fresh
    ).level,
    'blocked'
  )
  const m1 = evaluateEngineCompat(
    gpuEngineEntry('whisper-large-v3-turbo'),
    probe({ os: 'darwin', arch: 'arm64' }, []),
    fresh
  )
  assert.equal(m1.level, 'warn')
  assert.match(m1.reasons.join(' '), /CPU \(int8/)
  assert.equal(evaluateRuntimeCompat(probe({ arch: 'arm64' })).level, 'warn')
  assert.equal(evaluateRuntimeCompat(probe({ os: 'win32', arch: 'ia32' })).level, 'blocked')
})

test('compat: disco insuficiente bloqueia com o quanto precisa (runtime incluso se faltar)', () => {
  const omni = gpuEngineEntry('omnivoice')
  const low = evaluateEngineCompat(omni, probe({ diskFreeMb: 6000 }), fresh)
  assert.equal(low.level, 'blocked')
  assert.match(low.reasons[0], /precisa de ~1\d,\d GB livres \(com o runtime\)/)
  // runtime e camada já instalados: só os pesos + folga
  const ok = evaluateEngineCompat(omni, probe({ diskFreeMb: 6000 }), {
    runtimeInstalled: true,
    layerInstalled: true,
    installed: false
  })
  assert.equal(ok.level, 'ok')
  // já instalado: disco não importa
  assert.notEqual(
    evaluateEngineCompat(omni, probe({ diskFreeMb: 10 }), { ...fresh, installed: true }).level,
    'blocked'
  )
  assert.equal(evaluateRuntimeCompat(probe({ diskFreeMb: 3000 })).level, 'blocked')
})

test('compat: VibeVoice experimental (aviso), Qwen com nota de sotaque pt-PT', () => {
  const vibe = evaluateEngineCompat(gpuEngineEntry('vibevoice-realtime'), probe(), fresh)
  assert.equal(vibe.level, 'warn')
  assert.match(vibe.reasons.join(' '), /experimental/)
  const qwen = evaluateEngineCompat(gpuEngineEntry('qwen3-tts-0.6b'), probe(), fresh)
  assert.equal(qwen.level, 'ok')
  assert.match(qwen.reasons.join(' '), /Portugal/)
  assert.equal(GPU_ENGINE_CATALOG.length, 6)
  assert.ok(!GPU_ENGINE_CATALOG.some((e) => /f5/i.test(e.id)), 'F5-TTS removido')
})

// ---------------- settings ----------------

test('normalizadores: backend/mode gpu preservados; gpu normalizado; aditivo (ausente nos demais)', () => {
  const t = normalizeTtsSettings({
    backend: 'gpu',
    gpu: { engine: 'xtts-v2', voice: ' cc0-faber ', steps: 999 }
  })
  assert.equal(t.backend, 'gpu')
  assert.deepEqual(t.gpu, { engine: 'xtts-v2', voice: 'cc0-faber', steps: 64 })
  const d = normalizeTtsSettings({ backend: 'gpu' })
  assert.deepEqual(d.gpu, { engine: 'omnivoice', voice: null })
  const junk = normalizeTtsSettings({ backend: 'gpu', gpu: { engine: 'f5-tts', voice: 3 } })
  assert.deepEqual(junk.gpu, { engine: 'omnivoice', voice: null })
  assert.ok(!('gpu' in normalizeTtsSettings({ backend: 'api' })), 'sem gpu → campo ausente')
  // gpu salvo sobrevive à troca de backend (volta com a mesma voz)
  assert.equal(
    normalizeTtsSettings({ backend: 'local', gpu: { engine: 'qwen3-tts-0.6b', voice: 'x' } }).gpu
      ?.engine,
    'qwen3-tts-0.6b'
  )
  const s = normalizeSttSettings({ mode: 'gpu' })
  assert.equal(s.mode, 'gpu')
  assert.deepEqual(s.gpu, { engine: 'whisper-large-v3-turbo' })
  assert.ok(!('gpu' in normalizeSttSettings({ mode: 'api' })))
  // modo gpu = motor "local" injetado (nada vai para a API)
  assert.equal(chooseSttBackend(s, { hasLocalReady: false, purpose: 'final' }), 'local')
  assert.equal(chooseSttBackend(s, { hasLocalReady: true, purpose: 'partial' }), 'local')
  // cache de clipes por motor/voz da GPU
  assert.equal(clipVoiceId(t), 'gpu-xtts-v2-cc0-faber')
})

// ---------------- tar ----------------

function tarEntry(name: string, data: Buffer | string, type = '0', linkname = ''): Buffer {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data)
  const h = Buffer.alloc(512)
  h.write(name, 0, 100)
  h.write('0000755\0', 100)
  h.write('0000000\0', 108)
  h.write('0000000\0', 116)
  h.write(body.length.toString(8).padStart(11, '0') + '\0', 124)
  h.write('00000000000\0', 136)
  h.write('        ', 148)
  h.write(type, 156)
  h.write(linkname, 157, 100)
  h.write('ustar\0', 257)
  h.write('00', 263)
  let sum = 0
  for (const b of h) sum += b
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148)
  const pad = Buffer.alloc((512 - (body.length % 512)) % 512)
  return Buffer.concat([h, body, pad])
}
const tarGz = (entries: Buffer[]): Buffer =>
  gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]))

test('tar.gz: arquivos, pastas, symlink relativo, nome longo GNU; recusa ../ e symlink para fora', async () => {
  const dir = tmp('tar')
  const long = `python/lib/${'x'.repeat(120)}.py`
  const ok = tarGz([
    tarEntry('python/', '', '5'),
    tarEntry('python/bin/python3.11', '#!fake\n'),
    tarEntry('python/bin/python3', '', '2', 'python3.11'),
    tarEntry('././@LongLink', `${long}\0`, 'L'),
    tarEntry(long.slice(0, 99), 'print(1)\n')
  ])
  writeFileSync(join(dir, 'ok.tgz'), ok)
  const r = await extractTarGz(join(dir, 'ok.tgz'), join(dir, 'out'))
  assert.equal(r.files, 2)
  assert.equal(readFileSync(join(dir, 'out/python/bin/python3'), 'utf8'), '#!fake\n')
  assert.equal(readFileSync(join(dir, 'out', long), 'utf8'), 'print(1)\n')
  writeFileSync(join(dir, 'evil.tgz'), tarGz([tarEntry('../evil.txt', 'x')]))
  await assert.rejects(extractTarGz(join(dir, 'evil.tgz'), join(dir, 'out2')), /fora da pasta/)
  writeFileSync(join(dir, 'evil2.tgz'), tarGz([tarEntry('a', '', '2', '../../etc/passwd')]))
  await assert.rejects(extractTarGz(join(dir, 'evil2.tgz'), join(dir, 'out3')), /fora da pasta/)
  assert.throws(() => safeTarPath(dir, '/etc/passwd'), /inválido/)
  rmSync(dir, { recursive: true, force: true })
})

// ---------------- instalador (pip/HTTP falsos) ----------------

const SERVER_DIR = resolve(import.meta.dirname, '../resources/gpu-server')
const pyTgz = tarGz([tarEntry('python/bin/python3', '#!fake python\n')])
const pyDist = {
  url: 'https://fake.example/python.tar.gz',
  sha256: createHash('sha256').update(pyTgz).digest('hex'),
  size: pyTgz.length
}
const fakeFetch = (body: Buffer): typeof fetch =>
  (async () => new Response(new Uint8Array(body), { status: 200 })) as unknown as typeof fetch

/** pip/venv/check/download falsos: criam o que o real criaria e imprimem o mesmo protocolo. */
function fakeRunner(
  base: string,
  opts: { failPip?: string; calls?: string[] } = {}
): ProcessRunner {
  return async (cmd, args, o) => {
    const line = `${cmd} ${args.join(' ')}`
    opts.calls?.push(line)
    if (o.signal?.aborted) return { code: null, tail: [] }
    if (args.includes('venv')) {
      const dir = args[args.length - 1]
      mkdirSync(join(dir, 'bin'), { recursive: true })
      writeFileSync(join(dir, 'bin', 'python'), '')
      return { code: 0, tail: [] }
    }
    if (args.includes('pip')) {
      if (opts.failPip && line.includes(opts.failPip)) {
        o.onStderrLine?.('ERROR: No matching distribution found for torch==2.8.0')
        return {
          code: 1,
          tail: [
            'Collecting torch==2.8.0',
            'ERROR: No matching distribution found for torch==2.8.0'
          ]
        }
      }
      return { code: 0, tail: [] }
    }
    if (args.includes('check')) {
      o.onStdoutLine?.(JSON.stringify({ ok: true, torch: '2.8.0+cu128', cuda: true }))
      return { code: 0, tail: [] }
    }
    if (args.includes('download')) {
      const engine = args[args.indexOf('--engine') + 1]
      const repo = `models--fake--${engine}`
      mkdirSync(join(base, 'gpu-runtime/hf/hub', repo, 'snapshots/abc'), { recursive: true })
      writeFileSync(
        join(base, 'gpu-runtime/hf/hub', repo, 'snapshots/abc/model.bin'),
        Buffer.alloc(1024)
      )
      for (const b of [0, 500, 1000])
        o.onStdoutLine?.(JSON.stringify({ event: 'progress', bytes: b, total: 1000 }))
      o.onStdoutLine?.(
        JSON.stringify({ event: 'done', bytes: 1000, total: 1000, repoDirs: [repo], assets: [] })
      )
      return { code: 0, tail: [] }
    }
    return { code: 0, tail: [] }
  }
}

test('instalador: runtime + motor do zero (progresso crescente, estado, camada, pesos) e remoção', async () => {
  const base = tmp('inst')
  const calls: string[] = []
  const inst = new GpuInstaller({
    baseDir: base,
    serverDir: SERVER_DIR,
    platform: 'linux',
    arch: 'x64',
    run: fakeRunner(base, { calls }),
    fetch: fakeFetch(pyTgz),
    pythonDist: pyDist,
    pipCacheDir: join(base, 'pipcache')
  })
  assert.equal(inst.runtimeState(await inst.readState()), 'absent')
  const pcts: number[] = []
  await inst.installEngine('omnivoice', undefined, (p) => {
    if (p.pct !== null) pcts.push(p.pct)
  })
  const s = await inst.readState()
  assert.equal(inst.runtimeState(s), 'installed')
  assert.equal(inst.engineState(s, 'omnivoice'), 'installed')
  assert.ok(inst.layerReady(s, 'omni'))
  assert.deepEqual(
    pcts,
    [...pcts].sort((a, b) => a - b),
    'progresso nunca volta'
  )
  assert.equal(pcts.at(-1), 100)
  // torch pelo índice CUDA 12.8; camada sem deps (gradio fora) + travas; pesos pelo server.py
  assert.ok(calls.some((c) => c.includes('--index-url https://download.pytorch.org/whl/cu128')))
  assert.ok(calls.some((c) => c.includes('--no-deps') && c.includes('omni.nodeps.txt')))
  assert.ok(
    calls.some((c) => c.includes('omni.txt') && c.includes('-c') && c.includes('omni.lock'))
  )
  assert.ok(calls.some((c) => c.includes('download --engine omnivoice')))
  assert.ok(existsSync(join(base, 'gpu-runtime/install.log')))
  // 2º motor com o runtime pronto: a barra começa do zero (não reserva 40% para o runtime)
  const second: number[] = []
  await inst.installEngine('xtts-v2', undefined, (p) => {
    if (p.pct !== null) second.push(p.pct)
  })
  assert.ok(second[0] <= 5, `começa perto de 0 (veio ${second[0]})`)
  await inst.removeEngine('xtts-v2')
  // instalar de novo: idempotente (nada de pip)
  calls.length = 0
  await inst.installRuntime(undefined, () => undefined)
  assert.equal(calls.length, 0)
  // arquivo de peso sumiu → broken
  rmSync(join(base, 'gpu-runtime/hf/hub/models--fake--omnivoice'), { recursive: true })
  assert.equal(inst.engineState(await inst.readState(), 'omnivoice'), 'broken')
  await inst.removeEngine('omnivoice')
  const after = await inst.readState()
  assert.equal(inst.engineState(after, 'omnivoice'), 'absent')
  assert.ok(!existsSync(join(base, 'gpu-runtime/layers/omni')), 'camada sem motores sai')
  await inst.removeRuntime()
  assert.ok(!existsSync(join(base, 'gpu-runtime')))
  rmSync(base, { recursive: true, force: true })
})

test('instalador: falha do pip com as últimas linhas; checksum divergente; cancelamento', async () => {
  const base = tmp('inst2')
  const mk = (over: Partial<ConstructorParameters<typeof GpuInstaller>[0]> = {}): GpuInstaller =>
    new GpuInstaller({
      baseDir: base,
      serverDir: SERVER_DIR,
      platform: 'linux',
      arch: 'x64',
      run: fakeRunner(base, { failPip: 'torch.txt' }),
      fetch: fakeFetch(pyTgz),
      pythonDist: pyDist,
      pipCacheDir: join(base, 'pipcache'),
      ...over
    })
  await assert.rejects(
    mk().installRuntime(undefined, () => undefined),
    (e: unknown) => {
      assert.ok(e instanceof GpuInstallError)
      assert.match(e.message, /PyTorch falhou.*No matching distribution/s)
      return true
    }
  )
  assert.equal(
    mk().runtimeState(await mk().readState()),
    'broken',
    'Python extraído sem runtime = incompleto'
  )
  rmSync(join(base, 'gpu-runtime'), { recursive: true, force: true })
  await assert.rejects(
    mk({ pythonDist: { ...pyDist, sha256: '0'.repeat(64) } }).installRuntime(
      undefined,
      () => undefined
    ),
    /não confere/
  )
  assert.ok(!existsSync(join(base, 'gpu-runtime/python')), 'nada instalado com checksum errado')
  const ctl = new AbortController()
  ctl.abort()
  await assert.rejects(
    mk({ run: fakeRunner(base) }).installRuntime(ctl.signal, () => undefined),
    (e: unknown) => (e as Error).name === 'AbortError'
  )
  rmSync(base, { recursive: true, force: true })
})

// ---------------- servidor (processo falso) ----------------

function fakeServerManager(
  env: Record<string, string> = {},
  onChange?: () => void
): GpuServerManager {
  return new GpuServerManager({
    logDir: tmp('logs'),
    healthTimeoutMs: 8000,
    onChange,
    spec: (_g, engines, port, token) => ({
      python: process.execPath,
      args: [FAKE_SERVER, 'serve', '--port', String(port), '--engines', engines.join(',')],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', CLEARCHAT_GPU_TOKEN: token, ...env },
      cwd: tmpdir()
    })
  })
}
const waitFor = async (cond: () => boolean, ms = 8000): Promise<void> => {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout esperando condição')
    await new Promise((r) => setTimeout(r, 50))
  }
}

test('servidor: sobe com token, /health exige o token, reaproveita e reinicia com motor novo', async () => {
  const counter = join(tmp('cnt'), 'starts')
  const m = fakeServerManager({ FAKE_GPU_COUNTER: counter })
  const port = await m.ensure('omni', ['omnivoice'])
  assert.equal(m.get('omni')?.state, 'running')
  const noAuth = await fetch(`http://127.0.0.1:${port}/health`)
  assert.equal(noAuth.status, 401)
  const auth = await fetch(`http://127.0.0.1:${port}/health`, {
    headers: { Authorization: `Bearer ${m.token}` }
  })
  assert.equal(auth.status, 200)
  assert.equal(await m.ensure('omni', ['omnivoice']), port, 'mesmo processo')
  const port2 = await m.ensure('omni', ['whisper-large-v3-turbo'])
  assert.notEqual(port2, port)
  assert.deepEqual(m.get('omni')?.engines.sort(), ['omnivoice', 'whisper-large-v3-turbo'])
  assert.equal(readFileSync(counter, 'utf8').trim().split('\n').length, 2)
  // duas falas ao mesmo tempo num grupo parado: UM processo só
  const [a, b] = await Promise.all([
    m.ensure('qwen', ['qwen3-tts-0.6b']),
    m.ensure('qwen', ['qwen3-tts-0.6b'])
  ])
  assert.equal(a, b)
  assert.equal(readFileSync(counter, 'utf8').trim().split('\n').length, 3)
  await m.stopAll()
  assert.equal(m.list().length, 0)
})

test('servidor: falha ao iniciar → erro legível com o log; crash → 1 reinício → erro; ocioso → parado', async () => {
  const bad = fakeServerManager({ FAKE_GPU_MODE: 'exit-on-start' })
  await assert.rejects(
    bad.ensure('base', ['whisper-large-v3-turbo']),
    /saiu ao iniciar \(código 3\).*importar torch/
  )
  assert.equal(bad.get('base')?.state, 'error')

  const counter = join(tmp('cnt2'), 'starts')
  const crashy = fakeServerManager({ FAKE_GPU_MODE: 'crash-after:400', FAKE_GPU_COUNTER: counter })
  await crashy.ensure('xtts', ['xtts-v2'])
  await waitFor(() => crashy.get('xtts')?.state === 'error')
  assert.equal(readFileSync(counter, 'utf8').trim().split('\n').length, 2, 'reiniciou uma vez')
  assert.match(crashy.get('xtts')!.error!, /caiu \(código 139\).*segfault/)

  const idle = fakeServerManager({ FAKE_GPU_MODE: 'idle-exit-after:300' })
  await idle.ensure('vibe', ['vibevoice-realtime'])
  await waitFor(() => idle.list().length === 0)
})

// ---------------- gerenciador: endpoint → cliente de TTS; token fora da visão ----------------

async function installedManager(
  opts: {
    /** Sonda dinâmica (recebe o gerenciador: PIDs dos processos para o --query-compute-apps). */
    probe?: (m: GpuVoiceManager) => GpuProbe
    gpu?: Record<string, unknown>
    stt?: Record<string, unknown>
  } = {}
): Promise<{
  m: GpuVoiceManager
  base: string
  tts: Record<string, unknown>
  stt: Record<string, unknown>
}> {
  const base = tmp('mgr')
  const ttsSettings: Record<string, unknown> = {
    backend: 'gpu',
    api: { providerId: null, baseUrl: '', apiKey: '', model: '', voice: null },
    local: null,
    gpu: opts.gpu ?? { engine: 'omnivoice', voice: 'cc0-faber', steps: 16 }
  }
  const sttSettings: Record<string, unknown> = opts.stt ?? { mode: 'gpu' }
  let self: GpuVoiceManager | null = null
  const measured: Record<string, unknown> = {}
  const m = new GpuVoiceManager({
    baseDir: base,
    serverDir: SERVER_DIR,
    platform: 'linux',
    arch: 'x64',
    run: fakeRunner(base),
    fetch: fakeFetch(pyTgz),
    pythonDist: pyDist,
    pipCacheDir: join(base, 'pipcache'),
    getTts: () => normalizeTtsSettings(ttsSettings),
    getStt: () => normalizeSttSettings(sttSettings),
    readMeasured: () => measured as never,
    writeMeasured: (id, v) => {
      measured[id] = v
    },
    probe: async () => (opts.probe && self ? opts.probe(self) : probe()),
    server: {
      spec: (_g, engines, port, token) => ({
        python: process.execPath,
        args: [FAKE_SERVER, 'serve', '--port', String(port), '--engines', engines.join(',')],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', CLEARCHAT_GPU_TOKEN: token },
        cwd: tmpdir()
      }),
      healthTimeoutMs: 8000
    }
  })
  self = m
  await m.installEngine('omnivoice')
  await m.installEngine('whisper-large-v3-turbo')
  return { m, base, tts: ttsSettings, stt: sttSettings }
}

test('gerenciador: backend gpu → servidor sobe sob demanda e o cliente de API faz streaming PCM', async () => {
  const { m, base } = await installedManager()
  setGpuEndpointResolver(m)
  try {
    const settings = normalizeTtsSettings({
      backend: 'gpu',
      gpu: { engine: 'omnivoice', voice: 'cc0-faber' }
    })
    const api = await gpuTtsAsApi(settings)
    assert.equal(api.backend, 'api')
    assert.equal(api.api.model, 'omnivoice')
    assert.equal(api.api.voice, 'cc0-faber')
    assert.match(api.api.baseUrl, /^http:\/\/127\.0\.0\.1:\d+\/v1$/)
    const r = await synthesizeStream({ text: 'Olá, tudo bem?', settings })
    assert.ok(r.streaming)
    let bytes = 0
    if (r.streaming) {
      assert.equal(r.sampleRate, 24000)
      for await (const c of r.chunks) bytes += c.length
    }
    assert.equal(bytes, 9600)
    // a transcrição usa o MESMO processo (whisper junto do grupo do motor de fala)
    const stt = await m.stt()
    assert.equal(stt.baseUrl, api.api.baseUrl)
    const out = await m
      .sttBackend(true)
      .transcribe(
        { audio: encodeWav(new Uint8Array(3200), 16000), mimeType: 'audio/wav' },
        { language: 'pt-BR' }
      )
    assert.match(out.text, /verificar/)
    // visão do renderer: sem URL/porta/token
    const view = JSON.stringify(await m.status())
    assert.ok(!view.includes(m.server.token), 'token fora do status')
    assert.ok(!/127\.0\.0\.1:\d+/.test(view), 'URL fora do status')
    const st = await m.status()
    assert.equal(st.server.state, 'running')
    assert.deepEqual(st.engines.find((e) => e.id === 'omnivoice')?.install.state, 'installed')
    // autoteste: 1º áudio + RTF + WER (whisper falso devolve a frase)
    const self = await m.selfTest('omnivoice')
    assert.ok(self.firstAudioMs >= 0 && self.rtf > 0)
    assert.equal(self.wer, 0)
    assert.ok((await m.status()).engines.find((e) => e.id === 'omnivoice')?.measured)
  } finally {
    setGpuEndpointResolver(null)
    await m.stopServer()
    rmSync(base, { recursive: true, force: true })
  }
})

test('gerenciador: motor não instalado → TtsError config (fatal na chamada); sem resolvedor idem', async () => {
  const { m, base } = await installedManager()
  setGpuEndpointResolver(m)
  try {
    await assert.rejects(
      synthesizeStream({
        text: 'oi',
        settings: normalizeTtsSettings({ backend: 'gpu', gpu: { engine: 'xtts-v2' } })
      }),
      (e: unknown) =>
        e instanceof TtsError &&
        e.kind === 'config' &&
        /XTTS-v2 \(Coqui\) não está instalado/.test(e.message)
    )
    setGpuEndpointResolver(null)
    await assert.rejects(
      synthesizeStream({ text: 'oi', settings: normalizeTtsSettings({ backend: 'gpu' }) }),
      (e: unknown) => e instanceof TtsError && e.kind === 'config'
    )
  } finally {
    setGpuEndpointResolver(null)
    await m.stopServer()
    rmSync(base, { recursive: true, force: true })
  }
})

test('gerenciador: liga sozinho — prontidão sem servidor, isWarm, fases do aquecimento, OOM legível', async () => {
  const { m, base } = await installedManager()
  try {
    // servidor parado NÃO é problema (liga sozinho): voice:runtime:status fica disponível
    assert.equal((await m.status()).server.state, 'stopped')
    assert.deepEqual(await m.readiness(), {
      gpuTts: { available: true, reason: null },
      gpuStt: { available: true, reason: null }
    })
    const both = ['omnivoice', 'whisper-large-v3-turbo'] as const
    assert.equal(await m.isWarm([...both]), false)
    const phases: string[] = []
    await m.startServer(undefined, { onPhase: (t) => phases.push(t) })
    assert.deepEqual(phases, [
      'Iniciando OmniVoice + Whisper large-v3-turbo…',
      'Aquecendo OmniVoice + Whisper large-v3-turbo…'
    ])
    assert.equal(await m.isWarm([...both]), true, 'aquecido = /health ready')
    const st = await m.status()
    assert.equal(st.server.state, 'running')
    assert.equal(st.server.phase, null)
    await m.stopServer()
    assert.equal(await m.isWarm(['omnivoice']), false)
    // aquecimento que estoura a VRAM: erro legível (a chamada termina com ele)
    process.env.FAKE_GPU_MODE = 'warmup-oom'
    await assert.rejects(
      m.startServer(['omnivoice']),
      (e: unknown) =>
        e instanceof GpuEndpointError &&
        /OmniVoice não carregou na GPU: GPU sem memória/.test(e.message)
    )
    assert.equal((await m.status()).server.phase, null)
  } finally {
    delete process.env.FAKE_GPU_MODE
    await m.stopServer()
    rmSync(base, { recursive: true, force: true })
  }
})

test('chamada com GPU: prepara antes do microfone (fases → pronta), quente pula, falha encerra, encerrada no meio não mexe', async () => {
  const run = async (
    over: Partial<Parameters<typeof prepareGpuForCall>[0]>
  ): Promise<{ r: string; log: string[] }> => {
    const log: string[] = []
    const r = await prepareGpuForCall({
      engines: ['omnivoice', 'whisper-large-v3-turbo'],
      isWarm: async () => false,
      start: async (ids, onPhase) => {
        log.push(`start ${ids.join(',')}`)
        onPhase('Aquecendo OmniVoice + Whisper large-v3-turbo…')
      },
      setPreparing: (t) => log.push(`preparing ${t ?? 'null'}`),
      stillActive: () => true,
      fail: (reason) => log.push(`fail ${reason}`),
      ...over
    })
    return { r, log }
  }
  // fria: preparo → servidor sobe/aquece → pronta (só então o renderer abre o microfone)
  const cold = await run({})
  assert.equal(cold.r, 'ready')
  assert.deepEqual(cold.log, [
    'preparing Iniciando OmniVoice + Whisper large-v3-turbo…',
    'start omnivoice,whisper-large-v3-turbo',
    'preparing Aquecendo OmniVoice + Whisper large-v3-turbo…',
    'preparing null'
  ])
  // já quente: nada de fase de preparo
  assert.deepEqual(await run({ isWarm: async () => true }), { r: 'warm', log: [] })
  // sem GPU na chamada
  assert.equal((await run({ engines: [] })).r, 'none')
  // falha (OOM/servidor não subiu): encerra com motivo legível + saída (voz na nuvem)
  const oom = await run({
    start: async () => {
      throw new GpuEndpointError('OmniVoice não carregou na GPU: GPU sem memória', 'network')
    }
  })
  assert.equal(oom.r, 'failed')
  assert.equal(
    oom.log[1],
    `fail ${gpuCallFailureReason(new Error('OmniVoice não carregou na GPU: GPU sem memória'))}`
  )
  assert.match(
    oom.log[1],
    /a GPU local não ficou pronta — OmniVoice não carregou na GPU: GPU sem memória\. Feche programas que usam a GPU .* voz na nuvem/
  )
  // o usuário encerrou durante o preparo: nada de "pronta" nem de falha numa chamada que acabou
  let active = true
  const aborted = await run({
    start: async () => {
      active = false
      throw new Error('servidor parado')
    },
    stillActive: () => active
  })
  assert.equal(aborted.r, 'aborted')
  assert.ok(!aborted.log.some((l) => l.startsWith('fail') || l === 'preparing null'))
})

test('chamada: estado "preparing" (fase da GPU) é aditivo, emitido e some ao ficar pronta/encerrar', () => {
  const states: VoiceCallState[] = []
  const m = new VoiceCallManager({
    sendTurn: () => {},
    synth: async () => ({ audio: new Uint8Array(0), mime: 'audio/wav' }),
    emitState: (st) => states.push(st),
    emitUtterance: () => {},
    emitUtteranceCancel: () => {},
    emitTimeline: () => {},
    logEval: () => {},
    clip: async () => null,
    sessionInfo: () => ({ chatId: 'c1', depth: 0, busy: false }),
    chatConfig: () => ({}) as ChatConfig,
    settings: () => ({
      defaults: DEFAULT_VOICE_CALL_DEFAULTS,
      audioInput: DEFAULT_AUDIO_INPUT,
      stt: DEFAULT_STT_SETTINGS,
      tts: DEFAULT_TTS_SETTINGS
    }),
    onEvent: () => () => {}
  })
  // fora da chamada: nada
  assert.equal('preparing' in m.setPreparing('Iniciando…'), false)
  const st0 = m.start('s1')
  assert.equal('preparing' in st0, false, 'chamada sem GPU: estado igual ao de antes')
  assert.equal(m.setPreparing('Iniciando OmniVoice…').preparing, 'Iniciando OmniVoice…')
  assert.equal(states.at(-1)?.preparing, 'Iniciando OmniVoice…')
  const n = states.length
  m.setPreparing('Iniciando OmniVoice…') // igual: não reemite
  assert.equal(states.length, n)
  m.setPreparing('Aquecendo OmniVoice…')
  assert.equal(m.state().preparing, 'Aquecendo OmniVoice…')
  assert.equal('preparing' in m.setPreparing(null), false, 'pronta: o microfone pode abrir')
  m.setPreparing('Iniciando…')
  const stopped = m.stop('a GPU local não ficou pronta — OOM')
  assert.equal(stopped.active, false)
  assert.equal('preparing' in stopped, false)
  assert.match(stopped.error ?? '', /não ficou pronta/)
})

// ---------------- vozes ----------------

test('vozes: WAV do usuário (validação de duração/formato), listagem, CC0 com checksum', async () => {
  const root = tmp('voices')
  const store = new GpuVoiceStore(root, fakeFetch(Buffer.from('mp3 falso')))
  const wav = (s: number): ArrayBuffer => {
    const u = encodeWav(new Uint8Array(Math.round(s * 24000) * 2), 24000)
    return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer
  }
  assert.equal(parseWavInfo(new Uint8Array(wav(7)))?.durationS, 7)
  await assert.rejects(store.addUser({ name: 'Curta', audio: wav(1) }), /curta demais/)
  await assert.rejects(store.addUser({ name: 'Longa', audio: wav(45) }), /longa demais/)
  await assert.rejects(store.addUser({ name: '', audio: wav(7) }), /nome/)
  await assert.rejects(
    store.addUser({ name: 'X', audio: new TextEncoder().encode('oi').buffer }),
    /Formato/
  )
  const { id } = await store.addUser({
    name: 'Minha voz',
    audio: wav(7),
    transcript: ' Olá  mundo '
  })
  assert.match(id, /^user-[0-9a-f]{8}$/)
  assert.ok(existsSync(join(root, id, 'voice.wav')), '24 kHz mono → pronto para os motores')
  const list = await store.list()
  assert.deepEqual(
    list.map((v) => [v.id, v.name, v.transcript]),
    [[id, 'Minha voz', 'Olá mundo']]
  )
  await assert.rejects(store.downloadCc0(), /não confere/)
  await store.remove(id)
  assert.deepEqual(await store.list(), [])
  await assert.rejects(store.remove('../x'), /inválida/)
  rmSync(root, { recursive: true, force: true })
})

test('WER do autoteste', () => {
  assert.equal(wordErrorRate('Claro, já vou verificar isso.', 'claro ja vou verificar isso'), 0)
  assert.equal(wordErrorRate('um dois três quatro', 'um dois tres'), 0.25)
})

test('server.py: sintaxe Python válida e sem F5 (quando há python3 no sistema)', async (t) => {
  const py = await new Promise<number | null>((res) => {
    const c = spawn(
      'python3',
      ['-c', `import ast,sys; ast.parse(open(sys.argv[1]).read())`, join(SERVER_DIR, 'server.py')],
      { stdio: 'ignore' }
    )
    c.on('error', () => res(null))
    c.on('close', (code) => res(code))
  })
  if (py === null) return t.skip('python3 ausente')
  assert.equal(py, 0)
  assert.ok(!/F5-TTS|\bf5\b|F5Engine/i.test(readFileSync(join(SERVER_DIR, 'server.py'), 'utf8')))
})

// ---------------- relatório real: instalação, VRAM do próprio app, parâmetros ----------------

/** Runner falso que PARA no pip do torch até `release()` (instalação em andamento de verdade). */
function gatedRunner(base: string): {
  run: ProcessRunner
  reached: Promise<void>
  release: () => void
} {
  const inner = fakeRunner(base)
  let reachedOk: () => void = () => undefined
  const reached = new Promise<void>((r) => (reachedOk = r))
  let release: () => void = () => undefined
  const gate = new Promise<void>((r) => (release = r))
  const run: ProcessRunner = async (cmd, args, o) => {
    if (args.includes('pip') && args.some((a) => a.endsWith('torch.txt'))) {
      o.onStdoutLine?.('Looking in indexes: https://download.pytorch.org/whl/cu128')
      o.onStdoutLine?.('Collecting torch==2.8.0')
      reachedOk()
      await gate
    }
    return inner(cmd, args, o)
  }
  return { run, reached, release }
}

function bareManager(
  base: string,
  run: ProcessRunner,
  fetchImpl = fakeFetch(pyTgz)
): GpuVoiceManager {
  return new GpuVoiceManager({
    baseDir: base,
    serverDir: SERVER_DIR,
    platform: 'linux',
    arch: 'x64',
    run,
    fetch: fetchImpl,
    pythonDist: pyDist,
    pipCacheDir: join(base, 'pipcache'),
    getTts: () => normalizeTtsSettings({ backend: 'local' }),
    getStt: () => normalizeSttSettings({ mode: 'api' }),
    readMeasured: () => ({}),
    writeMeasured: () => undefined,
    probe: async () => probe()
  })
}

test('instalação em andamento: nunca "incompleta"; fase do PyTorch; log ao vivo; termina "instalado" com a versão', async () => {
  const base = tmp('inst-live')
  const g = gatedRunner(base)
  const m = bareManager(base, g.run)
  const p = m.installRuntime()
  await g.reached
  // o Python já foi extraído e o registro do runtime ainda não existe (= "broken" em disco)
  assert.ok(existsSync(join(base, 'gpu-runtime/python/.clearchat-python')))
  assert.equal(m.installer.runtimeState(await m.installer.readState()), 'broken')
  const during = await m.status()
  assert.equal(during.runtime.state, 'installing')
  assert.equal(during.runtime.error, null, 'erro de "incompleta" durante a instalação')
  assert.match(during.runtime.progress?.phase ?? '', /PyTorch/)
  assert.ok(typeof during.seq === 'number')
  // a saída do pip chega ao install.log ENQUANTO ele roda (antes só no fim)
  await new Promise((r) => setTimeout(r, 1300))
  assert.match(
    readFileSync(join(base, 'gpu-runtime/install.log'), 'utf8'),
    /Collecting torch==2\.8\.0/
  )
  g.release()
  await p
  const after = await m.status()
  assert.equal(after.runtime.state, 'installed')
  assert.equal(after.runtime.version, GPU_RUNTIME_VERSION)
  assert.equal(after.runtime.error, null)
  assert.ok((after.seq ?? 0) > (during.seq ?? 0), 'seq crescente')
  // a cópia não promete o modelo do whisper (só o pacote vem na base)
  assert.doesNotMatch(
    readFileSync(join(base, 'gpu-runtime/install.log'), 'utf8'),
    /\(whisper, servidor\)/
  )
  rmSync(base, { recursive: true, force: true })
})

test('instalar MOTOR sem runtime: o card do runtime fica "instalando" (com a fase) desde o início', async () => {
  const base = tmp('inst-eng')
  const g = gatedRunner(base)
  const m = bareManager(base, g.run)
  const p = m.installEngine('xtts-v2')
  await g.reached
  const s = await m.status()
  assert.equal(s.runtime.state, 'installing')
  assert.equal(s.runtime.error, null)
  assert.match(s.runtime.progress?.phase ?? '', /PyTorch/)
  const x = s.engines.find((e) => e.id === 'xtts-v2')!
  assert.equal(x.install.state, 'installing')
  assert.match(x.install.progress?.phase ?? '', /^Runtime: .*PyTorch/)
  g.release()
  await p
  const done = await m.status()
  assert.equal(done.runtime.state, 'installed')
  assert.equal(done.engines.find((e) => e.id === 'xtts-v2')?.install.state, 'installed')
  rmSync(base, { recursive: true, force: true })
})

test('instalação interrompida → retoma sem baixar o Python de novo; versão antiga tem mensagem própria', async () => {
  const base = tmp('inst-resume')
  const failing = bareManager(base, fakeRunner(base, { failPip: 'torch.txt' }))
  await assert.rejects(failing.installRuntime(), /PyTorch falhou/)
  const s1 = await failing.status()
  assert.equal(s1.runtime.state, 'broken')
  assert.match(s1.runtime.error ?? '', /falhou/, 'o erro real da última tentativa')
  assert.match(
    failing.installer.runtimeProblem(await failing.installer.readState()) ?? '',
    /interrompida.*continuar de onde parou/
  )
  let fetches = 0
  const counting = (async (...a: Parameters<typeof fetch>) => {
    fetches++
    return fakeFetch(pyTgz)(...a)
  }) as typeof fetch
  const calls: string[] = []
  const ok = bareManager(base, fakeRunner(base, { calls }), counting)
  await ok.installRuntime()
  assert.equal(fetches, 0, 'o Python portátil já extraído não é baixado de novo')
  assert.ok(
    calls.some((c) => c.includes('torch.txt')),
    'o pip retoma (já satisfeito = rápido)'
  )
  assert.equal((await ok.status()).runtime.state, 'installed')
  // registro de uma versão antiga do runtime
  const st = JSON.parse(readFileSync(join(base, 'gpu-runtime/state.json'), 'utf8'))
  st.runtime.version = 'py3.11.0-torch2.7.0-0'
  writeFileSync(join(base, 'gpu-runtime/state.json'), JSON.stringify(st))
  const old = await ok.status()
  assert.equal(old.runtime.state, 'broken')
  assert.match(old.runtime.error ?? '', /versão antiga \(py3\.11\.0-torch2\.7\.0-0\).*Reinstalar/)
  rmSync(base, { recursive: true, force: true })
})

test('VRAM: --query-compute-apps (N/A do WDDM) e a VRAM do próprio servidor separada da livre', () => {
  const apps = parseComputeAppsCsv(`1289, 111, GPU-aaa
1500127, 1250, GPU-aaa
1500581, 5404, GPU-aaa
4242, [N/A], GPU-bbb
garbage line
`)
  assert.deepEqual(
    apps.map((a) => [a.pid, a.usedMb, a.gpuUuid]),
    [
      [1289, 111, 'GPU-aaa'],
      [1500127, 1250, 'GPU-aaa'],
      [1500581, 5404, 'GPU-aaa'],
      [4242, null, 'GPU-bbb']
    ]
  )
  assert.deepEqual(parseComputeAppsCsv('No running processes found'), [])
  const own = ownVramByGpu(apps, new Set([1500127, 1500581, 4242]), () => 900)
  assert.equal(own.get('GPU-aaa'), 6654, 'só os PIDs do servidor (o desktop fica de fora)')
  assert.equal(own.get('GPU-bbb'), 900, 'sem número do driver → estimativa')
  // regras: carregado nunca avisa; o que o app libera ao trocar conta como livre
  const omni = gpuEngineEntry('omnivoice') // ~5,0 GB
  const p = probe({}, [nv({ vramFreeMb: 3500 })])
  const base = { runtimeInstalled: true, layerInstalled: true, installed: true }
  assert.match(evaluateEngineCompat(omni, p, base).reasons.join(' '), /VRAM livre agora: 3,4 GB/)
  const loaded = evaluateEngineCompat(omni, p, { ...base, vram: { loaded: true } })
  assert.equal(loaded.level, 'ok')
  assert.ok(!loaded.reasons.some((r) => /VRAM/.test(r)))
  const swap = evaluateEngineCompat(omni, p, {
    ...base,
    vram: { reclaimMb: 5400, releases: ['XTTS-v2'] }
  })
  assert.equal(swap.level, 'ok', 'cabe liberando o XTTS')
  const short = evaluateEngineCompat(omni, p, {
    ...base,
    vram: { reclaimMb: 600, releases: ['XTTS-v2'] }
  })
  assert.equal(short.level, 'warn')
  assert.match(short.reasons[0], /3,4 GB \+ 0,6 GB que o app libera ao trocar \(XTTS-v2\)/)
})

test('gerenciador: motor carregado no servidor não avisa de VRAM; VRAM do app à parte; trocar de grupo libera o processo antigo', async () => {
  const { m, base } = await installedManager({
    probe: (mgr) => ({
      platform: { os: 'linux', arch: 'x64', diskFreeMb: 100_000 },
      gpus: [nv({ vramFreeMb: 2000, uuid: 'GPU-1' })],
      ramMb: 32_000,
      computeApps: [
        { pid: 999_999, usedMb: 3000, gpuUuid: 'GPU-1' }, // outro programa (jogo)
        ...mgr.server
          .list()
          .flatMap((p) => p.pids.map((pid) => ({ pid, usedMb: 5400, gpuUuid: 'GPU-1' })))
      ]
    })
  })
  try {
    await m.installEngine('xtts-v2')
    const cold = await m.status(true)
    const omniCold = cold.engines.find((e) => e.id === 'omnivoice')!
    assert.equal(omniCold.compat.level, 'warn', 'parado: 2 GB livres < 5 GB')
    assert.equal(cold.gpus[0].vramOwnMb, 0)
    await m.startServer(['omnivoice'])
    const pids = m.server.list().flatMap((p) => p.pids)
    assert.ok(pids.length >= 1, 'PIDs do processo conhecidos')
    const hot = await m.status(true)
    const omni = hot.engines.find((e) => e.id === 'omnivoice')!
    assert.equal(omni.vram?.loaded, true)
    assert.ok(
      !omni.compat.reasons.some((r) => /VRAM livre/.test(r)),
      omni.compat.reasons.join(' | ')
    )
    assert.equal(hot.gpus[0].vramOwnMb, 5400 * new Set(pids).size)
    assert.ok(!('uuid' in hot.gpus[0]), 'UUID fora do status')
    // XTTS (outro grupo): cabe liberando o OmniVoice — sem aviso, com o que será liberado
    const x = hot.engines.find((e) => e.id === 'xtts-v2')!
    assert.equal(x.vram?.loaded, false)
    assert.deepEqual(x.vram?.releases, ['OmniVoice'])
    assert.equal(x.vram?.availMb, 2000 + 5400 * new Set(pids).size)
    assert.ok(!x.compat.reasons.some((r) => /VRAM livre/.test(r)))
    // trocar para o XTTS para o processo do OmniVoice (um processo por vez na GPU)
    await m.tts('xtts-v2')
    assert.deepEqual(
      m.server.list().map((p) => p.group),
      ['xtts']
    )
  } finally {
    await m.stopServer()
    rmSync(base, { recursive: true, force: true })
  }
})

test('parâmetros por motor: faixas, só overrides nas settings, chegam ao corpo da fala; whisper por /v1/config', async () => {
  // normalização / faixas
  assert.deepEqual(
    normalizeGpuParamOverrides('xtts-v2', { speed: 3, temperature: 'x', top_k: 50.4, junk: 1 }),
    { speed: 1.5 }
  )
  assert.equal(resolveGpuParams('xtts-v2', {}).speed, XTTS_DEFAULT_SPEED)
  assert.ok(XTTS_DEFAULT_SPEED > 1, 'XTTS um pouco mais rápido por padrão')
  assert.deepEqual(
    normalizeGpuParamOverrides('whisper-large-v3-turbo', {
      beam_size: 9,
      vad_filter: 'yes',
      language: 'auto'
    }),
    { beam_size: 5, language: 'auto' }
  )
  for (const [id, specs] of Object.entries(GPU_ENGINE_PARAMS))
    for (const sp of specs) {
      assert.ok(sp.help.length > 20, `${id}.${sp.key} sem explicação`)
      if (sp.kind === 'number') {
        assert.ok(
          sp.min! <= (sp.default as number) && (sp.default as number) <= sp.max!,
          `${id}.${sp.key}`
        )
      }
    }
  const tts = normalizeTtsSettings({
    backend: 'gpu',
    gpu: {
      engine: 'xtts-v2',
      voice: null,
      params: { 'xtts-v2': { speed: 1.3 }, nope: { a: 1 }, omnivoice: { guidance_scale: 2 } }
    }
  })
  assert.deepEqual(tts.gpu?.params, { 'xtts-v2': { speed: 1.3 } })
  assert.deepEqual(normalizeSttSettings({ mode: 'gpu', gpu: { params: { beam_size: 3 } } }).gpu, {
    engine: 'whisper-large-v3-turbo',
    params: { beam_size: 3 }
  })
  assert.equal(normalizeSttSettings({ mode: 'gpu' }).gpu?.params, undefined)

  // de ponta a ponta (servidor falso grava os corpos)
  const bodies = join(tmp('bodies'), 'b.jsonl')
  process.env.FAKE_GPU_BODY_FILE = bodies
  const gpu = { engine: 'omnivoice', voice: 'cc0-faber', params: { omnivoice: { speed: 1.2 } } }
  const {
    m,
    base,
    tts: ttsRaw
  } = await installedManager({
    gpu,
    stt: { mode: 'gpu', gpu: { params: { beam_size: 3, vad_filter: true } } }
  })
  setGpuEndpointResolver(m)
  const read = (): { url: string; body: Record<string, unknown> }[] =>
    readFileSync(bodies, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
  const lastSpeech = (): Record<string, unknown> =>
    read()
      .filter((x) => x.url === '/v1/audio/speech')
      .at(-1)!.body
  try {
    const drain = async (settings: ReturnType<typeof normalizeTtsSettings>): Promise<void> => {
      const r = await synthesizeStream({ text: 'Olá, tudo bem?', settings })
      if (r.streaming) for await (const _ of r.chunks) void _
    }
    await drain(normalizeTtsSettings(ttsRaw))
    assert.deepEqual(lastSpeech().params, { guidance_scale: 2, speed: 1.2 })
    assert.equal(lastSpeech().model, 'omnivoice', 'campos extras não sobrescrevem o modelo')
    const pids = m.server.list().flatMap((p) => p.pids)
    // mudou o parâmetro → a PRÓXIMA fala já vai com ele, sem reiniciar o servidor
    ;(ttsRaw.gpu as typeof gpu).params.omnivoice.speed = 0.9
    await drain(normalizeTtsSettings(ttsRaw))
    assert.equal(lastSpeech().params && (lastSpeech().params as { speed: number }).speed, 0.9)
    assert.deepEqual(
      m.server.list().flatMap((p) => p.pids),
      pids,
      'servidor não reiniciou'
    )
    // "Testar" do card usa os parâmetros atuais
    await m.selfTest('omnivoice')
    assert.equal((lastSpeech().params as { speed: number }).speed, 0.9)
    // whisper: config enviada uma vez por processo (beam/VAD/idioma)
    await m.stt()
    await m.stt()
    const cfgs = read().filter((x) => x.url === '/v1/config' && x.body.whisper)
    assert.equal(cfgs.length, 1)
    assert.deepEqual(cfgs[0].body.whisper, { beam_size: 3, vad_filter: true, language: 'pt' })
  } finally {
    delete process.env.FAKE_GPU_BODY_FILE
    setGpuEndpointResolver(null)
    await m.stopServer()
    rmSync(base, { recursive: true, force: true })
  }
})

test('server.py: parâmetros limitados às faixas e frase longa do XTTS em trechos ≤ 180 (python3)', async (t) => {
  const code = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("srv", sys.argv[1]); m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
long = "também rolou uma sequência intensa de lançamentos: " + ", ".join(f"o modelo número {i} da empresa {i}" for i in range(12)) + "."
print(json.dumps({
  "x": m.clamp_params("xtts-v2", {"speed": 9, "temperature": "abc", "top_k": 3.7}),
  "d": m.clamp_params("xtts-v2", None),
  "o": m.clamp_params("omnivoice", {"steps": 100}),
  "w": m.whisper_config({"beam_size": 0, "vad_filter": True, "language": "xx"}),
  "parts": [len(p) for p in m.split_long(long)],
  "joined": " ".join(m.split_long(long)) == long,
  "short": m.split_long("Oi, tudo bem?"),
  "clean": m.XttsEngine.clean("um trecho cortado,"),
}))`
  const out = await new Promise<string | null>((res) => {
    let o = ''
    const c = spawn('python3', ['-I', '-c', code, join(SERVER_DIR, 'server.py')], {
      stdio: ['ignore', 'pipe', 'ignore']
    })
    c.stdout.on('data', (b: Buffer) => (o += b.toString()))
    c.on('error', () => res(null))
    c.on('close', (code) => res(code === 0 ? o : null))
  })
  if (out === null) return t.skip('python3 ausente')
  const j = JSON.parse(out)
  assert.deepEqual(j.x, {
    speed: 1.5,
    temperature: 0.75,
    repetition_penalty: 10,
    top_p: 0.85,
    top_k: 3
  })
  assert.equal(j.d.speed, XTTS_DEFAULT_SPEED, 'padrão do servidor = padrão do app')
  assert.deepEqual(j.o, { guidance_scale: 2, speed: 1, steps: 64 })
  assert.deepEqual(j.w, { beam_size: 1, vad_filter: true, language: 'pt' })
  assert.ok(j.parts.length > 1 && j.parts.every((n: number) => n <= 180), JSON.stringify(j.parts))
  assert.equal(j.joined, true, 'nada se perde ao dividir')
  assert.deepEqual(j.short, ['Oi, tudo bem?'])
  assert.equal(j.clean, 'um trecho cortado')
})
