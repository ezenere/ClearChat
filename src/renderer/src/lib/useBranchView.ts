import { useMemo } from 'react'
import type { BranchSel } from '@shared/branches'
import type { Session, StoredMessage } from '@shared/types'
import { branchView, type BranchView } from './branchView'

export type { BranchView }

/**
 * Caminho ativo + irmãos da sessão (memoizado). `override` = seleção só desta tela (views só de
 * leitura: host offline, divergência); senão vale a `branchSel` sincronizada da sessão.
 */
export function useBranchView(
  session: Pick<Session, 'branchSel'> | null | undefined,
  messages: readonly StoredMessage[],
  override?: BranchSel | null
): BranchView {
  const sel = override ?? session?.branchSel
  return useMemo(() => branchView(messages, sel), [messages, sel])
}
