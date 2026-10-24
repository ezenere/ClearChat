// Menu de contexto nativo (botão direito) para as janelas do app — ver SPEC.md → "Menu de contexto".
// O Chromium só pede o menu quando a página NÃO chamou preventDefault() no `contextmenu` (menus
// próprios do app, como o do microfone, continuam funcionando). Os itens vêm do builder puro
// (`contextMenuTemplate.ts`); as ações do app (mensagem, código, arquivo) vêm de uma pergunta ao
// renderer (`ctx:query` → `ctx:reply`) feita só para cliques no frame principal da janela do app:
// o descritor é validado (lista fechada de ações), cópias são gravadas aqui no main e as outras
// ações voltam ao renderer só como nome (`ctx:action` + token) — nada de código ou texto executado.
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  shell,
  type ContextMenuParams,
  type MenuItemConstructorOptions,
  type Session,
  type WebContents
} from 'electron'
import { writeFile } from 'fs/promises'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import {
  CTX_ACTION_CHANNEL,
  CTX_QUERY_CHANNEL,
  CTX_REPLY_CHANNEL,
  imageFileName,
  isCopyAction,
  isOpenableLink,
  sanitizeAppCtx,
  webSearchUrl,
  type AppCtx
} from '@shared/contextMenu'
import { parseAttachmentUrl } from '@shared/attachments'
import {
  buildContextMenu,
  type CtxCommand,
  type CtxItem,
  type CtxParams
} from './contextMenuTemplate'
import { readAttachment } from './attachments'
import { serveViewerRequest } from './fileViewer'
import { getEngines } from './webSearchConfig'

export interface ContextMenuOptions {
  /** Janela do app (preload com a ponte `contextMenu`): pergunta ao renderer as ações do app. */
  appActions: boolean
}

/** Quanto o main espera a resposta do renderer antes de mostrar o menu sem as ações do app. */
const QUERY_TIMEOUT_MS = 300

let nextReq = 1
const pending = new Map<number, { wcId: number; resolve: (v: unknown) => void }>()
let replyListener = false

function ensureReplyListener(): void {
  if (replyListener) return
  replyListener = true
  ipcMain.on(CTX_REPLY_CHANNEL, (e, reqId: unknown, payload: unknown) => {
    if (typeof reqId !== 'number') return
    const p = pending.get(reqId)
    // só a mesma página a quem perguntamos responde
    if (!p || p.wcId !== e.sender.id) return
    pending.delete(reqId)
    p.resolve(payload)
  })
}

/** Pergunta ao renderer o que está sob o clique (null em timeout / resposta inválida). */
function queryAppCtx(wc: WebContents): Promise<AppCtx | null> {
  ensureReplyListener()
  const reqId = nextReq++
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(reqId)
      resolve(null)
    }, QUERY_TIMEOUT_MS)
    pending.set(reqId, {
      wcId: wc.id,
      resolve: (v) => {
        clearTimeout(timer)
        resolve(sanitizeAppCtx(v))
      }
    })
    try {
      wc.send(CTX_QUERY_CHANNEL, reqId)
    } catch {
      pending.delete(reqId)
      clearTimeout(timer)
      resolve(null)
    }
  })
}

function toParams(p: ContextMenuParams): CtxParams {
  return {
    x: p.x,
    y: p.y,
    isEditable: !!p.isEditable,
    selectionText: p.selectionText ?? '',
    linkURL: p.linkURL ?? '',
    mediaType: p.mediaType ?? 'none',
    srcURL: p.srcURL ?? '',
    hasImageContents: !!p.hasImageContents,
    misspelledWord: p.misspelledWord ?? '',
    dictionarySuggestions: p.dictionarySuggestions ?? [],
    editFlags: p.editFlags
  }
}

function preferredEngine(): string | null {
  try {
    return getEngines().find((e) => e.enabled)?.id ?? null
  } catch {
    return null
  }
}

function decodeDataUrl(url: string): Buffer | null {
  const m = /^data:([^,]*?),(.*)$/s.exec(url)
  if (!m) return null
  if (/;base64$/i.test(m[1])) return Buffer.from(m[2], 'base64')
  try {
    return Buffer.from(decodeURIComponent(m[2]), 'utf8')
  } catch {
    return null
  }
}

/**
 * "Salvar imagem como…": http(s)/blob → download do Chromium (a sessão do app não intercepta
 * downloads, então ele mesmo mostra o diálogo de salvar); anexos e arquivos do visualizador são lidos
 * pelos MESMOS handlers dos protocolos (validação de nome / token concedido); data: decodificada.
 */
async function saveImage(wc: WebContents, url: string): Promise<void> {
  const proto = new URL(url).protocol
  if (proto === 'http:' || proto === 'https:' || proto === 'blob:') {
    wc.downloadURL(url)
    return
  }
  let bytes: Buffer | null = null
  if (proto === 'clearchat-attachment:') {
    const file = parseAttachmentUrl(url.replace(/\/+$/, ''))
    if (!file) throw new Error('Anexo inválido.')
    bytes = readAttachment(file)
  } else if (proto === 'clearchat-file:') {
    const r = await serveViewerRequest(url)
    if (!r.ok) throw new Error('Arquivo indisponível.')
    bytes = Buffer.from(await r.arrayBuffer())
  } else if (proto === 'data:') {
    bytes = decodeDataUrl(url)
  }
  if (!bytes) throw new Error('Não foi possível ler a imagem.')
  const win = BrowserWindow.fromWebContents(wc)
  const opts = { defaultPath: join(app.getPath('downloads'), imageFileName(url)) }
  const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
  if (r.canceled || !r.filePath) return
  await writeFile(r.filePath, bytes)
}

/** Executa um item escolhido. */
export async function runContextCommand(
  wc: WebContents,
  cmd: CtxCommand,
  appCtx: AppCtx | null
): Promise<void> {
  switch (cmd.type) {
    case 'replaceMisspelling':
      if (cmd.word) wc.replaceMisspelling(cmd.word)
      return
    case 'addWord':
      wc.session.addWordToSpellCheckerDictionary(cmd.word)
      return
    case 'edit':
      wc[cmd.op]()
      return
    case 'search':
      await shell.openExternal(webSearchUrl(cmd.text, preferredEngine()))
      return
    case 'openLink':
      if (isOpenableLink(cmd.url)) await shell.openExternal(cmd.url)
      return
    case 'copyText':
      clipboard.writeText(cmd.text)
      return
    case 'copyImage':
      wc.copyImageAt(cmd.x, cmd.y)
      return
    case 'saveImage':
      await saveImage(wc, cmd.url)
      return
    case 'inspect':
      wc.inspectElement(cmd.x, cmd.y)
      return
    case 'app': {
      if (!appCtx || !appCtx.actions.includes(cmd.action)) return
      if (isCopyAction(cmd.action)) {
        const text = appCtx.copy[cmd.action]
        if (text) clipboard.writeText(text)
        return
      }
      if (!wc.isDestroyed())
        wc.send(CTX_ACTION_CHANNEL, { token: appCtx.token, action: cmd.action })
      return
    }
  }
}

function toTemplate(
  wc: WebContents,
  items: CtxItem[],
  appCtx: AppCtx | null
): MenuItemConstructorOptions[] {
  return items.map((it) =>
    it.type === 'separator'
      ? { type: 'separator' }
      : {
          label: it.label,
          enabled: it.enabled,
          ...(it.accelerator ? { accelerator: it.accelerator, registerAccelerator: false } : {}),
          click: () =>
            void runContextCommand(wc, it.command, appCtx).catch((e) =>
              console.error('[clearchat] menu de contexto', e)
            )
        }
  )
}

// ---------------- E2E (só com userData isolado): captura em vez de abrir o menu nativo ----------------

interface CapturedMenu {
  wcId: number
  items: CtxItem[]
  appCtx: AppCtx | null
}
let capture: CapturedMenu[] | null = null

function exposeE2eHooks(): void {
  if (!process.env['CLEARCHAT_USER_DATA']) return
  const g = globalThis as { __clearchatContextMenu?: unknown }
  if (g.__clearchatContextMenu) return
  g.__clearchatContextMenu = {
    /** Liga/desliga a captura (menus não são abertos; ficam em `menus()`). */
    capture(on: boolean) {
      capture = on ? [] : null
    },
    menus: () => capture ?? [],
    /** Clica no item `label` do último menu capturado. */
    async click(label: string) {
      const m = capture?.[capture.length - 1]
      const it = m?.items.find((i) => i.type === 'item' && i.label === label)
      if (!m || !it || it.type !== 'item') throw new Error(`item não encontrado: ${label}`)
      if (!it.enabled) throw new Error(`item desabilitado: ${label}`)
      const wc = BrowserWindow.getAllWindows()
        .map((w) => w.webContents)
        .find((w) => w.id === m.wcId)
      if (!wc) throw new Error('janela do menu fechada')
      await runContextCommand(wc, it.command, m.appCtx)
    },
    build: (params: CtxParams, appCtx: AppCtx | null = null) =>
      buildContextMenu(params, {
        platform: process.platform,
        dev: is.dev,
        canAddWord: true,
        app: sanitizeAppCtx(appCtx)
      })
  }
}

// ---------------- instalação ----------------

/** Liga o menu de contexto numa janela. */
export function installContextMenu(win: BrowserWindow, opts: ContextMenuOptions): void {
  exposeE2eHooks()
  const wc = win.webContents
  wc.on('context-menu', (_e, params) => {
    void (async () => {
      // pergunta só por cliques no documento do app (iframes do visualizador não têm a ponte)
      let mainFrame: boolean
      try {
        mainFrame = !params.frame || params.frame.parent === null
      } catch {
        mainFrame = false
      }
      const appCtx =
        opts.appActions && mainFrame && !params.isEditable ? await queryAppCtx(wc) : null
      if (win.isDestroyed()) return
      const items = buildContextMenu(toParams(params), {
        platform: process.platform,
        dev: is.dev,
        canAddWord: wc.session.isPersistent(),
        app: appCtx
      })
      if (capture) {
        capture.push({ wcId: wc.id, items, appCtx })
        return
      }
      if (!items.length) return
      Menu.buildFromTemplate(toTemplate(wc, items, appCtx)).popup({ window: win })
    })().catch((e) => console.error('[clearchat] menu de contexto', e))
  })
}

/**
 * Corretor ortográfico em pt-BR + en-US (Windows/Linux: dicionários Hunspell do Chromium, baixados
 * na primeira vez; macOS: corretor do sistema, que detecta o idioma — a API de idiomas não faz nada
 * lá). Só idiomas que esta versão do Electron conhece (código desconhecido lança).
 */
export function setupSpellcheck(ses: Session): void {
  if (process.platform === 'darwin') return
  try {
    const available = new Set(ses.availableSpellCheckerLanguages)
    const langs = ['pt-BR', 'en-US'].filter((l) => available.has(l))
    if (langs.length) ses.setSpellCheckerLanguages(langs)
  } catch (e) {
    console.warn('[clearchat] corretor ortográfico', e)
  }
}
