// Contrato compartilhado entre main, preload e renderer. Ver SPEC.md → "Tipos compartilhados".

export interface Provider {
  id: string
  name: string
  baseUrl: string
  apiKey: string
  headers: Record<string, string>
  createdAt: number
}

export interface ModelInfo {
  id: string
  name?: string
  contextLength?: number
  promptPrice?: number
  completionPrice?: number
  supportsTools?: boolean
  /** Modalidades de entrada (OpenRouter `architecture.input_modalities`: text, image, file, audio, video). Ausente = desconhecido. */
  inputModalities?: string[]
}

/** Só campos definidos (≠ undefined/null) vão para a request. */
export interface ChatParams {
  temperature?: number
  top_p?: number
  top_k?: number
  max_tokens?: number
  frequency_penalty?: number
  presence_penalty?: number
  repetition_penalty?: number
  seed?: number
  /** OpenRouter: vira `{ reasoning: { effort } }`; outros: `reasoning_effort`. */
  reasoning_effort?: 'minimal' | 'low' | 'medium' | 'high'
  /** JSON livre, merge raso no body (último a ser aplicado). */
  extraBody?: string
}

export type ToolName =
  | 'list_dir'
  | 'read_file'
  | 'search_files'
  | 'find_files'
  | 'write_file'
  | 'edit_file'
  | 'bash'
  | 'web_search'
  | 'browse_url'
  | 'list_models'
  | 'delegate_task'

export const CONFIRM_TOOLS: ToolName[] = ['bash', 'web_search', 'browse_url']

export interface ChatConfig {
  providerId: string
  model: string
  systemPrompt: string
  params: ChatParams
  enabledTools: ToolName[]
  /** Envia definições no campo `tools` da API (padrão true). */
  nativeTools: boolean
  /** Anexa toolsPromptText ao system prompt (padrão false). */
  toolsInPrompt: boolean
  /** null = texto padrão gerado (defaults.ts); editável. */
  toolsPromptText: string | null
  /** Anexa bloco <environment> (cwd, SO, shell) ao system prompt (padrão true). */
  envInPrompt: boolean
  /** Adiciona breakpoints cache_control (padrão: true se baseUrl contém openrouter.ai). */
  cacheEnabled: boolean
  /** System prompt dos subagentes. */
  subagentSystemPrompt: string
  /** Diretório raiz (workspace) da sessão — absoluto. Compartilhado por todas as subsessões. */
  cwd: string
  /** Tools de arquivo rejeitam caminhos fora do diretório raiz (após realpath). Padrão true. */
  confineToRoot: boolean
  /** Roda o bash via bubblewrap (raiz gravável, resto do FS somente leitura). Padrão false. */
  sandboxBash: boolean
  /** Janela de contexto (tokens) — sobrescreve a informada pelo provider (/models). */
  contextWindow?: number | null
  /** Fração da janela a partir da qual o app sugere compactar (padrão 0.9). */
  compactThreshold: number
  /** Compacta automaticamente a sessão principal ao atingir o limite (subsessões: sempre). */
  autoCompact: boolean
  /** Prompt de compactação; null = DEFAULT_COMPACT_PROMPT. */
  compactPrompt: string | null
  /** Limite de caracteres do resultado de cada tool enviado ao modelo (padrão 30000). */
  maxToolOutputChars: number
  /** Tools de CONFIRM_TOOLS que o usuário marcou "permitir sempre neste chat". */
  autoApprove: ToolName[]
  /** Assinatura de app (headers HTTP-Referer/X-Title) — id de APP_SIGNATURES (padrão 'clearchat'; 'none' = nada). */
  appSignature: string
  /** Usada quando appSignature === 'custom'. */
  appSignatureCustom?: { referer: string; title: string }
  /** Persona (preset) de onde o chat veio — só informativo (ver Preset). */
  presetId?: string
}

/**
 * Persona: preset reutilizável de configuração de chat. `config` é um snapshot parcial de
 * ChatConfig (ver PRESET_FIELDS em presets.ts); campos ausentes seguem os padrões do app.
 */
export interface Preset {
  id: string
  name: string
  description: string
  /** Emoji ou nome de ícone lucide (ver PRESET_ICONS no renderer). */
  icon: string
  config: Partial<ChatConfig>
  createdAt: number
  updatedAt: number
}

export interface Chat {
  id: string
  title: string
  config: ChatConfig
  mainSessionId: string
  createdAt: number
  updatedAt: number
}

export type SessionStatus =
  'idle' | 'running' | 'awaiting_approval' | 'done' | 'error' | 'interrupted'

export interface Session {
  id: string
  chatId: string
  parentSessionId: string | null
  parentToolCallId: string | null
  depth: 0 | 1 | 2
  model: string
  title: string
  task: string | null
  status: SessionStatus
  createdAt: number
}

// Formato OpenAI exato — é o que é persistido e reenviado byte-a-byte (essencial para token caching)
// Anexos (ver SPEC.md → "Anexos"): persistidos com `_attachment` (campo privado, nunca enviado) e,
// nos binários, uma referência `clearchat-attachment://<sha256>.<ext>` no lugar do base64 — o
// buildRequest expande para data URL/base64 na cópia enviada (mesmos bytes sempre → cacheável).
export type CacheControl = { type: 'ephemeral' }

/** Tipo de anexo: define como ele é codificado na request. */
export type AttachmentKind = 'image' | 'pdf' | 'audio' | 'text'

/** Metadados de um anexo (persistidos no part como `_attachment`; nunca vão para a API). */
export interface AttachmentMeta {
  name: string
  mime: string
  /** Bytes do arquivo original. */
  size: number
  kind: AttachmentKind
  /** Arquivo no store de anexos: `<sha256>.<ext>` (content-addressed). */
  file: string
  /** text: o conteúdo foi cortado no limite de caracteres. */
  truncated?: boolean
}

export type ContentPart =
  | { type: 'text'; text: string; cache_control?: CacheControl; _attachment?: AttachmentMeta }
  | {
      type: 'image_url'
      image_url: { url: string; detail?: 'auto' | 'low' | 'high' }
      cache_control?: CacheControl
      _attachment?: AttachmentMeta
    }
  | {
      type: 'file'
      file: { filename: string; file_data: string }
      cache_control?: CacheControl
      _attachment?: AttachmentMeta
    }
  | {
      type: 'input_audio'
      input_audio: { data: string; format: string }
      cache_control?: CacheControl
      _attachment?: AttachmentMeta
    }

/** Anexo já salvo no store (resultado de attachments.pick/add) — o que agent.send recebe. */
export interface AttachmentInfo extends AttachmentMeta {
  sha256: string
}

export interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export type ApiMessage =
  | { role: 'system'; content: string | ContentPart[] }
  | { role: 'user'; content: string | ContentPart[] }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[]; reasoning?: string }
  | { role: 'tool'; tool_call_id: string; content: string }

export interface Usage {
  promptTokens: number
  completionTokens: number
  cachedTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
  cost?: number
}

export interface MessageMeta {
  /** Criado pelo app (não pelo usuário nem pelo modelo) — UI mostra (i) com o texto exato. */
  synthetic?: boolean
  /** 'error' = erro HTTP/modelo persistido só para exibição (synthetic; NUNCA enviado à API). */
  /** 'compaction' = fronteira de compactação (role user com o resumo; buildRequest envia daqui em diante). */
  kind?: 'queued' | 'forced' | 'interrupt-notice' | 'tool-cancelled' | 'error' | 'compaction'
  /** Resposta do assistente cortada pelo usuário. */
  interrupted?: boolean
  usage?: Usage
  model?: string
  durationMs?: number
  error?: string
  /** Em mensagens tool de delegate_task. */
  subSessionId?: string
  toolStatus?: 'ok' | 'error' | 'denied' | 'cancelled'
  /** bash: diretório do shell ao final do comando (persistido entre chamadas da sessão). */
  shellCwd?: string
  // ---- compactação (kind 'compaction') ----
  /** Faixa de seq resumida (inclusive). */
  summaryOf?: { fromSeq: number; toSeq: number }
  /** Mensagens resumidas. */
  compactedCount?: number
  /** Tokens de contexto usados antes da compactação. */
  usageBefore?: number
  /** Estimativa do contexto logo após a compactação (system + resumo) — até a próxima usage real. */
  contextEstimate?: number
  /** Usage da chamada de resumo (não faz parte do histórico enviado). */
  compactUsage?: Usage
}

export interface StoredMessage {
  id: string
  sessionId: string
  seq: number
  message: ApiMessage
  meta: MessageMeta
  createdAt: number
}

export interface QueuedMessage {
  id: string
  sessionId: string
  text: string
  createdAt: number
  /** Anexos da mensagem enfileirada (já salvos no store). */
  attachments?: AttachmentInfo[]
}

export interface ApprovalRequest {
  id: string
  chatId: string
  sessionId: string
  toolCallId: string
  toolName: ToolName
  args: unknown
  createdAt: number
}

export interface StreamDraft {
  content: string
  reasoning: string
  toolCalls: { id: string; name: string; arguments: string }[]
}

export interface DirEntry {
  name: string
  path: string
  isDir: boolean
  size: number
  mtime: number
}

export type AgentEvent =
  | { type: 'session-created'; session: Session }
  | { type: 'session-updated'; session: Session }
  /** Subsessão apagada (ex.: regenerate/apagar a mensagem do delegate_task). Inclui descendentes. */
  | { type: 'session-deleted'; sessionId: string; chatId: string }
  | { type: 'message-added'; message: StoredMessage }
  | { type: 'message-updated'; message: StoredMessage }
  | { type: 'message-deleted'; sessionId: string; messageId: string }
  /** Throttled ~30–60ms; null = fim do stream. */
  | { type: 'draft'; sessionId: string; draft: StreamDraft | null }
  /** Output parcial (bash) opcional. */
  | {
      type: 'tool-running'
      sessionId: string
      toolCallId: string
      running: boolean
      output?: string
    }
  | { type: 'queue-updated'; sessionId: string; queue: QueuedMessage[] }
  | { type: 'approval-requested'; request: ApprovalRequest }
  | { type: 'approval-resolved'; id: string }
  | { type: 'chat-updated'; chat: Chat }
  /** Compactação: agendada (próximo passo), rodando (com o texto parcial do resumo) ou null (fim). */
  | {
      type: 'compaction'
      sessionId: string
      state: 'scheduled' | 'running' | null
      text?: string
    }
  | { type: 'error'; sessionId: string; error: string }
