// "Salvar como persona": nome, ícone, descrição, incluir diretório raiz e (se houver persona de
// origem) a opção de atualizá-la em vez de criar outra. Usado no Novo chat e na aba Chat.
import { useState } from 'react'
import type { PresetConfig } from '@shared/presets'
import type { Preset } from '@shared/types'
import { cn, compactPath } from '../../lib/format'
import { useStore } from '../../store'
import { ToggleRow } from '../panel/fields'
import { Button, Label } from '../ui/controls'
import { Modal } from '../ui/layers'
import { IconPicker, PresetIcon } from './PresetIcon'

export type SaveMode = 'new' | 'update'

export function SavePresetDialog({
  open,
  onClose,
  cwd,
  base,
  buildConfig,
  onSaved,
  defaultMode = 'new'
}: {
  open: boolean
  onClose: () => void
  /** Diretório raiz atual (opção "incluir diretório raiz"). */
  cwd: string | null
  /** Persona de origem — habilita "Atualizar". */
  base?: Preset | null
  buildConfig: (mode: SaveMode, includeCwd: boolean) => PresetConfig
  onSaved?: (preset: Preset, mode: SaveMode) => void
  defaultMode?: SaveMode
}): React.JSX.Element {
  return (
    <Modal
      open={open}
      onClose={onClose}
      width={520}
      title="Salvar como persona"
      subtitle="Guarda modelo, system prompt, parâmetros, tools e ajustes do chat para reutilizar."
    >
      {open && (
        <SaveForm
          cwd={cwd}
          base={base ?? null}
          buildConfig={buildConfig}
          defaultMode={base ? defaultMode : 'new'}
          onCancel={onClose}
          onSaved={(p, m) => {
            onSaved?.(p, m)
            onClose()
          }}
        />
      )}
    </Modal>
  )
}

function SaveForm({
  cwd,
  base,
  buildConfig,
  defaultMode,
  onCancel,
  onSaved
}: {
  cwd: string | null
  base: Preset | null
  buildConfig: (mode: SaveMode, includeCwd: boolean) => PresetConfig
  defaultMode: SaveMode
  onCancel: () => void
  onSaved: (preset: Preset, mode: SaveMode) => void
}): React.JSX.Element {
  const savePreset = useStore((s) => s.savePreset)
  const toast = useStore((s) => s.toast)
  const homeDir = useStore((s) => s.homeDir)
  const fieldsFor = (m: SaveMode): { name: string; icon: string; description: string } =>
    m === 'update' && base
      ? { name: base.name, icon: base.icon, description: base.description }
      : { name: '', icon: 'sparkles', description: '' }
  const [mode, setMode] = useState<SaveMode>(defaultMode)
  const [fields, setFields] = useState(() => fieldsFor(defaultMode))
  const [includeCwd, setIncludeCwd] = useState(
    defaultMode === 'update' ? !!base?.config.cwd : false
  )
  const [iconsOpen, setIconsOpen] = useState(false)
  const [saving, setSaving] = useState(false)

  const switchMode = (m: SaveMode): void => {
    setMode(m)
    setFields(fieldsFor(m))
    setIncludeCwd(m === 'update' ? !!base?.config.cwd : false)
  }

  const save = async (): Promise<void> => {
    if (!fields.name.trim()) return
    setSaving(true)
    const preset = await savePreset(
      {
        name: fields.name.trim(),
        icon: fields.icon,
        description: fields.description.trim(),
        config: buildConfig(mode, includeCwd)
      },
      mode === 'update' && base ? base.id : undefined
    )
    setSaving(false)
    if (!preset) return
    toast(
      mode === 'update'
        ? `Persona “${preset.name}” atualizada.`
        : `Persona “${preset.name}” criada.`,
      'success'
    )
    onSaved(preset, mode)
  }

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
    >
      {base && (
        <div className="flex rounded-lg border border-border bg-bg/60 p-0.5" role="radiogroup">
          {(
            [
              ['new', 'Nova persona'],
              ['update', `Atualizar “${base.name}”`]
            ] as const
          ).map(([m, label]) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={mode === m}
              onClick={() => switchMode(m)}
              className={cn(
                'min-w-0 flex-1 truncate rounded-md px-2 py-1.5 text-[12.5px] transition-colors',
                mode === m ? 'bg-active text-fg shadow-sm' : 'text-subtle hover:text-fg'
              )}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      <div className="flex items-end gap-3">
        <div>
          <Label>Ícone</Label>
          <button
            type="button"
            aria-label="Escolher ícone"
            aria-expanded={iconsOpen}
            onClick={() => setIconsOpen((o) => !o)}
            className="rounded-lg transition-opacity hover:opacity-80"
          >
            <PresetIcon icon={fields.icon} size="lg" />
          </button>
        </div>
        <div className="min-w-0 flex-1">
          <Label>Nome</Label>
          <input
            autoFocus
            className="field h-10"
            aria-label="Nome da persona"
            placeholder="Ex.: Revisor de código"
            value={fields.name}
            onChange={(e) => setFields((f) => ({ ...f, name: e.target.value }))}
          />
        </div>
      </div>
      {iconsOpen && (
        <div className="animate-fade-in rounded-xl border border-border bg-bg/40 p-2.5">
          <IconPicker value={fields.icon} onChange={(icon) => setFields((f) => ({ ...f, icon }))} />
        </div>
      )}
      <div>
        <Label>Descrição</Label>
        <input
          className="field"
          aria-label="Descrição da persona"
          placeholder="Opcional — para que serve esta persona"
          value={fields.description}
          onChange={(e) => setFields((f) => ({ ...f, description: e.target.value }))}
        />
      </div>
      {cwd && (
        <ToggleRow
          label="Incluir diretório raiz"
          status={compactPath(cwd, homeDir, 52)}
          checked={includeCwd}
          onChange={setIncludeCwd}
        />
      )}
      <div className="flex justify-end gap-2 pt-1">
        <Button variant="ghost" onClick={onCancel}>
          Cancelar
        </Button>
        <Button variant="primary" type="submit" loading={saving} disabled={!fields.name.trim()}>
          {mode === 'update' ? 'Atualizar persona' : 'Salvar persona'}
        </Button>
      </div>
    </form>
  )
}
