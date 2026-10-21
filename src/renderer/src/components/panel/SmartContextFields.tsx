// Smart-Approve → "Descrição do ambiente" e "Coleta automática de contexto": peças usadas na aba
// Tools (chat/persona — ajuste sobre o padrão global) e em Configurações → Aprovações (o padrão
// global). O "Contexto capturado da conversa" (descrição mantida pelo resumidor, editável) só
// aparece no painel do chat. Ver SPEC.md → "Smart-Approve → Descrição do ambiente e coleta
// automática de contexto".
import { RotateCcw, X } from 'lucide-react'
import { useState } from 'react'
import {
  captureActive,
  CONTEXT_CAPTURE_LIMITS,
  effectiveCapture,
  effectiveEnvironment,
  normalizeCapture,
  smartInUse
} from '@shared/contextCapture'
import type { CapturedEntry, ChatConfig, ContextCaptureConfig } from '@shared/types'
import { api } from '../../lib/api'
import { cn, formatCost, relativeTime } from '../../lib/format'
import { useStore } from '../../store'
import { AutoTextarea, Button } from '../ui/controls'
import { ModelPicker } from '../ui/ModelPicker'
import { Tip } from '../ui/Tooltip'
import { NumberInput, ToggleRow } from './fields'

export const ENVIRONMENT_PLACEHOLDER =
  'Ex.: 172.16.1.7 é meu servidor de testes; pode reiniciar containers lá. Produção é deploy@prod.exemplo.com — nunca mexer sem perguntar.'

/** Campos da coleta automática (ligada, modelo do resumo, mensagens do agente, max_tokens). */
export function CaptureFields({
  value,
  onChange,
  testId
}: {
  value: ContextCaptureConfig
  onChange: (v: ContextCaptureConfig) => void
  testId?: string
}): React.JSX.Element {
  const c = normalizeCapture(value)
  const hasModel = !!c.providerId && !!c.model
  const L = CONTEXT_CAPTURE_LIMITS
  return (
    <div data-testid={testId} className="space-y-2.5">
      <ToggleRow
        label="Coleta automática de contexto"
        description="Depois de cada mensagem sua, um modelo barato atualiza (em segundo plano) uma descrição curta do que você quer e permite — o juiz lê antes de decidir. Recebe só as suas mensagens e o texto das últimas falas do agente (nunca resultados de tool)."
        checked={c.enabled && hasModel}
        onChange={(enabled) => onChange({ ...c, enabled })}
      />
      <div className="flex items-center gap-1.5">
        <span className="w-[118px] shrink-0 text-[12px] text-fg/90">Modelo do resumo</span>
        <ModelPicker
          className="min-w-0 flex-1"
          value={hasModel ? { providerId: c.providerId!, model: c.model! } : null}
          placeholder="Nenhum"
          // padrão desligado até escolher um modelo: escolher liga
          onChange={(ref) =>
            onChange({ ...c, providerId: ref.providerId, model: ref.model, enabled: true })
          }
        />
        {hasModel && (
          <Tip label="Remover modelo do resumo (desliga a coleta)">
            <button
              type="button"
              aria-label="Remover modelo do resumo"
              onClick={() => onChange({ ...c, providerId: null, model: null, enabled: false })}
              className="grid size-8 shrink-0 place-items-center rounded-lg text-subtle hover:bg-hover hover:text-fg"
            >
              <X className="size-3.5" />
            </button>
          </Tip>
        )}
      </div>
      <div className="flex items-center gap-2.5">
        <span className="min-w-0 flex-1 text-[12px] text-fg/90">
          Falas do agente antes da sua (contexto)
        </span>
        <NumberInput
          value={c.lookback}
          disabled={false}
          step={1}
          min={1}
          max={L.maxLookback}
          int
          label="Falas do agente lidas pelo resumo"
          onCommit={(v) => v >= 1 && v <= L.maxLookback && onChange({ ...c, lookback: v })}
        />
      </div>
      <div className="flex items-center gap-2.5">
        <span className="min-w-0 flex-1 text-[12px] text-fg/90">
          Máx. de tokens da resposta{' '}
          <span className="text-faint">(vazio = {L.defaultMaxTokens})</span>
        </span>
        <NumberInput
          value={c.maxTokens ?? undefined}
          disabled={false}
          step={50}
          min={L.minMaxTokens}
          max={L.maxMaxTokens}
          int
          label="Máximo de tokens do resumo"
          onCommit={(v) =>
            onChange({
              ...c,
              maxTokens:
                Number.isFinite(v) && v >= L.minMaxTokens ? Math.min(v, L.maxMaxTokens) : null
            })
          }
        />
      </div>
      <p className="text-[11px] leading-snug text-faint">
        Só olha o que veio depois da última mensagem já resumida (nada é reenviado); mensagens
        seguidas viram uma chamada só; Parar cancela o resumo em andamento. Sem itens em
        Smart-Approve, nenhuma chamada é feita.
      </p>
    </div>
  )
}

/** Aba Tools: descrição do ambiente (chat/persona sobre a global) + coleta (sobre a global). */
export function SmartContextSection({
  cfg,
  set,
  chatId
}: {
  cfg: ChatConfig
  set: (p: { environment?: string | null; capture?: ContextCaptureConfig | null }) => void
  chatId?: string
}): React.JSX.Element {
  const defaults = useStore((s) => s.approvalSettings.smart)
  const globalModes = useStore((s) => s.approvalSettings.modes)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const sa = cfg.smartApprove
  const ownEnv = typeof sa?.environment === 'string'
  const ownCapture = !!sa?.capture
  const capture = effectiveCapture(sa, defaults)
  const inUse = smartInUse(cfg, globalModes)
  const active = captureActive(cfg, globalModes, defaults)
  return (
    <div className="space-y-3" data-testid="smart-context">
      <div>
        <div className="mb-1 flex items-center gap-2">
          <span className="text-[12.5px] font-medium text-fg/90">Descrição do ambiente</span>
          <label className="ml-auto inline-flex items-center gap-1.5 text-[11px] text-subtle">
            <input
              type="checkbox"
              data-testid="env-use-global"
              checked={!ownEnv}
              onChange={(e) =>
                set({ environment: e.target.checked ? null : (defaults.environment ?? '') })
              }
            />
            usar a global
          </label>
        </div>
        {ownEnv ? (
          <AutoTextarea
            value={sa?.environment ?? ''}
            aria-label="Descrição do ambiente deste chat"
            placeholder={ENVIRONMENT_PLACEHOLDER}
            onChange={(e) => set({ environment: e.target.value })}
            minRows={2}
            maxRows={10}
            className="field text-[12px] leading-relaxed"
          />
        ) : (
          <p
            data-testid="env-global-text"
            className="rounded-lg border border-border bg-bg/40 px-2.5 py-1.5 text-[12px] whitespace-pre-wrap text-muted"
          >
            {effectiveEnvironment(sa, defaults) || (
              <span className="text-faint">(vazia — defina em Configurações → Aprovações)</span>
            )}
          </p>
        )}
        <p className="mt-1 text-[11px] leading-snug text-faint">
          Vai para o juiz no começo da mensagem (
          <span className="font-mono">{'{{environment}}'}</span>
          ): quais máquinas são quais, o que pode ser feito onde.{' '}
          <button
            type="button"
            onClick={() => setSettingsOpen(true, 'approvals')}
            className="text-accent-strong hover:underline"
          >
            Global
          </button>
        </p>
      </div>

      <div className="border-t border-border/60 pt-2.5">
        <div className="mb-1.5 flex items-center gap-2">
          <span className="text-[12.5px] font-medium text-fg/90">Coleta de contexto</span>
          <label className="ml-auto inline-flex items-center gap-1.5 text-[11px] text-subtle">
            <input
              type="checkbox"
              data-testid="capture-use-global"
              checked={!ownCapture}
              onChange={(e) => set({ capture: e.target.checked ? null : { ...capture } })}
            />
            usar o padrão global
          </label>
        </div>
        {ownCapture ? (
          <CaptureFields
            value={capture}
            onChange={(v) => set({ capture: v })}
            testId="chat-capture-fields"
          />
        ) : (
          <p className="text-[11.5px] text-muted">
            Padrão global:{' '}
            {capture.enabled && capture.model ? `ligada · ${capture.model}` : 'desligada'}
          </p>
        )}
        <p
          data-testid="capture-status"
          data-active={active ? 'true' : 'false'}
          className={cn(
            'mt-1.5 text-[11px] leading-snug',
            active ? 'text-success/90' : 'text-faint'
          )}
        >
          {active
            ? 'Ativa neste chat.'
            : capture.enabled && capture.model && !inUse
              ? 'Inativa: ative o Smart-Approve em algum item (com modelo do juiz).'
              : 'Inativa.'}
        </p>
      </div>

      {chatId && <CapturedContextPanel chatId={chatId} cfg={cfg} />}
    </div>
  )
}

/** "Contexto capturado da conversa": a do chat e, vendo um subagente, a dele. Editável. */
function CapturedContextPanel({
  chatId,
  cfg
}: {
  chatId: string
  cfg: ChatConfig
}): React.JSX.Element {
  const view = useStore((s) => s.view)
  const sessions = useStore((s) => s.sessions)
  const subId = view.kind === 'chat' && view.chatId === chatId ? view.sessionId : null
  const sub = subId && sessions[subId]?.depth ? sessions[subId] : null
  const st = cfg.capturedContext
  return (
    <div className="space-y-2.5 border-t border-border/60 pt-2.5">
      <CapturedEntryEditor
        chatId={chatId}
        sessionId={null}
        entry={st?.main}
        title="Contexto capturado da conversa"
      />
      {sub && (
        <CapturedEntryEditor
          chatId={chatId}
          sessionId={sub.id}
          entry={st?.sessions?.[sub.id]}
          title={`Subagente “${sub.title}” (derivado do pai + tarefa)`}
        />
      )}
    </div>
  )
}

const BY_TEXT: Record<CapturedEntry['by'], string> = {
  model: 'pelo resumo',
  user: 'por você',
  derived: 'derivado do pai'
}

function CapturedEntryEditor({
  chatId,
  sessionId,
  entry,
  title
}: {
  chatId: string
  sessionId: string | null
  entry: CapturedEntry | undefined
  title: string
}): React.JSX.Element {
  const run = useStore((s) => s.run)
  const saved = entry?.text ?? ''
  const [draft, setDraft] = useState(saved)
  const [prev, setPrev] = useState(saved)
  if (prev !== saved) {
    setPrev(saved)
    setDraft(saved)
  }
  const dirty = draft !== saved
  const last = entry?.lastRun
  const meta = [
    entry?.updatedAt && saved
      ? `atualizado há ${relativeTime(entry.updatedAt)} ${BY_TEXT[entry.by]}`
      : null,
    entry?.calls ? `${entry.calls} resumo${entry.calls > 1 ? 's' : ''}` : null,
    entry?.cost ? formatCost(entry.cost) : null,
    last?.error ? `última falhou: ${last.error}` : null,
    last?.dropped ? `${last.dropped} linha(s) descartada(s) (só o agente disse)` : null
  ].filter(Boolean)
  return (
    <div data-testid={sessionId ? 'captured-context-sub' : 'captured-context'}>
      <div className="mb-1 flex items-center gap-2">
        <span className="text-[12px] font-medium text-fg/90">{title}</span>
        {entry?.prev && (
          <button
            type="button"
            data-testid="captured-undo"
            onClick={() =>
              void run(() => api.agent.undoCapturedContext(chatId, sessionId), 'Falha ao desfazer')
            }
            className="ml-auto inline-flex items-center gap-1 text-[11px] text-subtle hover:text-fg"
          >
            <RotateCcw className="size-3" /> Desfazer última mudança
          </button>
        )}
      </div>
      <AutoTextarea
        value={draft}
        aria-label={
          sessionId ? 'Contexto capturado do subagente' : 'Contexto capturado da conversa'
        }
        placeholder="(vazio — o resumo preenche depois das suas mensagens; você pode escrever aqui)"
        onChange={(e) => setDraft(e.target.value)}
        minRows={2}
        maxRows={12}
        className="field font-mono text-[11.5px] leading-relaxed"
      />
      <div className="mt-1 flex items-center gap-2">
        <span
          data-testid="captured-meta"
          className="min-w-0 flex-1 truncate text-[10.5px] text-faint"
        >
          {meta.join(' · ') || 'Nada capturado ainda.'}
        </span>
        {dirty && (
          <>
            <Button size="sm" variant="ghost" onClick={() => setDraft(saved)}>
              Cancelar
            </Button>
            <Button
              size="sm"
              variant="primary"
              onClick={() =>
                void run(
                  () => api.agent.setCapturedContext(chatId, sessionId, draft),
                  'Falha ao salvar'
                )
              }
            >
              Salvar
            </Button>
          </>
        )}
      </div>
    </div>
  )
}
