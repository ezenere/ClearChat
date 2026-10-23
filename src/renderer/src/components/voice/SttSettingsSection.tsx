// Configurações → Áudio → Transcrição (STT): modo (API/Local/Híbrido); nos modos com API, o
// PROVEDOR (um dos cadastrados em Provedores que serve transcrição, ou "Endpoint personalizado" no
// avançado) e o MODELO listado por ele (descoberta no main, com correção de apelidos); nos modos
// com motor local, o motor e o catálogo de modelos locais (no híbrido: qual modelo local faz as
// parciais/especulação e a reserva). A chave do provedor nunca passa pela tela.
import { useCallback, useState } from 'react'
import type { VoiceModelInfo, VoiceRuntimeStatus } from '@shared/ipc'
import type { SttMode, SttSettings } from '@shared/voice'
import { STT_LOCAL_PARTIAL_MAX_MODEL_BYTES } from '@shared/voice'
import { voiceProviderSupport, type VoiceProviderSupport } from '@shared/voiceCatalog'
import { useVoiceCatalog } from '../../lib/voice/useVoiceCatalog'
import type { LocalModelAction } from '../../lib/voice/modelList'
import { Label, Switch } from '../ui/controls'
import { Select } from '../ui/Select'
import { ApiInfo, C, HelpTip } from '../ui/Tooltip'
import {
  ApiKeyField,
  BaseUrlField,
  CustomEndpointDisclosure,
  LocalEnginePanel,
  VoiceModelField,
  VoiceProviderSelect
} from './voiceSettingsParts'
import {
  CUSTOM_ENDPOINT,
  effectiveFamily,
  type ProviderOption
} from '../../lib/voice/voiceSettingsHelpers'

const STT_MODE_LABELS: Record<SttMode, { label: string; description: string }> = {
  api: { label: 'API', description: 'Provedor remoto (OpenRouter, Groq, OpenAI…)' },
  local: {
    label: 'Local',
    description: 'Motor no dispositivo (whisper.cpp) — o áudio nunca sai do computador'
  },
  hybrid: {
    label: 'Híbrido',
    description: 'API na transcrição final; motor local nas parciais e como reserva'
  }
}

/** Modelo de transcrição sugerido ao trocar de provedor (o id que a família usa). */
const STT_DEFAULT_MODEL: Record<VoiceProviderSupport, string> = {
  openrouter: 'openai/whisper-large-v3-turbo',
  openai: 'whisper-large-v3-turbo',
  elevenlabs: ''
}

/** O id salvo tem a cara da família? (OpenRouter exige `fornecedor/modelo`.) */
const modelFitsFamily = (model: string, family: VoiceProviderSupport | null): boolean =>
  !model.trim() ? false : family === 'openrouter' ? model.includes('/') : true

export function SttSettingsSection({
  stt,
  language,
  providers,
  models,
  modelProgress,
  modelError,
  runtime,
  onCommit,
  onModelAction,
  onDismissModelError
}: {
  stt: SttSettings
  language: string
  providers: ProviderOption[]
  models: VoiceModelInfo[]
  modelProgress: Record<string, { bytes: number; total: number }>
  modelError: string | null
  runtime: VoiceRuntimeStatus | null
  /** Grava `sttSettings` (a máscara da chave no valor = preserva a chave salva). */
  onCommit: (next: SttSettings) => Promise<boolean>
  onModelAction: (model: VoiceModelInfo, action: LocalModelAction['action']) => void
  onDismissModelError: () => void
}): React.JSX.Element {
  const usesApi = stt.mode !== 'local'
  const usesLocal = stt.mode !== 'api'
  const provider = providers.find((p) => p.id === stt.api.providerId) ?? null
  const providerValue = provider ? provider.id : CUSTOM_ENDPOINT
  const isCustom = !provider
  const [advancedOpen, setAdvancedOpen] = useState<boolean | null>(null)
  const advanced = advancedOpen ?? isCustom
  const catalog = useVoiceCatalog(
    'stt',
    provider?.id ?? null,
    usesApi,
    isCustom ? stt.api.baseUrl : ''
  )
  const family = effectiveFamily(provider, stt.api.baseUrl)

  const saveApi = (patch: Partial<SttSettings['api']>): void => {
    void onCommit({ ...stt, api: { ...stt.api, ...patch } })
  }
  // estável para o efeito de correção de apelido do campo de modelo
  const commitModel = useCallback(
    (model: string) => void onCommit({ ...stt, api: { ...stt.api, model } }),
    [onCommit, stt]
  )

  const pickProvider = (v: string): void => {
    if (v === CUSTOM_ENDPOINT) {
      setAdvancedOpen(true)
      saveApi({ providerId: null })
      return
    }
    const p = providers.find((x) => x.id === v)
    const fam = p ? voiceProviderSupport(p) : null
    const model = modelFitsFamily(stt.api.model, fam)
      ? stt.api.model
      : fam
        ? STT_DEFAULT_MODEL[fam]
        : stt.api.model
    setAdvancedOpen(false)
    saveApi({ providerId: v, model })
  }

  const local = stt.local
  const localModel = local ? models.find((m) => m.id === local.model) : undefined
  // modelo grande demais para parciais por janelas (o runtime as desliga — mesma regra do main)
  const localPartialsOff =
    !!localModel &&
    localModel.engine === 'whisper.cpp' &&
    localModel.sizeBytes > STT_LOCAL_PARTIAL_MAX_MODEL_BYTES
  const runtimeProblem =
    runtime && local?.installed && !runtime.sttLocal.available
      ? (runtime.sttLocal.reason ?? 'runtime indisponível')
      : null

  return (
    <section className="border-t border-border pt-4" data-testid="stt-section">
      <div className="mb-3 flex items-baseline gap-2">
        <span className="text-[13px] font-medium text-fg/90">Transcrição (STT)</span>
        <HelpTip label="Transcrição de voz em texto">
          <p>
            O áudio gravado no ditado e na chamada de voz vira texto por um provedor de API (um dos
            cadastrados em Configurações → Provedores — OpenRouter, Groq, OpenAI…) ou pelo motor
            local (whisper.cpp). Híbrido usa a API na transcrição final e o motor local nas
            parciais/fim de turno e como reserva quando a API falha.
          </p>
          <p className="mt-2">
            A chave do provedor fica no processo principal e nunca chega à tela. Os modelos vêm da
            lista do próprio provedor (OpenRouter: modelos de transcrição do{' '}
            <C>/models?output_modalities=transcription</C>).
          </p>
        </HelpTip>
        {usesApi && (
          <SttApiInfo
            stt={stt}
            baseUrl={provider?.baseUrl ?? stt.api.baseUrl}
            language={language}
            family={family}
          />
        )}
      </div>
      <div className="space-y-4">
        <div>
          <Label>Modo</Label>
          <Select
            value={stt.mode}
            label="Modo de transcrição"
            className="h-8 w-full max-w-[360px]"
            menuMinWidth={360}
            onChange={(mode) => void onCommit({ ...stt, mode })}
            options={(['api', 'local', 'hybrid'] as SttMode[]).map((m) => ({
              value: m,
              label: STT_MODE_LABELS[m].label,
              description: STT_MODE_LABELS[m].description
            }))}
          />
        </div>

        {usesApi && (
          <div className="space-y-3" data-testid="stt-api">
            <div>
              <Label help="Provedores de Configurações → Provedores que servem transcrição (o endpoint e a chave vêm do provedor). Servidor fora da lista (ex.: whisper local OpenAI-compatível): Endpoint personalizado.">
                Provedor
              </Label>
              <VoiceProviderSelect
                capability="stt"
                providers={providers}
                value={providerValue}
                onChange={pickProvider}
                testId="stt-provider"
              />
              {stt.api.providerId && !provider && (
                <p className="mt-1 text-[11px] text-warning" role="alert">
                  O provedor escolhido não existe mais — usando o endpoint personalizado abaixo.
                </p>
              )}
            </div>
            <div>
              <Label help="Modelo de transcrição do provedor (lista do provedor). Um id sem o prefixo do OpenRouter (ex.: whisper-large-v3-turbo) é corrigido sozinho para o id listado (openai/whisper-large-v3-turbo).">
                Modelo
              </Label>
              <VoiceModelField
                capability="stt"
                state={catalog}
                value={stt.api.model}
                onCommit={commitModel}
                testId="stt-model"
                placeholder={
                  family === 'openrouter'
                    ? 'openai/whisper-large-v3-turbo'
                    : 'whisper-large-v3-turbo'
                }
              />
            </div>
            <CustomEndpointDisclosure
              open={advanced}
              onToggle={() => setAdvancedOpen(!advanced)}
              testId="stt-advanced"
            >
              {isCustom ? (
                <>
                  <div>
                    <Label help="Base OpenAI-compatível (o app chama {baseUrl}/audio/transcriptions). Ex.: servidor whisper local, Groq sem cadastrar provedor.">
                      Endpoint (baseUrl)
                    </Label>
                    <BaseUrlField
                      value={stt.api.baseUrl}
                      onCommit={(baseUrl) => saveApi({ baseUrl })}
                      testId="stt-base-url"
                      placeholder="https://api.groq.com/openai/v1"
                      label="Endpoint de transcrição (baseUrl)"
                    />
                  </div>
                  <div>
                    <Label help="Chave do endpoint personalizado (header Authorization: Bearer). A máscara da chave salva aparece no campo vazio; cole uma chave nova e clique em Salvar, ou em Remover (X). Endpoint local pode ficar sem chave.">
                      Chave de API
                    </Label>
                    <ApiKeyField
                      mask={stt.api.apiKey}
                      onSave={(key) =>
                        onCommit({ ...stt, api: { ...stt.api, apiKey: key as string } })
                      }
                    />
                  </div>
                </>
              ) : (
                <div className="flex flex-wrap items-center gap-2 text-[11px] text-subtle">
                  <span>
                    Usando o provedor “{provider.name}”. Para um servidor fora dos Provedores:
                  </span>
                  <button
                    type="button"
                    data-testid="stt-use-custom"
                    onClick={() => pickProvider(CUSTOM_ENDPOINT)}
                    className="rounded px-1 text-accent-strong underline-offset-2 hover:underline"
                  >
                    usar endpoint personalizado
                  </button>
                </div>
              )}
            </CustomEndpointDisclosure>
            <div className="flex items-center gap-2">
              <Label
                className="mb-0"
                help="Melhor-esforço enquanto você fala: o texto parcial aparece no composer (fora do texto editável) e a transcrição final entra no rascunho ao parar. No modo API cada parcial é uma request extra ao provedor; no Híbrido elas vêm do motor local quando pronto."
              >
                Parciais ao vivo
              </Label>
              <Switch
                checked={stt.livePartials}
                label="Parciais ao vivo"
                onChange={(livePartials) => void onCommit({ ...stt, livePartials })}
              />
            </div>
            {stt.livePartials && (
              <div className="flex items-center gap-2">
                <Label
                  className="mb-0"
                  help="Ditado: quando a última parcial já transcreveu a fala inteira desde a última pausa, ela vira o texto final na hora (sem esperar outra transcrição). Desligado: a final sempre transcreve de novo (um pouco mais precisa, mais lenta). A chamada de voz sempre aproveita."
                >
                  Final rápida (usar a parcial)
                </Label>
                <Switch
                  checked={stt.reusePartialFinal !== false}
                  label="Final rápida (usar a parcial)"
                  onChange={(reusePartialFinal) => void onCommit({ ...stt, reusePartialFinal })}
                />
              </div>
            )}
          </div>
        )}

        {!usesApi && (
          <div className="flex items-center gap-2">
            <Label
              className="mb-0"
              help="Melhor-esforço enquanto você fala: o motor local transcreve em janelas (só modelos até o base)."
            >
              Parciais ao vivo
            </Label>
            <Switch
              checked={stt.livePartials}
              label="Parciais ao vivo"
              onChange={(livePartials) => void onCommit({ ...stt, livePartials })}
            />
          </div>
        )}
        {!usesApi && stt.livePartials && localPartialsOff && localModel && (
          <p className="-mt-1 text-[11px] text-warning" role="note" data-testid="stt-partials-off">
            Parciais desligadas para este modelo ({localModel.name}): ele é grande demais para
            transcrever enquanto você fala — o texto aparece nas pausas e quando você parar. Para
            ver o texto ao vivo, use o ggml-base ou o ggml-tiny.
          </p>
        )}

        {usesLocal && (
          <LocalEnginePanel
            local={local}
            models={models}
            progress={modelProgress}
            error={modelError}
            title={stt.mode === 'hybrid' ? 'Motor local (parciais e reserva)' : 'Motor local'}
            help={
              stt.mode === 'hybrid'
                ? 'No Híbrido o motor local faz as parciais ao vivo e a transcrição especulativa do fim de turno da chamada, e transcreve quando a API falha por rede/cota/5xx. Um modelo pequeno (base) basta. Os arquivos ficam em userData/models.'
                : undefined
            }
            onEngine={(engine) =>
              void onCommit({
                ...stt,
                local: {
                  engine,
                  model: stt.local?.engine === engine ? stt.local.model : '',
                  // `installed` espelha o disco para o engine escolhido (a verdade é o disco)
                  installed: models.some(
                    (m) => m.kind === 'stt' && m.engine === engine && m.state === 'installed'
                  )
                }
              })
            }
            onAction={onModelAction}
            onDismissError={onDismissModelError}
            runtimeProblem={runtimeProblem}
          >
            <p
              className={`mt-1.5 text-[11px] ${local?.installed && localModel ? 'text-subtle' : 'text-warning'}`}
              data-testid="stt-local-current"
            >
              {local?.installed && localModel
                ? `Modelo local em uso: ${localModel.name}${stt.mode === 'hybrid' ? ' (parciais, especulação e reserva)' : ''}.`
                : stt.mode === 'hybrid'
                  ? 'Nenhum modelo local instalado — as parciais vão pela API (melhor-esforço) e não há reserva se a API falhar.'
                  : 'Nenhum modelo local instalado — baixe um abaixo para transcrever no computador.'}
            </p>
          </LocalEnginePanel>
        )}
      </div>
    </section>
  )
}

/** `</>` da transcrição: a request multipart exata do `/audio/transcriptions`. */
function SttApiInfo({
  stt,
  baseUrl,
  language,
  family
}: {
  stt: SttSettings
  baseUrl: string
  language: string
  family: VoiceProviderSupport | null
}): React.JSX.Element {
  const lang = language.split(/[-_]/)[0]?.toLowerCase() || language
  return (
    <ApiInfo
      title="Transcrição: request de cada gravação (e das parciais)"
      code={[
        `POST ${(baseUrl || '{endpoint}').replace(/\/+$/, '')}/audio/transcriptions`,
        'Authorization: Bearer {chave do provedor}',
        'Content-Type: multipart/form-data',
        '',
        'file            = audio.wav (PCM16 mono 16 kHz — o áudio gravado)',
        `model           = ${stt.api.model || '{modelo}'}`,
        `language        = ${lang}`,
        'response_format = json'
      ].join('\n')}
      codeLabel={
        family === 'openrouter'
          ? 'Modos API e Híbrido · OpenRouter (a chave do provedor entra no header)'
          : 'Modos API e Híbrido (a chave entra no header)'
      }
    >
      <p>
        Só o áudio gravado e esses campos saem do app. Com <C>Parciais ao vivo</C> no modo API, o
        mesmo request é repetido em janelas enquanto você fala (melhor-esforço); a transcrição final
        manda o áudio inteiro. No modo <C>Local</C> nada sai do computador.
      </p>
    </ApiInfo>
  )
}
