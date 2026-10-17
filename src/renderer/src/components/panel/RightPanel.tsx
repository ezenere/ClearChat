import {
  Braces,
  BrainCircuit,
  FolderTree,
  MessageSquareText,
  Sparkles,
  Wrench,
  X
} from 'lucide-react'
import { useEffect, useRef } from 'react'
import type { Chat } from '@shared/types'
import { cn } from '../../lib/format'
import { useStore, type PanelTab } from '../../store'
import { IconButton } from '../ui/controls'
import { ChatTab, MemoryTab, ModelTab, ToolsTab } from './ConfigTabs'
import { Note } from './fields'
import { ModelLabel } from '../ui/ModelLabel'
import { sessionProviderId } from '@shared/models'
import { FilesTab } from './FilesTab'

const TABS: { id: PanelTab; label: string; icon: typeof Sparkles }[] = [
  { id: 'model', label: 'Modelo', icon: Sparkles },
  { id: 'chat', label: 'Chat', icon: MessageSquareText },
  { id: 'tools', label: 'Tools', icon: Wrench },
  { id: 'memory', label: 'Memória', icon: BrainCircuit },
  { id: 'files', label: 'Arquivos', icon: FolderTree }
]

export function RightPanel({
  chat,
  overlay
}: {
  chat: Chat
  /** Janela estreita: gaveta sobreposta ao chat em vez de coluna. */
  overlay?: boolean
}): React.JSX.Element {
  const tab = useStore((s) => s.panelTab)
  const setPanel = useStore((s) => s.setPanel)
  const setPreview = useStore((s) => s.setPreview)
  const viewSessionId = useStore((s) => (s.view.kind === 'chat' ? s.view.sessionId : null))
  const viewSession = useStore((s) => (viewSessionId ? s.sessions[viewSessionId] : undefined))
  const isSub = !!viewSession && viewSession.depth > 0

  // focusConfig('contexto') → a aba já foi trocada no store; rola até a seção e destaca.
  const configFocus = useStore((s) => s.configFocus)
  const focusConfig = useStore((s) => s.focusConfig)
  const bodyRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!configFocus) return
    const body = bodyRef.current
    const el = body?.querySelector<HTMLElement>(`[data-section="${configFocus}"]`)
    if (body && el) {
      // rola só o corpo do painel (scrollIntoView rolaria também a janela quando a seção está no fim)
      const top = el.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop
      body.scrollTo({ top: Math.max(0, top - 4), behavior: 'smooth' })
      el.classList.add('animate-flash')
      setTimeout(() => el.classList.remove('animate-flash'), 1200)
    }
    focusConfig(null)
  }, [configFocus, focusConfig, tab])

  return (
    <aside
      data-testid="right-panel"
      className={cn(
        'flex w-[384px] max-w-[85%] shrink-0 animate-fade-in flex-col border-l border-border bg-surface',
        overlay && 'absolute inset-y-0 right-0 z-30 shadow-popover'
      )}
    >
      <div className="flex h-11 shrink-0 items-center gap-1.5 border-b border-border/70 px-2.5">
        <div role="tablist" className="flex min-w-0 flex-1 rounded-lg bg-bg/70 p-0.5">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => setPanel(true, t.id)}
              title={t.label}
              className={cn(
                'flex h-7 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-md px-1 text-xs font-medium transition-colors',
                tab === t.id ? 'bg-active text-fg shadow-sm' : 'text-subtle hover:text-fg'
              )}
            >
              {/* 5 abas em 384px: o ícone só aparece na aba ativa (o rótulo nunca corta) */}
              {tab === t.id && <t.icon className="size-3.5 shrink-0" />}
              <span className="truncate">{t.label}</span>
            </button>
          ))}
        </div>
        <IconButton
          label="Ver request"
          size="sm"
          side="bottom"
          onClick={() => setPreview(viewSessionId ?? chat.mainSessionId)}
        >
          <Braces />
        </IconButton>
        <IconButton label="Fechar painel" size="sm" side="bottom" onClick={() => setPanel(false)}>
          <X />
        </IconButton>
      </div>
      <div
        ref={bodyRef}
        className={cn('min-h-0 flex-1', tab === 'files' ? 'overflow-hidden' : 'overflow-y-auto')}
      >
        {tab !== 'files' && isSub && (
          <div className="px-4 pt-4">
            <Note>
              Configuração do chat (compartilhada por todas as sessões dele — editar aqui vale para
              o chat, não só para esta subsessão). Este subagente usa{' '}
              <ModelLabel
                providerId={sessionProviderId(chat.config, viewSession)}
                model={viewSession.model}
                className="text-fg/90"
                modelClassName="font-mono"
              />{' '}
              e o system prompt de subagentes (aba Tools); &quot;Ver request&quot; mostra a request
              dela. Para falar com ele, use o campo de mensagem — as respostas voltam ao agente pai.
            </Note>
          </div>
        )}
        {tab === 'model' ? (
          <ModelTab chat={chat} />
        ) : tab === 'chat' ? (
          <ChatTab chat={chat} />
        ) : tab === 'tools' ? (
          <ToolsTab chat={chat} />
        ) : tab === 'memory' ? (
          <MemoryTab chat={chat} />
        ) : (
          <FilesTab key={chat.id} chat={chat} />
        )}
      </div>
    </aside>
  )
}
