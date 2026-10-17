// Seção de memória da config (aba Memória do painel do chat e editor de personas): só SELECIONA e
// ATIVA coleções — criar/editar conteúdo é em Configurações → Memórias (global). No chat, mostra o
// que veio da persona de origem (selos *da persona* / *adicionada*, ★ na escrita da persona) e
// permite ajustar; na persona, sem "Extrair agora", "Atualizar memória" e memória do chat.
import {
  ArrowUpRight,
  BrainCircuit,
  Check,
  PenLine,
  RefreshCw,
  RotateCcw,
  Settings2,
  Star,
  TriangleAlert,
  X
} from 'lucide-react'
import { useState } from 'react'
import {
  MEMORY_CATEGORIES,
  MEMORY_CATEGORY_HINTS,
  MEMORY_CATEGORY_LABELS,
  type MemoryCategory,
  type MemoryCollection,
  type MemoryConfig
} from '@shared/memory'
import type { Chat, ChatConfig } from '@shared/types'
import { api, errorMessage } from '../../lib/api'
import { formatTime } from '../../lib/dates'
import { cn } from '../../lib/format'
import {
  activeInCategory,
  collectionBadge,
  DEFAULT_MEMORY_EXTRACTION_PROMPT,
  DEFAULT_MEMORY_HELP_PROMPT,
  differsFromPersona,
  extractionCounts,
  memoryConfigOf,
  memoryWillSend,
  restoreFromPersona,
  setWriteTarget,
  sharedCollections,
  toggleCategory,
  toggleCollection,
  writeTargetIssue,
  type CollectionBadge
} from '../../lib/memory'
import { useStore } from '../../store'
import {
  ChatMemoryInfo,
  ExtractionPromptInfo,
  MemoryCollectionsInfo,
  MemoryHelpInfo,
  MemoryPreviewInfo,
  MemoryRefreshInfo,
  MemorySubagentsInfo
} from '../apiDocs'
import { PresetIcon } from '../presets/PresetIcon'
import { AutoTextarea, Button, Switch } from '../ui/controls'
import { ModelLabel } from '../ui/ModelLabel'
import { ModelPicker } from '../ui/ModelPicker'
import { Select } from '../ui/Select'
import { Tip } from '../ui/Tooltip'
import type { CfgProps } from '../panel/editors'
import { Section, ToggleRow } from '../panel/fields'
import { useMemoryCollections, useMemoryPreview } from './hooks'
import { CollectionIcon } from './MemoryIcon'

const NONE = '__none__'

export function MemorySection({
  cfg,
  patch,
  chat
}: CfgProps & {
  /** Presente = painel do chat (com extração agora, snapshot e memória do chat). */
  chat?: Chat
}): React.JSX.Element {
  const isChat = !!chat
  const cols = useMemoryCollections()
  const presets = useStore((s) => s.presets)
  const mem = memoryConfigOf(cfg)
  const set = (next: MemoryConfig): void => patch({ memory: next } as Partial<ChatConfig>)

  const preset = isChat && cfg.presetId ? presets.find((p) => p.id === cfg.presetId) : undefined
  const persona = preset?.config.memory ? memoryConfigOf(preset.config) : null
  const willSend = memoryWillSend(mem, cols, { chat: isChat })
  const { preview, reload, setPreview } = useMemoryPreview(
    chat?.id ?? null,
    chat?.mainSessionId ?? null,
    JSON.stringify(mem)
  )
  const helpText = mem.helpPrompt.text ?? DEFAULT_MEMORY_HELP_PROMPT

  return (
    <div data-testid={isChat ? 'memory-panel' : 'preset-memory'}>
      <Section
        title="Memória"
        id="memoria"
        aside={
          <MemoryPreviewInfo
            preview={isChat ? preview : null}
            willSend={willSend}
            persona={!isChat}
            helpText={mem.helpPrompt.enabled ? helpText : null}
          />
        }
      >
        <ToggleRow
          label={isChat ? 'Memória neste chat' : 'Memória nesta persona'}
          description="Índice, instruções e tools de memória nas requests"
          checked={mem.enabled}
          onChange={(enabled) => set({ ...mem, enabled })}
        />
        {preset && persona && (
          <PersonaLine
            name={preset.name}
            icon={preset.icon}
            differs={differsFromPersona(mem, persona)}
            onRestore={() => set(restoreFromPersona(mem, persona))}
          />
        )}
        <SendStatus mem={mem} cols={cols} willSend={willSend} isChat={isChat} />
      </Section>

      <Section title="Coleções" aside={<MemoryCollectionsInfo />}>
        <p className="-mt-1 text-[11.5px] leading-snug text-subtle">
          Marque as coleções que o modelo lê; em cada categoria, escolha onde ele grava.
          {persona && (
            <>
              {' '}
              <Star className="mb-0.5 inline size-2.5 fill-current text-accent-strong" /> = escrita
              da persona.
            </>
          )}
        </p>
        <div className={cn('space-y-3', !mem.enabled && 'opacity-55')}>
          {MEMORY_CATEGORIES.map((cat) => (
            <CategoryBlock
              key={cat}
              cat={cat}
              mem={mem}
              cols={cols}
              persona={persona}
              onChange={set}
            />
          ))}
        </div>
        <ManageLink />
      </Section>

      {isChat && chat && <ChatMemorySection chat={chat} mem={mem} cols={cols} onChange={set} />}

      <HelpSection mem={mem} text={helpText} onChange={set} />

      <ExtractionSection mem={mem} chat={chat} willSend={willSend} onChange={set} />

      {isChat && chat && (
        <SnapshotSection
          sessionId={chat.mainSessionId}
          chatId={chat.id}
          snapshotAt={preview?.snapshotAt ?? null}
          willSend={willSend}
          onRefreshed={(p) => {
            setPreview(p)
            reload()
          }}
        />
      )}

      <Section title="Subagentes" id="memoria-subagentes" aside={<MemorySubagentsInfo />}>
        <ToggleRow
          label="Memória nos subagentes (só busca/leitura)"
          description="memory_search e memory_read — nunca escrita nem índice"
          checked={mem.subagents}
          onChange={(subagents) => set({ ...mem, subagents })}
        />
      </Section>
    </div>
  )
}

function PersonaLine({
  name,
  icon,
  differs,
  onRestore
}: {
  name: string
  icon: string
  differs: boolean
  onRestore: () => void
}): React.JSX.Element {
  return (
    <div
      data-testid="memory-persona-line"
      className="flex items-center gap-2 rounded-lg border border-border bg-bg/40 py-1.5 pr-1.5 pl-2 text-[12px]"
    >
      <PresetIcon icon={icon} size="sm" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[11px] text-subtle">
          Da persona <span className="text-fg/90">{name}</span>
        </span>
        <span
          className={cn(
            'block truncate text-[11.5px]',
            differs ? 'text-accent-strong' : 'text-muted'
          )}
        >
          {differs ? 'Ajustada neste chat' : 'Igual à persona'}
        </span>
      </span>
      {differs && (
        <Tip label="Voltar à memória da persona (a memória do chat fica como está)">
          <Button
            size="sm"
            variant="ghost"
            icon={<RotateCcw className="size-3" />}
            onClick={onRestore}
            className="h-6 px-2 text-[11px]"
          >
            Restaurar
          </Button>
        </Tip>
      )}
    </div>
  )
}

/** Resumo do que vai (ou não) para a API, com a regra de envio. */
function SendStatus({
  mem,
  cols,
  willSend,
  isChat
}: {
  mem: MemoryConfig
  cols: MemoryCollection[]
  willSend: boolean
  isChat: boolean
}): React.JSX.Element {
  if (!willSend)
    return (
      <p
        data-testid="memory-status"
        data-active="false"
        className="rounded-lg border border-border bg-bg/40 px-3 py-2 text-[11.5px] leading-snug text-subtle"
      >
        <strong className="font-medium text-fg/85">Nada de memória vai para a API.</strong>{' '}
        {!mem.enabled
          ? 'A memória está desligada.'
          : `Ative ao menos uma coleção${isChat ? ' ou a memória do chat' : ''}.`}
      </p>
    )
  const active = mem.categories.flatMap((c) => activeInCategory(mem, cols, c))
  const writes = MEMORY_CATEGORIES.filter(
    (c) => mem.categories.includes(c) && mem.writeTo[c] && !writeTargetIssue(mem, cols, c)
  ).length
  const parts = [
    `${active.length} ${active.length === 1 ? 'coleção' : 'coleções'} no índice`,
    writes
      ? `grava em ${writes} ${writes === 1 ? 'categoria' : 'categorias'}`
      : 'sem coleção de escrita',
    isChat && mem.chatMemory ? 'memória do chat' : '',
    mem.helpPrompt.enabled ? 'instruções' : ''
  ].filter(Boolean)
  return (
    <p
      data-testid="memory-status"
      data-active="true"
      className="flex items-start gap-1.5 rounded-lg border border-accent/20 bg-accent-soft/30 px-3 py-2 text-[11.5px] leading-snug text-muted"
    >
      <BrainCircuit className="mt-px size-3.5 shrink-0 text-accent-strong" />
      <span>Vai para a API: {parts.join(' · ')}.</span>
    </p>
  )
}

const BADGE: Record<Exclude<CollectionBadge, null>, { text: string; cls: string; tip: string }> = {
  persona: {
    text: 'da persona',
    cls: 'border-border text-subtle',
    tip: 'Ativa na persona de origem'
  },
  'persona-off': {
    text: 'da persona · desligada aqui',
    cls: 'border-dashed border-border-strong text-faint',
    tip: 'Ativa na persona, desligada neste chat'
  },
  added: {
    text: 'adicionada',
    cls: 'border-accent/30 text-accent-strong/90',
    tip: 'Ativada só neste chat (a persona não tem)'
  }
}

function CategoryBlock({
  cat,
  mem,
  cols,
  persona,
  onChange
}: {
  cat: MemoryCategory
  mem: MemoryConfig
  cols: MemoryCollection[]
  persona: MemoryConfig | null
  onChange: (m: MemoryConfig) => void
}): React.JSX.Element {
  const toast = useStore((s) => s.toast)
  const openMemory = useStore((s) => s.openMemory)
  const list = sharedCollections(cols, cat)
  const on = mem.categories.includes(cat)
  const active = activeInCategory(mem, cols, cat)
  const issue = writeTargetIssue(mem, cols, cat)
  const writeId = issue ? null : (mem.writeTo[cat] ?? null)
  const personaWrite = persona ? (persona.writeTo[cat] ?? null) : undefined
  const label = MEMORY_CATEGORY_LABELS[cat]
  return (
    <div data-testid={`memory-cat-${cat}`} className="rounded-lg border border-border bg-bg/30">
      <div className="flex items-center gap-2 px-2.5 py-2">
        <Switch
          size="sm"
          checked={on}
          label={`Categoria ${label}`}
          onChange={(v) => onChange(toggleCategory(mem, cat, v))}
        />
        <div className="min-w-0 flex-1">
          <div className={cn('text-[12.5px] font-medium', on ? 'text-fg/90' : 'text-subtle')}>
            {label}
          </div>
          <div className="truncate text-[10.5px] text-faint" title={MEMORY_CATEGORY_HINTS[cat]}>
            {MEMORY_CATEGORY_HINTS[cat]}
          </div>
        </div>
        {on && list.length > 0 && (
          <div className="flex shrink-0 items-center gap-1.5">
            <span className="text-[11px] text-subtle">Escrita:</span>
            <Select<string>
              label={`Coleção de escrita: ${label}`}
              value={writeId ?? NONE}
              menuMinWidth={210}
              className="h-7 w-[118px] px-2 py-0 text-[11.5px]"
              onChange={(v) => {
                const r = setWriteTarget(mem, cols, cat, v === NONE ? null : v)
                if (r.error) toast(r.error, 'error')
                else onChange(r.mem)
              }}
              options={[
                ...active.map((c) => ({
                  value: c.id,
                  label: (
                    <span className="flex items-center gap-1.5">
                      <PenLine className="size-3 shrink-0 text-accent-strong" />
                      <span className="truncate">{c.name}</span>
                      {personaWrite === c.id && (
                        <Star
                          aria-label="escrita da persona"
                          className="size-2.5 shrink-0 fill-current text-accent-strong"
                        />
                      )}
                    </span>
                  )
                })),
                {
                  value: NONE,
                  label: (
                    <span className="flex items-center gap-1.5 text-subtle">
                      Nenhuma
                      {personaWrite === null && (
                        <Star className="size-2.5 shrink-0 fill-current text-accent-strong" />
                      )}
                    </span>
                  ),
                  description: active.length
                    ? 'O modelo não grava nesta categoria'
                    : 'Ative uma coleção para gravar'
                }
              ]}
            />
          </div>
        )}
      </div>
      {on && (
        <div className="border-t border-border/60 px-1.5 py-1">
          {list.length === 0 ? (
            <button
              type="button"
              onClick={() => openMemory()}
              className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1.5 text-left text-[11.5px] text-subtle hover:bg-hover/50 hover:text-fg"
            >
              Nenhuma coleção — criar em Configurações → Memórias
              <ArrowUpRight className="size-3" />
            </button>
          ) : (
            list.map((c) => {
              const checked = mem.collections.includes(c.id)
              const badge = collectionBadge(c.id, mem, persona)
              const isWrite = writeId === c.id
              return (
                <label
                  key={c.id}
                  data-testid={`memory-col-${c.id}`}
                  data-checked={checked || undefined}
                  className="flex h-8 cursor-pointer items-center gap-2 rounded-md px-1.5 hover:bg-hover/50"
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(e) => onChange(toggleCollection(mem, c, e.target.checked))}
                    aria-label={`${label}: ${c.name}`}
                    className="peer sr-only"
                  />
                  <span
                    aria-hidden
                    className={cn(
                      'flex size-3.5 shrink-0 items-center justify-center rounded-[4px] border transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-accent/40',
                      checked
                        ? 'border-accent bg-accent text-white'
                        : 'border-border-strong bg-active'
                    )}
                  >
                    {checked && <Check className="size-2.5" strokeWidth={3} />}
                  </span>
                  <CollectionIcon collection={c} size="xs" />
                  <span
                    className={cn(
                      'min-w-0 flex-1 truncate text-[12px]',
                      checked ? 'text-fg/90' : 'text-subtle'
                    )}
                  >
                    {c.name}
                  </span>
                  {badge && (
                    <Tip label={BADGE[badge].tip}>
                      <span
                        data-testid="memory-badge"
                        data-badge={badge}
                        className={cn(
                          'shrink-0 rounded border px-1 py-px text-[9.5px] leading-tight',
                          BADGE[badge].cls
                        )}
                      >
                        {BADGE[badge].text}
                      </span>
                    </Tip>
                  )}
                  {isWrite && (
                    <Tip label="Coleção de escrita desta categoria">
                      <PenLine
                        data-testid="memory-write-mark"
                        className="size-3 shrink-0 text-accent-strong"
                      />
                    </Tip>
                  )}
                  <span className="w-5 shrink-0 text-right text-[10.5px] text-faint tabular-nums">
                    {c.count ?? ''}
                  </span>
                </label>
              )
            })
          )}
          {issue && (
            <p className="flex items-center gap-1 px-1.5 pb-1 text-[11px] text-warning/90">
              <TriangleAlert className="size-3 shrink-0" /> Escrita sem efeito: {issue}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

function ManageLink(): React.JSX.Element {
  const openMemory = useStore((s) => s.openMemory)
  return (
    <button
      type="button"
      onClick={() => openMemory()}
      className="inline-flex items-center gap-1.5 text-[11.5px] text-accent-strong hover:underline"
    >
      <Settings2 className="size-3.5" /> Criar e editar memórias (Configurações → Memórias)
    </button>
  )
}

function ChatMemorySection({
  chat,
  mem,
  cols,
  onChange
}: {
  chat: Chat
  mem: MemoryConfig
  cols: MemoryCollection[]
  onChange: (m: MemoryConfig) => void
}): React.JSX.Element {
  const openMemory = useStore((s) => s.openMemory)
  const own = cols.filter((c) => c.scope === 'chat' && c.chatId === chat.id)
  const count = own.reduce((s, c) => s + (c.count ?? 0), 0)
  return (
    <Section title="Memória do chat" aside={<ChatMemoryInfo />}>
      <ToggleRow
        label="Memória do chat"
        description="O modelo decide: o que serve fora desta conversa vai para a coleção de escrita; o que só importa a esta tarefa fica em “Este chat”."
        checked={mem.chatMemory}
        onChange={(chatMemory) => onChange({ ...mem, chatMemory })}
      />
      {own.length > 0 && (
        <button
          type="button"
          data-testid="chat-memory-link"
          onClick={() => openMemory({ collectionId: own[0].id })}
          className="inline-flex items-center gap-1.5 text-[11.5px] text-subtle hover:text-fg"
        >
          {count} {count === 1 ? 'memória' : 'memórias'} neste chat
          <ArrowUpRight className="size-3" />
        </button>
      )}
    </Section>
  )
}

function HelpSection({
  mem,
  text,
  onChange
}: {
  mem: MemoryConfig
  text: string
  onChange: (m: MemoryConfig) => void
}): React.JSX.Element {
  const custom = mem.helpPrompt.text != null
  const [open, setOpen] = useState(false)
  return (
    <Section title="Instruções">
      <ToggleRow
        label="Instruções de memória no system prompt"
        description="Consultar antes de responder, gravar fatos novos, corrigir discrepâncias"
        checked={mem.helpPrompt.enabled}
        onChange={(enabled) => onChange({ ...mem, helpPrompt: { ...mem.helpPrompt, enabled } })}
        info={<MemoryHelpInfo text={text} />}
      />
      {mem.helpPrompt.enabled && (
        <PromptEditor
          title="Texto das instruções"
          custom={custom}
          open={open}
          setOpen={setOpen}
          value={text}
          onChange={(t) => onChange({ ...mem, helpPrompt: { ...mem.helpPrompt, text: t } })}
          onRestore={() => onChange({ ...mem, helpPrompt: { ...mem.helpPrompt, text: null } })}
        />
      )}
    </Section>
  )
}

function PromptEditor({
  title,
  custom,
  open,
  setOpen,
  value,
  onChange,
  onRestore,
  info
}: {
  title: string
  custom: boolean
  open: boolean
  setOpen: (v: boolean) => void
  value: string
  onChange: (v: string) => void
  onRestore: () => void
  info?: React.ReactNode
}): React.JSX.Element {
  return (
    <div>
      <div className="mb-1 flex items-center gap-1.5 text-[11px] text-subtle">
        <button type="button" onClick={() => setOpen(!open)} className="hover:text-fg">
          {open ? '▾' : '▸'} {title}
          {custom ? ' (personalizado)' : ''}
        </button>
        {info}
        {custom && (
          <button
            type="button"
            onClick={onRestore}
            className="ml-auto inline-flex items-center gap-1 hover:text-fg"
          >
            <RotateCcw className="size-3" /> Restaurar padrão
          </button>
        )}
      </div>
      {open && (
        <AutoTextarea
          value={value}
          aria-label={title}
          onChange={(e) => onChange(e.target.value)}
          minRows={4}
          maxRows={14}
          className="field animate-fade-in font-mono text-[11px] leading-relaxed"
        />
      )}
    </div>
  )
}

function ExtractionSection({
  mem,
  chat,
  willSend,
  onChange
}: {
  mem: MemoryConfig
  chat?: Chat
  willSend: boolean
  onChange: (m: MemoryConfig) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [running, setRunning] = useState(false)
  const toast = useStore((s) => s.toast)
  const flushConfig = useStore((s) => s.flushConfig)
  const ex = mem.extraction
  const prompt = ex.prompt ?? DEFAULT_MEMORY_EXTRACTION_PROMPT
  const hasModel = !!ex.providerId && !!ex.model
  const setEx = (p: Partial<MemoryConfig['extraction']>): void =>
    onChange({ ...mem, extraction: { ...ex, ...p } })

  const extractNow = async (): Promise<void> => {
    if (!chat) return
    setRunning(true)
    try {
      await flushConfig(chat.id)
      const r = await api.memory.extractNow(chat.mainSessionId)
      if (r.error) toast(`Extração de memórias falhou: ${r.error}`, 'error')
      else
        toast(
          r.created + r.updated + r.deleted
            ? `Extração de memórias: ${extractionCounts(r)}.`
            : 'Extração de memórias: nada novo para gravar.',
          'success'
        )
    } catch (err) {
      toast(`Extração de memórias falhou: ${errorMessage(err)}`, 'error')
    } finally {
      setRunning(false)
    }
  }

  return (
    <Section
      title="Extração"
      aside={
        <ExtractionPromptInfo
          prompt={prompt}
          model={hasModel ? `${ex.model}` : 'o modelo do chat'}
        />
      }
    >
      <ToggleRow
        label="Extrair automaticamente após compactar"
        description="Uma request separada lê a conversa e grava fatos duradouros"
        checked={ex.auto}
        onChange={(auto) => setEx({ auto })}
      />
      <div>
        <div className="mb-1.5 text-[11.5px] text-subtle">Modelo de extração</div>
        <div data-testid="memory-extraction-model" className="flex items-center gap-1.5">
          <ModelPicker
            className="min-w-0 flex-1"
            value={hasModel ? { providerId: ex.providerId!, model: ex.model! } : null}
            placeholder="Modelo do chat"
            onChange={(ref) => setEx({ providerId: ref.providerId, model: ref.model })}
          />
          {hasModel && (
            <Tip label="Usar o modelo do chat">
              <button
                type="button"
                aria-label="Usar o modelo do chat na extração"
                onClick={() => setEx({ providerId: null, model: null })}
                className="grid size-8 shrink-0 place-items-center rounded-lg text-subtle hover:bg-hover hover:text-fg"
              >
                <X className="size-3.5" />
              </button>
            </Tip>
          )}
        </div>
        {hasModel && (
          <p className="mt-1 text-[11px] text-faint">
            Extração com{' '}
            <ModelLabel
              providerId={ex.providerId!}
              model={ex.model!}
              short
              className="text-subtle"
            />
          </p>
        )}
      </div>
      <PromptEditor
        title="Prompt de extração"
        custom={ex.prompt != null}
        open={open}
        setOpen={setOpen}
        value={prompt}
        onChange={(t) => setEx({ prompt: t })}
        onRestore={() => setEx({ prompt: null })}
      />
      {chat && (
        <>
          <Button
            variant="secondary"
            className="w-full"
            data-testid="memory-extract-now"
            loading={running}
            disabled={!willSend}
            icon={<BrainCircuit className="size-3.5 text-accent-strong" />}
            onClick={() => void extractNow()}
          >
            {running ? 'Extraindo memórias…' : 'Extrair memórias agora'}
          </Button>
          {!willSend && (
            <p className="-mt-1 text-center text-[11px] text-subtle">
              Ligue a memória e ative uma coleção para extrair.
            </p>
          )}
        </>
      )}
    </Section>
  )
}

function SnapshotSection({
  sessionId,
  chatId,
  snapshotAt,
  willSend,
  onRefreshed
}: {
  sessionId: string
  chatId: string
  snapshotAt: number | null
  willSend: boolean
  onRefreshed: (p: import('@shared/memory').MemoryPreview) => void
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const toast = useStore((s) => s.toast)
  const flushConfig = useStore((s) => s.flushConfig)
  return (
    <Section title="Índice da sessão" aside={<MemoryRefreshInfo />}>
      <div className="flex items-center gap-2.5">
        <p
          data-testid="memory-snapshot"
          className="min-w-0 flex-1 text-[11.5px] leading-snug text-subtle"
        >
          {!willSend
            ? 'Sem índice — a memória não está ativa.'
            : snapshotAt
              ? `Índice congelado desde ${formatTime(snapshotAt)} — mudanças feitas fora deste chat entram ao atualizar.`
              : 'O índice é tirado na próxima request desta sessão.'}
        </p>
        <Button
          size="sm"
          variant="secondary"
          loading={busy}
          disabled={!willSend}
          icon={<RefreshCw className="size-3.5" />}
          onClick={() => {
            setBusy(true)
            void (async () => {
              try {
                await flushConfig(chatId)
                const p = await api.memory.refreshSnapshot(sessionId)
                onRefreshed(p)
                toast('Memória atualizada: a próxima request leva o índice novo.', 'success')
              } catch (err) {
                toast(`Erro ao atualizar a memória: ${errorMessage(err)}`, 'error')
              } finally {
                setBusy(false)
              }
            })()
          }}
        >
          Atualizar memória
        </Button>
      </div>
    </Section>
  )
}
