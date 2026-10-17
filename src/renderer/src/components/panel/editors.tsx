// Editores de ChatConfig independentes de onde a config mora: recebem `cfg` (config completa) e
// `patch` (patch parcial). Usados pelas abas do painel (config do chat) e pelo editor de personas.
import { ArrowUpRight, BrainCircuit, RotateCcw } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import {
  DEFAULT_COMPACT_PROMPT,
  DEFAULT_COMPACT_THRESHOLD,
  defaultToolsPrompt
} from '@shared/defaults'
import { providerKind, type ProviderKind } from '@shared/providerKinds'
import {
  conflictOmitted,
  effortSpec,
  paramSupport,
  safeExtraBody,
  sortEfforts,
  type ParamKey,
  type ParamSupport
} from '@shared/modelParams'
import { LIMITS, approxTokens, clampToolOutput } from '@shared/limits'
import { currentToolDefinition, TOOL_LABELS, TOOL_NAMES } from '@shared/tools'
import type { ChatConfig, ChatParams, ToolName } from '@shared/types'
import { cn, formatTokens, modelMeta } from '../../lib/format'
import { useStore } from '../../store'
import {
  CacheInfo,
  CompactPromptInfo,
  ConfineInfo,
  ContextWindowInfo,
  EnvInfo,
  ExtraBodyInfo,
  MaxOutputInfo,
  ModelFieldInfo,
  NativeToolsInfo,
  ParamInfo,
  SandboxInfo,
  SystemPromptInfo,
  ToolDefInfo,
  ToolsInPromptInfo
} from '../apiDocs'
import { AppSignatureField, AppSignatureInfo } from '../AppSignatureField'
import { AutoTextarea, Switch } from '../ui/controls'
import { ModelPicker } from '../ui/ModelPicker'
import { ExtraBodyEditor, NumberInput, Section, ToggleRow } from './fields'
import { SmartApproveSection } from './SmartApproveSection'
import { ChatApprovalSection } from '../approvals/ChatApprovalSection'
import { memoryConfigOf, memoryWillSend } from '../../lib/memory'
import { useMemoryCollections } from '../memory/hooks'

export interface CfgProps {
  cfg: ChatConfig
  patch: (p: Partial<ChatConfig>) => void
}

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

// Último valor usado de cada parâmetro (para religar o toggle sem perder o valor), por escopo.
const remembered = new Map<string, Partial<Record<keyof ChatParams, unknown>>>()
function rememberedFor(scope: string): Partial<Record<keyof ChatParams, unknown>> {
  let m = remembered.get(scope)
  if (!m) remembered.set(scope, (m = {}))
  return m
}

/** Patch de um parâmetro: `undefined` desliga (vai `null` — o main só remove chaves nulas). */
function useSetParam(
  cfg: ChatConfig,
  patch: CfgProps['patch'],
  scope: string
): <K extends keyof ChatParams>(key: K, value: ChatParams[K] | undefined) => void {
  return (key, value) => {
    const next: Record<string, unknown> = { ...cfg.params }
    if (value === undefined) {
      if (next[key] != null) rememberedFor(scope)[key] = next[key]
      next[key] = null
    } else next[key] = value
    patch({ params: next as ChatParams })
  }
}

// ---------------- Modelo ----------------

/** Contexto / preço / tools do modelo escolhido (lista do provedor). */
export function ModelInfoLine({
  providerId,
  model
}: {
  providerId: string
  model: string
}): React.JSX.Element | null {
  const entry = useStore((s) => (providerId ? s.models[providerId] : undefined))
  if (!model.trim() || !entry || entry.status === 'loading') return null
  const m = entry.list.find((x) => x.id === model)
  if (!m) {
    return entry.status === 'ok' ? (
      <p className="text-[11px] text-subtle">Fora da lista do provedor (ID livre).</p>
    ) : null
  }
  const meta = modelMeta(m)
  if (m.supportsTools) meta.push('tools')
  if (!meta.length) return null
  return (
    <div data-testid="model-info" className="flex flex-wrap gap-1">
      {meta.map((t) => (
        <span
          key={t}
          className="rounded-md border border-border bg-bg/50 px-1.5 py-px font-mono text-[10.5px] text-subtle tabular-nums"
        >
          {t}
        </span>
      ))}
    </div>
  )
}

export function ModelSection({
  cfg,
  patch,
  note
}: CfgProps & { note?: ReactNode }): React.JSX.Element {
  return (
    <Section title="Modelo" aside={<ModelFieldInfo side="left" />}>
      <div>
        <ModelPicker
          value={{ providerId: cfg.providerId, model: cfg.model }}
          onChange={(ref) => patch({ providerId: ref.providerId, model: ref.model })}
        />
        <div className="mt-1.5 empty:hidden">
          <ModelInfoLine providerId={cfg.providerId} model={cfg.model} />
        </div>
        {note && <div className="mt-1.5">{note}</div>}
      </div>
    </Section>
  )
}

export function SystemPromptSection({ cfg, patch }: CfgProps): React.JSX.Element {
  return (
    <Section title="System prompt" aside={<SystemPromptInfo side="left" />}>
      <AutoTextarea
        value={cfg.systemPrompt}
        aria-label="System prompt"
        onChange={(e) => patch({ systemPrompt: e.target.value })}
        minRows={4}
        maxRows={14}
        placeholder="(vazio)"
        className="field text-[12.5px] leading-relaxed"
      />
    </Section>
  )
}

function useProviderKind(providerId: string): ProviderKind {
  const provider = useStore((s) => s.providers.find((p) => p.id === providerId))
  return provider ? providerKind(provider) : 'openai'
}

/**
 * O que o modelo do chat aceita (@shared/modelParams): o painel só mostra estes. Sem modelo →
 * tudo. Os valores salvos dos ocultos ficam no chat (voltam ao trocar para um modelo que aceite).
 */
function useParamSupport(cfg: ChatConfig): ParamSupport | null {
  const provider = useStore((s) => s.providers.find((p) => p.id === cfg.providerId))
  const info = useStore((s) =>
    cfg.providerId ? s.models[cfg.providerId]?.list.find((m) => m.id === cfg.model) : undefined
  )
  if (!provider || !cfg.model.trim()) return null
  return paramSupport({
    kind: providerKind(provider),
    model: cfg.model,
    info,
    extra: safeExtraBody(cfg.params.extraBody),
    params: cfg.params
  })
}

export function ParamsSection({
  cfg,
  patch,
  scope
}: CfgProps & { scope: string }): React.JSX.Element {
  const kind = useProviderKind(cfg.providerId)
  const openRouter = kind === 'openrouter'
  const setParam = useSetParam(cfg, patch, scope)
  const mem = rememberedFor(scope)
  const support = useParamSupport(cfg)
  // Níveis de reasoning_effort do modelo (API → tabela → conjunto comum). Sem modelo: conjunto comum.
  const effort = support ? support.effort : effortSpec({ kind, model: cfg.model })
  const effortValue = cfg.params.reasoning_effort ?? undefined
  // Níveis desconhecidos: o valor salvo (de outro modelo) continua selecionável
  const effortLevels = !effort
    ? []
    : effort.known || !effortValue || effort.levels.includes(effortValue)
      ? effort.levels
      : sortEfforts([...effort.levels, effortValue])
  const effortAdjust = support?.effortAdjust
  const visible = (k: ParamKey): boolean => !support || support.supported.includes(k)
  const conflicts = support ? conflictOmitted(support) : new Set<ParamKey>()
  /** Liga um parâmetro; se ele tiver par exclusivo (ex.: temperature/top_p no Claude 4.x), desliga o outro. */
  const turnOn = (key: NumParam, value: number): void => {
    const other = support?.exclusive.flatMap(([a, b]) =>
      a === key ? [b] : b === key ? [a] : []
    )[0]
    if (!other || cfg.params[other] == null) return setParam(key, value)
    rememberedFor(scope)[other] = cfg.params[other]
    patch({ params: { ...cfg.params, [key]: value, [other]: null } as unknown as ChatParams })
  }
  return (
    <Section title="Parâmetros">
      <p className="-mt-1 text-[11.5px] text-subtle">
        Só os parâmetros ligados entram na request
        {support && support.supported.length < NUM_PARAMS.length + 1
          ? ' (os que o modelo não aceita ficam ocultos).'
          : '.'}
      </p>
      <div className="space-y-1">
        {NUM_PARAMS.filter((p) => visible(p.key)).map((p) => {
          const on = cfg.params[p.key] != null
          const conflict =
            on && conflicts.has(p.key)
              ? support?.omitted.find((o) => o.key === p.key)?.reason
              : undefined
          return (
            <div key={p.key}>
              <div className="flex h-8 items-center gap-2.5">
                <Switch
                  size="sm"
                  checked={on}
                  label={`Enviar ${p.key}`}
                  onChange={(v) =>
                    v
                      ? turnOn(p.key, (mem[p.key] as number | undefined) ?? p.def)
                      : setParam(p.key, undefined)
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
                  value={
                    on
                      ? (cfg.params[p.key] as number)
                      : ((mem[p.key] as number | undefined) ?? p.def)
                  }
                  disabled={!on}
                  step={p.step}
                  min={p.min}
                  max={p.max}
                  int={p.int}
                  label={p.key}
                  onCommit={(v) => setParam(p.key, v)}
                />
              </div>
              {conflict && (
                <p
                  data-testid={`param-conflict-${p.key}`}
                  className="ml-[38px] text-[11px] text-subtle"
                >
                  Não enviado: {conflict}.
                </p>
              )}
            </div>
          )
        })}
        {visible('reasoning_effort') && (
          <div className="flex h-8 items-center gap-2.5">
            <Switch
              size="sm"
              checked={cfg.params.reasoning_effort != null}
              label="Enviar reasoning_effort"
              onChange={(v) => {
                if (!v) return setParam('reasoning_effort', undefined)
                const last = mem.reasoning_effort as ChatParams['reasoning_effort']
                setParam(
                  'reasoning_effort',
                  last && effortLevels.includes(last) ? last : (effort?.default ?? 'medium')
                )
              }}
            />
            <span
              className={cn(
                'min-w-0 flex-1 truncate font-mono text-[12px]',
                cfg.params.reasoning_effort != null ? 'text-fg/90' : 'text-subtle'
              )}
            >
              reasoning_effort
            </span>
            <ParamInfo name="reasoning_effort" openRouter={openRouter} effort={effort} />
          </div>
        )}
        {visible('reasoning_effort') && cfg.params.reasoning_effort != null && (
          <div className="ml-[38px] animate-fade-in">
            <div
              data-testid="effort-levels"
              data-source={effort?.source}
              className="flex rounded-lg border border-border bg-bg/60 p-0.5"
            >
              {effortLevels.map((e) => (
                <button
                  key={e}
                  type="button"
                  aria-pressed={cfg.params.reasoning_effort === e}
                  onClick={() => setParam('reasoning_effort', e)}
                  className={cn(
                    'min-w-0 flex-1 truncate rounded-md px-0.5 py-1 text-[11px] transition-colors',
                    cfg.params.reasoning_effort === e
                      ? 'bg-active text-fg shadow-sm'
                      : 'text-subtle hover:text-fg'
                  )}
                >
                  {e}
                </button>
              ))}
            </div>
            {effortAdjust && (
              <p data-testid="effort-adjust" className="mt-1 text-[11px] text-subtle">
                {effortAdjust.to ? 'Ajustado' : 'Não enviado'}: {effortAdjust.reason}.
              </p>
            )}
          </div>
        )}
      </div>
    </Section>
  )
}

export function RequestExtrasSection({
  cfg,
  patch,
  scope
}: CfgProps & { scope: string }): React.JSX.Element {
  const setParam = useSetParam(cfg, patch, scope)
  return (
    <Section title="Request">
      <ToggleRow
        label="Token caching"
        description="Breakpoints cache_control — depende do modelo/provedor"
        checked={cfg.cacheEnabled}
        onChange={(cacheEnabled) => patch({ cacheEnabled })}
        info={<CacheInfo />}
      />
      <div>
        <div className="mb-1.5 flex items-center gap-1.5 text-xs text-muted">
          Body extra (JSON) <ExtraBodyInfo />
        </div>
        <ExtraBodyEditor
          key={scope}
          value={cfg.params.extraBody}
          onChange={(v) => setParam('extraBody', v)}
        />
      </div>
    </Section>
  )
}

/** Aba Modelo inteira (painel e editor de persona). */
export function ModelEditor(
  props: CfgProps & { scope: string; modelNote?: ReactNode }
): React.JSX.Element {
  return (
    <>
      <ModelSection cfg={props.cfg} patch={props.patch} note={props.modelNote} />
      <SystemPromptSection {...props} />
      <ParamsSection {...props} />
      <RequestExtrasSection {...props} />
    </>
  )
}

// ---------------- Chat ----------------

/** Confinar / sandbox / bloco de ambiente (o caminho da raiz fica com quem chama). */
export function RootOptions({
  cfg,
  patch,
  sessionId
}: CfgProps & { sessionId?: string }): React.JSX.Element {
  const caps = useStore((s) => s.capabilities)
  return (
    <>
      <ToggleRow
        label="Confinar ferramentas à raiz"
        description="Tools de arquivo recusam caminhos fora dela"
        checked={cfg.confineToRoot !== false}
        onChange={(confineToRoot) => patch({ confineToRoot })}
        info={<ConfineInfo />}
      />
      {caps.bwrap ? (
        <ToggleRow
          label="Shell em sandbox"
          description="bubblewrap: só a raiz é gravável; rede liberada"
          checked={!!cfg.sandboxBash}
          onChange={(sandboxBash) => patch({ sandboxBash })}
          info={<SandboxInfo />}
        />
      ) : (
        <p className="text-[11.5px] leading-snug text-subtle">
          Sandbox do shell indisponível: instale o <span className="font-mono">bubblewrap</span>{' '}
          (bwrap) para isolar o terminal na raiz.
        </p>
      )}
      <ToggleRow
        label="Bloco de ambiente"
        description="Raiz, SO, shell e regras no system prompt"
        checked={cfg.envInPrompt}
        onChange={(envInPrompt) => patch({ envInPrompt })}
        info={
          <EnvInfo
            sessionId={sessionId}
            cwd={cfg.cwd}
            deps={`${cfg.confineToRoot}|${cfg.sandboxBash}`}
          />
        }
      />
    </>
  )
}

export function SignatureSection({ cfg, patch }: CfgProps): React.JSX.Element {
  return (
    <Section
      title="Assinatura do app"
      aside={<AppSignatureInfo id={cfg.appSignature} custom={cfg.appSignatureCustom} />}
    >
      <AppSignatureField
        value={cfg.appSignature}
        custom={cfg.appSignatureCustom}
        onChange={(p) => patch(p)}
      />
    </Section>
  )
}

/** Ajustes de contexto/compactação (sem o medidor nem o botão Compactar). */
export function ContextSettings({
  cfg,
  patch,
  knownWindow
}: CfgProps & { knownWindow?: number | null }): React.JSX.Element {
  const [promptOpen, setPromptOpen] = useState(false)
  const override = cfg.contextWindow != null && cfg.contextWindow > 0
  const prompt = cfg.compactPrompt ?? DEFAULT_COMPACT_PROMPT
  const pct = Math.round((cfg.compactThreshold ?? DEFAULT_COMPACT_THRESHOLD) * 100)
  return (
    <>
      <ToggleRow
        label="Definir janela manualmente"
        description="Para endpoints que não informam o tamanho do contexto"
        checked={override}
        onChange={(v) => patch({ contextWindow: v ? (knownWindow ?? 128_000) : null })}
      />
      {override && (
        <div className="flex animate-fade-in items-center gap-2.5 pl-1">
          <span className="min-w-0 flex-1 text-[12px] text-subtle">Janela (tokens)</span>
          <NumberInput
            value={cfg.contextWindow ?? undefined}
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
        checked={cfg.autoCompact}
        onChange={(autoCompact) => patch({ autoCompact })}
      />
      <div>
        <div className="mb-1 flex items-center gap-1.5 text-[11px] text-subtle">
          <button type="button" onClick={() => setPromptOpen((o) => !o)} className="hover:text-fg">
            {promptOpen ? '▾' : '▸'} Prompt de compactação
            {cfg.compactPrompt != null ? ' (personalizado)' : ''}
          </button>
          <CompactPromptInfo prompt={prompt} />
          {cfg.compactPrompt != null && (
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
            aria-label="Prompt de compactação"
            onChange={(e) => patch({ compactPrompt: e.target.value })}
            minRows={5}
            maxRows={16}
            className="field animate-fade-in font-mono text-[11px] leading-relaxed"
          />
        )}
      </div>
    </>
  )
}

export function ContextSettingsSection(
  props: CfgProps & { knownWindow?: number | null }
): React.JSX.Element {
  return (
    <Section title="Contexto" aside={<ContextWindowInfo />}>
      <ContextSettings {...props} />
    </Section>
  )
}

// ---------------- Tools ----------------

export function ToolsListSection({ cfg, patch }: CfgProps): React.JSX.Element {
  const toggleTool = (t: ToolName, on: boolean): void =>
    patch({
      enabledTools: on
        ? TOOL_NAMES.filter((n) => n === t || cfg.enabledTools.includes(n))
        : cfg.enabledTools.filter((n) => n !== t)
    })
  const count = TOOL_NAMES.filter((t) => cfg.enabledTools.includes(t)).length
  return (
    <Section
      title="Ferramentas"
      aside={
        <span className="text-[11px] text-subtle tabular-nums">
          {count}/{TOOL_NAMES.length}
        </span>
      }
    >
      <div className="-mx-1.5 space-y-px">
        {TOOL_NAMES.map((t) => {
          const on = cfg.enabledTools.includes(t)
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
              <span className="truncate font-mono text-[10.5px] text-faint">{t}</span>
              <ToolDefInfo name={t} nativeTools={cfg.nativeTools} />
            </div>
          )
        })}
      </div>
    </Section>
  )
}

export function ToolsPromptSection({ cfg, patch }: CfgProps): React.JSX.Element {
  const enabledDefs = TOOL_NAMES.filter((t) => cfg.enabledTools.includes(t)).map((t) =>
    currentToolDefinition(t)
  )
  const toolsText = cfg.toolsPromptText ?? defaultToolsPrompt(enabledDefs, cfg.nativeTools)
  return (
    <Section title="Envio das tools">
      <ToggleRow
        label="Enviar tools nativas"
        description="Campo tools da request"
        checked={cfg.nativeTools}
        onChange={(nativeTools) => patch({ nativeTools })}
        info={<NativeToolsInfo />}
      />
      <ToggleRow
        label="Texto das tools no system prompt"
        description="Anexado ao final do system prompt"
        checked={cfg.toolsInPrompt}
        onChange={(toolsInPrompt) => patch({ toolsInPrompt })}
        info={<ToolsInPromptInfo text={toolsText} />}
      />
      {cfg.toolsInPrompt && (
        <div className="animate-fade-in">
          <div className="mb-1 flex items-center text-[11px] text-subtle">
            {cfg.toolsPromptText == null
              ? 'Texto padrão (gerado das tools habilitadas)'
              : 'Texto personalizado'}
            {cfg.toolsPromptText != null && (
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
            aria-label="Texto das tools"
            onChange={(e) => patch({ toolsPromptText: e.target.value })}
            minRows={4}
            maxRows={14}
            className="field font-mono text-[11px] leading-relaxed"
          />
        </div>
      )}
    </Section>
  )
}

/** Aba Tools → Subagentes: memória liberada para subagentes? (link para a seção de memória). */
function SubagentMemoryLine({
  cfg,
  chatScope,
  onOpenMemory
}: {
  cfg: ChatConfig
  chatScope?: boolean
  onOpenMemory?: () => void
}): React.JSX.Element {
  const cols = useMemoryCollections()
  const focusConfig = useStore((s) => s.focusConfig)
  const mem = memoryConfigOf(cfg)
  const active = memoryWillSend(mem, cols)
  const on = mem.subagents && active
  const open = onOpenMemory ?? (() => focusConfig('memoria-subagentes'))
  return (
    <div
      data-testid="subagent-memory"
      data-on={on || undefined}
      className="flex items-center gap-2 rounded-lg border border-border bg-bg/40 px-2.5 py-1.5 text-[12px]"
    >
      <BrainCircuit className={cn('size-3.5 shrink-0', on ? 'text-accent-strong' : 'text-faint')} />
      <span className="min-w-0 flex-1 text-muted">
        Memória para subagentes:{' '}
        <span className={on ? 'text-fg/90' : 'text-subtle'}>
          {mem.subagents ? 'ligada' : 'desligada'}
        </span>
        {mem.subagents && !active && (
          <span className="text-warning/85">
            {' '}
            · memória desligada {chatScope ? 'neste chat' : 'nesta persona'}
          </span>
        )}
        {on && <span className="text-subtle"> · só busca/leitura</span>}
      </span>
      <button
        type="button"
        onClick={open}
        className="inline-flex shrink-0 items-center gap-0.5 text-[11.5px] text-accent-strong hover:underline"
      >
        Memória <ArrowUpRight className="size-3" />
      </button>
    </div>
  )
}

export function SubagentSection({
  cfg,
  patch,
  chatScope,
  onOpenMemory
}: CfgProps & { chatScope?: boolean; onOpenMemory?: () => void }): React.JSX.Element {
  return (
    <Section title="Subagentes" aside={<SystemPromptInfo subagent side="left" />}>
      <SubagentMemoryLine cfg={cfg} chatScope={chatScope} onOpenMemory={onOpenMemory} />
      <AutoTextarea
        value={cfg.subagentSystemPrompt}
        aria-label="System prompt dos subagentes"
        onChange={(e) => patch({ subagentSystemPrompt: e.target.value })}
        minRows={4}
        maxRows={14}
        className="field text-[12.5px] leading-relaxed"
      />
    </Section>
  )
}

export function LimitsSection({ cfg, patch }: CfgProps): React.JSX.Element {
  const max = clampToolOutput(cfg.maxToolOutputChars)
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
          value={cfg.maxToolOutputChars ?? LIMITS.maxToolOutputChars}
          disabled={false}
          step={1000}
          min={LIMITS.minToolOutputChars}
          max={LIMITS.maxToolOutputCharsCap}
          int
          wide
          label="Saída máxima por ferramenta (caracteres)"
          onCommit={(v) =>
            v >= LIMITS.minToolOutputChars && patch({ maxToolOutputChars: clampToolOutput(v) })
          }
        />
      </div>
    </Section>
  )
}

/** Aba Tools inteira (painel e editor de persona). */
export function ToolsEditor({
  chatScope,
  onOpenMemory,
  ...props
}: CfgProps & {
  /** Painel do chat (textos "neste chat" × "nesta persona"). */
  chatScope?: boolean
  /** Link "Memória" da seção de subagentes (editor de persona: troca de aba). */
  onOpenMemory?: () => void
}): React.JSX.Element {
  return (
    <>
      <ToolsListSection {...props} />
      <ToolsPromptSection {...props} />
      <ChatApprovalSection {...props} />
      <SmartApproveSection {...props} />
      <SubagentSection {...props} chatScope={chatScope} onOpenMemory={onOpenMemory} />
      <LimitsSection {...props} />
    </>
  )
}
