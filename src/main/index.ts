import { app, shell, BrowserWindow, nativeTheme } from 'electron'
import { join, resolve } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { closeDb, getDb, getDbPath } from './db'
import { registerIpc } from './ipc'
import { registerEventWindow } from './events'
import { initRunner, shutdownRunner } from './agent/runner'
import { migrateLegacyData } from './migrate'

const APP_NAME = 'ClearChat'
const APP_ID = 'com.clearchat.app'

// Nome explícito: define userData (~/.config/ClearChat) e o WM_CLASS da janela no Linux
// (o app_id no Wayland vem de "desktopName" no package.json → clearchat.desktop).
app.setName(APP_NAME)

// Testes isolados: CLEARCHAT_USER_DATA sobrescreve o diretório userData (banco etc.). Antes do ready.
const isolatedUserData = process.env['CLEARCHAT_USER_DATA']
if (isolatedUserData) {
  app.setPath('userData', resolve(isolatedUserData))
}

const THEME_BG = '#0b0b0f'

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: APP_NAME,
    backgroundColor: THEME_BG,
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: THEME_BG, symbolColor: '#a1a1aa', height: 40 },
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  registerEventWindow(win)
  win.once('ready-to-show', () => win.show())

  // Links externos abrem no navegador do sistema, nunca dentro do app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return win
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId(APP_ID)
  nativeTheme.themeSource = 'dark'

  // F12 abre DevTools em dev; ignora Ctrl+R em produção.
  app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))

  // Dados do nome antigo (~/.config/CleartChat/cleartchat.db) → ~/.config/ClearChat/clearchat.db.
  // Só no userData padrão; o diretório antigo fica intacto.
  if (!isolatedUserData) {
    try {
      const r = migrateLegacyData(app.getPath('userData'))
      if (r.migrated) console.log(`[clearchat] banco migrado (${r.reason}): ${r.from} → ${r.to}`)
      else if (r.reason.startsWith('error')) console.warn(`[clearchat] migração: ${r.reason}`)
    } catch (e) {
      console.error('[clearchat] migração', e)
    }
  }

  getDb()
  console.log(`[clearchat] db: ${getDbPath()}`)

  initRunner()
  registerIpc()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => shutdownRunner())
app.on('will-quit', () => closeDb())
