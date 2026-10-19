// Checagem de versão nova (SPEC → "Atualizações"): GET na última release do GitHub, alguns segundos
// depois do start e a cada 6 h. Sem Electron (versão, emissão e fetch injetados → testável no Node).
// Falhas (rede, 403/429 do limite da API, JSON inválido) só vão para o log: nunca viram toast.
// Nada é baixado nem instalado.
import {
  LATEST_RELEASE_API,
  UPDATE_FIRST_CHECK_MS,
  UPDATE_INTERVAL_MS,
  isNewer,
  parseLatestRelease,
  type UpdateStatus
} from '@shared/updates'

type FetchLike = (url: string, init: RequestInit) => Promise<Response>

export interface UpdateCheckerDeps {
  currentVersion: string
  /** Avisa o renderer (evento `update-status`). */
  onStatus?: (status: UpdateStatus) => void
  fetch?: FetchLike
  log?: (msg: string) => void
}

export interface UpdateChecker {
  status(): UpdateStatus
  /** Checa agora (chamadas simultâneas compartilham a mesma request). */
  check(): Promise<UpdateStatus>
  start(): void
  stop(): void
}

export function createUpdateChecker(deps: UpdateCheckerDeps): UpdateChecker {
  const doFetch: FetchLike = deps.fetch ?? ((url, init) => fetch(url, init))
  const log = deps.log ?? ((m: string) => console.warn(`[clearchat] atualizações: ${m}`))
  let status: UpdateStatus = { current: deps.currentVersion, state: 'idle' }
  let inflight: Promise<UpdateStatus> | null = null
  let firstTimer: ReturnType<typeof setTimeout> | null = null
  let interval: ReturnType<typeof setInterval> | null = null

  const publish = (next: UpdateStatus): UpdateStatus => {
    status = next
    deps.onStatus?.(status)
    return status
  }

  const fail = (reason: string): UpdateStatus => {
    log(reason)
    // mantém a última release conhecida: uma falha passageira não some com o aviso
    return publish({ ...status, state: 'error', error: reason, checkedAt: Date.now() })
  }

  const run = async (): Promise<UpdateStatus> => {
    publish({ ...status, state: 'checking', error: undefined })
    let res: Response
    try {
      res = await doFetch(LATEST_RELEASE_API, {
        // a API do GitHub exige User-Agent; sem versão nem identificação do usuário
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'ClearChat' },
        signal: AbortSignal.timeout(15_000)
      })
    } catch (e) {
      return fail(`sem conexão com o GitHub (${e instanceof Error ? e.message : String(e)})`)
    }
    if (res.status === 403 || res.status === 429) return fail('limite da API do GitHub atingido')
    if (res.status === 404) return fail('nenhuma release publicada')
    if (!res.ok) return fail(`GitHub respondeu HTTP ${res.status}`)
    let json: unknown
    try {
      json = await res.json()
    } catch {
      return fail('resposta inválida do GitHub')
    }
    const latest = parseLatestRelease(json)
    if (!latest) return fail('release sem versão válida')
    return publish({
      current: deps.currentVersion,
      state: isNewer(latest, deps.currentVersion) ? 'available' : 'latest',
      latest,
      checkedAt: Date.now()
    })
  }

  const check = (): Promise<UpdateStatus> =>
    (inflight ??= run()
      .catch((e) => fail(String(e)))
      .finally(() => {
        inflight = null
      }))

  return {
    status: () => status,
    check,
    start() {
      if (firstTimer || interval) return
      firstTimer = setTimeout(() => {
        firstTimer = null
        void check()
      }, UPDATE_FIRST_CHECK_MS)
      interval = setInterval(() => void check(), UPDATE_INTERVAL_MS)
      // não segura o processo aberto (testes / quit)
      firstTimer.unref?.()
      interval.unref?.()
    },
    stop() {
      if (firstTimer) clearTimeout(firstTimer)
      if (interval) clearInterval(interval)
      firstTimer = interval = null
    }
  }
}

// ---- instância do app (index.ts inicia; ipc.ts consulta) ----
let instance: UpdateChecker | null = null

/** `auto: false` (testes com userData isolado): sem checagem automática — só o botão manual. */
export function initUpdates(deps: UpdateCheckerDeps, { auto = true } = {}): UpdateChecker {
  instance?.stop()
  instance = createUpdateChecker(deps)
  if (auto) instance.start()
  return instance
}

export function updateChecker(): UpdateChecker | null {
  return instance
}

export function shutdownUpdates(): void {
  instance?.stop()
}
