// Skills no sync (opt-in, docs/SYNC_PROTOCOL.md §13): "Sincronizar" por skill local e a seção
// "Skills na nuvem" (baixar sob pedido; baixadas passam a ser acompanhadas).
import { CloudDownload, CloudOff, Cloud, Trash2 } from 'lucide-react'
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { CloudSkill } from '@shared/sync'
import type { SkillInfo } from '@shared/skills'
import { api } from '../../lib/api'
import { formatBytes } from '../../lib/format'
import { useStore } from '../../store'
import { Button, Switch } from '../ui/controls'
import { Tip } from '../ui/Tooltip'

interface SkillSyncState {
  ready: boolean
  tracked: Set<string>
  cloud: CloudSkill[]
  reload: () => Promise<void>
}

const Ctx = createContext<SkillSyncState>({
  ready: false,
  tracked: new Set(),
  cloud: [],
  reload: async () => {}
})

export function SkillSyncProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const ready = useStore((s) => s.sync?.phase === 'ready')
  const tick = useStore((s) => s.skillsTick)
  const [tracked, setTracked] = useState<Set<string>>(new Set())
  const [cloud, setCloud] = useState<CloudSkill[]>([])
  const reload = useCallback(async () => {
    if (!ready) return
    try {
      const [t, c] = await Promise.all([api.sync.trackedSkills(), api.sync.cloudSkills()])
      setTracked(new Set(t))
      setCloud(c)
    } catch {
      /* offline */
    }
  }, [ready])
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- carga assíncrona
    void reload()
  }, [reload, tick])
  const value = useMemo(() => ({ ready, tracked, cloud, reload }), [ready, tracked, cloud, reload])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

/** Interruptor "Sincronizar" de uma skill local (pasta de origem). */
export function SkillSyncToggle({ skill }: { skill: SkillInfo }): React.JSX.Element | null {
  const { ready, tracked, reload } = useContext(Ctx)
  const run = useStore((s) => s.run)
  const [busy, setBusy] = useState(false)
  if (!ready || skill.error || skill.shadowedBy || skill.locationId === 'synced') return null
  const on = tracked.has(skill.name)
  return (
    <Tip
      label={
        on
          ? 'Sincronizada (cifrada) com seus dispositivos — clique para parar'
          : 'Enviar esta skill (cifrada) para seus outros dispositivos'
      }
    >
      <span
        className="flex shrink-0 items-center gap-1 text-[10.5px] text-subtle"
        onClick={(e) => e.stopPropagation()}
        data-testid="skill-sync-toggle"
      >
        <Cloud className="size-3" />
        <Switch
          size="sm"
          checked={on}
          disabled={busy}
          label="Sincronizar"
          onChange={(v) => {
            setBusy(true)
            void run(
              () => api.sync.setSkillSync(skill.name, v),
              'Falha ao sincronizar a skill'
            ).finally(() => {
              setBusy(false)
              void reload()
            })
          }}
        />
      </span>
    </Tip>
  )
}

export function CloudSkillsSection(): React.JSX.Element | null {
  const { ready, cloud, reload } = useContext(Ctx)
  const run = useStore((s) => s.run)
  const toast = useStore((s) => s.toast)
  const [busy, setBusy] = useState<string | null>(null)
  if (!ready) return null
  const notHere = cloud.filter((c) => !c.local)
  const download = (names?: string[]): void => {
    setBusy(names?.[0] ?? '*')
    void run(async () => {
      const n = await api.sync.downloadSkills(names)
      toast(`${n} skill${n === 1 ? '' : 's'} baixada${n === 1 ? '' : 's'}.`, 'success')
    }, 'Falha ao baixar').finally(() => {
      setBusy(null)
      void reload()
    })
  }
  return (
    <div
      className="rounded-xl border border-border bg-surface/50 px-3.5 py-3"
      data-testid="cloud-skills"
    >
      <div className="mb-2 flex items-center gap-2">
        <Cloud className="size-3.5 text-accent-strong" />
        <span className="text-[13px] font-medium">Skills na nuvem</span>
        <span className="text-[11px] text-subtle">
          só baixadas quando você pede · depois ficam atualizadas
        </span>
        {notHere.length > 1 && (
          <Button size="sm" className="ml-auto" loading={busy === '*'} onClick={() => download()}>
            Baixar todas
          </Button>
        )}
      </div>
      {!cloud.length ? (
        <p className="text-[11.5px] text-faint">
          Nenhuma skill sincronizada. Ligue “Sincronizar” numa skill acima para enviá-la.
        </p>
      ) : (
        <div className="-mx-1 space-y-px">
          {cloud.map((c) => (
            <div
              key={c.recordId}
              className="group flex items-center gap-2 rounded-lg px-1.5 py-1.5 hover:bg-hover/40"
              data-testid="cloud-skill"
              data-skill={c.name}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate font-mono text-[12px] text-fg/90">{c.name}</span>
                  <span className="shrink-0 text-[10.5px] text-faint tabular-nums">
                    {c.files} arquivo{c.files === 1 ? '' : 's'} · {formatBytes(c.size)}
                  </span>
                  <span className="shrink-0 rounded bg-hover px-1.5 py-px text-[10.5px] text-subtle">
                    {c.local === 'source'
                      ? 'daqui'
                      : c.local === 'copy'
                        ? 'baixada'
                        : 'não baixada'}
                  </span>
                </div>
                <p className="line-clamp-1 text-[11.5px] text-subtle">{c.description}</p>
              </div>
              {!c.local && (
                <Button
                  size="sm"
                  icon={<CloudDownload className="size-3.5" />}
                  loading={busy === c.name}
                  onClick={() => download([c.name])}
                >
                  Baixar
                </Button>
              )}
              {c.local === 'copy' && (
                <Tip label="Parar de acompanhar (a cópia fica, sem atualizações)">
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<CloudOff className="size-3.5" />}
                    aria-label="Parar de sincronizar"
                    onClick={() =>
                      void run(() => api.sync.stopTrackingSkill(c.name)).then(() => reload())
                    }
                  />
                </Tip>
              )}
              <Tip label="Remover da nuvem (cópias baixadas são apagadas; pastas de origem nunca)">
                <Button
                  size="sm"
                  variant="ghost"
                  className="opacity-60 group-hover:opacity-100 hover:text-danger"
                  icon={<Trash2 className="size-3.5" />}
                  aria-label="Remover da nuvem"
                  onClick={() =>
                    void run(() => api.sync.removeCloudSkill(c.name)).then(() => reload())
                  }
                />
              </Tip>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
