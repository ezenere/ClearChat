// Onde cada pendência (aprovação / falha de subagente) aparece no chat aberto: no card que a
// "hospeda" na conversa vista (o próprio card da tool, ou o card "Delegar a subagente" do ancestral
// que é filho direto da sessão vista) quando esse card está VISÍVEL no scroll; senão, na fila acima
// do composer. Ver SPEC.md → "Aprovações → UI → Fila acima do composer".
import type { ApprovalRequest, Session } from '@shared/types'

/** Visibilidade dos cards-âncora montados: true/false = medido; null = montado, ainda sem medida. */
export type AnchorVis = Record<string, boolean | null>

export const anchorId = (sessionId: string, toolCallId: string): string =>
  `${sessionId}:${toolCallId}`

/**
 * Card da sessão vista que hospeda as pendências de `sessionId`: mesma sessão → o card da própria
 * tool call (`toolCallId`); descendente → o card do delegate_task que criou o ancestral filho direto
 * da sessão vista. Fora da subárvore da sessão vista → null (sempre na fila).
 */
export function anchorFor(
  sessionId: string,
  toolCallId: string | null,
  viewSessionId: string,
  sessions: Record<string, Session>
): string | null {
  if (sessionId === viewSessionId) return toolCallId ? anchorId(viewSessionId, toolCallId) : null
  let cur: Session | undefined = sessions[sessionId]
  for (let i = 0; cur && i < 6; i++) {
    if (cur.parentSessionId === viewSessionId)
      return cur.parentToolCallId ? anchorId(viewSessionId, cur.parentToolCallId) : null
    cur = cur.parentSessionId ? sessions[cur.parentSessionId] : undefined
  }
  return null
}

/**
 * O card-âncora está na tela? Montado e ainda não medido conta como visível (evita piscar na fila
 * quando a aprovação chega junto com o card); desmontado (ex.: mensagens compactadas ocultas) = não.
 */
export function isAnchorShown(vis: AnchorVis, key: string | null): boolean {
  return key !== null && key in vis && vis[key] !== false
}

/** Aprovações do chat que vão para a fila acima do composer (âncora fora da tela), mais antiga primeiro. */
export function queuedApprovals(
  approvals: ApprovalRequest[],
  chatId: string,
  viewSessionId: string,
  sessions: Record<string, Session>,
  vis: AnchorVis
): ApprovalRequest[] {
  return approvals
    .filter(
      (a) =>
        a.chatId === chatId &&
        !isAnchorShown(vis, anchorFor(a.sessionId, a.toolCallId, viewSessionId, sessions))
    )
    .sort((a, b) => a.createdAt - b.createdAt)
}

/** Primeira linha do erro, encurtada (aviso compacto / tooltip). */
export function shortFailure(error: string | undefined, max = 140): string {
  const line = (error ?? '').split('\n').find((l) => l.trim()) ?? ''
  const t = line.trim()
  return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t || 'erro desconhecido'
}

/**
 * Observa os cards-âncora de uma lista de mensagens (IntersectionObserver com o scroller como raiz).
 * Os cards podem se registrar antes do scroller existir (efeitos dos filhos rodam antes): ficam
 * guardados e são observados no `attach`.
 */
export class AnchorTracker {
  private io: IntersectionObserver | null = null
  private els = new Map<Element, string>()
  private onChange: (patch: Record<string, boolean | null | undefined>) => void
  constructor(onChange: (patch: Record<string, boolean | null | undefined>) => void) {
    this.onChange = onChange
  }

  attach(root: Element): void {
    this.detach()
    this.io = new IntersectionObserver(
      (entries) => {
        const patch: Record<string, boolean> = {}
        for (const e of entries) {
          const id = this.els.get(e.target)
          if (id) patch[id] = e.isIntersecting
        }
        if (Object.keys(patch).length) this.onChange(patch)
      },
      // precisa de uma faixa mínima do card na tela (não só 1px na borda)
      { root, rootMargin: '-24px 0px -24px 0px', threshold: 0 }
    )
    for (const el of this.els.keys()) this.io.observe(el)
  }

  detach(): void {
    this.io?.disconnect()
    this.io = null
  }

  add(el: Element, id: string): void {
    this.els.set(el, id)
    this.onChange({ [id]: null })
    this.io?.observe(el)
  }

  remove(el: Element): void {
    const id = this.els.get(el)
    this.els.delete(el)
    this.io?.unobserve(el)
    if (id) this.onChange({ [id]: undefined })
  }
}
