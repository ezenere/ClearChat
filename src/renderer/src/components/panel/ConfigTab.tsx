import { Braces, FolderOpen, Layers, RotateCcw } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  DEFAULT_COMPACT_PROMPT,
  DEFAULT_COMPACT_THRESHOLD,
  defaultToolsPrompt,
  isOpenRouter
} from '@shared/defaults'
import { LIMITS, approxTokens, clampToolOutput } from '@shared/limits'
import { TOOL_DEFINITIONS, TOOL_LABELS, TOOL_NAMES } from '@shared/tools'
import {
  CONFIRM_TOOLS,
  type Chat,
  type ChatConfig,
  type ChatParams,
  type ToolName
} from '@shared/types'
import { api } from '../../lib/api'
import { cn, compactPath, formatTokens } from '../../lib/format'
import { isBusy, useStore } from '../../store'
import { useContextInfo } from '../../lib/useContextInfo'
import {
  AutoApproveInfo,
  CacheInfo,
  CompactPromptInfo,
  ConfineInfo,
  ContextWindowInfo,
  EnvInfo,
  MaxOutputInfo,
  RootInfo,
  SandboxInfo,
  ExtraBodyInfo,
  ModelFieldInfo,
  NativeToolsInfo,
  ParamInfo,
  ProviderFieldInfo,
  SystemPromptInfo,
  ToolDefInfo,
  ToolsInPromptInfo
} from '../apiDocs'
import { AppSignatureField, AppSignatureInfo } from '../AppSignatureField'
import { AutoTextarea, Button, Switch } from '../ui/controls'
import { ModelCombobox } from '../ui/ModelCombobox'
import { Select } from '../ui/Select'

type NumParam = Exclude<keyof ChatParams, 'extraBody' | 'reasoning_effort'>

const NUM_PARAMS: {
  key: NumParam
  def: number
  step: number
  min?: number
  max?: number
  int?: boolean
}[] = [
  { key: 'temperature', def: 1, step: 0.1, min: 0, max: 2 },
  { key: 'top_p', def: 1, step: 0.05, min: 0, max: 1 },
  { key: 'top_k', def: 40, step: 1, min: 0, int: true },
  { key: 'max_tokens', def: 4096, step: 256, min: 1, int: true },
  { key: 'frequency_penalty', def: 0, step: 0.1, min: -2, max: 2 },
  { key: 'presence_penalty', def: 0, step: 0.1, min: -2, max: 2 },
  { key: 'repetition_penalty', def: 1, step: 0.05, min: 0, max: 2 },
  { key: 'seed', def: 0, step: 1, int: true }
]

const EFFORTS = ['minimal', 'low', 'medium', 'high'] as const

// Último valor usado de cada parâmetro (para religar o toggle sem perder o valor).
const remembered = new Map<string, Partial<Record<keyof ChatParams, unknown>>>()
function rememberedFor(chatId: string): Partial<Record<keyof ChatParams, unknown>> {
  let m = remembered.get(chatId)
  if (!m) remembered.set(chatId, (m = {}))
  return m
}

function Section({
  title,
  children,
  aside,
  id
}: {
  title: string
  children: ReactNode
  aside?: ReactNode
  id?: string
}): React.JSX.Element {
  return (
    <section
      data-section={id}
      className="scroll-mt-2 border-b border-border/70 px-4 py-4 last:border-b-0"
    >
      <div className="mb-3 flex items-center gap-2">
        <h3 className="text-[11px] font-semibold tracking-[0.06em] text-subtle uppercase">
          {title}
        </h3>
        {aside && <div className="ml-auto">{aside}</div>}
      </div>
      <div className="space-y-3">{children}</div>
    </section>
  )
}

function ToggleRow({
  label,
  checked,
  onChange,
  info,
  description
}: {
  label: string
  checked: boolean
  onChange: (v: boolean) => void
  info?: ReactNode
  description?: string
}): React.JSX.Element {
  return (
    <div className="flex items-start gap-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-[13px] text-fg/90">
          {label}
          {info}
        </div>
        {description && (
          <p className="mt-0.5 text-[11.5px] leading-snug text-subtle">{description}</p>
        )}
      </div>
      <div className="pt-0.5">
        <Switch checked={checked} onChange={onChange} label={label} />
      </div>
    </div>
  )
}

function NumberInput({
  value,
  disabled,
  step,
  min,
  max,
  int,
  wide,
  label,
  onCommit
}: {
  value: number | undefined
  disabled: boolean
  step: number
  min?: number
  max?: number
  int?: boolean
  wide?: boolean
  label?: string
  onCommit: (v: number) => void
}): React.JSX.Element {
  const [text, setText] = useState(value == null ? '' : String(value))
  const [prev, setPrev] = useState(value)
  if (prev !== value) {
    setPrev(value)
    setText(value == null ? '' : String(value))
  }
  return (
    <input
      type="number"
      value={text}
      step={step}
      min={min}
      max={max}
      disabled={disabled}
      aria-label={label}
      onChange={(e) => {
        setText(e.target.value)
        const n = int ? parseInt(e.target.value, 10) : parseFloat(e.target.value)
        if (!Number.isNaN(n)) onCommit(n)
      }}
      className={cn(
        'field h-7 px-2 py-0 text-right font-mono text-[12px] tabular-nums disabled:opacity-40 [&::-webkit-inner-spin-button]:opacity-40',
        wide ? 'w-[110px]' : 'w-[92px]'
      )}
    />
  )
}

function ExtraBodyEditor({
  value,
  onChange
}: {
  value: string | undefined
  onChange: (v: string | undefined) => void
}): React.JSX.Element {
  const [text, setText] = useState(value ?? '')
  const [prev, setPrev] = useState(value)
  if (prev !== value) {
    setPrev(value)
    if ((value ?? '') !== text && validate(text) === null) setText(value ?? '')
  }
  const error = validate(text)
  return (
    <div>
      <textarea
        value={text}
        spellCheck={false}
        placeholder={'{\n  "provider": { "order": ["anthropic"] }\n}'}
        onChange={(e) => {
          const t = e.target.value
          setText(t)
          if (validate(t) === null) onChange(t.trim() ? t : undefined)
        }}
        className={cn(
          'field min-h-[84px] resize-y font-mono text-[11.5px] leading-relaxed',
          error && 'border-danger/50 focus:border-danger/60'
        )}
      />
      <div className="mt-1 h-4 text-[11px]">
        {error ? (
          <span className="text-danger">{error} — não salvo</span>
        ) : text.trim() ? (
          <span className="text-success/80">JSON válido · mesclado no body</span>
        ) : (
          <span className="text-subtle">Vazio · nada é mesclado</span>
        )}
      </div>
    </div>
  )
}

function validate(text: string): string | null {
  if (!text.trim()) return null
  try {
    const v = JSON.parse(text)
    if (!v || typeof v !== 'object' || Array.isArray(v)) return 'Deve ser um objeto JSON'
    return null
  } catch (err) {
    return (err as Error).message.replace(/^JSON\.parse: /, '')
  }
}

function ContextSection({ chat }: { chat: Chat }): React.JSX.Element {
  const patchConfig = useStore((s) => s.patchConfig)
  const compact = useStore((s) => s.compact)
  const viewSessionId = useStore((s) => (s.view.kind === 'chat' ? s.view.sessionId : null))
  const viewSession = useStore((s) => (viewSessionId ? s.sessions[viewSessionId] : undefined))
  const mainSession = useStore((s) => s.sessions[chat.mainSessionId])
  const session = viewSession ?? mainSession
  const compacting = useStore((s) => (session ? s.compactions[session.id] : undefined))
  const [promptOpen, setPromptOpen] = useState(false)
  const c = chat.config
  const patch = (p: Partial<ChatConfig>): void => patchConfig(chat.id, p)
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
  const override = c.contextWindow != null && c.contextWindow > 0
  const prompt = c.compactPrompt ?? DEFAULT_COMPACT_PROMPT
  const isSub = !!session && session.depth > 0
  const pct = Math.round((c.compactThreshold ?? DEFAULT_COMPACT_THRESHOLD) * 100)
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
      <ToggleRow
        label="Definir janela manualmente"
        description="Para endpoints que não informam o tamanho do contexto"
        checked={override}
        onChange={(v) => patch({ contextWindow: v ? (info.window ?? 128_000) : null })}
      />
      {override && (
        <div className="flex animate-fade-in items-center gap-2.5 pl-1">
          <span className="min-w-0 flex-1 text-[12px] text-subtle">Janela (tokens)</span>
          <NumberInput
            value={c.contextWindow ?? undefined}
            disabled={false}
            step={1000}
            min={1}
            int
            wide
            label="Janela de contexto (tokens)"
            onCommit={(v) => v > 0 && patch({ contextWindow: v })}
          />
        </div>
      )}
      <div className="flex items-center gap-2.5">
        <span className="min-w-0 flex-1 text-[13px] text-fg/90">Sugerir compactação em</span>
        <NumberInput
          value={pct}
          disabled={false}
          step={1}
          min={10}
          max={100}
          int
          label="Limite para compactar (%)"
          onCommit={(v) => v >= 10 && v <= 100 && patch({ compactThreshold: Math.round(v) / 100 })}
        />
        <span className="text-[12px] text-subtle">%</span>
      </div>
      <ToggleRow
        label="Compactar automaticamente"
        description="Sessão principal, ao atingir o limite. Subagentes: sempre."
        checked={c.autoCompact}
        onChange={(autoCompact) => patch({ autoCompact })}
      />
      <div>
        <div className="mb-1 flex items-center gap-1.5 text-[11px] text-subtle">
          <button type="button" onClick={() => setPromptOpen((o) => !o)} className="hover:text-fg">
            {promptOpen ? '▾' : '▸'} Prompt de compactação
            {c.compactPrompt != null ? ' (personalizado)' : ''}
          </button>
          <CompactPromptInfo prompt={prompt} />
          {c.compactPrompt != null && (
            <button
              type="button"
              onClick={() => patch({ compactPrompt: null })}
              className="ml-auto inline-flex items-center gap-1 hover:text-fg"
            >
              <RotateCcw className="size-3" /> Restaurar padrão
            </button>
          )}
        </div>
        {promptOpen && (
          <AutoTextarea
            value={prompt}
            onChange={(e) => patch({ compactPrompt: e.target.value })}
            minRows={5}
            maxRows={16}
            className="field animate-fade-in font-mono text-[11px] leading-relaxed"
          />
        )}
      </div>
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

function RootSection({ chat }: { chat: Chat }): React.JSX.Element {
  const patchConfig = useStore((s) => s.patchConfig)
  const homeDir = useStore((s) => s.homeDir)
  const caps = useStore((s) => s.capabilities)
  const run = useStore((s) => s.run)
  const setPanel = useStore((s) => s.setPanel)
  const c = chat.config
  const patch = (p: Partial<ChatConfig>): void => patchConfig(chat.id, p)
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
      <ToggleRow
        label="Confinar ferramentas à raiz"
        description="Tools de arquivo recusam caminhos fora dela"
        checked={c.confineToRoot !== false}
        onChange={(confineToRoot) => patch({ confineToRoot })}
        info={<ConfineInfo />}
      />
      {caps.bwrap ? (
        <ToggleRow
          label="Bash em sandbox"
          description="bubblewrap: só a raiz é gravável; rede liberada"
          checked={!!c.sandboxBash}
          onChange={(sandboxBash) => patch({ sandboxBash })}
          info={<SandboxInfo />}
        />
      ) : (
        <p className="text-[11.5px] leading-snug text-subtle">
          Sandbox do bash indisponível: instale o <span className="font-mono">bubblewrap</span>{' '}
          (bwrap) para isolar o terminal na raiz.
        </p>
      )}
    </Section>
  )
}

function LimitsSection({ chat }: { chat: Chat }): React.JSX.Element {
  const patchConfig = useStore((s) => s.patchConfig)
  const max = clampToolOutput(chat.config.maxToolOutputChars)
  return (
    <Section title="Limites" aside={<MaxOutputInfo />}>
      <div className="flex items-center gap-2.5">
        <div className="min-w-0 flex-1">
          <div className="text-[13px] text-fg/90">Saída máx. por ferramenta</div>
          <p className="mt-0.5 text-[11.5px] text-subtle">
            caracteres · ≈ {formatTokens(approxTokens(max))} tokens por resultado
          </p>
        </div>
        <NumberInput
          value={chat.config.maxToolOutputChars ?? LIMITS.maxToolOutputChars}
          disabled={false}
          step={1000}
          min={LIMITS.minToolOutputChars}
          max={LIMITS.maxToolOutputCharsCap}
          int
          wide
          label="Saída máxima por ferramenta (caracteres)"
          onCommit={(v) =>
            v >= LIMITS.minToolOutputChars &&
            patchConfig(chat.id, { maxToolOutputChars: clampToolOutput(v) })
          }
        />
      </div>
    </Section>
  )
}

export function ConfigTab({ chat }: { chat: Chat }): React.JSX.Element {
  const providers = useStore((s) => s.providers)
  const patchConfig = useStore((s) => s.patchConfig)
  const setPreview = useStore((s) => s.setPreview)
  const viewSessionId = useStore((s) => (s.view.kind === 'chat' ? s.view.sessionId : null))
  const viewSession = useStore((s) => (viewSessionId ? s.sessions[viewSessionId] : undefined))
  const c = chat.config
  const patch = (p: Partial<ChatConfig>): void => patchConfig(chat.id, p)
  const provider = providers.find((p) => p.id === c.providerId)
  const openRouter = provider ? isOpenRouter(provider.baseUrl) : false

  const mem = rememberedFor(chat.id)

  const setParam = <K extends keyof ChatParams>(key: K, value: ChatParams[K] | undefined): void => {
    const next: Record<string, unknown> = { ...c.params }
    if (value === undefined) {
      if (next[key] != null) rememberedFor(chat.id)[key] = next[key]
      // null (não `delete`): o main faz merge de params e só remove chaves explicitamente nulas
      next[key] = null
    } else next[key] = value
    patch({ params: next as ChatParams })
  }

  const autoAll = CONFIRM_TOOLS.every((t) => c.autoApprove.includes(t))
  const autoSome = CONFIRM_TOOLS.some((t) => c.autoApprove.includes(t))

  const enabledDefs = TOOL_NAMES.filter((t) => c.enabledTools.includes(t)).map(
    (t) => TOOL_DEFINITIONS[t]
  )
  const generatedToolsText = defaultToolsPrompt(enabledDefs, c.nativeTools)
  const toolsText = c.toolsPromptText ?? generatedToolsText

  const configFocus = useStore((s) => s.configFocus)
  const focusConfig = useStore((s) => s.focusConfig)
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!configFocus) return
    const el = rootRef.current?.querySelector<HTMLElement>(`[data-section="${configFocus}"]`)
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' })
      el.classList.add('animate-flash')
      setTimeout(() => el.classList.remove('animate-flash'), 1200)
    }
    focusConfig(null)
  }, [configFocus, focusConfig])

  const toggleTool = (t: ToolName, on: boolean): void =>
    patch({
      enabledTools: on
        ? TOOL_NAMES.filter((n) => n === t || c.enabledTools.includes(n))
        : c.enabledTools.filter((n) => n !== t)
    })

  return (
    <div ref={rootRef}>
      <div className="px-4 pt-4 pb-1">
        <Button
          variant="secondary"
          className="w-full"
          icon={<Braces className="size-3.5 text-accent-strong" />}
          onClick={() => setPreview(viewSessionId ?? chat.mainSessionId)}
        >
          Ver request
        </Button>
        <p className="mt-2 text-center text-[11px] text-subtle">
          Alterações são salvas automaticamente.
        </p>
        {viewSession && viewSession.depth > 0 && (
          <p className="mt-3 rounded-lg border border-accent/20 bg-accent-soft/40 px-3 py-2 text-[11.5px] leading-snug text-muted">
            Configuração do chat (compartilhada). Esta subsessão usa o modelo{' '}
            <span className="font-mono text-fg/90">{viewSession.model}</span> e o system prompt de
            subagentes (seção Subagentes); &quot;Ver request&quot; mostra a request dela.
          </p>
        )}
      </div>

      <Section title="Modelo">
        <div>
          <div className="mb-1.5 flex items-center gap-1.5 text-xs text-muted">
            Provedor <ProviderFieldInfo />
          </div>
          <Select
            value={c.providerId}
            onChange={(providerId) => patch({ providerId })}
            options={providers.map((p) => ({ value: p.id, label: p.name, description: p.baseUrl }))}
          />
        </div>
        <div>
          <div className="mb-1.5 flex items-center gap-1.5 text-xs text-muted">
            Modelo <ModelFieldInfo side="left" />
          </div>
          <ModelCombobox
            providerId={c.providerId}
            value={c.model}
            onChange={(model) => patch({ model })}
          />
        </div>
      </Section>

      <RootSection chat={chat} />

      <ContextSection chat={chat} />

      <Section
        title="Assinatura do app"
        aside={<AppSignatureInfo id={c.appSignature} custom={c.appSignatureCustom} />}
      >
        <AppSignatureField
          value={c.appSignature}
          custom={c.appSignatureCustom}
          onChange={(p) => patch(p)}
        />
      </Section>

      <Section title="System prompt" aside={<SystemPromptInfo side="left" />}>
        <AutoTextarea
          value={c.systemPrompt}
          onChange={(e) => patch({ systemPrompt: e.target.value })}
          minRows={4}
          maxRows={14}
          placeholder="(vazio)"
          className="field text-[12.5px] leading-relaxed"
        />
      </Section>

      <Section title="Parâmetros">
        <p className="-mt-1 text-[11.5px] text-subtle">
          Só os parâmetros ligados entram na request.
        </p>
        <div className="space-y-1">
          {NUM_PARAMS.map((p) => {
            const on = c.params[p.key] != null
            return (
              <div key={p.key} className="flex h-8 items-center gap-2.5">
                <Switch
                  size="sm"
                  checked={on}
                  label={`Enviar ${p.key}`}
                  onChange={(v) =>
                    setParam(p.key, v ? ((mem[p.key] as number | undefined) ?? p.def) : undefined)
                  }
                />
                <span
                  className={cn(
                    'min-w-0 flex-1 truncate font-mono text-[12px]',
                    on ? 'text-fg/90' : 'text-subtle'
                  )}
                >
                  {p.key}
                </span>
                <ParamInfo name={p.key} openRouter={openRouter} />
                <NumberInput
                  value={on ? c.params[p.key] : ((mem[p.key] as number | undefined) ?? p.def)}
                  disabled={!on}
                  step={p.step}
                  min={p.min}
                  max={p.max}
                  int={p.int}
                  label={p.key}
                  onCommit={(v) => setParam(p.key, v)}
                />
              </div>
            )
          })}
          <div className="flex h-8 items-center gap-2.5">
            <Switch
              size="sm"
              checked={c.params.reasoning_effort != null}
              label="Enviar reasoning_effort"
              onChange={(v) =>
                setParam(
                  'reasoning_effort',
                  v
                    ? ((mem.reasoning_effort as ChatParams['reasoning_effort']) ?? 'medium')
                    : undefined
                )
              }
            />
            <span
              className={cn(
                'min-w-0 flex-1 truncate font-mono text-[12px]',
                c.params.reasoning_effort != null ? 'text-fg/90' : 'text-subtle'
              )}
            >
              reasoning_effort
            </span>
            <ParamInfo name="reasoning_effort" openRouter={openRouter} />
          </div>
          {c.params.reasoning_effort != null && (
            <div className="ml-[38px] flex animate-fade-in rounded-lg border border-border bg-bg/60 p-0.5">
              {EFFORTS.map((e) => (
                <button
                  key={e}
                  type="button"
                  onClick={() => setParam('reasoning_effort', e)}
                  className={cn(
                    'flex-1 rounded-md py-1 text-[11.5px] transition-colors',
                    c.params.reasoning_effort === e
                      ? 'bg-active text-fg shadow-sm'
                      : 'text-subtle hover:text-fg'
                  )}
                >
                  {e}
                </button>
              ))}
            </div>
          )}
        </div>
      </Section>

      <Section title="Body extra (JSON)" aside={<ExtraBodyInfo />}>
        <ExtraBodyEditor
          key={chat.id}
          value={c.params.extraBody}
          onChange={(v) => setParam('extraBody', v)}
        />
      </Section>

      <Section title="Ferramentas">
        <div className="-mx-1.5 space-y-px">
          {TOOL_NAMES.map((t) => {
            const on = c.enabledTools.includes(t)
            return (
              <div
                key={t}
                className="flex h-8 items-center gap-2.5 rounded-lg px-1.5 hover:bg-hover/50"
              >
                <Switch
                  size="sm"
                  checked={on}
                  label={TOOL_LABELS[t]}
                  onChange={(v) => toggleTool(t, v)}
                />
                <span
                  className={cn(
                    'min-w-0 flex-1 truncate text-[12.5px]',
                    on ? 'text-fg/90' : 'text-subtle'
                  )}
                >
                  {TOOL_LABELS[t]}
                </span>
                <span className="font-mono text-[10.5px] text-faint">{t}</span>
                <ToolDefInfo name={t} nativeTools={c.nativeTools} />
              </div>
            )
          })}
        </div>
      </Section>

      <Section title="Prompt e request">
        <ToggleRow
          label="Enviar tools nativas"
          description="Campo tools da request"
          checked={c.nativeTools}
          onChange={(nativeTools) => patch({ nativeTools })}
          info={<NativeToolsInfo />}
        />
        <ToggleRow
          label="Texto das tools no system prompt"
          description="Anexado ao final do system prompt"
          checked={c.toolsInPrompt}
          onChange={(toolsInPrompt) => patch({ toolsInPrompt })}
          info={<ToolsInPromptInfo text={toolsText} />}
        />
        {c.toolsInPrompt && (
          <div className="animate-fade-in">
            <div className="mb-1 flex items-center text-[11px] text-subtle">
              {c.toolsPromptText == null
                ? 'Texto padrão (gerado das tools habilitadas)'
                : 'Texto personalizado'}
              {c.toolsPromptText != null && (
                <button
                  type="button"
                  onClick={() => patch({ toolsPromptText: null })}
                  className="ml-auto inline-flex items-center gap-1 hover:text-fg"
                >
                  <RotateCcw className="size-3" /> Restaurar padrão
                </button>
              )}
            </div>
            <AutoTextarea
              value={toolsText}
              onChange={(e) => patch({ toolsPromptText: e.target.value })}
              minRows={4}
              maxRows={14}
              className="field font-mono text-[11px] leading-relaxed"
            />
          </div>
        )}
        <ToggleRow
          label="Bloco de ambiente"
          description="Diretório raiz, SO, shell e regras no system prompt"
          checked={c.envInPrompt}
          onChange={(envInPrompt) => patch({ envInPrompt })}
          info={
            <EnvInfo
              sessionId={chat.mainSessionId}
              cwd={c.cwd}
              deps={`${c.confineToRoot}|${c.sandboxBash}`}
            />
          }
        />
        <ToggleRow
          label="Token caching"
          description="Breakpoints cache_control"
          checked={c.cacheEnabled}
          onChange={(cacheEnabled) => patch({ cacheEnabled })}
          info={<CacheInfo />}
        />
      </Section>

      <LimitsSection chat={chat} />

      <Section title="Subagentes" aside={<SystemPromptInfo subagent side="left" />}>
        <AutoTextarea
          value={c.subagentSystemPrompt}
          onChange={(e) => patch({ subagentSystemPrompt: e.target.value })}
          minRows={4}
          maxRows={14}
          className="field text-[12.5px] leading-relaxed"
        />
      </Section>

      <Section title="Aprovação automática" aside={<AutoApproveInfo />}>
        <div className="flex items-start gap-3 rounded-lg border border-border bg-bg/40 px-3 py-2.5">
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium text-fg/90">Auto-aprovar tudo</div>
            <p className="mt-0.5 text-[11.5px] leading-snug text-subtle">
              {autoAll
                ? 'Terminal, pesquisa e navegação rodam sem pedir confirmação.'
                : autoSome
                  ? 'Parcial: algumas ferramentas rodam sem confirmação.'
                  : 'O app pede sua confirmação antes de cada execução.'}
            </p>
          </div>
          <div className="pt-0.5">
            <Switch
              checked={autoAll}
              indeterminate={autoSome && !autoAll}
              label="Auto-aprovar tudo"
              onChange={(v) => patch({ autoApprove: v ? [...CONFIRM_TOOLS] : [] })}
            />
          </div>
        </div>
        {CONFIRM_TOOLS.map((t) => (
          <ToggleRow
            key={t}
            label={TOOL_LABELS[t]}
            checked={c.autoApprove.includes(t)}
            onChange={(v) =>
              patch({
                autoApprove: v
                  ? [...c.autoApprove.filter((x) => x !== t), t]
                  : c.autoApprove.filter((x) => x !== t)
              })
            }
          />
        ))}
      </Section>
    </div>
  )
}
