// Gasto do chat até agora (botão ao lado do medidor de contexto no composer). Soma SÓ o que a API
// informou (`usage` de cada chamada); chamada sem `cost` conta os tokens e entra como "custo
// desconhecido". Puro — testes em e2e/chatUi.test.ts.
//
// Fontes (ver SPEC → UI → Gasto do chat):
//  - Respostas: mensagens `assistant` da sessão principal (meta.usage), todos os ramos;
//  - Subagentes: idem nas subsessões (depth > 0), somadas e por subagente;
//  - Smart-Approve: meta.smartApprove.usage das mensagens tool (todas as sessões);
//  - Coleta de contexto: chat.config.capturedContext (main + sessions) — `calls`/`cost` acumulados;
//  - Título automático: meta.autoTitle.usage;
//  - Compactação: meta.compactUsage (kind 'compaction'); extração de memória: meta.memoryExtraction.usage.
import type { Chat, CapturedEntry, Session, StoredMessage, Usage } from '@shared/types'

export interface SpendTotals {
  /** Chamadas contadas. */
  calls: number
  /** Entrada sem cache (promptTokens − lidos do cache − escrita de cache). */
  input: number
  /** Entrada lida do cache. */
  cacheRead: number
  /** Entrada gravada no cache. */
  cacheWrite: number
  /** Saída (completionTokens; inclui o raciocínio). */
  output: number
  /** Dos quais raciocínio (quando o provedor informa). */
  reasoning: number
  /** Soma dos custos informados. */
  cost: number
  /** Chamadas com custo informado (calls − costed = custo desconhecido). */
  costed: number
  /** false quando a fonte não guarda os tokens de cada chamada (coleta de contexto). */
  tokensKnown: boolean
}

export interface SubagentSpend {
  sessionId: string
  label: string
  model: string
  depth: number
  totals: SpendTotals
}

export interface ChatSpend {
  main: SpendTotals
  subagents: SpendTotals
  perSubagent: SubagentSpend[]
  judge: SpendTotals
  capture: SpendTotals
  title: SpendTotals
  compaction: SpendTotals
  memory: SpendTotals
  total: { cost: number; calls: number; unknown: number }
  /** Subsessões cujas mensagens ainda não foram carregadas (o total pode subir). */
  missingSessions: number
}

export const emptyTotals = (tokensKnown = true): SpendTotals => ({
  calls: 0,
  input: 0,
  cacheRead: 0,
  cacheWrite: 0,
  output: 0,
  reasoning: 0,
  cost: 0,
  costed: 0,
  tokensKnown
})

const n = (v: number | undefined): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/** Soma uma chamada (usage ausente = chamada sem tokens nem custo conhecidos). */
export function addUsage(t: SpendTotals, u: Usage | undefined): void {
  t.calls++
  if (!u) return
  const cacheRead = n(u.cachedTokens)
  const cacheWrite = n(u.cacheWriteTokens)
  t.input += Math.max(0, n(u.promptTokens) - cacheRead - cacheWrite)
  t.cacheRead += cacheRead
  t.cacheWrite += cacheWrite
  t.output += n(u.completionTokens)
  t.reasoning += n(u.reasoningTokens)
  if (typeof u.cost === 'number' && Number.isFinite(u.cost)) {
    t.cost += u.cost
    t.costed++
  }
}

function addTotals(into: SpendTotals, t: SpendTotals): void {
  into.calls += t.calls
  into.input += t.input
  into.cacheRead += t.cacheRead
  into.cacheWrite += t.cacheWrite
  into.output += t.output
  into.reasoning += t.reasoning
  into.cost += t.cost
  into.costed += t.costed
}

/** Resposta do modelo (não as sintéticas/de exibição — essas não são chamadas à API). */
function isModelReply(m: StoredMessage): boolean {
  return (
    m.message.role === 'assistant' &&
    !m.meta.synthetic &&
    !m.meta.kind &&
    (!!m.meta.usage || !!m.meta.model)
  )
}

/** Entrada do resumidor: só `calls`/`cost` acumulados (os tokens ficam só na última chamada). */
function addCapture(t: SpendTotals, e: CapturedEntry | undefined): void {
  if (!e) return
  const calls = e.calls ?? (e.lastRun ? 1 : 0)
  if (!calls) return
  t.calls += calls
  // `cost` acumula 0 quando o provedor não informa: só conta como conhecido se houve custo de fato
  // ou se a última chamada trouxe `usage.cost`
  const known = typeof e.cost === 'number' && (e.cost > 0 || e.lastRun?.usage?.cost != null)
  if (known) {
    t.cost += e.cost!
    t.costed += calls
  }
}

export function computeChatSpend(
  chat: Chat,
  sessions: Session[],
  messages: Record<string, StoredMessage[] | undefined>
): ChatSpend {
  const out: ChatSpend = {
    main: emptyTotals(),
    subagents: emptyTotals(),
    perSubagent: [],
    judge: emptyTotals(),
    capture: emptyTotals(false),
    title: emptyTotals(),
    compaction: emptyTotals(),
    memory: emptyTotals(),
    total: { cost: 0, calls: 0, unknown: 0 },
    missingSessions: 0
  }
  const own = sessions
    .filter((s) => s.chatId === chat.id)
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
  for (const s of own) {
    const isMain = s.id === chat.mainSessionId
    const list = messages[s.id]
    if (!list) {
      if (!isMain) out.missingSessions++
      continue
    }
    const replies = isMain ? out.main : emptyTotals()
    for (const m of list) {
      if (isModelReply(m)) addUsage(replies, m.meta.usage)
      const sa = m.meta.smartApprove
      // falha de request (HTTP/rede) sem usage: o provedor recusou, nada a cobrar
      if (sa && !(sa.fallback === 'error' && !sa.usage)) addUsage(out.judge, sa.usage)
      if (m.meta.autoTitle) addUsage(out.title, m.meta.autoTitle.usage)
      if (m.meta.kind === 'compaction' && m.meta.compactUsage)
        addUsage(out.compaction, m.meta.compactUsage)
      if (
        m.meta.memoryExtraction &&
        (m.meta.memoryExtraction.usage || m.meta.memoryExtraction.model)
      )
        addUsage(out.memory, m.meta.memoryExtraction.usage)
    }
    if (!isMain) {
      addTotals(out.subagents, replies)
      out.perSubagent.push({
        sessionId: s.id,
        label: s.title || 'Subagente',
        model: s.model,
        depth: s.depth,
        totals: replies
      })
    }
  }
  const cc = chat.config.capturedContext
  addCapture(out.capture, cc?.main)
  for (const e of Object.values(cc?.sessions ?? {})) addCapture(out.capture, e)
  for (const t of [
    out.main,
    out.subagents,
    out.judge,
    out.capture,
    out.title,
    out.compaction,
    out.memory
  ]) {
    out.total.cost += t.cost
    out.total.calls += t.calls
    out.total.unknown += t.calls - t.costed
  }
  return out
}

/** Valor em dólar no formato pt-BR: $0,00 · <$0,0001 · $0,0042 · $0,42 · $1.234,56. */
export function formatUsd(cost: number): string {
  if (!Number.isFinite(cost) || cost <= 0) return '$0,00'
  if (cost < 0.0001) return '<$0,0001'
  if (cost < 0.01) return `$${cost.toFixed(4).replace('.', ',')}`
  const [int, dec] = cost.toFixed(2).split('.')
  return `$${int.replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${dec}`
}

/** Inteiro com separador de milhar pt-BR (12.345). */
export function formatIntPt(v: number): string {
  return String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, '.')
}
