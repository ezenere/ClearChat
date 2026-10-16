// Definições das tools no formato OpenAI (`tools: [{ type: 'function', function }]`).
// Compartilhadas: o main as envia na request; o renderer as mostra no (i) de cada tool.
import type { ToolName } from './types'
import { LIMITS } from './limits'
import { ASK_USER_LIMITS as AL } from './askUser'
import { shellDescriptionPrefix, toolShellInfo, type ShellInfoLite } from './shellInfo'

const shellDescription = (info: ShellInfoLite | null): string => {
  const p = shellDescriptionPrefix(info)
  return `${p}${/[.!]$/.test(p) ? '' : '.'} ${SHELL_DESC_REST}`
}

/** Resto da descrição da tool `shell` (o início diz qual shell — ver shellInfo.ts). */
const SHELL_DESC_REST =
  'O ambiente do shell de login/interativo do usuário (PATH, nvm etc.) já vem carregado. A primeira chamada começa no diretório raiz; o diretório atual (cd) persiste entre chamadas desta sessão. Retorna stdout+stderr e o código de saída; o comando precisa TERMINAR (há tempo limite). Para algo que deve continuar rodando (servidor, emulador, watcher, logcat), use process_start — nunca `&`/nohup aqui. Saídas longas são cortadas no meio (mantém início e fim): para saídas grandes, redirecione para um arquivo e use grep/head/tail ou read_file com offset/limit.'

/** Propriedade de JSON Schema (recursiva: arrays de objetos, ex.: ask_user). */
export interface JsonSchemaProp {
  type: string
  description?: string
  enum?: string[]
  items?: JsonSchemaProp
  properties?: Record<string, JsonSchemaProp>
  required?: string[]
  minItems?: number
  maxItems?: number
  additionalProperties?: boolean
}

export interface JsonSchema {
  type: 'object'
  properties: Record<string, JsonSchemaProp>
  required?: string[]
  additionalProperties?: boolean
}

export interface ToolDefinition {
  type: 'function'
  function: { name: ToolName; description: string; parameters: JsonSchema }
}

export const TOOL_NAMES: ToolName[] = [
  'list_dir',
  'read_file',
  'search_files',
  'find_files',
  'write_file',
  'edit_file',
  'shell',
  'process_start',
  'process_logs',
  'process_list',
  'process_stop',
  'web_search',
  'browse_url',
  'list_models',
  'delegate_task',
  'get_chat_info',
  'list_chats',
  'send_to_chat',
  'read_history',
  'check_subagents',
  'wait_subagents',
  'cancel_subagent',
  'message_subagent',
  'ask_user'
]

/** Rótulos curtos (pt-BR) para a UI. */
export const TOOL_LABELS: Record<ToolName, string> = {
  list_dir: 'Listar pasta',
  read_file: 'Ler arquivo',
  search_files: 'Buscar no conteúdo',
  find_files: 'Encontrar arquivos',
  write_file: 'Escrever arquivo',
  edit_file: 'Editar arquivo',
  shell: 'Terminal (shell)',
  process_start: 'Iniciar processo',
  process_logs: 'Logs do processo',
  process_list: 'Listar processos',
  process_stop: 'Parar processo',
  web_search: 'Pesquisa na web',
  browse_url: 'Abrir URL',
  list_models: 'Listar modelos',
  delegate_task: 'Delegar a subagente',
  get_chat_info: 'Info do chat',
  list_chats: 'Listar chats',
  send_to_chat: 'Enviar para chat',
  read_history: 'Ler histórico',
  check_subagents: 'Ver subagentes',
  wait_subagents: 'Aguardar subagentes',
  cancel_subagent: 'Cancelar subagente',
  message_subagent: 'Mensagem ao subagente',
  ask_user: 'Perguntar ao usuário'
}

const def = (
  name: ToolName,
  description: string,
  properties: JsonSchema['properties'],
  required: string[] = []
): ToolDefinition => ({
  type: 'function',
  function: {
    name,
    description,
    parameters: { type: 'object', properties, required, additionalProperties: false }
  }
})

const L = LIMITS
const n = (v: number): string => v.toLocaleString('pt-BR')

export const TOOL_DEFINITIONS: Record<ToolName, ToolDefinition> = {
  list_dir: def(
    'list_dir',
    `Lista arquivos e pastas de um diretório (pastas primeiro, com o tamanho dos arquivos). Caminhos relativos resolvem a partir do diretório raiz da sessão. Mostra no máximo ${n(L.listMaxEntries)} entradas; para árvores grandes prefira find_files / search_files.`,
    { path: { type: 'string', description: 'Diretório a listar (padrão: diretório raiz).' } }
  ),
  read_file: def(
    'read_file',
    `Lê um arquivo de texto — e, se o modelo desta sessão aceitar, imagens (png/jpg/webp/gif) e PDF, que voltam como imagem/documento para você ver (ideal para conferir screenshots que você gerou; imagens grandes são reduzidas). Texto: retorna as linhas numeradas no formato "N\\tconteúdo" e sempre informa o total de linhas. Sem offset/limit lê no máximo ${n(L.readDefaultLines)} linhas; linhas com mais de ${n(L.readMaxLineChars)} caracteres são cortadas e a saída total é limitada. Arquivos acima de ${L.readHardMaxBytes / 1024 / 1024} MB só podem ser lidos em partes (offset/limit). Para arquivos grandes, localize o trecho com search_files e leia só a faixa necessária.`,
    {
      path: {
        type: 'string',
        description: 'Caminho do arquivo (relativo ao diretório raiz ou absoluto).'
      },
      offset: { type: 'number', description: 'Linha inicial (1 = primeira linha).' },
      limit: { type: 'number', description: 'Número máximo de linhas a ler.' }
    },
    ['path']
  ),
  search_files: def(
    'search_files',
    `Busca uma expressão regular no conteúdo dos arquivos (como grep -rn / ripgrep). Retorna linhas "caminho:linha: texto" (caminhos relativos ao diretório raiz). Ignora .git, node_modules, arquivos binários e o que estiver no .gitignore. Padrão ${L.searchDefaultResults} resultados (máx. ${L.searchMaxResults}). Use para localizar trechos antes de ler arquivos grandes.`,
    {
      pattern: { type: 'string', description: 'Expressão regular a buscar.' },
      path: {
        type: 'string',
        description: 'Pasta ou arquivo onde buscar (padrão: diretório raiz).'
      },
      glob: {
        type: 'string',
        description: 'Filtra arquivos por glob (ex.: "*.ts", "src/**/*.py").'
      },
      max_results: {
        type: 'number',
        description: `Máximo de linhas de resultado (padrão ${L.searchDefaultResults}).`
      },
      case_insensitive: {
        type: 'boolean',
        description: 'Ignorar maiúsculas/minúsculas (padrão false).'
      }
    },
    ['pattern']
  ),
  find_files: def(
    'find_files',
    `Encontra arquivos pelo nome usando um glob (ex.: "*.md", "src/**/*.test.ts"). Retorna caminhos relativos ao diretório raiz, ordenados (máx. ${L.findMaxResults}). Ignora .git, node_modules e o que estiver no .gitignore.`,
    {
      glob: {
        type: 'string',
        description: 'Padrão glob. Sem "/", casa com o nome do arquivo em qualquer pasta.'
      },
      path: { type: 'string', description: 'Pasta base (padrão: diretório raiz).' }
    },
    ['glob']
  ),
  write_file: def(
    'write_file',
    'Cria ou sobrescreve um arquivo com o conteúdo informado. Cria as pastas intermediárias se necessário.',
    {
      path: {
        type: 'string',
        description: 'Caminho do arquivo (relativo ao diretório raiz ou absoluto).'
      },
      content: { type: 'string', description: 'Conteúdo completo do arquivo.' }
    },
    ['path', 'content']
  ),
  edit_file: def(
    'edit_file',
    'Substitui um trecho exato de um arquivo. Falha se old_string não for encontrado ou não for único (a menos que replace_all seja true).',
    {
      path: {
        type: 'string',
        description: 'Caminho do arquivo (relativo ao diretório raiz ou absoluto).'
      },
      old_string: { type: 'string', description: 'Texto exato a ser substituído.' },
      new_string: { type: 'string', description: 'Texto novo.' },
      replace_all: {
        type: 'boolean',
        description: 'Substituir todas as ocorrências (padrão false).'
      }
    },
    ['path', 'old_string', 'new_string']
  ),
  shell: def(
    'shell',
    shellDescription(null),
    {
      command: { type: 'string', description: 'Comando a executar.' },
      timeout_ms: { type: 'number', description: 'Tempo limite em ms (padrão 120000).' }
    },
    ['command']
  ),
  process_start: def(
    'process_start',
    `Inicia um processo em SEGUNDO PLANO que continua rodando depois que a ferramenta retorna (dev server, emulador/AVD, \`adb logcat\`, watcher, banco local…). Para comandos que terminam, use shell. Roda no shell do usuário (mesmo ambiente do shell), com stdout+stderr capturados num log. O processo sobrevive entre turnos e é encerrado com process_stop ou quando o ClearChat fecha. Retorna o id (ex.: "p1"), pid e as primeiras linhas de saída. Para esperar ficar pronto, use wait_for (regex casada contra cada linha da saída, ex.: "Listening on|ready in") em vez de sleep/polling: retorna quando casar, quando o processo sair (erro com o código e o fim do log) ou no tempo limite (o processo continua rodando). A saída não é um terminal: se um programa fizer buffer do stdout, force line-buffering (ex.: \`stdbuf -oL cmd\`). Interromper a espera não mata o processo. Depois, use process_logs (pattern / since_line) para inspecionar. Máx. ${L.processMaxPerChat} processos rodando por chat.`,
    {
      command: { type: 'string', description: 'Comando a executar (shell -c).' },
      name: { type: 'string', description: 'Rótulo curto (ex.: "vite", "emulador").' },
      cwd: {
        type: 'string',
        description:
          'Diretório (relativo ao raiz ou absoluto). Padrão: o diretório atual do shell desta sessão.'
      },
      wait_for: {
        type: 'string',
        description:
          'Regex: espera até uma linha da saída casar (ex.: "boot completed|Listening on").'
      },
      timeout_s: {
        type: 'number',
        description: `Espera máxima do wait_for em segundos (padrão ${L.processWaitDefaultS}, máx. ${L.processWaitMaxS}). Sem wait_for, espera só ~1 s para capturar falhas imediatas.`
      }
    },
    ['command']
  ),
  process_logs: def(
    'process_logs',
    `Lê a saída (stdout+stderr) de um processo de process_start, com as linhas numeradas pela posição no log ("N\ttexto"). Padrão: as últimas ${L.processLogsDefaultLines} linhas. Para acompanhar incrementalmente, passe since_line com o número da última linha já vista (só vem o que é novo). pattern filtra por regex. Informa o estado (rodando / encerrado com código), o total de linhas e o caminho do arquivo com o log completo (a memória guarda só as últimas ${n(L.processBufferLines)} linhas; para buscar no log inteiro use search_files/read_file nesse arquivo).`,
    {
      id: { type: 'string', description: 'Id do processo (ex.: "p1").' },
      pattern: { type: 'string', description: 'Regex para filtrar as linhas.' },
      case_insensitive: {
        type: 'boolean',
        description: 'pattern sem diferenciar maiúsculas (padrão false).'
      },
      tail: {
        type: 'number',
        description: `Últimas N linhas (ou ocorrências, com pattern). Padrão ${L.processLogsDefaultLines}, máx. ${n(L.processLogsMaxLines)}.`
      },
      since_line: {
        type: 'number',
        description:
          'Só linhas com número maior que este (leitura incremental; vem em ordem, a partir da primeira nova).'
      },
      offset: { type: 'number', description: 'Linha inicial (1 = primeira) para ler uma faixa.' },
      limit: {
        type: 'number',
        description: 'Máximo de linhas com since_line/offset (padrão = tail).'
      }
    },
    ['id']
  ),
  process_list: def(
    'process_list',
    'Lista os processos em segundo plano deste chat (iniciados por esta sessão, pela principal ou por subagentes): id, nome, comando, pid, diretório, estado, há quanto tempo roda, nº de linhas de log e a última linha.',
    {}
  ),
  process_stop: def(
    'process_stop',
    'Para um processo de process_start: envia o sinal ao grupo de processos inteiro (filhos inclusos) e, se não sair em ~3 s, SIGKILL. Retorna o código final e o fim do log.',
    {
      id: { type: 'string', description: 'Id do processo (ex.: "p1").' },
      signal: {
        type: 'string',
        enum: ['SIGTERM', 'SIGINT', 'SIGKILL'],
        description: 'Sinal inicial (padrão SIGTERM).'
      }
    },
    ['id']
  ),
  web_search: def(
    'web_search',
    `Pesquisa na web (DuckDuckGo, com fallback automático para o Brave Search se o DuckDuckGo bloquear ou falhar) e retorna até ${L.webMaxResults} resultados com título, URL e trecho; a 1ª linha diz qual buscador respondeu. Há um intervalo mínimo global entre pesquisas (configurável; padrão 5 s): se preciso, a chamada espera a vez e a 1ª linha informa quanto aguardou.`,
    { query: { type: 'string', description: 'Termos de busca.' } },
    ['query']
  ),
  browse_url: def(
    'browse_url',
    `Abre uma URL em um navegador oculto e retorna o título, o texto visível e (na primeira página) os principais links. O texto vem em páginas de até ${n(L.browsePageChars)} caracteres; o cabeçalho indica "caracteres X–Y de Z" — use offset para ler a continuação (sem recarregar a página).`,
    {
      url: { type: 'string', description: 'URL completa (http/https).' },
      offset: {
        type: 'number',
        description: 'Posição (em caracteres) do texto a partir da qual ler (padrão 0).'
      }
    },
    ['url']
  ),
  list_models: def(
    'list_models',
    `Lista os modelos de todos os provedores configurados (seções [Provedor]; o desta sessão primeiro), um por linha: id · contexto · preço por 1M tokens (entrada/saída) · grátis · tools. Use para escolher o modelo de um subagente (delegate_task com model e provider; ele precisa de "tools"). Modelos grátis (id ":free" ou preço 0) só para tarefas fáceis e SEM dados pessoais/sensíveis (o provedor pode registrar os prompts); são instáveis (429, erros, respostas vazias, sem tools): se falharem, tente outro grátis ou um pago. Tarefas difíceis ou com dados pessoais: modelo pago. Padrão ${L.modelsDefaultResults} por provedor (máx. ${L.modelsMaxResults}).`,
    {
      query: {
        type: 'string',
        description:
          'Filtra por parte do id ou do nome (sem diferenciar maiúsculas; ex.: "gpt-4.1", "claude").'
      },
      provider: {
        type: 'string',
        description: 'Só este provedor (nome ou id). Padrão: todos.'
      },
      tools_only: { type: 'boolean', description: 'Só modelos com suporte a tools.' },
      free_only: { type: 'boolean', description: 'Só modelos grátis.' },
      limit: {
        type: 'number',
        description: `Máximo de modelos listados por provedor (padrão ${L.modelsDefaultResults}, máx. ${L.modelsMaxResults}).`
      },
      sort: {
        type: 'string',
        enum: ['id', 'price', 'context'],
        description:
          'Ordem: id (padrão), price (mais barato primeiro) ou context (maior janela primeiro).'
      }
    }
  ),
  delegate_task: def(
    'delegate_task',
    'Delega uma tarefa autocontida a um subagente com as mesmas ferramentas e o mesmo diretório raiz. O subagente não vê esta conversa: descreva a tarefa com todo o contexto necessário. Retorna o relatório final do subagente. Com background=true retorna na hora e o resultado chega depois sozinho, como mensagem: se você estiver no meio de um turno, ele entra no próximo passo; se tiver encerrado o turno, você é acordado. Use para tarefas independentes ou longas e para rodar várias em paralelo. Sem mais nada a fazer enquanto eles rodam, ENCERRE O TURNO (pode dizer ao usuário o que está em andamento) — não precisa chamar wait_subagents nem consultar check_subagents; só use wait_subagents se o seu próximo passo, no mesmo turno, depende do resultado. Para outro modelo (ou o mesmo modelo por outro provedor), consulte list_models e passe model/provider; se o modelo falhar, tente outro.',
    {
      task: { type: 'string', description: 'Descrição completa e autocontida da tarefa.' },
      model: {
        type: 'string',
        description: 'Modelo do subagente (padrão: o mesmo desta sessão; veja list_models).'
      },
      provider: {
        type: 'string',
        description:
          'Provedor do subagente (nome, como em list_models, ou id). Padrão: o desta sessão.'
      },
      title: { type: 'string', description: 'Título curto para a subsessão.' },
      background: {
        type: 'boolean',
        description: 'Rodar em segundo plano e receber o resultado depois (padrão false).'
      }
    },
    ['task']
  ),
  get_chat_info: def(
    'get_chat_info',
    'Retorna informações deste chat: id, título, sessão atual (e sessão-pai, se for subagente), modelo, provedor, diretório raiz e data de criação.',
    {}
  ),
  list_chats: def(
    'list_chats',
    `Lista os chats do app (id, título, modelo, estado — ocioso, rodando ou aguardando aprovação — e última atualização), mais recentes primeiro; marca este chat. Com query, filtra pelo título (sem acentos/maiúsculas, mais parecidos primeiro). Para achar um chat pelo que foi DISCUTIDO nele, use read_history com scope "all". Padrão ${L.chatsDefaultResults} (máx. ${L.chatsMaxResults}).`,
    {
      query: {
        type: 'string',
        description: 'Filtra por palavras do título (ou início do id).'
      },
      limit: {
        type: 'number',
        description: `Máximo de chats listados (padrão ${L.chatsDefaultResults}).`
      }
    }
  ),
  send_to_chat: def(
    'send_to_chat',
    `Envia uma mensagem a OUTRO chat (id via list_chats), como se o usuário a digitasse lá: inicia um turno, ou entra na fila se o chat estiver ocupado. O destinatário vê de qual chat ela veio. Com wait_for_reply=true, aguarda o fim do turno e retorna a resposta final dele. Não envia para este próprio chat; cadeias de mensagens entre chats param em ${L.interChatMaxHops} saltos.`,
    {
      chat_id: { type: 'string', description: 'Id do chat de destino.' },
      message: { type: 'string', description: 'Texto a entregar.' },
      wait_for_reply: {
        type: 'boolean',
        description: 'Aguardar e retornar a resposta do chat (padrão false).'
      },
      timeout_s: {
        type: 'number',
        description: `Espera máxima em segundos com wait_for_reply (padrão ${L.interChatDefaultTimeoutS}).`
      }
    },
    ['chat_id', 'message']
  ),
  read_history: def(
    'read_history',
    `Lê o histórico salvo desta sessão, inclusive mensagens anteriores a compactações (que não estão mais no seu contexto). Com query: busca o texto (sem diferenciar maiúsculas) em mensagens, argumentos e resultados de tools e retorna trechos com o número #seq. Sem query: retorna as mensagens de from_seq a to_seq (padrão ${L.historyDefaultMessages}). Mensagens longas são cortadas; para ler uma inteira, use from_seq = to_seq. OUTROS CHATS (só leitura): scope "all" + query busca em todos os chats menos este (por relevância, agrupado por chat, até ${L.historyAllPerChat} trechos cada) — use para achar algo discutido em outro chat ou o chat certo antes de send_to_chat; chat_id (id ou prefixo) busca ou lê a faixa naquele chat.`,
    {
      query: {
        type: 'string',
        description:
          'Texto a buscar (em outros chats: palavras, sem acentos/maiúsculas, prefixos casam).'
      },
      chat_id: {
        type: 'string',
        description:
          'Outro chat (id ou prefixo único, via list_chats ou scope "all"): busca/faixa nele em vez desta sessão.'
      },
      scope: {
        type: 'string',
        enum: ['all'],
        description: '"all": buscar a query em todos os outros chats.'
      },
      session_id: {
        type: 'string',
        description: 'Com chat_id: subsessão (subagente) daquele chat; padrão a principal.'
      },
      from_seq: { type: 'number', description: 'Primeira mensagem (#seq).' },
      to_seq: { type: 'number', description: 'Última mensagem (#seq).' },
      limit: {
        type: 'number',
        description: `Máximo de mensagens (faixa: padrão ${L.historyDefaultMessages}; busca: padrão ${L.historySearchDefault}); com scope "all", de chats (padrão ${L.historyAllChatsDefault}).`
      },
      include_tool_results: {
        type: 'boolean',
        description:
          'Na faixa, inclui o conteúdo dos resultados de tools (padrão false: só o tamanho).'
      }
    }
  ),
  check_subagents: def(
    'check_subagents',
    'Lista os subagentes desta sessão: id, título, modelo, estado, duração, última atividade e se o resultado já foi entregue. Não use para esperar: se não há mais nada a fazer, encerre o turno — os resultados chegam sozinhos e te acordam.',
    {}
  ),
  wait_subagents: def(
    'wait_subagents',
    `Aguarda subagentes em segundo plano terminarem e retorna os resultados (que então não chegam de novo como mensagem). mode "all" (padrão) espera todos; "any", o primeiro. Sem ids: todos os pendentes desta sessão. No tempo limite (padrão ${L.subagentWaitDefaultS}s), retorna os estados. Raramente necessário: os resultados de subagentes em segundo plano já chegam sozinhos como mensagem (e te acordam se o turno tiver encerrado). Use só quando precisa do resultado para continuar NESTE turno; se não há mais nada a fazer, prefira encerrar o turno.`,
    {
      ids: { type: 'array', items: { type: 'string' }, description: 'Ids dos subagentes.' },
      mode: { type: 'string', enum: ['all', 'any'], description: 'all (padrão) ou any.' },
      timeout_s: {
        type: 'number',
        description: `Espera máxima em segundos (padrão ${L.subagentWaitDefaultS}).`
      }
    }
  ),
  cancel_subagent: def(
    'cancel_subagent',
    'Cancela um subagente em execução (e os subagentes dele). O cancelamento é informado na mensagem de resultado.',
    { id: { type: 'string', description: 'Id do subagente.' } },
    ['id']
  ),
  message_subagent: def(
    'message_subagent',
    'Envia uma mensagem a um subagente que VOCÊ criou com delegate_task (direto ou descendente) — ex.: para avisar de mudanças. Não serve para responder a quem te delegou uma tarefa (para isso, apenas responda). Rodando: entra no próximo passo dele; ocioso ou concluído: ele retoma e a nova resposta final volta como mensagem. Com wait_for_reply=true, aguarda e retorna essa resposta.',
    {
      id: { type: 'string', description: 'Id do subagente.' },
      message: { type: 'string', description: 'Texto a entregar.' },
      wait_for_reply: {
        type: 'boolean',
        description: 'Aguardar e retornar a próxima resposta final dele (padrão false).'
      },
      timeout_s: {
        type: 'number',
        description: `Espera máxima em segundos com wait_for_reply (padrão ${L.subagentWaitDefaultS}).`
      }
    },
    ['id', 'message']
  ),
  ask_user: def(
    'ask_user',
    `Faz um questionário de múltipla escolha ao usuário (1 a ${AL.maxQuestions} perguntas, 1 a ${AL.maxOptions} opções cada) — a interface mostra uma pergunta por vez no lugar do campo de mensagem e o resultado chega quando ele envia as respostas (a ferramenta aguarda). Use quando há uma decisão com opções claras (ex.: qual banco de dados, qual abordagem) ou para coletar várias preferências de uma vez antes de começar. NÃO use para uma pergunta aberta simples ou para confirmar algo trivial — nesse caso apenas escreva a pergunta no chat e encerre o turno. O usuário sempre pode escolher "Outro" e escrever a própria resposta (a opção "Outro" é adicionada automaticamente: não a inclua). Ele não pode pular perguntas. Se ele cancelar, o resultado diz que não respondeu e o seu turno termina; não insista com o mesmo questionário. Campos opcionais por opção: icon (nome de ícone lucide em kebab-case como "database", um emoji, ou uma imagem pequena: URL http(s), caminho de arquivo dentro do diretório raiz ou "<svg…>" inline), description, image (imagem grande mostrada ao passar o mouse — URL, caminho ou "<svg…>") e help (texto de ajuda exibido em fonte monoespaçada, preservando espaços/ASCII art, ou uma imagem nas mesmas formas). Use imagens/ajuda só quando realmente ajudam a decidir.`,
    {
      questions: {
        type: 'array',
        minItems: 1,
        maxItems: AL.maxQuestions,
        description: `Perguntas (1 a ${AL.maxQuestions}), mostradas na ordem.`,
        items: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Pergunta (curta).' },
            description: { type: 'string', description: 'Contexto extra (opcional).' },
            multiple: {
              type: 'boolean',
              description: 'Permite marcar várias opções (padrão false = uma só).'
            },
            options: {
              type: 'array',
              minItems: 1,
              maxItems: AL.maxOptions,
              description: `1 a ${AL.maxOptions} opções (sem "Outro" — é adicionada automaticamente).`,
              items: {
                type: 'object',
                properties: {
                  title: { type: 'string', description: 'Texto da opção.' },
                  icon: {
                    type: 'string',
                    description:
                      'Opcional: ícone lucide (kebab-case, ex. "database"), emoji, ou imagem pequena (URL http(s), caminho no diretório raiz ou "<svg…>").'
                  },
                  description: { type: 'string', description: 'Opcional: detalhe da opção.' },
                  image: {
                    type: 'string',
                    description:
                      'Opcional: imagem grande mostrada ao passar o mouse (URL http(s), caminho no diretório raiz ou "<svg…>").'
                  },
                  help: {
                    type: 'string',
                    description:
                      'Opcional: ajuda no botão "?" — texto (monoespaçado, preserva espaços) ou imagem (mesmas formas de image).'
                  }
                },
                required: ['title'],
                additionalProperties: false
              }
            }
          },
          required: ['title', 'options'],
          additionalProperties: false
        }
      }
    },
    ['questions']
  )
}

/** Definição da tool `shell` com o shell detectado na descrição (null = genérica). */
export function shellToolDefinition(info: ShellInfoLite | null): ToolDefinition {
  const d = TOOL_DEFINITIONS.shell
  if (!info) return d
  return {
    ...d,
    function: { ...d.function, description: shellDescription(info) }
  }
}

/** Definição "como enviada" independente de provedores (shell com o shell detectado). */
export function currentToolDefinition(name: ToolName): ToolDefinition {
  return name === 'shell' ? shellToolDefinition(toolShellInfo()) : TOOL_DEFINITIONS[name]
}

/** Tools com o argumento `provider` (escolha entre os provedores configurados). */
const PROVIDER_ARG_TOOLS: ToolName[] = ['list_models', 'delegate_task']

/**
 * Definição enviada na request, ajustada aos provedores configurados: com um provedor só, o
 * argumento `provider` some (modelos fracos o preenchem com nomes inventados); com vários, ganha
 * `enum` com os nomes (quando únicos). As demais tools ficam iguais (mesmo objeto).
 */
export function toolDefinitionFor(name: ToolName, providerNames: string[]): ToolDefinition {
  const d = TOOL_DEFINITIONS[name]
  if (name === 'shell') return currentToolDefinition(name)
  if (!PROVIDER_ARG_TOOLS.includes(name)) return d
  const { provider, ...rest } = d.function.parameters.properties
  if (!provider) return d
  const names = [...new Set(providerNames)]
  const properties =
    providerNames.length <= 1
      ? rest
      : {
          ...d.function.parameters.properties,
          provider: names.length === providerNames.length ? { ...provider, enum: names } : provider
        }
  return {
    ...d,
    function: { ...d.function, parameters: { ...d.function.parameters, properties } }
  }
}
