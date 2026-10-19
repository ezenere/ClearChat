// Ramificação na UI — funções PURAS sobre src/shared/branches.ts (testadas em e2e/branchView.test.ts):
// caminho ativo + irmãos (‹ i/n ›), grupo de versões de uma mensagem, onde fica o "Regenerar" de cada
// turno, o erro do último turno (regenerar = substituir) e os subagentes em segundo plano que
// impedem trocar de versão / serão parados ao criar uma versão.
import {
  activePath,
  buildTree,
  isPromptMessage,
  pathSiblings,
  selKey,
  type BranchSel,
  type MessageTree,
  type SiblingInfo
} from '@shared/branches'
import { isDisplayOnly } from '@shared/context'
import type { StoredMessage } from '@shared/types'

export interface BranchView {
  tree: MessageTree<StoredMessage>
  /** Caminho ativo (o que aparece e o que o agente vê), da raiz à folha. */
  path: StoredMessage[]
  /** Irmãos das mensagens do caminho que têm MAIS de uma versão. */
  siblings: Map<string, SiblingInfo>
}

export function branchView(
  messages: readonly StoredMessage[],
  sel: BranchSel | null | undefined
): BranchView {
  const tree = buildTree(messages)
  const path = activePath(tree, sel)
  return { tree, path, siblings: pathSiblings(tree, path) }
}

/** Chave do grupo de versões de `msgId` (= chave da seleção: id do pai ou "root"). */
export function branchGroup(tree: MessageTree<StoredMessage>, msgId: string): string {
  return selKey(tree.parentOf.get(msgId) ?? null)
}

/**
 * Onde fica o "Regenerar resposta": a ÚLTIMA mensagem do assistente (não só de exibição) da
 * resposta de cada turno do caminho. Mensagens antes do primeiro prompt não contam.
 */
export function regenerateTargets(path: readonly StoredMessage[]): Set<string> {
  const out = new Set<string>()
  let inTurn = false
  let last: string | null = null
  for (const m of path) {
    if (isPromptMessage(m)) {
      if (last) out.add(last)
      inTurn = true
      last = null
      continue
    }
    if (inTurn && m.message.role === 'assistant' && !isDisplayOnly(m.meta)) last = m.id
  }
  if (last) out.add(last)
  return out
}

/**
 * Erro persistido que fecha o caminho (ignorando cards de extração de memória depois dele): é onde
 * aparecem "Tentar de novo" (regenerar = substituir, se a resposta só tem erros) e "Compactar e
 * tentar de novo". null = o caminho não termina num erro.
 */
export function trailingErrorId(path: readonly StoredMessage[]): string | null {
  for (let i = path.length - 1; i >= 0; i--) {
    const k = path[i].meta.kind
    if (k === 'memory-extraction') continue
    return k === 'error' ? path[i].id : null
  }
  return null
}

/**
 * Subagentes em segundo plano ainda rodando cuja tool call de origem está ABAIXO de `forkParent`
 * (qualquer ramo; `null` = raiz → todos). Trocar a versão desse ponto é recusado enquanto houver
 * algum; criar uma versão nova ali os para (sem callback). `busyCalls` = parentToolCallId das
 * subsessões ocupadas desta sessão.
 */
export function subagentsBelow(
  tree: MessageTree<StoredMessage>,
  forkParent: string | null,
  busyCalls: readonly string[]
): number {
  if (!busyCalls.length) return 0
  const wanted = new Set(busyCalls)
  const origin = new Map<string, string>()
  for (const m of tree.ordered)
    if (m.message.role === 'assistant')
      for (const tc of m.message.tool_calls ?? []) if (wanted.has(tc.id)) origin.set(tc.id, m.id)
  let n = 0
  for (const call of busyCalls) {
    const at = origin.get(call)
    if (!at) continue
    if (forkParent === null) {
      n++
      continue
    }
    // sobe do card de origem até a raiz procurando o ponto da bifurcação
    let cur = tree.parentOf.get(at) ?? null
    while (cur !== null && cur !== forkParent) cur = tree.parentOf.get(cur) ?? null
    if (cur === forkParent) n++
  }
  return n
}

/** "Versão 2 de 3" (aria-label do ‹ i/n ›). */
export const versionLabel = (s: Pick<SiblingInfo, 'index' | 'count'>): string =>
  `Versão ${s.index + 1} de ${s.count}`
