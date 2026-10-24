// Helpers PUROS da UI do "Modo avançado (GPU local)" (SPEC → "Áudio → Modo avançado (GPU local)"):
// veredito do hardware, ordem dos motores, compat → estado do botão, rótulos (pt-BR, tamanho,
// latência), agrupamento das vozes, voz padrão, problemas de prontidão (painéis de Fala/Transcrição
// e pré-checagem da chamada) e o WAV da amostra de voz. Sem DOM, sem React, sem `window` — testado
// em `e2e/gpuModeUi.test.ts`. Só `import type` de `./types` (que toca `window.api`).
import {
  DEFAULT_TTS_GPU,
  GPU_ENGINE_PARAMS,
  GPU_SERVER_IDLE_EXIT_MIN,
  gpuEnginesLabel,
  normalizeGpuParamOverrides,
  normalizeGpuParamValue,
  resolveGpuParams,
  type GpuParamSpec,
  type GpuParamValue,
  type GpuParamValues
} from '@shared/gpuVoice'
import type {
  GpuCompatLevel,
  GpuEngineId,
  GpuEngineStatus,
  GpuStatus,
  GpuTtsEngineId,
  GpuVoice,
  SttSettingsGpu,
  TtsGpuConfig,
  TtsSettingsGpu
} from './types'

/** Ordem fixa da lista (a favorita primeiro; transcrição por último). */
export const GPU_ENGINE_ORDER: readonly GpuEngineId[] = [
  'omnivoice',
  'xtts-v2',
  'vibevoice-realtime',
  'qwen3-tts-0.6b',
  'qwen3-tts-1.7b',
  'whisper-large-v3-turbo'
]

/** Passos padrão do OmniVoice ("16 soa igual a 32", metade do tempo). */
export const OMNIVOICE_DEFAULT_STEPS = 16
export const OMNIVOICE_STEPS = [16, 32] as const

/** Motores que NÃO clonam voz (só as vozes embutidas). */
const NO_CLONING: ReadonlySet<GpuEngineId> = new Set([
  'vibevoice-realtime',
  'whisper-large-v3-turbo'
])
/** Motores que precisam da transcrição da referência para clonar. */
const NEEDS_TRANSCRIPT: ReadonlySet<GpuEngineId> = new Set(['qwen3-tts-0.6b', 'qwen3-tts-1.7b'])

export const engineClones = (e: Pick<GpuEngineStatus, 'id' | 'kind'>): boolean =>
  e.kind === 'tts' && !NO_CLONING.has(e.id)
export const engineNeedsTranscript = (id: GpuEngineId): boolean => NEEDS_TRANSCRIPT.has(id)

/** Motores na ordem da UI (desconhecidos no fim, na ordem recebida). */
export function sortGpuEngines<T extends { id: string }>(engines: readonly T[]): T[] {
  const rank = (id: string): number => {
    const i = GPU_ENGINE_ORDER.indexOf(id as GpuEngineId)
    return i < 0 ? GPU_ENGINE_ORDER.length : i
  }
  return engines
    .map((e, i) => ({ e, i }))
    .sort((a, b) => rank(a.e.id) - rank(b.e.id) || a.i - b.i)
    .map((x) => x.e)
}

// ---------------- números legíveis ----------------

const brNum = (n: number, decimals: number): string =>
  n.toFixed(decimals).replace(/\.0+$/, '').replace('.', ',')

/** MB → "512 MB" / "1,6 GB" / "12 GB" (1 GB = 1024 MB). null/inválido → "—". */
export function formatMb(mb: number | null | undefined): string {
  if (mb == null || !Number.isFinite(mb) || mb < 0) return '—'
  if (mb < 1024) return `${Math.round(mb)} MB`
  return `${brNum(mb / 1024, 1)} GB`
}

/** Latência: < 250 ms em ms arredondado a 10 ("~120 ms"); senão segundos com 1 casa ("~0,6 s"). */
export function formatLatency(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 250) return `~${Math.max(10, Math.round(ms / 10) * 10)} ms`
  return `~${brNum(ms / 1000, 1)} s`
}

/** Linha da medição do último teste ("~0,6 s até o 1º áudio · 6× tempo real"). */
export function measuredLine(
  kind: 'tts' | 'stt',
  m: { firstAudioMs: number; rtf: number }
): string {
  const lat = formatLatency(m.firstAudioMs)
  if (kind === 'stt') return `${lat} por frase`
  const x = m.rtf > 0 ? 1 / m.rtf : 0
  const speed = x > 0 ? ` · ${brNum(x, x < 10 ? 1 : 0)}× o tempo real` : ''
  return `${lat} até o 1º áudio${speed}`
}

// ---------------- badges ----------------

export type Tone = 'success' | 'warning' | 'danger' | 'neutral' | 'accent'

export const PT_BR_BADGE: Record<
  GpuEngineStatus['ptBR'],
  { label: string; tone: Tone; help: string }
> = {
  native: { label: 'pt-BR nativo', tone: 'success', help: 'Fala pt-BR com sotaque brasileiro.' },
  ok: {
    label: 'pt-BR bom',
    tone: 'success',
    help: 'pt-BR inteligível; o sotaque segue a voz de referência (clonagem).'
  },
  'pt-PT-accent': {
    label: 'sotaque de Portugal',
    tone: 'warning',
    help: 'Sem uma referência brasileira o sotaque puxa para o português europeu; clonando uma voz brasileira (a voz livre CC0 é baixada junto ao instalar) o sotaque fica brasileiro.'
  },
  experimental: {
    label: 'pt-BR experimental',
    tone: 'warning',
    help: 'O modelo é treinado sobretudo em inglês: pronúncia pt-BR irregular em algumas palavras.'
  }
}

export interface CompatUi {
  level: GpuCompatLevel
  badge: string
  tone: Tone
  /** Pode instalar (bloqueado = não). */
  canInstall: boolean
  /** Instalar pede confirmação (aviso: pode não rodar bem). */
  confirm: boolean
  /** Motivos em uma linha (vazio quando ok). */
  reason: string
}

/** compat do motor → estado da UI (badge, botão, confirmação). */
export function compatUi(compat: GpuEngineStatus['compat'] | undefined): CompatUi {
  const reasons = compat?.reasons?.filter((r) => r.trim()) ?? []
  const reason = reasons.join(' · ')
  switch (compat?.level) {
    case 'blocked':
      return {
        level: 'blocked',
        badge: 'incompatível',
        tone: 'danger',
        canInstall: false,
        confirm: false,
        reason: reason || 'incompatível com este computador'
      }
    case 'warn':
      return {
        level: 'warn',
        badge: 'pode não rodar bem',
        tone: 'warning',
        canInstall: true,
        confirm: true,
        reason
      }
    default:
      return {
        level: 'ok',
        badge: 'compatível',
        tone: 'success',
        canInstall: true,
        confirm: false,
        reason
      }
  }
}

// ---------------- veredito do hardware ----------------

export interface HardwareVerdict {
  level: GpuCompatLevel
  title: string
  details: string[]
}

/** Espaço livre mínimo além do download (descompactação, cache). */
const DISK_MARGIN_MB = 2048
/** Download típico do runtime quando o status ainda não sabe o tamanho. */
export const RUNTIME_TYPICAL_MB = 8 * 1024

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

/**
 * Veredito geral do computador para o modo GPU: bloqueado só quando NADA roda (todos os motores
 * ou o próprio runtime incompatíveis); sem NVIDIA = aviso (CPU, lento); Apple = experimental.
 */
export function hardwareVerdict(s: GpuStatus): HardwareVerdict {
  const engines = s.engines
  const blocked = engines.filter((e) => e.compat.level === 'blocked')
  const warned = engines.filter((e) => e.compat.level === 'warn')
  const nvidia = s.gpus.find((g) => g.vendor === 'nvidia') ?? null
  const apple =
    s.gpus.find((g) => g.vendor === 'apple') ??
    (s.platform.os === 'darwin' && s.platform.arch === 'arm64' ? { name: 'Apple Silicon' } : null)
  const details: string[] = []
  let level: GpuCompatLevel
  let title: string

  if (
    s.runtime.compat?.level === 'blocked' ||
    (engines.length > 0 && blocked.length === engines.length)
  ) {
    const why =
      s.runtime.compat?.level === 'blocked'
        ? s.runtime.compat.reasons[0]
        : (blocked[0]?.compat.reasons[0] ?? 'nenhum motor roda neste computador')
    return {
      level: 'blocked',
      title: `Incompatível: ${why ?? 'este computador não roda o modo GPU'}`,
      details
    }
  }
  if (!nvidia && apple) {
    level = 'warn'
    title = `${apple.name}: suporte experimental — roda pelo Metal (MPS), mais lento que uma GPU NVIDIA`
  } else if (!nvidia) {
    level = 'warn'
    title = 'Sem GPU NVIDIA — vai rodar na CPU, lento para chamada'
  } else if (!blocked.length && !warned.length) {
    level = 'ok'
    title = 'Sua GPU roda todos os motores'
  } else {
    level = 'warn'
    const ok = engines.length - blocked.length - warned.length
    title = `Sua GPU roda ${ok} de ${engines.length} motores sem ressalvas`
    if (warned.length)
      details.push(`${plural(warned.length, 'motor pode', 'motores podem')} não rodar bem`)
    if (blocked.length)
      details.push(
        `${plural(blocked.length, 'motor bloqueado', 'motores bloqueados')}: ${blocked.map((e) => e.label).join(', ')}`
      )
  }
  // a VRAM do próprio servidor do app não conta como "ocupada por outros"
  if (nvidia && nvidia.vramFreeMb != null && nvidia.vramFreeMb + (nvidia.vramOwnMb ?? 0) < 3072)
    details.push(
      `Pouca VRAM livre agora (${formatMb(nvidia.vramFreeMb)}) — feche jogos/apps que usam a GPU`
    )
  const need = s.runtime.state === 'installed' ? 0 : (s.runtime.sizeMb ?? RUNTIME_TYPICAL_MB)
  if (s.platform.diskFreeMb < need + DISK_MARGIN_MB) {
    details.push(
      `Pouco espaço em disco: ${formatMb(s.platform.diskFreeMb)} livres${need ? ` (o runtime pede ~${formatMb(need)})` : ''}`
    )
    if (level === 'ok') level = 'warn'
  }
  return { level, title, details }
}

// ---------------- ações ----------------

export interface EngineActionUi {
  action: 'install' | 'cancel' | 'remove' | 'reinstall'
  label: string
  disabled: boolean
  /** Por que está desabilitado (texto visível ao lado/no tooltip). */
  why: string | null
  /** Nota visível sem desabilitar (ex.: o runtime é baixado junto). */
  note?: string | null
}

/** Botão principal do card do motor (estado de instalação × compat × runtime). */
export function engineAction(
  e: Pick<GpuEngineStatus, 'install' | 'compat'>,
  runtimeInstalled: boolean,
  otherBusy: boolean
): EngineActionUi {
  const c = compatUi(e.compat)
  switch (e.install.state) {
    case 'installing':
      return { action: 'cancel', label: 'Cancelar', disabled: false, why: null }
    case 'installed':
      return { action: 'remove', label: 'Remover', disabled: false, why: null }
    case 'broken':
    case 'absent': {
      const label = e.install.state === 'broken' ? 'Reinstalar' : 'Instalar'
      const action = e.install.state === 'broken' ? 'reinstall' : 'install'
      if (!c.canInstall) return { action, label, disabled: true, why: c.reason }
      if (otherBusy)
        return { action, label, disabled: true, why: 'aguarde a instalação em andamento' }
      // sem o runtime o backend o instala antes do motor (um clique só)
      return {
        action,
        label,
        disabled: false,
        why: null,
        note: runtimeInstalled ? null : 'baixa o runtime junto na primeira instalação'
      }
    }
  }
}

/** Percentual 0–100 arredondado; null = indeterminado. */
export function progressPct(p: { pct: number | null } | undefined): number | null {
  if (!p || p.pct == null || !Number.isFinite(p.pct)) return null
  const v = p.pct <= 1 && p.pct > 0 && !Number.isInteger(p.pct) ? p.pct * 100 : p.pct
  return Math.max(0, Math.min(100, Math.round(v)))
}

/** Alguma instalação (runtime ou motor) em andamento. */
export const gpuBusy = (s: GpuStatus | null): boolean =>
  !!s &&
  (s.runtime.state === 'installing' || s.engines.some((e) => e.install.state === 'installing'))

// ---------------- vozes ----------------

export interface GpuVoiceGroup {
  key: GpuVoice['source']
  title: string
  voices: GpuVoice[]
}

const ACCENT_RANK: Record<string, number> = { 'pt-BR': 0, other: 1, 'pt-PT': 2 }
const collator = new Intl.Collator('pt-BR', { sensitivity: 'base', numeric: true })

/**
 * Vozes do motor em 3 grupos: "Vozes do modelo" (embutidas — pt-BR primeiro, pt-PT por último),
 * "Voz pt-BR livre (CC0)" e "Minhas vozes" (clonadas pelo usuário, por nome). Motor que não clona
 * só tem o 1º grupo; grupos de clonagem aparecem mesmo vazios (a UI oferece baixar/gravar).
 */
export function groupGpuVoices(
  e: Pick<GpuEngineStatus, 'id' | 'kind' | 'voices'>
): GpuVoiceGroup[] {
  const by = (src: GpuVoice['source']): GpuVoice[] => e.voices.filter((v) => v.source === src)
  const builtin = by('builtin').sort(
    (a, b) =>
      (ACCENT_RANK[a.accent ?? 'other'] ?? 1) - (ACCENT_RANK[b.accent ?? 'other'] ?? 1) ||
      collator.compare(a.label, b.label)
  )
  const groups: GpuVoiceGroup[] = []
  if (builtin.length || !engineClones(e))
    groups.push({ key: 'builtin', title: 'Vozes do modelo', voices: builtin })
  if (engineClones(e)) {
    groups.push({ key: 'cc0', title: 'Voz pt-BR livre (CC0)', voices: by('cc0') })
    groups.push({
      key: 'user',
      title: 'Minhas vozes',
      voices: by('user').sort((a, b) => collator.compare(a.label, b.label))
    })
  }
  return groups
}

/** Vozes do usuário (deduplicadas — o backend lista a mesma voz em cada motor que clona). */
export function userVoicesOf(status: Pick<GpuStatus, 'engines'> | null): GpuVoice[] {
  const seen = new Map<string, GpuVoice>()
  for (const e of status?.engines ?? [])
    for (const v of e.voices) if (v.source === 'user' && !seen.has(v.id)) seen.set(v.id, v)
  return [...seen.values()].sort((a, b) => collator.compare(a.label, b.label))
}

/** Voz sugerida ao escolher um motor: CC0 pt-BR → embutida pt-BR → minha → embutida qualquer. */
export function defaultGpuVoice(e: Pick<GpuEngineStatus, 'voices'>): string | null {
  const v =
    e.voices.find((x) => x.source === 'cc0') ??
    e.voices.find((x) => x.source === 'builtin' && x.accent === 'pt-BR') ??
    e.voices.find((x) => x.source === 'user') ??
    e.voices.find((x) => x.source === 'builtin' && x.accent !== 'pt-PT') ??
    e.voices[0]
  return v?.id ?? null
}

/** Motores de fala instalados (na ordem da UI). */
export const installedTtsEngines = (s: GpuStatus | null): GpuEngineStatus[] =>
  s
    ? sortGpuEngines(s.engines.filter((e) => e.kind === 'tts' && e.install.state === 'installed'))
    : []

/** Config da GPU ao escolher (ou trocar de) motor: mantém a voz que existe no motor novo. */
export function gpuConfigFor(
  engine: GpuEngineStatus,
  prev: TtsGpuConfig | null | undefined
): TtsGpuConfig {
  const keep = prev?.voice && engine.voices.some((v) => v.id === prev.voice) ? prev.voice : null
  return {
    engine: engine.id as GpuTtsEngineId,
    voice: keep ?? defaultGpuVoice(engine),
    ...(engine.id === 'omnivoice'
      ? { steps: prev?.steps ?? engine.options?.steps ?? OMNIVOICE_DEFAULT_STEPS }
      : {}),
    // os parâmetros são por motor: trocar de motor não perde os de nenhum
    ...(prev?.params ? { params: prev.params } : {})
  }
}

// ---------------- parâmetros por motor ----------------

export interface GpuParamRow {
  spec: GpuParamSpec
  value: GpuParamValue
  /** Diferente do padrão. */
  changed: boolean
  /** Valor legível ("1,15×", "0,75", "ligado", "Português"). */
  display: string
  defaultDisplay: string
}

/** Valor de parâmetro legível (pt-BR; velocidade com "×"). */
export function formatGpuParam(spec: GpuParamSpec, v: GpuParamValue): string {
  if (spec.kind === 'boolean') return v ? 'ligado' : 'desligado'
  if (spec.kind === 'select') return spec.options?.find((o) => o.value === v)?.label ?? String(v)
  const n = typeof v === 'number' ? v : Number(v)
  const t = n.toFixed(spec.decimals ?? 2).replace('.', ',')
  return spec.key === 'speed' ? `${t}×` : t
}

/** Linhas do editor de parâmetros de um motor (valor atual, padrão, mudou?). */
export function gpuParamRows(id: GpuEngineId, overrides: unknown): GpuParamRow[] {
  const cur = resolveGpuParams(id, overrides)
  return (GPU_ENGINE_PARAMS[id] ?? []).map((spec) => ({
    spec,
    value: cur[spec.key],
    changed: cur[spec.key] !== spec.default,
    display: formatGpuParam(spec, cur[spec.key]),
    defaultDisplay: formatGpuParam(spec, spec.default)
  }))
}

/** Overrides com `key` = `value` (limitado à faixa; voltar ao padrão tira a chave). */
export function setGpuParam(
  id: GpuEngineId,
  overrides: unknown,
  key: string,
  value: unknown
): GpuParamValues {
  const base = normalizeGpuParamOverrides(id, overrides)
  const spec = (GPU_ENGINE_PARAMS[id] ?? []).find((s) => s.key === key)
  if (!spec) return base
  const v = normalizeGpuParamValue(spec, value)
  if (v === undefined) return base
  const next = { ...base, [key]: v }
  return normalizeGpuParamOverrides(id, next)
}

/** `ttsSettings` com os parâmetros de um motor de fala (vazio = padrão: a chave sai). */
export function ttsWithGpuParams(
  tts: TtsSettingsGpu,
  id: GpuTtsEngineId,
  overrides: GpuParamValues
): TtsSettingsGpu {
  const gpu = tts.gpu ?? { ...DEFAULT_TTS_GPU }
  const all = { ...(gpu.params ?? {}) }
  const o = normalizeGpuParamOverrides(id, overrides)
  if (Object.keys(o).length) all[id] = o
  else delete all[id]
  const rest = { ...gpu }
  delete rest.params
  return { ...tts, gpu: { ...rest, ...(Object.keys(all).length ? { params: all } : {}) } }
}

/** `sttSettings` com os parâmetros do whisper (vazio = padrão: a chave sai). */
export function sttWithGpuParams(stt: SttSettingsGpu, overrides: GpuParamValues): SttSettingsGpu {
  const o = normalizeGpuParamOverrides('whisper-large-v3-turbo', overrides)
  return {
    ...stt,
    gpu: {
      engine: 'whisper-large-v3-turbo',
      ...(Object.keys(o).length ? { params: o } : {})
    }
  }
}

/** Overrides salvos de um motor (fala → `ttsSettings.gpu.params[id]`; whisper → `sttSettings.gpu.params`). */
export function savedGpuParams(
  id: GpuEngineId,
  tts: TtsSettingsGpu | null,
  stt: SttSettingsGpu | null
): GpuParamValues {
  return id === 'whisper-large-v3-turbo'
    ? normalizeGpuParamOverrides(id, stt?.gpu?.params)
    : normalizeGpuParamOverrides(id, tts?.gpu?.params?.[id as GpuTtsEngineId])
}

// ---------------- prontidão ----------------

export interface GpuProblem {
  /** error = a chamada/síntese não funciona; warn = funciona com ressalva; info = só avisa. */
  level: 'error' | 'warn' | 'info'
  text: string
}

const WHERE = 'Configurações → Áudio → Modelos locais'

function runtimeProblems(s: GpuStatus): GpuProblem[] {
  if (s.runtime.state === 'installed') return []
  if (s.runtime.state === 'installing')
    return [{ level: 'error', text: `o runtime ainda está sendo instalado (${WHERE})` }]
  if (s.runtime.state === 'broken')
    return [
      {
        level: 'error',
        text: `o runtime está com problema${s.runtime.error ? ` (${firstLine(s.runtime.error)})` : ''} — reinstale em ${WHERE}`
      }
    ]
  return [{ level: 'error', text: `instale o runtime em ${WHERE}` }]
}

const firstLine = (t: string): string => {
  const l = t.split('\n').find((x) => x.trim()) ?? t
  return l.length > 140 ? `${l.slice(0, 139)}…` : l
}

function engineProblems(e: GpuEngineStatus | undefined, id: string, s: GpuStatus): GpuProblem[] {
  if (!e)
    return [{ level: 'error', text: `o motor “${id}” não existe nesta versão — escolha outro` }]
  const out: GpuProblem[] = []
  if (e.compat.level === 'blocked')
    out.push({
      level: 'error',
      text: `${e.label} não roda neste computador: ${compatUi(e.compat).reason}`
    })
  else if (e.install.state === 'absent')
    out.push({ level: 'error', text: `instale o motor ${e.label} em ${WHERE}` })
  else if (e.install.state === 'installing')
    out.push({ level: 'error', text: `${e.label} ainda está sendo instalado (${WHERE})` })
  else if (e.install.state === 'broken')
    out.push({
      level: 'error',
      text: `${e.label} está com problema${e.install.error ? ` (${firstLine(e.install.error)})` : ''} — reinstale em ${WHERE}`
    })
  else if (e.compat.level === 'warn')
    out.push({ level: 'warn', text: `${e.label} pode não rodar bem: ${compatUi(e.compat).reason}` })
  if (!out.some((p) => p.level === 'error')) {
    // falha anterior não barra: o próximo uso sobe o servidor de novo (o erro de agora, se
    // houver, encerra a chamada com o motivo)
    if (s.server.state === 'error')
      out.push({
        level: 'warn',
        text: `o servidor local da GPU falhou da última vez${s.server.error ? ` (${firstLine(s.server.error)})` : ''} — ele tenta subir de novo no próximo uso`
      })
    else if (s.server.state === 'stopped')
      out.push({
        level: 'info',
        text: 'o servidor local liga sozinho ao usar (a chamada espera alguns segundos enquanto a GPU carrega o modelo)'
      })
    else if (s.server.state === 'starting')
      out.push({ level: 'info', text: 'o servidor local está carregando os modelos…' })
  }
  return out
}

/** Problemas da fala pela GPU (painel de Fala e pré-checagem da chamada). */
export function gpuTtsProblems(tts: TtsSettingsGpu, s: GpuStatus | null | undefined): GpuProblem[] {
  if (tts.backend !== 'gpu') return []
  if (!s) return [{ level: 'error', text: 'o modo GPU local não está disponível neste build' }]
  const rt = runtimeProblems(s)
  if (rt.length) return rt
  const cfg = tts.gpu
  if (!cfg?.engine)
    return [{ level: 'error', text: `escolha um motor de fala instalado (${WHERE})` }]
  const e = s.engines.find((x) => x.id === cfg.engine)
  const out = engineProblems(e, cfg.engine, s)
  if (e && e.install.state === 'installed') {
    if (cfg.voice && !e.voices.some((v) => v.id === cfg.voice))
      out.unshift({ level: 'error', text: 'a voz escolhida não existe mais — escolha outra voz' })
    else if (!cfg.voice && !e.voices.some((v) => v.source === 'builtin') && engineClones(e))
      out.unshift({
        level: 'error',
        text: `${e.label} precisa de uma voz de referência — baixe a voz pt-BR livre ou grave a sua`
      })
    else if (cfg.voice && engineNeedsTranscript(e.id)) {
      const v = e.voices.find((x) => x.id === cfg.voice)
      if (v?.accent === 'pt-PT')
        out.push({ level: 'warn', text: `a voz “${v.label}” tem sotaque de Portugal` })
    }
  }
  return out
}

/** Problemas da transcrição pela GPU (painel de Transcrição e pré-checagem da chamada). */
export function gpuSttProblems(stt: SttSettingsGpu, s: GpuStatus | null | undefined): GpuProblem[] {
  if (stt.mode !== 'gpu') return []
  if (!s) return [{ level: 'error', text: 'o modo GPU local não está disponível neste build' }]
  const rt = runtimeProblems(s)
  if (rt.length) return rt
  const id = stt.gpu?.engine ?? 'whisper-large-v3-turbo'
  return engineProblems(
    s.engines.find((x) => x.id === id),
    id,
    s
  )
}

// ---------------- amostra de voz (WAV) ----------------

/** PCM16 mono → WAV (RIFF, 44 bytes de cabeçalho). */
export function pcm16ToWav(pcm: Int16Array, sampleRate: number): ArrayBuffer {
  const buf = new ArrayBuffer(44 + pcm.length * 2)
  const v = new DataView(buf)
  const str = (o: number, s: string): void => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i))
  }
  str(0, 'RIFF')
  v.setUint32(4, 36 + pcm.length * 2, true)
  str(8, 'WAVE')
  str(12, 'fmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true) // PCM
  v.setUint16(22, 1, true) // mono
  v.setUint32(24, sampleRate, true)
  v.setUint32(28, sampleRate * 2, true)
  v.setUint16(32, 2, true)
  v.setUint16(34, 16, true)
  str(36, 'data')
  v.setUint32(40, pcm.length * 2, true)
  new Int16Array(buf, 44).set(pcm)
  return buf
}

/** Faixa recomendada da amostra de voz para clonar (s). */
export const CLONE_MIN_S = 3
export const CLONE_IDEAL_MIN_S = 6
export const CLONE_IDEAL_MAX_S = 10
export const CLONE_MAX_S = 30

/** Aviso (ou erro) da duração da amostra; null = boa. */
export function sampleDurationProblem(
  seconds: number
): { level: 'error' | 'warn'; text: string } | null {
  if (!Number.isFinite(seconds) || seconds <= 0) return { level: 'error', text: 'amostra vazia' }
  if (seconds < CLONE_MIN_S)
    return {
      level: 'error',
      text: `amostra curta demais (${brNum(seconds, 1)} s) — grave pelo menos ${CLONE_MIN_S} s`
    }
  if (seconds > CLONE_MAX_S)
    return {
      level: 'error',
      text: `amostra longa demais (${brNum(seconds, 0)} s) — use até ${CLONE_MAX_S} s (o ideal é ${CLONE_IDEAL_MIN_S}–${CLONE_IDEAL_MAX_S} s)`
    }
  if (seconds < CLONE_IDEAL_MIN_S || seconds > CLONE_IDEAL_MAX_S + 5)
    return {
      level: 'warn',
      text: `${brNum(seconds, 1)} s — o ideal é ${CLONE_IDEAL_MIN_S}–${CLONE_IDEAL_MAX_S} s de fala limpa`
    }
  return null
}

/** Frase sugerida para gravar (~8 s lida em ritmo normal, sons variados do pt-BR). */
export const CLONE_SUGGESTED_TEXT =
  'Olá! Esta é a minha voz para o ClearChat. Hoje o dia está bonito, e eu vou ler este texto com calma, sem pressa, do jeito que eu falo no dia a dia.'

/** Arquivos aceitos no upload da amostra. */
export const CLONE_ACCEPT = '.wav,.mp3,.ogg,.oga,.opus,.webm,.m4a,audio/*'

// ---------------- servidor local: linha de status (só leitura) ----------------

export interface GpuServerLine {
  state: GpuStatus['server']['state']
  /** "parado" / "iniciando — Aquecendo OmniVoice…" / "em uso por: OmniVoice + Whisper" / "falhou da última vez". */
  text: string
  /** Complemento discreto (ciclo de vida). */
  hint: string
}

/** Linha de status do servidor local (sem botões de Iniciar: ele liga sozinho quando precisa). */
export function gpuServerLine(s: Pick<GpuStatus, 'server'>): GpuServerLine {
  const sv = s.server
  const idle = `desliga após ${GPU_SERVER_IDLE_EXIT_MIN} min sem uso`
  switch (sv.state) {
    case 'starting':
      return {
        state: sv.state,
        text: `iniciando${sv.phase ? ` — ${sv.phase}` : '…'}`,
        hint: idle
      }
    case 'running':
      return {
        state: sv.state,
        text: sv.engines.length ? `em uso por: ${gpuEnginesLabel(sv.engines)}` : 'ligado',
        hint: idle
      }
    case 'error':
      return {
        state: sv.state,
        text: 'falhou da última vez',
        hint: 'tenta de novo sozinho no próximo uso'
      }
    default:
      return { state: 'stopped', text: 'parado', hint: `liga sozinho quando precisa, ${idle}` }
  }
}

// ---------------- chamada/ditado com a GPU: plano (aviso de uso + VRAM livre) ----------------

export interface GpuCallPlan {
  /** Motores que a chamada usa (fala `gpu` e/ou transcrição `gpu`). */
  engines: GpuEngineId[]
  /** Os que ainda não estão no servidor rodando (vão carregar agora). */
  toLoad: GpuEngineId[]
  /** Precisa subir/aquecer o servidor ("Preparando a GPU…"). */
  needsStart: boolean
  /** VRAM dos motores que vão carregar (MB — medida do lab, contexto CUDA incluso). */
  vramNeedMb: number
  /** VRAM livre agora (nvidia-smi do status), null = sem NVIDIA/desconhecida. */
  vramFreeMb: number | null
  /** Nome curto da GPU ("RTX 3080 Ti"); null = sem NVIDIA. */
  gpuName: string | null
  /** "A chamada vai usar sua GPU (RTX 3080 Ti) — ~3,7 GB de VRAM"; null = nada a avisar. */
  notice: string | null
  /** Pouca VRAM livre (avisa, não barra); null = ok. */
  warning: string | null
}

/** "NVIDIA GeForce RTX 3080 Ti" → "RTX 3080 Ti". */
export const shortGpuName = (name: string): string =>
  name
    .replace(/^NVIDIA\s+/i, '')
    .replace(/^GeForce\s+/i, '')
    .trim() || name

/**
 * O que a chamada (ou o ditado — `what`) vai pedir da GPU: motores, quais ainda carregam, VRAM
 * necessária × livre agora (outro programa — um jogo — pode estar usando) e os textos do aviso.
 * Pouca VRAM = AVISO (a chamada continua; OOM de verdade encerra com o motivo).
 */
export function gpuCallPlan(
  tts: TtsSettingsGpu,
  stt: SttSettingsGpu,
  s: GpuStatus | null | undefined,
  what: 'chamada' | 'ditado' = 'chamada'
): GpuCallPlan | null {
  const engines: GpuEngineId[] = []
  if (tts.backend === 'gpu') engines.push(tts.gpu?.engine ?? 'omnivoice')
  if (stt.mode === 'gpu') engines.push('whisper-large-v3-turbo')
  if (!engines.length || !s) return null
  const running = s.server.state === 'running' ? s.server.engines : []
  const toLoad = engines.filter(
    (id) => !running.includes(id) && !s.engines.find((e) => e.id === id)?.vram?.loaded
  )
  const vramNeedMb = toLoad.reduce(
    (n, id) => n + (s.engines.find((e) => e.id === id)?.vramMb ?? 0),
    0
  )
  const nv = s.gpus
    .filter((g) => g.vendor === 'nvidia')
    .reduce<GpuStatus['gpus'][number] | null>(
      (a, b) => (!a || (b.vramTotalMb ?? 0) > (a.vramTotalMb ?? 0) ? b : a),
      null
    )
  const gpuName = nv ? shortGpuName(nv.name) : null
  // livre agora + o que o app libera ao trocar de motor (os processos dele de outros grupos)
  const tts0 = toLoad.map((id) => s.engines.find((e) => e.id === id)).find((e) => e?.kind === 'tts')
  const avail = tts0?.vram?.availMb ?? null
  const vramFreeMb =
    nv?.vramFreeMb == null ? null : avail != null ? Math.max(avail, nv.vramFreeMb) : nv.vramFreeMb
  const label = what === 'chamada' ? 'A chamada' : 'O ditado'
  const notice = !toLoad.length
    ? null
    : nv
      ? `${label} vai usar sua GPU (${gpuName})${vramNeedMb ? ` — ~${formatMb(vramNeedMb)} de VRAM` : ''}`
      : `${label} vai rodar ${gpuEnginesLabel(toLoad)} sem GPU NVIDIA (na CPU) — lento`
  const warning =
    toLoad.length && vramFreeMb != null && vramNeedMb > 0 && vramFreeMb < vramNeedMb
      ? `Pouca VRAM livre (${formatMb(vramFreeMb)} de ${formatMb(vramNeedMb)}) — a ${what} pode falhar ou ficar lenta; feche outros programas que usam a GPU`
      : null
  return {
    engines,
    toLoad,
    needsStart: toLoad.length > 0,
    vramNeedMb,
    vramFreeMb,
    gpuName,
    notice,
    warning
  }
}
