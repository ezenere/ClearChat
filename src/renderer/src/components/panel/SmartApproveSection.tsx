// Seção "Smart-Approve" da aba Tools (painel do chat e editor de personas): modelo juiz, liga/desliga,
// tools avaliadas, rótulos, contexto/tempo, prompt + template editáveis e "Testar".
import { FlaskConical, RotateCcw, X } from 'lucide-react'
import { useState } from 'react'
import {
  DEFAULT_SMART_APPROVE_PROMPT,
  DEFAULT_SMART_APPROVE_TEMPLATE,
  isOpenRouter
} from '@shared/defaults'
import {
  buildJudgeBody,
  buildJudgeMessages,
  normalizeSmartApprove,
  SMART_APPROVE_DEFAULTS,
  SMART_APPROVE_EXTRA_TOOLS,
  SMART_APPROVE_PLACEHOLDERS,
  SMART_APPROVE_SAMPLE,
  smartApproveActive,
  smartApproveTools,
  validateLabels
} from '@shared/smartApprove'
import { TOOL_LABELS } from '@shared/tools'
import {
  CONFIRM_TOOLS,
  type SmartApproveConfig,
  type SmartApproveLabels,
  type SmartApproveRecord,
  type ToolName
} from '@shared/types'
import { api } from '../../lib/api'
import { cn } from '../../lib/format'
import { useStore } from '../../store'
import { SmartApproveLine } from '../chat/SmartApprove'
import { AutoTextarea, Button, Switch } from '../ui/controls'
import { ModelPicker } from '../ui/ModelPicker'
import { Select } from '../ui/Select'
import { ApiInfo, C, Tip } from '../ui/Tooltip'
import type { CfgProps } from './editors'
import { NumberInput, Section } from './fields'

const LABEL_FIELDS: { key: keyof SmartApproveLabels; caption: string }[] = [
  { key: 'approve', caption: 'Aprovar' },
  { key: 'reject', caption: 'Rejeitar' },
  { key: 'ask', caption: 'Perguntar' }
]

const TEST_TOOLS: ToolName[] = [...CONFIRM_TOOLS, ...SMART_APPROVE_EXTRA_TOOLS]

function SmartRequestInfo({
  cfg,
  sa,
  tool,
  args
}: CfgProps & { sa: SmartApproveConfig; tool: ToolName; args: unknown }): React.JSX.Element {
  const provider = useStore((s) => s.providers.find((p) => p.id === sa.providerId))
  const bwrap = useStore((s) => s.capabilities.bwrap)
  const messages = buildJudgeMessages(sa, {
    tool,
    args,
    cwd: cfg.cwd || '~',
    confine: cfg.confineToRoot !== false,
    sandbox: !!cfg.sandboxBash && bwrap,
    history: SMART_APPROVE_SAMPLE.history
  })
  const body = buildJudgeBody(
    sa.model ?? '<modelo>',
    messages,
    provider ? isOpenRouter(provider.baseUrl) : false
  )
  const url = provider
    ? `${provider.baseUrl.replace(/\/+$/, '')}/chat/completions`
    : '<provedor>/chat/completions'
  return (
    <ApiInfo
      title="Chamada ao juiz (exemplo)"
      side="left"
      code={JSON.stringify({ url, body }, null, 2)}
      codeLabel={`POST — chamada de exemplo: ${tool}`}
      wide
    >
      <p>
        Para cada chamada avaliada, o app faz uma request{' '}
        <strong className="text-fg">separada</strong> ao modelo escolhido (fora do histórico; o
        agente não a vê): <C>{'role: "system"'}</C> = o prompt, <C>{'role: "user"'}</C> = o template
        com os placeholders preenchidos, <C>temperature: 0</C>,{' '}
        <C>max_tokens: {SMART_APPROVE_DEFAULTS.maxTokens}</C>. Headers: os do provedor do juiz + a
        assinatura do app deste chat.
      </p>
      <p>
        Rejeitada → o agente recebe <C>{'role: "tool"'}</C>{' '}
        <C>Rejeitado pelo Smart-Approve (modelo): motivo</C>. Erro, tempo esgotado ou resposta sem
        exatamente um rótulo → você decide.
      </p>
    </ApiInfo>
  )
}

export function SmartApproveSection({ cfg, patch }: CfgProps): React.JSX.Element {
  const sa = normalizeSmartApprove(cfg.smartApprove)
  const set = (p: Partial<SmartApproveConfig>): void => patch({ smartApprove: { ...sa, ...p } })
  const active = smartApproveActive(sa)
  const tools = smartApproveTools(sa)
  const hasModel = !!sa.providerId && !!sa.model

  // rótulos: rascunho local, só grava quando válido
  const [labels, setLabels] = useState<SmartApproveLabels>(sa.labels)
  const [prevLabels, setPrevLabels] = useState(sa.labels)
  if (JSON.stringify(prevLabels) !== JSON.stringify(sa.labels)) {
    setPrevLabels(sa.labels)
    setLabels(sa.labels)
  }
  const labelError = validateLabels(labels)

  const [promptOpen, setPromptOpen] = useState(false)
  const [testOpen, setTestOpen] = useState(false)
  const [testTool, setTestTool] = useState<ToolName>(SMART_APPROVE_SAMPLE.tool)
  const [testArgs, setTestArgs] = useState(JSON.stringify(SMART_APPROVE_SAMPLE.args, null, 2))
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<SmartApproveRecord | null>(null)
  const [testError, setTestError] = useState<string | null>(null)
  let parsedArgs: unknown = SMART_APPROVE_SAMPLE.args
  let argsError: string | null = null
  try {
    parsedArgs = JSON.parse(testArgs)
  } catch (e) {
    argsError = (e as Error).message
  }

  const toggleTool = (t: ToolName, on: boolean): void => {
    const next = on ? [...tools.filter((x) => x !== t), t] : tools.filter((x) => x !== t)
    set({ tools: TEST_TOOLS.filter((x) => next.includes(x)) })
  }

  const runTest = async (): Promise<void> => {
    setTesting(true)
    setTestError(null)
    setTestResult(null)
    try {
      setTestResult(
        await api.agent.smartApproveTest({
          config: {
            smartApprove: sa,
            cwd: cfg.cwd,
            confineToRoot: cfg.confineToRoot,
            sandboxBash: cfg.sandboxBash,
            appSignature: cfg.appSignature,
            appSignatureCustom: cfg.appSignatureCustom
          },
          tool: testTool,
          args: parsedArgs,
          history: SMART_APPROVE_SAMPLE.history
        })
      )
    } catch (e) {
      setTestError(
        (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
      )
    } finally {
      setTesting(false)
    }
  }

  const customPrompt = sa.prompt != null || sa.template != null

  return (
    <Section
      title="Smart-Approve"
      id="smart-approve"
      aside={<SmartRequestInfo cfg={cfg} patch={patch} sa={sa} tool={testTool} args={parsedArgs} />}
    >
      <p className="-mt-1 text-[11.5px] leading-snug text-subtle">
        Um modelo avalia cada chamada que pediria confirmação e aprova, rejeita ou pergunta a você.
        Erro, demora ou resposta ambígua → pergunta a você. Tools em “Aprovação automática” rodam
        direto.
      </p>

      <div data-testid="smart-approve-model" className="flex items-center gap-1.5">
        <ModelPicker
          className="min-w-0 flex-1"
          value={hasModel ? { providerId: sa.providerId!, model: sa.model! } : null}
          placeholder="Nenhum"
          onChange={(ref) => set({ providerId: ref.providerId, model: ref.model })}
        />
        {hasModel && (
          <Tip label="Nenhum (desliga o Smart-Approve)">
            <button
              type="button"
              aria-label="Remover modelo do Smart-Approve"
              onClick={() => set({ providerId: null, model: null, enabled: false })}
              className="grid size-8 shrink-0 place-items-center rounded-lg text-subtle hover:bg-hover hover:text-fg"
            >
              <X className="size-3.5" />
            </button>
          </Tip>
        )}
      </div>

      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className={cn('text-[13px]', hasModel ? 'text-fg/90' : 'text-subtle')}>
            Habilitar
          </div>
          <p
            data-testid="smart-approve-hint"
            className="mt-0.5 text-[11.5px] leading-snug text-subtle"
          >
            {!hasModel
              ? 'Escolha um modelo para habilitar'
              : active
                ? 'Ligado: o juiz decide antes de pedir sua confirmação.'
                : 'Desligado: as confirmações são suas.'}
          </p>
        </div>
        <div className="pt-0.5">
          <Switch
            checked={active}
            disabled={!hasModel}
            label="Habilitar Smart-Approve"
            onChange={(enabled) => set({ enabled })}
          />
        </div>
      </div>

      <div className={cn('space-y-3 transition-opacity', !active && 'opacity-60')}>
        <div>
          <div className="mb-1 text-[11px] text-subtle">Ferramentas avaliadas</div>
          <div className="-mx-1.5 space-y-px">
            {TEST_TOOLS.map((t) => {
              const confirm = CONFIRM_TOOLS.includes(t)
              const on = tools.includes(t)
              return (
                <label
                  key={t}
                  className="flex h-7 cursor-pointer items-center gap-2.5 rounded-lg px-1.5 hover:bg-hover/50"
                >
                  <input
                    type="checkbox"
                    checked={on}
                    aria-label={`Avaliar ${TOOL_LABELS[t]}`}
                    onChange={(e) => toggleTool(t, e.target.checked)}
                    className="size-3.5 accent-accent"
                  />
                  <span
                    className={cn(
                      'min-w-0 flex-1 truncate text-[12.5px]',
                      on ? 'text-fg/90' : 'text-subtle'
                    )}
                  >
                    {TOOL_LABELS[t]}
                  </span>
                  <span className="text-[10.5px] text-faint">
                    {confirm ? 'pede confirmação' : on ? 'passa a pedir confirmação' : ''}
                  </span>
                </label>
              )
            })}
          </div>
          {tools.some((t) => !CONFIRM_TOOLS.includes(t)) && (
            <p className="mt-1 text-[11px] leading-snug text-subtle">
              Com o Smart-Approve ligado, as tools extras marcadas passam pelo juiz e, se ele não
              aprovar, pedem sua confirmação.
            </p>
          )}
        </div>

        <div>
          <div className="mb-1 text-[11px] text-subtle">Rótulos (1ª linha da resposta)</div>
          <div className="grid grid-cols-3 gap-1.5">
            {LABEL_FIELDS.map(({ key, caption }) => (
              <label key={key} className="min-w-0">
                <span className="mb-0.5 block text-[10.5px] text-faint">{caption}</span>
                <input
                  value={labels[key]}
                  aria-label={`Rótulo ${caption}`}
                  onChange={(e) => {
                    const next = { ...labels, [key]: e.target.value }
                    setLabels(next)
                    if (!validateLabels(next))
                      set({
                        labels: {
                          approve: next.approve.trim(),
                          reject: next.reject.trim(),
                          ask: next.ask.trim()
                        }
                      })
                  }}
                  className={cn(
                    'field h-7 w-full px-2 py-0 font-mono text-[11.5px]',
                    labelError && !labels[key].trim() && 'border-danger/60'
                  )}
                />
              </label>
            ))}
          </div>
          {labelError && (
            <p data-testid="smart-label-error" className="mt-1 text-[11px] text-danger/90">
              {labelError} (não salvo)
            </p>
          )}
        </div>

        <div className="flex items-center gap-2.5">
          <span className="min-w-0 flex-1 text-[12.5px] text-fg/90">
            Mensagens recentes no contexto
          </span>
          <NumberInput
            value={sa.contextMessages}
            disabled={false}
            step={1}
            min={0}
            max={SMART_APPROVE_DEFAULTS.maxContextMessages}
            int
            label="Mensagens recentes no contexto do juiz"
            onCommit={(v) =>
              v >= 0 &&
              v <= SMART_APPROVE_DEFAULTS.maxContextMessages &&
              set({ contextMessages: v })
            }
          />
        </div>
        <div className="flex items-center gap-2.5">
          <span className="min-w-0 flex-1 text-[12.5px] text-fg/90">Tempo máximo</span>
          <NumberInput
            value={sa.timeoutS}
            disabled={false}
            step={5}
            min={SMART_APPROVE_DEFAULTS.minTimeoutS}
            max={SMART_APPROVE_DEFAULTS.maxTimeoutS}
            int
            label="Tempo máximo do juiz (segundos)"
            onCommit={(v) =>
              v >= SMART_APPROVE_DEFAULTS.minTimeoutS &&
              v <= SMART_APPROVE_DEFAULTS.maxTimeoutS &&
              set({ timeoutS: v })
            }
          />
          <span className="text-[12px] text-subtle">s</span>
        </div>

        <div>
          <div className="mb-1 flex items-center gap-1.5 text-[11px] text-subtle">
            <button
              type="button"
              onClick={() => setPromptOpen((o) => !o)}
              className="hover:text-fg"
            >
              {promptOpen ? '▾' : '▸'} Prompt do juiz{customPrompt ? ' (personalizado)' : ''}
            </button>
            {customPrompt && (
              <button
                type="button"
                onClick={() => set({ prompt: null, template: null })}
                className="ml-auto inline-flex items-center gap-1 hover:text-fg"
              >
                <RotateCcw className="size-3" /> Restaurar padrão
              </button>
            )}
          </div>
          {promptOpen && (
            <div className="animate-fade-in space-y-2">
              <div>
                <div className="mb-0.5 text-[10.5px] text-faint">
                  System (<C>{'role: "system"'}</C>)
                </div>
                <AutoTextarea
                  value={sa.prompt ?? DEFAULT_SMART_APPROVE_PROMPT}
                  aria-label="Prompt do Smart-Approve"
                  onChange={(e) => set({ prompt: e.target.value })}
                  minRows={5}
                  maxRows={16}
                  className="field font-mono text-[11px] leading-relaxed"
                />
              </div>
              <div>
                <div className="mb-0.5 text-[10.5px] text-faint">
                  Template da mensagem (<C>{'role: "user"'}</C>)
                </div>
                <AutoTextarea
                  value={sa.template ?? DEFAULT_SMART_APPROVE_TEMPLATE}
                  aria-label="Template do Smart-Approve"
                  onChange={(e) => set({ template: e.target.value })}
                  minRows={5}
                  maxRows={16}
                  className="field font-mono text-[11px] leading-relaxed"
                />
              </div>
              <div className="rounded-lg border border-border bg-bg/40 px-2.5 py-2">
                <div className="mb-1 text-[10.5px] font-medium text-subtle">
                  Placeholders (system e template)
                </div>
                <dl className="grid grid-cols-[auto_1fr] gap-x-2.5 gap-y-0.5 text-[11px]">
                  {SMART_APPROVE_PLACEHOLDERS.map((p) => (
                    <div key={p.key} className="contents">
                      <dt className="font-mono text-accent-strong">{`{{${p.key}}}`}</dt>
                      <dd className="text-subtle">{p.desc}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            </div>
          )}
        </div>

        <div>
          <button
            type="button"
            onClick={() => setTestOpen((o) => !o)}
            className="text-[11px] text-subtle hover:text-fg"
          >
            {testOpen ? '▾' : '▸'} Testar com uma chamada de exemplo
          </button>
          {testOpen && (
            <div className="mt-1.5 animate-fade-in space-y-2">
              <Select
                value={testTool}
                onChange={(v) => setTestTool(v)}
                options={TEST_TOOLS.map((t) => ({ value: t, label: `${TOOL_LABELS[t]} · ${t}` }))}
              />
              <AutoTextarea
                value={testArgs}
                aria-label="Argumentos de exemplo"
                onChange={(e) => setTestArgs(e.target.value)}
                minRows={2}
                maxRows={8}
                className={cn('field font-mono text-[11px]', argsError && 'border-danger/60')}
              />
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  loading={testing}
                  disabled={!hasModel || !!argsError}
                  icon={<FlaskConical className="size-3.5" />}
                  onClick={() => void runTest()}
                >
                  Testar
                </Button>
                <span className="text-[11px] text-faint">
                  {argsError
                    ? 'JSON inválido'
                    : 'Contexto de exemplo: “As dependências do projeto estão quebradas, reinstale.”'}
                </span>
              </div>
              {testError && <p className="text-[11.5px] text-danger/90">{testError}</p>}
              {testResult && (
                <div
                  data-testid="smart-test-result"
                  className="overflow-hidden rounded-lg border border-border"
                >
                  <SmartApproveLine rec={testResult} pending />
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </Section>
  )
}
