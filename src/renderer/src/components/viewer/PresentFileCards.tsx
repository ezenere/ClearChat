// Cards de uma chamada de present_file, no lugar do card de tool (sem cabeçalho): um por arquivo,
// na posição da chamada dentro da resposta. Clique → abre no painel de arquivo (vira o ativo);
// no hover/foco, as ações pela extensão + sistema: "Abrir no app" (documento) ou "Executar…"
// (executável deste sistema), "Mostrar na pasta" (local) / "Salvar como…" (remoto); executável de
// outro sistema → só as duas últimas + nota. Arquivo em outro dispositivo (controle remoto, sync)
// ou que sumiu → card sem pré-visualização + nota. Ver SPEC → "Visualizador de arquivos".
import {
  CircleAlert,
  Download,
  ExternalLink,
  FolderOpen,
  MonitorSmartphone,
  Play,
  ShieldAlert
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { PresentedFile, StoredMessage } from '@shared/types'
import type { ViewerCheck } from '@shared/ipc'
import { presentTitleBlock } from '@shared/fileViewer'
import { presentedFilesOf } from '../../lib/presentFiles'
import { cn, formatBytes } from '../../lib/format'
import {
  nameActions,
  presentedPlace,
  resourceActions,
  sourcesFor,
  uaPlatform
} from '../../lib/fileSources'
import { useStore } from '../../store'
import { useHostInfo } from '../sync/hooks'
import { MessageInfo } from '../apiDocs'
import { IconButton } from '../ui/controls'
import { fileIcon } from './fileIcons'
import { contributeCtx } from '../../lib/contextMenu'

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
  hint,
  onOpen,
  onExternal,
  onRun,
  onFolder,
  onSaveAs
}: {
  file: PresentedFile
  active: boolean
  disabled: boolean
  note?: React.ReactNode
  /** Aviso que não desabilita o card (executável de outro sistema). */
  hint?: string
  onOpen: () => void
  onExternal?: () => void
  onRun?: () => void
  onFolder?: () => void
  onSaveAs?: () => void
}): React.JSX.Element {
  const { icon: Icon, tone } = fileIcon(file.name, file.kind)
  return (
    <div
      data-testid="present-file-card"
      data-active={active || undefined}
      data-disabled={disabled || undefined}
      onContextMenu={(e) =>
        // botão direito: as mesmas ações dos botões do card + copiar o caminho
        contributeCtx(e, {
          copy: { fileCopyPath: file.path },
          run: {
            fileRun: onRun,
            fileOpenExternal: onExternal,
            fileShowInFolder: onFolder,
            fileSaveAs: onSaveAs
          }
        })
      }
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
          {hint && !note && (
            <span
              data-testid="pf-hint"
              className="flex items-center gap-1 text-[11px] text-warning/85"
            >
              <ShieldAlert className="size-3" /> {hint}
            </span>
          )}
        </span>
        {file.size != null && !note && (
          <span className="shrink-0 text-[10.5px] text-faint tabular-nums">
            {formatBytes(file.size)}
          </span>
        )}
      </button>
      {(onExternal || onRun || onFolder || onSaveAs) && (
        <div className="flex shrink-0 gap-0.5 opacity-0 transition-opacity group-focus-within/pf:opacity-100 group-hover/pf:opacity-100">
          {onRun && (
            <IconButton label="Executar…" size="xs" onClick={onRun}>
              <Play />
            </IconButton>
          )}
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
          {onSaveAs && (
            <IconButton label="Salvar como…" size="xs" onClick={onSaveAs}>
              <Download />
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
  const platform = useStore((s) => s.capabilities.platform) ?? uaPlatform()
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

  /**
   * Abre o recurso e roda a ação. `primary` = Executar… ou Abrir no app conforme a classe do
   * RECURSO (local: vem do main, com o bit de execução — o card só sabe o nome).
   */
  const withResource = async (
    index: number,
    fn: 'primary' | 'showInFolder' | 'saveAs'
  ): Promise<void> => {
    if (!result) return
    const r = await source.open({ chatId, source: 'present', messageId: result.id, index })
    if (!r.ok) {
      useStore.getState().toast(r.message, 'error')
      return
    }
    const acts = resourceActions(source, r.resource)
    const action = fn === 'primary' ? (acts.run ?? acts.openExternal) : acts[fn]
    if (action) await run(() => action(), 'Não foi possível abrir')
    else if (acts.note) useStore.getState().toast(acts.note, 'info')
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
        // remota: "Abrir no app" / "Executar…" baixam do host para um temporário; ações pela
        // extensão + sistema (o main reclassifica ao agir)
        const acts = nameActions(source, f.name, platform)
        const can = !unavailable && reachable
        return (
          <Card
            key={`${i}:${f.path}`}
            file={f}
            active={!!active && !f.error && active.path === f.path}
            disabled={unavailable}
            note={note}
            hint={acts.note}
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
              can && acts.openExternal ? () => void withResource(i, 'primary') : undefined
            }
            onRun={can && acts.run ? () => void withResource(i, 'primary') : undefined}
            onFolder={
              can && acts.showInFolder ? () => void withResource(i, 'showInFolder') : undefined
            }
            onSaveAs={can && acts.saveAs ? () => void withResource(i, 'saveAs') : undefined}
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
