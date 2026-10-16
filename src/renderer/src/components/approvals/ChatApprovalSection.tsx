// Aba Tools (chat e persona): modo de aprovação por item com "Padrão global (X)" + os 3 modos.
// As listas são globais (Configurações → Aprovações).
import { Settings2 } from 'lucide-react'
import {
  APPROVAL_ITEMS,
  effectiveMode,
  ITEM_LABEL,
  ITEM_TOOL,
  normalizeChatModes
} from '@shared/approvalPolicy'
import { smartApproveActive } from '@shared/smartApprove'
import type { ApprovalItem, ApprovalMode } from '@shared/types'
import { useStore } from '../../store'
import { AutoApproveInfo } from '../apiDocs'
import type { CfgProps } from '../panel/editors'
import { Section } from '../panel/fields'
import { ModeSelector, SmartMissingNote } from './ApprovalControls'

export function ChatApprovalSection({ cfg, patch }: CfgProps): React.JSX.Element {
  const global = useStore((s) => s.approvalSettings.modes)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const overrides = normalizeChatModes(cfg.approvalModes)
  const judge = smartApproveActive(cfg.smartApprove)
  const set = (item: ApprovalItem, mode: ApprovalMode | null): void => {
    const next = { ...overrides }
    if (mode) next[item] = mode
    else delete next[item]
    patch({ approvalModes: next })
  }
  const smartWithoutJudge =
    APPROVAL_ITEMS.some((i) => effectiveMode(cfg, global, i) === 'smart') && !judge
  return (
    <Section title="Aprovações" id="aprovacoes" aside={<AutoApproveInfo />}>
      <div className="space-y-2.5">
        {APPROVAL_ITEMS.map((item) => (
          <div key={item}>
            <div className="mb-1 flex items-baseline gap-2">
              <span className="text-[12.5px] text-fg/90">{ITEM_LABEL[item]}</span>
              <span className="font-mono text-[10.5px] text-faint">{ITEM_TOOL[item]}</span>
            </div>
            <ModeSelector
              item={item}
              value={overrides[item] ?? null}
              inherit={global[item]}
              onChange={(m) => set(item, m)}
              label={`Aprovação: ${ITEM_LABEL[item]}`}
              testId={`chat-mode-${item}`}
            />
          </div>
        ))}
      </div>
      {smartWithoutJudge && <SmartMissingNote where="na seção Smart-Approve abaixo" />}
      <button
        type="button"
        onClick={() => setSettingsOpen(true, 'approvals')}
        className="inline-flex items-center gap-1.5 text-[11.5px] text-accent-strong hover:underline"
      >
        <Settings2 className="size-3.5" /> Padrões globais e listas (Configurações → Aprovações)
      </button>
    </Section>
  )
}
