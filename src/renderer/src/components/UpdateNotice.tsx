// Aviso de versão nova (SPEC → "Atualizações"): item discreto no rodapé da sidebar e linha de versão
// no rodapé das Configurações. Só avisa — "Baixar" abre a página da release no navegador.
import { ArrowUpCircle, Download, RefreshCw, X } from 'lucide-react'
import { isNewer, shouldShowUpdateNotice } from '@shared/updates'
import { useStore } from '../store'
import { Button } from './ui/controls'
import { Tip } from './ui/Tooltip'

/** Rodapé da sidebar: "Nova versão X disponível" + Baixar + dispensar (lembrado por versão). */
export function UpdateNotice(): React.JSX.Element | null {
  const update = useStore((s) => s.update)
  const dismissed = useStore((s) => s.settings.updateDismissedVersion)
  const openRelease = useStore((s) => s.openRelease)
  const dismissUpdate = useStore((s) => s.dismissUpdate)
  if (!update?.latest || !shouldShowUpdateNotice(update, dismissed)) return null
  return (
    <div
      data-testid="update-notice"
      className="mb-1.5 flex animate-fade-in items-center gap-2 rounded-lg border border-accent/25 bg-accent-soft/50 py-1 pr-1 pl-2.5 text-[12px]"
    >
      <ArrowUpCircle className="size-3.5 shrink-0 text-accent-strong" />
      <span className="min-w-0 flex-1 leading-snug text-fg/85">
        Nova versão <span className="font-medium tabular-nums">{update.latest.version}</span>{' '}
        disponível
      </span>
      <Tip label="Abre a página da versão no navegador">
        <button
          type="button"
          onClick={() => void openRelease()}
          className="shrink-0 rounded-md px-1.5 py-1 text-[11.5px] font-medium text-accent-strong transition-colors hover:bg-accent/15 hover:text-fg"
        >
          Baixar
        </button>
      </Tip>
      <Tip label="Dispensar (volta numa versão mais nova)">
        <button
          type="button"
          aria-label="Dispensar"
          onClick={() => void dismissUpdate()}
          className="shrink-0 rounded-md p-1 text-subtle transition-colors hover:bg-hover hover:text-fg"
        >
          <X className="size-3" />
        </button>
      </Tip>
    </div>
  )
}

/** Rodapé das Configurações: versão instalada, estado da checagem e "Verificar atualizações". */
export function VersionFooter(): React.JSX.Element {
  const update = useStore((s) => s.update)
  const checkUpdates = useStore((s) => s.checkUpdates)
  const openRelease = useStore((s) => s.openRelease)
  const checking = update?.state === 'checking'
  const available = !!update && isNewer(update.latest, update.current)

  const state = checking ? (
    <span className="text-subtle">Verificando…</span>
  ) : available ? (
    <span className="text-accent-strong">Nova versão {update!.latest!.version} disponível</span>
  ) : update?.state === 'error' ? (
    <Tip label={update.error ?? 'Falha ao consultar o GitHub'}>
      <span className="text-subtle">Não foi possível verificar agora</span>
    </Tip>
  ) : update?.state === 'latest' ? (
    <span className="text-subtle">Você está na versão mais recente</span>
  ) : null

  return (
    <div data-testid="version-footer" className="flex w-full items-center gap-2 text-xs">
      <span className="text-muted">
        ClearChat <span className="tabular-nums">{update?.current ?? '—'}</span>
      </span>
      {state && <span className="text-faint">·</span>}
      {state}
      <div className="ml-auto flex items-center gap-2">
        {available && !checking && (
          <Button
            size="sm"
            variant="primary"
            icon={<Download className="size-3.5" />}
            onClick={() => void openRelease()}
          >
            Baixar
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          loading={checking}
          icon={<RefreshCw className="size-3.5" />}
          onClick={() => void checkUpdates()}
        >
          Verificar atualizações
        </Button>
      </div>
    </div>
  )
}
