// Emissão de AgentEvent para as janelas do app (renderer) via EVENT_CHANNEL.
import type { BrowserWindow } from 'electron'
import { EVENT_CHANNEL } from '@shared/ipc'
import type { AgentEvent } from '@shared/types'

const windows = new Set<BrowserWindow>()

/** Registra uma janela do app para receber eventos (janelas ocultas do browse_url não entram). */
export function registerEventWindow(win: BrowserWindow): void {
  windows.add(win)
  win.on('closed', () => windows.delete(win))
}

type Listener = (e: AgentEvent) => void
const listeners = new Set<Listener>()

/** Assinatura interna (main) — útil para depuração/testes. */
export function onAgentEvent(fn: Listener): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function emit(event: AgentEvent): void {
  sendToWindows(EVENT_CHANNEL, event)
  for (const fn of listeners) {
    try {
      fn(event)
    } catch {
      /* ignora */
    }
  }
}

/** Envia um payload cru para as janelas registradas (canais fora de `agent:event`; ex. `voice:partial`). */
export function sendToWindows(channel: string, payload: unknown): void {
  for (const win of windows) {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send(channel, payload)
    }
  }
}
