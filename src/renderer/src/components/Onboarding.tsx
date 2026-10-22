import { ArrowLeft, ArrowRight, Cloud, ExternalLink, KeyRound } from 'lucide-react'
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
  // escolha inicial → 'provider' (formulário) ou 'signin' (conta online)
  const [step, setStep] = useState<'choose' | 'provider' | 'signin'>('choose')
  const connected = sync?.phase === 'ready'
  // entrou (e desbloqueou) mas a conta não tinha provedores: vai direto à configuração do provedor
  const showFlow = step === 'signin' && !connected
  const showForm = step === 'provider' || connected

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

  const card =
    'rounded-2xl border border-border bg-surface/80 p-5 shadow-[0_1px_0_rgb(255_255_255/0.03)_inset]'

  return (
    <div className="flex h-full flex-col">
      <div className="drag h-titlebar shrink-0" />
      {/* my-auto (e não items-center): centraliza sem cortar o topo quando o conteúdo é mais alto */}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6 pb-16">
        <div className="mx-auto my-auto w-full max-w-[400px] animate-slide-up pt-4">
          <div className="mb-8 flex flex-col items-center text-center">
            <Logo className="mb-5 size-11" />
            <h1 className="text-[22px] font-semibold tracking-tight">Bem-vindo ao ClearChat</h1>
            <p className="mt-2 max-w-[320px] text-[13px] leading-relaxed text-muted">
              {showForm
                ? 'Conecte um provedor (OpenRouter, Anthropic ou qualquer API compatível com a da OpenAI) para começar. Você pode adicionar outros depois.'
                : 'Conecte um provedor de IA para começar — ou entre na sua conta para trazer provedores, chats e personas de outro computador.'}
            </p>
          </div>
          {showFlow ? (
            <div data-testid="onboarding-signin" className={card}>
              <AccountFlow onCancel={() => setStep('choose')} />
            </div>
          ) : showForm ? (
            <>
              <form
                className={card}
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
              {connected ? (
                <p className="mt-4 text-center text-[11.5px] leading-relaxed text-subtle">
                  <Cloud className="mr-1.5 inline size-3.5 -translate-y-px text-accent-strong" />
                  Conectado como {sync?.account?.email} — o provedor será sincronizado (cifrado) com
                  seus outros dispositivos.
                </p>
              ) : (
                <>
                  <p className="mt-4 text-center text-[11.5px] text-subtle">
                    A chave fica salva só neste computador e é enviada apenas ao endpoint
                    configurado.
                  </p>
                  <div className="mt-3 flex justify-center">
                    <Button
                      variant="ghost"
                      size="sm"
                      icon={<ArrowLeft className="size-3.5" />}
                      data-testid="onboarding-back"
                      onClick={() => setStep('choose')}
                    >
                      Voltar
                    </Button>
                  </div>
                </>
              )}
            </>
          ) : (
            <div className="space-y-2.5" data-testid="onboarding-choose">
              <Button
                variant="primary"
                size="lg"
                className="w-full"
                icon={<KeyRound className="size-4" />}
                data-testid="onboarding-provider"
                onClick={() => setStep('provider')}
              >
                Configurar provedor
              </Button>
              <div className="grid grid-cols-2 gap-2.5">
                <Button
                  size="lg"
                  icon={<Cloud className="size-4" />}
                  data-testid="onboarding-login"
                  onClick={() => setStep('signin')}
                >
                  Entrar
                </Button>
                <Button
                  size="lg"
                  icon={<ExternalLink className="size-4" />}
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
              <p className="pt-2 text-center text-[11.5px] leading-relaxed text-subtle">
                A conta é opcional: sincroniza tudo cifrado ponta a ponta entre seus computadores.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
