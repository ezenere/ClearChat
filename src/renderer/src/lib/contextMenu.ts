// Menu de contexto — lado do renderer (SPEC → "Menu de contexto"). O menu é nativo (main); aqui só
// se registra O QUE está sob o clique direito:
//   1. `contextmenu` na janela (fase de captura) abre um registro vazio para este clique;
//   2. os `onContextMenu` dos componentes (bloco de código → mensagem → …, do mais interno para o
//      mais externo) acrescentam as ações que valem agora — o mais interno vence;
//   3. o main pergunta (`ctx:query`) e recebe o descritor: nomes de ações da lista fechada + os
//      textos de cópia (o main grava na área de transferência); o registro vira "pendente";
//   4. ação escolhida que roda aqui (`ctx:action`) → só com o token do clique pendente.
// Quem chama preventDefault() no `contextmenu` (menus próprios, ex.: microfone) não recebe o nativo.
import {
  CTX_APP_ITEMS,
  isCopyAction,
  type AppCtx,
  type CtxAppAction,
  type CtxCopyAction,
  type CtxRunAction
} from '@shared/contextMenu'
import type { ClearApi } from '@shared/ipc'

export interface CtxContribution {
  /** Texto de cada ação de cópia (string ou função avaliada só quando o main pergunta). */
  copy?: Partial<Record<CtxCopyAction, string | (() => string)>>
  /** Ações executadas aqui (as mesmas funções da barra de ações / botões). */
  run?: Partial<Record<CtxRunAction, () => void>>
}

interface Registry {
  copy: Partial<Record<CtxCopyAction, () => string>>
  run: Partial<Record<CtxRunAction, () => void>>
}

let current: Registry | null = null
let pending: { token: number; run: Registry['run'] } | null = null
let nextToken = 1

/** Alvo dentro de um campo editável: as ações do app não entram (o editor fica dentro do balão). */
export function isEditableTarget(t: unknown): boolean {
  const el = t as { closest?: (sel: string) => unknown } | null
  return !!el?.closest?.(
    'input, textarea, select, [contenteditable]:not([contenteditable="false"])'
  )
}

/** Início de um clique direito (o listener de captura chama). */
export function beginCtx(): void {
  current = { copy: {}, run: {} }
}

/** `onContextMenu` de um componente: acrescenta as ações deste nível (as já registradas ficam). */
export function contributeCtx(e: { target: unknown }, c: CtxContribution): void {
  if (!current || isEditableTarget(e.target)) return
  for (const [k, v] of Object.entries(c.copy ?? {}) as [CtxCopyAction, string | (() => string)][]) {
    if (v == null || current.copy[k]) continue
    current.copy[k] = typeof v === 'function' ? v : () => v
  }
  for (const [k, fn] of Object.entries(c.run ?? {}) as [CtxRunAction, () => void][]) {
    if (fn && !current.run[k]) current.run[k] = fn
  }
}

/** Resposta ao `ctx:query`: descritor do clique atual (ou null) — consome o registro. */
export function snapshotCtx(): AppCtx | null {
  const reg = current
  current = null
  if (!reg) return null
  const token = nextToken++
  const actions: CtxAppAction[] = []
  const copy: AppCtx['copy'] = {}
  for (const { action } of CTX_APP_ITEMS) {
    if (isCopyAction(action)) {
      let text: string
      try {
        text = reg.copy[action]?.() ?? ''
      } catch {
        text = ''
      }
      if (!text) continue
      copy[action] = text
      actions.push(action)
    } else if (reg.run[action]) actions.push(action)
  }
  pending = { token, run: reg.run }
  return actions.length ? { token, actions, copy } : null
}

/** `ctx:action`: roda a ação do clique pendente (token diferente / ação ausente → nada). */
export function runCtxAction(token: number, action: string): boolean {
  if (!pending || pending.token !== token || isCopyAction(action)) return false
  const fn = pending.run[action as CtxRunAction]
  if (!fn) return false
  pending = null
  fn()
  return true
}

/** Liga a ponte (uma vez, no start). Sem preload (mock de dev) → nada. */
export function installContextMenuBridge(
  bridge: ClearApi['contextMenu'] = (window as { api?: ClearApi }).api?.contextMenu
): () => void {
  if (!bridge) return () => {}
  const onCapture = (): void => beginCtx()
  window.addEventListener('contextmenu', onCapture, true)
  const offQuery = bridge.onQuery(() => snapshotCtx())
  const offAction = bridge.onAction(({ token, action }) => {
    try {
      runCtxAction(token, action)
    } catch (e) {
      console.error('[clearchat] ação do menu de contexto', e)
    }
  })
  return () => {
    window.removeEventListener('contextmenu', onCapture, true)
    offQuery()
    offAction()
  }
}
