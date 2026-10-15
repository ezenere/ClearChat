# ClearChat — Spec / Contrato

App desktop **Electron** (electron-vite + React + TypeScript + Tailwind v4 + zustand + lucide-react).
UI em **pt-BR**. Chat com IA via qualquer endpoint **OpenAI-compatible** (`POST {baseUrl}/chat/completions`, SSE streaming). Padrão: OpenRouter (`https://openrouter.ai/api/v1`).

Princípio: **minimalismo + controle total**. Criar chat → escolher modelo + system prompt + **diretório raiz** (workspace) → conversar. Tudo que vai para a API como parte do prompt aparece na UI com um ícone **(i)** com tooltip explicando exatamente o que é enviado e como (ex.: "Enviado como mensagem `role: system`", "Enviado no campo `tools` da request", "Anexado ao final do system prompt").

## Layout de pastas

```
src/
  shared/      types.ts, ipc.ts (canais + interface ClearApi), defaults.ts (textos/config padrão), tools.ts (definições das tools)   ← contrato
  main/        index.ts (janela), db.ts, migrate.ts (dados do nome antigo), ipc.ts (handlers), agent/ (runner, llm, request, queue, approvals), tools/
  preload/     index.ts (contextBridge → window.api)
  renderer/    React app
```

Segurança Electron: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: false` só se preciso para preload. Toda lógica de rede, tools e DB fica no **main process**.

## Banco (SQLite, better-sqlite3) — `app.getPath('userData')/clearchat.db`

```sql
providers(id TEXT PK, name TEXT, base_url TEXT, api_key TEXT, headers_json TEXT DEFAULT '{}', created_at INTEGER)
settings(key TEXT PK, value TEXT)                 -- JSON values. keys: defaultProviderId + defaultModel (o par "Modelo padrão"), defaultSystemPrompt, defaultCwd, defaultPresetId, presetsSeeded
chats(id TEXT PK, title TEXT, config_json TEXT, main_session_id TEXT, created_at INTEGER, updated_at INTEGER)
sessions(id TEXT PK, chat_id TEXT, parent_session_id TEXT NULL, parent_tool_call_id TEXT NULL, depth INTEGER,
         model TEXT, title TEXT, task TEXT NULL, status TEXT, created_at INTEGER,
         provider_id TEXT NULL)                   -- provedor da subsessão (ALTER TABLE idempotente em db.ts); NULL na principal
messages(id TEXT PK, session_id TEXT, seq INTEGER, message_json TEXT, meta_json TEXT, created_at INTEGER)
presets(id TEXT PK, name TEXT, description TEXT, icon TEXT, config_json TEXT, created_at INTEGER, updated_at INTEGER)  -- personas (ver "Personas")
```
IDs: `crypto.randomUUID()`. Timestamps: `Date.now()`. Deletar chat apaga sessions/messages (cascade manual ou FK ON DELETE CASCADE).

**Migração do nome antigo** (`src/main/migrate.ts`, `migrateLegacyData(userData)`): o app se chamava "CleartChat" (typo). No `ready`, antes de abrir o banco e só no userData padrão (não com `CLEARCHAT_USER_DATA`): se `<userData>/clearchat.db` não existe e `<irmão>/CleartChat/cleartchat.db` existe, copia com `VACUUM INTO` numa conexão somente leitura (cópia consistente, já com o WAL) para um temporário e renomeia; fallback: cópia crua de `.db` + `-wal`/`-shm` validada ao abrir. O diretório antigo fica intacto. Testado em `e2e/unit.test.ts`.

## Tipos compartilhados (`src/shared/types.ts`)

```ts
export interface Provider { id: string; name: string; baseUrl: string; apiKey: string; headers: Record<string,string>; createdAt: number }
export interface ModelInfo { id: string; name?: string; contextLength?: number; promptPrice?: number; completionPrice?: number; supportsTools?: boolean
  inputModalities?: string[] }          // OpenRouter architecture.input_modalities (text, image, file, audio, video); ausente = desconhecido

export interface ChatParams {           // só campos definidos (≠ undefined/null) vão para a request
  temperature?: number; top_p?: number; top_k?: number; max_tokens?: number
  frequency_penalty?: number; presence_penalty?: number; repetition_penalty?: number; seed?: number
  reasoning_effort?: 'minimal' | 'low' | 'medium' | 'high'   // OpenRouter: vira { reasoning: { effort } }
  extraBody?: string                    // JSON livre, merge raso no body (último a ser aplicado)
}
export type ToolName = 'list_dir' | 'read_file' | 'search_files' | 'find_files' | 'write_file' | 'edit_file' | 'bash' | 'web_search' | 'browse_url' | 'list_models' | 'delegate_task'
  | 'get_chat_info' | 'list_chats' | 'send_to_chat' | 'read_history'                              // chats / histórico
  | 'check_subagents' | 'wait_subagents' | 'cancel_subagent' | 'message_subagent'                  // só com delegate_task disponível
export const CONFIRM_TOOLS: ToolName[] = ['bash', 'web_search', 'browse_url']

export interface ChatConfig {
  providerId: string
  model: string
  systemPrompt: string
  params: ChatParams
  enabledTools: ToolName[]
  nativeTools: boolean          // envia definições no campo `tools` da API (padrão true)
  toolsInPrompt: boolean        // anexa toolsPromptText ao system prompt (padrão false)
  toolsPromptText: string | null// null = texto padrão gerado (defaults.ts); editável
  envInPrompt: boolean          // anexa bloco <environment> (cwd, SO, shell) ao system prompt (padrão true)
  cacheEnabled: boolean         // adiciona breakpoints cache_control (padrão: true se baseUrl contém openrouter.ai)
  subagentSystemPrompt: string  // system prompt dos subagentes
  cwd: string                   // DIRETÓRIO RAIZ (workspace) da sessão, absoluto — UI: "Diretório raiz"; compartilhado por todos os subagentes
  confineToRoot: boolean        // tools de arquivo recusam caminhos fora da raiz (após realpath) — padrão true
  sandboxBash: boolean          // bash via bubblewrap (raiz rw, resto ro, /tmp privado, rede ok) — padrão false; só se `bwrap` existir
  contextWindow?: number | null // override da janela de contexto (tokens) — p/ endpoints que não informam
  compactThreshold: number      // fração da janela que dispara a sugestão/compactação automática — padrão 0.9
  autoCompact: boolean          // compacta a sessão principal sozinho ao atingir o limite — padrão false (subsessões: sempre)
  compactPrompt: string | null  // prompt de compactação; null = DEFAULT_COMPACT_PROMPT (defaults.ts)
  maxToolOutputChars: number    // teto de caracteres de cada resultado de tool — padrão 30000 (LIMITS em shared/limits.ts)
  autoApprove: ToolName[]       // tools de CONFIRM_TOOLS que o usuário marcou "permitir sempre neste chat"
  presetId?: string             // persona de onde o chat veio — só informativo
}
export interface Preset { id: string; name: string; description: string; icon: string /* emoji ou nome lucide */; config: Partial<ChatConfig>; createdAt: number; updatedAt: number }
export interface Chat { id: string; title: string; config: ChatConfig; mainSessionId: string; createdAt: number; updatedAt: number }

export type SessionStatus = 'idle' | 'running' | 'awaiting_approval' | 'done' | 'error' | 'interrupted'
  | 'waiting'   // subagente que encerrou o turno com filhos em segundo plano pendentes (dorme até os callbacks)
export interface Session { id: string; chatId: string; parentSessionId: string | null; parentToolCallId: string | null
  depth: 0 | 1 | 2; model: string; providerId?: string | null; title: string; task: string | null; status: SessionStatus; createdAt: number }

// Formato OpenAI exato — é o que é persistido e reenviado byte-a-byte (essencial para token caching)
export type ContentPart =               // todos aceitam cache_control?: { type: 'ephemeral' } e _attachment?: AttachmentMeta (privado, nunca enviado)
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }                     // persistido: url = clearchat-attachment://<sha256>.<ext>
  | { type: 'file'; file: { filename: string; file_data: string } }      // PDF (idem)
  | { type: 'input_audio'; input_audio: { data: string; format: string } } // wav/mp3 (idem)
export interface AttachmentMeta { name: string; mime: string; size: number; kind: 'image' | 'pdf' | 'audio' | 'text'; file: string; truncated?: boolean }
export interface AttachmentInfo extends AttachmentMeta { sha256: string }   // anexo salvo no store (attachments.pick/add → agent.send)
export interface ToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }
export type ApiMessage =
  | { role: 'system'; content: string | ContentPart[] }
  | { role: 'user'; content: string | ContentPart[] }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[]; reasoning?: string }
  | { role: 'tool'; tool_call_id: string; content: string }

export interface Usage { promptTokens: number; completionTokens: number; cachedTokens?: number; cacheWriteTokens?: number; reasoningTokens?: number; cost?: number }
export interface MessageMeta {
  synthetic?: boolean            // criado pelo app (não pelo usuário nem pelo modelo) — UI mostra (i) com o texto exato
  kind?: 'queued' | 'forced' | 'interrupt-notice' | 'tool-cancelled' | 'error' | 'compaction'
       | 'inter-chat' | 'subagent-callback' | 'parent-message'
  interrupted?: boolean          // resposta do assistente cortada pelo usuário
  usage?: Usage; model?: string; durationMs?: number; error?: string
  subSessionId?: string          // em mensagens tool de delegate_task
  toolStatus?: 'ok' | 'error' | 'denied' | 'cancelled'
  shellCwd?: string              // bash: diretório do shell ao fim do comando (card mostra; restaura após reiniciar)
  // fronteira de compactação (kind 'compaction'):
  summaryOf?: { fromSeq: number; toSeq: number }; compactedCount?: number
  usageBefore?: number           // tokens de contexto antes
  contextEstimate?: number       // estimativa logo depois (system + tools + resumo) — medidor até a próxima usage real
  compactUsage?: Usage           // usage da chamada de resumo (não faz parte do histórico)
  // mensagens entre chats (kind 'inter-chat', no destino): fromChatId, fromSessionId, fromChatTitle, interChatHops
  // send_to_chat (mensagem tool no remetente): targetChatId
  // subagentes: background (tool do delegate_task em segundo plano), callbackUpdate (callback de retomada)
  // kind 'parent-message' (no subagente): fromSessionId
}
export interface StoredMessage { id: string; sessionId: string; seq: number; message: ApiMessage; meta: MessageMeta; createdAt: number }

export interface QueuedMessage { id: string; sessionId: string; text: string; createdAt: number; attachments?: AttachmentInfo[]
  meta?: MessageMeta }           // meta extra aplicada ao persistir (inter-chat, callback de subagente, mensagem do pai)
export interface ApprovalRequest { id: string; chatId: string; sessionId: string; toolCallId: string; toolName: ToolName; args: unknown; createdAt: number }
export interface StreamDraft { content: string; reasoning: string; toolCalls: { id: string; name: string; arguments: string }[] }
export interface DirEntry { name: string; path: string; isDir: boolean; size: number; mtime: number }

export type AgentEvent =
  | { type: 'session-created'; session: Session }
  | { type: 'session-updated'; session: Session }
  | { type: 'session-deleted'; sessionId: string; chatId: string }   // subsessão apagada (regenerate / apagar msg do delegate); um evento por sessão, descendentes primeiro
  | { type: 'message-added'; message: StoredMessage }
  | { type: 'message-updated'; message: StoredMessage }
  | { type: 'message-deleted'; sessionId: string; messageId: string }
  | { type: 'draft'; sessionId: string; draft: StreamDraft | null }      // throttled ~30–60ms; null = fim do stream
  | { type: 'tool-running'; sessionId: string; toolCallId: string; running: boolean; output?: string } // output parcial (bash) opcional
  | { type: 'queue-updated'; sessionId: string; queue: QueuedMessage[] }
  | { type: 'approval-requested'; request: ApprovalRequest }
  | { type: 'approval-resolved'; id: string }
  | { type: 'chat-updated'; chat: Chat }
  | { type: 'compaction'; sessionId: string; state: 'scheduled' | 'running' | null; text?: string } // text = resumo parcial (stream)
  | { type: 'error'; sessionId: string; error: string }
```

## API do preload (`window.api`) — todos retornam Promise (ipcRenderer.invoke), exceto `onEvent`

```ts
interface ClearApi {
  providers: { list(): Provider[]; create(p: Omit<Provider,'id'|'createdAt'>): Provider; update(id, patch: Partial<Provider>): Provider
               delete(id): void; listModels(providerId): ModelInfo[]; test(p: {baseUrl, apiKey, headers?}): { ok: boolean; error?: string; modelCount?: number } }
  settings:  { get<T>(key): T | null; set(key, value: unknown): void }
  chats:     { list(): Chat[]; get(id): Chat | null; create(input: { title?: string; config?: Partial<ChatConfig> }): Chat
               update(id, patch: { title?: string; config?: Partial<ChatConfig> }): Chat; delete(id): void }
  sessions:  { list(chatId): Session[]; messages(sessionId): StoredMessage[] }
  messages:  { update(id, message: ApiMessage): StoredMessage; delete(id): void }   // edição livre do histórico
  agent: {
    send(sessionId, text, attachments?: AttachmentInfo[]): { queued: boolean }   // principal OU subagente (conversa direta). idle → inicia turno; running/waiting → enfileira (com os anexos); subagente concluído → retoma (resultado volta ao pai como callback)
    forceSend(queuedId): void                   // ⚡: aborta o que está rodando e injeta a mensagem já
    removeQueued(queuedId): void
    getQueue(sessionId): QueuedMessage[]
    stop(sessionId): void                        // principal: aborta (cascata só para subsessões bloqueantes; as em segundo plano continuam). Subagente: ele + todos os descendentes
    stopSubagents(chatId): void                  // "Parar todos os subagentes" (a principal continua)
    regenerate(sessionId): void                  // remove mensagens após a última msg do usuário e roda de novo
    approve(requestId, decision: 'allow' | 'deny' | 'always'): void   // 'always' adiciona a chat.config.autoApprove
    pendingApprovals(): ApprovalRequest[]
    previewRequest(sessionId): { url: string; headers: Record<string,string>; body: unknown; notes?: string[] }  // request EXATA da próxima chamada (apiKey mascarada; base64 de anexos encurtado + nota)
    runningSessions(): string[]
    compact(sessionId, opts?: { retry?: boolean }): { scheduled: boolean }  // só depth 0; ociosa → já; rodando → próximo limite de passo
  }
  fs: { listDir(path): DirEntry[]; readFile(path): { content: string; truncated: boolean; binary: boolean }; pickDirectory(): string | null; homeDir(): string
        mkdir(path): string }                    // "Nova pasta…" (pai precisa existir; erro "Já existe")
  app: { capabilities(): { bwrap: boolean; ripgrep: boolean } }
  presets: { list(): Preset[]; create(input: PresetInput): Preset; update(id, patch: Partial<PresetInput>): Preset   // patch.config SUBSTITUI a config
             delete(id): void; duplicate(id): Preset }   // PresetInput = { name; description?; icon?; config: Partial<ChatConfig> }
  attachments: { pick(): { items: AttachmentInfo[]; errors: string[] }        // diálogo nativo (multi); o main lê e salva no store
                 add(input: { name; mime?; data: Uint8Array }): AttachmentInfo } // arrastar/colar: bytes do renderer → store (erro legível se grande/não suportado)
  onEvent(cb: (e: AgentEvent) => void): () => void
}
```
Canais IPC: `domínio:método` (ex.: `chats:create`, `agent:send`), eventos em `agent:event`. Constantes em `src/shared/ipc.ts`.

## Construção da request (`src/main/agent/request.ts` — função pura `buildRequest(chat, session, history, provider)`, usada pelo runner E pelo preview)

```
body = {
  model: session.model,
  messages: [ systemMessage, ...activeHistory(history).map(m => m.message) ],   // a partir da fronteira de compactação mais recente
  stream: true, stream_options: { include_usage: true },
  tools?: (nativeTools && toolsDisponiveis.length) ? definicoes : omitido,
  ...params definidos (reasoning_effort → OpenRouter: reasoning:{effort}; outros: reasoning_effort),
  usage: { include: true }   // só se baseUrl contém openrouter.ai
  ...JSON.parse(extraBody)   // por último
}
system content = (session.depth===0 ? systemPrompt : subagentSystemPrompt)
               + (envInPrompt ? "\n\n<environment>\nroot: …\nos: …\nshell: bash\n<regras do workspace>\n</environment>" : "")   // SEM data/hora nem dir. atual do shell → estável p/ cache
               + (toolsInPrompt ? "\n\n" + (toolsPromptText ?? defaultToolsPrompt(tools, nativeTools)) : "")
```
Se o system content ficar vazio, não envia mensagem system.
Bloco de ambiente (`environmentBlock(cfg, env)`): `root: <cwd>`, `os`, `shell`, a linha "Diretório raiz (workspace) desta sessão: root acima. Caminhos relativos nas ferramentas resolvem a partir dele e o bash começa nele (o diretório do shell persiste entre chamadas)." + (confineToRoot) "As ferramentas de arquivo só acessam caminhos dentro do diretório raiz." + (sandboxBash e bwrap instalado) "O bash roda em sandbox: só o diretório raiz (e um /tmp privado) é gravável.".
Headers: `Content-Type`, `Authorization: Bearer <key>`, + headers da **assinatura de app** do chat (ver abaixo; qualquer provider) e por último `provider.headers` (sobrescrevem).

**Token caching**: o histórico é imutável e reenviado exatamente como persistido; nada dinâmico no prefixo. Se `cacheEnabled`: (1) system vira `[{type:"text", text, cache_control:{type:"ephemeral"}}]`; (2) a **última mensagem do array (qualquer role, inclusive `tool`)** tem seu último text part marcado com `cache_control` (se não tiver texto, recua até a anterior que tenha); (3) a última mensagem `user`, se for outra, também (máx. 3 breakpoints; Anthropic aceita 4). Conversão string → parts **apenas na cópia enviada**, não no DB. Mensagens `meta.kind: "error"` (erros persistidos só para exibição) são excluídas da request. Ordem fixa: tools → system → histórico. Mostrar `cachedTokens` no rodapé de uso de cada resposta. Parse do usage: `usage.prompt_tokens_details.cached_tokens`, `usage.prompt_tokens_details.cache_write_tokens` (se houver), `usage.completion_tokens_details.reasoning_tokens`, `usage.cost` (OpenRouter).

Streaming: SSE `data: {...}` com `choices[0].delta.{content, reasoning | reasoning_content, tool_calls[]}`; acumular tool_calls por `index`. Ignorar linhas `: OPENROUTER PROCESSING`. `[DONE]` encerra. Erros HTTP → mensagem de erro legível (body da resposta) como evento `error` + session status `error` + mensagem persistida só para exibição (`{role:'assistant', content: erro}`, `meta: {kind:'error', synthetic:true, error}`) — sobrevive ao reinício e **nunca** vai para a API (`buildRequest` a exclui). Regenerate/apagar a mensagem (tool com `meta.subSessionId` ou assistant com o tool_call) de um `delegate_task` apaga a subsessão (e descendentes) e emite `session-deleted`.

**Modo sem tools nativas** (`nativeTools=false` e tools habilitadas): o texto padrão de tools no prompt instrui o modelo a chamar tools com `<tool_call>{"name": "...", "arguments": {...}}</tool_call>`. O runner faz parse disso no texto final do assistente; o resultado volta como mensagem `user` sintética: `<tool_result name="...">…</tool_result>` (meta.synthetic, kind `tool-result-text` pode ser derivado do conteúdo). Prioridade secundária, mas implementar.

### Assinatura de app (`src/shared/appSignatures.ts`)

Por chat, o usuário escolhe quais headers de atribuição (`HTTP-Referer` / `X-Title`) vão em cada request — controle total, para qualquer provider (não só OpenRouter).
- `ChatConfig.appSignature: string` (id de `APP_SIGNATURES`; padrão `DEFAULT_APP_SIGNATURE = 'clearchat'`; chats antigos sem o campo = `'clearchat'`; o id antigo `'cleartchat'` é um alias silencioso — `normalizeAppSignatureId` o resolve para `'clearchat'` ao ler o chat, no seletor e em `resolveAppSignatureHeaders`) e `ChatConfig.appSignatureCustom?: { referer: string; title: string }` (usado quando `appSignature === 'custom'`).
- `APP_SIGNATURES: AppSignature[]` (`{ id, label, referer?, title? }`): `none` (Nenhuma — não envia headers de atribuição), `clearchat` (padrão), `cline`, `roo-code`, `kilo-code`, `aider`, `opencode`, `sillytavern`, `open-webui`, `librechat` (valores conferidos no código-fonte de cada app) e `custom` (Personalizada).
- `resolveAppSignatureHeaders(id, custom?)` → `{ 'HTTP-Referer'?, 'X-Title'? }` (campos vazios são omitidos; id desconhecido → ClearChat). `buildRequest` aplica depois de `Authorization` e antes de `provider.headers`; o `previewRequest` mostra os headers; subsessões usam a assinatura do chat.
- "Auto-aprovar tudo" na UI = `autoApprove = CONFIRM_TOOLS` (sem mudança no backend).

### Personas (presets de chat) — `src/shared/presets.ts`

Registro de configurações de chat reutilizáveis (tabela `presets`, `presetsRepo` em `repo.ts`, canais `presets:*`).
- `config` é um **snapshot parcial** de `ChatConfig` com só os campos de `PRESET_FIELDS`: `providerId`, `model`, `systemPrompt`, `params`, `enabledTools`, `nativeTools`, `toolsInPrompt`, `toolsPromptText`, `envInPrompt`, `cacheEnabled`, `subagentSystemPrompt`, `autoApprove`, `appSignature`, `appSignatureCustom`, `contextWindow`, `compactThreshold`, `autoCompact`, `compactPrompt`, `maxToolOutputChars`, `confineToRoot`, `sandboxBash` — e `cwd` só se o usuário marcar "Incluir diretório raiz" (desligado por padrão). `presetId`, título e chaves desconhecidas nunca entram (`sanitizePresetConfig`, aplicado no main ao salvar e ao ler).
- **Campos ausentes seguem os padrões** de "Novos chats" (modelo/system prompt/pasta padrão + `DEFAULT_CHAT_CONFIG`): `applyPreset(base, config)` = base ← persona (params mesclados). `providerId` + `model` são **um par** (`resolvePresetModel` em `src/shared/models.ts`): persona sem modelo → o par padrão (o `providerId` sozinho é ignorado); com modelo e sem `providerId` (antigas) → o modelo no provedor padrão; provedor apagado → o par padrão + aviso no Novo chat e no editor ("O provedor … não existe mais"). Sem `cacheEnabled` na persona → segue o provedor (OpenRouter liga).
- `snapshotPreset(chatConfig, { includeCwd })` = persona a partir de um chat (snapshot completo dos campos acima). `patchPresetConfig` mescla edições num rascunho (params nulos removem).
- **Primeira execução** (`presetsRepo.seed()`, chamado em `registerIpc`): cria "Padrão" com config **vazia** (= segue "Novos chats", então mudar o modelo/system prompt padrão continua valendo) e a define em `defaultPresetId`; a flag `presetsSeeded` impede recriá-la depois de apagada. Sem nenhuma persona o app funciona igual (só os padrões).
- Apagar a persona padrão limpa `defaultPresetId`. `duplicate` cria "Nome (cópia)". Chats guardam `config.presetId` (informativo: apagar/editar a persona não muda chats existentes).
- Tudo o que uma persona define são os mesmos campos do chat, com os mesmos (i) (system prompt, params, tools…), nos mesmos editores.

## Tools (`src/main/tools/`)

**Diretório raiz**: paths relativos resolvem contra `chat.config.cwd` (a raiz; `~` expande). Com `confineToRoot` (padrão), `list_dir`/`read_file`/`write_file`/`edit_file`/`search_files`/`find_files` rejeitam caminhos que, após `realpath` (seguindo symlinks — inclusive o ancestral existente mais profundo de um caminho que ainda não existe — e resolvendo `..`), fiquem fora da raiz: erro "acesso negado — … fica fora do diretório raiz" devolvido como `role: tool`. Sem confinação, absolutos são aceitos.

**Limites (higiene do contexto)** — `src/shared/limits.ts` (`LIMITS`), único configurável: `maxToolOutputChars` (padrão 30000; `runLocalTool` aplica como rede de segurança com corte início/fim). Cada card de tool mostra o tamanho aproximado do resultado enviado (caracteres ÷ 4 ≈ tokens).
- `read_file`: sem offset/limit lê no máx. 2000 linhas; linhas > 2000 chars cortadas com `[… linha cortada: N caracteres]`; teto de chars corta em linha inteira. Saída parcial começa com `[arquivo grande: 15.234 linhas, 820 KB — mostrando linhas 1–2.000. Use offset/limit para ler o resto, ou search_files para localizar trechos.]` (ou `[linhas X–Y de N (tamanho). Continue com offset=…]` com offset/limit); arquivo inteiro termina com `[fim do arquivo · N linhas]` (total de linhas sempre informado). > 5 MB sem offset/limit: não lê (tamanho + instruções); com offset/limit lê em streaming. Binário → recusa com tipo (PNG, PDF, ELF…) e tamanho.
- `bash`: mantém início (40%) e fim (60%) com `[… N chars / M linhas omitidos …]` + dica de redirecionar para arquivo e usar grep/head/tail.
- `browse_url`: texto paginado (12.000 chars/página) com `offset`; cabeçalho `[caracteres X–Y de Z — continue com offset=…]`; texto extraído em cache por sessão+URL por 5 min (paginação não recarrega); links só na 1ª página (máx. 40).
- `list_models`: padrão 50 modelos (máx. 200, `modelsDefaultResults`/`modelsMaxResults`), corta antes do teto de saída com dica para refinar.
- `web_search`: máx. 8 resultados, trecho ≤ 300 chars. `list_dir`: máx. 300 entradas (com tamanhos; nota para usar find/search em árvores grandes).

| tool | args | confirmação |
|---|---|---|
| list_dir | `{ path?: string }` | não |
| read_file | `{ path, offset?: number, limit?: number }` (linhas, numeradas `N\t…`) | não |
| search_files | `{ pattern (regex), path?, glob?, max_results? (padrão 50, máx. 300), case_insensitive? }` — ripgrep (`rg`, roda dentro da pasta-alvo; `--hidden`, respeita .gitignore, ignora .git/node_modules, ≤ 5 MB) ou walker JS (sem seguir symlinks, pula binários); saída `caminho:linha: texto` relativa à raiz | não |
| find_files | `{ glob, path? }` — glob sem `/` casa com o nome em qualquer pasta; ordenado; máx. 200 listados | não |
| write_file | `{ path, content }` (cria pastas) | não |
| edit_file | `{ path, old_string, new_string, replace_all?: boolean }` (erro se não único) | não |
| bash | `{ command, timeout_ms?: number }` — `spawn('bash', ['-lc', script])` em process group próprio; stdout+stderr, exit code, timeout padrão 120s, kill do grupo em abort. **Diretório persistente por sessão**: o script começa com `trap 'builtin pwd >&3' EXIT` + `cd "$CLEAR_START_DIR"` (1ª chamada = raiz); o pwd final lido do fd 3 vira o início da próxima chamada (`meta.shellCwd`; restaurado do histórico após reiniciar; volta à raiz se a raiz mudar ou o dir sumir). Resultado inclui `[cwd: …]` quando ≠ raiz. Confinado e terminou fora da raiz → próxima chamada volta à raiz e o resultado avisa. `sandboxBash` + `bwrap`: `bwrap --ro-bind / / --dev /dev --proc /proc --tmpfs /tmp --bind <raiz> <raiz> --die-with-parent bash -lc …` | **sim** |
| web_search | `{ query }` — scrape `https://html.duckduckgo.com/html/?q=` → lista título/url/snippet | **sim** |
| browse_url | `{ url, offset? }` — BrowserWindow oculta (`show:false`, offscreen ok), carrega, espera load + ~1.5s, extrai `title`, `innerText` e links principais; destrói janela | **sim** |
| list_models | `{ query?, provider?: string, tools_only?: boolean, free_only?: boolean, limit? (padrão 50 por provedor, máx. 200), sort?: 'id' \| 'price' \| 'context' }` — modelos de **todos os provedores configurados** via `providers.listModels` (em paralelo; cache de 5 min por provider; sem acesso a arquivos). `provider` (nome sem caixa ou id) filtra um só; desconhecido → erro com os nomes disponíveis. Vários provedores: cabeçalho `[modelos de N provedores — OpenRouter (desta sessão): X de Y, mostrando K · Anthropic: … · Local: falhou]`, uma seção `[Provedor]` por provedor (o da sessão primeiro, `(atual)` só nele), `[… mais N em P]` quando cortado, o teto de caracteres dividido entre os provedores com resultados (sobra passa adiante); `/models` de um provedor falhando vira `[P] erro ao listar (GET /models): …` inline (todos falhando → erro). Um provedor só (ou `provider`): o formato simples abaixo. `query`: cada termo casa com id ou nome (sem caixa nem separadores: "gpt41" acha "gpt-4.1"). `sort`: id (padrão), price (entrada+saída, mais barato primeiro), context (maior janela primeiro); sem dado → fim. Saída: `[N modelos de M no provedor X; mostrando K]` + uma linha por modelo `openai/gpt-4.1-nano (atual) · ctx 1.047k · $0.10/$0.40 por 1M · tools` (grátis = id `:free` ou preço 0 → `· grátis`; `(atual)` = modelo da sessão) + dica de refinar com `query` se cortado (por `limit` ou `maxToolOutputChars`). Falha de `/models` → erro legível (toolStatus `error`). A descrição orienta: grátis só para tarefas fáceis e sem dados pessoais (o provedor pode registrar prompts), são instáveis (429, respostas vazias, sem tools) — se falharem, outro grátis ou um pago. Habilitada por padrão em chats novos (chats existentes mantêm o `enabledTools` salvo). | não |
| delegate_task | `{ task: string, model?: string, provider?: string, title?: string }` — cria subsessão (depth+1, `providerId` + `model` resolvidos por `resolveSubagentTarget` em `tools/models.ts` e fixados: trocar o modelo/provedor do chat depois não muda subsessões). Provedor: `provider` (nome sem caixa ou id; desconhecido → erro com os nomes disponíveis; `model` que o `/models` dele não lista → erro) ou, sem ele, o da sessão chamadora; sem `provider`, um `model` que não existe no provedor da sessão mas existe em exatamente um outro → esse outro, com `[nota: …]` no início do resultado; em vários → erro pedindo `provider`; em nenhum → o modelo da sessão (com nota); `/models` com falha → confia no pedido, roda o loop até a resposta final, retorna o texto final como resultado. Modelo padrão = modelo da sessão chamadora (a descrição sugere `list_models` para escolher outro). Só disponível se `session.depth < 2` (máx 2 níveis: principal → sub → sub-sub). Se a chamada ao modelo do subagente falhar, o resultado (toolStatus `error`) é `[falha do modelo X: <erro>] O subagente não concluiu a tarefa. Tente outro modelo …` (modelo `:free` → sugere outro grátis ou um pago); resposta final vazia → `(o subagente terminou sem retornar texto — possível falha do modelo X; tente outro modelo)`. | não |
| delegate_task `background` | `background?: boolean` (padrão false = bloqueante). Com `true`: cria a subsessão, inicia o loop **sem** o signal do pai e retorna na hora `Subagente iniciado em segundo plano (id …, modelo …). Você receberá o resultado automaticamente quando ele terminar.` (tool `meta.background`). Sem limite de concorrência (só o de profundidade). | não |
| get_chat_info | `{}` → `chat_id`, título, sessão atual (principal, ou subagente com nível/título + sessão-pai e sessão principal), modelo, provedor, diretório raiz, `criado em` (data local + fuso). | não |
| list_chats | `{ query?, limit? (padrão 30, máx. 100) }` → `[N chats; mostrando K]` + `id (este chat) · "Título" · modelo · ocioso/rodando/aguardando aprovação · atualizado há X`, mais recentes primeiro; `query` casa com título (sem caixa) ou prefixo do id; corta no teto de saída. | não |
| send_to_chat | `{ chat_id, message, wait_for_reply?: boolean (padrão false), timeout_s? (padrão 300, máx. 3600) }` — ver "Mensagens entre chats". | não |
| read_history | `{ query?, from_seq?, to_seq?, limit?, include_tool_results? }` — ver "Histórico (read_history)". | não |
| check_subagents | `{}` → `[N subagentes; M em execução]` + por subagente direto: `id · "título" · modelo · estado · em segundo plano/bloqueante · duração · resultado entregue/ainda não entregue/devolvido no delegate_task · último: "…"`. | não |
| wait_subagents | `{ ids?: string[], mode?: 'all' \| 'any' (padrão all), timeout_s? (padrão 600, máx. 3600) }` — sem ids: todos os pendentes da sessão. Bloqueia até terminarem (ou o primeiro, em `any`) e devolve os resultados (texto igual ao callback), **reivindicando-os** (o callback enfileirado é retirado; não chega de novo). Tempo esgotado → estados. Parar/⚡ cancela a espera (os subagentes continuam). | não |
| cancel_subagent | `{ id }` (descendente da sessão) → para o subagente e os descendentes; o callback informa o cancelamento. | não |
| message_subagent | `{ id, message, wait_for_reply?, timeout_s? (padrão 600) }` — só para descendentes da sessão (outros → erro claro). Persistida no filho como `role: user` `[Mensagem do agente pai]\n<texto>` (meta.kind `parent-message`, `fromSessionId`). Rodando → fila (próximo passo); ocioso/concluído → retoma e a nova resposta final volta como callback. Com `wait_for_reply`: devolve a próxima resposta final dele e reivindica o callback. | não |

As 4 tools de subagentes só são oferecidas quando `delegate_task` está disponível (habilitada e depth < 2); num **subagente** (depth 1), só depois que ele mesmo chamou `delegate_task` (`hasDelegated(history)` em `availableTools(chat, session, history)`) — modelos fracos não as usam para "responder" a quem delegou; o prefixo de cache muda uma vez, no primeiro delegate. A principal as vê sempre (para planejar). A execução de tool é permissiva (sem histórico). Todas as novas tools vêm habilitadas em chats novos e não pedem confirmação.

Confirmação: tool em `CONFIRM_TOOLS` e não em `autoApprove` → cria `ApprovalRequest`, emite `approval-requested`, sessão `awaiting_approval`, aguarda `agent.approve`. `deny` → resultado de tool `"O usuário negou a execução desta ferramenta."` (toolStatus `denied`). Subsessões também pedem confirmação (a UI mostra a solicitação mesmo se o usuário estiver em outra sessão).

## Contexto e compactação (`src/shared/context.ts`, `src/main/agent/compaction.ts`, runner)

- **Janela** (`resolveContextWindow`): principal = `contextWindow` (override) → `ModelInfo.contextLength` (`/models`, `context_length`); subsessão = janela do próprio modelo → override.
- **Uso** (`contextUsage`): `promptTokens + completionTokens` da última resposta do assistente após a fronteira mais recente; sem resposta desde a compactação → `meta.contextEstimate` da fronteira (estimativa).
- **Limite**: `compactThreshold` (0.9). ≥ limite → banner "Contexto em 92% — Compactar conversa". `autoCompact` (principal) / sempre (subsessões): compacta sozinho no limite de passo; também ao receber erro de contexto excedido (`isContextLengthError`: "maximum context length", "context_length_exceeded", "prompt is too long", …; ignora rate-limit/TPM), uma vez por chamada bem-sucedida.
- **Compactação** (`agent.compact` ou automática): roda no limite de passo (ociosa: loop só de compactação, status `running`; rodando: agendada, evento `compaction{state:'scheduled'}`; agendada no último passo → roda e encerra o turno, salvo fila/⚡). `repairTail` antes (nunca no meio de um par tool_calls ↔ tool). Request = **a request normal** (mesmas tools, system, params, histórico ativo e breakpoints → prefixo do cache) + último `{role:'user', content: compactPrompt}`; stream visível (`compaction{state:'running', text}`). Se a request estourar o contexto: tenta `trimmed` (resultados de tool/mensagens longas encurtados) e depois `tail` (só as mais recentes que cabem); resposta vazia → repete com `tool_choice:'none'`. Nem a request nem a resposta são persistidas: só a **fronteira** `role: user`, content = `compactionMessageText(resumo, faixa?)` = `<conversation_summary>\n…\n</conversation_summary>\n\n` + nota — decidida **na hora da compactação** (o texto é persistido): com `read_history` disponível para a sessão, `compactionNoteWithHistory(X, Y)` = "O histórico anterior desta conversa (mensagens #X–#Y) foi compactado … As mensagens originais continuam salvas: … consulte-as com a ferramenta read_history …" (X = primeira mensagem salva, Y = última resumida); sem ela, `COMPACTION_NOTE` ("… as mensagens originais não estão mais disponíveis …"), meta `{ kind:'compaction', synthetic:true, summaryOf, compactedCount, usageBefore, contextEstimate, compactUsage, model, durationMs }`. `buildRequest` envia só da fronteira mais recente em diante (system continua primeiro; tool órfão logo após a fronteira é descartado por `sanitizeHistory`). Parar/⚡ durante a compactação cancela sem salvar nada. Apagar a fronteira desfaz a compactação. `{retry:true}` ("Compactar e tentar de novo") roda o agente depois.

## Mensagens entre chats (`send_to_chat`, `src/shared/interChat.ts`, runner)

- Entrega no **chat de destino** (sessão principal) exatamente como se o usuário digitasse: ociosa → inicia um turno; rodando → fila (`QueuedMessage.meta`), injetada no próximo limite de passo. As aprovações do destino continuam valendo lá.
- Conteúdo persistido = `interChatHeader(título, id, { waitForReply, canReply })` + `\n` + mensagem: `[Mensagem do chat "Título" (id …)]`, com o sufixo `— o remetente aguarda: sua resposta final neste turno será devolvida a ele automaticamente` (wait) ou `— se precisar responder, use send_to_chat com chat_id "…"` (se o destino tiver a tool). Meta `{ kind:'inter-chat', fromChatId, fromSessionId, fromChatTitle, interChatHops }`. O título automático do destino usa só o corpo.
- `wait_for_reply`: aguarda o fim do turno do destino que processa a mensagem e devolve `Resposta do chat "T" (id …):\n\n<texto final>`; tempo esgotado → `[O chat "T" … ainda está rodando após Ns; a resposta ficará no chat …]`; erro do destino → erro; turno interrompido / mensagem presa na fila → aviso. Sem wait: "entregue … iniciou um turno" / "enfileirada …". Parar/⚡ do remetente cancela só a espera (a mensagem já entregue fica).
- **Segurança**: recusa o próprio chat; **saltos** — `currentInterChatHops(histórico da principal do remetente)` = saltos da última mensagem do usuário (não sintética) se ela for inter-chat, senão 0; a nova mensagem leva +1 e acima de 3 (`LIMITS.interChatMaxHops`) é recusada; **ciclo de espera** — grafo em memória de esperas (chat que espera → chat aguardado); `wouldCreateWaitCycle` recusa A aguardar B se já houver caminho B → … → A (em vez de travar). `chat_id` aceita prefixo único (≥ 4).
- UI: no destino, bolha distinta "De: <título>" (link abre o chat de origem; "(chat apagado)" se não existir; saltos > 1 indicados) com (i) mostrando o objeto exato (com o cabeçalho). No remetente, o card mostra o chat de destino, "Abrir chat" e a resposta (quando aguardada). A sidebar reflete o destino ocupado via `session-updated` (aplicado para qualquer chat, aberto ou não) e `chat-updated` (ordem/“atualizado”).

## Histórico (`read_history`, `src/main/tools/history.ts`)

Lê as mensagens **persistidas** da sessão chamadora (subagentes leem a própria), inclusive as anteriores às fronteiras de compactação; exclui erros só de exibição. Cabeçalho: `[histórico desta sessão: N mensagens (#a–#b); fronteiras de compactação: #12 (resume #1–#11) — as mensagens antes de #12 não estão mais no seu contexto]`.
- **Faixa** (sem `query`): `#seq papel: conteúdo` (`user`, `user (app)`, `user [de outro chat]`, `user [fronteira de compactação · resume #x–#y]`, `assistant` + `→ chamou tool(args…)`, `tool (nome[, status])`); resultados de tool só com `include_tool_results` (senão `[resultado omitido · N caracteres …]`); cada mensagem ≤ 2.000 chars (início 70% + fim 30% com `[… N caracteres omitidos — leia inteira com from_seq=S to_seq=S]`), exceto ao ler uma só (inteira, até o teto). Padrão 40 mensagens (máx. 200): sem from/to = início do histórico; só `to_seq` = as últimas até ele. Respeita `maxToolOutputChars`; rodapé `[mostrando #a–#b … continue com from_seq=…]`.
- **Busca** (`query`): sem caixa, em texto, argumentos e resultados de tools (ignora as chamadas/resultados do próprio read_history); sem a frase exata, mensagens com todos os termos. Padrão 20 resultados (máx. 100), até 2 trechos de ~220 chars por mensagem: `#seq papel: …trecho…`. `from_seq`/`to_seq` filtram.

## Subagentes em segundo plano, callbacks e conversa direta (`src/main/agent/subagents.ts`, runner)

- **Report**: cada execução de subsessão cujo resultado volta ao pai por callback (delegate em segundo plano, ou subsessão **retomada** por mensagem nova — usuário, `message_subagent` ou callback de um filho) é registrada (`ReportRegistry`). Ao terminar (concluiu / falhou / cancelada), salvo se reivindicada (`wait_subagents`/`message_subagent` com wait) ou apagada, o pai recebe uma mensagem `role: user` **sintética** (meta `{ kind:'subagent-callback', synthetic, subSessionId, callbackUpdate? }`): `[Subagente "<título>" (id …) concluiu]` / `— atualização após nova mensagem]` / `falhou]` (+ `delegateFailureText`) / `foi cancelado]` (+ parcial) / `não concluiu]\n(interrompido: o app foi fechado)`, seguida do texto final (cortado no teto). Entrega com a semântica da fila: pai rodando → próximo limite de passo (na ordem de término); pai ocioso → **acorda** (novo turno).
- **Subagente com filhos pendentes**: ao encerrar um turno com filhos em segundo plano ainda rodando, **dorme** (status `waiting`, "aguardando subagentes") até chegar mensagem/callback na fila; só quando encerra um turno sem pendentes o resultado sobe (resultado do delegate bloqueante ou callback). Profundidade máxima continua 2.
- **Fila em todas as profundidades**: subsessões recebem mensagens (usuário, pai, callbacks); `agent.send` aceita subsessões (rodando/dormindo → fila; ⚡ interrompe só aquele subagente; ociosa/concluída → retoma; se o pai ainda espera um delegate bloqueante, a mensagem só faz parte da execução e a resposta final é o resultado da tool).
- **Parar**: Parar/⚡ na principal não derrubam subagentes em segundo plano (o loop deles não herda o signal); delegates bloqueantes continuam em cascata. Parar num subagente (banner) ou `cancel_subagent` para a subárvore toda (callbacks dos descendentes só registrados nos pais, sem acordá-los; o da raiz segue normal). "Parar todos os subagentes" (`agent.stopSubagents`). Apagar chat/mensagem do delegate: sem callbacks. Fechar o app: subagentes que reportariam por callback e ainda rodam deixam no pai "(interrompido: o app foi fechado)" sem acordá-lo (também na inicialização, após fechamento abrupto: sessões `running`/`waiting` → `interrupted`).
- UI: card do delegate com selo "em segundo plano" + status ao vivo + "Abrir subsessão"; callbacks como card compacto ("Subagente X concluiu", resultado recolhível, (i) com o texto exato, "Abrir subsessão"); subsessão com composer e banner "Conversando com o subagente <título> · as respostas dele voltam ao agente <pai>" (+ Parar); mensagens no subagente: "Você" vs "Agente pai", cada uma com (i); seletor de sessão em árvore agrupada sob o pai, rolável, recolhível, com contagem por status e "Parar todos os subagentes"; sidebar mostra o chat ocupado enquanto qualquer subagente roda.

## Runner / fila / interrupção (`src/main/agent/`)

Loop por sessão: `build → stream → persistir assistant → executar tool_calls sequencialmente → persistir tool msgs → [drenar fila] → repetir` até o assistente responder sem tool calls.

- **Fila**: `agent.send` com sessão rodando → `QueuedMessage` (memória, por sessão; `meta` opcional para mensagens de outro chat/pai/callbacks), evento `queue-updated`. Vale para qualquer profundidade. No próximo limite de passo (depois que os resultados das tools foram persistidos e antes da próxima chamada, OU quando o assistente termina o turno) todas as mensagens da fila são anexadas como mensagens `user` (meta.kind `queued`) e o loop continua imediatamente.
- **⚡ forceSend**: aborta o stream HTTP (AbortController) e as tools em andamento (kill bash, nega approvals pendentes, aborta subsessões em cascata). Persiste o assistant parcial (se tem conteúdo; `meta.interrupted=true`; tool_calls incompletas descartadas). Para cada tool_call sem resultado, adiciona msg `tool` sintética `"[Interrompido pelo usuário antes de concluir]"` (toolStatus `cancelled`) — mantém o pareamento tool_call/tool válido. Então anexa a mensagem do usuário (meta.kind `forced`) e continua o loop.
- **stop**: igual ao abort acima, sem injetar; sessão `idle`; a fila permanece (cada item mostra ⚡ = enviar agora).
- Erros: status `error`, evento `error`; o usuário pode mandar nova mensagem ou `regenerate`.
- Título do chat: primeira mensagem do usuário truncada (~50 chars). Sem chamadas extras ao modelo.

## UI (renderer)

Estética: escura, elegante, minimalista (referência: Linear / Claude desktop / Raycast). Janela com `titleBarStyle: 'hidden'` + `titleBarOverlay` (cores do tema) e área de drag. Fonte Inter (`@fontsource-variable/inter`), mono JetBrains Mono. Animações sutis. Ícones lucide-react.

- **Onboarding** (sem providers): tela cheia — nome (padrão "OpenRouter"), base URL (padrão `https://openrouter.ai/api/v1`), API key, botão Testar conexão, Continuar.
- **Seletor de modelo** (`components/ui/ModelPicker.tsx`, lógica pura em `lib/modelPicker.ts`): **não existe provedor padrão nem seletor de provedor** — o valor é o par `{ providerId, model }` e o mesmo id em dois provedores (ex.: um Claude via OpenRouter e via Anthropic) são duas opções. Uma lista só com os modelos de **todos** os provedores (`listModels` em paralelo, cache do store), um grupo por provedor: cabeçalho com nome, contagem e chevron para recolher/expandir (lembrado em `localStorage` `clearchat.modelPicker.collapsed`, com try/catch; o grupo da seleção atual abre sozinho), spinner por provedor e erro com "tentar de novo" (um provedor falhando não afeta os outros). A busca filtra todos os grupos ao mesmo tempo (termos em qualquer ordem, sem separadores, também pelo nome do provedor; ignora o recolhimento; grupos sem resultado somem; "N de M" no cabeçalho). Linha: nome, id (mono), ícones tools/visão, contexto e preço entrada/saída por 1M, ✓ na seleção. ID livre: com texto digitado, "Usar "<texto>" em <provedor>" para cada provedor que não tem esse id exato (o da seleção primeiro). Teclado: ↑/↓ (pulam cabeçalhos), Enter, Esc. Virtualizado (alturas fixas por tipo de linha; ~460 modelos do OpenRouter rendem ~20 linhas no DOM) com cabeçalho do grupo grudado no topo ao rolar. Gatilho: "<Provedor> · <nome do modelo> <id>" (provedor esmaecido; "provedor removido" se apagado). Usado no Novo chat, na aba Modelo, no editor de personas e em "Novos chats". Escolher grava `providerId` e `model` juntos (`chats.update` com os dois; a principal usa o provedor novo já na próxima request; subsessões ficam no delas).
- **Sidebar esquerda**: "Novo chat", lista de chats (renomear/apagar no hover), engrenagem → Configurações.
- **Novo chat**: tela central — **Persona** (seletor compacto: ícone + nome + modelo; padrão = `defaultPresetId` → "Padrão" → a primeira; "Gerenciar personas…" abre as Configurações), **Modelo** (o seletor único acima; contexto/preço/tools do modelo abaixo; sem par padrão definido, "Escolha um modelo…"), system prompt (textarea, (i)), **Diretório raiz** (seletor de pasta + "Nova pasta…" que cria uma pasta dentro da selecionada e a usa como raiz, (i)), assinatura do app, botão "Começar". Escolher uma persona preenche os campos (a pasta só muda se a persona definir uma); os campos que a tela não mostra (params, tools, aprovação, contexto…) vêm da persona. Ao alterar qualquer campo o seletor vira "Personalizado · a partir de <persona>" com "Desfazer alterações" e aparece **"Salvar como persona"** (nome, ícone — lucide ou emoji —, descrição, "Incluir diretório raiz", e "Atualizar “<persona>”" em vez de criar outra; a persona salva = config da origem + campos da tela). O chat criado guarda `presetId`.
- **Chat**: header com título, pílula do modelo "<Provedor> · <modelo>" (provedor esmaecido; tooltip com o endpoint para onde vai o `model`; clicável → aba Modelo; na subsessão mostra o par dela), **seletor de sessão** (principal + subagentes em árvore com indicador de status; subsessão: composer próprio (conversa direta com o subagente), sem edição do histórico, banner "Conversando com o subagente … · as respostas dele voltam ao agente … · <Provedor> · <modelo>" + Parar + voltar à principal; o painel de config mostra uma nota de que a config é do chat (compartilhada); o seletor mostra o par de cada sessão). Mensagens: usuário, assistente em markdown (react-markdown + remark-gfm + highlight), raciocínio em três estados — fechado (só o cabeçalho "Raciocínio"/"Pensando…"), caixa compacta com rolagem própria (abre sozinha enquanto o modelo pensa) e "Expandir tudo" (botão no cabeçalho: texto inteiro na altura natural, sem rolagem interna; "Voltar para a caixa" desfaz); o estado fica guardado por mensagem enquanto o app está aberto — cards de tool call (nome, args, status, resultado colapsável com (i) "enviado ao modelo como `role: tool`"), card de delegate com "Abrir subsessão", aprovação inline (Permitir / Negar / Sempre neste chat), rodapé de uso (in/out/cached/custo). Mensagens sintéticas mostram (i) com o texto exato enviado. Hover: editar / apagar mensagem; regenerar última resposta.
- **Contexto**: medidor compacto no rodapé do composer (e no banner de subsessão) — anel + "38k / 200k · 19%", cor muda em 70% / limite; tooltip com entrada/resposta/cache/janela; janela desconhecida → "N tokens · definir janela"; clique → seção Contexto da Config. Banner acima do composer no limite com "Compactar conversa" (dispensável). Mensagens antes da fronteira ficam visíveis porém esmaecidas, com divisor "Conversa compactada · N mensagens resumidas · não são mais enviadas à API" (Ocultar/Mostrar); a fronteira é um card "Resumo da conversa" (markdown recolhível, (i) "Enviado como mensagem role:user no início do histórico", N mensagens, tokens antes → depois, custo). Compactação em andamento: card com o resumo ao vivo. Erro de contexto excedido → botão "Compactar e tentar de novo".
- **Composer**: textarea auto-grow, Enter envia / Shift+Enter quebra linha, botão Parar quando rodando. Mensagens **enfileiradas** aparecem acima do composer como chips com botão ⚡ (forçar) no canto e X (remover).
- **Painel direito** (colapsável), abas:
  Cabeçalho: abas **Modelo · Chat · Tools · Arquivos** (ícone + rótulo; `role="tab"`), botão **"Ver request"** ({ }, de qualquer aba → modal com o JSON exato da próxima request, `previewRequest`) e fechar. A última aba fica em `localStorage` (`clearchat.panelTab`, com try/catch). Em subsessão, as abas de config mostram a nota "Configuração do chat (compartilhada) · esta subsessão usa o modelo X e o system prompt de subagentes". Tudo editável a qualquer momento; salva automaticamente. Os editores (`panel/editors.tsx`) recebem `{cfg, patch}` e são os mesmos no editor de personas.
  - **Modelo**: o seletor único de modelo (par provedor + modelo; (i) explica que o id vai como `model` para o endpoint daquele provedor) (+ contexto/preço/tools), system prompt (i), parâmetros (cada um com toggle "enviar" — só os ativados vão; (i)), reasoning_effort, **Request**: "Token caching (cache_control)" (i; depende do modelo/provedor) e body extra JSON (i).
  - **Chat**: título, persona de origem + **"Salvar como persona"** (snapshot da config do chat; opção de incluir a raiz ou atualizar a persona de origem), **Diretório raiz** (caminho, "Alterar…", "Confinar ferramentas à raiz" (i), "Bash em sandbox" (i) — só se bwrap existir —, "Bloco de ambiente" no system prompt (i, mostra o texto)), **Assinatura do app** (i), **Contexto** (uso/janela, "Definir janela manualmente", "Sugerir compactação em N%", "Compactar automaticamente", prompt de compactação editável com reset e (i), "Compactar agora"; o medidor do composer abre esta aba).
  - **Tools**: tools habilitadas (cada uma com (i) mostrando a definição JSON enviada), "Enviar tools nativas (campo tools)" (i), "Texto das tools no system prompt" (i) + textarea editável com reset, aprovação automática (tudo + por tool), system prompt de subagentes (i), **Limites** ("Saída máx. por ferramenta" (i)).
  - **Arquivos**: navegador da raiz — com `confineToRoot` o breadcrumb começa na raiz e nunca sobe acima dela; recarregar (e recarrega sozinho a cada resultado de tool do chat); "Usar como raiz", "Escolher pasta…", "Nova pasta…" (cria na pasta atual e entra nela); clicar arquivo → preview (somente leitura).
- **Configurações** (modal), abas: **Provedores** (CRUD: nome, base URL, API key mascarada, headers extras JSON, testar — nenhum é "padrão"); **Personas** (lista com ícone, nome, "<Provedor> · <modelo>" e descrição/resumo; Editar — nome/ícone/descrição + sub-abas Modelo · Chat · Tools com os mesmos editores do painel, incluindo "Definir diretório raiz"; na aba Modelo, nota "Definido nesta persona" / "Segue o modelo padrão" + "Usar o padrão" (remove o par da persona); Duplicar; estrela = definir como padrão; Apagar com confirmação; "Nova persona"); **Novos chats** (persona padrão, **Modelo padrão** — um seletor só que grava `defaultProviderId` + `defaultModel` juntos; provedor apagado → "Não definido" —, system prompt e pasta padrão — usados nos campos que a persona não define).
- Componente `<ApiInfo>`: ícone (i) com tooltip (Radix Tooltip ou próprio) — usar em TODO lugar que vira parte do prompt/request.

## Notas do scaffold (fase 1)

- **Versões**: Electron 44.7.2, electron-vite 6.0.0 (Vite 8 / rolldown), React 19.3, Tailwind 4.3, better-sqlite3 13.0.3, TypeScript 5.9.
- **better-sqlite3 v13** é N-API com binários pré-compilados: funciona no Electron sem rebuild. `external` no build do main; `asarUnpack` no pacote.
- **Preload com `sandbox: true`** (não foi preciso `false`): o preload só faz `require('electron')`; `@shared` é empacotado nele.
- **`src/shared/ipc.ts`**: `IPC.<domínio>.<método>` = `'domínio:método'` (ex.: `IPC.chats.create === 'chats:create'`), `EVENT_CHANNEL = 'agent:event'`, `ALL_CHANNELS` (lista de todos os canais invoke) e a interface `ClearApi` com tipos concretos (`ProviderInput`, `ProviderTestInput/Result`, `ChatCreateInput`, `ChatUpdateInput`, `ApprovalDecision`, `RequestPreview`, `FileContent`). Handlers recebem os argumentos posicionais na mesma ordem da API: `ipcMain.handle(IPC.chats.update, (_e, id, patch) => …)`.
- **`src/shared/tools.ts`** (adição ao contrato): `ToolDefinition` (formato OpenAI `{type:'function', function:{name, description, parameters}}`), `TOOL_DEFINITIONS: Record<ToolName, ToolDefinition>` (schemas da tabela de Tools — usados pelo main na request e pelo (i) do renderer), `TOOL_NAMES`, `TOOL_LABELS` (pt-BR).
- **`src/shared/defaults.ts`**: `DEFAULT_BASE_URL`, `DEFAULT_PROVIDER_NAME`, `DEFAULT_SYSTEM_PROMPT`, `DEFAULT_SUBAGENT_SYSTEM_PROMPT`, `isOpenRouter(baseUrl)`, `DEFAULT_CHAT_CONFIG(cwd, { providerId?, model?, systemPrompt?, baseUrl? })` (todas as tools habilitadas, `nativeTools` true, `toolsInPrompt` false, `envInPrompt` true, `cacheEnabled` = baseUrl é OpenRouter) e `defaultToolsPrompt(tools: ToolDefinition[], nativeTools: boolean)` já implementado (modo sem tools nativas usa `<tool_call>…</tool_call>` / `<tool_result name="…">…</tool_result>`). O chamador passa só as tools disponíveis para a sessão (ex.: sem `delegate_task` em depth 2). Com `list_models` e `delegate_task`, as diretrizes sugerem consultar `list_models` antes de delegar (grátis: só tarefas fáceis sem dados pessoais; instáveis).
- **`src/main/db.ts`**: `getDb()` (abre uma vez; WAL + `foreign_keys=ON`; cria o schema), `getDbPath()`, `closeDb()`. FKs com `ON DELETE CASCADE`: chats → sessions (e sessão-pai → subsessões) → messages; índice único `(session_id, seq)`.
- **`src/main/ipc.ts`**: stub `registerIpc()` chamado em `app.whenReady()` após `getDb()`.
- **Renderer**: tokens do tema em `src/renderer/src/styles.css` (`@theme`): cores `bg`, `surface`, `elevated`, `border`, `fg`, `muted`, `subtle`, `accent`; `font-sans` (Inter), `font-mono` (JetBrains Mono); `h-titlebar` (40px = altura do `titleBarOverlay`); utilitários `drag` / `no-drag`. Tema de código: `highlight.js/styles/github-dark.css`.
- Ambiente: se `ELECTRON_RUN_AS_NODE` estiver definido (processos filhos do VS Code), o app não abre — `unset ELECTRON_RUN_AS_NODE`.

## Ícone e empacotamento

- **Ícone**: `build/icon.svg` é o mestre (marca do `Logo.tsx` — balão de chat — num squircle com o gradiente do acento, margem de ~10% e sombra). `npm run icons` (`scripts/icons/render.sh`: `make-svg.py` + `rsvg-convert` + ImageMagick + `make-icns.py`) gera `build/icons/<N>x<N>.png` (16–1024; 16–32 px usam uma variante com margem de 1 px e traço mais grosso), `build/icon.png` (1024), `build/icon.ico`, `build/icon.icns`, `resources/icon.png` (ícone da janela) e `src/renderer/public/favicon.svg`. O `<Logo>` do renderer desenha a mesma arte em SVG.
- **Identidade**: `productName` ClearChat, `appId` `com.clearchat.app`, executável `clearchat`, `desktopName` `clearchat.desktop` (Electron usa como app_id no Wayland; WM_CLASS no X11) = `StartupWMClass=clearchat` + `linux.syncDesktopName`, para o dock agrupar as janelas. `app.setName('ClearChat')` no main → userData `~/.config/ClearChat`.
- **electron-builder** (`electron-builder.yml`): Linux AppImage + deb + pacman + tar.gz, `artifactName: ClearChat-${version}-${arch}.${ext}`, `compression: maximum`, `electronLanguages: [pt-BR, en-US]`, só `out/`, `resources/` e deps de produção no asar (sem `src/`, `e2e/`, `scripts/`, docs, sourcemaps, `node-addon-api`, prebuilds de outras plataformas); `better-sqlite3` em `asarUnpack`. `pacman.depends` explícito (a lista padrão cita pacotes que não existem mais no Arch). Seções win (nsis, `icon.ico`) e mac (dmg, `icon.icns`) configuradas, mas só o Linux é buildado aqui.
- **Scripts**: `dist` (todos os alvos Linux), `dist:appimage`, `dist:dir`, `install:local` (`scripts/install-local.sh`: AppImage em `~/.local/bin`, `.desktop` em `~/.local/share/applications`, ícones em `~/.local/share/icons/hicolor`; `-- --uninstall` remove).


## Markdown (renderer)

`components/chat/Markdown.tsx`: react-markdown + remark-gfm + **remark-math** → **rehype-katex** → rehype-highlight (KaTeX antes do highlight). O texto passa antes por dois pré-processamentos puros (testados em `e2e/markdown.test.ts`, parte do `npm run test:unit`):

- **Cercas aninhadas** (`lib/fences.ts`, `normalizeFences`): um bloco cercado que contém outros com a mesma cerca (README em ` ```markdown ` com ` ```python ` dentro) tem a cerca **externa** (abertura + fechamento) reescrita com mais crases/tis que a maior interna, então o remark vê um bloco só; o rótulo é a linguagem externa e "Copiar" copia o conteúdo com as cercas internas intactas. Dentro de um bloco (caractere C, comprimento L) só cercas de C com ≥ L são estruturais: com info string abrem nível, nuas fecham o nível mais interno; uma nua na profundidade 0 é candidata a fechar o externo. Entre as leituras possíveis (fechar na 1ª, 2ª… candidata ou não fechar — streaming) vence a de menor penalidade: cerca nua que abre seguida de linha em branco, que fecha seguida de texto colado, bloco vazio (abre+fecha coladas), abre colada após um fechamento, e mensagem terminando com cerca aberta (1,5). O resto da mensagem é avaliado junto (programação dinâmica sobre as linhas-cerca). Empate → a mais cedo (CommonMark); se a externa é `markdown`/`md`/`mdx`, a mais tarde. Cercas de 4+ que já englobam as internas, `~~~`, listas indentadas e CRLF são respeitados; citações (`> ```) não são tratadas.
- **Delimitadores de LaTeX** (`lib/math.ts`, `normalizeMath`), fora de blocos de código, código inline, blocos `$$` e escapes: `\[…\]` → `$$…$$` (em linhas próprias vira bloco de display com a indentação preservada; no meio da frase, inline) e `\(…\)` → `$…$`. `$…$` com um cifrão continua ligado (muitos modelos usam), mas só vale o par na regra do Pandoc — abertura com não-espaço à direita, fechamento com não-espaço à esquerda e sem dígito logo depois, na mesma linha; qualquer outro `$` vira `\$` (texto): "custa $5 e $10", "R$ 50" ficam texto. Streaming: `\[` sem fechamento no fim vira `$$` (a fórmula aparece aos poucos), `$$` aberto já vai até o fim, `$` sem par fica texto.
- KaTeX: `throwOnError:false` (via rehype-katex) com `errorColor` vermelho suave — TeX inválido mostra o fonte cru, nunca derruba a mensagem; durante o streaming o erro fica cinza (a fórmula final quase sempre está incompleta). Display rola na horizontal se for larga; cor herdada do texto. CSS em `components/chat/markdown-math.css` + `katex/dist/katex.min.css`; as fontes do KaTeX são empacotadas pelo Vite em `out/renderer/assets` (carregadas via `font-src 'self'`, sem rede). **`katex` fica em `^0.16`, a mesma versão que o rehype-katex usa** — a 0.19 renomeou classes (`sizing` → `katex-sizing`) e o CSS deixaria de casar com o HTML gerado (subscritos em tamanho cheio).

## Anexos (`src/shared/attachments.ts`, `src/main/attachments.ts`)

Enviar arquivos aos modelos que os aceitam — imagens, PDF, áudio e arquivos de texto/código.

- **Entrada (composer)**: botão 📎 "Anexar arquivos" (diálogo nativo via `attachments.pick`; o main lê os caminhos), **arrastar** arquivos para qualquer ponto do chat (overlay "Solte para anexar") e **colar** imagens (`attachments.add` com os bytes; imagem colada vira `colado-HHMMSS.png`). Cada arquivo vai na hora para o store e vira um chip acima do textarea (miniatura para imagens, ícone + nome + tamanho para os demais, X remove, (i) explica o envio). Pode enviar só anexos (texto vazio).
- **Limites** (`ATTACHMENT_LIMITS` em `src/shared/limits.ts`): 20 MB por arquivo, 10 anexos e 50 MB por mensagem, 200.000 caracteres por arquivo de texto (o resto é cortado com `[… arquivo cortado: mostrando N de M caracteres]`). Erros legíveis em pt-BR (tamanho, tipo não suportado, arquivo vazio).
- **Tipos** (`classifyAttachment`, por extensão/mime): imagem `png/jpg/webp/gif`; PDF; áudio `wav/mp3`; texto = extensões/mimes de texto e código, ou qualquer arquivo desconhecido que seja UTF-8 válido sem NUL. Outros binários (zip, docx, vídeo, bmp…) → "Tipo não suportado".
- **Capacidades**: `ModelInfo.inputModalities` vem de `architecture.input_modalities` do `/models`. Imagem exige `image`, PDF `file`, áudio `audio`; texto funciona com qualquer modelo. Sem a modalidade → aviso inline "Este modelo não aceita imagens" (modalidades desconhecidas, ex.: provider não-OpenRouter → "Não sei se este modelo aceita…", assume só texto); Enter não envia — só o botão **"Enviar mesmo assim"** (confirmação explícita). PDF no OpenRouter num modelo sem `file`: sem aviso — o OpenRouter extrai o texto do PDF (plugin file-parser) para qualquer modelo; o (i) do chip explica.
- **Codificação** (OpenAI-compatible / OpenRouter), um part por anexo, **anexos antes do texto** (`content: [...anexos, { type: 'text', text }]`; Anthropic recomenda imagens antes do texto, e o breakpoint de cache no último text part cobre a mensagem inteira):
  - imagem → `{ type: 'image_url', image_url: { url: 'data:<mime>;base64,…' } }`
  - PDF → `{ type: 'file', file: { filename, file_data: 'data:application/pdf;base64,…' } }`
  - áudio → `{ type: 'input_audio', input_audio: { data: '<base64>', format: 'wav' | 'mp3' } }`
  - texto → `{ type: 'text', text: '<file name="…">\n…\n</file>' }` (nome com `& " < >` escapados)
- **Persistência / caching**: o `message_json` nunca guarda base64. Os bytes ficam em `userData/attachments/<sha256>.<ext>` (content-addressed: mesmo arquivo = mesmo nome, dedup; escrita atômica tmp + rename). O part persistido é o formato do fio com uma referência no lugar do base64 — `{ type: 'image_url', image_url: { url: 'clearchat-attachment://<sha256>.png' }, _attachment: { name, mime, size, kind, file } }` (idem `file.file_data` / `input_audio.data`); arquivos de texto ficam inline (já no formato enviado) com `_attachment`. O tipo de part é decidido no envio e fica gravado no histórico. `buildRequest` chama `expandAttachments` **na cópia** (depois de `sanitizeHistory`, antes dos breakpoints): referência → data URL/base64 dos bytes do arquivo, e todo `_attachment` é removido — mesmos arquivos ⇒ mesmos bytes em toda request (o cache de prefixo funciona; leitura com cache LRU em memória). Mensagens sem anexos continuam string, idênticas.
- **cache_control**: continua no último text part da mensagem marcada; mensagem só com anexos (sem texto) recebe o breakpoint no último part (imagem/arquivo/áudio) — aceito via OpenRouter por Anthropic, OpenAI e Gemini (verificado).
- **Arquivo ausente** no disco → `buildRequest` lança `Anexo não encontrado no disco: "nome" (caminho). Apague a mensagem que contém esse anexo para continuar a conversa.` — vira o erro persistido do turno / erro no "Ver request", nunca crash. Na UI a miniatura mostra "arquivo ausente".
- **Preview** (`previewRequest`): mostra a estrutura expandida com o base64 encurtado (`data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA…(812 KB)`, `truncateBodyForPreview`) e `notes` ("Base64 de N anexos encurtado nesta visualização…") exibidas acima do Body.
- **Renderer**: miniaturas servidas pelo protocolo `clearchat-attachment://` (registrado como privilegiado no main; só lê nomes `^[0-9a-f]{64}(\.[a-z0-9]+)?$` do store; o CSP inclui o esquema em `img-src`/`media-src`). Mensagem do usuário: anexos acima do balão — imagens clicáveis (lightbox, Esc fecha), chips de arquivo com nome/tamanho, arquivos de texto com "Ver conteúdo" (prévia expansível) — cada um com (i) exato (part, tamanho → base64, "enviado em base64 em toda request enquanto estiver no histórico — conta tokens e é cacheável"). A fila mostra 📎 com os nomes.
- **Fila / ⚡ / edição**: `QueuedMessage.attachments` — a mensagem enfileirada leva os anexos e entra com eles no próximo passo (`kind: 'queued'`) ou no ⚡ (`kind: 'forced'`). `messages.update` (editar) preserva os parts de anexo: `withText` troca só o texto digitado.
- **Histórico em texto**: `contentText` ignora parts de anexo (copiar, editar, título — sem texto, o título vira o nome dos anexos). Compactação: o modo `full` reenvia os anexos (prefixo em cache); `trimmed`/`tail` trocam imagem/PDF/áudio por `[imagem: nome]` / `[PDF: nome]` / `[áudio: nome]` e encurtam arquivos de texto; o prompt de compactação pede para citar anexos assim e descrever o conteúdo relevante.
- **GC** (no início, antes da janela): apaga do store os arquivos que nenhuma `message_json` referencia (`LIKE '%clearchat-attachment://%'` + regex). Só nomes no formato do store (e temporários `.tmp-<uuid>`), só arquivos regulares e mais velhos que 1 h (anexos recém-escolhidos e ainda não enviados ficam; o dedup renova o mtime). Apagar chat/mensagem deixa órfãos até o próximo início.
