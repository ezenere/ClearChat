// Limites das tools (higiene do contexto) — fonte única para main (implementação) e textos
// (descrições das tools / UI). Só `maxToolOutputChars` é configurável por chat.

export const LIMITS = {
  /** Padrão de ChatConfig.maxToolOutputChars: teto de caracteres de qualquer resultado de tool. */
  maxToolOutputChars: 30_000,
  minToolOutputChars: 2_000,
  maxToolOutputCharsCap: 400_000,

  /** read_file: janela padrão (linhas) quando não há offset/limit. */
  readDefaultLines: 2000,
  /** read_file: linhas mais longas que isso são cortadas com marcador. */
  readMaxLineChars: 2000,
  /** read_file: acima disso (bytes) e sem offset/limit, não lê — devolve tamanho + instruções. */
  readHardMaxBytes: 5 * 1024 * 1024,

  /** list_dir: máximo de entradas listadas. */
  listMaxEntries: 300,

  /** search_files: padrão / máximo de linhas de resultado. */
  searchDefaultResults: 50,
  searchMaxResults: 300,
  /** search_files: corte de cada linha de resultado. */
  searchMaxLineChars: 300,
  /** find_files: máximo de caminhos listados. */
  findMaxResults: 200,

  /** list_models: padrão / máximo de modelos listados. */
  modelsDefaultResults: 50,
  modelsMaxResults: 200,

  /** web_search: máximo de resultados e de caracteres por trecho. */
  webMaxResults: 8,
  webSnippetChars: 300,

  /** browse_url: caracteres de texto por página (paginação via offset). */
  browsePageChars: 12_000,
  /** browse_url: tempo de cache do texto extraído (por sessão + URL). */
  browseCacheMs: 5 * 60_000,
  browseMaxLinks: 40,

  /** bash: fração do limite mantida do início (o resto vem do fim). */
  bashHeadRatio: 0.4
} as const

/** Aproximação usada na UI: ~4 caracteres por token. */
export const approxTokens = (chars: number): number => Math.ceil(chars / 4)

/** Normaliza o limite configurado (fallback no padrão). */
export function clampToolOutput(n: number | undefined | null): number {
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return LIMITS.maxToolOutputChars
  return Math.round(Math.min(LIMITS.maxToolOutputCharsCap, Math.max(LIMITS.minToolOutputChars, n)))
}

/** Anexos (composer → agent.send). Ver SPEC.md → "Anexos". */
export const ATTACHMENT_LIMITS = {
  /** Tamanho máximo de cada arquivo (bytes). */
  maxFileBytes: 20 * 1024 * 1024,
  /** Máximo de anexos por mensagem. */
  maxFiles: 10,
  /** Soma máxima dos anexos de uma mensagem (bytes). */
  maxTotalBytes: 50 * 1024 * 1024,
  /** Arquivos de texto: caracteres inseridos no prompt (o resto é cortado com aviso). */
  maxTextChars: 200_000
} as const
