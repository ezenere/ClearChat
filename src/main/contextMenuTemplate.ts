// Menu de contexto — construção PURA dos itens (sem Electron): dado o que o Chromium informa sobre
// o clique (subconjunto de Electron.ContextMenuParams) e o descritor do app (renderer, já
// validado), devolve a lista de itens com rótulos pt-BR, habilitação e atalhos por plataforma.
// `src/main/contextMenu.ts` transforma em Menu e liga os cliques. Ver SPEC.md → "Menu de contexto".
import {
  CTX_APP_ITEMS,
  isOpenableLink,
  isSaveableImage,
  menuText,
  searchLabel,
  searchQuery,
  type AppCtx,
  type CtxAppAction
} from '@shared/contextMenu'

export interface CtxEditFlags {
  canUndo: boolean
  canRedo: boolean
  canCut: boolean
  canCopy: boolean
  canPaste: boolean
  canSelectAll: boolean
}

/** O que o template usa de `Electron.ContextMenuParams`. */
export interface CtxParams {
  x: number
  y: number
  isEditable: boolean
  selectionText: string
  linkURL: string
  mediaType: string
  srcURL: string
  hasImageContents: boolean
  misspelledWord: string
  dictionarySuggestions: string[]
  editFlags: CtxEditFlags
}

export type EditOp = 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'pasteAndMatchStyle' | 'selectAll'

export type CtxCommand =
  | { type: 'replaceMisspelling'; word: string }
  | { type: 'addWord'; word: string }
  | { type: 'edit'; op: EditOp }
  | { type: 'search'; text: string }
  | { type: 'openLink'; url: string }
  | { type: 'copyText'; text: string }
  | { type: 'copyImage'; x: number; y: number }
  | { type: 'saveImage'; url: string }
  | { type: 'app'; action: CtxAppAction }
  | { type: 'inspect'; x: number; y: number }

export type CtxItem =
  | { type: 'separator' }
  | { type: 'item'; label: string; enabled: boolean; accelerator?: string; command: CtxCommand }

export interface CtxOptions {
  platform: NodeJS.Platform
  /** Dev (`is.dev`): "Inspecionar elemento". */
  dev: boolean
  /** Sessão persistente (o dicionário pessoal só grava nelas). */
  canAddWord: boolean
  /** Ações do app sob o clique (mensagem, bloco de código, arquivo), já validadas. */
  app?: AppCtx | null
}

/** Atalhos mostrados no menu (os do Chromium/sistema de cada plataforma). */
export function editAccelerator(op: EditOp, platform: NodeJS.Platform): string {
  const mac = platform === 'darwin'
  switch (op) {
    case 'undo':
      return 'CmdOrCtrl+Z'
    case 'redo':
      return mac ? 'Shift+Cmd+Z' : platform === 'win32' ? 'Ctrl+Y' : 'Ctrl+Shift+Z'
    case 'cut':
      return 'CmdOrCtrl+X'
    case 'copy':
      return 'CmdOrCtrl+C'
    case 'paste':
      return 'CmdOrCtrl+V'
    case 'pasteAndMatchStyle':
      return mac ? 'Shift+Alt+Cmd+V' : 'Ctrl+Shift+V'
    case 'selectAll':
      return 'CmdOrCtrl+A'
  }
}

const EDIT_LABEL: Record<EditOp, string> = {
  undo: 'Desfazer',
  redo: 'Refazer',
  cut: 'Recortar',
  copy: 'Copiar',
  paste: 'Colar',
  pasteAndMatchStyle: 'Colar sem formatação',
  selectAll: 'Selecionar tudo'
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

/** Até quantas sugestões do corretor aparecem. */
export const MAX_SPELL_SUGGESTIONS = 5

/**
 * Itens do menu para um clique. Grupos (separados): corretor → edição (campo editável) ou cópia da
 * seleção → pesquisa → link → imagem → ações do app (mensagem / arquivo) → Inspecionar (dev).
 * Lista vazia = não mostra menu.
 */
export function buildContextMenu(p: CtxParams, o: CtxOptions): CtxItem[] {
  const groups: CtxItem[][] = []
  const item = (
    label: string,
    command: CtxCommand,
    enabled = true,
    accelerator?: string
  ): CtxItem => ({ type: 'item', label, enabled, command, ...(accelerator ? { accelerator } : {}) })
  const edit = (op: EditOp, enabled: boolean): CtxItem =>
    item(EDIT_LABEL[op], { type: 'edit', op }, enabled, editAccelerator(op, o.platform))
  const selection = searchQuery(p.selectionText ?? '')
  const f = p.editFlags

  // corretor ortográfico (só em campo editável com palavra marcada)
  if (p.isEditable && p.misspelledWord) {
    const sugg = (p.dictionarySuggestions ?? []).slice(0, MAX_SPELL_SUGGESTIONS)
    const g: CtxItem[] = sugg.length
      ? sugg.map((w) => item(menuText(w), { type: 'replaceMisspelling', word: w }))
      : [item('Sem sugestões', { type: 'replaceMisspelling', word: '' }, false)]
    if (o.canAddWord)
      g.push(item('Adicionar ao dicionário', { type: 'addWord', word: p.misspelledWord }))
    groups.push(g)
  }

  if (p.isEditable) {
    groups.push([edit('undo', f.canUndo), edit('redo', f.canRedo)])
    groups.push([
      edit('cut', f.canCut),
      edit('copy', f.canCopy),
      edit('paste', f.canPaste),
      edit('pasteAndMatchStyle', f.canPaste),
      edit('selectAll', f.canSelectAll)
    ])
  } else if (selection) {
    groups.push([edit('copy', f.canCopy)])
  }
  if (selection) groups.push([item(searchLabel(selection), { type: 'search', text: selection })])

  if (p.linkURL) {
    const g: CtxItem[] = []
    const mail = /^mailto:/i.test(p.linkURL)
    if (isOpenableLink(p.linkURL))
      g.push(
        item(mail ? 'Escrever e-mail' : 'Abrir no navegador', { type: 'openLink', url: p.linkURL })
      )
    g.push(
      mail
        ? item('Copiar e-mail', {
            type: 'copyText',
            text: safeDecode(p.linkURL.replace(/^mailto:/i, '').split('?')[0])
          })
        : item('Copiar link', { type: 'copyText', text: p.linkURL })
    )
    groups.push(g)
  }

  if (p.mediaType === 'image' && p.srcURL) {
    groups.push([
      item('Copiar imagem', { type: 'copyImage', x: p.x, y: p.y }, p.hasImageContents !== false),
      item('Salvar imagem como…', { type: 'saveImage', url: p.srcURL }, isSaveableImage(p.srcURL))
    ])
  }

  // ações do app: nunca dentro de campo editável (o editor da mensagem está dentro do balão)
  if (o.app && !p.isEditable) {
    const avail = new Set(o.app.actions)
    for (const grp of ['msg', 'file'] as const) {
      const g = CTX_APP_ITEMS.filter((i) => i.group === grp && avail.has(i.action)).map((i) =>
        item(i.label, { type: 'app', action: i.action })
      )
      if (g.length) groups.push(g)
    }
  }

  if (o.dev) groups.push([item('Inspecionar elemento', { type: 'inspect', x: p.x, y: p.y })])

  const out: CtxItem[] = []
  for (const g of groups) {
    if (!g.length) continue
    if (out.length) out.push({ type: 'separator' })
    out.push(...g)
  }
  return out
}
