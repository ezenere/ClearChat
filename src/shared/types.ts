// Contrato compartilhado entre main, preload e renderer. Ver SPEC.md → "Tipos compartilhados".

export interface Provider {
  id: string
  name: string
  /** Adaptador (ver providerKinds.ts). Ausente = inferido pela baseUrl (`providerKind()`). */
  kind?: import('./providerKinds').ProviderKind
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
  /**
   * Chaves de ChatParams que o modelo aceita (OpenRouter `supported_parameters`, mapeado em
   * @shared/modelParams). Ausente = desconhecido → todas (Anthropic usa uma tabela por modelo).
   */
  supportedParams?: string[]
  /**
   * Raciocínio informado pela API (OpenRouter: objeto `reasoning` do /models; Anthropic nativa:
   * `capabilities.effort`). Ausente = a API não informa (ver @shared/modelParams → effortSpec).
   */
  reasoning?: ModelReasoningInfo
}

/** Níveis de esforço conhecidos (ordem crescente). */
export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface ModelReasoningInfo {
  /**
   * Níveis aceitos (ordem crescente). `null` = a API diz que todos os níveis do gateway valem
   * (OpenRouter `supported_efforts: null`); ausente = a API não lista níveis.
   */
  efforts?: ReasoningEffort[] | null
  /** Nível padrão do modelo (OpenRouter `default_effort`). */
  defaultEffort?: ReasoningEffort
  /** Raciocínio obrigatório (OpenRouter `mandatory`: não aceita `effort: "none"`). */
  mandatory?: boolean
  /** Anthropic nativa: `capabilities.effort.supported` (false = não aceita effort). */
  effortSupported?: boolean
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
  /**
   * OpenRouter: vira `{ reasoning: { effort } }`; openai genérico: `reasoning_effort`; Anthropic
   * nativa: `output_config: { effort }`. Níveis válidos por modelo: @shared/modelParams → effortSpec.
   */
  reasoning_effort?: ReasoningEffort
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
  | 'shell'
  | 'web_search'
  | 'browse_url'
  | 'list_models'
  | 'delegate_task'
  | 'get_chat_info'
  | 'list_chats'
  | 'send_to_chat'
  | 'read_history'
  | 'check_subagents'
  | 'wait_subagents'
  | 'cancel_subagent'
  | 'message_subagent'
  | 'process_start'
  | 'process_logs'
  | 'process_list'
  | 'process_stop'
  | 'ask_user'

/**
 * Tools que passam pelo gate de aprovação (ver approvalPolicy.ts): cada uma é um ITEM com modo
 * always | smart | lists. `process_stop` NÃO está aqui: o agente só enxerga/para processos do
 * próprio chat (registro por chat em tools/processes.ts), então nunca pede confirmação.
 */
export const CONFIRM_TOOLS: ToolName[] = ['shell', 'process_start', 'web_search', 'browse_url']

/** Item de aprovação (um por tool de CONFIRM_TOOLS). */
export type ApprovalItem = 'commands' | 'processes' | 'pages' | 'search'
/** always = sempre permitir · smart = Smart-Approve decide · lists = whitelist/blacklist (search: perguntar). */
export type ApprovalMode = 'always' | 'smart' | 'lists'
/** Listas globais (settings `approvalLists`): padrões de comando/processo ou domínios/prefixos de URL. */
export interface ApprovalList {
  allow: string[]
  deny: string[]
}
export type ApprovalListItem = 'commands' | 'processes' | 'pages'
export interface ApprovalSettings {
  /** Modo global por item (settings `approvalModes`). */
  modes: Record<ApprovalItem, ApprovalMode>
  /** Listas globais (settings `approvalLists`) — nunca por chat. */
  lists: Record<ApprovalListItem, ApprovalList>
}

/** Nomes antigos de tools → atuais (alias de leitura: configs/históricos antigos, modelos). */
export const TOOL_ALIASES: Record<string, ToolName> = { bash: 'shell' }

/** Lista de ToolName com aliases antigos mapeados (sem duplicatas, ordem preservada). */
export function normalizeToolList(list: unknown): ToolName[] | undefined {
  if (!Array.isArray(list)) return undefined
  const out: ToolName[] = []
  for (const t of list) {
    if (typeof t !== 'string') continue
    const n = (TOOL_ALIASES[t] ?? t) as ToolName
    if (!out.includes(n)) out.push(n)
  }
  return out
}

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
  /** Roda o shell (tool `shell` e process_start) via bubblewrap (raiz gravável, resto do FS somente leitura). Padrão false. */
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
  /**
   * Ajuste por chat do modo de aprovação de cada item (ausente = padrão global, settings
   * `approvalModes`). Ver approvalPolicy.ts.
   */
  approvalModes?: Partial<Record<ApprovalItem, ApprovalMode>>
  /**
   * @deprecated (≤ 0.3.0) tools "permitir sempre neste chat". Só alias de leitura: convertido em
   * `approvalModes` (always) por migrateApprovalConfig e removido.
   */
  autoApprove?: ToolName[]
  /** Assinatura de app (headers HTTP-Referer/X-Title) — id de APP_SIGNATURES (padrão 'clearchat'; 'none' = nada). */
  appSignature: string
  /** Usada quando appSignature === 'custom'. */
  appSignatureCustom?: { referer: string; title: string }
  /**
   * Smart-Approve: um modelo "juiz" decide se uma chamada de tool que pediria confirmação pode
   * rodar (aprovar / rejeitar / perguntar ao usuário). Ausente = desligado. Ver smartApprove.ts.
   */
  smartApprove?: SmartApproveConfig
  /** Persona (preset) de onde o chat veio — só informativo (ver Preset). */
  presetId?: string
}

/** Rótulos que o juiz do Smart-Approve deve responder na 1ª linha. */
export interface SmartApproveLabels {
  approve: string
  reject: string
  ask: string
}

export interface SmartApproveConfig {
  enabled: boolean
  /** Par provedor + modelo do juiz (qualquer provedor). Sem modelo → não pode ser habilitado. */
  providerId: string | null
  model: string | null
  /** System prompt do juiz; null = DEFAULT_SMART_APPROVE_PROMPT. */
  prompt: string | null
  /** Template da mensagem `user` do juiz (placeholders {{tool}} etc.); null = o padrão. */
  template: string | null
  labels: SmartApproveLabels
  /** Quantas mensagens recentes da sessão entram em {{recent_context}} (padrão 6). */
  contextMessages: number
  /** Tempo máximo da chamada ao juiz, em segundos (padrão 30). Estourou → pergunta ao usuário. */
  timeoutS: number
  /**
   * Tools EXTRAS avaliadas pelo juiz (SMART_APPROVE_EXTRA_TOOLS: write_file, edit_file,
   * send_to_chat, delegate_task; padrão nenhuma). As de CONFIRM_TOOLS usam o juiz quando o modo do
   * item é `smart` (approvalModes). Nomes de CONFIRM_TOOLS aqui são ignorados (legado).
   */
  tools?: ToolName[]
}

export type SmartApproveDecision = 'approve' | 'reject' | 'ask'

/** Uma avaliação do juiz (meta da mensagem tool e da ApprovalRequest). Nunca entra no histórico enviado. */
export interface SmartApproveRecord {
  decision: SmartApproveDecision
  reason: string
  /** Por que caiu em 'ask' sem o juiz pedir: erro HTTP/rede, tempo esgotado ou resposta ambígua. */
  fallback?: 'error' | 'timeout' | 'ambiguous'
  error?: string
  providerId: string
  model: string
  usage?: Usage
  durationMs: number
  /** Request exata enviada ao juiz (key mascarada) — para o (i). */
  request?: { url: string; headers: Record<string, string>; body: unknown; notes?: string[] }
  /** Texto bruto da resposta do juiz (cortado). */
  response?: string
  /** O usuário clicou "Executar mesmo assim" depois de uma rejeição. */
  overridden?: boolean
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
  | 'idle'
  | 'running'
  | 'awaiting_approval'
  | 'done'
  | 'error'
  | 'interrupted'
  /** Subagente que encerrou o turno com subagentes em segundo plano pendentes: dorme até os callbacks. */
  | 'waiting'
  /** Sessão principal esperando o usuário responder um questionário (tool ask_user). */
  | 'awaiting_input'
  /** Chamada ao modelo falhou por erro de REDE: card "Tentar de novo / Cancelar" aberto (isBusy). */
  | 'awaiting_retry'

export interface Session {
  id: string
  chatId: string
  parentSessionId: string | null
  parentToolCallId: string | null
  depth: 0 | 1 | 2
  model: string
  /**
   * Provedor da subsessão (fixado ao criar). `null`/ausente na principal — ela segue
   * `chat.config.providerId` — e em subsessões antigas (→ o do chat). Ver `sessionProviderId`.
   */
  providerId?: string | null
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
  /**
   * content em parts só no read_file de imagem/PDF: `[{type:'text', text:'[imagem: …]'}, <part por
   * referência>]` (ver SPEC.md → "Tools" / read_file). Os demais resultados continuam string.
   */
  | { role: 'tool'; tool_call_id: string; content: string | ContentPart[] }

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
  /** 'inter-chat' = mensagem entregue por outro chat (send_to_chat), role user com cabeçalho. */
  kind?:
    | 'queued'
    | 'forced'
    | 'interrupt-notice'
    | 'tool-cancelled'
    | 'error'
    | 'compaction'
    | 'inter-chat'
    | 'subagent-callback'
    | 'parent-message'
  /** Resposta do assistente cortada pelo usuário. */
  interrupted?: boolean
  usage?: Usage
  model?: string
  durationMs?: number
  error?: string
  /** Em mensagens tool de delegate_task. */
  subSessionId?: string
  toolStatus?: 'ok' | 'error' | 'denied' | 'cancelled'
  /** shell: diretório do shell ao final do comando (persistido entre chamadas da sessão). */
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
  // ---- mensagens entre chats (kind 'inter-chat', no chat de destino) ----
  /** Chat que enviou a mensagem. */
  fromChatId?: string
  /** Sessão (principal ou subagente) do chat de origem que chamou send_to_chat. */
  fromSessionId?: string
  /** Título do chat de origem no momento do envio (exibição se ele for apagado/renomeado). */
  fromChatTitle?: string
  /** Saltos da cadeia de mensagens entre chats (1 = enviada a partir de um turno humano). */
  interChatHops?: number
  /** send_to_chat (mensagem tool no remetente): chat de destino resolvido. */
  targetChatId?: string
  // ---- subagentes ----
  /** delegate_task com background=true (mensagem tool no pai). */
  background?: boolean
  /** kind 'subagent-callback': resultado de uma retomada (atualização após nova mensagem). */
  callbackUpdate?: boolean
  // ---- Smart-Approve (mensagem tool) ----
  /** Avaliação do juiz para esta chamada (custo aparece no rodapé da resposta). */
  smartApprove?: SmartApproveRecord
  /** Executada por liberação explícita do usuário ("Executar mesmo assim") após uma rejeição. */
  smartOverride?: boolean
  /** Gate de aprovação (modo lists/always): o que liberou ou bloqueou a chamada. */
  approval?: ApprovalRecord
  // ---- questionário (mensagem tool de ask_user) ----
  /** Perguntas (com imagens já resolvidas no store) + respostas estruturadas, para o card. */
  askUser?: AskUserRecord
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
  /** Meta extra aplicada ao persistir (ex.: kind 'inter-chat' + origem). */
  meta?: MessageMeta
}

/** Um sub-comando (ou a URL) avaliado contra as listas, como o card mostra. */
export interface ApprovalCheckItem {
  /** Sub-comando normalizado (tokens) ou URL normalizada. */
  text: string
  /** allow = liberado pela whitelist; ask = precisa da sua decisão. */
  verdict: 'allow' | 'ask'
  /** Entrada da whitelist que casou (verdict allow). */
  entry?: string
  /** Por que nunca é liberado automaticamente (eval, redirecionamento para arquivo…). */
  reason?: string
  /** Contexto (ex.: "dentro de $(…)", "via bash -c", "prefixo env"). */
  note?: string
  /** Pré-preenchimento do "+ whitelist/blacklist" (prefixo `programa sub *` ou o domínio). */
  suggestion: string
}

export interface ApprovalCheck {
  item: ApprovalItem
  items: ApprovalCheckItem[]
}

/** meta.approval da mensagem tool. */
export interface ApprovalRecord {
  item: ApprovalItem
  mode: ApprovalMode
  /** Sub-comandos/URL liberados pela whitelist. */
  allowed?: { text: string; entry: string }[]
  /** Bloqueado pela blacklist (nada rodou). */
  blocked?: { text: string; entry: string }
  /** Sub-comandos que você aprovou no card. */
  userAllowed?: string[]
  /** Sub-comando que você negou. */
  denied?: string
}

export interface ApprovalRequest {
  id: string
  chatId: string
  sessionId: string
  toolCallId: string
  toolName: ToolName
  args: unknown
  createdAt: number
  /** O Smart-Approve avaliou e pediu sua decisão (ou falhou) — o card mostra o motivo. */
  smartApprove?: SmartApproveRecord
  /** Modo lists: sub-comandos (ou a URL) com o veredito de cada um — card com 4 botões por item. */
  check?: ApprovalCheck
  /** Modo smart sem juiz configurado/ligado → perguntou (o card avisa). */
  smartMissing?: boolean
}

// ---- Questionário (tool ask_user) — ver SPEC.md → "Questionário (ask_user)" ----

/** Ícone de uma opção já resolvido: nome lucide, texto/emoji ou imagem do store. */
export type AskUserIcon =
  { kind: 'lucide'; name: string } | { kind: 'text'; text: string } | { kind: 'image'; url: string }

/** Ajuda de uma opção: texto (monospace) ou imagem do store. */
export type AskUserHelp = { kind: 'text'; text: string } | { kind: 'image'; url: string }

/** Opção como a UI mostra (campos ausentes não aparecem). `url` = `clearchat-attachment://…`. */
export interface AskUserOption {
  title: string
  description?: string
  icon?: AskUserIcon
  /** Imagem grande mostrada ao passar o mouse sobre a opção. */
  image?: string
  help?: AskUserHelp
}

export interface AskUserQuestion {
  title: string
  description?: string
  multiple: boolean
  options: AskUserOption[]
}

/** Resposta a uma pergunta: índices das opções marcadas (0-based) + texto de "Outro". */
export interface QuestionAnswer {
  selected: number[]
  other?: string
}

/** Questionário pendente (memória do main; some ao responder/cancelar). */
export interface QuestionRequest {
  id: string
  chatId: string
  sessionId: string
  toolCallId: string
  questions: AskUserQuestion[]
  /** Imagens/ícones que não puderam ser carregados (também vão no resultado ao modelo). */
  notes?: string[]
  createdAt: number
}

/**
 * Chamada ao modelo que falhou por erro de rede (memória do main; some ao decidir). Ver SPEC.md →
 * "Falha de conexão (nova tentativa)".
 */
export interface RetryRequest {
  id: string
  chatId: string
  sessionId: string
  /** Erro curto (mensagem + causa). */
  error: string
  /** Modelo/provedor da chamada (para o card). */
  model: string
  providerName?: string
  createdAt: number
}

/** meta.askUser da mensagem tool: o que foi mostrado e o que o usuário respondeu. */
export interface AskUserRecord {
  questions: AskUserQuestion[]
  outcome: 'answered' | 'cancelled' | 'app-closed'
  answers?: QuestionAnswer[]
  notes?: string[]
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

/** Processo em segundo plano iniciado por process_start (escopo: chat). */
export interface ProcessInfo {
  /** Id curto no chat ("p1", "p2"…). */
  id: string
  chatId: string
  /** Sessão que iniciou (principal ou subagente). */
  sessionId: string
  name: string
  command: string
  cwd: string
  pid: number | null
  status: 'running' | 'exited'
  exitCode: number | null
  signal: string | null
  startedAt: number
  endedAt: number | null
  /** Total de linhas já produzidas (numeração global do log). */
  lines: number
  lastLine: string
  /** Arquivo com o log completo. */
  logFile: string
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
  /** Output parcial (shell) opcional. */
  | {
      type: 'tool-running'
      sessionId: string
      toolCallId: string
      running: boolean
      output?: string
      /** Smart-Approve avaliando a chamada (antes de executar ou pedir aprovação). */
      judging?: boolean
    }
  | { type: 'queue-updated'; sessionId: string; queue: QueuedMessage[] }
  | { type: 'approval-requested'; request: ApprovalRequest }
  | { type: 'approval-resolved'; id: string }
  /** Questionário (ask_user) aguardando o usuário / respondido ou cancelado. */
  | { type: 'question-requested'; request: QuestionRequest }
  | { type: 'question-resolved'; id: string }
  /** Falha de conexão com o provedor aguardando "Tentar de novo" / "Cancelar". */
  | { type: 'retry-requested'; request: RetryRequest }
  | { type: 'retry-resolved'; id: string }
  | { type: 'chat-updated'; chat: Chat }
  /** Compactação: agendada (próximo passo), rodando (com o texto parcial do resumo) ou null (fim). */
  | {
      type: 'compaction'
      sessionId: string
      state: 'scheduled' | 'running' | null
      text?: string
    }
  | { type: 'error'; sessionId: string; error: string }
  /** Processos em segundo plano (process_start) do chat mudaram (início, saída, parada). */
  | { type: 'processes-updated'; chatId: string; processes: ProcessInfo[] }
  /** Modos globais / listas de aprovação mudaram (Configurações → Aprovações ou "+ lista" no card). */
  | { type: 'approval-settings-updated'; settings: ApprovalSettings }
