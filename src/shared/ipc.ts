// Nomes dos canais IPC (formato `domínio:método`) + interface `window.api`.
// Ver SPEC.md → "API do preload". Todo método (exceto onEvent) é ipcRenderer.invoke → ipcMain.handle.
import type { EngineConfig } from './webSearchSettings'
import type {
  ChatHostInfo,
  CloudSkill,
  DivergenceDetails,
  SyncDevice,
  SyncServerInfo,
  SyncServerKind,
  SyncStatus,
  TakeoverOptions
} from './sync'
import type { UpdateStatus } from './updates'
import type { SkillsDiscoverOptions, SkillsDiscovery, SkillsSettings } from './skills'
import type {
  Memory,
  MemoryCollection,
  MemoryCollectionInput,
  MemoryCollectionPatch,
  MemoryExtractionResult,
  MemoryInput,
  MemoryListQuery,
  MemoryPatch,
  MemoryPreview
} from './memory'
import type {
  AgentEvent,
  ApiMessage,
  ApprovalRequest,
  AttachmentInfo,
  Chat,
  ChatConfig,
  DirEntry,
  ModelInfo,
  Preset,
  ProcessInfo,
  Provider,
  QuestionAnswer,
  QuestionRequest,
  RetryRequest,
  QueuedMessage,
  Session,
  SmartApproveRecord,
  StoredMessage,
  ToolName
} from './types'

export const IPC = {
  providers: {
    list: 'providers:list',
    create: 'providers:create',
    update: 'providers:update',
    delete: 'providers:delete',
    listModels: 'providers:listModels',
    test: 'providers:test'
  },
  settings: {
    get: 'settings:get',
    set: 'settings:set'
  },
  chats: {
    list: 'chats:list',
    get: 'chats:get',
    create: 'chats:create',
    update: 'chats:update',
    delete: 'chats:delete'
  },
  sessions: {
    list: 'sessions:list',
    messages: 'sessions:messages'
  },
  messages: {
    update: 'messages:update',
    delete: 'messages:delete'
  },
  agent: {
    send: 'agent:send',
    forceSend: 'agent:forceSend',
    removeQueued: 'agent:removeQueued',
    getQueue: 'agent:getQueue',
    stop: 'agent:stop',
    regenerate: 'agent:regenerate',
    editBranch: 'agent:editBranch',
    selectBranch: 'agent:selectBranch',
    approve: 'agent:approve',
    pendingApprovals: 'agent:pendingApprovals',
    previewRequest: 'agent:previewRequest',
    runningSessions: 'agent:runningSessions',
    compact: 'agent:compact',
    stopSubagents: 'agent:stopSubagents',
    smartOverride: 'agent:smartOverride',
    smartApproveTest: 'agent:smartApproveTest'
  },
  fs: {
    listDir: 'fs:listDir',
    readFile: 'fs:readFile',
    pickDirectory: 'fs:pickDirectory',
    homeDir: 'fs:homeDir',
    mkdir: 'fs:mkdir'
  },
  app: {
    capabilities: 'app:capabilities'
  },
  updates: {
    status: 'updates:status',
    check: 'updates:check',
    openRelease: 'updates:openRelease'
  },
  presets: {
    list: 'presets:list',
    create: 'presets:create',
    update: 'presets:update',
    delete: 'presets:delete',
    duplicate: 'presets:duplicate'
  },
  memory: {
    listCollections: 'memory:listCollections',
    createCollection: 'memory:createCollection',
    updateCollection: 'memory:updateCollection',
    deleteCollection: 'memory:deleteCollection',
    list: 'memory:list',
    create: 'memory:create',
    update: 'memory:update',
    delete: 'memory:delete',
    preview: 'memory:preview',
    refreshSnapshot: 'memory:refreshSnapshot',
    extractNow: 'memory:extractNow'
  },
  attachments: {
    pick: 'attachments:pick',
    add: 'attachments:add'
  },
  questions: {
    answer: 'questions:answer',
    cancel: 'questions:cancel',
    pending: 'questions:pending'
  },
  retries: {
    retry: 'retries:retry',
    cancel: 'retries:cancel',
    pending: 'retries:pending'
  },
  processes: {
    list: 'processes:list',
    stop: 'processes:stop',
    logs: 'processes:logs'
  },
  approvals: {
    getSettings: 'approvals:getSettings',
    updateSettings: 'approvals:updateSettings'
  },
  skills: {
    getSettings: 'skills:getSettings',
    updateSettings: 'skills:updateSettings',
    discover: 'skills:discover',
    read: 'skills:read',
    pickFolder: 'skills:pickFolder',
    openFolder: 'skills:openFolder'
  },
  sync: {
    status: 'sync:status',
    probeServer: 'sync:probeServer',
    setServer: 'sync:setServer',
    requestCode: 'sync:requestCode',
    verifyCode: 'sync:verifyCode',
    refreshKeys: 'sync:refreshKeys',
    unlock: 'sync:unlock',
    unlockWithRecovery: 'sync:unlockWithRecovery',
    resolveMerge: 'sync:resolveMerge',
    lock: 'sync:lock',
    logout: 'sync:logout',
    changePassword: 'sync:changePassword',
    newRecoveryKey: 'sync:newRecoveryKey',
    devices: 'sync:devices',
    renameDevice: 'sync:renameDevice',
    revokeDevice: 'sync:revokeDevice',
    syncNow: 'sync:syncNow',
    openSignup: 'sync:openSignup',
    openSetup: 'sync:openSetup',
    chatStates: 'sync:chatStates',
    takeover: 'sync:takeover',
    cancelHandover: 'sync:cancelHandover',
    setPinned: 'sync:setPinned',
    confirmCwd: 'sync:confirmCwd',
    divergence: 'sync:divergence',
    resolveDivergence: 'sync:resolveDivergence',
    setActiveChat: 'sync:setActiveChat',
    answerPrompt: 'sync:answerPrompt',
    cloudSkills: 'sync:cloudSkills',
    trackedSkills: 'sync:trackedSkills',
    setSkillSync: 'sync:setSkillSync',
    downloadSkills: 'sync:downloadSkills',
    removeCloudSkill: 'sync:removeCloudSkill',
    stopTrackingSkill: 'sync:stopTrackingSkill',
    hostSkills: 'sync:hostSkills'
  },
  webSearch: {
    getSettings: 'webSearch:getSettings',
    updateEngines: 'webSearch:updateEngines',
    setKey: 'webSearch:setKey',
    revealKey: 'webSearch:revealKey',
    test: 'webSearch:test'
  }
} as const

/** Canal main → renderer (webContents.send) para todos os AgentEvent. */
export const EVENT_CHANNEL = 'agent:event'

type ValueOf<T> = T[keyof T]
export type IpcChannel = ValueOf<{ [D in keyof typeof IPC]: ValueOf<(typeof IPC)[D]> }>

/** Todos os canais invoke (útil para validar que o main registrou handlers para tudo). */
export const ALL_CHANNELS: IpcChannel[] = Object.values(IPC).flatMap(
  (domain) => Object.values(domain) as IpcChannel[]
)

// ---- Tipos de entrada/saída ----

export type ProviderInput = Omit<Provider, 'id' | 'createdAt'>
export type ProviderPatch = Partial<Omit<Provider, 'id' | 'createdAt'>>
export interface ProviderTestInput {
  kind?: import('./providerKinds').ProviderKind
  baseUrl: string
  apiKey: string
  headers?: Record<string, string>
}
export interface ProviderTestResult {
  ok: boolean
  error?: string
  modelCount?: number
}

export interface ChatCreateInput {
  title?: string
  config?: Partial<ChatConfig>
}
export interface ChatUpdateInput {
  title?: string
  config?: Partial<ChatConfig>
}

export type ApprovalDecision = 'allow' | 'deny'

/** "Testar" do Smart-Approve: a config (chat ou persona) + uma chamada de exemplo. */
export interface SmartApproveTestInput {
  config: Pick<
    ChatConfig,
    'smartApprove' | 'cwd' | 'confineToRoot' | 'sandboxBash' | 'appSignature' | 'appSignatureCustom'
  >
  tool: ToolName
  args: unknown
  /** Histórico de exemplo para {{recent_context}} / {{last_user_message}}. */
  history?: StoredMessage[]
}

/** Request EXATA da próxima chamada (apiKey mascarada). */
export interface RequestPreview {
  url: string
  headers: Record<string, string>
  body: unknown
  /** Avisos sobre a exibição (ex.: base64 de anexos encurtado no preview). */
  notes?: string[]
}

/** Arquivo enviado pelo renderer (arrastar/colar) para o store de anexos. */
export interface AttachmentAddInput {
  name: string
  mime?: string
  data: Uint8Array
}

/** Resultado do seletor de arquivos: anexos salvos + erros legíveis (tamanho/tipo). */
export interface AttachmentPickResult {
  items: AttachmentInfo[]
  errors: string[]
}

export interface FileContent {
  content: string
  truncated: boolean
  binary: boolean
}

export interface CompactOptions {
  /** Depois de compactar, roda o agente de novo (botão "Compactar e tentar de novo"). */
  retry?: boolean
}

export interface AppCapabilities {
  /** bubblewrap disponível → opção "shell em sandbox". */
  bwrap: boolean
  /** ripgrep disponível (search_files/find_files usam; senão, busca em JS). */
  ripgrep: boolean
  /** Shell do usuário detectado no start (descrição da tool `shell`). */
  shell?: import('./shellInfo').ShellInfoLite
}

/** Últimas linhas de um processo em segundo plano (popover da UI). */
export interface ProcessLogsResult {
  info: ProcessInfo
  lines: { n: number; text: string }[]
}

/** Buscador do web_search como a UI o vê: a chave só como máscara ("tvly-…abcd"). */
export interface WebSearchEngineState extends EngineConfig {
  hasKey: boolean
  keyMask: string | null
}
export interface WebSearchSettingsState {
  /** Ordem = prioridade. */
  engines: WebSearchEngineState[]
}
/** "Testar" de um buscador: uma pesquisa pequena (fora do intervalo global). */
export interface WebSearchTestResult {
  ok: boolean
  /** "3 resultados em 1,2 s" / motivo da falha. */
  message: string
  count?: number
  ms?: number
  /** Recusado pelo freio do botão (teste em andamento / muito seguido) — sem ir à rede. */
  throttled?: boolean
}

/** Persona nova. `config` passa por sanitizePresetConfig (só PRESET_FIELDS + cwd opcional). */
export interface PresetInput {
  name: string
  description?: string
  icon?: string
  config: Partial<ChatConfig>
}
/** `config`, se presente, SUBSTITUI a config inteira da persona (não é merge). */
export type PresetPatch = Partial<PresetInput>

export interface ClearApi {
  providers: {
    list(): Promise<Provider[]>
    create(p: ProviderInput): Promise<Provider>
    update(id: string, patch: ProviderPatch): Promise<Provider>
    delete(id: string): Promise<void>
    listModels(providerId: string): Promise<ModelInfo[]>
    test(p: ProviderTestInput): Promise<ProviderTestResult>
  }
  settings: {
    get<T = unknown>(key: string): Promise<T | null>
    set(key: string, value: unknown): Promise<void>
  }
  chats: {
    list(): Promise<Chat[]>
    get(id: string): Promise<Chat | null>
    create(input: ChatCreateInput): Promise<Chat>
    update(id: string, patch: ChatUpdateInput): Promise<Chat>
    delete(id: string): Promise<void>
  }
  sessions: {
    list(chatId: string): Promise<Session[]>
    messages(sessionId: string): Promise<StoredMessage[]>
  }
  /** Edição livre do histórico (mensagem digitada da principal → `agent.editBranch`). */
  messages: {
    update(id: string, message: ApiMessage): Promise<StoredMessage>
    delete(id: string): Promise<void>
  }
  agent: {
    /**
     * Só sessão depth 0. idle → inicia turno; running → enfileira. `attachments`: anexos já
     * salvos via attachments.pick/add (texto pode ser vazio se houver anexos).
     */
    send(
      sessionId: string,
      text: string,
      attachments?: AttachmentInfo[],
      /** Skills escolhidas na lâmpada do composer: SKILL.md lido no envio (erro → nada enviado). */
      skills?: string[]
    ): Promise<{ queued: boolean }>
    /** ⚡: aborta o que está rodando e injeta a mensagem já. */
    forceSend(queuedId: string): Promise<void>
    removeQueued(queuedId: string): Promise<void>
    getQueue(sessionId: string): Promise<QueuedMessage[]>
    /** Aborta (cascata para subsessões). */
    stop(sessionId: string): Promise<void>
    /**
     * Nova versão da resposta do turno que contém `messageId` (padrão: o último turno do caminho
     * ativo) — a anterior continua salva (‹ › para alternar). Resposta que é só erro é substituída.
     */
    regenerate(sessionId: string, messageId?: string): Promise<void>
    /**
     * Editar mensagem digitada da sessão principal = nova versão (irmã com o novo texto; anexos e
     * skills da original) e o agente roda a partir dela. Para o turno em andamento e os
     * subagentes em segundo plano da parte abandonada.
     */
    editBranch(messageId: string, message: ApiMessage): Promise<void>
    /**
     * Troca de versão (o caminho ativo passa por `messageId`); emite session-updated. Erro (pt-BR)
     * com a sessão ocupada ou subagente em segundo plano rodando na parte que muda.
     */
    selectBranch(messageId: string): Promise<Session>
    /**
     * Responde um card. Pergunta simples: 'allow' | 'deny'. Card do modo Listas: `items` = decisão
     * por sub-comando pendente (`pattern` = "+ whitelist"/"+ blacklist", salvo na lista global);
     * sem `items`, 'allow' = sim para todos.
     */
    approve(
      requestId: string,
      decision: ApprovalDecision,
      items?: import('./approvalPolicy').ApprovalItemDecision[]
    ): Promise<void>
    pendingApprovals(): Promise<ApprovalRequest[]>
    previewRequest(sessionId: string): Promise<RequestPreview>
    runningSessions(): Promise<string[]>
    /**
     * Compacta a conversa (só sessão principal). Ociosa → roda já; rodando → agenda para o
     * próximo limite de passo (`scheduled: true`).
     */
    compact(sessionId: string, opts?: CompactOptions): Promise<{ scheduled: boolean }>
    /** Para todos os subagentes do chat (inclusive em segundo plano); a sessão principal continua. */
    stopSubagents(chatId: string): Promise<void>
    /**
     * "Executar mesmo assim" num resultado rejeitado pelo Smart-Approve (id da mensagem tool):
     * libera a próxima chamada idêntica uma vez e envia "Pode executar …; eu aprovo." à sessão.
     */
    smartOverride(messageId: string): Promise<void>
    /** Roda o juiz numa chamada de exemplo (nada é salvo). */
    smartApproveTest(input: SmartApproveTestInput): Promise<SmartApproveRecord>
  }
  fs: {
    listDir(path: string): Promise<DirEntry[]>
    readFile(path: string): Promise<FileContent>
    pickDirectory(): Promise<string | null>
    homeDir(): Promise<string>
    /** Cria uma pasta (pai precisa existir; erro se já existir). Retorna o caminho absoluto. */
    mkdir(path: string): Promise<string>
  }
  app: {
    capabilities(): Promise<AppCapabilities>
  }
  /** Aviso de versão nova (SPEC → "Atualizações"): só consulta o GitHub; nada é baixado. */
  updates: {
    /** Versão instalada + resultado da última checagem (sem ir à rede). */
    status(): Promise<UpdateStatus>
    /** "Verificar atualizações": checa agora. Falha → `state: 'error'` (nunca lança). */
    check(): Promise<UpdateStatus>
    /** "Baixar": abre a página da última release no navegador (só URLs do repositório do app). */
    openRelease(): Promise<void>
  }
  /** Personas (presets de chat). Apagar a persona padrão limpa `defaultPresetId`. */
  presets: {
    list(): Promise<Preset[]>
    create(input: PresetInput): Promise<Preset>
    update(id: string, patch: PresetPatch): Promise<Preset>
    delete(id: string): Promise<void>
    /** Cópia com nome "X (cópia)". */
    duplicate(id: string): Promise<Preset>
  }
  /** Memória modular (SPEC → Memória). CRUD global; seleção fica em ChatConfig.memory. */
  memory: {
    /** Inclui coleções de chat (scope 'chat'). */
    listCollections(): Promise<MemoryCollection[]>
    createCollection(input: MemoryCollectionInput): Promise<MemoryCollection>
    updateCollection(id: string, patch: MemoryCollectionPatch): Promise<MemoryCollection>
    deleteCollection(id: string): Promise<void>
    list(query?: MemoryListQuery): Promise<Memory[]>
    create(input: MemoryInput): Promise<Memory>
    update(id: string, patch: MemoryPatch): Promise<Memory>
    delete(id: string): Promise<void>
    /** O que vai para a API na próxima request da sessão (índice/help/tools). */
    preview(sessionId: string): Promise<MemoryPreview>
    /** Renova o snapshot do índice da sessão ("Atualizar memória"). */
    refreshSnapshot(sessionId: string): Promise<MemoryPreview>
    /** Roda a extração de memórias agora (só sessão principal). */
    extractNow(sessionId: string): Promise<MemoryExtractionResult>
  }
  /** Anexos: salvos no store content-addressed (userData/attachments) antes do envio. */
  attachments: {
    /** Diálogo nativo (múltiplos arquivos); lê e salva no main. */
    pick(): Promise<AttachmentPickResult>
    /** Salva bytes vindos do renderer (arrastar/colar). Erro legível se grande demais/não suportado. */
    add(input: AttachmentAddInput): Promise<AttachmentInfo>
  }
  /** Questionários pendentes (tool ask_user). */
  questions: {
    /** Envia as respostas (uma por pergunta, na ordem). Erro legível se incompletas. */
    answer(id: string, answers: QuestionAnswer[]): Promise<void>
    /** Cancela: o resultado vira "[O usuário não respondeu ao questionário]" e o agente para. */
    cancel(id: string): Promise<void>
    pending(): Promise<QuestionRequest[]>
  }
  /** Falhas de conexão com o provedor aguardando decisão (card "Tentar de novo / Cancelar"). */
  retries: {
    /** Repete a mesma chamada do zero (o parcial já foi descartado). */
    retry(id: string): Promise<void>
    /** Termina o turno como erro (como antes) — o mesmo que Parar no card. */
    cancel(id: string): Promise<void>
    pending(): Promise<RetryRequest[]>
  }
  /** Processos em segundo plano (process_start) do chat. */
  processes: {
    list(chatId: string): Promise<ProcessInfo[]>
    /** SIGTERM no grupo; SIGKILL após ~3 s. */
    stop(chatId: string, id: string): Promise<void>
    logs(chatId: string, id: string, tail?: number): Promise<ProcessLogsResult>
  }
  /** Aprovações: modos globais por item + listas globais (settings approvalModes / approvalLists). */
  approvals: {
    getSettings(): Promise<import('./types').ApprovalSettings>
    /** Substitui `modes` e/ou `lists` (inteiros). Entrada inválida → erro legível. */
    updateSettings(
      patch: Partial<import('./types').ApprovalSettings>
    ): Promise<import('./types').ApprovalSettings>
  }
  /** Skills (Configurações → Skills; seleção por chat em ChatConfig.skills). Ver SPEC → Skills. */
  skills: {
    getSettings(): Promise<SkillsSettings>
    /** Substitui `locations` e/ou `projectSkills`. Emite `skills-changed`. */
    updateSettings(patch: Partial<SkillsSettings>): Promise<SkillsSettings>
    /** Escaneia os locais (+ projeto de `cwd`). `rescan` ignora o cache (e emite `skills-changed`). */
    discover(opts?: SkillsDiscoverOptions): Promise<SkillsDiscovery>
    /** Conteúdo de um SKILL.md (preview somente leitura). Só arquivos chamados SKILL.md. */
    read(file: string): Promise<string>
    /** Diálogo nativo para escolher uma pasta de skills. */
    pickFolder(): Promise<string | null>
    /** Abre a pasta no gerenciador de arquivos (`~` expandido). */
    openFolder(path: string): Promise<void>
  }
  /** Buscadores do web_search (Configurações → Pesquisa na web). */
  webSearch: {
    getSettings(): Promise<WebSearchSettingsState>
    /** Substitui a lista (ordem/ligado/opções). Ligar buscador com API sem chave → erro legível. */
    updateEngines(
      engines: import('./webSearchSettings').EngineConfig[]
    ): Promise<WebSearchSettingsState>
    /** Salva a chave (null/vazio remove e desliga o buscador). */
    setKey(
      engine: import('./webSearchSettings').SearchEngineId,
      key: string | null
    ): Promise<WebSearchSettingsState>
    /** Chave em claro, a pedido (botão mostrar). */
    revealKey(engine: import('./webSearchSettings').SearchEngineId): Promise<string | null>
    test(engine: import('./webSearchSettings').SearchEngineId): Promise<WebSearchTestResult>
  }
  /** Sync (conta, servidor, host de execução, divergência) — ver docs/SYNC_PROTOCOL.md. */
  sync: {
    status(): Promise<SyncStatus>
    /** Valida um servidor (GET <base>/api/info). Sem url = o servidor atual. */
    probeServer(url?: string): Promise<SyncServerInfo>
    /** Só deslogado. kind 'official' = clear.ezenere.com; 'self' = url. */
    setServer(kind: SyncServerKind, url?: string): Promise<SyncStatus>
    /** Envia o código por e-mail (captcha numa janela, se a instância exigir). */
    requestCode(email: string): Promise<void>
    verifyCode(email: string, code: string): Promise<SyncStatus>
    /** Conta sem chaves: "Já defini a senha". */
    refreshKeys(): Promise<SyncStatus>
    unlock(password: string, remember: boolean): Promise<SyncStatus>
    unlockWithRecovery(
      recoveryKey: string,
      newPassword: string,
      remember: boolean
    ): Promise<SyncStatus>
    resolveMerge(priority: 'online' | 'local'): Promise<SyncStatus>
    /** Esquece a DEK neste computador (continua logado). */
    lock(): Promise<SyncStatus>
    logout(): Promise<SyncStatus>
    changePassword(newPassword: string): Promise<void>
    newRecoveryKey(): Promise<{ recoveryKey: string }>
    devices(): Promise<SyncDevice[]>
    renameDevice(id: string, name: string): Promise<void>
    revokeDevice(id: string): Promise<void>
    syncNow(): Promise<SyncStatus>
    openSignup(): Promise<void>
    openSetup(): Promise<void>
    chatStates(): Promise<ChatHostInfo[]>
    /** "Executar neste dispositivo" (troca de host). */
    takeover(chatId: string, opts: TakeoverOptions): Promise<ChatHostInfo>
    cancelHandover(chatId: string): Promise<void>
    setPinned(chatId: string, pinned: boolean): Promise<void>
    /** Raiz local escolhida ao virar host de um chat vindo de outro dispositivo. */
    confirmCwd(chatId: string, cwd: string): Promise<void>
    divergence(chatId: string): Promise<DivergenceDetails>
    /** Mantém uma versão; a outra é APAGADA (depois do aviso na UI). */
    resolveDivergence(chatId: string, keep: 'online' | 'local'): Promise<void>
    /** Chat aberto na tela (stream ao vivo do host). */
    setActiveChat(chatId: string | null): Promise<void>
    /** "Chat apagado em outro dispositivo": manter como novo / descartar. */
    answerPrompt(chatId: string, keep: boolean): Promise<SyncStatus>
    cloudSkills(): Promise<CloudSkill[]>
    /** Skills locais com "Sincronizar" ligado (nomes). */
    trackedSkills(): Promise<string[]>
    setSkillSync(name: string, on: boolean): Promise<void>
    downloadSkills(names?: string[]): Promise<number>
    removeCloudSkill(name: string): Promise<void>
    stopTrackingSkill(name: string): Promise<void>
    /** Skills do host (controle remoto): null = este dispositivo executa o chat. */
    hostSkills(chatId: string): Promise<{ name: string; description: string }[] | null>
  }
  /** Assina eventos do agente; retorna a função de unsubscribe. */
  onEvent(cb: (e: AgentEvent) => void): () => void
}
