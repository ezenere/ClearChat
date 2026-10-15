import {
  ArrowLeft,
  ChevronRight,
  File,
  FileText,
  Folder,
  FolderInput,
  FolderOpen,
  FolderPlus,
  FolderRoot,
  House,
  RefreshCw
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { Chat, DirEntry } from '@shared/types'
import type { FileContent } from '@shared/ipc'
import { api, errorMessage } from '../../lib/api'
import { cn, compactPath, formatBytes } from '../../lib/format'
import { useStore } from '../../store'
import { Button, IconButton, Spinner } from '../ui/controls'
import { RootInfo } from '../apiDocs'
import { CopyButton } from '../chat/Markdown'

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

function Preview({ entry, onBack }: { entry: DirEntry; onBack: () => void }): React.JSX.Element {
  const [data, setData] = useState<FileContent | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    api.fs
      .readFile(entry.path)
      .then((d) => alive && setData(d))
      .catch((err) => alive && setError(errorMessage(err)))
    return () => {
      alive = false
    }
  }, [entry.path])
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-10 shrink-0 items-center gap-1.5 border-b border-border/70 pr-2 pl-2">
        <button
          type="button"
          onClick={onBack}
          className="rounded-md p-1.5 text-subtle hover:bg-hover hover:text-fg"
          aria-label="Voltar"
        >
          <ArrowLeft className="size-3.5" />
        </button>
        <FileText className="size-3.5 shrink-0 text-subtle" />
        <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{entry.name}</span>
        <span className="text-[11px] text-faint">{formatBytes(entry.size)}</span>
        {data && !data.binary && <CopyButton text={data.content} label="" />}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {!data && !error && (
          <div className="flex items-center gap-2 p-4 text-xs text-subtle">
            <Spinner /> Carregando…
          </div>
        )}
        {error && <div className="p-4 text-xs text-danger">{error}</div>}
        {data?.binary && (
          <div className="p-4 text-xs text-subtle">
            Arquivo binário — pré-visualização indisponível.
          </div>
        )}
        {data && !data.binary && (
          <>
            <pre className="px-4 py-3 font-mono text-[11.5px] leading-[1.65] whitespace-pre text-fg/85">
              {data.content}
            </pre>
            {data.truncated && (
              <div className="border-t border-border/70 px-4 py-2 text-[11px] text-warning/80">
                Arquivo grande: exibindo só o início.
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

export function FilesTab({ chat }: { chat: Chat }): React.JSX.Element {
  const homeDir = useStore((s) => s.homeDir)
  const patchConfig = useStore((s) => s.patchConfig)
  const run = useStore((s) => s.run)
  const tick = useStore((s) => s.fsTick[chat.id] ?? 0)
  const root = chat.config.cwd
  const confine = chat.config.confineToRoot !== false
  const [dir, setDir] = useState(root)
  const [reload, setReload] = useState(0)
  const [creating, setCreating] = useState(false)
  const [listing, setListing] = useState<{
    dir: string
    entries?: DirEntry[]
    error?: string
  } | null>(null)
  const [file, setFile] = useState<DirEntry | null>(null)
  const [prevRoot, setPrevRoot] = useState(root)
  if (prevRoot !== root) {
    setPrevRoot(root)
    setDir(root)
  }
  // Confinado: a navegação nunca sobe acima da raiz.
  const shownDir = confine && !insideRoot(dir, root) ? root : dir

  useEffect(() => {
    let alive = true
    api.fs
      .listDir(shownDir)
      .then((list) => alive && setListing({ dir: shownDir, entries: list }))
      .catch((err) => alive && setListing({ dir: shownDir, error: errorMessage(err) }))
    return () => {
      alive = false
    }
  }, [shownDir, tick, reload])
  const current = listing?.dir === shownDir ? listing : null
  const entries = current?.entries ?? null
  const error = current?.error ?? null

  const sorted = useMemo(
    () =>
      entries
        ? [...entries].sort((a, b) =>
            a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1
          )
        : [],
    [entries]
  )

  if (file) return <Preview entry={file} onBack={() => setFile(null)} />

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
        {creating && (
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
        {error && <div className="px-2 py-2 text-xs text-danger">{error}</div>}
        {entries && sorted.length === 0 && (
          <div className="px-2 py-6 text-center text-xs text-subtle">Pasta vazia</div>
        )}
        {sorted.map((e) => (
          <button
            key={e.path || join(shownDir, e.name)}
            type="button"
            onClick={() => (e.isDir ? setDir(e.path || join(shownDir, e.name)) : setFile(e))}
            className="group flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[12.5px] hover:bg-hover"
          >
            {e.isDir ? (
              <Folder
                className="size-3.5 shrink-0 text-accent-strong/70"
                fill="currentColor"
                fillOpacity={0.15}
              />
            ) : (
              <File className="size-3.5 shrink-0 text-subtle" />
            )}
            <span
              className={cn(
                'min-w-0 flex-1 truncate',
                e.isDir ? 'text-fg/90' : 'text-fg/75',
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
        ))}
      </div>
    </div>
  )
}
