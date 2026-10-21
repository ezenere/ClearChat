// Resultado do gate de aprovação de uma chamada já respondida (meta da mensagem tool), para o card
// da tool: APROVADA → sem faixa extra, os detalhes ficam no selo de status ("ok") do card (tooltip
// fixável); NEGADA/BLOQUEADA → uma faixa compacta visível (o usuário precisa ver por que não rodou).
// Puro (sem React): testado em e2e/smartApprove.test.ts.
import type { MessageMeta } from '@shared/types'

export type ApprovedBy = 'user' | 'lists' | 'smart' | 'readonly' | 'edits'

export interface OutcomeItem {
  text: string
  /** Quem decidiu este item. */
  by: ApprovedBy | 'denied' | 'blocked'
  /** Entrada da whitelist/blacklist que casou, ou "Executar mesmo assim". */
  detail?: string
}

export interface ApprovalOutcome {
  kind: 'approved' | 'denied'
  /** Aprovada: quem liberou (na ordem: você, lista, Smart-Approve). */
  by: ApprovedBy[]
  /** Negada: o que negou. */
  deniedBy?: 'user' | 'blacklist' | 'smart'
  title: string
  /** Negada: o motivo (sub-comando negado, entrada da blacklist, motivo do juiz). */
  reason?: string
  items: OutcomeItem[]
  /** Perguntou por tocar um caminho protegido. */
  protectedPath?: string
}

const BY_TEXT: Record<ApprovedBy, string> = {
  user: 'por você',
  lists: 'pela lista',
  smart: 'pelo Smart-Approve',
  readonly: 'como leitura (sempre liberada)',
  edits: 'por “Aceitar edições dentro da raiz”'
}

/** "Aprovado pela lista e pelo Smart-Approve". */
export function approvedTitle(by: ApprovedBy[]): string {
  const parts = by.map((b) => BY_TEXT[b])
  const joined =
    parts.length > 1 ? `${parts.slice(0, -1).join(', ')} e ${parts[parts.length - 1]}` : parts[0]
  return `Aprovado ${joined ?? ''}`.trim()
}

/**
 * O que mostrar para uma chamada respondida. null = nada (modo "Sempre permitir", tool sem gate,
 * chamada cancelada antes de qualquer decisão).
 */
export function approvalOutcome(meta: MessageMeta | null | undefined): ApprovalOutcome | null {
  if (!meta) return null
  const rec = meta.approval
  const sa = meta.smartApprove
  const status = meta.toolStatus
  if (rec?.blocked)
    return {
      kind: 'denied',
      by: [],
      deniedBy: 'blacklist',
      title: 'Bloqueado pela blacklist',
      reason: `“${rec.blocked.entry}” casou com ${rec.blocked.text}`,
      items: [{ text: rec.blocked.text, by: 'blocked', detail: rec.blocked.entry }]
    }
  if (sa?.decision === 'reject')
    return {
      kind: 'denied',
      by: [],
      deniedBy: 'smart',
      title: 'Negado pelo Smart-Approve',
      reason: sa.reason || 'sem motivo informado',
      items: []
    }
  const items: OutcomeItem[] = []
  const ro = new Set(rec?.readOnly ?? [])
  for (const t of rec?.readOnly ?? []) items.push({ text: t, by: 'readonly' })
  for (const a of rec?.allowed ?? [])
    if (!ro.has(a.text)) items.push({ text: a.text, by: 'lists', detail: a.entry })
  for (const t of rec?.judgeAllowed ?? []) items.push({ text: t, by: 'smart' })
  for (const t of rec?.userAllowed ?? []) items.push({ text: t, by: 'user' })
  const prot = rec?.protectedPath ? { protectedPath: rec.protectedPath } : {}
  if (rec?.denied || (status === 'denied' && (rec || sa))) {
    if (rec?.denied) items.push({ text: rec.denied, by: 'denied' })
    return {
      kind: 'denied',
      by: [],
      deniedBy: 'user',
      title: 'Negado por você',
      ...(rec?.denied ? { reason: rec.denied } : {}),
      items,
      ...prot
    }
  }
  if (status === 'denied' || status === 'cancelled') return null
  const by: ApprovedBy[] = []
  if (rec?.userAllowed?.length || meta.smartOverride) by.push('user')
  if (rec?.allowed?.some((a) => !ro.has(a.text))) by.push('lists')
  if (rec?.readOnly?.length) by.push('readonly')
  if (rec?.acceptEdits) {
    by.push('edits')
    items.push({ text: 'esta edição', by: 'edits' })
  }
  if (sa?.decision === 'approve' || rec?.judgeAllowed?.length) by.push('smart')
  // registros antigos: o juiz pediu e a chamada rodou → você permitiu
  if (!by.length && sa?.decision === 'ask') by.push('user')
  if (meta.smartOverride)
    items.push({ text: 'esta chamada', by: 'user', detail: 'Executar mesmo assim' })
  if (!by.length) return null
  return { kind: 'approved', by, title: approvedTitle(by), items, ...prot }
}
