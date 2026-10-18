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
  /** web_search: teto da opção "resultados" dos buscadores com API. */
  webMaxResultsCap: 10,
  webSnippetChars: 300,

  /** browse_url: caracteres de texto por página (paginação via offset). */
  browsePageChars: 12_000,
  /** browse_url: tempo de cache do texto extraído (por sessão + URL). */
  browseCacheMs: 5 * 60_000,
  browseMaxLinks: 40,

  /** shell: fração do limite mantida do início (o resto vem do fim). */
  bashHeadRatio: 0.4,

  /** list_chats: padrão / máximo de chats listados. */
  chatsDefaultResults: 30,
  chatsMaxResults: 100,

  /** send_to_chat: máximo de saltos de uma cadeia de mensagens entre chats. */
  interChatMaxHops: 3,
  /** send_to_chat (wait_for_reply): espera padrão / máxima, em segundos. */
  interChatDefaultTimeoutS: 300,
  interChatMaxTimeoutS: 3600,

  /** read_history (faixa): padrão / máximo de mensagens. */
  historyDefaultMessages: 40,
  historyMaxMessages: 200,
  /** read_history: corte de cada mensagem (exceto ao ler uma única mensagem). */
  historyMsgChars: 2000,
  /** read_history (busca): padrão / máximo de mensagens encontradas. */
  historySearchDefault: 20,
  historySearchMax: 100,
  /** read_history (busca): caracteres de contexto ao redor de cada ocorrência. */
  historySnippetChars: 220,
  /** read_history scope "all": chats mostrados (padrão / máximo) e trechos por chat. */
  historyAllChatsDefault: 5,
  historyAllChatsMax: 20,
  historyAllPerChat: 3,

  /** wait_subagents / message_subagent (wait_for_reply): espera padrão / máxima, em segundos. */
  subagentWaitDefaultS: 600,
  subagentWaitMaxS: 3600,

  /** Processos em segundo plano (process_*): máximo rodando por chat. */
  processMaxPerChat: 8,
  /** Buffer em memória por processo: linhas / caracteres (o log completo fica em arquivo). */
  processBufferLines: 20_000,
  processBufferChars: 5_000_000,
  /** Linhas mais longas que isso são cortadas (buffer e arquivo). */
  processMaxLineChars: 2000,
  /** process_start wait_for: espera padrão / máxima, em segundos. */
  processWaitDefaultS: 60,
  processWaitMaxS: 600,
  /** process_logs: linhas padrão (tail) / máximo de resultados. */
  processLogsDefaultLines: 100,
  processLogsMaxLines: 2000,
  /** Logs mais antigos que isso são apagados no start do app. */
  processLogMaxAgeDays: 7
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

/** Memória modular (SPEC → Memória). */
export const MEMORY_LIMITS = {
  /** Título de uma memória (caracteres). */
  titleChars: 80,
  /** Resumo (uma frase; vai no índice). */
  summaryChars: 160,
  /** Cada tópico (fato) de uma memória. */
  factChars: 200,
  /** Tópicos por memória. */
  maxFacts: 15,
  /** Nome / descrição de uma coleção. */
  collectionNameChars: 60,
  collectionDescriptionChars: 300,
  /** Teto do bloco de índice no system prompt (caracteres; acima disso: fixadas + recentes). */
  indexMaxChars: 12_000,
  /** memory_search: resultados padrão / máximo; memory_read: ids por chamada. */
  searchDefaultResults: 10,
  searchMaxResults: 30,
  readMaxIds: 20,
  /** Extração: rodadas de tool calls (request → tools → request…) e caracteres de conversa enviados. */
  extractionMaxRounds: 4,
  extractionConversationChars: 60_000,
  /** Extração: índice completo enviado (caracteres). */
  extractionIndexChars: 40_000
} as const
