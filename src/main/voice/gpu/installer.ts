// "Modo avançado (GPU local)" — instalador do runtime e dos motores (main, sem Electron).
//
// Runtime: Python portátil (python-build-standalone, sha256 conferido) → `pip install` do torch
// (índice CUDA 12.8 no Linux/Windows) → base fixada (faster-whisper + servidor + áudio) → checagem
// (`server.py check`). Motor: camada venv `--system-site-packages` do grupo (pacotes fixados em
// `resources/gpu-server/requirements/<grupo>.{nodeps.txt,txt,lock}`) → checagem de import →
// pesos (`server.py download`, revisões fixadas no HF; progresso em linhas JSON). Tudo retomável
// (pip e o HF retomam; o Python vai para `tmp/` e só vira `python/` com rename atômico),
// cancelável (AbortSignal derruba a árvore do processo) e com log em `install.log`.
// Dependências injetáveis (runner de processos, fetch) — testes com pip/HTTP falsos.
import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream, existsSync } from 'node:fs'
import {
  appendFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile
} from 'node:fs/promises'
import { join } from 'node:path'
import {
  GPU_RUNTIME_VERSION,
  gpuEngineEntry,
  type GpuEngineGroup,
  type GpuEngineId
} from '@shared/gpuVoice'
import { gpuLayout, pythonDistFor, torchIndexFor, type GpuLayout, type PythonDist } from './layout'
import { defaultRunner, type ProcessRunner } from './proc'
import { extractTarGz } from './tar'

export type LayerGroup = Exclude<GpuEngineGroup, 'base'>

export interface GpuInstallState {
  runtime: {
    version: string
    installedAt: string
    sizeMb: number
    torchIndex: string | null
  } | null
  layers: Partial<Record<LayerGroup, { version: string; installedAt: string; sizeMb: number }>>
  engines: Partial<
    Record<
      GpuEngineId,
      { version: string; installedAt: string; sizeMb: number; repoDirs: string[]; assets: string[] }
    >
  >
}

export const EMPTY_STATE: GpuInstallState = { runtime: null, layers: {}, engines: {} }

export interface InstallProgress {
  /** 'runtime' ou o id do motor. */
  target: 'runtime' | GpuEngineId
  phase: string
  /** 0–100 do alvo inteiro (null = indeterminado). */
  pct: number | null
  bytes?: number
}

export interface InstallerDeps {
  baseDir: string
  /** Pasta com `server.py` e `requirements/` (resources/gpu-server). */
  serverDir: string
  platform?: NodeJS.Platform
  arch?: string
  run?: ProcessRunner
  fetch?: typeof fetch
  /** Cache do pip (padrão: `tmp/pip-cache`, apagado ao terminar). Testes apontam para um cache existente. */
  pipCacheDir?: string
  /** Python dist (testes: um tar.gz local servido por HTTP falso). */
  pythonDist?: PythonDist | null
  now?: () => Date
}

/** Erro legível da instalação (pt-BR), com as últimas linhas do log quando vem do pip. */
export class GpuInstallError extends Error {
  readonly detail?: string
  constructor(message: string, detail?: string) {
    super(message)
    this.name = 'GpuInstallError'
    this.detail = detail
  }
}

const abortErr = (): Error =>
  Object.assign(new Error('instalação cancelada'), { name: 'AbortError' })

export const isAbortError = (e: unknown): boolean =>
  !!e && typeof e === 'object' && (e as { name?: string }).name === 'AbortError'

/** Tamanho em MB de uma pasta (sem seguir symlinks). */
export async function dirSizeMb(dir: string): Promise<number> {
  let total = 0
  const walk = async (d: string): Promise<void> => {
    let entries: import('node:fs').Dirent[]
    try {
      entries = await readdir(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = join(d, e.name)
      if (e.isDirectory()) await walk(p)
      else if (e.isFile()) {
        try {
          total += (await lstat(p)).size
        } catch {
          /* sumiu */
        }
      }
    }
  }
  await walk(dir)
  return Math.round(total / 2 ** 20)
}

export class GpuInstaller {
  readonly layout: GpuLayout
  private readonly run: ProcessRunner
  private readonly fetchImpl: typeof fetch
  private readonly platform: NodeJS.Platform
  private readonly arch: string

  private readonly deps: InstallerDeps

  constructor(deps: InstallerDeps) {
    this.deps = deps
    this.platform = deps.platform ?? process.platform
    this.arch = deps.arch ?? process.arch
    this.layout = gpuLayout(deps.baseDir, this.platform)
    this.run = deps.run ?? defaultRunner
    this.fetchImpl = deps.fetch ?? fetch
  }

  // ---------------- estado ----------------

  async readState(): Promise<GpuInstallState> {
    try {
      const raw = JSON.parse(await readFile(this.layout.state, 'utf8')) as Partial<GpuInstallState>
      return {
        runtime: raw.runtime ?? null,
        layers: raw.layers ?? {},
        engines: raw.engines ?? {}
      }
    } catch {
      return { runtime: null, layers: {}, engines: {} }
    }
  }

  private async writeState(mutate: (s: GpuInstallState) => void): Promise<GpuInstallState> {
    const s = await this.readState()
    mutate(s)
    await mkdir(this.layout.root, { recursive: true })
    const tmp = `${this.layout.state}.${randomUUID().slice(0, 8)}.tmp`
    await writeFile(tmp, JSON.stringify(s, null, 2))
    await rename(tmp, this.layout.state)
    return s
  }

  /** Runtime instalado e utilizável (registro + executável na versão atual). */
  runtimeReady(s: GpuInstallState): boolean {
    return (
      !!s.runtime && s.runtime.version === GPU_RUNTIME_VERSION && existsSync(this.layout.pythonExe)
    )
  }

  /** absent | installed | broken (sobra de instalação interrompida, versão antiga ou executável sumido). */
  runtimeState(s: GpuInstallState): 'absent' | 'installed' | 'broken' {
    if (this.runtimeReady(s)) return 'installed'
    if (s.runtime || existsSync(this.layout.python)) return 'broken'
    return 'absent'
  }

  layerReady(s: GpuInstallState, group: GpuEngineGroup): boolean {
    if (group === 'base') return true
    return !!s.layers[group] && existsSync(this.layout.layerPython(group))
  }

  /** Motor: absent | installed | broken (arquivos sumiram/camada faltando). */
  engineState(s: GpuInstallState, id: GpuEngineId): 'absent' | 'installed' | 'broken' {
    const e = s.engines[id]
    if (!e) return 'absent'
    const group = gpuEngineEntry(id).group
    if (!this.runtimeReady(s) || !this.layerReady(s, group)) return 'broken'
    if (e.repoDirs.some((d) => !existsSync(join(this.layout.hf, 'hub', d)))) return 'broken'
    if (e.assets.some((a) => !existsSync(join(this.layout.assets, a)))) return 'broken'
    return 'installed'
  }

  /** Python que roda um grupo (base → o portátil; demais → o venv da camada). */
  pythonFor(group: GpuEngineGroup): string {
    return group === 'base' ? this.layout.pythonExe : this.layout.layerPython(group)
  }

  get serverScript(): string {
    return join(this.deps.serverDir, 'server.py')
  }

  private req(name: string): string {
    return join(this.deps.serverDir, 'requirements', name)
  }

  // ---------------- log ----------------

  async log(line: string): Promise<void> {
    const ts = (this.deps.now?.() ?? new Date()).toISOString()
    await mkdir(this.layout.root, { recursive: true })
    await appendFile(this.layout.installLog, `[${ts}] ${line}\n`).catch(() => undefined)
  }

  /** Últimas `n` linhas do install.log. */
  async logTail(n = 200): Promise<string> {
    try {
      const lines = (await readFile(this.layout.installLog, 'utf8')).split('\n')
      return lines.slice(-n).join('\n')
    } catch {
      return ''
    }
  }

  // ---------------- execução ----------------

  /** Ambiente dos processos Python (isolado do Python/pip do usuário). */
  pyEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {}
    // só o essencial do ambiente do app (nada de PYTHONPATH/VIRTUAL_ENV/CONDA do usuário)
    for (const k of [
      'PATH',
      'HOME',
      'USERPROFILE',
      'SYSTEMROOT',
      'SystemRoot',
      'TEMP',
      'TMP',
      'TMPDIR',
      'LANG',
      'LC_ALL',
      'APPDATA',
      'LOCALAPPDATA',
      'COMSPEC',
      'PATHEXT',
      'WINDIR',
      'HTTP_PROXY',
      'HTTPS_PROXY',
      'NO_PROXY',
      'http_proxy',
      'https_proxy',
      'no_proxy',
      'SSL_CERT_FILE',
      'REQUESTS_CA_BUNDLE',
      'DISPLAY',
      'WAYLAND_DISPLAY',
      'XDG_RUNTIME_DIR',
      'CUDA_VISIBLE_DEVICES'
    ]) {
      const v = process.env[k]
      if (v !== undefined) env[k] = v
    }
    return {
      ...env,
      PYTHONNOUSERSITE: '1',
      PYTHONUNBUFFERED: '1',
      PYTHONIOENCODING: 'utf-8',
      PIP_DISABLE_PIP_VERSION_CHECK: '1',
      PIP_NO_INPUT: '1',
      PIP_PROGRESS_BAR: 'off',
      HF_HOME: this.layout.hf,
      HF_HUB_DISABLE_TELEMETRY: '1',
      ...extra
    }
  }

  private async exec(
    what: string,
    cmd: string,
    args: string[],
    signal: AbortSignal | undefined,
    opts: { env?: NodeJS.ProcessEnv; onStdoutLine?: (l: string) => void } = {}
  ): Promise<void> {
    if (signal?.aborted) throw abortErr()
    await this.log(`$ ${cmd} ${args.join(' ')}`)
    const lines: string[] = []
    const flush = async (): Promise<void> => {
      if (lines.length) await this.log(lines.splice(0).join('\n'))
    }
    const r = await this.run(cmd, args, {
      env: opts.env ?? this.pyEnv(),
      cwd: this.layout.root,
      signal,
      onStdoutLine: (l) => {
        lines.push(l)
        opts.onStdoutLine?.(l)
      },
      onStderrLine: (l) => lines.push(l)
    }).catch((e: unknown) => {
      throw new GpuInstallError(
        `${what}: não consegui executar ${cmd} (${e instanceof Error ? e.message : String(e)})`
      )
    })
    await flush()
    if (signal?.aborted) throw abortErr()
    if (r.code !== 0) {
      const tail = r.tail.slice(-8).join('\n')
      await this.log(`falhou (${what}) com código ${r.code}`)
      throw new GpuInstallError(
        `${what} falhou (código ${r.code}). Últimas linhas do log:\n${tail}`,
        tail
      )
    }
  }

  private pipArgs(): string[] {
    const cache = this.deps.pipCacheDir ?? join(this.layout.tmp, 'pip-cache')
    return ['-m', 'pip', 'install', '--no-input', '--cache-dir', cache]
  }

  /** Mede o crescimento de uma pasta enquanto `work` roda → pct da fase (a cada 3 s). */
  private async withGrowth<T>(
    dir: string,
    expectedMb: number,
    onPct: (pct: number) => void,
    work: () => Promise<T>
  ): Promise<T> {
    const start = await dirSizeMb(dir)
    let stop = false
    let wake: () => void = () => undefined
    const loop = (async () => {
      while (!stop) {
        await new Promise<void>((r) => {
          wake = r
          setTimeout(r, 3000)
        })
        if (stop) break
        const now = await dirSizeMb(dir)
        onPct(Math.max(0, Math.min(0.99, (now - start) / Math.max(1, expectedMb))))
      }
    })()
    try {
      return await work()
    } finally {
      stop = true
      wake()
      await loop.catch(() => undefined)
    }
  }

  // ---------------- download HTTP ----------------

  async downloadFile(
    url: string,
    dest: string,
    expect: { sha256: string; size: number },
    signal: AbortSignal | undefined,
    onBytes: (n: number) => void
  ): Promise<void> {
    let res: Response
    try {
      res = await this.fetchImpl(url, { signal, headers: { 'User-Agent': 'ClearChat' } })
    } catch (e) {
      if (signal?.aborted) throw abortErr()
      throw new GpuInstallError(
        `falha de rede ao baixar ${url}: ${e instanceof Error ? e.message : String(e)}`
      )
    }
    if (!res.ok || !res.body)
      throw new GpuInstallError(`download falhou (HTTP ${res.status}) em ${url}`)
    const part = `${dest}.${randomUUID().slice(0, 8)}.part`
    const hash = createHash('sha256')
    let n = 0
    const out = createWriteStream(part)
    try {
      const reader = res.body.getReader()
      for (;;) {
        let r: ReadableStreamReadResult<Uint8Array>
        try {
          r = await reader.read()
        } catch (e) {
          if (signal?.aborted) throw abortErr()
          throw new GpuInstallError(
            `conexão caiu baixando ${url}: ${e instanceof Error ? e.message : String(e)}`
          )
        }
        if (r.done) break
        hash.update(r.value)
        n += r.value.length
        if (!out.write(r.value)) await new Promise<void>((ok) => out.once('drain', () => ok()))
        onBytes(n)
      }
      await new Promise<void>((ok, ko) => out.end((e?: Error | null) => (e ? ko(e) : ok())))
      const got = hash.digest('hex')
      if (n !== expect.size || got !== expect.sha256)
        throw new GpuInstallError(
          `arquivo baixado não confere (tamanho ${n}/${expect.size}, sha256 ${got.slice(0, 12)}… ≠ ${expect.sha256.slice(0, 12)}…) — tente de novo`
        )
      await rename(part, dest)
    } catch (e) {
      out.destroy()
      await rm(part, { force: true })
      throw e
    }
  }

  // ---------------- runtime ----------------

  async installRuntime(
    signal: AbortSignal | undefined,
    onProgress: (p: InstallProgress) => void
  ): Promise<void> {
    const L = this.layout
    const prog = (phase: string, pct: number | null, bytes?: number): void =>
      onProgress({ target: 'runtime', phase, pct, ...(bytes !== undefined ? { bytes } : {}) })
    const state = await this.readState()
    if (this.runtimeReady(state)) return
    await mkdir(L.tmp, { recursive: true })
    await this.log(`== instalar runtime ${GPU_RUNTIME_VERSION} (${this.platform}-${this.arch})`)
    // versão antiga do runtime: recomeça do zero (os requisitos mudaram)
    if (state.runtime && state.runtime.version !== GPU_RUNTIME_VERSION) {
      await rm(L.python, { recursive: true, force: true })
      await rm(L.layers, { recursive: true, force: true })
      await this.writeState((s) => {
        s.runtime = null
        s.layers = {}
      })
    }
    // 1. Python portátil
    if (!existsSync(join(L.python, '.clearchat-python'))) {
      const dist = this.deps.pythonDist ?? pythonDistFor(this.platform, this.arch)
      if (!dist)
        throw new GpuInstallError(
          `não há Python portátil para ${this.platform}-${this.arch} — modo GPU indisponível neste sistema`
        )
      const tgz = join(L.tmp, 'python.tar.gz')
      prog('Baixando o Python portátil', 0, 0)
      await this.downloadFile(dist.url, tgz, dist, signal, (n) =>
        prog('Baixando o Python portátil', Math.round((n / dist.size) * 3), n)
      )
      prog('Extraindo o Python', 3)
      const stage = join(L.tmp, `py-${randomUUID().slice(0, 8)}`)
      await extractTarGz(tgz, stage, { signal })
      await writeFile(join(stage, 'python', '.clearchat-python'), dist.sha256)
      await rm(L.python, { recursive: true, force: true })
      await rename(join(stage, 'python'), L.python)
      await rm(stage, { recursive: true, force: true })
      await rm(tgz, { force: true })
    }
    // 2. torch (índice CUDA no Linux/Windows x64)
    const index = torchIndexFor(this.platform, this.arch)
    const cuda = !!index
    prog(cuda ? 'Instalando o PyTorch (CUDA 12.8, ~3 GB)' : 'Instalando o PyTorch', 4)
    await this.withGrowth(
      L.python,
      cuda ? 6400 : 700,
      (f) =>
        prog(
          cuda ? 'Instalando o PyTorch (CUDA 12.8, ~3 GB)' : 'Instalando o PyTorch',
          4 + Math.round(f * 76)
        ),
      () =>
        this.exec(
          'instalação do PyTorch',
          L.pythonExe,
          [
            ...this.pipArgs(),
            ...(index ? ['--index-url', index] : []),
            '-r',
            this.req('torch.txt')
          ],
          signal
        )
    )
    // 3. base (faster-whisper, servidor, áudio)
    prog('Instalando a base (whisper, servidor)', 80)
    await this.withGrowth(
      L.python,
      900,
      (f) => prog('Instalando a base (whisper, servidor)', 80 + Math.round(f * 16)),
      () =>
        this.exec(
          'instalação da base',
          L.pythonExe,
          [...this.pipArgs(), '-r', this.req('base.txt'), '-c', this.req('base.lock')],
          signal
        )
    )
    // 4. checagem: o torch carrega e vê (ou não) a GPU
    prog('Verificando o runtime', 97)
    let check: Record<string, unknown> = {}
    await this.exec(
      'verificação do runtime',
      L.pythonExe,
      ['-I', this.serverScript, 'check', '--engines', 'whisper-large-v3-turbo'],
      signal,
      {
        onStdoutLine: (l) => {
          try {
            check = JSON.parse(l) as Record<string, unknown>
          } catch {
            /* linha de log */
          }
        }
      }
    )
    await this.log(`runtime ok: ${JSON.stringify(check)}`)
    if (!this.deps.pipCacheDir) await rm(join(L.tmp, 'pip-cache'), { recursive: true, force: true })
    const sizeMb = await dirSizeMb(L.python)
    await this.writeState((s) => {
      s.runtime = {
        version: GPU_RUNTIME_VERSION,
        installedAt: (this.deps.now?.() ?? new Date()).toISOString(),
        sizeMb,
        torchIndex: index
      }
    })
    prog('Runtime instalado', 100)
  }

  async removeRuntime(): Promise<void> {
    await this.log('== remover runtime (python, camadas, pesos)')
    // tudo sob gpu-runtime (as vozes ficam em gpu-voices); o log recomeça
    await rm(this.layout.root, { recursive: true, force: true })
  }

  // ---------------- motores ----------------

  async installEngine(
    id: GpuEngineId,
    signal: AbortSignal | undefined,
    onProgress: (p: InstallProgress) => void
  ): Promise<void> {
    const entry = gpuEngineEntry(id)
    const L = this.layout
    const prog = (phase: string, pct: number | null, bytes?: number): void =>
      onProgress({ target: id, phase, pct, ...(bytes !== undefined ? { bytes } : {}) })
    let state = await this.readState()
    // runtime ausente: ele vem primeiro e ocupa 0–40% da barra do motor
    const withRuntime = !this.runtimeReady(state)
    if (withRuntime) {
      await this.installRuntime(signal, (p) =>
        prog(`Runtime: ${p.phase}`, p.pct === null ? null : Math.round(p.pct * 0.4), p.bytes)
      )
      state = await this.readState()
    }
    const base = withRuntime ? 40 : 0
    const span = 100 - base
    await this.log(`== instalar motor ${id}`)
    // 1. camada de pacotes do grupo
    const group = entry.group
    if (group !== 'base' && !this.layerReady(state, group)) {
      const dir = L.layer(group)
      const py = L.layerPython(group)
      prog('Criando o ambiente do motor', base)
      if (!existsSync(py))
        await this.exec(
          'criação do ambiente do motor',
          L.pythonExe,
          ['-m', 'venv', '--system-site-packages', dir],
          signal
        )
      prog('Instalando os pacotes do motor', base + Math.round(span * 0.05))
      await this.withGrowth(
        dir,
        Math.max(50, entry.layerMb),
        (f) => prog('Instalando os pacotes do motor', base + Math.round(span * (0.05 + f * 0.2))),
        async () => {
          if (existsSync(this.req(`${group}.nodeps.txt`)))
            await this.exec(
              'instalação dos pacotes do motor',
              py,
              [...this.pipArgs(), '--no-deps', '-r', this.req(`${group}.nodeps.txt`)],
              signal
            )
          await this.exec(
            'instalação dos pacotes do motor',
            py,
            [...this.pipArgs(), '-r', this.req(`${group}.txt`), '-c', this.req(`${group}.lock`)],
            signal
          )
        }
      )
      prog('Verificando o motor', base + Math.round(span * 0.25))
      await this.exec(
        `verificação do motor ${entry.label}`,
        py,
        ['-I', this.serverScript, 'check', '--engines', id],
        signal
      )
      const sizeMb = await dirSizeMb(dir)
      await this.writeState((s) => {
        s.layers[group] = {
          version: GPU_RUNTIME_VERSION,
          installedAt: (this.deps.now?.() ?? new Date()).toISOString(),
          sizeMb
        }
      })
      if (!this.deps.pipCacheDir)
        await rm(join(L.tmp, 'pip-cache'), { recursive: true, force: true })
    }
    // 2. pesos (HF revisões fixadas + arquivos extras)
    const w0 = base + Math.round(span * 0.27)
    const wspan = 100 - w0 - 1
    prog('Baixando os pesos', w0, 0)
    let done: { repoDirs?: string[]; assets?: string[] } = {}
    let failure: string | null = null
    await this.exec(
      `download dos pesos de ${entry.label}`,
      L.pythonExe,
      ['-I', this.serverScript, 'download', '--engine', id, '--assets-dir', L.assets],
      signal,
      {
        onStdoutLine: (l) => {
          let ev: { event?: string; bytes?: number; total?: number; message?: string } & typeof done
          try {
            ev = JSON.parse(l)
          } catch {
            return
          }
          if (ev.event === 'progress' && ev.total)
            prog(
              'Baixando os pesos',
              w0 + Math.round(((ev.bytes ?? 0) / ev.total) * wspan),
              ev.bytes
            )
          else if (ev.event === 'done') done = ev
          else if (ev.event === 'error') failure = ev.message ?? 'falha no download'
        }
      }
    ).catch((e: unknown) => {
      if (failure && !isAbortError(e)) throw new GpuInstallError(failure)
      throw e
    })
    const repoDirs = done.repoDirs ?? []
    const assets = done.assets ?? []
    let sizeMb = 0
    for (const d of repoDirs) sizeMb += await dirSizeMb(join(L.hf, 'hub', d))
    await this.writeState((s) => {
      s.engines[id] = {
        version: GPU_RUNTIME_VERSION,
        installedAt: (this.deps.now?.() ?? new Date()).toISOString(),
        sizeMb,
        repoDirs,
        assets
      }
    })
    await this.log(`motor ${id} instalado (${sizeMb} MB de pesos)`)
    prog('Motor instalado', 100)
  }

  /** Remove os pesos do motor e a camada do grupo quando nenhum outro motor dela ficou. */
  async removeEngine(id: GpuEngineId): Promise<void> {
    const entry = gpuEngineEntry(id)
    const s = await this.readState()
    const e = s.engines[id]
    await this.log(`== remover motor ${id}`)
    for (const d of e?.repoDirs ?? [])
      await rm(join(this.layout.hf, 'hub', d), { recursive: true, force: true })
    for (const a of e?.assets ?? []) await rm(join(this.layout.assets, a), { force: true })
    const others = (Object.keys(s.engines) as GpuEngineId[]).filter(
      (x) => x !== id && gpuEngineEntry(x).group === entry.group
    )
    const dropLayer = entry.group !== 'base' && !others.length
    if (dropLayer)
      await rm(this.layout.layer(entry.group as LayerGroup), { recursive: true, force: true })
    await this.writeState((st) => {
      delete st.engines[id]
      if (dropLayer) delete st.layers[entry.group as LayerGroup]
    })
  }
}
