// "Gerar título" ao lado do título do chat (header): o modelo do título (Configurações → Novos chats)
// dá nome ao chat de novo a partir da 1ª mensagem. Só aparece com modelo escolhido e com mensagem.
// Ver SPEC.md → "Título automático".
import { WandSparkles } from 'lucide-react'
import { useState } from 'react'
import { autoTitleEnabled, normalizeAutoTitleSettings } from '@shared/autoTitle'
import type { Chat } from '@shared/types'
import { cn } from '../../lib/format'
import { useStore } from '../../store'
import { Spinner } from '../ui/controls'
import { Tip } from '../ui/Tooltip'

export function GenerateTitleButton({ chat }: { chat: Chat }): React.JSX.Element | null {
  const enabled = useStore((s) =>
    autoTitleEnabled(normalizeAutoTitleSettings(s.settings.autoTitle))
  )
  const generateTitle = useStore((s) => s.generateTitle)
  const [busy, setBusy] = useState(false)
  // sem título ainda = sem 1ª mensagem (o título provisório nasce com ela)
  if (!enabled || !chat.title) return null
  return (
    <Tip label={busy ? 'Gerando título…' : 'Gerar título com o modelo do título'} side="bottom">
      <button
        type="button"
        aria-label="Gerar título"
        data-testid="generate-title"
        disabled={busy}
        onClick={() => {
          setBusy(true)
          void generateTitle(chat.id).finally(() => setBusy(false))
        }}
        className={cn(
          'no-drag grid size-6 shrink-0 place-items-center rounded-md text-faint transition-opacity hover:bg-hover hover:text-fg focus-visible:opacity-100',
          busy ? 'opacity-100' : 'opacity-0 group-hover/title:opacity-100'
        )}
      >
        {busy ? <Spinner className="size-3" /> : <WandSparkles className="size-3.5" />}
      </button>
    </Tip>
  )
}
