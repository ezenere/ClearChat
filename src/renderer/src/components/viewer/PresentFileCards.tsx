// Cards de uma chamada de present_file, no lugar do card de tool (sem cabeçalho): um por arquivo,
// na posição da chamada dentro da resposta. Clique → abre no painel de arquivo (vira o ativo);
// "Abrir no app" / "Mostrar na pasta" no hover/foco. Arquivo em outro dispositivo (controle remoto,
// sync) ou que sumiu → card sem pré-visualização + nota. Ver SPEC → "Visualizador de arquivos".
import { CircleAlert, ExternalLink, FolderOpen, MonitorSmartphone } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { PresentedFile, StoredMessage } from '@shared/types'
import type { ViewerCheck } from '@shared/ipc'
import { presentTitleBlock } from '@shared/fileViewer'
import { presentedFilesOf } from '../../lib/presentFiles'
import { cn, formatBytes } from '../../lib/format'
import { presentedPlace, resourceActions, sourcesFor } from '../../lib/fileSources'
import { useStore } from '../../store'
import { useHostInfo } from '../sync/hooks'
import { MessageInfo } from '../apiDocs'
import { IconButton } from '../ui/controls'
import { fileIcon } from './fileIcons'

function TitleBlock({ file }: { file: PresentedFile }): React.JSX.Element {
  const t = presentTitleBlock(file)
  return (
    <span className="flex min-w-0 flex-1 flex-col">
      <span data-testid="pf-title" className="truncate text-[13px] font-medium text-fg/95">
        {t.title}
      </span>
      {t.description && (
        <span data-testid="pf-desc" className="line-clamp-2 text-[12px] leading-snug text-muted">
          {t.description}
        </span>
      )}
      {t.fileName && (
        <span data-testid="pf-name" className="truncate font-mono text-[10.5px] text-faint">
          {t.fileName}
        </span>
      )}
    </span>
  )
}

function Card({
  file,
  active,
  disabled,
  note,
  onOpen,
  onExternal,
  onFolder
}: {
  file: PresentedFile
  active: boolean
  disabled: boolean
  note?: React.ReactNode
  onOpen: () => void
  onExternal?: () => void
  onFolder?: () => void
}): React.JSX.Element {
  const { icon: Icon, tone } = fileIcon(file.name, file.kind)
  return (
    <div
      data-testid="present-file-card"
      data-active={active || undefined}
      data-disabled={disabled || undefined}
      className={cn(
        'group/pf flex items-center gap-1 rounded-xl border pr-1.5 transition-colors',
        active
          ? 'border-border-strong bg-active'
          : 'border-border bg-surface/70 hover:border-border-strong/80 hover:bg-hover/60',
        disabled && 'opacity-80'
      )}
    >
      <button
        type="button"
        disabled={disabled}
        aria-current={active ? 'true' : undefined}
        aria-label={`Abrir ${file.name} no visualizador`}
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-xl px-3 py-2.5 text-left disabled:cursor-default"
      >
        <span
          className={cn(
            'flex size-9 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-bg/60',
            tone
          )}
        >
          <Icon className="size-[18px]" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <TitleBlock file={file} />
          {note && (
            <span
              data-testid="pf-note"
              className="flex items-center gap-1 text-[11px] text-warning/85"
            >
              {note}
            </span>
          )}
        </span>
        {file.size != null && !note && (
          <span className="shrink-0 text-[10.5px] text-faint tabular-nums">
            {formatBytes(file.size)}
          </span>
        )}
      </button>
      {(onExternal || onFolder) && (
        <div className="flex shrink-0 gap-0.5 opacity-0 transition-opacity group-focus-within/pf:opacity-100 group-hover/pf:opacity-100">
          {onExternal && (
            <IconButton label="Abrir no app" size="xs" onClick={onExternal}>
              <ExternalLink />
            </IconButton>
          )}
          {onFolder && (
            <IconButton label="Mostrar na pasta" size="xs" onClick={onFolder}>
              <FolderOpen />
            </IconButton>
          )}
        </div>
      )}
    </div>
  )
}

export function PresentFileCards({
  chatId,
  args,
  result,
  pending
}: {
  chatId: string
  args: string
  result?: StoredMessage
  /** Ainda sem resultado (stream / executando). */
  pending?: boolean
}): React.JSX.Element | null {
  const data = useMemo(() => presentedFilesOf(args, result), [args, result])
  const active = useStore((s) => s.viewer[chatId])
  const openFile = useStore((s) => s.openFile)
  const run = useStore((s) => s.run)
  const myDevice = useStore((s) => s.sync?.device?.id)
  const tick = useStore((s) => s.fsTick[chatId] ?? 0)
  const host = useHostInfo(chatId)
  const [checks, setChecks] = useState<ViewerCheck[] | null>(null)
  const rec = result?.meta.presentFiles
  const place = rec
    ? presentedPlace(rec, myDevice, { mode: host?.mode, name: host?.host?.name })
    : null
  const source = sourcesFor(chatId, host?.mode).file

  // estado de cada arquivo (sumiu? está em outro dispositivo?) — recheca a cada resultado de tool
  useEffect(() => {
    if (!result?.meta.presentFiles) return
    let alive = true
    void source.check(chatId, result.id).then((c) => alive && setChecks(c))
    return () => {
      alive = false
    }
  }, [chatId, result, source, tick])

  if (!data) return null
  const { files } = data

  const withResource = async (
    index: number,
    fn: 'openExternal' | 'showInFolder'
  ): Promise<void> => {
    if (!result) return
    const r = await source.open({ chatId, source: 'present', messageId: result.id, index })
    if (!r.ok) {
      useStore.getState().toast(r.message, 'error')
      return
    }
    const action = resourceActions(source, r.resource)[fn]
    if (action) await run(() => action(), 'Não foi possível abrir')
    r.resource.dispose()
  }

  return (
    <div data-testid="present-files" className="group/pfs relative my-2 space-y-1.5">
      {files.map((f, i) => {
        const check = checks?.[i]
        const remote =
          place?.where === 'remote'
            ? place.deviceName
            : check && !check.ok && check.reason === 'remote'
              ? (check.deviceName ?? 'outro dispositivo')
              : null
        let note: React.ReactNode
        if (f.error)
          note = (
            <>
              <CircleAlert className="size-3" /> Não apresentado: {f.error}
            </>
          )
        // fonte local: qualquer arquivo de outro dispositivo; remota: só o que não está no host
        // atual (um terceiro dispositivo) — o do host abre no painel, buscado pelo sync
        else if (
          remote &&
          (source.id === 'local' || (check && !check.ok && check.reason === 'remote'))
        )
          note = (
            <>
              <MonitorSmartphone className="size-3" /> Arquivo no {remote}
            </>
          )
        else if (check && !check.ok && check.reason === 'missing')
          note = (
            <>
              <CircleAlert className="size-3" /> Arquivo não encontrado
            </>
          )
        else if (check && !check.ok && check.reason === 'denied')
          note = (
            <>
              <CircleAlert className="size-3" /> Acesso negado (fora do diretório raiz)
            </>
          )
        const unavailable = !!note || pending || !result
        // "Mostrar na pasta" só com a capacidade da fonte (nunca para arquivo remoto)
        const reachable = !remote || source.id !== 'local'
        // remota: "Abrir no app" baixa do host para um temporário e abre
        const caps = source.capabilities
        return (
          <Card
            key={`${i}:${f.path}`}
            file={f}
            active={!!active && !f.error && active.path === f.path}
            disabled={unavailable}
            note={note}
            onOpen={() =>
              result &&
              openFile(
                chatId,
                { chatId, source: 'present', messageId: result.id, index: i },
                f.path,
                f.name
              )
            }
            onExternal={
              !unavailable && reachable && caps.openNative
                ? () => void withResource(i, 'openExternal')
                : undefined
            }
            onFolder={
              !unavailable && reachable && caps.reveal
                ? () => void withResource(i, 'showInFolder')
                : undefined
            }
          />
        )
      })}
      {result && (
        <span className="absolute top-1 -right-6 opacity-0 transition-opacity group-hover/pfs:opacity-100">
          <MessageInfo msg={result} side="left" />
        </span>
      )}
    </div>
  )
}
