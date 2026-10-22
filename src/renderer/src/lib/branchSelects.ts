import { buildTree, selectionToReach, selEquals, type BranchSel } from '@shared/branches'
import type { Session, StoredMessage } from '@shared/types'

/** O que a troca de versão precisa do store (injetado: testável sem Electron/zustand). */
export interface BranchSelectStore {
  session(sessionId: string): Session | undefined
  messages(sessionId: string): readonly StoredMessage[] | undefined
  /** Grava a sessão no store (substitui a anterior). */
  put(session: Session): void
  /** `api.agent.selectBranch` (o main grava e devolve a sessão; antes emite `session-updated`). */
  call(messageId: string): Promise<Session>
}

interface Pending {
  /** número da troca mais recente desta sessão */
  latest: number
  /** trocas ainda sem resposta */
  inflight: number
  /** seleção a mostrar enquanto houver troca pendente (a otimista da mais recente) */
  sel?: BranchSel
  /** última seleção que o main mandou (evento ou retorno) — volta para ela se a mais recente falhar */
  server?: BranchSel
}

export interface BranchSelects {
  /** Troca de versão: otimista já; resolve com a confirmação, rejeita (já desfeita) no erro. */
  select(sessionId: string, messageId: string): Promise<void>
  /**
   * Sessão vinda do main (`session-updated`): com troca de versão ainda pendente nessa sessão, a
   * seleção mostrada continua a otimista da mais recente.
   */
  incoming(session: Session): Session
}

/**
 * Troca de versão (‹ i/n ›) no renderer: o caminho muda na hora (otimista) e a confirmação do main
 * chega depois (`session-updated` + retorno da chamada). Trocas rápidas (←/→ seguidos, clique logo
 * depois de outro) se sobrepõem: a confirmação da troca ANTERIOR chega depois do otimista da nova —
 * aplicada como veio, a tela voltaria por um instante à versão antiga (o ‹ › é remontado, perde o
 * foco, e o próximo clique/tecla agiria sobre a versão errada — a escolha nova se perdia). Por isso,
 * enquanto houver troca pendente na sessão, o que chega do main mantém a seleção otimista da mais
 * recente; a resposta da mais recente é a palavra final (o main processa as trocas em ordem, cada
 * uma sobre a seleção gravada pela anterior).
 */
export function createBranchSelects(store: BranchSelectStore): BranchSelects {
  const pending = new Map<string, Pending>()
  let seq = 0

  const keep = (p: Pending, session: Session): Session => {
    p.server = session.branchSel ?? {}
    return p.sel ? { ...session, branchSel: p.sel } : session
  }

  return {
    incoming(session) {
      const p = pending.get(session.id)
      return p ? keep(p, session) : session
    },

    async select(sessionId, messageId) {
      const before = store.session(sessionId)
      const msgs = store.messages(sessionId)
      const optimistic =
        before && msgs ? selectionToReach(buildTree(msgs), before.branchSel, messageId) : undefined
      const n = ++seq
      const p = pending.get(sessionId) ?? { latest: n, inflight: 0 }
      p.latest = n
      p.inflight++
      p.sel = optimistic
      pending.set(sessionId, p)
      if (before && optimistic) store.put({ ...before, branchSel: optimistic })
      try {
        const updated = await store.call(messageId)
        if (!updated?.id) return
        if (p.latest === n) {
          // a mais recente: vale o que o main gravou (e segura respostas atrasadas de antes dela)
          p.sel = p.server = updated.branchSel ?? {}
          store.put(updated)
        } else store.put(keep(p, updated))
      } catch (err) {
        if (p.latest === n) {
          // desfaz só se nada mais mudou a seleção nesse meio-tempo
          const back = p.server ?? before?.branchSel
          const cur = store.session(sessionId)
          if (optimistic && cur && selEquals(cur.branchSel, optimistic))
            store.put({ ...cur, branchSel: back })
          p.sel = undefined
        }
        throw err
      } finally {
        if (--p.inflight <= 0) pending.delete(sessionId)
      }
    }
  }
}
