// Gerenciador de componentes locais de áudio (SPEC → "Áudio → Componentes locais (download)").
// Download com progresso e verificação, instalação/remoção em `<baseDir>/models/` com
// `manifest.json`, sem Electron, sem UI e sem IPC (a fiação vem na fatia de integração; a API já sai
// pronta para ser embrulhada). A INFERÊNCIA (rodar whisper/vosk/nemotron/kokoro) é outra fatia —
// aqui só se guardam os arquivos. Lógica independente de Electron: o caminho base (`baseDir` =
// userData) e o fetch são injetáveis para os testes (nunca há download real em teste).
//
// Comportamento declarado:
// - Layout: `<baseDir>/models/<arquivo>` (nome = basename da URL do catálogo), download em
//   `<arquivo>.part` com rename atômico ao final, e `<baseDir>/models/manifest.json` no formato
//   `{ [id]: { version, file, sha256, size, installedAt } }` (sha256 = hash calculado do arquivo
//   instalado, conferido contra `sha256Oficial` quando o catálogo tem um).
// - Verificação: tamanho EXATO (`sizeBytes` do catálogo) + magic bytes sempre; sha256 quando há
//   `sha256Oficial`. Falhou → o `.part` é apagado e nada é instalado.
// - Manifest: `readManifest`/`writeManifest` são idempotentes; manifest ausente/ilegível/JSON
//   inválido → renomeado para `manifest.json.bak` e tratado como vazio (a instalação regrava por
//   cima); entradas com campos inválidos são descartadas; escrita é atômica (`.tmp` + rename,
//   chaves ordenadas).
// - Estados (`listLocalModels`): `installed` = registrado no manifest + arquivo com o tamanho do
//   registro + magic ok; `corrupt` = arquivo sem registro, registro sem arquivo ou
//   tamanho/magic divergentes (a checagem barata de lista NÃO relê o sha256 — use
//   `verifyModelFile` para a checagem profunda); `downloading` = download em voo nesta sessão;
//   `notInstalled` = nada em disco. `.part` órfão (de crash) não muda o estado — é limpo no
//   próximo download ou na remoção.
// - `downloadLocalModel` é idempotente: já `installed` → devolve sem baixar; `corrupt` → baixa de
//   novo por cima. Download do mesmo id em paralelo → erro legível.
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { createSHA256 } from 'hash-wasm'
import { abortError } from '../tools/util'
import {
  LOCAL_MODEL_CATALOG,
  catalogFileName,
  expectedMagic,
  findCatalogEntry,
  type LocalModelCatalogEntry
} from './catalog'

type FetchLike = (url: string, init: RequestInit) => Promise<Response>

export interface LocalModelsOptions {
  /** Catálogo a considerar (padrão `LOCAL_MODEL_CATALOG`; injetável para testes). */
  catalog?: readonly LocalModelCatalogEntry[]
}

export interface DownloadLocalModelOptions extends LocalModelsOptions {
  /** Progresso do download: bytes gravados até agora e total esperado. */
  onProgress?: (bytes: number, total: number) => void
  /** Cancela o download (limpa o `.part` e propaga `AbortError`). */
  signal?: AbortSignal
  /** fetch a usar (padrão: o global; injetável para testes). */
  fetch?: FetchLike
}

/** Estado do modelo local no disco. */
export type LocalModelState = 'notInstalled' | 'downloading' | 'installed' | 'corrupt'

/** Registro de instalação no `manifest.json` (id → registro). */
export interface ManifestEntry {
  /** `version` da entrada do catálogo no momento da instalação. */
  version: string
  /** Nome do arquivo instalado em `<baseDir>/models/`. */
  file: string
  /** sha256 calculado do arquivo instalado (null só em manifest legado/normalizado). */
  sha256: string | null
  /** Tamanho do arquivo instalado em bytes. */
  size: number
  /** Data/hora ISO da instalação. */
  installedAt: string
}

/** `manifest.json`: id da entrada do catálogo → registro de instalação. */
export type ModelManifest = Record<string, ManifestEntry>

/** Visão de uma entrada do catálogo com o estado em disco. */
export interface LocalModelInfo {
  entry: LocalModelCatalogEntry
  state: LocalModelState
  /** Caminho absoluto do arquivo em disco (null quando não há arquivo). */
  path: string | null
  /** Tamanho do arquivo em disco (null quando não há arquivo). */
  installedBytes: number | null
  /** Registro no manifest (null quando não registrado). */
  manifest: ManifestEntry | null
}

// ---------------- caminhos e manifest ----------------

/** `<baseDir>/models` — onde vivem os arquivos e o `manifest.json`. */
export function modelsDir(baseDir: string): string {
  return join(baseDir, 'models')
}

const manifestPath = (baseDir: string): string => join(modelsDir(baseDir), 'manifest.json')

const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

/** Nome de arquivo seguro para virar caminho (sem separadores/`..`); inválido → null. */
function safeFileName(file: string | undefined): string | null {
  if (!file || basename(file) !== file || file === '.' || file === '..') return null
  return file
}

function normalizeManifestEntry(v: unknown): ManifestEntry | null {
  const o = isObject(v) ? v : null
  if (!o) return null
  const file = safeFileName(typeof o.file === 'string' ? o.file : undefined)
  if (!file) return null
  const size = o.size
  if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) return null
  const sha256 = o.sha256
  return {
    version: typeof o.version === 'string' ? o.version : '',
    file,
    sha256: typeof sha256 === 'string' && /^[0-9a-f]{64}$/.test(sha256) ? sha256 : null,
    size,
    installedAt: typeof o.installedAt === 'string' ? o.installedAt : ''
  }
}

/**
 * Lê o `manifest.json` (idempotente). Ausente/ilegível/JSON inválido → renomeia para
 * `manifest.json.bak` (backup; sobrescreve o anterior) e devolve `{}`. Entradas com campos
 * inválidas são descartadas.
 */
export async function readManifest(baseDir: string): Promise<ModelManifest> {
  const path = manifestPath(baseDir)
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    return {}
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    parsed = undefined
  }
  if (!isObject(parsed)) {
    await rename(path, path + '.bak').catch(() => undefined)
    return {}
  }
  const out: ModelManifest = {}
  for (const [id, v] of Object.entries(parsed)) {
    const entry = normalizeManifestEntry(v)
    if (entry) out[id] = entry
  }
  return out
}

/** Grava o `manifest.json` de forma atômica (`.tmp` + rename), com as chaves ordenadas. */
export async function writeManifest(baseDir: string, manifest: ModelManifest): Promise<void> {
  await mkdir(modelsDir(baseDir), { recursive: true })
  const ordered: ModelManifest = {}
  for (const id of Object.keys(manifest).sort()) ordered[id] = manifest[id]
  const path = manifestPath(baseDir)
  const tmp = path + '.tmp'
  await writeFile(tmp, JSON.stringify(ordered, null, 2) + '\n', 'utf8')
  await rename(tmp, path)
}

// ---------------- estado ----------------

const activeDownloads = new Set<string>()
const downloadKey = (baseDir: string, id: string): string => `${baseDir}\u0000${id}`

/** Checagem barata: arquivo existe, tem o tamanho esperado e os magic bytes certos. */
async function quickCheck(
  filePath: string,
  entry: LocalModelCatalogEntry,
  expectedSize: number
): Promise<boolean> {
  try {
    const st = await stat(filePath)
    if (!st.isFile() || st.size !== expectedSize) return false
    const magic = expectedMagic(entry)
    if (!magic) return true
    const fh = await open(filePath, 'r')
    try {
      const head = new Uint8Array(magic.length)
      const { bytesRead } = await fh.read(head, 0, head.length, 0)
      return bytesRead === head.length && head.every((b, i) => b === magic[i])
    } finally {
      await fh.close()
    }
  } catch {
    return false
  }
}

async function buildInfo(
  baseDir: string,
  entry: LocalModelCatalogEntry,
  manifest: ModelManifest
): Promise<LocalModelInfo> {
  const m = manifest[entry.id] ?? null
  const fileName = safeFileName(m?.file) ?? catalogFileName(entry)
  const path = fileName ? join(modelsDir(baseDir), fileName) : null
  let exists = false
  let size: number | null = null
  if (path) {
    try {
      const st = await stat(path)
      exists = st.isFile()
      if (exists) size = st.size
    } catch {
      exists = false
    }
  }
  let state: LocalModelState
  if (activeDownloads.has(downloadKey(baseDir, entry.id))) state = 'downloading'
  else if (exists && m && size === m.size && (await quickCheck(path!, entry, m.size)))
    state = 'installed'
  else if (exists || m) state = 'corrupt'
  else state = 'notInstalled'
  return {
    entry,
    state,
    path: exists ? path : null,
    installedBytes: size,
    manifest: m
  }
}

/**
 * Lista o catálogo com o estado em disco (`notInstalled` | `downloading` | `installed` |
 * `corrupt`) e, quando há arquivo, o caminho e o tamanho instalados. A checagem de lista é barata
 * (manifest + tamanho + magic bytes); sha256 profundo → `verifyModelFile`.
 */
export async function listLocalModels(
  baseDir: string,
  opts: LocalModelsOptions = {}
): Promise<LocalModelInfo[]> {
  const catalog = opts.catalog ?? LOCAL_MODEL_CATALOG
  const manifest = await readManifest(baseDir)
  const out: LocalModelInfo[] = []
  for (const entry of catalog) out.push(await buildInfo(baseDir, entry, manifest))
  return out
}

/**
 * Caminho absoluto do arquivo do modelo em `<baseDir>/models/` (nome do manifest quando instalado,
 * senão o basename da URL). Id desconhecido ou placeholder sem download sem instalação → erro
 * legível. Idempotente (só leitura).
 */
export async function resolveLocalModelPath(
  baseDir: string,
  id: string,
  opts: LocalModelsOptions = {}
): Promise<string> {
  const entry = findCatalogEntry(id, opts.catalog ?? LOCAL_MODEL_CATALOG)
  if (!entry) throw new Error(`modelo desconhecido: ${id}`)
  const manifest = await readManifest(baseDir)
  const fileName = safeFileName(manifest[id]?.file) ?? catalogFileName(entry)
  if (!fileName) throw new Error(`modelo ${id} não tem arquivo definido (placeholder sem download)`)
  return join(modelsDir(baseDir), fileName)
}

// ---------------- verificação ----------------

/**
 * Verifica o arquivo baixado/instalado contra a entrada do catálogo: tamanho EXATO (`sizeBytes`) +
 * magic bytes sempre, sha256 contra `sha256Oficial` quando existe. Devolve o sha256 calculado do
 * arquivo (sempre — vai para o manifest). Qualquer divergência → erro legível.
 */
export async function verifyModelFile(
  filePath: string,
  entry: LocalModelCatalogEntry
): Promise<string> {
  const st = await stat(filePath)
  if (!st.isFile()) throw new Error(`verificação falhou: ${basename(filePath)} não é arquivo`)
  if (st.size !== entry.sizeBytes)
    throw new Error(`verificação falhou: tamanho ${st.size} bytes ≠ esperado ${entry.sizeBytes}`)
  const fh = await open(filePath, 'r')
  try {
    const magic = expectedMagic(entry)
    if (magic) {
      const head = new Uint8Array(magic.length)
      const { bytesRead } = await fh.read(head, 0, head.length, 0)
      if (bytesRead !== head.length || !head.every((b, i) => b === magic[i]))
        throw new Error('verificação falhou: magic bytes não batem com o formato esperado')
    }
    const hasher = await createSHA256()
    hasher.init()
    const buf = new Uint8Array(1024 * 1024)
    let pos = 0
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, pos)
      if (!bytesRead) break
      hasher.update(buf.subarray(0, bytesRead))
      pos += bytesRead
    }
    const digest = hasher.digest('hex')
    if (entry.sha256Oficial && digest !== entry.sha256Oficial)
      throw new Error('verificação falhou: sha256 do arquivo difere do oficial publicado')
    return digest
  } finally {
    await fh.close()
  }
}

// ---------------- download ----------------

/** Encerra a promise quando o `signal` aborta (o fetch nativo também aborta o corpo). */
function raceAbort<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p
  if (signal.aborted) return Promise.reject(abortError())
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortError())
    signal.addEventListener('abort', onAbort, { once: true })
    p.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

async function fetchToPart(
  url: string,
  partPath: string,
  totalHint: number,
  opts: DownloadLocalModelOptions
): Promise<void> {
  const doFetch: FetchLike = opts.fetch ?? ((u, init) => fetch(u, init))
  if (opts.signal?.aborted) throw abortError()
  const res = await raceAbort(doFetch(url, { signal: opts.signal }), opts.signal)
  if (!res.ok) throw new Error(`download falhou: HTTP ${res.status}`)
  if (!res.body) throw new Error('download falhou: resposta sem corpo')
  const total = Number(res.headers.get('content-length')) || totalHint
  const reader = res.body.getReader()
  const fh = await open(partPath, 'w')
  let written = 0
  try {
    for (;;) {
      const { done, value } = await raceAbort(reader.read(), opts.signal)
      if (done) break
      if (opts.signal?.aborted) throw abortError()
      if (value) {
        await fh.write(value)
        written += value.byteLength
        opts.onProgress?.(written, total)
      }
    }
  } finally {
    await fh.close().catch(() => undefined)
  }
}

/**
 * Baixa, verifica e instala o modelo `id` em `<baseDir>/models/`, gravando o `manifest.json`.
 * Stream para `<arquivo>.part`, verificação (tamanho + magic + sha256 oficial quando existe),
 * rename atômico e registro. Falha/abort no meio limpa o `.part` (nada é instalado nem registrado);
 * `AbortError` propaga como `abortError()`. Já instalado e íntegro → devolve sem baixar.
 */
export async function downloadLocalModel(
  baseDir: string,
  id: string,
  opts: DownloadLocalModelOptions = {}
): Promise<LocalModelInfo> {
  const entry = findCatalogEntry(id, opts.catalog ?? LOCAL_MODEL_CATALOG)
  if (!entry) throw new Error(`modelo desconhecido: ${id}`)
  if (!entry.url)
    throw new Error(`modelo ${id} não tem download disponível ainda (preenchido na fatia de TTS)`)
  const key = downloadKey(baseDir, id)
  if (activeDownloads.has(key)) throw new Error(`download já em andamento para ${id}`)
  const fileName = catalogFileName(entry)!
  const dir = modelsDir(baseDir)
  await mkdir(dir, { recursive: true })
  const finalPath = join(dir, fileName)
  const partPath = finalPath + '.part'
  // idempotente: já instalado e íntegro → nada a fazer
  const manifest = await readManifest(baseDir)
  const current = await buildInfo(baseDir, entry, manifest)
  if (current.state === 'installed') return current

  activeDownloads.add(key)
  try {
    await rm(partPath, { force: true })
    await fetchToPart(entry.url, partPath, entry.sizeBytes, opts)
    const digest = await verifyModelFile(partPath, entry)
    const st = await stat(partPath)
    await rename(partPath, finalPath)
    manifest[entry.id] = {
      version: entry.version,
      file: fileName,
      sha256: digest,
      size: st.size,
      installedAt: new Date().toISOString()
    }
    await writeManifest(baseDir, manifest)
  } catch (e) {
    await rm(partPath, { force: true })
    if (opts.signal?.aborted) throw abortError()
    throw e
  } finally {
    activeDownloads.delete(key)
  }
  // fora do registro de downloads em voo: o estado devolvido é o final ('installed')
  return await buildInfo(baseDir, entry, manifest)
}

/**
 * Remove o modelo instalado (arquivo, `.part` órfão e registro no manifest). Idempotente: remover o
 * que não está instalado não faz nada; ids fora do catálogo ainda limpam o que o manifest registra.
 * Com download em voo para o id → erro legível (cancele antes).
 */
export async function removeLocalModel(
  baseDir: string,
  id: string,
  opts: LocalModelsOptions = {}
): Promise<void> {
  if (activeDownloads.has(downloadKey(baseDir, id)))
    throw new Error(`download em andamento para ${id} — cancele antes de remover`)
  const manifest = await readManifest(baseDir)
  const m = manifest[id] ?? null
  const dir = modelsDir(baseDir)
  const names = new Set<string>()
  const fromManifest = safeFileName(m?.file)
  if (fromManifest) names.add(fromManifest)
  const entry = findCatalogEntry(id, opts.catalog ?? LOCAL_MODEL_CATALOG)
  const fromCatalog = entry ? catalogFileName(entry) : null
  if (fromCatalog) names.add(fromCatalog)
  for (const name of names) {
    await rm(join(dir, name), { force: true })
    await rm(join(dir, name + '.part'), { force: true })
  }
  if (m) {
    delete manifest[id]
    await writeManifest(baseDir, manifest)
  }
}
