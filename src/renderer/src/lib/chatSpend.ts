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
//  - Chamadas de voz: as respostas dos turnos da chamada (meta.voice.source 'call') saem de
//    "Respostas" e entram AQUI (nunca contadas duas vezes), com STT/TTS/tempos dos marcadores de
//    fim (meta.voiceCall). A voz estimada pelo preço de lista (≈) fica FORA do total.
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

/** Chamadas de voz do chat (marcadores + respostas dos turnos de voz). */
export interface VoiceSpend {
  /** Chamadas (ids distintos nos marcadores). */
  calls: number
  /** Chamadas sem marcador de fim (em andamento). */
  open: number
  durationMs: number
  userSpeechMs: number
  ttsAudioMs: number
  /** Respostas do modelo nos turnos da chamada (fora de `main`). */
  llm: SpendTotals
  stt: {
    apiRequests: number
    audioMs: number
    cost: number
    costedRequests: number
    /** Chamadas com transcrição local/GPU (grátis). */
    localCalls: number
  }
  tts: {
    chars: number
    /** Custo informado/calculado sem estimativa (entra no total). */
    cost: number
    /** Custo ≈ pelo preço de lista (fora do total). */
    estimated: number
    /** Caracteres na ElevenLabs direta (créditos). */
    elevenChars: number
    localCalls: number
    /** Chamadas por API sem preço conhecido. */
    unknownCalls: number
  }
  /** Custo que entra no total (LLM + STT informado + voz não estimada). */
  cost: number
}

export interface ChatSpend {
  main: SpendTotals
  voice: VoiceSpend
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

export const emptyVoiceSpend = (): VoiceSpend => ({
  calls: 0,
  open: 0,
  durationMs: 0,
  userSpeechMs: 0,
  ttsAudioMs: 0,
  llm: emptyTotals(),
  stt: { apiRequests: 0, audioMs: 0, cost: 0, costedRequests: 0, localCalls: 0 },
  tts: { chars: 0, cost: 0, estimated: 0, elevenChars: 0, localCalls: 0, unknownCalls: 0 },
  cost: 0
})

/** Soma o marcador de fim de uma chamada (STT/TTS/tempos — o LLM vem das respostas). */
function addCallEnd(v: VoiceSpend, m: StoredMessage): void {
  const mark = m.meta.voiceCall
  if (!mark || mark.phase !== 'end') return
  v.durationMs += n(mark.durationMs)
  const u = mark.usage
  if (!u) return
  v.userSpeechMs += n(u.userSpeechMs)
  v.ttsAudioMs += n(u.tts.audioMs)
  if (u.stt.mode === 'local' || u.stt.mode === 'gpu' || (!u.stt.apiRequests && u.stt.localRequests))
    v.stt.localCalls++
  v.stt.apiRequests += n(u.stt.apiRequests)
  v.stt.audioMs += n(u.stt.apiAudioMs)
  v.stt.cost += n(u.stt.cost)
  v.stt.costedRequests += n(u.stt.costedRequests)
  if (u.tts.backend === 'local' || u.tts.backend === 'gpu') v.tts.localCalls++
  else if (u.tts.backend === 'elevenlabs') v.tts.elevenChars += n(u.tts.chars)
  else if (u.tts.cost == null) v.tts.unknownCalls++
  v.tts.chars += n(u.tts.chars)
  if (u.tts.estimated) v.tts.estimated += n(u.tts.cost)
  else v.tts.cost += n(u.tts.cost)
}

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
    voice: emptyVoiceSpend(),
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
    const callIds = new Set<string>()
    const ended = new Set<string>()
    for (const m of list) {
      if (isModelReply(m)) {
        // turno da chamada de voz: vai para "Chamadas de voz" (não soma em "Respostas")
        if (isMain && m.meta.voice?.source === 'call') addUsage(out.voice.llm, m.meta.usage)
        else addUsage(replies, m.meta.usage)
      }
      if (m.meta.kind === 'voice-call' && m.meta.voiceCall) {
        callIds.add(m.meta.voiceCall.callId)
        if (m.meta.voiceCall.phase === 'end' && !ended.has(m.meta.voiceCall.callId)) {
          ended.add(m.meta.voiceCall.callId)
          addCallEnd(out.voice, m)
        }
      }
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
    out.voice.calls += callIds.size
    out.voice.open += [...callIds].filter((id) => !ended.has(id)).length
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
  const v = out.voice
  v.cost = v.llm.cost + v.stt.cost + v.tts.cost
  // custo da voz/transcrição informado entra no total; as respostas contam como chamadas
  out.total.cost += v.stt.cost + v.tts.cost
  for (const t of [
    out.main,
    v.llm,
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
