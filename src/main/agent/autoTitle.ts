// Título automático (main, sem Electron): monta a request ao modelo do título, chama em segundo
// plano e só troca o título provisório se ninguém renomeou o chat enquanto isso. Banco/eventos
// entram por `AutoTitleDeps` (src/main/autoTitle.ts liga ao app; os testes passam falsos).
// Ver SPEC.md → "Título automático".
import { DEFAULT_APP_SIGNATURE, resolveAppSignatureHeaders } from '@shared/appSignatures'
import {
  AUTO_TITLE_DEFAULTS,
  autoTitleEnabled,
  buildAutoTitleMessages,
  sanitizeTitle,
  type AutoTitleRecord,
  type AutoTitleSettings
} from '@shared/autoTitle'
import { EFFORT_ORDER, type ParamSupport } from '@shared/modelParams'
import { providerKind } from '@shared/providerKinds'
import type { Chat, ChatConfig, ChatParams, Provider, ReasoningEffort } from '@shared/types'
import { adapterFor } from './adapters'
import { buildAnthropicBody } from './adapters/anthropic'
import { newAccumulator, streamChat } from './llm'
import { filterParams, type BuiltRequest } from './request'

/**
 * Raciocínio mínimo para a chamada (barata): `none` se o modelo aceita, senão o nível mais baixo.
 * Só com níveis confiáveis (API ou tabela conferida); desconhecido → não manda nada (um endpoint
 * que não conhece o campo poderia recusar a request).
 */
export function minimalEffort(effort: ParamSupport['effort']): ReasoningEffort | undefined {
  if (!effort?.known) return undefined
  return EFFORT_ORDER.find((e) => effort.levels.includes(e))
}

/** Request exata da chamada do título (formato do adaptador do provedor). */
export function buildAutoTitleRequest(input: {
  settings: AutoTitleSettings
  provider: Provider
  chatConfig?: Pick<ChatConfig, 'appSignature' | 'appSignatureCustom'>
  text: string
  attachments?: string[]
  memory?: string | null
}): BuiltRequest {
  const { settings: s, provider } = input
  const model = s.model ?? ''
  const kind = providerKind(provider)
  const adapter = adapterFor(kind)
  const signature = resolveAppSignatureHeaders(
    input.chatConfig?.appSignature ?? DEFAULT_APP_SIGNATURE,
    input.chatConfig?.appSignatureCustom
  )
  const messages = buildAutoTitleMessages(s.prompt, {
    text: input.text,
    attachments: input.attachments,
    memory: input.memory
  })
  // max_tokens e raciocínio mínimo passam pelo mesmo filtro do chat: só vai o que o modelo aceita
  const base: ChatParams = { max_tokens: s.maxTokens }
  const effort = minimalEffort(filterParams(base, kind, provider.id, model, null).effort)
  const support = filterParams(
    effort ? { ...base, reasoning_effort: effort } : base,
    kind,
    provider.id,
    model,
    null
  )
  let body: Record<string, unknown>
  if (kind === 'anthropic') {
    // max_tokens é obrigatório na API nativa (o filtro nunca o tira na Anthropic)
    body = buildAnthropicBody({ model, messages, params: support.send })
  } else {
    body = { model, messages }
    if (support.send.max_tokens != null) body.max_tokens = support.send.max_tokens
    const e = support.send.reasoning_effort
    if (e) {
      if (kind === 'openrouter') body.reasoning = { effort: e }
      else body.reasoning_effort = e
    }
    body.stream = true
    body.stream_options = { include_usage: true }
    if (kind === 'openrouter') body.usage = { include: true }
  }
  return {
    url: adapter.chatUrl(provider.baseUrl),
    headers: adapter.headers(provider, signature),
    body,
    kind,
    ...(support.notes.length ? { notes: support.notes } : {})
  }
}

export interface AutoTitleDeps {
  settings(): AutoTitleSettings
  chat(id: string): Chat | null
  provider(id: string): Provider | null
  /** Índice compacto das memórias ativas do chat (null = memória desligada/vazia). */
  memory(chat: Chat): string | null
  /** Grava o título (e avisa a UI). */
  setTitle(chatId: string, title: string): void
  /** Guarda o registro (custo/modelo) na meta da mensagem de origem. */
  record(messageId: string, rec: AutoTitleRecord): void
  stream?: typeof streamChat
  log?(msg: string): void
  timeoutMs?: number
  now?(): number
}

export interface AutoTitleJob {
  chatId: string
  /** Texto digitado da 1ª mensagem e nomes dos anexos/skills. */
  text: string
  attachments?: string[]
  /** Título no momento do pedido: só troca se o chat ainda tiver este título. */
  expectTitle: string
  /** Mensagem de origem (o registro vai na meta dela). */
  messageId?: string | null
  trigger: AutoTitleRecord['trigger']
  signal?: AbortSignal
}

export type AutoTitleOutcome =
  | { status: 'skipped'; reason: 'no-model' }
  | { status: 'applied'; title: string; record: AutoTitleRecord }
  | { status: 'kept'; reason: 'renamed' | 'gone'; title: string; record: AutoTitleRecord }
  | { status: 'error'; error: string }

/**
 * Gera o título e aplica (compare-and-set contra `expectTitle`). NUNCA lança: erro HTTP/rede,
 * tempo esgotado, resposta vazia ou genérica → `{status:'error'}` e o título fica como está.
 * Sem modelo → nenhuma chamada.
 */
export async function runAutoTitle(
  job: AutoTitleJob,
  deps: AutoTitleDeps
): Promise<AutoTitleOutcome> {
  const log = (m: string): void => (deps.log ?? ((x) => console.log(`[clearchat] ${x}`)))(m)
  const now = deps.now ?? Date.now
  const s = deps.settings()
  if (!autoTitleEnabled(s)) return { status: 'skipped', reason: 'no-model' }
  const fail = (error: string): AutoTitleOutcome => {
    log(`título automático (${job.trigger}) não gerado: ${error}`)
    return { status: 'error', error }
  }
  const t0 = now()
  const chat = deps.chat(job.chatId)
  if (!chat) return fail('chat não encontrado.')
  const provider = deps.provider(s.providerId!)
  if (!provider) return fail('o provedor do modelo do título não existe mais.')
  let memory: string | null = null
  if (s.useMemory) {
    try {
      memory = deps.memory(chat)
    } catch (e) {
      log(`título automático: memórias indisponíveis (${(e as Error).message})`)
    }
  }
  let req: BuiltRequest
  try {
    req = buildAutoTitleRequest({
      settings: s,
      provider,
      chatConfig: chat.config,
      text: job.text,
      attachments: job.attachments,
      memory
    })
  } catch (e) {
    return fail((e as Error).message || String(e))
  }
  const timeoutMs = deps.timeoutMs ?? AUTO_TITLE_DEFAULTS.timeoutMs
  const timeout = new AbortController()
  const timer = setTimeout(() => timeout.abort(), timeoutMs)
  const signal = job.signal ? AbortSignal.any([job.signal, timeout.signal]) : timeout.signal
  const acc = newAccumulator()
  try {
    await (deps.stream ?? streamChat)(req, signal, acc, () => {})
  } catch (e) {
    const msg = timeout.signal.aborted
      ? `sem resposta em ${Math.round(timeoutMs / 1000)}s.`
      : (e as Error).message || String(e)
    if (acc.usage) log(`título automático: chamada com erro custou ${acc.usage.cost ?? '?'}`)
    return fail(msg)
  } finally {
    clearTimeout(timer)
  }
  const title = sanitizeTitle(acc.content)
  if (!title) {
    const raw = acc.content.trim().replace(/\s+/g, ' ').slice(0, 120)
    return fail(
      raw
        ? `resposta inútil ("${raw}").`
        : `resposta vazia${acc.reasoning ? ' (só raciocínio)' : ''}.`
    )
  }
  const record: AutoTitleRecord = {
    title,
    applied: false,
    trigger: job.trigger,
    providerId: provider.id,
    model: s.model!,
    ...(acc.usage ? { usage: acc.usage } : {}),
    durationMs: now() - t0,
    at: now()
  }
  // compare-and-set: leitura + escrita síncronas (nenhum handler roda no meio)
  const cur = deps.chat(job.chatId)
  let outcome: AutoTitleOutcome
  if (!cur) outcome = { status: 'kept', reason: 'gone', title, record }
  else if (cur.title !== job.expectTitle) {
    log(`título automático "${title}" descartado: o chat foi renomeado para "${cur.title}".`)
    outcome = { status: 'kept', reason: 'renamed', title, record }
  } else {
    record.applied = true
    if (title !== cur.title) deps.setTitle(job.chatId, title)
    outcome = { status: 'applied', title, record }
  }
  if (job.messageId && cur) {
    try {
      deps.record(job.messageId, record)
    } catch (e) {
      log(`título automático: registro não gravado (${(e as Error).message})`)
    }
  }
  const cost = record.usage?.cost
  log(
    `título automático (${job.trigger}, ${s.model}): "${title}"${record.applied ? '' : ' (não aplicado)'}` +
      `${cost != null ? ` · $${cost}` : ''} · ${record.durationMs}ms`
  )
  return outcome
}
