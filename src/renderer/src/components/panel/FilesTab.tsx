import {
  ChevronRight,
  Folder,
  FolderInput,
  FolderOpen,
  FolderPlus,
  FolderRoot,
  House,
  MonitorSmartphone,
  RefreshCw,
  WifiOff
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { Chat, DirEntry } from '@shared/types'
import { api } from '../../lib/api'
import { resourceActions, sourcesFor } from '../../lib/fileSources'
import { cn, compactPath, formatBytes } from '../../lib/format'
import { useStore } from '../../store'
import { Button, IconButton, Spinner } from '../ui/controls'
import { RootInfo } from '../apiDocs'
import { useHostInfo } from '../sync/hooks'
import { fileIcon } from '../viewer/fileIcons'

function join(dir: string, name: string): string {
  return dir.endsWith('/') ? dir + name : `${dir}/${name}`
}

function crumbs(path: string, home: string | null): { label: string; path: string }[] {
  const out: { label: string; path: string }[] = []
  let base = ''
  let rest = path
  if (home && (path === home || path.startsWith(home + '/'))) {
    out.push({ label: '~', path: home })
    base = home
    rest = path.slice(home.length)
  } else {
    out.push({ label: '/', path: '/' })
  }
  for (const seg of rest.split('/').filter(Boolean)) {
    base = `${base}/${seg}`
    out.push({ label: seg, path: base })
  }
  return out
}

/** Breadcrumb a partir do diretório raiz (nunca acima dele). */
function rootCrumbs(path: string, root: string): { label: string; path: string }[] {
  const name = root.split('/').filter(Boolean).pop() ?? '/'
  const out = [{ label: name, path: root }]
  if (path === root || !path.startsWith(root === '/' ? '/' : root + '/')) return out
  let base = root
  for (const seg of path.slice(root.length).split('/').filter(Boolean)) {
    base = base === '/' ? `/${seg}` : `${base}/${seg}`
    out.push({ label: seg, path: base })
  }
  return out
}

const insideRoot = (p: string, root: string): boolean =>
  p === root || p.startsWith(root === '/' ? '/' : root + '/')

/** Formulário inline "Nova pasta…": cria `parent/nome`. */
export function NewFolderForm({
  parent,
  onCreated,
  onCancel
}: {
  parent: string
  onCreated: (path: string) => void
  onCancel: () => void
}): React.JSX.Element {
  const homeDir = useStore((s) => s.homeDir)
  const run = useStore((s) => s.run)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const valid = !!name.trim() && !/[/\\]/.test(name) && name.trim() !== '.' && name.trim() !== '..'
  const create = async (): Promise<void> => {
    if (!valid || busy) return
    setBusy(true)
    const p = await run(() => api.fs.mkdir(join(parent, name.trim())), 'Erro ao criar pasta')
    setBusy(false)
    if (p) onCreated(p)
  }
  return (
    <div className="animate-fade-in rounded-lg border border-border bg-bg/50 p-2.5">
      <div className="mb-1.5 truncate text-[11px] text-subtle" title={parent}>
        Nova pasta em <span className="font-mono">{compactPath(parent, homeDir, 40)}</span>
      </div>
      <div className="flex gap-2">
        <input
          autoFocus
          value={name}
          placeholder="nome-do-projeto"
          aria-label="Nome da nova pasta"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              void create()
            }
            if (e.key === 'Escape') {
              e.stopPropagation()
              onCancel()
            }
          }}
          className="field h-7 min-w-0 flex-1 px-2 py-0 font-mono text-[12px]"
        />
        <Button
          size="sm"
          variant="primary"
          disabled={!valid}
          loading={busy}
          onClick={() => void create()}
        >
          Criar
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancelar
        </Button>
      </div>
    </div>
  )
}

export function FilesTab({ chat }: { chat: Chat }): React.JSX.Element {
  const homeDir = useStore((s) => s.homeDir)
  const patchConfig = useStore((s) => s.patchConfig)
  const run = useStore((s) => s.run)
  const tick = useStore((s) => s.fsTick[chat.id] ?? 0)
  // fonte da listagem: local, ou a do HOST no controle remoto (lib/fileSources → remoteFiles)
  const host = useHostInfo(chat.id)
  const dirSource = sourcesFor(chat.id, host?.mode).dir
  const remoteMode = dirSource.id === 'remote'
  // controle remoto: raiz e confinamento são os do chat NO HOST (vêm com a listagem)
  const [remoteRoot, setRemoteRoot] = useState<{ root: string; confine: boolean } | null>(null)
  const root = remoteMode ? (remoteRoot?.root ?? host?.hostCwd?.path ?? '') : chat.config.cwd
  const confine = remoteMode ? (remoteRoot?.confine ?? true) : chat.config.confineToRoot !== false
  const [dir, setDir] = useState(root)
  const [reload, setReload] = useState(0)
  const [creating, setCreating] = useState(false)
  const [listing, setListing] = useState<{
    dir: string
    entries?: DirEntry[]
    error?: string
    offline?: boolean
    truncated?: boolean
  } | null>(null)
  const active = useStore((s) => s.viewer[chat.id])
  const openFile = useStore((s) => s.openFile)
  const [prevRoot, setPrevRoot] = useState(root)
  if (prevRoot !== root) {
    setPrevRoot(root)
    setDir(root)
  }
  const [prevMode, setPrevMode] = useState(remoteMode)
  if (prevMode !== remoteMode) {
    setPrevMode(remoteMode)
    setRemoteRoot(null)
  }
  // Confinado: a navegação nunca sobe acima da raiz.
  const shownDir = confine && !insideRoot(dir, root) ? root : dir
  // remota sem a raiz do host ainda: pede '' (o host responde com a raiz dele)
  const requestDir = remoteMode && !remoteRoot ? '' : shownDir

  useEffect(() => {
    const ctl = new AbortController()
    void dirSource.listDir(chat.id, requestDir, ctl.signal).then((r) => {
      if (ctl.signal.aborted) return
      if (r.ok && r.root !== undefined && dirSource.id === 'remote')
        setRemoteRoot((cur) =>
          cur && cur.root === r.root && cur.confine === (r.confine !== false)
            ? cur
            : { root: r.root!, confine: r.confine !== false }
        )
      setListing(
        r.ok
          ? {
              dir: requestDir === '' && r.root !== undefined ? r.dir : requestDir,
              entries: r.entries,
              truncated: r.truncated
            }
          : { dir: requestDir, error: r.message, offline: r.reason === 'host-offline' }
      )
    })
    return () => ctl.abort()
  }, [requestDir, tick, reload, dirSource, chat.id])
  const current =
    listing?.dir === requestDir || (remoteMode && listing?.dir === shownDir) ? listing : null
  const entries = current?.entries ?? null
  const error = current?.error ?? null
  const offline = !!current?.offline

  const sorted = useMemo(
    () =>
      entries
        ? [...entries].sort((a, b) =>
            a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1
          )
        : [],
    [entries]
  )

  /** Clique: abre no painel de arquivo (vira o arquivo ativo do chat). */
  const openInViewer = (e: DirEntry, path: string): void =>
    openFile(chat.id, { chatId: chat.id, source: 'browse', path }, path, e.name)
  /**
   * Duplo clique: abre no app padrão do sistema (remoto: cópia temporária); executável deste
   * sistema → "Executar…" (confirmação no main); de outro sistema → só avisa.
   */
  const openInApp = async (path: string): Promise<void> => {
    const fileSource = sourcesFor(chat.id, host?.mode).file
    if (!fileSource.capabilities.openNative) return
    const r = await fileSource.open({ chatId: chat.id, source: 'browse', path })
    if (!r.ok) {
      useStore.getState().toast(r.message, 'error')
      return
    }
    const acts = resourceActions(fileSource, r.resource)
    const open = acts.run ?? acts.openExternal
    if (open) await run(() => open(), 'Não foi possível abrir o arquivo')
    else if (acts.note) useStore.getState().toast(acts.note, 'info')
    r.resource.dispose()
  }

  const pick = async (): Promise<void> => {
    const d = await run(() => api.fs.pickDirectory(), 'Erro ao escolher pasta')
    if (d) {
      patchConfig(chat.id, { cwd: d })
      setDir(d)
    }
  }

  const parts = confine ? rootCrumbs(shownDir, root) : crumbs(shownDir, homeDir)

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 space-y-3 border-b border-border/70 px-4 py-3.5">
        <div className="flex items-center gap-2">
          <span className="rounded bg-accent-soft px-1.5 py-0.5 text-[10px] font-semibold tracking-wide whitespace-nowrap text-accent-strong">
            RAIZ
          </span>
          <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-fg/90" title={root}>
            {compactPath(root, homeDir, 34)}
          </span>
          <RootInfo side="left" />
          <IconButton label="Recarregar" size="xs" onClick={() => setReload((n) => n + 1)}>
            <RefreshCw />
          </IconButton>
        </div>
        {remoteMode ? (
          <div
            data-testid="files-remote"
            className="flex items-center gap-1.5 text-[11.5px] text-subtle"
          >
            <MonitorSmartphone className="size-3.5 shrink-0" />
            <span className="min-w-0 truncate">
              Arquivos do {host?.host?.name ?? 'host'} — clique para visualizar (baixa pelo sync)
            </span>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="secondary"
              className="flex-1"
              disabled={shownDir === root}
              icon={<FolderInput className="size-3.5" />}
              onClick={() => patchConfig(chat.id, { cwd: shownDir })}
            >
              Usar como raiz
            </Button>
            <Button
              size="sm"
              variant="secondary"
              className="flex-1"
              icon={<FolderOpen className="size-3.5" />}
              onClick={() => void pick()}
            >
              Escolher pasta…
            </Button>
            <IconButton
              label="Nova pasta…"
              size="sm"
              active={creating}
              onClick={() => setCreating((v) => !v)}
            >
              <FolderPlus />
            </IconButton>
          </div>
        )}
        {creating && !remoteMode && (
          <NewFolderForm
            parent={shownDir}
            onCancel={() => setCreating(false)}
            onCreated={(p) => {
              setCreating(false)
              setDir(p)
              setReload((n) => n + 1)
            }}
          />
        )}
      </div>

      <nav className="flex shrink-0 flex-wrap items-center gap-0.5 px-3 py-2 text-[12px]">
        {parts.map((p, i) => (
          <span key={p.path} className="flex items-center gap-0.5">
            {i > 0 && <ChevronRight className="size-3 text-faint" />}
            <button
              type="button"
              onClick={() => setDir(p.path)}
              title={p.path}
              className={cn(
                'flex items-center gap-1 rounded px-1 py-0.5 hover:bg-hover',
                i === parts.length - 1 ? 'font-medium text-fg' : 'text-subtle hover:text-fg'
              )}
            >
              {confine && i === 0 ? (
                <>
                  <FolderRoot className="size-3 text-accent-strong/80" />
                  {p.label}
                </>
              ) : p.label === '~' ? (
                <House className="size-3" />
              ) : (
                p.label
              )}
            </button>
          </span>
        ))}
      </nav>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {!entries && !error && (
          <div className="flex items-center gap-2 px-2 py-2 text-xs text-subtle">
            <Spinner /> Carregando…
          </div>
        )}
        {error &&
          (offline ? (
            <div className="flex items-center gap-2 px-2 py-2 text-xs text-subtle">
              <WifiOff className="size-3.5" /> Host offline — {error}
            </div>
          ) : (
            <div className="px-2 py-2 text-xs text-danger">{error}</div>
          ))}
        {entries && sorted.length === 0 && (
          <div className="px-2 py-6 text-center text-xs text-subtle">Pasta vazia</div>
        )}
        {current?.truncated && (
          <div className="px-2 py-1.5 text-[11px] text-subtle">
            Pasta grande: mostrando só as primeiras {sorted.length} entradas.
          </div>
        )}
        {sorted.map((e) => {
          const path = e.path || join(shownDir, e.name)
          const isActive = !e.isDir && active?.path === path
          const { icon: FIcon } = fileIcon(e.name)
          return (
            <button
              key={path}
              type="button"
              data-testid="files-entry"
              aria-current={isActive ? 'true' : undefined}
              title={
                e.isDir
                  ? undefined
                  : `${e.name} — clique para visualizar, duplo clique abre no app${remoteMode ? ' (baixa do host)' : ''}`
              }
              onClick={() => (e.isDir ? setDir(path) : openInViewer(e, path))}
              onDoubleClick={() => !e.isDir && void openInApp(path)}
              className={cn(
                'group flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[12.5px]',
                isActive ? 'bg-active text-fg' : 'hover:bg-hover'
              )}
            >
              {e.isDir ? (
                <Folder
                  className="size-3.5 shrink-0 text-accent-strong/70"
                  fill="currentColor"
                  fillOpacity={0.15}
                />
              ) : (
                <FIcon
                  className={cn('size-3.5 shrink-0', isActive ? 'text-fg/80' : 'text-subtle')}
                />
              )}
              <span
                className={cn(
                  'min-w-0 flex-1 truncate',
                  isActive ? 'text-fg' : e.isDir ? 'text-fg/90' : 'text-fg/75',
                  e.name.startsWith('.') && 'opacity-60'
                )}
              >
                {e.name}
              </span>
              {!e.isDir && (
                <span className="shrink-0 text-[10.5px] text-faint tabular-nums">
                  {formatBytes(e.size)}
                </span>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}
