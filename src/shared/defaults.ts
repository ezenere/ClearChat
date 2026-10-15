// Textos e valores padrão. Ver SPEC.md → ChatConfig / Construção da request.
import type { ChatConfig } from './types'
import { TOOL_NAMES, type ToolDefinition } from './tools'
import { DEFAULT_APP_SIGNATURE } from './appSignatures'
import { LIMITS } from './limits'

export const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1'
export const DEFAULT_PROVIDER_NAME = 'OpenRouter'

export const DEFAULT_SYSTEM_PROMPT = `Você é um assistente prestativo, direto e preciso.
Responda no idioma do usuário (por padrão, português do Brasil).
Seja conciso: vá direto ao ponto e evite rodeios, mas dê detalhes quando forem úteis.
Use Markdown quando ajudar a leitura (listas, tabelas, blocos de código com a linguagem indicada).
Se não souber algo ou faltar informação, diga isso claramente em vez de inventar.`

export const DEFAULT_SUBAGENT_SYSTEM_PROMPT = `Você é um subagente executando uma tarefa delegada por outro agente.
Você não tem acesso à conversa original: tudo o que sabe está na tarefa recebida e no que descobrir com as ferramentas.
Trabalhe de forma autônoma até concluir a tarefa; não faça perguntas ao usuário.
Ao terminar, responda com um relatório final conciso dos resultados: o que foi feito, o que foi encontrado (com caminhos, valores e trechos relevantes) e qualquer pendência ou problema.
Esse relatório é a única coisa que o agente que delegou a tarefa vai ver.`

export const DEFAULT_COMPACT_THRESHOLD = 0.9

export const isOpenRouter = (baseUrl: string): boolean => baseUrl.includes('openrouter.ai')

/** Config padrão de um chat novo. `baseUrl` define o padrão de `cacheEnabled`. */
export function DEFAULT_CHAT_CONFIG(
  cwd: string,
  opts: { providerId?: string; model?: string; systemPrompt?: string; baseUrl?: string } = {}
): ChatConfig {
  return {
    providerId: opts.providerId ?? '',
    model: opts.model ?? '',
    systemPrompt: opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
    params: {},
    enabledTools: [...TOOL_NAMES],
    nativeTools: true,
    toolsInPrompt: false,
    toolsPromptText: null,
    envInPrompt: true,
    cacheEnabled: isOpenRouter(opts.baseUrl ?? DEFAULT_BASE_URL),
    subagentSystemPrompt: DEFAULT_SUBAGENT_SYSTEM_PROMPT,
    cwd,
    confineToRoot: true,
    sandboxBash: false,
    compactThreshold: DEFAULT_COMPACT_THRESHOLD,
    autoCompact: false,
    compactPrompt: null,
    maxToolOutputChars: LIMITS.maxToolOutputChars,
    autoApprove: [],
    appSignature: DEFAULT_APP_SIGNATURE
  }
}

/**
 * Prompt de compactação: enviado como ÚLTIMA mensagem `role: user` de uma request extra
 * (histórico atual + este texto). Nem a request nem a resposta entram no histórico — só o resumo,
 * dentro da mensagem de fronteira (ver compactionMessageText).
 */
export const DEFAULT_COMPACT_PROMPT = `A conversa acima está ficando longa demais para a janela de contexto. Escreva agora um RESUMO DENSO E ESTRUTURADO de tudo o que importa para continuar o trabalho sem o histórico completo. O histórico original será descartado: o que não estiver no resumo será perdido.

Regras:
- Resuma SOMENTE as mensagens acima desta. Esta instrução de resumir não faz parte da conversa: não a mencione.
- Preserve LITERALMENTE todo fato que o usuário informou sobre si ou sobre o trabalho (nomes, identificadores, números, senhas/códigos de teste, preferências), mesmo que pareça trivial.
- Não chame ferramentas; responda apenas com o resumo, em Markdown, nestas seções:

## Objetivo
O que o usuário quer alcançar (inclua literalmente o último pedido do usuário se ele ainda não foi totalmente atendido).

## Decisões e preferências
Decisões tomadas, restrições e preferências do usuário.

## Estado atual
O que já foi feito e onde o trabalho parou.

## Arquivos
Arquivos lidos, criados ou alterados (caminhos completos) e o que mudou ou importa em cada um.

## Fatos importantes
Fatos informados pelo usuário (literalmente), valores, comandos, trechos de código, URLs, erros e soluções que precisam ser lembrados.

## Pendências e próximos passos
Tarefas em aberto e o próximo passo concreto.

Seja específico (caminhos, nomes, números) e conciso. Não invente nada.`

/** Nota que acompanha o resumo na mensagem de fronteira. */
export const COMPACTION_NOTE =
  'O histórico anterior desta conversa foi compactado no resumo acima para economizar contexto; as mensagens originais não estão mais disponíveis. Continue o trabalho a partir daqui.'

/**
 * Nota usada quando read_history está habilitada na sessão no momento da compactação: as mensagens
 * originais (seq X–Y) continuam salvas e podem ser consultadas.
 */
export function compactionNoteWithHistory(fromSeq: number, toSeq: number): string {
  return `O histórico anterior desta conversa (mensagens #${fromSeq}–#${toSeq}) foi compactado no resumo acima para economizar contexto. As mensagens originais continuam salvas: se precisar de um detalhe que não está no resumo, consulte-as com a ferramenta read_history (query para buscar texto, ou from_seq/to_seq para ler uma faixa). Continue o trabalho a partir daqui.`
}

/**
 * Conteúdo exato da mensagem de fronteira (`role: user`) que substitui o histórico anterior.
 * `history` = faixa consultável com read_history (só se a tool estiver habilitada ao compactar).
 */
export function compactionMessageText(
  summary: string,
  history?: { fromSeq: number; toSeq: number }
): string {
  const note = history ? compactionNoteWithHistory(history.fromSeq, history.toSeq) : COMPACTION_NOTE
  return `<conversation_summary>\n${summary.trim()}\n</conversation_summary>\n\n${note}`
}

/**
 * Texto padrão de tools anexado ao system prompt quando `toolsInPrompt` está ligado
 * (e `toolsPromptText` é null).
 * - nativeTools=true: as definições já vão no campo `tools`; o texto só orienta o uso.
 * - nativeTools=false: o texto é o único canal — inclui os schemas e o formato
 *   `<tool_call>{"name": "...", "arguments": {...}}</tool_call>` que o runner faz parse.
 */
export function defaultToolsPrompt(tools: ToolDefinition[], nativeTools: boolean): string {
  if (tools.length === 0) return ''

  const has = (name: string): boolean => tools.some((t) => t.function.name === name)
  const guidelines = [
    '- Caminhos relativos são resolvidos a partir do diretório raiz da sessão.',
    has('edit_file') && '- Leia antes de editar; prefira edit_file a reescrever arquivos inteiros.',
    (has('search_files') || has('read_file')) &&
      '- Proteja o contexto: localize trechos com search_files/find_files e leia arquivos grandes em partes (offset/limit) em vez de inteiros.',
    has('list_models') &&
      has('delegate_task') &&
      '- Para escolher o modelo de um subagente, consulte list_models antes de delegate_task. Modelos grátis: só tarefas fáceis e sem dados pessoais; são instáveis — se falharem, use outro modelo.',
    has('delegate_task') &&
      has('wait_subagents') &&
      '- Subagentes em segundo plano (delegate_task com background=true) rodam em paralelo e o resultado chega sozinho como mensagem; não consulte em loop — use wait_subagents ou encerre o turno. Use message_subagent para atualizar um subagente.',
    has('read_history') &&
      '- Depois de uma compactação, use read_history para recuperar detalhes do histórico original que não estejam no resumo.',
    has('send_to_chat') &&
      '- send_to_chat entrega uma mensagem a outro chat como se fosse o usuário (ids via list_chats). Mensagens vindas de outros chats começam com [Mensagem do chat "…" (id …)].',
    '- Algumas ferramentas exigem aprovação do usuário; se ele negar, não insista — siga sem ela ou pergunte.',
    '- Quando terminar, responda normalmente, sem chamar ferramentas.'
  ]
    .filter(Boolean)
    .join('\n')

  if (nativeTools) {
    const list = tools.map((t) => `- ${t.function.name}: ${t.function.description}`).join('\n')
    return `<tools>\nVocê pode usar as seguintes ferramentas via chamadas de função:\n${list}\n\nDiretrizes:\n${guidelines}\n</tools>`
  }

  const specs = tools
    .map(
      (t) =>
        `## ${t.function.name}\n${t.function.description}\nParâmetros (JSON Schema): ${JSON.stringify(t.function.parameters)}`
    )
    .join('\n\n')

  return `<tools>
Você tem acesso às ferramentas abaixo. Para chamar uma ferramenta, escreva exatamente:
<tool_call>{"name": "NOME_DA_FERRAMENTA", "arguments": {...}}</tool_call>
- "arguments" deve ser um objeto JSON válido conforme o schema da ferramenta.
- Você pode fazer várias chamadas em uma resposta; elas serão executadas em ordem.
- Depois de chamar ferramentas, pare e aguarde: os resultados chegarão em uma mensagem no formato
  <tool_result name="NOME_DA_FERRAMENTA">…</tool_result>
- Nunca escreva um <tool_result> você mesmo.

${specs}

Diretrizes:
${guidelines}
</tools>`
}
