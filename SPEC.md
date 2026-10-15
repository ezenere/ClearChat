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
settings(key TEXT PK, value TEXT)                 -- JSON values. keys: defaultProviderId, defaultModel, defaultSystemPrompt, defaultCwd
chats(id TEXT PK, title TEXT, config_json TEXT, main_session_id TEXT, created_at INTEGER, updated_at INTEGER)
sessions(id TEXT PK, chat_id TEXT, parent_session_id TEXT NULL, parent_tool_call_id TEXT NULL, depth INTEGER,
         model TEXT, title TEXT, task TEXT NULL, status TEXT, created_at INTEGER)
messages(id TEXT PK, session_id TEXT, seq INTEGER, message_json TEXT, meta_json TEXT, created_at INTEGER)
```
IDs: `crypto.randomUUID()`. Timestamps: `Date.now()`. Deletar chat apaga sessions/messages (cascade manual ou FK ON DELETE CASCADE).

**Migração do nome antigo** (`src/main/migrate.ts`, `migrateLegacyData(userData)`): o app se chamava "CleartChat" (typo). No `ready`, antes de abrir o banco e só no userData padrão (não com `CLEARCHAT_USER_DATA`): se `<userData>/clearchat.db` não existe e `<irmão>/CleartChat/cleartchat.db` existe, copia com `VACUUM INTO` numa conexão somente leitura (cópia consistente, já com o WAL) para um temporário e renomeia; fallback: cópia crua de `.db` + `-wal`/`-shm` validada ao abrir. O diretório antigo fica intacto. Testado em `e2e/unit.test.ts`.

## Tipos compartilhados (`src/shared/types.ts`)

```ts
export interface Provider { id: string; name: string; baseUrl: string; apiKey: string; headers: Record<string,string>; createdAt: number }
export interface ModelInfo { id: string; name?: string; contextLength?: number; promptPrice?: number; completionPrice?: number; supportsTools?: boolean }

export interface ChatParams {           // só campos definidos (≠ undefined/null) vão para a request
  temperature?: number; top_p?: number; top_k?: number; max_tokens?: number
  frequency_penalty?: number; presence_penalty?: number; repetition_penalty?: number; seed?: number
  reasoning_effort?: 'minimal' | 'low' | 'medium' | 'high'   // OpenRouter: vira { reasoning: { effort } }
  extraBody?: string                    // JSON livre, merge raso no body (último a ser aplicado)
}
export type ToolName = 'list_dir' | 'read_file' | 'search_files' | 'find_files' | 'write_file' | 'edit_file' | 'bash' | 'web_search' | 'browse_url' | 'list_models' | 'delegate_task'
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
}
export interface Chat { id: string; title: string; config: ChatConfig; mainSessionId: string; createdAt: number; updatedAt: number }

export type SessionStatus = 'idle' | 'running' | 'awaiting_approval' | 'done' | 'error' | 'interrupted'
export interface Session { id: string; chatId: string; parentSessionId: string | null; parentToolCallId: string | null
  depth: 0 | 1 | 2; model: string; title: string; task: string | null; status: SessionStatus; createdAt: number }

// Formato OpenAI exato — é o que é persistido e reenviado byte-a-byte (essencial para token caching)
export type ContentPart = { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }
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
}
export interface StoredMessage { id: string; sessionId: string; seq: number; message: ApiMessage; meta: MessageMeta; createdAt: number }

export interface QueuedMessage { id: string; sessionId: string; text: string; createdAt: number }
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
    send(sessionId, text): { queued: boolean }   // só sessão depth 0. idle → inicia turno; running → enfileira
    forceSend(queuedId): void                   // ⚡: aborta o que está rodando e injeta a mensagem já
    removeQueued(queuedId): void
    getQueue(sessionId): QueuedMessage[]
    stop(sessionId): void                        // aborta (cascata para subsessões)
    regenerate(sessionId): void                  // remove mensagens após a última msg do usuário e roda de novo
    approve(requestId, decision: 'allow' | 'deny' | 'always'): void   // 'always' adiciona a chat.config.autoApprove
    pendingApprovals(): ApprovalRequest[]
    previewRequest(sessionId): { url: string; headers: Record<string,string>; body: unknown }  // request EXATA da próxima chamada (apiKey mascarada)
    runningSessions(): string[]
    compact(sessionId, opts?: { retry?: boolean }): { scheduled: boolean }  // só depth 0; ociosa → já; rodando → próximo limite de passo
  }
  fs: { listDir(path): DirEntry[]; readFile(path): { content: string; truncated: boolean; binary: boolean }; pickDirectory(): string | null; homeDir(): string
        mkdir(path): string }                    // "Nova pasta…" (pai precisa existir; erro "Já existe")
  app: { capabilities(): { bwrap: boolean; ripgrep: boolean } }
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
| list_models | `{ query?, tools_only?: boolean, free_only?: boolean, limit? (padrão 50, máx. 200), sort?: 'id' \| 'price' \| 'context' }` — modelos do provedor do chat via `providers.listModels` (cache de 5 min por provider; sem acesso a arquivos). `query`: cada termo casa com id ou nome (sem caixa nem separadores: "gpt41" acha "gpt-4.1"). `sort`: id (padrão), price (entrada+saída, mais barato primeiro), context (maior janela primeiro); sem dado → fim. Saída: `[N modelos de M no provedor X; mostrando K]` + uma linha por modelo `openai/gpt-4.1-nano (atual) · ctx 1.047k · $0.10/$0.40 por 1M · tools` (grátis = id `:free` ou preço 0 → `· grátis`; `(atual)` = modelo da sessão) + dica de refinar com `query` se cortado (por `limit` ou `maxToolOutputChars`). Falha de `/models` → erro legível (toolStatus `error`). A descrição orienta: grátis só para tarefas fáceis e sem dados pessoais (o provedor pode registrar prompts), são instáveis (429, respostas vazias, sem tools) — se falharem, outro grátis ou um pago. Habilitada por padrão em chats novos (chats existentes mantêm o `enabledTools` salvo). | não |
| delegate_task | `{ task: string, model?: string, title?: string }` — cria subsessão (depth+1), roda o loop até a resposta final, retorna o texto final como resultado. Modelo padrão = modelo da sessão chamadora (a descrição sugere `list_models` para escolher outro). Só disponível se `session.depth < 2` (máx 2 níveis: principal → sub → sub-sub). Se a chamada ao modelo do subagente falhar, o resultado (toolStatus `error`) é `[falha do modelo X: <erro>] O subagente não concluiu a tarefa. Tente outro modelo …` (modelo `:free` → sugere outro grátis ou um pago); resposta final vazia → `(o subagente terminou sem retornar texto — possível falha do modelo X; tente outro modelo)`. | não |

Confirmação: tool em `CONFIRM_TOOLS` e não em `autoApprove` → cria `ApprovalRequest`, emite `approval-requested`, sessão `awaiting_approval`, aguarda `agent.approve`. `deny` → resultado de tool `"O usuário negou a execução desta ferramenta."` (toolStatus `denied`). Subsessões também pedem confirmação (a UI mostra a solicitação mesmo se o usuário estiver em outra sessão).

## Contexto e compactação (`src/shared/context.ts`, `src/main/agent/compaction.ts`, runner)

- **Janela** (`resolveContextWindow`): principal = `contextWindow` (override) → `ModelInfo.contextLength` (`/models`, `context_length`); subsessão = janela do próprio modelo → override.
- **Uso** (`contextUsage`): `promptTokens + completionTokens` da última resposta do assistente após a fronteira mais recente; sem resposta desde a compactação → `meta.contextEstimate` da fronteira (estimativa).
- **Limite**: `compactThreshold` (0.9). ≥ limite → banner "Contexto em 92% — Compactar conversa". `autoCompact` (principal) / sempre (subsessões): compacta sozinho no limite de passo; também ao receber erro de contexto excedido (`isContextLengthError`: "maximum context length", "context_length_exceeded", "prompt is too long", …; ignora rate-limit/TPM), uma vez por chamada bem-sucedida.
- **Compactação** (`agent.compact` ou automática): roda no limite de passo (ociosa: loop só de compactação, status `running`; rodando: agendada, evento `compaction{state:'scheduled'}`; agendada no último passo → roda e encerra o turno, salvo fila/⚡). `repairTail` antes (nunca no meio de um par tool_calls ↔ tool). Request = **a request normal** (mesmas tools, system, params, histórico ativo e breakpoints → prefixo do cache) + último `{role:'user', content: compactPrompt}`; stream visível (`compaction{state:'running', text}`). Se a request estourar o contexto: tenta `trimmed` (resultados de tool/mensagens longas encurtados) e depois `tail` (só as mais recentes que cabem); resposta vazia → repete com `tool_choice:'none'`. Nem a request nem a resposta são persistidas: só a **fronteira** `role: user`, content = `compactionMessageText(resumo)` = `<conversation_summary>\n…\n</conversation_summary>\n\n` + nota "O histórico anterior … foi compactado …", meta `{ kind:'compaction', synthetic:true, summaryOf, compactedCount, usageBefore, contextEstimate, compactUsage, model, durationMs }`. `buildRequest` envia só da fronteira mais recente em diante (system continua primeiro; tool órfão logo após a fronteira é descartado por `sanitizeHistory`). Parar/⚡ durante a compactação cancela sem salvar nada. Apagar a fronteira desfaz a compactação. `{retry:true}` ("Compactar e tentar de novo") roda o agente depois.

## Runner / fila / interrupção (`src/main/agent/`)

Loop por sessão: `build → stream → persistir assistant → executar tool_calls sequencialmente → persistir tool msgs → [drenar fila] → repetir` até o assistente responder sem tool calls.

- **Fila**: `agent.send` com sessão rodando → `QueuedMessage` (memória, por sessão), evento `queue-updated`. No próximo limite de passo (depois que os resultados das tools foram persistidos e antes da próxima chamada, OU quando o assistente termina o turno) todas as mensagens da fila são anexadas como mensagens `user` (meta.kind `queued`) e o loop continua imediatamente.
- **⚡ forceSend**: aborta o stream HTTP (AbortController) e as tools em andamento (kill bash, nega approvals pendentes, aborta subsessões em cascata). Persiste o assistant parcial (se tem conteúdo; `meta.interrupted=true`; tool_calls incompletas descartadas). Para cada tool_call sem resultado, adiciona msg `tool` sintética `"[Interrompido pelo usuário antes de concluir]"` (toolStatus `cancelled`) — mantém o pareamento tool_call/tool válido. Então anexa a mensagem do usuário (meta.kind `forced`) e continua o loop.
- **stop**: igual ao abort acima, sem injetar; sessão `idle`; a fila permanece (cada item mostra ⚡ = enviar agora).
- Erros: status `error`, evento `error`; o usuário pode mandar nova mensagem ou `regenerate`.
- Título do chat: primeira mensagem do usuário truncada (~50 chars). Sem chamadas extras ao modelo.

## UI (renderer)

Estética: escura, elegante, minimalista (referência: Linear / Claude desktop / Raycast). Janela com `titleBarStyle: 'hidden'` + `titleBarOverlay` (cores do tema) e área de drag. Fonte Inter (`@fontsource-variable/inter`), mono JetBrains Mono. Animações sutis. Ícones lucide-react.

- **Onboarding** (sem providers): tela cheia — nome (padrão "OpenRouter"), base URL (padrão `https://openrouter.ai/api/v1`), API key, botão Testar conexão, Continuar.
- **Sidebar esquerda**: "Novo chat", lista de chats (renomear/apagar no hover), engrenagem → Configurações.
- **Novo chat**: tela central — provider, modelo (combobox pesquisável de `listModels`, aceita texto livre), system prompt (textarea, (i)), **Diretório raiz** (seletor de pasta + "Nova pasta…" que cria uma pasta dentro da selecionada e a usa como raiz, (i)), botão "Começar". Só isso.
- **Chat**: header com título, pílula do modelo (clicável → painel config), **seletor de sessão** (principal + subagentes em árvore com indicador de status; subsessão = **somente leitura**, banner "Subagente · somente leitura · voltar à principal"). Mensagens: usuário, assistente em markdown (react-markdown + remark-gfm + highlight), raciocínio em três estados — fechado (só o cabeçalho "Raciocínio"/"Pensando…"), caixa compacta com rolagem própria (abre sozinha enquanto o modelo pensa) e "Expandir tudo" (botão no cabeçalho: texto inteiro na altura natural, sem rolagem interna; "Voltar para a caixa" desfaz); o estado fica guardado por mensagem enquanto o app está aberto — cards de tool call (nome, args, status, resultado colapsável com (i) "enviado ao modelo como `role: tool`"), card de delegate com "Abrir subsessão", aprovação inline (Permitir / Negar / Sempre neste chat), rodapé de uso (in/out/cached/custo). Mensagens sintéticas mostram (i) com o texto exato enviado. Hover: editar / apagar mensagem; regenerar última resposta.
- **Contexto**: medidor compacto no rodapé do composer (e no banner de subsessão) — anel + "38k / 200k · 19%", cor muda em 70% / limite; tooltip com entrada/resposta/cache/janela; janela desconhecida → "N tokens · definir janela"; clique → seção Contexto da Config. Banner acima do composer no limite com "Compactar conversa" (dispensável). Mensagens antes da fronteira ficam visíveis porém esmaecidas, com divisor "Conversa compactada · N mensagens resumidas · não são mais enviadas à API" (Ocultar/Mostrar); a fronteira é um card "Resumo da conversa" (markdown recolhível, (i) "Enviado como mensagem role:user no início do histórico", N mensagens, tokens antes → depois, custo). Compactação em andamento: card com o resumo ao vivo. Erro de contexto excedido → botão "Compactar e tentar de novo".
- **Composer**: textarea auto-grow, Enter envia / Shift+Enter quebra linha, botão Parar quando rodando. Mensagens **enfileiradas** aparecem acima do composer como chips com botão ⚡ (forçar) no canto e X (remover).
- **Painel direito** (colapsável), abas:
  - **Config**: provider, modelo, system prompt (i), parâmetros (cada um com toggle "enviar" — só os ativados vão; (i)), extraBody JSON (i), tools habilitadas (cada uma com (i) mostrando a definição JSON enviada), toggle "Enviar tools nativas (campo tools)" (i), toggle "Inserir texto das tools no system prompt" (i) + textarea editável com reset, toggle "Bloco de ambiente no system prompt" (i, mostra o texto), toggle "Token caching (cache_control)" (i), system prompt de subagentes (i), autoApprove, **Diretório raiz** (caminho, "Alterar…", "Confinar ferramentas à raiz" (i), "Bash em sandbox" (i) — só se bwrap existir), **Contexto** (uso/janela, "Definir janela manualmente", "Sugerir compactação em N%", "Compactar automaticamente", prompt de compactação editável com reset e (i), "Compactar agora"), **Limites** ("Saída máx. por ferramenta" (i)), botão **"Ver request"** → modal com JSON exato da próxima request (`previewRequest`). Tudo editável a qualquer momento; salva automaticamente.
  - **Arquivos**: navegador da raiz — com `confineToRoot` o breadcrumb começa na raiz e nunca sobe acima dela; recarregar (e recarrega sozinho a cada resultado de tool do chat); "Usar como raiz", "Escolher pasta…", "Nova pasta…" (cria na pasta atual e entra nela); clicar arquivo → preview (somente leitura).
- **Configurações** (modal): CRUD de providers (nome, base URL, API key mascarada, headers extras JSON, testar), provider/modelo padrão, system prompt padrão para novos chats.
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

