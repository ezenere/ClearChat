// Clipes de interjeição/filler da chamada de voz (SPEC → "Áudio → Serviço de TTS (clipes)"):
// falas curtas pré-geradas pela voz configurada e cacheadas em
// `<userData>/voice-clips/<voiceId>/<CLASSE>_<n>.wav`, com manifest por voz (id, engine, modelo,
// hash da definição). A Feature B consome via `resolveClip` (latência zero depois de gerados) e a
// regeneração acontece quando a voz muda (voiceId próprio por voz) ou o hash da definição muda.
// Sem Electron/UI/IPC; síntese via `synthesize` de `tts.ts` (motor local injetado ou API).
import { createSHA256 } from 'hash-wasm'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { TtsSettings } from '@shared/voice'
import { synthesize, type TtsLocalBackend } from './tts'

/** Classes de clipes (whitelist de nomes de arquivo — nada fora daqui vira arquivo). */
export type ClipClass = 'ACK' | 'AGREEMENT' | 'ENCOURAGEMENT' | 'THINKING' | 'FILLER'
export const CLIP_CLASSES: readonly ClipClass[] = [
  'ACK',
  'AGREEMENT',
  'ENCOURAGEMENT',
  'THINKING',
  'FILLER'
]

/** Variantes por classe (3 cada — o índice vira o `<n>` do nome do arquivo). */
export const CLIP_VARIANTS = 3

/** Frases curtas (pt-BR) por classe, na ordem das variantes. */
export const CLIP_PHRASES: Readonly<Record<ClipClass, readonly [string, string, string]>> = {
  ACK: ['Uhum.', 'Aham.', 'Entendi.'],
  AGREEMENT: ['Sim.', 'Certo.', 'É isso aí.'],
  ENCOURAGEMENT: ['Isso!', 'Boa!', 'Pode seguir.'],
  THINKING: ['Hum...', 'Deixa eu pensar...', 'Hmm, deixa eu ver...'],
  FILLER: ['Só um minutinho que eu tô vendo isso.', 'Deixa eu ver isso com calma.', 'Um instante.']
}

/** Um clipe gerado (registro do manifest). */
export interface VoiceClip {
  /** Id estável: `<CLASSE>_<n>`. */
  id: string
  /** Nome do arquivo dentro da pasta da voz (sempre `clipFileName`). */
  file: string
  class: ClipClass
  /** Variante 1..`CLIP_VARIANTS`. */
  n: number
  text: string
}

/** Manifest de clipes de uma voz (`<userData>/voice-clips/<voiceId>/manifest.json`). */
export interface ClipsManifest {
  /** Voz dona do cache (mesmo id de `clipVoiceId`). */
  voiceId: string
  backend: 'api' | 'local'
  /** Motor local ('kokoro'); null no backend de API. */
  engine: string | null
  /** Modelo/voz usados (informativo; nunca guarda chave de API). */
  model: string
  /** sha256 da definição (frases + voz + modelo) — mudou → os clipes são regerados. */
  hash: string
  generatedAt: string
  clips: VoiceClip[]
}

export interface GenerateClipsOptions {
  /** userData do app (os clipes vão para `<baseDir>/voice-clips`). */
  baseDir: string
  /** Configuração de fala dona da voz (backend/voz/modelo). */
  settings: TtsSettings
  /** Motor local injetado (backend 'local'); sem ele, `synthesize` falha legível. */
  local?: TtsLocalBackend
  /** Progresso a cada clipe gerado. */
  onProgress?: (e: { done: number; total: number; id: string }) => void
  signal?: AbortSignal
}

// ---------------- nomes e pastas (seguros) ----------------

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/** Nome do arquivo de um clipe (`<CLASSE>_<n>.wav`) — classe/n fora da whitelist → erro legível. */
export function clipFileName(cls: string, n: number): string {
  if (!(CLIP_CLASSES as readonly string[]).includes(cls))
    throw new Error(`classe de clipe desconhecida: ${cls} (use: ${CLIP_CLASSES.join(', ')})`)
  if (!Number.isInteger(n) || n < 1 || n > CLIP_VARIANTS)
    throw new Error(`variante de clipe inválida: ${n} (use 1..${CLIP_VARIANTS})`)
  return `${cls}_${n}.wav`
}

/**
 * Id do diretório de cache da voz: `local-<engine>-<voz>` ou `api-<voz>` (segmento seguro — a voz
 * vem das settings e pode ser livre no backend de API; `../`, separadores e sequências `..` nunca
 * viram caminho).
 */
export function clipVoiceId(settings: TtsSettings): string {
  const raw =
    settings.backend === 'local'
      ? `local-${settings.local?.engine ?? 'kokoro'}-${settings.local?.voice ?? 'padrao'}`
      : `api-${(settings.api.voice ?? '').trim() || 'padrao'}`
  const safe = raw
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/\.{2,}/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '')
    .slice(0, 64)
  return safe || 'voz'
}

/** `<userData>/voice-clips` (raiz dos caches por voz). */
export function clipsRoot(baseDir: string): string {
  return join(baseDir, 'voice-clips')
}

/** Diretório de cache de uma voz (null quando o id não é um segmento seguro). */
export function clipsDir(baseDir: string, voiceId: string): string | null {
  return SAFE_SEGMENT.test(voiceId) ? join(clipsRoot(baseDir), voiceId) : null
}

// ---------------- manifest/hash ----------------

/** Hash da definição dos clipes (frases + voz + modelo): mudou → regerar. */
export async function clipsHash(settings: TtsSettings): Promise<string> {
  const payload = JSON.stringify({
    phrases: CLIP_PHRASES,
    variants: CLIP_VARIANTS,
    backend: settings.backend,
    engine: settings.backend === 'local' ? (settings.local?.engine ?? null) : null,
    voice:
      settings.backend === 'local'
        ? (settings.local?.voice ?? null)
        : (settings.api.voice ?? null) || null,
    model: settings.backend === 'api' ? settings.api.model : null
  })
  const hasher = await createSHA256()
  return hasher.update(payload).digest('hex')
}

const MANIFEST_FILE = 'manifest.json'

function normalizeClip(v: unknown): VoiceClip | null {
  if (!v || typeof v !== 'object') return null
  const c = v as Record<string, unknown>
  const cls = typeof c.class === 'string' ? c.class : ''
  const n = typeof c.n === 'number' ? c.n : 0
  if (!(CLIP_CLASSES as readonly string[]).includes(cls)) return null
  if (!Number.isInteger(n) || n < 1 || n > CLIP_VARIANTS) return null
  let file: string
  try {
    file = clipFileName(cls, n)
  } catch {
    return null
  }
  if (c.file !== file) return null
  if (typeof c.id !== 'string' || c.id !== `${cls}_${n}`) return null
  if (typeof c.text !== 'string' || !c.text.trim()) return null
  return { id: c.id, file, class: cls as ClipClass, n, text: c.text }
}

/**
 * Lê e valida o manifest de uma voz (null quando ausente/inválido/sem os arquivos — o chamador
 * regenera). Só aceita ids de voz seguros e arquivos da whitelist.
 */
export async function loadClips(baseDir: string, voiceId: string): Promise<ClipsManifest | null> {
  const dir = clipsDir(baseDir, voiceId)
  if (!dir) return null
  let raw: string
  try {
    raw = await readFile(join(dir, MANIFEST_FILE), 'utf8')
  } catch {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  const m = parsed as Record<string, unknown>
  if (m.voiceId !== voiceId) return null
  if (m.backend !== 'api' && m.backend !== 'local') return null
  if (typeof m.hash !== 'string' || !/^[0-9a-f]{64}$/.test(m.hash)) return null
  if (typeof m.generatedAt !== 'string') return null
  if (typeof m.model !== 'string') return null
  if (m.engine !== null && typeof m.engine !== 'string') return null
  const clips = Array.isArray(m.clips) ? m.clips.map(normalizeClip) : []
  if (!clips.length || clips.some((c) => !c)) return null
  // todos os arquivos do manifest precisam existir (senão o cache está incompleto → regerar)
  for (const c of clips as VoiceClip[]) {
    if (!existsSync(join(dir, c.file))) return null
  }
  return {
    voiceId,
    backend: m.backend,
    engine: (m.engine as string | null) ?? null,
    model: m.model,
    hash: m.hash,
    generatedAt: m.generatedAt,
    clips: clips as VoiceClip[]
  }
}

/**
 * Caminho do `.wav` de um clipe da voz (null quando a classe/variante não existe no cache).
 * A Feature B toca este arquivo direto (latência zero depois de gerados).
 */
export async function resolveClip(
  baseDir: string,
  voiceId: string,
  cls: string,
  n: number
): Promise<string | null> {
  const dir = clipsDir(baseDir, voiceId)
  if (!dir) return null
  let file: string
  try {
    file = clipFileName(cls, n)
  } catch {
    return null
  }
  const path = join(dir, file)
  return existsSync(path) ? path : null
}

// ---------------- geração ----------------

/**
 * Gera (ou reusa) os clipes da voz configurada: cada frase de `CLIP_PHRASES` é sintetizada pela
 * voz atual (`synthesize` — motor local ou API) e gravada em
 * `<baseDir>/voice-clips/<voiceId>/<CLASSE>_<n>.wav`, com manifest (voz, engine, modelo, hash).
 * Cache: se o manifest da voz tem o mesmo hash e todos os arquivos existem, devolve sem sintetizar
 * (o "Gerar clipes" da UI é idempotente); voz nova = diretório novo = regeneração natural.
 */
export async function generateClips(opts: GenerateClipsOptions): Promise<ClipsManifest> {
  const voiceId = clipVoiceId(opts.settings)
  const dir = clipsDir(opts.baseDir, voiceId)
  if (!dir) throw new Error(`id de voz inseguro para clipes: ${voiceId}`)
  const hash = await clipsHash(opts.settings)
  const existing = await loadClips(opts.baseDir, voiceId)
  if (existing && existing.hash === hash) return existing

  const entries: VoiceClip[] = []
  const total = CLIP_CLASSES.length * CLIP_VARIANTS
  let done = 0
  await mkdir(dir, { recursive: true })
  for (const cls of CLIP_CLASSES) {
    for (let n = 1; n <= CLIP_VARIANTS; n++) {
      if (opts.signal?.aborted) throw new Error('geração de clipes cancelada')
      const text = CLIP_PHRASES[cls][n - 1]
      const file = clipFileName(cls, n)
      const r = await synthesize(
        { text, settings: opts.settings, format: 'wav' },
        { local: opts.local, signal: opts.signal }
      )
      // escrita via .part + rename (manifest só sai no fim, com tudo íntegro)
      const part = join(dir, `${file}.part`)
      await writeFile(part, r.audio)
      await rename(part, join(dir, file))
      entries.push({ id: `${cls}_${n}`, file, class: cls, n, text })
      done++
      opts.onProgress?.({ done, total, id: `${cls}_${n}` })
    }
  }
  const engine = opts.settings.backend === 'local' ? (opts.settings.local?.engine ?? null) : null
  const manifest: ClipsManifest = {
    voiceId,
    backend: opts.settings.backend,
    engine,
    model:
      opts.settings.backend === 'local'
        ? (opts.settings.local?.voice ?? '')
        : opts.settings.api.model,
    hash,
    generatedAt: new Date().toISOString(),
    clips: entries
  }
  const tmp = join(dir, `${MANIFEST_FILE}.tmp`)
  await writeFile(tmp, JSON.stringify(manifest, null, 2))
  await rename(tmp, join(dir, MANIFEST_FILE))
  return manifest
}

/** Remove o cache de clipes de uma voz (idempotente; id inseguro = sem efeito). */
export async function removeClips(baseDir: string, voiceId: string): Promise<void> {
  const dir = clipsDir(baseDir, voiceId)
  if (!dir) return
  await rm(dir, { recursive: true, force: true })
}
