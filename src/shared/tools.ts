// Definições das tools no formato OpenAI (`tools: [{ type: 'function', function }]`).
// Compartilhadas: o main as envia na request; o renderer as mostra no (i) de cada tool.
import type { ToolName } from './types'
import { LIMITS } from './limits'

export interface JsonSchema {
  type: 'object'
  properties: Record<string, { type: string; description?: string; enum?: string[] }>
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
  'bash',
  'web_search',
  'browse_url',
  'list_models',
  'delegate_task'
]

/** Rótulos curtos (pt-BR) para a UI. */
export const TOOL_LABELS: Record<ToolName, string> = {
  list_dir: 'Listar pasta',
  read_file: 'Ler arquivo',
  search_files: 'Buscar no conteúdo',
  find_files: 'Encontrar arquivos',
  write_file: 'Escrever arquivo',
  edit_file: 'Editar arquivo',
  bash: 'Terminal (bash)',
  web_search: 'Pesquisa na web',
  browse_url: 'Abrir URL',
  list_models: 'Listar modelos',
  delegate_task: 'Delegar a subagente'
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
    `Lê um arquivo de texto. Retorna as linhas numeradas no formato "N\\tconteúdo" e sempre informa o total de linhas. Sem offset/limit lê no máximo ${n(L.readDefaultLines)} linhas; linhas com mais de ${n(L.readMaxLineChars)} caracteres são cortadas e a saída total é limitada. Arquivos acima de ${L.readHardMaxBytes / 1024 / 1024} MB só podem ser lidos em partes (offset/limit). Para arquivos grandes, localize o trecho com search_files e leia só a faixa necessária.`,
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
  bash: def(
    'bash',
    'Executa um comando no bash (bash -lc). A primeira chamada começa no diretório raiz; o diretório atual (cd) persiste entre chamadas desta sessão. Retorna stdout+stderr e o código de saída. Saídas longas são cortadas no meio (mantém início e fim): para saídas grandes, redirecione para um arquivo e use grep/head/tail ou read_file com offset/limit.',
    {
      command: { type: 'string', description: 'Comando a executar.' },
      timeout_ms: { type: 'number', description: 'Tempo limite em ms (padrão 120000).' }
    },
    ['command']
  ),
  web_search: def(
    'web_search',
    `Pesquisa na web (DuckDuckGo) e retorna até ${L.webMaxResults} resultados com título, URL e trecho.`,
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
    `Lista os modelos do provedor deste chat, um por linha: id · contexto · preço por 1M tokens (entrada/saída) · grátis · tools. Use para escolher o modelo de um subagente (delegate_task; ele precisa de "tools"). Modelos grátis (id ":free" ou preço 0) só para tarefas fáceis e SEM dados pessoais/sensíveis (o provedor pode registrar os prompts); são instáveis (429, erros, respostas vazias, sem tools): se falharem, tente outro grátis ou um pago. Tarefas difíceis ou com dados pessoais: modelo pago. Padrão ${L.modelsDefaultResults} resultados (máx. ${L.modelsMaxResults}).`,
    {
      query: {
        type: 'string',
        description:
          'Filtra por parte do id ou do nome (sem diferenciar maiúsculas; ex.: "gpt-4.1", "claude").'
      },
      tools_only: { type: 'boolean', description: 'Só modelos com suporte a tools.' },
      free_only: { type: 'boolean', description: 'Só modelos grátis.' },
      limit: {
        type: 'number',
        description: `Máximo de modelos listados (padrão ${L.modelsDefaultResults}, máx. ${L.modelsMaxResults}).`
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
    'Delega uma tarefa autocontida a um subagente com as mesmas ferramentas e o mesmo diretório raiz. O subagente não vê esta conversa: descreva a tarefa com todo o contexto necessário. Retorna o relatório final do subagente. Para outro modelo, consulte list_models; se o modelo falhar, tente outro.',
    {
      task: { type: 'string', description: 'Descrição completa e autocontida da tarefa.' },
      model: {
        type: 'string',
        description: 'Modelo do subagente (padrão: o mesmo desta sessão; veja list_models).'
      },
      title: { type: 'string', description: 'Título curto para a subsessão.' }
    },
    ['task']
  )
}
