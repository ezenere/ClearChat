// Smart-Approve → coleta automática de contexto (resumidor) no main. Regras puras em
// @shared/contextCapture; aqui ficam o agendamento, as chamadas ao modelo e a gravação.
//
// - Mensagem nova do usuário (digitada; no subagente também a do agente pai) persistida →
//   `onUserMessage`: só se o resumidor estiver ativo no chat (ligado + modelo + algum item em
//   Smart-Approve com juiz); cancela o resumo em andamento da sessão (o cursor não avançou, então o
//   próximo cobre tudo) e agenda um novo depois de `debounceMs` (mensagens seguidas = 1 chamada).
// - Nunca bloqueia o agente: tudo em segundo plano; falha/timeout → mantém a descrição e o cursor.
// - O juiz espera (`waitIdle`, teto `judgeWaitMs`) o resumo da sessão antes de julgar.
// - Parar (`cancel`/`cancelChat`): aborta o resumo em andamento e o agendado; nada mais roda até a
//   próxima mensagem do usuário. Cancelado = descrição e cursor intactos.
// - Subagente criado (`deriveForSubagent`): descrição do pai + a tarefa (concatenada na hora; com o
//   modelo, refeita em segundo plano).
// - Prompts: os personalizados do chat/persona ou os globais (`capturePrompts`); template sem
//   {{current}}/{{user}} → o padrão. A trava "só o que o usuário disse" (applyCapture) vale sempre.
// Sem Electron (testável): as dependências entram por `CaptureDeps`.
import {
  applyCapture,
  applyDerive,
  buildCaptureMessages,
  buildDeriveMessages,
  captureActive,
  capturedTextFor,
  CONTEXT_CAPTURE_LIMITS,
  deriveConcat,
  effectiveCapture,
  effectiveCapturePrompts,
  entryFor,
  nextEntry,
  resolveCapturePrompts,
  selectionTexts,
  selectPending,
  undoEntry,
  withEntry
} from '@shared/contextCapture'
import type {
  ApprovalItem,
  ApprovalMode,
  CapturedContextState,
  CapturedEntry,
  Chat,
  Provider,
  Session,
  SmartApproveDefaults,
  StoredMessage,
  Usage
} from '@shared/types'
import { newAccumulator, streamChat } from './llm'
import type { BuiltRequest } from './request'
import { buildSideRequest } from './smartApprove'

export interface CaptureDeps {
  getChat(chatId: string): Chat | null
  getSession(id: string): Session | null
  /** Caminho ativo da sessão. */
  history(sessionId: string): StoredMessage[]
  getProvider(id: string): Provider | null
  globalModes(): Partial<Record<ApprovalItem, ApprovalMode>>
  defaults(): SmartApproveDefaults
  /** Lê-modifica-grava o estado (síncrono) e avisa a UI. */
  save(chatId: string, fn: (st: CapturedContextState | undefined) => CapturedContextState): void
  /** Chamada ao modelo (padrão: streaming acumulado). */
  call?(req: BuiltRequest, signal: AbortSignal): Promise<{ content: string; usage?: Usage }>
  now?(): number
  debounceMs?: number
  judgeWaitMs?: number
  timeoutMs?: number
  log?(...a: unknown[]): void
}

async function defaultCall(
  req: BuiltRequest,
  signal: AbortSignal
): Promise<{ content: string; usage?: Usage }> {
  const acc = newAccumulator()
  await streamChat(req, signal, acc, () => {})
  return { content: acc.content, ...(acc.usage ? { usage: acc.usage } : {}) }
}

export class ContextCaptureService {
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  private runs = new Map<string, { ctrl: AbortController; done: Promise<void> }>()
  private chatOf = new Map<string, string>()
  private d: CaptureDeps

  constructor(deps: CaptureDeps) {
    this.d = deps
  }

  private now(): number {
    return this.d.now?.() ?? Date.now()
  }
  private log(...a: unknown[]): void {
    this.d.log?.('[context-capture]', ...a)
  }

  /** Há resumo agendado ou em andamento para a sessão? */
  busy(sessionId: string): boolean {
    return this.timers.has(sessionId) || this.runs.has(sessionId)
  }

  /** Mensagem nova do usuário (ou do agente pai, no subagente) persistida na sessão. */
  onUserMessage(sessionId: string): void {
    const s = this.d.getSession(sessionId)
    const chat = s ? this.d.getChat(s.chatId) : null
    if (!s || !chat) return
    if (!captureActive(chat.config, this.d.globalModes(), this.d.defaults())) return
    // nova mensagem durante um resumo: cancela (o cursor não avançou) e recomeça cobrindo tudo
    this.abortRun(sessionId)
    this.clearTimer(sessionId)
    this.chatOf.set(sessionId, s.chatId)
    const ms = this.d.debounceMs ?? CONTEXT_CAPTURE_LIMITS.debounceMs
    this.timers.set(
      sessionId,
      setTimeout(() => {
        this.timers.delete(sessionId)
        this.start(sessionId, (signal) => this.process(sessionId, signal))
      }, ms)
    )
  }

  /** Parar: aborta o resumo agendado/em andamento da sessão (descrição e cursor intactos). */
  cancel(sessionId: string): void {
    this.clearTimer(sessionId)
    this.abortRun(sessionId)
  }

  /** Parar o chat inteiro (todas as sessões). */
  cancelChat(chatId: string): void {
    for (const [sid, cid] of this.chatOf) if (cid === chatId) this.cancel(sid)
  }

  /**
   * O juiz espera o resumo da sessão: dispara já o agendado e aguarda o em andamento, no máximo
   * `capMs` (depois julga com a descrição atual — nunca trava, nunca pula o juiz).
   */
  async waitIdle(
    sessionId: string,
    capMs = this.d.judgeWaitMs ?? CONTEXT_CAPTURE_LIMITS.judgeWaitMs
  ): Promise<'idle' | 'done' | 'timeout'> {
    if (this.timers.has(sessionId)) {
      this.clearTimer(sessionId)
      this.start(sessionId, (signal) => this.process(sessionId, signal))
    }
    const r = this.runs.get(sessionId)
    if (!r) return 'idle'
    let timer: ReturnType<typeof setTimeout> | undefined
    const res = await Promise.race([
      r.done.then(() => 'done' as const),
      new Promise<'timeout'>((ok) => {
        timer = setTimeout(() => ok('timeout'), capMs)
      })
    ])
    if (timer) clearTimeout(timer)
    if (res === 'timeout') this.log('juiz não esperou mais o resumo', sessionId, `${capMs}ms`)
    return res
  }

  /**
   * Subagente criado: descrição = a do pai + a tarefa. Grava já a concatenação (cursor na mensagem
   * da tarefa); com o resumidor ativo, refaz com o modelo em segundo plano (o juiz do subagente
   * espera, como no resumo normal). Sem descrição do pai → nada a derivar.
   */
  deriveForSubagent(parent: Session, child: Session, task: string, taskMsg: StoredMessage): void {
    this.chatOf.set(child.id, child.chatId)
    this.start(child.id, async (signal) => {
      // o resumo do pai em andamento (ex.: a mensagem que pediu a delegação) entra antes
      if (this.busy(parent.id)) await this.waitIdle(parent.id)
      if (signal.aborted) return
      const chat = this.d.getChat(child.chatId)
      if (!chat) return
      const st = chat.config.capturedContext
      const parentText = capturedTextFor(
        st,
        parent.depth > 0 ? parent.id : null,
        this.chain(parent)
      )
      const active = captureActive(chat.config, this.d.globalModes(), this.d.defaults())
      const concat = deriveConcat(parentText, task)
      const cursor = { id: taskMsg.id, seq: taskMsg.seq, at: taskMsg.createdAt }
      if (!concat && !active) return
      const now = this.now()
      this.d.save(chat.id, (s) =>
        withEntry(s, child.id, { text: concat, updatedAt: now, by: 'derived', cursor })
      )
      if (!concat || !active) return
      await this.derive(child, parentText, task, signal)
    })
  }

  /** Edição sua da descrição (principal: sessionId null). */
  setText(chatId: string, sessionId: string | null, text: string): void {
    const now = this.now()
    const t = text.replace(/\r/g, '').slice(0, CONTEXT_CAPTURE_LIMITS.maxChars * 2)
    this.d.save(chatId, (st) =>
      withEntry(st, sessionId, nextEntry(entryFor(st, sessionId), t, 'user', now))
    )
  }

  /** Desfaz a última mudança da descrição. */
  undo(chatId: string, sessionId: string | null): void {
    const now = this.now()
    this.d.save(chatId, (st) => {
      const e = undoEntry(entryFor(st, sessionId), now)
      return e ? withEntry(st, sessionId, e) : (st ?? {})
    })
  }

  // ---------------- interno ----------------

  private clearTimer(sessionId: string): void {
    const t = this.timers.get(sessionId)
    if (t) clearTimeout(t)
    this.timers.delete(sessionId)
  }

  private abortRun(sessionId: string): void {
    const r = this.runs.get(sessionId)
    if (r) r.ctrl.abort()
    this.runs.delete(sessionId)
  }

  private start(sessionId: string, fn: (signal: AbortSignal) => Promise<void>): void {
    this.abortRun(sessionId)
    const ctrl = new AbortController()
    const done = fn(ctrl.signal)
      .catch((e) => this.log('falha', sessionId, (e as Error)?.message ?? e))
      .finally(() => {
        if (this.runs.get(sessionId)?.ctrl === ctrl) this.runs.delete(sessionId)
      })
    this.runs.set(sessionId, { ctrl, done })
  }

  /**
   * Prompts personalizados do chat (ou os globais). Template sem placeholder obrigatório → o
   * builder usa o padrão; aqui só fica o registro no log.
   */
  private prompts(chat: Chat): ReturnType<typeof effectiveCapturePrompts> {
    const p = effectiveCapturePrompts(chat.config.smartApprove, this.d.defaults())
    if (resolveCapturePrompts(p).templateFallback)
      this.log('template personalizado sem {{current}}/{{user}} — usando o padrão', chat.id)
    return p
  }

  /** Ids dos subagentes acima (o mais próximo primeiro), até a principal. */
  private chain(s: Session): string[] {
    const out: string[] = []
    let cur: Session | null = s
    for (let i = 0; cur?.parentSessionId && i < 4; i++) {
      const p = this.d.getSession(cur.parentSessionId)
      if (!p || p.depth === 0) break
      out.push(p.id)
      cur = p
    }
    return out
  }

  private async callModel(
    chat: Chat,
    messages: { role: 'system' | 'user'; content: string }[],
    signal: AbortSignal
  ): Promise<
    | { ok: true; content: string; usage?: Usage; providerId: string; model: string; ms: number }
    | { ok: false; error: string; providerId: string; model: string; ms: number }
    | null
  > {
    const cfg = effectiveCapture(chat.config.smartApprove, this.d.defaults())
    const providerId = cfg.providerId ?? ''
    const model = cfg.model ?? ''
    const t0 = this.now()
    const provider = providerId ? this.d.getProvider(providerId) : null
    if (!provider || !model)
      return { ok: false, error: 'O provedor do resumo não existe mais.', providerId, model, ms: 0 }
    const req = buildSideRequest({
      provider,
      model,
      messages,
      maxTokens: cfg.maxTokens ?? CONTEXT_CAPTURE_LIMITS.defaultMaxTokens,
      chatConfig: chat.config
    })
    const timeout = new AbortController()
    const timer = setTimeout(
      () => timeout.abort(),
      this.d.timeoutMs ?? CONTEXT_CAPTURE_LIMITS.timeoutMs
    )
    try {
      const r = await (this.d.call ?? defaultCall)(req, AbortSignal.any([signal, timeout.signal]))
      if (signal.aborted) return null
      return { ok: true, ...r, providerId, model, ms: this.now() - t0 }
    } catch (e) {
      if (signal.aborted) return null
      return {
        ok: false,
        error: timeout.signal.aborted ? 'tempo esgotado' : (e as Error)?.message || String(e),
        providerId,
        model,
        ms: this.now() - t0
      }
    } finally {
      clearTimeout(timer)
    }
  }

  /** Uma rodada do resumidor para a sessão (o que veio depois do cursor). */
  private async process(sessionId: string, signal: AbortSignal): Promise<void> {
    const s = this.d.getSession(sessionId)
    const chat = s ? this.d.getChat(s.chatId) : null
    if (!s || !chat || signal.aborted) return
    if (!captureActive(chat.config, this.d.globalModes(), this.d.defaults())) return
    const sub = s.depth > 0
    const key = sub ? s.id : null
    const st = chat.config.capturedContext
    const entry = entryFor(st, key)
    const cfg = effectiveCapture(chat.config.smartApprove, this.d.defaults())
    const sel = selectPending(this.d.history(s.id), entry?.cursor, cfg.lookback, sub)
    if (!sel) return
    const texts = selectionTexts(sel)
    const current = entry ? entry.text : sub ? capturedTextFor(st, s.id, this.chain(s)) : ''
    const r = await this.callModel(
      chat,
      buildCaptureMessages(current, texts, sub, this.prompts(chat)),
      signal
    )
    if (!r || signal.aborted) return // cancelado: nada muda (nem o cursor)
    const now = this.now()
    if (!r.ok) {
      // falha → mantém a descrição E o cursor (a próxima rodada tenta de novo)
      this.d.save(chat.id, (cur) => {
        const e = entryFor(cur, key) ?? { text: current, updatedAt: now, by: 'model' as const }
        return withEntry(cur, key, {
          ...e,
          lastRun: {
            at: now,
            providerId: r.providerId,
            model: r.model,
            error: r.error,
            durationMs: r.ms
          }
        })
      })
      this.log('erro', sessionId, r.error)
      return
    }
    this.d.save(chat.id, (cur) => {
      const e = entryFor(cur, key)
      // você editou durante a chamada → aplica sobre o seu texto
      const base = e ? e.text : current
      const applied = applyCapture(base, r.content, texts)
      const extra: Partial<CapturedEntry> = {
        cursor: sel.cursor,
        lastRun: {
          at: now,
          providerId: r.providerId,
          model: r.model,
          decision: applied.decision,
          durationMs: r.ms,
          ...(r.usage ? { usage: r.usage } : {}),
          ...(applied.dropped ? { dropped: applied.dropped } : {})
        },
        calls: (e?.calls ?? 0) + 1,
        cost: (e?.cost ?? 0) + (r.usage?.cost ?? 0)
      }
      const next = applied.changed
        ? nextEntry(
            e ?? { text: base, updatedAt: now, by: 'model' },
            applied.text,
            'model',
            now,
            extra
          )
        : { ...(e ?? { text: base, updatedAt: now, by: 'model' as const }), ...extra }
      return withEntry(cur, key, next)
    })
  }

  /** Derivação com modelo da descrição do subagente. */
  private async derive(
    child: Session,
    parentText: string,
    task: string,
    signal: AbortSignal
  ): Promise<void> {
    const chat = this.d.getChat(child.chatId)
    if (!chat) return
    const r = await this.callModel(
      chat,
      buildDeriveMessages(parentText, task, this.prompts(chat)),
      signal
    )
    if (!r || signal.aborted) return
    const now = this.now()
    this.d.save(chat.id, (cur) => {
      const e = entryFor(cur, child.id)
      const text = r.ok ? applyDerive(r.content) : ''
      const lastRun = {
        at: now,
        providerId: r.providerId,
        model: r.model,
        durationMs: r.ms,
        ...(r.ok ? { decision: 'rewrite' as const } : { error: r.error }),
        ...(r.ok && r.usage ? { usage: r.usage } : {})
      }
      const extra: Partial<CapturedEntry> = {
        lastRun,
        calls: (e?.calls ?? 0) + (r.ok ? 1 : 0),
        cost: (e?.cost ?? 0) + (r.ok ? (r.usage?.cost ?? 0) : 0)
      }
      // só substitui a concatenação se você não editou nesse meio-tempo
      const next =
        text && (!e || e.by === 'derived')
          ? nextEntry(e, text, 'model', now, extra)
          : { ...(e ?? { text: '', updatedAt: now, by: 'derived' as const }), ...extra }
      return withEntry(cur, child.id, next)
    })
  }
}
