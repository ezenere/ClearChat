// Anexos — partes puras compartilhadas por main e renderer (classificação, referências, modalidades).
// Ver SPEC.md → "Anexos".
import type { ApiMessage, AttachmentKind, AttachmentMeta, ContentPart, ModelInfo } from './types'
import type { ProviderKind } from './providerKinds'
import type { SkillPartMeta } from './skills'

/** Esquema das referências persistidas e do protocolo que serve os arquivos ao renderer. */
export const ATTACHMENT_SCHEME = 'clearchat-attachment'
export const ATTACHMENT_URL_PREFIX = `${ATTACHMENT_SCHEME}://`

/** Nome de arquivo no store: `<sha256>` + extensão opcional (só [a-z0-9]). */
export const ATTACHMENT_FILE_RE = /^[0-9a-f]{64}(?:\.[a-z0-9]{1,10})?$/

export const attachmentUrl = (file: string): string => ATTACHMENT_URL_PREFIX + file

/** `clearchat-attachment://<file>` → `<file>` (validado) ou null. */
export function parseAttachmentUrl(url: unknown): string | null {
  if (typeof url !== 'string' || !url.startsWith(ATTACHMENT_URL_PREFIX)) return null
  const file = url.slice(ATTACHMENT_URL_PREFIX.length).replace(/\/$/, '')
  return ATTACHMENT_FILE_RE.test(file) ? file : null
}

export const IMAGE_MIMES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif'
}
export const AUDIO_MIMES: Record<string, string> = {
  wav: 'audio/wav',
  mp3: 'audio/mpeg'
}

/** Extensões tratadas como texto (o conteúdo ainda passa por uma checagem de UTF-8 no main). */
const TEXT_EXTS = new Set(
  (
    'txt md markdown mdx rst adoc org tex log csv tsv json jsonl ndjson yaml yml toml ini cfg conf ' +
    'env properties xml svg html htm css scss sass less js mjs cjs jsx ts mts cts tsx vue svelte ' +
    'astro py pyi rb php pl pm lua r jl go rs c h cc cpp cxx hpp hh cs java kt kts scala groovy ' +
    'gradle swift m mm dart ex exs erl hrl clj cljs edn elm hs ml mli fs fsx nim zig v sol sql ' +
    'graphql gql proto sh bash zsh fish ps1 bat cmd make mk cmake dockerfile tf hcl nix lock ' +
    'gitignore gitattributes editorconfig diff patch srt vtt ipynb'
  ).split(/\s+/)
)
const TEXT_NAMES = new Set([
  'makefile',
  'dockerfile',
  'license',
  'readme',
  'changelog',
  'gemfile',
  'rakefile',
  'procfile',
  '.env',
  '.gitignore',
  '.bashrc',
  '.zshrc',
  '.profile'
])

export function fileExt(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? ''
  const i = base.lastIndexOf('.')
  return i > 0 ? base.slice(i + 1).toLowerCase() : ''
}

/** Mime normalizado (sem parâmetros, minúsculo). */
const normMime = (mime: string | undefined): string =>
  (mime ?? '').split(';')[0].trim().toLowerCase()

/**
 * Classifica pelo nome/mime: 'image' | 'pdf' | 'audio' | 'text' (extensão/mime de texto) |
 * 'maybe-text' (desconhecido — o main confere se é UTF-8) | null (binário não suportado).
 */
export function classifyAttachment(
  name: string,
  mime?: string
): { kind: AttachmentKind | 'maybe-text' | null; mime: string } {
  const ext = fileExt(name)
  const m = normMime(mime)
  if (IMAGE_MIMES[ext] || ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(m))
    return { kind: 'image', mime: IMAGE_MIMES[ext] ?? (m === 'image/jpg' ? 'image/jpeg' : m) }
  if (ext === 'pdf' || m === 'application/pdf') return { kind: 'pdf', mime: 'application/pdf' }
  if (
    AUDIO_MIMES[ext] ||
    ['audio/wav', 'audio/x-wav', 'audio/wave', 'audio/mpeg', 'audio/mp3'].includes(m)
  )
    return {
      kind: 'audio',
      mime:
        AUDIO_MIMES[ext] ?? (m.includes('wav') || m.includes('wave') ? 'audio/wav' : 'audio/mpeg')
    }
  const base = (name.split(/[\\/]/).pop() ?? '').toLowerCase()
  if (
    TEXT_EXTS.has(ext) ||
    TEXT_NAMES.has(base) ||
    m.startsWith('text/') ||
    /^application\/(json|xml|javascript|x-sh|x-yaml|yaml|toml|sql|x-python)/.test(m) ||
    m.endsWith('+json') ||
    m.endsWith('+xml')
  )
    return { kind: 'text', mime: m && m !== 'application/octet-stream' ? m : 'text/plain' }
  if (m.startsWith('image/') || m.startsWith('video/') || m.startsWith('audio/'))
    return { kind: null, mime: m }
  if (/^application\/(zip|gzip|x-tar|x-7z|x-rar|vnd\.|msword|x-msdownload|x-executable)/.test(m))
    return { kind: null, mime: m }
  return { kind: 'maybe-text', mime: m || 'application/octet-stream' }
}

/** Formato do input_audio a partir do mime. */
export const audioFormat = (mime: string): string => (mime.includes('wav') ? 'wav' : 'mp3')

/** Rótulo pt-BR do tipo (chips, placeholders). */
export const KIND_LABEL: Record<AttachmentKind, string> = {
  image: 'imagem',
  pdf: 'PDF',
  audio: 'áudio',
  text: 'arquivo de texto'
}

/** Modalidade de entrada exigida do modelo (OpenRouter `input_modalities`); null = qualquer modelo. */
export function requiredModality(kind: AttachmentKind): 'image' | 'file' | 'audio' | null {
  if (kind === 'image') return 'image'
  if (kind === 'pdf') return 'file'
  if (kind === 'audio') return 'audio'
  return null
}

export type ModalitySupport =
  /** O modelo declara suporte (ou o tipo funciona com qualquer modelo). */
  | 'ok'
  /** PDF num modelo sem suporte nativo, via OpenRouter: o OpenRouter extrai o texto (plugin). */
  | 'parsed'
  /** O modelo declara as modalidades e não inclui esta (ou o adaptador não suporta o tipo). */
  | 'unsupported'
  /** Modalidades desconhecidas (provider que não informa) — assume só texto. */
  | 'unknown'

/**
 * Suporte do modelo a um tipo de anexo, considerando o adaptador do provider:
 * - openrouter: `input_modalities`; PDF sem `file` → 'parsed' (file-parser do OpenRouter);
 * - anthropic: modalidades vêm de `capabilities` (image_input → image, pdf_input → file);
 *   áudio nunca (a API não aceita);
 * - openai (genérico): `input_modalities` se o /models informar; senão 'unknown'.
 * `provider` aceita boolean por compatibilidade (true = openrouter).
 */
export function modalitySupport(
  kind: AttachmentKind,
  model: Pick<ModelInfo, 'inputModalities'> | null | undefined,
  provider: ProviderKind | boolean
): ModalitySupport {
  const pk: ProviderKind =
    typeof provider === 'boolean' ? (provider ? 'openrouter' : 'openai') : provider
  const need = requiredModality(kind)
  if (!need) return 'ok'
  if (pk === 'anthropic' && need === 'audio') return 'unsupported'
  const mods = model?.inputModalities
  if (mods?.includes(need)) return 'ok'
  if (kind === 'pdf' && pk === 'openrouter') return 'parsed'
  return mods ? 'unsupported' : 'unknown'
}

/** Tipos de anexo que o modelo aceita com certeza (ok/parsed). 'text' sempre. */
export function acceptedKinds(
  model: Pick<ModelInfo, 'inputModalities'> | null | undefined,
  provider: ProviderKind | boolean
): AttachmentKind[] {
  return (['image', 'pdf', 'audio', 'text'] as AttachmentKind[]).filter((k) => {
    const s = modalitySupport(k, model, provider)
    return s === 'ok' || s === 'parsed'
  })
}

/** Aviso pt-BR para um tipo não suportado (null se ok/parsed). */
export function modalityWarning(kind: AttachmentKind, support: ModalitySupport): string | null {
  if (support === 'ok' || support === 'parsed') return null
  const what = kind === 'image' ? 'imagens' : kind === 'pdf' ? 'PDFs' : 'áudio'
  return support === 'unsupported'
    ? `Este modelo não aceita ${what}`
    : `Não sei se este modelo aceita ${what} (o provider não informa as modalidades)`
}

/** Part com anexo? */
export const isAttachmentPart = (p: ContentPart): boolean => !!p._attachment

export function partAttachment(p: ContentPart): AttachmentMeta | null {
  return p._attachment ?? null
}

/** Anexos de uma mensagem (na ordem). */
export function messageAttachments(m: ApiMessage): AttachmentMeta[] {
  if (m.role === 'assistant' || typeof m.content === 'string' || !m.content) return []
  return m.content.map((p) => p._attachment).filter((a): a is AttachmentMeta => !!a)
}

/** Part com skill carregada manualmente (bloco <skill>, `_skill`)? */
export const isSkillPart = (p: ContentPart): boolean => p.type === 'text' && !!p._skill

/** Part privado do app (anexo ou skill): não é texto digitado; a edição o preserva. */
export const isAppPart = (p: ContentPart): boolean => !!p._attachment || isSkillPart(p)

/** Skills carregadas manualmente numa mensagem (na ordem). */
export function messageSkills(m: ApiMessage): SkillPartMeta[] {
  if (m.role !== 'user' || typeof m.content === 'string' || !m.content) return []
  return m.content.flatMap((p) => (p.type === 'text' && p._skill ? [p._skill] : []))
}

/** Texto digitado da mensagem (ignora parts de anexo e de skill). */
export function contentText(content: string | ContentPart[] | null | undefined): string {
  if (content == null) return ''
  if (typeof content === 'string') return content
  return content
    .filter((p) => !isAppPart(p) && p.type === 'text')
    .map((p) => (p as { text: string }).text)
    .join('')
}

/** Texto de um resultado de tool (string, ou o texto dos parts — read_file de imagem/PDF descreve o arquivo num text part). */
export const toolContentText = (content: string | ContentPart[]): string => contentText(content)

/** Escapa aspas/sinais do nome dentro do atributo `name="…"` do bloco <file>. */
export const escapeAttr = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Bloco enviado para um arquivo de texto (vai como part `text`). */
export function textFileBlock(name: string, body: string): string {
  return `<file name="${escapeAttr(name)}">\n${body}\n</file>`
}

/** Conteúdo de um bloco <file> (para o preview na UI). */
export function textFileBody(text: string): string {
  const m = /^<file name="[^"]*">\n([\s\S]*)\n<\/file>$/.exec(text)
  return m ? m[1] : text
}

/** Placeholder de texto para um anexo (resumos/compactação, histórico encurtado). */
export function attachmentPlaceholder(a: AttachmentMeta): string {
  return `[${KIND_LABEL[a.kind]}: ${a.name}]`
}

export function formatSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
