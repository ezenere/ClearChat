import { ArrowRight, FolderOpen, FolderPlus, RotateCcw } from 'lucide-react'
import { useState } from 'react'
import { DEFAULT_APP_SIGNATURE } from '@shared/appSignatures'
import { DEFAULT_SYSTEM_PROMPT, isOpenRouter } from '@shared/defaults'
import { AppSignatureField, AppSignatureInfo } from './AppSignatureField'
import { api } from '../lib/api'
import { compactPath } from '../lib/format'
import { useStore } from '../store'
import { ModelFieldInfo, ProviderFieldInfo, RootInfo, SystemPromptInfo } from './apiDocs'
import { NewFolderForm } from './panel/FilesTab'
import { Tip } from './ui/Tooltip'
import { AutoTextarea, Button, Kbd, Label } from './ui/controls'
import { ModelCombobox } from './ui/ModelCombobox'
import { Select } from './ui/Select'

export function NewChat(): React.JSX.Element {
  const providers = useStore((s) => s.providers)
  const settings = useStore((s) => s.settings)
  const homeDir = useStore((s) => s.homeDir)
  const createChat = useStore((s) => s.createChat)
  const run = useStore((s) => s.run)

  const initialProvider =
    providers.find((p) => p.id === settings.defaultProviderId)?.id ?? providers[0]?.id ?? null
  const [providerId, setProviderId] = useState<string | null>(initialProvider)
  const [model, setModel] = useState(settings.defaultModel ?? '')
  const [systemPrompt, setSystemPrompt] = useState(
    settings.defaultSystemPrompt ?? DEFAULT_SYSTEM_PROMPT
  )
  const [cwd, setCwd] = useState<string | null>(settings.defaultCwd ?? homeDir)
  const [creating, setCreating] = useState(false)
  const [newFolder, setNewFolder] = useState(false)
  const [appSignature, setAppSignature] = useState(DEFAULT_APP_SIGNATURE)
  const [appSignatureCustom, setAppSignatureCustom] = useState({ referer: '', title: '' })

  const defaultPrompt = settings.defaultSystemPrompt ?? DEFAULT_SYSTEM_PROMPT
  const provider = providers.find((p) => p.id === providerId)
  const canStart = !!provider && model.trim().length > 0 && !!cwd

  const start = async (): Promise<void> => {
    if (!canStart || !provider || !cwd) return
    setCreating(true)
    await createChat({
      config: {
        providerId: provider.id,
        model: model.trim(),
        systemPrompt,
        cwd,
        cacheEnabled: isOpenRouter(provider.baseUrl),
        appSignature,
        ...(appSignature === 'custom' ? { appSignatureCustom } : {})
      }
    })
    setCreating(false)
  }

  const pickDir = async (): Promise<void> => {
    const dir = await run(() => api.fs.pickDirectory(), 'Erro ao escolher pasta')
    if (dir) setCwd(dir)
  }

  return (
    <div
      className="flex min-h-0 flex-1 justify-center overflow-y-auto px-8"
      onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault()
          void start()
        }
      }}
    >
      <div className="w-full max-w-[600px] animate-slide-up py-[9vh]">
        <h1 className="text-[24px] font-semibold tracking-tight">Novo chat</h1>
        <p className="mt-1.5 text-[13px] text-muted">
          Escolha o modelo, ajuste o system prompt e comece.
        </p>

        <div className="mt-8 space-y-5">
          <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-3">
            <div>
              <Label info={<ProviderFieldInfo />}>Provedor</Label>
              <Select
                value={providerId}
                onChange={setProviderId}
                options={providers.map((p) => ({
                  value: p.id,
                  label: p.name,
                  description: p.baseUrl
                }))}
              />
            </div>
            <div>
              <Label info={<ModelFieldInfo />}>Modelo</Label>
              <ModelCombobox providerId={providerId} value={model} onChange={setModel} />
            </div>
          </div>

          <div>
            <Label
              info={<SystemPromptInfo />}
              hint={
                systemPrompt !== defaultPrompt && (
                  <button
                    type="button"
                    onClick={() => setSystemPrompt(defaultPrompt)}
                    className="inline-flex items-center gap-1 text-subtle hover:text-fg"
                  >
                    <RotateCcw className="size-3" /> Restaurar padrão
                  </button>
                )
              }
            >
              System prompt
            </Label>
            <AutoTextarea
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              minRows={6}
              maxRows={16}
              placeholder="Instruções para o modelo (opcional)"
              className="field leading-relaxed"
            />
          </div>

          <div className="grid grid-cols-[minmax(0,3fr)_minmax(0,2fr)] items-start gap-3">
            <div>
              <Label info={<RootInfo />}>Diretório raiz</Label>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => void pickDir()}
                  className="field group flex min-w-0 flex-1 items-center gap-2.5 text-left"
                >
                  <FolderOpen className="size-4 shrink-0 text-subtle group-hover:text-accent-strong" />
                  <span
                    data-testid="new-chat-root"
                    className="min-w-0 flex-1 truncate font-mono text-[12.5px]"
                    title={cwd ?? undefined}
                  >
                    {cwd ? (
                      compactPath(cwd, homeDir, 40)
                    ) : (
                      <span className="font-sans text-subtle">Escolher pasta…</span>
                    )}
                  </span>
                  <span className="text-xs text-subtle group-hover:text-fg">Alterar</span>
                </button>
                <Tip label="Criar uma pasta nova (projeto novo) dentro da selecionada">
                  <button
                    type="button"
                    aria-label="Nova pasta…"
                    onClick={() => setNewFolder((v) => !v)}
                    className="field flex w-auto shrink-0 items-center gap-1.5 px-2.5 text-xs text-subtle hover:text-fg"
                  >
                    <FolderPlus className="size-4" />
                    <span className="max-[1179px]:hidden">Nova pasta…</span>
                  </button>
                </Tip>
              </div>
              {newFolder && (cwd ?? homeDir) && (
                <div className="mt-2">
                  <NewFolderForm
                    parent={(cwd ?? homeDir)!}
                    onCancel={() => setNewFolder(false)}
                    onCreated={(p) => {
                      setNewFolder(false)
                      setCwd(p)
                    }}
                  />
                </div>
              )}
              <p className="mt-1.5 text-[11px] leading-snug text-subtle">
                Workspace da sessão: o agente cria e edita arquivos e roda o bash aqui.
              </p>
            </div>
            <div>
              <Label
                info={<AppSignatureInfo id={appSignature} custom={appSignatureCustom} side="top" />}
              >
                Assinatura do app
              </Label>
              <AppSignatureField
                value={appSignature}
                custom={appSignatureCustom}
                onChange={(p) => {
                  if (p.appSignature !== undefined) setAppSignature(p.appSignature)
                  if (p.appSignatureCustom) setAppSignatureCustom(p.appSignatureCustom)
                }}
              />
            </div>
          </div>
        </div>

        <div className="mt-8 flex items-center justify-end gap-3">
          <span className="flex items-center gap-1 text-[11px] text-subtle">
            <Kbd>Ctrl</Kbd>
            <Kbd>Enter</Kbd>
          </span>
          <Button
            variant="primary"
            size="lg"
            disabled={!canStart}
            loading={creating}
            onClick={() => void start()}
          >
            Começar <ArrowRight className="size-4" />
          </Button>
        </div>
      </div>
    </div>
  )
}
