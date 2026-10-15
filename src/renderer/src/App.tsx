import { CircleAlert, CircleCheck, Info, X } from 'lucide-react'
import { useEffect, useSyncExternalStore } from 'react'
import { ChatHeader, ChatView } from './components/chat/ChatView'
import { NewChat } from './components/NewChat'
import { Onboarding } from './components/Onboarding'
import { RequestPreviewModal } from './components/panel/RequestPreview'
import { RightPanel } from './components/panel/RightPanel'
import { SettingsModal } from './components/SettingsModal'
import { Sidebar } from './components/Sidebar'
import { TopBar } from './components/TopBar'
import { Spinner } from './components/ui/controls'
import { TooltipProvider } from './components/ui/Tooltip'
import { cn } from './lib/format'
import { currentChat, useStore } from './store'

function Toasts(): React.JSX.Element {
  const toasts = useStore((s) => s.toasts)
  const dismiss = useStore((s) => s.dismissToast)
  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-[90] flex w-[340px] flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={cn(
            'pointer-events-auto flex animate-slide-up items-start gap-2.5 rounded-xl border bg-elevated px-3.5 py-2.5 text-[12.5px] shadow-popover',
            t.kind === 'error' ? 'border-danger/25' : 'border-border-strong/70'
          )}
        >
          {t.kind === 'error' ? (
            <CircleAlert className="mt-px size-3.5 shrink-0 text-danger" />
          ) : t.kind === 'success' ? (
            <CircleCheck className="mt-px size-3.5 shrink-0 text-success" />
          ) : (
            <Info className="mt-px size-3.5 shrink-0 text-accent-strong" />
          )}
          <span className="min-w-0 flex-1 break-words text-fg/90">{t.text}</span>
          <button type="button" onClick={() => dismiss(t.id)} className="text-subtle hover:text-fg">
            <X className="size-3.5" />
          </button>
        </div>
      ))}
    </div>
  )
}

/** Abaixo desta largura de janela o painel direito vira gaveta sobreposta (e começa fechado). */
const NARROW_QUERY = '(max-width: 1179px)'

function useNarrow(): boolean {
  return useSyncExternalStore(
    (cb) => {
      const mq = window.matchMedia(NARROW_QUERY)
      mq.addEventListener('change', cb)
      return () => mq.removeEventListener('change', cb)
    },
    () => window.matchMedia(NARROW_QUERY).matches
  )
}

function Main(): React.JSX.Element {
  const view = useStore((s) => s.view)
  const chat = useStore(currentChat)
  const panelOpen = useStore((s) => s.panelOpen)
  const setPanel = useStore((s) => s.setPanel)
  const narrow = useNarrow()
  // trocar a persona padrão (Configurações) reinicia o Novo chat com ela
  const defaultPresetId = useStore((s) => s.settings.defaultPresetId)

  // Ao ficar estreita, recolhe o painel (o usuário pode reabrir como gaveta).
  useEffect(() => {
    if (narrow) useStore.getState().setPanel(false)
  }, [narrow])
  const session = useStore((s) =>
    s.view.kind === 'chat' ? s.sessions[s.view.sessionId] : undefined
  )

  if (view.kind === 'chat' && chat) {
    return (
      <div className="flex min-w-0 flex-1 flex-col">
        <ChatHeader chat={chat} session={session} />
        <div className="relative flex min-h-0 flex-1">
          <ChatView key={view.sessionId} chat={chat} sessionId={view.sessionId} />
          {panelOpen && narrow && (
            <div
              className="absolute inset-0 z-20 animate-fade-in bg-black/40"
              onClick={() => setPanel(false)}
            />
          )}
          {panelOpen && <RightPanel chat={chat} overlay={narrow} />}
        </div>
      </div>
    )
  }
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <TopBar />
      <NewChat key={`new:${defaultPresetId ?? ''}`} />
    </div>
  )
}

function App(): React.JSX.Element {
  const booted = useStore((s) => s.booted)
  const hasProviders = useStore((s) => s.providers.length > 0)
  const boot = useStore((s) => s.boot)

  useEffect(() => {
    void boot()
  }, [boot])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const mod = e.ctrlKey || e.metaKey
      if (!mod || e.altKey) return
      const s = useStore.getState()
      if (s.providers.length === 0) return
      if (e.key.toLowerCase() === 'n' && !e.shiftKey) {
        e.preventDefault()
        s.setSettingsOpen(false)
        s.setPreview(null)
        s.goNew()
      } else if (e.key === ',') {
        e.preventDefault()
        s.setSettingsOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <TooltipProvider delayDuration={350} skipDelayDuration={150}>
      {!booted ? (
        <div className="flex h-full flex-col">
          <div className="drag h-titlebar" />
          <div className="flex flex-1 items-center justify-center">
            <Spinner className="size-4" />
          </div>
        </div>
      ) : !hasProviders ? (
        <Onboarding />
      ) : (
        <div className="flex h-full">
          <Sidebar />
          <Main />
          <SettingsModal />
          <RequestPreviewModal />
        </div>
      )}
      <Toasts />
    </TooltipProvider>
  )
}

export default App
