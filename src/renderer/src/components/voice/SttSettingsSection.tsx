// Configurações → Áudio → Transcrição (STT). PROVEDOR = um dos cadastrados em Configurações →
// Provedores que serve transcrição (OpenRouter, Groq, OpenAI, servidor local OpenAI-compatível…) ou
// as opções embutidas "Local — whisper.cpp" e "Local (GPU)" (Modo avançado, whisper large-v3-turbo;
// só escolhível com ele instalado). Com provedor: MODELO no mesmo seletor do chat (agrupado por
// provedor) e "Motor local nas parciais e como reserva" (= modo híbrido). Endereço e chave ficam
// só no provedor cadastrado — a chave nunca passa pela tela.
import { useCallback } from 'react'
import type { VoiceModelInfo, VoiceRuntimeStatus } from '@shared/ipc'
import type { ModelRef } from '@shared/models'
import type { SttSettings } from '@shared/voice'
import { DEFAULT_STT_GPU, STT_LOCAL_PARTIAL_MAX_MODEL_BYTES } from '@shared/voice'
import { voiceProviderSupport, type VoiceProviderSupport } from '@shared/voiceCatalog'
import { useVoiceCatalogs } from '../../lib/voice/useVoiceCatalogs'
import type { LocalModelAction } from '../../lib/voice/modelList'
import { ToggleRow } from '../panel/fields'
import { Label } from '../ui/controls'
import { ApiInfo, C } from '../ui/Tooltip'
import { AudioSection, WarnNote } from './audioUi'
import { LocalEnginePanel, VoiceModelField, VoiceSourceSelect } from './voiceSettingsParts'
import {
  effectiveFamily,
  GPU_SOURCE,
  LOCAL_SOURCE,
  providerMissing,
  type ProviderOption
} from '../../lib/voice/voiceSettingsHelpers'
import { useGpuStatus } from '../../lib/voice/gpu/useGpuStatus'
import { GpuSectionLink, GpuSttPanel } from './gpu/GpuBackendPanels'

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
  /** Grava `sttSettings`. */
  onCommit: (next: SttSettings) => Promise<boolean>
  onModelAction: (model: VoiceModelInfo, action: LocalModelAction['action']) => void
  onDismissModelError: () => void
}): React.JSX.Element {
  const mode = stt.mode
  const usesApi = mode === 'api' || mode === 'hybrid'
  const usesLocal = mode === 'local' || mode === 'hybrid'
  const provider = providers.find((p) => p.id === stt.api.providerId) ?? null
  const missing = usesApi && providerMissing(stt.api, providers)
  const catalogs = useVoiceCatalogs('stt', usesApi ? (provider?.id ?? null) : null)
  const family = effectiveFamily(provider)
  const { status: gpuStatus, available: gpuAvailable } = useGpuStatus()
  const whisperReady =
    gpuStatus?.engines.find((e) => e.id === 'whisper-large-v3-turbo')?.install.state === 'installed'

  const pickSource = (v: string): void => {
    if (v === LOCAL_SOURCE) return void onCommit({ ...stt, mode: 'local' })
    if (v === GPU_SOURCE)
      return void onCommit({ ...stt, mode: 'gpu', gpu: stt.gpu ?? { ...DEFAULT_STT_GPU } })
    const p = providers.find((x) => x.id === v)
    const fam = p ? voiceProviderSupport(p) : null
    const model = modelFitsFamily(stt.api.model, fam)
      ? stt.api.model
      : fam
        ? STT_DEFAULT_MODEL[fam]
        : stt.api.model
    void onCommit({
      ...stt,
      mode: mode === 'hybrid' ? 'hybrid' : 'api',
      api: { ...stt.api, providerId: v, model }
    })
  }
  // estável para o efeito de correção de apelido do campo de modelo
  const pickModel = useCallback(
    (ref: ModelRef) =>
      void onCommit({
        ...stt,
        api: { ...stt.api, providerId: ref.providerId, model: ref.model }
      }),
    [onCommit, stt]
  )

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
    <AudioSection
      title="Transcrição (STT)"
      testId="stt-section"
      help={
        <>
          <p>
            O áudio do ditado e da chamada de voz vira texto por um provedor cadastrado em
            Configurações → Provedores (OpenRouter, Groq, OpenAI ou um servidor local
            OpenAI-compatível — localhost pode ficar sem chave), pelo motor local (whisper.cpp) ou
            pela GPU (Modo avançado).
          </p>
          <p>
            A chave do provedor fica no processo principal e nunca chega à tela. Os modelos vêm da
            lista do próprio provedor (OpenRouter: <C>/models?output_modalities=transcription</C>).
          </p>
        </>
      }
      info={
        usesApi ? (
          <SttApiInfo
            stt={stt}
            baseUrl={provider?.baseUrl ?? ''}
            language={language}
            family={family}
          />
        ) : undefined
      }
    >
      <div>
        <Label help="Provedores de Configurações → Provedores que servem transcrição (o endpoint e a chave vêm de lá), o motor local whisper.cpp (no computador) ou a GPU (Modo avançado, abaixo).">
          Provedor
        </Label>
        <VoiceSourceSelect
          capability="stt"
          providers={providers}
          value={
            mode === 'local' ? LOCAL_SOURCE : mode === 'gpu' ? GPU_SOURCE : (provider?.id ?? null)
          }
          onChange={pickSource}
          local={{
            label: 'Local — whisper.cpp',
            description: 'No computador (CPU) — o áudio nunca sai daqui'
          }}
          gpu={
            gpuAvailable || mode === 'gpu'
              ? {
                  enabled: whisperReady,
                  description: whisperReady
                    ? 'Whisper large-v3-turbo na sua placa de vídeo (Modo avançado)'
                    : 'Instale o Whisper no Modo avançado (GPU local), abaixo'
                }
              : null
          }
          testId="stt-provider"
        />
        {gpuAvailable && !whisperReady && mode !== 'gpu' && (
          <p className="mt-1.5 text-[11.5px] text-subtle" data-testid="stt-gpu-hint">
            Local (GPU): instale o Whisper large-v3-turbo no{' '}
            <GpuSectionLink testId="stt-gpu-install-link" /> para transcrever na placa de vídeo.
          </p>
        )}
      </div>

      {missing && (
        <WarnNote testId="stt-provider-missing">
          O provedor escolhido não existe mais — escolha outro acima.
        </WarnNote>
      )}

      {mode === 'gpu' && <GpuSttPanel stt={stt} status={gpuStatus} />}

      {usesApi && provider && (
        <div className="space-y-3" data-testid="stt-api">
          <div>
            <Label help="Modelos de transcrição dos provedores cadastrados, agrupados por provedor (escolher um de outro grupo troca o provedor). Um id sem o prefixo do OpenRouter (ex.: whisper-large-v3-turbo) é corrigido sozinho para o id listado. Os lentos para a chamada têm o badge “lento”.">
              Modelo
            </Label>
            <VoiceModelField
              capability="stt"
              catalogs={catalogs}
              providers={providers}
              value={{ providerId: stt.api.providerId, model: stt.api.model }}
              onChange={pickModel}
              testId="stt-model"
            />
          </div>
          <ToggleRow
            label="Motor local nas parciais e como reserva"
            checked={mode === 'hybrid'}
            onChange={(v) => void onCommit({ ...stt, mode: v ? 'hybrid' : 'api' })}
            help="Híbrido: a API faz a transcrição final; o motor local (whisper.cpp) faz as parciais ao vivo e a transcrição especulativa do fim de turno da chamada, e transcreve quando a API falha por rede/cota/5xx. Um modelo pequeno (base) basta."
          />
        </div>
      )}

      <ToggleRow
        label="Parciais ao vivo"
        checked={stt.livePartials}
        onChange={(livePartials) => void onCommit({ ...stt, livePartials })}
        help={
          mode === 'gpu'
            ? 'Melhor-esforço enquanto você fala: o whisper da GPU transcreve em janelas (rápido o bastante para o large-v3-turbo).'
            : mode === 'local'
              ? 'Melhor-esforço enquanto você fala: o motor local transcreve em janelas (só modelos até o base).'
              : 'Melhor-esforço enquanto você fala: o texto parcial aparece no composer (fora do texto editável) e a transcrição final entra no rascunho ao parar. Só pela API, cada parcial é uma request extra ao provedor; com o motor local como reserva, elas vêm dele quando pronto.'
        }
        status={
          mode === 'local' && stt.livePartials && localPartialsOff && localModel ? (
            <span className="text-warning" data-testid="stt-partials-off">
              Desligadas para {localModel.name}: grande demais para transcrever enquanto você fala —
              o texto aparece nas pausas. Use o ggml-base ou o ggml-tiny para ver ao vivo.
            </span>
          ) : undefined
        }
      />
      {usesApi && stt.livePartials && (
        <ToggleRow
          label="Final rápida (usar a parcial)"
          checked={stt.reusePartialFinal !== false}
          onChange={(reusePartialFinal) => void onCommit({ ...stt, reusePartialFinal })}
          help="Ditado: quando a última parcial já transcreveu a fala inteira desde a última pausa, ela vira o texto final na hora (sem esperar outra transcrição). Desligado: a final sempre transcreve de novo (um pouco mais precisa, mais lenta). A chamada de voz sempre aproveita."
        />
      )}

      {usesLocal && (
        <LocalEnginePanel
          local={local}
          models={models}
          progress={modelProgress}
          error={modelError}
          title={mode === 'hybrid' ? 'Motor local (parciais e reserva)' : 'Motor local'}
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
            className={`mt-1.5 text-[11.5px] ${local?.installed && localModel ? 'text-subtle' : 'text-warning'}`}
            data-testid="stt-local-current"
          >
            {local?.installed && localModel
              ? `Modelo local em uso: ${localModel.name}${mode === 'hybrid' ? ' (parciais, especulação e reserva)' : ''}.`
              : mode === 'hybrid'
                ? 'Nenhum modelo local instalado — as parciais vão pela API (melhor-esforço) e não há reserva se a API falhar.'
                : 'Nenhum modelo local instalado — baixe um abaixo para transcrever no computador.'}
          </p>
        </LocalEnginePanel>
      )}
    </AudioSection>
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
          ? 'Com provedor de API · OpenRouter (a chave do provedor entra no header)'
          : 'Com provedor de API (a chave entra no header; servidor local pode ficar sem)'
      }
    >
      <p>
        Só o áudio gravado e esses campos saem do app. Com <C>Parciais ao vivo</C> só pela API, o
        mesmo request é repetido em janelas enquanto você fala (melhor-esforço); a transcrição final
        manda o áudio inteiro. Com o motor local ou a GPU nada sai do computador.
      </p>
    </ApiInfo>
  )
}
