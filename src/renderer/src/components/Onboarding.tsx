import { ArrowRight, Cloud, ExternalLink } from 'lucide-react'
import { useState } from 'react'
import { DEFAULT_BASE_URL, DEFAULT_PROVIDER_NAME } from '@shared/defaults'
import { inferProviderKind } from '@shared/providerKinds'
import { api, errorMessage } from '../lib/api'
import { useStore } from '../store'
import { Logo } from './Logo'
import { ProviderFields, TestButton, TestResult } from './ProviderForm'
import { draftToInput, useProviderTest, type ProviderDraft } from '../lib/provider'
import { Button } from './ui/controls'
import { AccountFlow } from './sync/AccountFlow'

export function Onboarding(): React.JSX.Element {
  const [draft, setDraft] = useState<ProviderDraft>({
    name: DEFAULT_PROVIDER_NAME,
    kind: inferProviderKind(DEFAULT_BASE_URL),
    baseUrl: DEFAULT_BASE_URL,
    apiKey: '',
    headersText: ''
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { testing, result, test, reset } = useProviderTest()
  const refreshProviders = useStore((s) => s.refreshProviders)
  const sync = useStore((s) => s.sync)
  const run = useStore((s) => s.run)
  const [signIn, setSignIn] = useState(false)
  const connected = sync?.phase === 'ready'
  // entrou (e desbloqueou) mas a conta não tinha provedores: volta à configuração do provedor
  const showFlow = signIn && !connected

  const submit = async (): Promise<void> => {
    const input = draftToInput(draft)
    if (typeof input === 'string') return setError(input)
    setSaving(true)
    setError(null)
    try {
      await api.providers.create(input)
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
              Conecte um provedor (OpenRouter, Anthropic ou qualquer API compatível com a da OpenAI)
              para começar. Você pode adicionar outros depois.
            </p>
          </div>
          {showFlow ? (
            <div
              data-testid="onboarding-signin"
              className="rounded-2xl border border-border bg-surface/80 p-5 shadow-[0_1px_0_rgb(255_255_255/0.03)_inset]"
            >
              <AccountFlow onCancel={() => setSignIn(false)} />
            </div>
          ) : (
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
          )}
          {!showFlow && connected && (
            <p className="mt-4 text-center text-[11.5px] leading-relaxed text-subtle">
              <Cloud className="mr-1.5 inline size-3.5 -translate-y-px text-accent-strong" />
              Conectado como {sync?.account?.email} — o provedor será sincronizado (cifrado) com
              seus outros dispositivos.
            </p>
          )}
          {!showFlow && !connected && (
            <>
              <p className="mt-4 text-center text-[11.5px] text-subtle">
                A chave fica salva só neste computador e é enviada apenas ao endpoint configurado.
              </p>
              <div className="mt-6 flex items-center gap-3 text-[11px] text-faint">
                <span className="h-px flex-1 bg-border" /> ou{' '}
                <span className="h-px flex-1 bg-border" />
              </div>
              <div className="mt-4 rounded-2xl border border-border bg-surface/50 px-4 py-3.5">
                <p className="text-[12.5px] text-muted">
                  Já usa o ClearChat em outro computador? Entre na sua conta para trazer provedores,
                  chats e personas — cifrados ponta a ponta.
                </p>
                <div className="mt-3 flex gap-2">
                  <Button
                    variant="primary"
                    icon={<Cloud className="size-3.5" />}
                    data-testid="onboarding-login"
                    onClick={() => setSignIn(true)}
                  >
                    Entrar
                  </Button>
                  <Button
                    icon={<ExternalLink className="size-3.5" />}
                    onClick={() =>
                      void run(async () => {
                        const info = await api.sync.probeServer()
                        if (!info.signupOpen)
                          throw new Error(`O cadastro em ${info.name} é só por convite.`)
                        await api.sync.openSignup()
                      }, 'Criar conta')
                    }
                  >
                    Criar conta
                  </Button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
