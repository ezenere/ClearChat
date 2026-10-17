// Abas Modelo · Chat · Tools do painel direito (config do chat; salva automaticamente).
import { BookmarkPlus, FolderOpen, Layers } from 'lucide-react'
import { useState } from 'react'
import { snapshotPreset } from '@shared/presets'
import type { Chat, ChatConfig } from '@shared/types'
import { api } from '../../lib/api'
import { compactPath, formatTokens } from '../../lib/format'
import { useContextInfo } from '../../lib/useContextInfo'
import { isBusy, useStore } from '../../store'
import { ContextWindowInfo, RootInfo } from '../apiDocs'
import { PresetIcon } from '../presets/PresetIcon'
import { SavePresetDialog } from '../presets/SavePresetDialog'
import { Button } from '../ui/controls'
import { ContextSettings, ModelEditor, RootOptions, SignatureSection, ToolsEditor } from './editors'
import { Section } from './fields'
import { MemorySection } from '../memory/MemorySection'

function usePatch(chat: Chat): (p: Partial<ChatConfig>) => void {
  const patchConfig = useStore((s) => s.patchConfig)
  return (p) => patchConfig(chat.id, p)
}

export function ModelTab({ chat }: { chat: Chat }): React.JSX.Element {
  return <ModelEditor cfg={chat.config} patch={usePatch(chat)} scope={chat.id} />
}

export function ToolsTab({ chat }: { chat: Chat }): React.JSX.Element {
  return <ToolsEditor cfg={chat.config} patch={usePatch(chat)} chatScope />
}

export function MemoryTab({ chat }: { chat: Chat }): React.JSX.Element {
  return <MemorySection cfg={chat.config} patch={usePatch(chat)} chat={chat} />
}

export function ChatTab({ chat }: { chat: Chat }): React.JSX.Element {
  const patch = usePatch(chat)
  return (
    <>
      <ChatInfoSection chat={chat} />
      <RootSection chat={chat} />
      <SignatureSection cfg={chat.config} patch={patch} />
      <ContextSection chat={chat} />
    </>
  )
}

function TitleInput({ chat }: { chat: Chat }): React.JSX.Element {
  const renameChat = useStore((s) => s.renameChat)
  const [text, setText] = useState(chat.title)
  const [prev, setPrev] = useState(chat.title)
  if (prev !== chat.title) {
    setPrev(chat.title)
    setText(chat.title)
  }
  const commit = (): void => {
    const t = text.trim()
    if (t !== chat.title) void renameChat(chat.id, t)
  }
  return (
    <input
      value={text}
      aria-label="Título do chat"
      placeholder="Novo chat"
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        if (e.key === 'Escape') setText(chat.title)
      }}
      className="field text-[13px]"
    />
  )
}

function ChatInfoSection({ chat }: { chat: Chat }): React.JSX.Element {
  const presets = useStore((s) => s.presets)
  const flushConfig = useStore((s) => s.flushConfig)
  const patchConfig = useStore((s) => s.patchConfig)
  const [saveOpen, setSaveOpen] = useState(false)
  const origin = chat.config.presetId
    ? (presets.find((p) => p.id === chat.config.presetId) ?? null)
    : null
  return (
    <Section title="Chat">
      <TitleInput key={chat.id} chat={chat} />
      <div className="flex items-center gap-2.5 rounded-lg border border-border bg-bg/40 py-1.5 pr-1.5 pl-2">
        <PresetIcon icon={origin?.icon} size="sm" />
        <div className="min-w-0 flex-1">
          <div className="text-[11px] text-subtle">Persona de origem</div>
          <div data-testid="chat-preset" className="truncate text-[12.5px] text-fg/90">
            {origin ? origin.name : chat.config.presetId ? '(persona apagada)' : 'Nenhuma'}
          </div>
        </div>
        <Button
          size="sm"
          variant="ghost"
          icon={<BookmarkPlus className="size-3.5 text-accent-strong" />}
          onClick={() => {
            void flushConfig(chat.id)
            setSaveOpen(true)
          }}
        >
          Salvar como persona
        </Button>
      </div>
      <SavePresetDialog
        open={saveOpen}
        onClose={() => setSaveOpen(false)}
        cwd={chat.config.cwd}
        base={origin}
        buildConfig={(_mode, includeCwd) => snapshotPreset(chat.config, { includeCwd })}
        onSaved={(p) => patchConfig(chat.id, { presetId: p.id })}
      />
    </Section>
  )
}

function RootSection({ chat }: { chat: Chat }): React.JSX.Element {
  const patch = usePatch(chat)
  const homeDir = useStore((s) => s.homeDir)
  const run = useStore((s) => s.run)
  const setPanel = useStore((s) => s.setPanel)
  const c = chat.config
  const pick = async (): Promise<void> => {
    const d = await run(() => api.fs.pickDirectory(), 'Erro ao escolher pasta')
    if (d) patch({ cwd: d })
  }
  return (
    <Section title="Diretório raiz" aside={<RootInfo side="left" />}>
      <div className="flex items-center gap-2 rounded-lg border border-border bg-bg/40 py-1.5 pr-1.5 pl-3">
        <FolderOpen className="size-3.5 shrink-0 text-accent-strong/80" />
        <button
          type="button"
          title={c.cwd}
          onClick={() => setPanel(true, 'files')}
          className="min-w-0 flex-1 truncate text-left font-mono text-[12px] text-fg/90 hover:text-fg"
        >
          {compactPath(c.cwd, homeDir, 30)}
        </button>
        <Button size="sm" variant="ghost" onClick={() => void pick()}>
          Alterar…
        </Button>
      </div>
      <RootOptions cfg={c} patch={patch} sessionId={chat.mainSessionId} />
    </Section>
  )
}

function ContextSection({ chat }: { chat: Chat }): React.JSX.Element {
  const patch = usePatch(chat)
  const compact = useStore((s) => s.compact)
  const viewSessionId = useStore((s) => (s.view.kind === 'chat' ? s.view.sessionId : null))
  const viewSession = useStore((s) => (viewSessionId ? s.sessions[viewSessionId] : undefined))
  const mainSession = useStore((s) => s.sessions[chat.mainSessionId])
  const session = viewSession ?? mainSession
  const compacting = useStore((s) => (session ? s.compactions[session.id] : undefined))
  const c = chat.config
  const info = useContextInfo(
    chat,
    session ?? {
      id: chat.mainSessionId,
      chatId: chat.id,
      parentSessionId: null,
      parentToolCallId: null,
      depth: 0,
      model: c.model,
      title: '',
      task: null,
      status: 'idle',
      createdAt: 0
    }
  )
  const isSub = !!session && session.depth > 0
  return (
    <Section title="Contexto" id="contexto" aside={<ContextWindowInfo />}>
      <div className="rounded-lg border border-border bg-bg/40 px-3 py-2.5 text-[12px]">
        <div className="flex items-center gap-2">
          <span className="text-muted">Em uso</span>
          <span className="ml-auto font-mono text-fg/90 tabular-nums">
            {info.usage
              ? `${info.usage.estimated ? '~' : ''}${formatTokens(info.usage.used)}${info.window ? ` / ${formatTokens(info.window)} · ${Math.round((info.pct ?? 0) * 100)}%` : ''}`
              : '—'}
          </span>
        </div>
        <div className="mt-1 flex items-center gap-2">
          <span className="text-muted">Janela</span>
          <span className="ml-auto text-subtle">
            {info.window
              ? `${info.window.toLocaleString('pt-BR')} tokens · ${info.source === 'override' ? 'definida aqui' : 'do modelo'}`
              : 'não informada pelo provedor'}
          </span>
        </div>
      </div>
      <ContextSettings cfg={c} patch={patch} knownWindow={info.window} />
      <Button
        variant="secondary"
        className="w-full"
        disabled={isSub || !info.canCompact || !!compacting}
        loading={compacting?.state === 'running'}
        icon={<Layers className="size-3.5 text-accent-strong" />}
        onClick={() => session && void compact(session.id)}
      >
        {compacting?.state === 'scheduled'
          ? 'Compactação agendada'
          : session && isBusy(session.status)
            ? 'Compactar no próximo passo'
            : 'Compactar agora'}
      </Button>
      {isSub && (
        <p className="-mt-1 text-center text-[11px] text-subtle">
          Subagentes compactam sozinhos ao atingir o limite.
        </p>
      )}
    </Section>
  )
}
