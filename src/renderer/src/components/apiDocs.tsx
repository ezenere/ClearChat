// Conteúdo dos ícones (i): o que exatamente vai para a API e como. Fonte única para toda a UI.
import { useEffect, useState } from 'react'
import { currentToolDefinition } from '@shared/tools'
import { COMPACTION_NOTE, compactionMessageText } from '@shared/defaults'
import { LIMITS } from '@shared/limits'
import { audioFormat, contentText, formatSize, messageAttachments } from '@shared/attachments'
import type { ApiMessage, AttachmentMeta, ChatParams, StoredMessage, ToolName } from '@shared/types'
import { api } from '../lib/api'
import { ATTACHMENT_LIMITS } from '@shared/limits'
import { ApiInfo, C } from './ui/Tooltip'

type Side = 'top' | 'right' | 'bottom' | 'left'

export function SystemPromptInfo({
  subagent,
  side
}: {
  subagent?: boolean
  side?: Side
}): React.JSX.Element {
  return (
    <ApiInfo title={subagent ? 'System prompt dos subagentes' : 'System prompt'} side={side}>
      {subagent ? (
        <p>
          Nas subsessões criadas por <C>delegate_task</C>, este texto substitui o system prompt
          principal: vira a mensagem <C>{'role: "system"'}</C> no início de <C>messages</C> de cada
          request do subagente.
        </p>
      ) : (
        <p>
          Enviado como a primeira mensagem do array <C>messages</C>, com <C>{'role: "system"'}</C>.
          Usado só na sessão principal.
        </p>
      )}
      <p>
        Ordem do conteúdo: este texto → <C>\n\n</C> + bloco <C>{'<environment>'}</C> (se ativo) →{' '}
        <C>\n\n</C> + texto das tools (se ativo). Com token caching, o conteúdo vai como{' '}
        <C>{'[{ type: "text", text, cache_control: { type: "ephemeral" } }]'}</C>. Se tudo ficar
        vazio, nenhuma mensagem system é enviada.
      </p>
    </ApiInfo>
  )
}

export function ModelFieldInfo({ side }: { side?: Side }): React.JSX.Element {
  return (
    <ApiInfo title="Modelo" side={side}>
      <p>
        O que se escolhe é o par <b>provedor + modelo</b>: o id vai no campo <C>model</C> do body de{' '}
        <C>POST {'{baseUrl}'}/chat/completions</C> <i>desse</i> provedor, com a key dele (
        <C>Authorization: Bearer …</C>) e os headers extras dele. O mesmo id em dois provedores
        (ex.: um Claude via OpenRouter e via Anthropic) são opções diferentes.
      </p>
      <p>
        <C>HTTP-Referer</C>/<C>X-Title</C> vêm da &quot;Assinatura do app&quot;; em OpenRouter
        também vai <C>{'usage: { include: true }'}</C>. Trocar no meio do chat vale a partir da
        próxima request; subagentes ficam no provedor da sessão que os criou, salvo se o{' '}
        <C>delegate_task</C> informar <C>provider</C> (e/ou <C>model</C>) — aí o subagente fica fixo
        nesse par.
      </p>
    </ApiInfo>
  )
}

const PARAM_DOCS: Record<Exclude<keyof ChatParams, 'extraBody'>, string> = {
  temperature: 'Aleatoriedade da amostragem. Maior = mais criativo.',
  top_p: 'Nucleus sampling: considera só os tokens que somam esta probabilidade.',
  top_k: 'Considera só os K tokens mais prováveis (nem todo provedor aceita).',
  max_tokens: 'Limite de tokens gerados na resposta.',
  frequency_penalty: 'Penaliza tokens proporcionalmente à frequência em que já apareceram.',
  presence_penalty: 'Penaliza tokens que já apareceram ao menos uma vez.',
  repetition_penalty: 'Penalidade de repetição (OpenRouter e alguns provedores).',
  seed: 'Semente para amostragem determinística (quando suportado).',
  reasoning_effort: 'Esforço de raciocínio em modelos que suportam.'
}

export function ParamInfo({
  name,
  openRouter
}: {
  name: keyof typeof PARAM_DOCS
  openRouter: boolean
}): React.JSX.Element {
  return (
    <ApiInfo title={<span className="font-mono text-[12px]">{name}</span>} side="left">
      <p>{PARAM_DOCS[name]}</p>
      {name === 'reasoning_effort' ? (
        <p>
          {openRouter ? (
            <>
              Este provedor é OpenRouter: enviado como <C>{'reasoning: { effort: "<valor>" }'}</C>{' '}
              no body.
            </>
          ) : (
            <>
              Enviado como campo <C>reasoning_effort</C> no body (no OpenRouter seria{' '}
              <C>{'reasoning: { effort }'}</C>).
            </>
          )}
        </p>
      ) : (
        <p>
          Enviado como <C>{`"${name}": <número>`}</C> na raiz do body.
        </p>
      )}
      <p className="text-subtle">
        Só vai na request com o toggle ligado; desligado, o campo é omitido.
      </p>
    </ApiInfo>
  )
}

export function ExtraBodyInfo(): React.JSX.Element {
  return (
    <ApiInfo title="Body extra (JSON)" side="left">
      <p>
        Objeto JSON mesclado de forma rasa (<C>{'{ ...body, ...extra }'}</C>) na raiz do body,{' '}
        <strong className="text-fg">por último</strong> — sobrescreve qualquer campo, inclusive{' '}
        <C>model</C>, <C>messages</C> e <C>tools</C>. Vazio = nada é mesclado.
      </p>
    </ApiInfo>
  )
}

export function ToolDefInfo({
  name,
  nativeTools
}: {
  name: ToolName
  nativeTools: boolean
}): React.JSX.Element {
  return (
    <ApiInfo
      title={<span className="font-mono text-[12px]">{name}</span>}
      code={JSON.stringify(currentToolDefinition(name), null, 2)}
      codeLabel="Definição exata (um item do array tools):"
      side="left"
    >
      <p>
        {nativeTools ? (
          <>
            Habilitada: enviada como um item do array <C>tools</C> da request.
          </>
        ) : (
          <>
            &quot;Tools nativas&quot; está desligado: o campo <C>tools</C> não é enviado. A tool só
            chega ao modelo se o texto das tools no system prompt estiver ligado.
          </>
        )}{' '}
        <C>delegate_task</C> é omitida em subsessões de nível 2.
      </p>
    </ApiInfo>
  )
}

export function NativeToolsInfo(): React.JSX.Element {
  return (
    <ApiInfo title="Tools nativas" side="left">
      <p>
        Ligado: as definições JSON das tools habilitadas vão no campo <C>tools</C> da request (antes
        do system, no prefixo cacheável) e o modelo responde com <C>tool_calls</C>.
      </p>
      <p>
        Desligado: o campo <C>tools</C> é omitido. Se o texto das tools no prompt estiver ligado, o
        modelo é instruído a chamar ferramentas escrevendo <C>{'<tool_call>{…}</tool_call>'}</C>, e
        os resultados voltam como mensagens <C>{'role: "user"'}</C> com{' '}
        <C>{'<tool_result name="…">…</tool_result>'}</C>.
      </p>
    </ApiInfo>
  )
}

export function ToolsInPromptInfo({ text }: { text: string }): React.JSX.Element {
  return (
    <ApiInfo
      title="Texto das tools no system prompt"
      code={text}
      codeLabel="Texto exato anexado:"
      side="left"
    >
      <p>
        Anexado ao <strong className="text-fg">final</strong> do conteúdo da mensagem{' '}
        <C>{'role: "system"'}</C>, precedido de <C>\n\n</C>, depois do bloco de ambiente.
      </p>
    </ApiInfo>
  )
}

const ENV_RE = /<environment>[\s\S]*?<\/environment>/

function systemText(body: unknown): string | null {
  const msgs = (body as { messages?: ApiMessage[] } | null)?.messages
  const sys = msgs?.find((m) => m.role === 'system')
  if (!sys) return null
  return contentText(sys.content)
}

/** Busca o bloco <environment> exato via previewRequest; cai num modelo se o main não responder. */
function EnvBlock({
  sessionId,
  cwd,
  deps
}: {
  sessionId?: string
  cwd: string
  deps?: string
}): React.JSX.Element {
  const fallback = `<environment>\nroot: ${cwd}\nos: (sistema operacional detectado pelo app)\nshell: (shell do usuário)\n…\n</environment>`
  const [text, setText] = useState<string | null>(null)
  useEffect(() => {
    if (!sessionId) return
    let alive = true
    api.agent
      .previewRequest(sessionId)
      .then((p) => {
        const m = systemText(p.body)?.match(ENV_RE)
        if (alive && m) setText(m[0])
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [sessionId, cwd, deps])
  return (
    <pre className="max-h-60 overflow-auto rounded-lg border border-border bg-bg/80 p-2.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-fg/90">
      {text ?? fallback}
    </pre>
  )
}

export function EnvInfo({
  sessionId,
  cwd,
  deps
}: {
  /** Sem sessão (ex.: editor de persona): mostra um modelo do bloco. */
  sessionId?: string
  cwd: string
  /** Muda quando opções que alteram o bloco mudam (confinação, sandbox). */
  deps?: string
}): React.JSX.Element {
  return (
    <ApiInfo title="Bloco de ambiente" side="left" wide>
      <p>
        Anexado ao conteúdo da mensagem <C>{'role: "system"'}</C>, precedido de <C>\n\n</C>, logo
        após o seu system prompt. Diz ao modelo o diretório raiz, o SO e as regras do workspace. Sem
        data/hora nem diretório atual do shell, para manter o prefixo estável para o cache. Texto
        exato:
      </p>
      <EnvBlock sessionId={sessionId} cwd={cwd} deps={deps} />
    </ApiInfo>
  )
}

export function RootInfo({ side }: { side?: Side }): React.JSX.Element {
  return (
    <ApiInfo title="Diretório raiz" side={side}>
      <p>
        O workspace da sessão (e de todos os subagentes). Com o bloco de ambiente ativo, aparece no
        system prompt como <C>root: …</C> dentro de <C>{'<environment>'}</C>, junto com a regra de
        que caminhos relativos resolvem a partir dele.
      </p>
      <p>
        Localmente: base dos caminhos relativos das ferramentas e diretório onde o <C>shell</C>{' '}
        começa (o <C>cd</C> persiste entre chamadas da mesma sessão).
      </p>
    </ApiInfo>
  )
}

export function ConfineInfo(): React.JSX.Element {
  return (
    <ApiInfo title="Confinar ao diretório raiz" side="left">
      <p>
        Localmente, <C>list_dir</C>, <C>read_file</C>, <C>write_file</C>, <C>edit_file</C>,{' '}
        <C>search_files</C> e <C>find_files</C> recusam caminhos que (após resolver <C>..</C> e
        links simbólicos) saiam do diretório raiz; o erro volta ao modelo como{' '}
        <C>{'role: "tool"'}</C>. O shell sempre começa no raiz e volta a ele se terminar fora.
      </p>
      <p>
        Com o bloco de ambiente ativo, adiciona ao system prompt a linha:{' '}
        <C>As ferramentas de arquivo só acessam caminhos dentro do diretório raiz.</C>
      </p>
    </ApiInfo>
  )
}

export function SandboxInfo(): React.JSX.Element {
  return (
    <ApiInfo title="Shell em sandbox (bubblewrap)" side="left">
      <p>
        Localmente, o shell (tools <C>shell</C> e <C>process_start</C>) roda via <C>bwrap</C>: o
        diretório raiz é montado com leitura e escrita, o resto do sistema de arquivos fica somente
        leitura, <C>/tmp</C> é privado e a rede continua liberada.
      </p>
      <p>
        Com o bloco de ambiente ativo, adiciona ao system prompt a linha:{' '}
        <C>O shell roda em sandbox: só o diretório raiz (e um /tmp privado) é gravável.</C>
      </p>
    </ApiInfo>
  )
}

export function ContextWindowInfo(): React.JSX.Element {
  return (
    <ApiInfo title="Janela de contexto e limite" side="left">
      <p>
        <strong className="text-fg">Não é enviado à API.</strong> Usado só pelo medidor de contexto
        (tokens da última resposta: <C>prompt_tokens + completion_tokens</C>) e para decidir quando
        sugerir — ou fazer, se automático — a compactação. Sem override, vem do{' '}
        <C>context_length</C> que o provedor informa em <C>/models</C>.
      </p>
      <p className="text-subtle">
        Subagentes usam a janela do próprio modelo e compactam sempre ao atingir o limite.
      </p>
    </ApiInfo>
  )
}

export function CompactPromptInfo({ prompt }: { prompt: string }): React.JSX.Element {
  return (
    <ApiInfo
      title="Prompt de compactação"
      side="left"
      code={compactionMessageText('…resumo gerado pelo modelo…')}
      codeLabel="O histórico anterior é substituído por esta mensagem role: user:"
    >
      <p>
        Usado só na request de compactação: a request normal da sessão (mesmas tools, system,
        parâmetros e histórico ativo — o prefixo vem do cache) com este texto como última mensagem{' '}
        <C>{'{ role: "user", content: "<prompt>" }'}</C>.
      </p>
      <p>
        Essa request e a resposta <strong className="text-fg">não entram no histórico</strong>. O
        resumo é salvo numa mensagem de fronteira; dali em diante cada request envia só{' '}
        <C>system</C> → fronteira → mensagens novas.
      </p>
      <p className="text-subtle">{prompt.length.toLocaleString('pt-BR')} caracteres.</p>
    </ApiInfo>
  )
}

export function MaxOutputInfo(): React.JSX.Element {
  return (
    <ApiInfo title="Limite de saída das ferramentas" side="left">
      <p>
        Teto de caracteres do <C>content</C> de cada resultado enviado ao modelo como{' '}
        <C>{'role: "tool"'}</C> (≈ 4 caracteres por token). Saídas maiores são cortadas com um
        marcador explicando o corte e como ler o resto.
      </p>
      <p>
        Fixos: <C>read_file</C> lê no máximo {LIMITS.readDefaultLines.toLocaleString('pt-BR')}{' '}
        linhas sem offset/limit e corta linhas acima de{' '}
        {LIMITS.readMaxLineChars.toLocaleString('pt-BR')} caracteres; <C>list_dir</C> até{' '}
        {LIMITS.listMaxEntries} entradas; <C>search_files</C> até {LIMITS.searchMaxResults}{' '}
        resultados; <C>list_models</C> até {LIMITS.modelsMaxResults} modelos; <C>shell</C> mantém
        início e fim; <C>browse_url</C> pagina o texto com <C>offset</C>.
      </p>
      <p className="text-subtle">Não é um campo da request.</p>
    </ApiInfo>
  )
}

export function CompactionMessageInfo({
  msg,
  side = 'top'
}: {
  msg: StoredMessage
  side?: Side
}): React.JSX.Element {
  return (
    <ApiInfo
      title="Resumo da conversa (fronteira de compactação)"
      code={JSON.stringify(msg.message, null, 2)}
      codeLabel="Objeto exato no array messages:"
      side={side}
    >
      <p>
        Enviado como mensagem <C>{'role: "user"'}</C> no início do histórico — logo depois do
        system. As mensagens anteriores a ela continuam salvas e visíveis, mas{' '}
        <strong className="text-fg">não são mais enviadas à API</strong>.
      </p>
      <p className="text-subtle">
        Criada pelo app: conteúdo = <C>{'<conversation_summary>…</conversation_summary>'}</C> + a
        nota “{COMPACTION_NOTE}” Se a ferramenta <C>read_history</C> estava habilitada ao compactar,
        a nota diz que o histórico original (mensagens #X–#Y) continua salvo e pode ser consultado
        com <C>read_history</C> (busca ou faixa). Apague-a para voltar a enviar o histórico
        completo.
      </p>
    </ApiInfo>
  )
}

export function CacheInfo(): React.JSX.Element {
  return (
    <ApiInfo title="Token caching" side="left">
      <p>
        Adiciona <C>{'cache_control: { type: "ephemeral" }'}</C> em até três pontos da request (máx.
        4 no Anthropic):
      </p>
      <p>
        1. No system prompt, cujo <C>content</C> vira{' '}
        <C>{'[{ type: "text", text, cache_control }]'}</C>.
        <br />
        2. Na <strong className="text-fg">última</strong> mensagem do array, de qualquer role
        (inclusive <C>{'role: "tool"'}</C>) — assim cada passo de um loop de tools lê do cache tudo
        o que o passo anterior enviou.
        <br />
        3. Na última mensagem <C>{'role: "user"'}</C>, se não for a mesma.
      </p>
      <p>
        O <C>content</C> string vira <C>{'[{ type: "text", text, cache_control }]'}</C> só na cópia
        enviada; o histórico salvo não muda.
      </p>
      <p className="text-subtle">
        O histórico é reenviado byte a byte como foi salvo, para maximizar acertos de cache.
      </p>
    </ApiInfo>
  )
}

export function AutoApproveInfo(): React.JSX.Element {
  return (
    <ApiInfo title="Aprovação automática">
      <p>
        <strong className="text-fg">Não é enviado à API.</strong> Só controla se o app pede sua
        confirmação antes de executar a tool localmente. Se você negar, o resultado enviado ao
        modelo como <C>{'role: "tool"'}</C> é: <C>O usuário negou a execução desta ferramenta.</C>
      </p>
    </ApiInfo>
  )
}

export function ComposerInfo({ running }: { running: boolean }): React.JSX.Element {
  return (
    <ApiInfo title="Sua mensagem" side="top">
      <p>
        Enviada como uma nova mensagem <C>{'{ role: "user", content: "<texto>" }'}</C> (string) no
        fim do array <C>messages</C>, depois de todo o histórico.
      </p>
      <p>
        Com anexos, <C>content</C> vira um array: um part por anexo (imagem → <C>image_url</C>, PDF
        → <C>file</C>, áudio → <C>input_audio</C>, texto → <C>text</C> com{' '}
        <C>{'<file name="…">'}</C>) e, por último, <C>{'{ type: "text", text }'}</C> com o que você
        digitou.
      </p>
      {running && (
        <p>
          O agente está trabalhando: a mensagem entra na <strong className="text-fg">fila</strong> e
          é anexada como <C>{'role: "user"'}</C> no próximo limite de passo (após os resultados das
          tools, antes da próxima chamada).
        </p>
      )}
    </ApiInfo>
  )
}

export function QueueInfo(): React.JSX.Element {
  return (
    <ApiInfo title="Mensagens na fila">
      <p>
        Cada item vira uma mensagem <C>{'role: "user"'}</C> anexada no próximo limite de passo do
        agente, na ordem da fila.
      </p>
      <p>
        ⚡ envia agora: interrompe a geração/tools em andamento, salva a resposta parcial, fecha
        cada tool call pendente com uma mensagem <C>{'role: "tool"'}</C> com o texto{' '}
        <C>[Interrompido pelo usuário antes de concluir]</C> e então anexa sua mensagem.
      </p>
    </ApiInfo>
  )
}

/** (i) de uma mensagem do histórico: mostra o objeto exato reenviado em toda request. */
export function MessageInfo({
  msg,
  side = 'top'
}: {
  msg: StoredMessage
  side?: Side
}): React.JSX.Element {
  const m = msg.message
  if (msg.meta.kind === 'compaction') return <CompactionMessageInfo msg={msg} side={side} />
  if (msg.meta.kind === 'error') {
    return (
      <ApiInfo title="Erro (só exibição)" side={side}>
        <p>
          <strong className="text-fg">Não é enviado à API.</strong> O app salvou este erro no
          histórico apenas para exibição (sobrevive ao reinício); ele é excluído do array{' '}
          <C>messages</C> de todas as requests.
        </p>
      </ApiInfo>
    )
  }
  const origin = originInfo(msg)
  if (origin) {
    return (
      <ApiInfo
        title={origin.title}
        code={JSON.stringify(m, null, 2)}
        codeLabel="Objeto exato no array messages:"
        side={side}
      >
        {origin.body}
      </ApiInfo>
    )
  }
  const desc: Record<ApiMessage['role'], React.ReactNode> = {
    user: (
      <>
        Mensagem <C>{'role: "user"'}</C> do histórico, reenviada em toda request exatamente como
        salva.
      </>
    ),
    assistant: (
      <>
        Mensagem <C>{'role: "assistant"'}</C> reenviada em toda request como salva: <C>content</C>
        {m.role === 'assistant' && m.tool_calls?.length ? (
          <>
            {' '}
            + <C>tool_calls</C>
          </>
        ) : null}
        {m.role === 'assistant' && m.reasoning ? (
          <>
            {' '}
            + <C>reasoning</C>
          </>
        ) : null}
        .
      </>
    ),
    tool: (
      <>
        Resultado enviado ao modelo como <C>{'role: "tool"'}</C>, pareado pelo <C>tool_call_id</C>.
      </>
    ),
    system: (
      <>
        Mensagem <C>{'role: "system"'}</C> do histórico.
      </>
    )
  }
  return (
    <ApiInfo
      title={msg.meta.synthetic ? 'Mensagem sintética (criada pelo app)' : undefined}
      code={JSON.stringify(m, null, 2)}
      codeLabel="Objeto exato no array messages:"
      side={side}
    >
      <p>{desc[m.role]}</p>
      {messageAttachments(m).length > 0 && (
        <p>
          Anexos: no banco ficam só referências <C>clearchat-attachment://…</C> (e o campo privado{' '}
          <C>_attachment</C>); em cada request elas viram o conteúdo em base64 e <C>_attachment</C>{' '}
          é removido. Veja o resultado em &quot;Ver request&quot;.
        </p>
      )}
      {msg.meta.synthetic && (
        <p>
          Não foi escrita por você nem pelo modelo: o app a inseriu para manter a conversa
          consistente.
        </p>
      )}
    </ApiInfo>
  )
}

/** (i) de mensagens que não foram digitadas aqui: outro chat, agente pai, resultado de subagente. */
function originInfo(msg: StoredMessage): { title: string; body: React.ReactNode } | null {
  const k = msg.meta.kind
  if (k === 'inter-chat')
    return {
      title: 'Mensagem de outro chat',
      body: (
        <>
          <p>
            Entregue pelo chat de origem com a ferramenta <C>send_to_chat</C>, como se o usuário a
            digitasse aqui: vai no histórico como <C>{'role: "user"'}</C>, reenviada em toda
            request.
          </p>
          <p className="text-subtle">
            A primeira linha (<C>{'[Mensagem do chat "…" (id …)]'}</C>) é um cabeçalho do app para o
            modelo saber de onde veio. Saltos na cadeia entre chats: {msg.meta.interChatHops ?? 1}{' '}
            (máx. {LIMITS.interChatMaxHops}).
          </p>
        </>
      )
    }
  if (k === 'parent-message')
    return {
      title: 'Mensagem do agente pai',
      body: (
        <p>
          Enviada pelo agente pai com <C>message_subagent</C>. Vai no histórico do subagente como{' '}
          <C>{'role: "user"'}</C>, com o cabeçalho <C>[Mensagem do agente pai]</C> na primeira
          linha.
        </p>
      )
    }
  if (k === 'subagent-callback')
    return {
      title: msg.meta.callbackUpdate
        ? 'Atualização de subagente (criada pelo app)'
        : 'Resultado de subagente (criada pelo app)',
      body: (
        <>
          <p>
            Quando um subagente em segundo plano (ou retomado por uma mensagem nova) termina, o app
            insere o resultado aqui como mensagem <C>{'role: "user"'}</C> sintética: na fila, se o
            agente estava rodando (entra no próximo passo), ou iniciando um turno novo, se estava
            ocioso.
          </p>
          <p className="text-subtle">
            Primeira linha = cabeçalho do app; o resto = resposta final do subagente (ou a falha).
          </p>
        </>
      )
    }
  return null
}

export function TaskInfo({ task, side }: { task: string | null; side?: Side }): React.JSX.Element {
  return (
    <ApiInfo title="Tarefa do subagente" code={task ?? ''} codeLabel="Argumento task:" side={side}>
      <p>
        O subagente não vê esta conversa. A request dele começa do zero com:{' '}
        <C>{'role: "system"'}</C> = system prompt de subagentes (+ ambiente/tools, se ativos) e,
        como primeira mensagem <C>{'role: "user"'}</C>, exatamente o argumento <C>task</C> da
        chamada <C>delegate_task</C>. O texto final dele volta para esta sessão como o resultado{' '}
        <C>{'role: "tool"'}</C>.
      </p>
    </ApiInfo>
  )
}

const LIMITS_TEXT_CHARS = ATTACHMENT_LIMITS.maxTextChars
const b64Size = (n: number): number => Math.ceil(n / 3) * 4

/** (i) de um anexo: como exatamente ele vai na request. */
export function AttachmentApiInfo({
  meta,
  openRouterParsed,
  side = 'top',
  className
}: {
  meta: AttachmentMeta
  className?: string
  /** PDF num modelo sem suporte nativo via OpenRouter (o OpenRouter extrai o texto). */
  openRouterParsed?: boolean
  side?: Side
}): React.JSX.Element {
  const name = JSON.stringify(meta.name)
  const shape =
    meta.kind === 'image'
      ? `{ "type": "image_url", "image_url": { "url": "data:${meta.mime};base64,…" } }`
      : meta.kind === 'pdf'
        ? `{ "type": "file", "file": { "filename": ${name}, "file_data": "data:application/pdf;base64,…" } }`
        : meta.kind === 'audio'
          ? `{ "type": "input_audio", "input_audio": { "data": "<base64>", "format": "${audioFormat(meta.mime)}" } }`
          : `{ "type": "text", "text": "<file name=${name}>\n…conteúdo…\n</file>" }`
  return (
    <ApiInfo
      title={meta.name}
      side={side}
      className={className}
      code={shape}
      codeLabel="Part enviado no content da mensagem role: user:"
    >
      {meta.kind === 'text' ? (
        <p>
          Arquivo de texto ({formatSize(meta.size)}): o conteúdo vai como um part <C>text</C>,
          dentro de <C>{'<file name="…">'}</C> — funciona com qualquer modelo.
          {meta.truncated && (
            <>
              {' '}
              <strong className="text-warning">Cortado</strong> no limite de{' '}
              {LIMITS_TEXT_CHARS.toLocaleString('pt-BR')} caracteres.
            </>
          )}{' '}
          Enviado em toda request enquanto estiver no histórico — conta tokens e é cacheável.
        </p>
      ) : (
        <p>
          {formatSize(meta.size)} → ~{formatSize(b64Size(meta.size))} em base64.{' '}
          <strong className="text-fg">
            Enviado em base64 em toda request enquanto estiver no histórico
          </strong>{' '}
          — conta tokens e é cacheável (os bytes são sempre os mesmos).
        </p>
      )}
      {meta.kind === 'pdf' && (
        <p>
          {openRouterParsed
            ? 'Este modelo não lê PDF nativamente: o OpenRouter extrai o texto do PDF (plugin file-parser) antes de repassar.'
            : 'No OpenRouter, modelos sem suporte nativo a PDF recebem o texto extraído pelo plugin file-parser.'}
        </p>
      )}
      <p>
        {meta.kind === 'text' ? (
          <>O texto fica salvo no histórico já no formato enviado (sem base64).</>
        ) : (
          <>
            No banco fica só uma referência (<C>clearchat-attachment://{meta.file.slice(0, 10)}…</C>
            ); o arquivo fica em <C>userData/attachments</C> e vira base64 na hora de montar cada
            request.
          </>
        )}{' '}
        Os anexos vêm antes do texto no array <C>content</C>.
      </p>
    </ApiInfo>
  )
}
