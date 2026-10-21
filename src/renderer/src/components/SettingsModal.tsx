import { FolderOpen, Pencil, Plus, RotateCcw, Server, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { DEFAULT_BASE_URL, DEFAULT_SYSTEM_PROMPT } from '@shared/defaults'
import { defaultModelRef } from '@shared/models'
import { inferProviderKind, PROVIDER_KIND_LABEL, providerKind } from '@shared/providerKinds'
import type { Provider } from '@shared/types'
import { api, errorMessage } from '../lib/api'
import { cn, shortPath } from '../lib/format'
import { useStore, type SettingsTab } from '../store'
import { PresetEditor, PresetsList } from './presets/PresetsSettings'
import { PresetIcon } from './presets/PresetIcon'
import { ModelFieldInfo, SystemPromptInfo } from './apiDocs'
import { ProviderFields, TestButton, TestResult } from './ProviderForm'
import { draftToInput, useProviderTest, type ProviderDraft } from '../lib/provider'
import { AutoTextarea, Button, Label } from './ui/controls'
import { Modal } from './ui/layers'
import { ModelPicker } from './ui/ModelPicker'
import { Select } from './ui/Select'
import { HelpTip } from './ui/Tooltip'
import { ModelInfoLine } from './panel/editors'
import { ApprovalsSettings } from './approvals/ApprovalsSettings'
import { WebSearchSettings } from './web/WebSearchSettings'
import { MemorySettings } from './memory/MemorySettings'
import { SkillsSettings } from './skills/SkillsSettings'
import { AccountSettings } from './sync/AccountSettings'
import { VersionFooter } from './UpdateNotice'
import { AutoTitleSettings } from './AutoTitleSettings'

function toDraft(p?: Provider): ProviderDraft {
  return p
    ? {
        name: p.name,
        kind: providerKind(p),
        kindTouched: true,
        baseUrl: p.baseUrl,
        apiKey: p.apiKey,
        headersText: Object.keys(p.headers ?? {}).length ? JSON.stringify(p.headers, null, 2) : ''
      }
    : {
        name: '',
        kind: inferProviderKind(DEFAULT_BASE_URL),
        baseUrl: DEFAULT_BASE_URL,
        apiKey: '',
        headersText: ''
      }
}

function ProviderEditor({
  provider,
  onDone
}: {
  provider?: Provider
  onDone: () => void
}): React.JSX.Element {
  const [draft, setDraft] = useState(() => toDraft(provider))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { testing, result, test, reset } = useProviderTest()
  const refreshProviders = useStore((s) => s.refreshProviders)
  const loadModels = useStore((s) => s.loadModels)

  const save = async (): Promise<void> => {
    const input = draftToInput(draft)
    if (typeof input === 'string') return setError(input)
    setSaving(true)
    try {
      if (provider) {
        await api.providers.update(provider.id, input)
        void loadModels(provider.id, true)
      } else await api.providers.create(input)
      await refreshProviders()
      onDone()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="animate-fade-in rounded-xl border border-border-strong/70 bg-bg/40 p-4">
      <ProviderFields
        draft={draft}
        onChange={(d) => {
          setDraft(d)
          reset()
          setError(null)
        }}
      />
      <div className="mt-3 space-y-2 empty:hidden">
        <TestResult result={result} />
        {error && <TestResult result={{ ok: false, error }} />}
      </div>
      <div className="mt-4 flex items-center gap-2">
        <TestButton testing={testing} onClick={() => void test(draft)} />
        <div className="ml-auto flex gap-2">
          <Button variant="ghost" onClick={onDone}>
            Cancelar
          </Button>
          <Button variant="primary" loading={saving} onClick={() => void save()}>
            {provider ? 'Salvar' : 'Adicionar'}
          </Button>
        </div>
      </div>
    </div>
  )
}

function ProviderRow({
  provider,
  onEdit
}: {
  provider: Provider
  onEdit: () => void
}): React.JSX.Element {
  const [confirm, setConfirm] = useState(false)
  const run = useStore((s) => s.run)
  const refreshProviders = useStore((s) => s.refreshProviders)
  return (
    <div
      className="group flex items-center gap-3 rounded-xl border border-border bg-bg/30 px-3.5 py-2.5"
      onMouseLeave={() => setConfirm(false)}
    >
      <div className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-elevated">
        <Server className="size-3.5 text-muted" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2 text-[13px] font-medium">
          {provider.name}
          <span className="text-[11px] font-normal text-subtle">
            {PROVIDER_KIND_LABEL[providerKind(provider)]}
          </span>
        </div>
        <div className="truncate font-mono text-[11px] text-subtle">
          {provider.baseUrl}
          {provider.apiKey && (
            <span className="ml-2 text-faint">•••• {provider.apiKey.slice(-4)}</span>
          )}
        </div>
      </div>
      <div className="flex items-center gap-1 opacity-60 transition-opacity group-hover:opacity-100">
        <Button size="sm" variant="ghost" icon={<Pencil className="size-3.5" />} onClick={onEdit}>
          Editar
        </Button>
        {confirm ? (
          <Button
            size="sm"
            variant="danger"
            onClick={() =>
              void run(async () => {
                await api.providers.delete(provider.id)
                await refreshProviders()
              }, 'Erro ao remover provedor')
            }
          >
            Remover?
          </Button>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            className="hover:text-danger"
            icon={<Trash2 className="size-3.5" />}
            onClick={() => setConfirm(true)}
            aria-label="Remover"
          />
        )}
      </div>
    </div>
  )
}

function DefaultsSection(): React.JSX.Element {
  const providers = useStore((s) => s.providers)
  const settings = useStore((s) => s.settings)
  const homeDir = useStore((s) => s.homeDir)
  const setSetting = useStore((s) => s.setSetting)
  const setSettings = useStore((s) => s.setSettings)
  const run = useStore((s) => s.run)
  const [prompt, setPrompt] = useState(settings.defaultSystemPrompt ?? DEFAULT_SYSTEM_PROMPT)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // provedor apagado → padrão não definido
  const def = defaultModelRef(
    settings,
    providers.map((p) => p.id)
  )

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    []
  )

  const onPrompt = (v: string): void => {
    setPrompt(v)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => void setSetting('defaultSystemPrompt', v), 500)
  }

  return (
    <div className="space-y-4">
      <DefaultPresetField />
      <div className="flex items-center gap-1.5 text-xs leading-relaxed text-subtle">
        Padrões de chats novos
        <HelpTip label="Padrões de chats novos">
          Valem para os campos que a persona não define (a persona “Padrão” não define nenhum) e
          quando não há persona.
        </HelpTip>
      </div>
      <div>
        <Label info={<ModelFieldInfo />}>Modelo padrão</Label>
        <ModelPicker
          value={def.providerId ? def : null}
          placeholder="Não definido — escolha no Novo chat"
          onChange={(ref) =>
            void setSettings({ defaultProviderId: ref.providerId, defaultModel: ref.model })
          }
        />
        <div className="mt-1.5 empty:hidden">
          <ModelInfoLine providerId={def.providerId} model={def.model} />
        </div>
      </div>
      <div>
        <Label
          info={<SystemPromptInfo />}
          hint={
            prompt !== DEFAULT_SYSTEM_PROMPT && (
              <button
                type="button"
                onClick={() => onPrompt(DEFAULT_SYSTEM_PROMPT)}
                className="inline-flex items-center gap-1 hover:text-fg"
              >
                <RotateCcw className="size-3" /> Restaurar padrão
              </button>
            )
          }
        >
          System prompt padrão
        </Label>
        <AutoTextarea
          value={prompt}
          onChange={(e) => onPrompt(e.target.value)}
          minRows={5}
          maxRows={12}
          className="field text-[12.5px] leading-relaxed"
        />
      </div>
      <div>
        <Label>Pasta de trabalho padrão</Label>
        <button
          type="button"
          onClick={() =>
            void run(async () => {
              const d = await api.fs.pickDirectory()
              if (d) await setSetting('defaultCwd', d)
            })
          }
          className="field group flex items-center gap-2.5 text-left"
        >
          <FolderOpen className="size-4 shrink-0 text-subtle group-hover:text-accent-strong" />
          <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]">
            {shortPath(settings.defaultCwd ?? homeDir ?? '~', homeDir)}
          </span>
          <span className="text-xs text-subtle group-hover:text-fg">Alterar</span>
        </button>
      </div>
      <AutoTitleSettings />
    </div>
  )
}

function DefaultPresetField(): React.JSX.Element {
  const presets = useStore((s) => s.presets)
  const defaultPresetId = useStore((s) => s.settings.defaultPresetId)
  const setSetting = useStore((s) => s.setSetting)
  const NONE = '__none__'
  return (
    <div>
      <Label>Persona padrão do Novo chat</Label>
      <Select
        value={presets.some((p) => p.id === defaultPresetId) ? defaultPresetId : NONE}
        onChange={(v) => void setSetting('defaultPresetId', v === NONE ? null : v)}
        options={[
          ...presets.map((p) => ({
            value: p.id,
            label: (
              <span className="flex items-center gap-2">
                <PresetIcon icon={p.icon} size="sm" className="size-5 border-0 bg-transparent" />
                {p.name}
              </span>
            ),
            description: p.description || undefined
          })),
          { value: NONE, label: 'Nenhuma (só os padrões abaixo)' }
        ]}
      />
    </div>
  )
}

export function SettingsModal(): React.JSX.Element {
  const open = useStore((s) => s.settingsOpen)
  const setOpen = useStore((s) => s.setSettingsOpen)
  const tab = useStore((s) => s.settingsTab)
  const providers = useStore((s) => s.providers)
  const presets = useStore((s) => s.presets)
  const [editing, setEditing] = useState<string | 'new' | null>(null)
  const [editingPreset, setEditingPreset] = useState<string | 'new' | null>(null)
  const setTab = (t: SettingsTab): void => {
    setOpen(true, t)
    setEditingPreset(null)
  }

  return (
    <Modal
      open={open}
      onClose={() => {
        setOpen(false)
        setEditing(null)
        setEditingPreset(null)
      }}
      title="Configurações"
      footer={<VersionFooter />}
      width={
        (tab === 'presets' && editingPreset) || tab === 'memory' || tab === 'skills' ? 720 : 680
      }
    >
      <div className="mb-5 flex gap-0.5 border-b border-border">
        {(
          [
            ['account', 'Conta'],
            ['providers', 'Provedores'],
            ['presets', 'Personas'],
            ['defaults', 'Novos chats'],
            ['approvals', 'Aprovações'],
            ['memory', 'Memórias'],
            ['skills', 'Skills'],
            ['web', 'Pesquisa na web']
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={cn(
              '-mb-px shrink-0 border-b-2 px-2 pb-2 text-[13px] whitespace-nowrap transition-colors',
              tab === id ? 'border-accent text-fg' : 'border-transparent text-subtle hover:text-fg'
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'account' ? (
        <AccountSettings />
      ) : tab === 'providers' ? (
        <div className="space-y-2.5">
          <p className="mb-3 text-xs text-subtle">
            Endpoints compatíveis com a API da OpenAI (chat/completions), OpenRouter ou a API nativa
            da Anthropic.
          </p>
          {providers.map((p) =>
            editing === p.id ? (
              <ProviderEditor key={p.id} provider={p} onDone={() => setEditing(null)} />
            ) : (
              <ProviderRow key={p.id} provider={p} onEdit={() => setEditing(p.id)} />
            )
          )}
          {editing === 'new' ? (
            <ProviderEditor onDone={() => setEditing(null)} />
          ) : (
            <button
              type="button"
              onClick={() => setEditing('new')}
              className="flex h-11 w-full items-center justify-center gap-2 rounded-xl border border-dashed border-border-strong text-[13px] text-subtle transition-colors hover:border-accent/50 hover:bg-accent-soft/30 hover:text-fg"
            >
              <Plus className="size-4" /> Adicionar provedor
            </button>
          )}
        </div>
      ) : tab === 'presets' ? (
        editingPreset ? (
          <PresetEditor
            key={editingPreset}
            preset={presets.find((p) => p.id === editingPreset) ?? null}
            onDone={() => setEditingPreset(null)}
          />
        ) : (
          <PresetsList onEdit={setEditingPreset} />
        )
      ) : tab === 'approvals' ? (
        <ApprovalsSettings />
      ) : tab === 'memory' ? (
        <MemorySettings />
      ) : tab === 'skills' ? (
        <SkillsSettings />
      ) : tab === 'web' ? (
        <WebSearchSettings />
      ) : (
        <DefaultsSection />
      )}
    </Modal>
  )
}
