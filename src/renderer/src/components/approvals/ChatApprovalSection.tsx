// Aba Tools (chat e persona): modo de aprovação por item — as 3 opções, com ★ na opção igual ao
// padrão global. Sem override = segue o global (a opção ★ aparece selecionada); escolher a opção ★
// remove o override. As listas são globais (Configurações → Aprovações).
import { AlertTriangle, Settings2, Star } from 'lucide-react'
import {
  APPROVAL_ITEM_GROUPS,
  APPROVAL_ITEMS,
  effectiveMode,
  ITEM_LABEL,
  ITEM_TOOL,
  normalizeChatModes,
  withChatMode
} from '@shared/approvalPolicy'
import { smartApproveActive } from '@shared/smartApprove'
import type { ApprovalItem, ApprovalMode } from '@shared/types'
import { approvalsSummary } from '../../lib/configSummary'
import { useStore } from '../../store'
import { AutoApproveInfo } from '../apiDocs'
import type { CfgProps } from '../panel/editors'
import { CollapsibleSection } from '../panel/fields'
import { ModeSelector, SMART_NEEDS_MODEL } from './ApprovalControls'

export function ChatApprovalSection({
  cfg,
  patch,
  chatScope
}: CfgProps & {
  /** Painel do chat: o aviso "sem modelo" leva à seção Smart-Approve (focusConfig). */
  chatScope?: boolean
}): React.JSX.Element {
  const global = useStore((s) => s.approvalSettings.modes)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const focusConfig = useStore((s) => s.focusConfig)
  const overrides = normalizeChatModes(cfg.approvalModes)
  const judge = smartApproveActive(cfg.smartApprove)
  // escolher a opção ★ (= global) remove o override; outra opção fixa o modo neste chat
  const set = (item: ApprovalItem, mode: ApprovalMode): void =>
    patch({ approvalModes: withChatMode(overrides, item, mode, global) })
  const smartNoModel = judge
    ? []
    : APPROVAL_ITEMS.filter((i) => effectiveMode(cfg, global, i) === 'smart')
  return (
    <CollapsibleSection
      id="approvals"
      title="Aprovações"
      section="aprovacoes"
      summary={approvalsSummary(cfg)}
      warning={
        smartNoModel.length
          ? `Em Smart-Approve sem modelo (pedem confirmação): ${smartNoModel.map((i) => ITEM_LABEL[i]).join(', ')}`
          : null
      }
      aside={<AutoApproveInfo />}
    >
      <p data-testid="approval-star-hint" className="-mt-1 text-[11.5px] leading-snug text-subtle">
        <Star className="mb-0.5 inline size-2.5 fill-current text-accent-strong" /> marca o padrão
        global; escolher a opção com estrela segue o padrão global (muda junto se ele mudar).
      </p>
      {APPROVAL_ITEM_GROUPS.map((g) => (
        <div key={g.title} className="space-y-2.5">
          <div className="border-b border-border/50 pb-1 text-[11px] text-subtle">{g.title}</div>
          {g.items.map((item) => {
            const missing = !judge && effectiveMode(cfg, global, item) === 'smart'
            return (
              <div key={item}>
                <div className="mb-1 flex items-baseline gap-2">
                  <span className="text-[12.5px] text-fg/90">{ITEM_LABEL[item]}</span>
                  <span className="font-mono text-[10.5px] text-faint">{ITEM_TOOL[item]}</span>
                  {missing && (
                    <span
                      data-testid={`smart-missing-${item}`}
                      title={`${SMART_NEEDS_MODEL}. Sem modelo, este item pede sua confirmação.`}
                      className="ml-auto inline-flex items-center gap-1 text-[11px] text-warning/90"
                    >
                      <AlertTriangle className="size-3" /> sem modelo · pergunta
                    </span>
                  )}
                </div>
                <ModeSelector
                  item={item}
                  value={overrides[item] ?? null}
                  globalMode={global[item]}
                  smartUnavailable={!judge}
                  onChange={(m) => set(item, m)}
                  label={`Aprovação: ${ITEM_LABEL[item]}`}
                  testId={`chat-mode-${item}`}
                />
              </div>
            )
          })}
        </div>
      ))}
      {!judge && (
        <p data-testid="smart-needs-model" className="text-[11px] leading-snug text-faint">
          Smart-Approve indisponível:{' '}
          {chatScope ? (
            <button
              type="button"
              onClick={() => focusConfig('smart-approve')}
              className="text-accent-strong hover:underline"
            >
              escolha um modelo na seção Smart-Approve
            </button>
          ) : (
            'escolha um modelo na seção Smart-Approve'
          )}
          .
        </p>
      )}
      <button
        type="button"
        onClick={() => setSettingsOpen(true, 'approvals')}
        className="inline-flex items-center gap-1.5 text-[11.5px] text-accent-strong hover:underline"
      >
        <Settings2 className="size-3.5" /> Padrões globais e listas (Configurações → Aprovações)
      </button>
    </CollapsibleSection>
  )
}
