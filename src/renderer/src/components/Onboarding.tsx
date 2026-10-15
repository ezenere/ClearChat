import { ArrowRight } from 'lucide-react'
import { useState } from 'react'
import { DEFAULT_BASE_URL, DEFAULT_PROVIDER_NAME } from '@shared/defaults'
import { api, errorMessage } from '../lib/api'
import { useStore } from '../store'
import { Logo } from './Logo'
import { ProviderFields, TestButton, TestResult } from './ProviderForm'
import { draftToInput, useProviderTest, type ProviderDraft } from '../lib/provider'
import { Button } from './ui/controls'

export function Onboarding(): React.JSX.Element {
  const [draft, setDraft] = useState<ProviderDraft>({
    name: DEFAULT_PROVIDER_NAME,
    baseUrl: DEFAULT_BASE_URL,
    apiKey: '',
    headersText: ''
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { testing, result, test, reset } = useProviderTest()
  const refreshProviders = useStore((s) => s.refreshProviders)
  const setSetting = useStore((s) => s.setSetting)

  const submit = async (): Promise<void> => {
    const input = draftToInput(draft)
    if (typeof input === 'string') return setError(input)
    setSaving(true)
    setError(null)
    try {
      const p = await api.providers.create(input)
      await setSetting('defaultProviderId', p.id)
      await refreshProviders()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="drag h-titlebar shrink-0" />
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-6 pb-16">
        <div className="w-full max-w-[400px] animate-slide-up">
          <div className="mb-8 flex flex-col items-center text-center">
            <Logo className="mb-5 size-11" />
            <h1 className="text-[22px] font-semibold tracking-tight">Bem-vindo ao ClearChat</h1>
            <p className="mt-2 max-w-[320px] text-[13px] leading-relaxed text-muted">
              Conecte um provedor compatível com a API da OpenAI para começar. Você pode adicionar
              outros depois.
            </p>
          </div>
          <form
            className="rounded-2xl border border-border bg-surface/80 p-5 shadow-[0_1px_0_rgb(255_255_255/0.03)_inset]"
            onSubmit={(e) => {
              e.preventDefault()
              void submit()
            }}
          >
            <ProviderFields
              draft={draft}
              onChange={(d) => {
                setDraft(d)
                reset()
                setError(null)
              }}
              showHeaders={false}
              autoFocusKey
            />
            <div className="mt-4 space-y-2 empty:hidden">
              <TestResult result={result} />
              {error && <TestResult result={{ ok: false, error }} />}
            </div>
            <div className="mt-5 flex items-center justify-between gap-2">
              <TestButton testing={testing} onClick={() => void test(draft)} />
              <Button
                type="submit"
                variant="primary"
                loading={saving}
                disabled={!draft.apiKey.trim()}
              >
                Continuar <ArrowRight className="size-3.5" />
              </Button>
            </div>
          </form>
          <p className="mt-4 text-center text-[11.5px] text-subtle">
            A chave fica salva só neste computador e é enviada apenas ao endpoint configurado.
          </p>
        </div>
      </div>
    </div>
  )
}
