// Configurações → Áudio → Fala (TTS). PROVEDOR = um dos cadastrados em Configurações → Provedores
// que serve fala (OpenRouter, ElevenLabs direto, OpenAI-compatível — inclusive um servidor local)
// ou as opções embutidas "Local — Kokoro" e "Local (GPU)" (Modo avançado; só escolhível com um
// motor de voz da GPU instalado — senão desabilitada com o link). Com provedor: MODELO no mesmo
// seletor do chat (agrupado por provedor, latência medida à direita, lista curada para a chamada)
// e VOZ no mesmo desenho (busca, grupos por idioma, ▶ prévia por linha). Kokoro: voz + pesos para
// baixar. GPU: motor + voz agrupada (`GpuTtsPanel`). "Testar voz", "Gerar clipes de voz" e a
// contagem dos clipes. Endereço e chave ficam só no provedor cadastrado — a chave nunca passa pela
// tela.
import { Play, Settings2, Square } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { TtsVoicesView, VoiceModelInfo, VoiceRuntimeStatus } from '@shared/ipc'
import type { ModelRef } from '@shared/models'
import { ttsCallTransport, type TtsSettings } from '@shared/voice'
import {
  CALL_TTS_RECOMMENDED,
  describeVoice,
  orderVoicesForPt,
  voiceProviderSupport,
  VOICE_PREVIEW_PHRASE,
  type VoiceCatalogVoice,
  type VoiceProviderSupport
} from '@shared/voiceCatalog'
import { api, errorMessage } from '../../lib/api'
import type { LocalModelAction } from '../../lib/voice/modelList'
import { useVoiceCatalogs } from '../../lib/voice/useVoiceCatalogs'
import { useStore } from '../../store'
import { Button, Label } from '../ui/controls'
import { Select } from '../ui/Select'
import { ToggleRow } from '../panel/fields'
import { ApiInfo, C, HelpTip } from '../ui/Tooltip'
import { AudioSection, WarnNote } from './audioUi'
import { groupCatalogVoices } from './catalogVoiceGroups'
import {
  DismissibleError,
  LocalModelList,
  VoiceModelField,
  VoicePicker,
  VoiceSourceSelect
} from './voiceSettingsParts'
import {
  effectiveFamily,
  GPU_SOURCE,
  LOCAL_SOURCE,
  playAudioBytes,
  providerMissing,
  type ProviderOption
} from '../../lib/voice/voiceSettingsHelpers'
import { gpuConfigFor, installedTtsEngines } from '../../lib/voice/gpu/gpuUi'
import type { GpuStatus } from '../../lib/voice/gpu/types'
import { useGpuStatus } from '../../lib/voice/gpu/useGpuStatus'
import { GpuSectionLink, GpuTtsPanel } from './gpu/GpuBackendPanels'

/** "Local (GPU)": completa `gpu` (1º motor instalado + voz sugerida) quando falta ou sumiu. */
function toGpu(t: TtsSettings, status: GpuStatus | null): TtsSettings {
  const installed = installedTtsEngines(status)
  const cur = installed.find((e) => e.id === t.gpu?.engine)
  const gpu = cur ? t.gpu : installed[0] ? gpuConfigFor(installed[0], t.gpu) : t.gpu
  return { ...t, backend: 'gpu', ...(gpu ? { gpu } : {}) }
}

/** Mensagem do IPC sem o prefixo da classe (`TtsError: …`) — o texto do main já é legível. */
const ipcError = (e: unknown): string => errorMessage(e).replace(/^[A-Z]\w*Error: /, '')

/** Modelo/voz sugeridos ao trocar de provedor (só quando o salvo não serve à família nova). */
const TTS_DEFAULTS: Record<VoiceProviderSupport, { model: string; voice: string | null }> = {
  openrouter: { model: 'elevenlabs/eleven-flash-v2.5', voice: 'sarah' },
  elevenlabs: { model: 'eleven_flash_v2_5', voice: null },
  openai: { model: 'gpt-4o-mini-tts', voice: 'alloy' }
}

const modelFitsFamily = (model: string, family: VoiceProviderSupport | null): boolean => {
  const m = model.trim()
  if (!m) return false
  if (family === 'openrouter') return m.includes('/')
  if (family === 'elevenlabs') return !m.includes('/') && /^eleven/i.test(m)
  return true
}

/** Atalho "Usar OpenRouter (ElevenLabs Flash)" (com um OpenRouter cadastrado em Provedores). */
const OPENROUTER_PRESET = { model: 'elevenlabs/eleven-flash-v2.5', voice: 'sarah' } as const

type Clips = {
  busy: boolean
  done: number
  total: number
  error: string | null
  count: number | null
  stale: boolean
}

export function TtsSettingsSection({
  tts,
  providers,
  models,
  modelProgress,
  runtime,
  onCommit,
  onModelAction
}: {
  tts: TtsSettings
  providers: ProviderOption[]
  models: VoiceModelInfo[]
  modelProgress: Record<string, { bytes: number; total: number }>
  runtime: VoiceRuntimeStatus | null
  /** Grava `ttsSettings`. */
  onCommit: (next: TtsSettings) => Promise<boolean>
  onModelAction: (model: VoiceModelInfo, action: LocalModelAction['action']) => void
}): React.JSX.Element | null {
  const voiceApi = api.voice
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const backend = tts.backend
  const isApi = backend === 'api'
  const isGpu = backend === 'gpu'
  const { status: gpuStatus, available: gpuAvailable } = useGpuStatus()
  const gpuEngines = installedTtsEngines(gpuStatus)
  const provider = providers.find((p) => p.id === tts.api.providerId) ?? null
  const missing = isApi && providerMissing(tts.api, providers)
  const family = effectiveFamily(provider)
  const catalogs = useVoiceCatalogs('tts', isApi ? (provider?.id ?? null) : null)
  const catalog = catalogs.stateFor(isApi ? (provider?.id ?? null) : null).catalog
  /** Vozes do motor local atual (`voice:tts:voices`). */
  const [localVoices, setLocalVoices] = useState<TtsVoicesView['local']>([])
  const [test, setTest] = useState<{ state: 'idle' | 'busy' | 'playing'; error: string | null }>({
    state: 'idle',
    error: null
  })
  const [preview, setPreview] = useState<{ id: string; state: 'busy' | 'playing' } | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [clips, setClips] = useState<Clips>({
    busy: false,
    done: 0,
    total: 0,
    error: null,
    count: null,
    stale: false
  })
  /** `<audio>` em reprodução (teste ou prévia) — um por vez; fechar o modal interrompe. */
  const playing = useRef<{ el: HTMLAudioElement; url: string } | null>(null)

  const refreshClips = useCallback((): void => {
    void api.voice?.tts.clips
      .list()
      .then((m) =>
        setClips((c) => ({
          ...c,
          count: m && !m.stale ? m.clips.length : 0,
          stale: !!m?.stale
        }))
      )
      .catch(() => void 0)
  }, [setClips])

  const refreshLocalVoices = useCallback((): void => {
    void api.voice?.tts
      .voices()
      .then((v) => setLocalVoices(v.local))
      .catch(() => void 0)
  }, [])

  useEffect(() => {
    refreshClips()
    refreshLocalVoices()
  }, [refreshClips, refreshLocalVoices])

  // progresso da geração de clipes (`voice:tts:clips:progress`)
  useEffect(
    () =>
      api.onVoiceTtsClipsProgress?.((e) => {
        setClips((c) => ({ ...c, busy: true, done: e.done, total: e.total }))
      }),
    []
  )

  const stopPlaying = (): void => {
    const t = playing.current
    playing.current = null
    if (t) {
      t.el.pause()
      URL.revokeObjectURL(t.url)
    }
  }
  // fechar o modal (desmontar) interrompe teste/prévia
  useEffect(() => () => stopPlaying(), [])

  const commit = useCallback(
    async (next: TtsSettings): Promise<boolean> => {
      const ok = await onCommit(next)
      // voz/backend/motor mudaram → a contagem de clipes é a do cache da voz nova
      refreshClips()
      return ok
    },
    [onCommit, refreshClips]
  )

  /**
   * Troca de modelo (ou de provedor+modelo, pelo seletor agrupado): a voz salva que o modelo novo
   * não aceita (OpenRouter: `supported_voices`) vira a 1ª recomendada para pt-BR (ou a 1ª da lista);
   * modelo sem vozes (ex.: Fish Audio) = voz padrão.
   */
  const pickModel = useCallback(
    (ref: ModelRef) => {
      const m = catalogs.entries[ref.providerId]?.catalog?.models.find((x) => x.id === ref.model)
      let voice = tts.api.voice
      if (m?.voiceIds) {
        if (!m.voiceIds.length) voice = null
        else if (!voice || !m.voiceIds.includes(voice))
          voice = m.ptVoices?.find((v) => m.voiceIds!.includes(v)) ?? m.voiceIds[0]
      }
      void commit({
        ...tts,
        api: { ...tts.api, providerId: ref.providerId, model: ref.model, voice }
      })
    },
    [catalogs.entries, commit, tts]
  )

  // vozes do modelo escolhido (OpenRouter: `supported_voices` do modelo; ElevenLabs: da conta),
  // pt primeiro: as recomendadas do modelo para pt-BR, depois pt-BR/pt/multilíngue/resto
  const model =
    catalog?.models.find((m) => m.id === tts.api.model) ??
    catalog?.hiddenModels?.find((m) => m.id === tts.api.model) ??
    null
  const voices: VoiceCatalogVoice[] = useMemo(() => {
    const allVoices = catalog?.voices ?? []
    return orderVoicesForPt(
      model?.voiceIds?.length
        ? model.voiceIds.map(
            (id) => allVoices.find((v) => v.id === id) ?? describeVoice(id, model.id)
          )
        : model?.voiceIds && family === 'openrouter'
          ? [] // modelo sem vozes listadas (ex.: Fish Audio): só a voz padrão
          : allVoices,
      model?.ptVoices ?? []
    )
  }, [catalog, model, family])
  const noVoiceList = !!model?.voiceIds && model.voiceIds.length === 0

  if (!voiceApi) return null

  const saveApi = (patch: Partial<TtsSettings['api']>): void => {
    void commit({ ...tts, api: { ...tts.api, ...patch } })
  }
  /** "Usar ElevenLabs Flash v2.5" do aviso de modelo lento (lista curada). */
  const curatedFamily = family === 'openrouter' || family === 'elevenlabs' ? family : null
  const recommended = curatedFamily
    ? {
        label: CALL_TTS_RECOMMENDED[curatedFamily].label,
        onUse: (): void =>
          saveApi({
            model: CALL_TTS_RECOMMENDED[curatedFamily].model,
            voice: CALL_TTS_RECOMMENDED[curatedFamily].voice ?? tts.api.voice
          })
      }
    : undefined

  const pickSource = (v: string): void => {
    if (v === LOCAL_SOURCE)
      return void commit({ ...tts, backend: 'local' }).then(refreshLocalVoices)
    if (v === GPU_SOURCE) return void commit(toGpu(tts, gpuStatus))
    const p = providers.find((x) => x.id === v)
    const fam = p ? voiceProviderSupport(p) : null
    const keep = modelFitsFamily(tts.api.model, fam)
    void commit({
      ...tts,
      backend: 'api',
      api: {
        ...tts.api,
        providerId: v,
        ...(keep || !fam ? {} : { model: TTS_DEFAULTS[fam].model, voice: TTS_DEFAULTS[fam].voice })
      }
    })
  }

  const openRouter = providers.find((p) => voiceProviderSupport(p) === 'openrouter') ?? null
  const presetActive = isApi && family === 'openrouter' && tts.api.model === OPENROUTER_PRESET.model
  const applyPreset = (): void => {
    if (!openRouter) return setSettingsOpen(true, 'providers')
    void commit({
      ...tts,
      backend: 'api',
      api: {
        ...tts.api,
        providerId: openRouter.id,
        model: OPENROUTER_PRESET.model,
        voice: OPENROUTER_PRESET.voice
      }
    })
  }

  const play = (
    audio: Uint8Array,
    mime: string,
    onEnd: () => void,
    onError: (msg: string) => void
  ): void => {
    stopPlaying()
    playing.current = playAudioBytes(
      audio,
      mime,
      () => {
        playing.current = null
        onEnd()
      },
      (msg) => {
        playing.current = null
        onError(msg)
      }
    )
  }

  /** "Testar voz": sintetiza a frase de demonstração com a config salva e reproduz. */
  const runTest = (): void => {
    if (test.state === 'playing') {
      stopPlaying()
      setTest((s) => ({ ...s, state: 'idle' }))
      return
    }
    setPreview(null)
    setTest({ state: 'busy', error: null })
    void voiceApi.tts
      .test()
      .then((r) => {
        setTest({ state: 'playing', error: null })
        play(
          r.audio,
          r.mime,
          () => setTest((s) => ({ ...s, state: 'idle' })),
          (error) => setTest({ state: 'idle', error: `Falha ao testar a voz: ${error}` })
        )
      })
      .catch((e) => setTest({ state: 'idle', error: `Falha ao testar a voz: ${ipcError(e)}` }))
  }

  /** ▶ prévia de uma voz: `preview_url` do provedor (baixado pelo main) ou a frase sintetizada. */
  const runPreview = (id: string, label: string): void => {
    if (preview?.id === id && preview.state === 'playing') {
      stopPlaying()
      setPreview(null)
      return
    }
    const v = voices.find((x) => x.id === id)
    setTest((s) => ({ ...s, state: 'idle' }))
    setPreviewError(null)
    setPreview({ id, state: 'busy' })
    const get =
      v?.previewUrl && voiceApi.catalog
        ? voiceApi.catalog.preview({ url: v.previewUrl })
        : voiceApi.tts.test({
            voice: id,
            ...(isApi && tts.api.model ? { model: tts.api.model } : {}),
            text: VOICE_PREVIEW_PHRASE
          })
    void get
      .then((r) => {
        setPreview({ id, state: 'playing' })
        play(
          r.audio,
          r.mime,
          () => setPreview(null),
          (msg) => {
            setPreview(null)
            setPreviewError(`Prévia de “${label}”: ${msg}`)
          }
        )
      })
      .catch((e) => {
        setPreview(null)
        setPreviewError(`Prévia de “${label}”: ${ipcError(e)}`)
      })
  }

  /** "Gerar clipes de voz": pré-gera as falas curtas (interjeições/fillers) da voz atual. */
  const runClips = (): void => {
    setClips((c) => ({ ...c, busy: true, done: 0, total: 0, error: null }))
    void voiceApi.tts.clips
      .generate()
      .then((m) =>
        setClips({
          busy: false,
          done: m.clips.length,
          total: m.clips.length,
          error: null,
          count: m.clips.length,
          stale: false
        })
      )
      .catch((e) => setClips((c) => ({ ...c, busy: false, error: ipcError(e) })))
  }

  const engine = tts.local?.engine ?? 'kokoro'
  const gpuEngine = gpuStatus?.engines.find((e) => e.id === tts.gpu?.engine) ?? null
  const currentVoiceLabel = isGpu
    ? (gpuEngine?.voices.find((v) => v.id === tts.gpu?.voice)?.label ??
      tts.gpu?.voice ??
      'voz padrão do motor')
    : isApi
      ? tts.api.voice
        ? (voices.find((v) => v.id === tts.api.voice)?.label ?? tts.api.voice)
        : 'voz padrão'
      : (localVoices.find((v) => v.id === tts.local?.voice)?.label ?? tts.local?.voice ?? 'pf_dora')

  return (
    <AudioSection
      title="Fala (TTS)"
      testId="tts-section"
      help={
        <>
          <p>
            Síntese de fala da chamada de voz: um provedor cadastrado em Configurações → Provedores
            (OpenRouter, ElevenLabs, OpenAI-compatível — inclusive um servidor local, como o
            Kokoro-FastAPI), o motor local Kokoro (pesos ONNX baixados aqui; a fonemização pt-BR usa
            o <C>espeak-ng</C> do sistema) ou a GPU (Modo avançado). Modelos e vozes vêm da lista do
            provedor.
          </p>
          <p>A chave do provedor fica no processo principal e nunca chega à tela.</p>
        </>
      }
      info={
        isGpu ? (
          <ApiInfo title="Fala local (GPU)">
            <p>
              Nada sai do computador: cada frase da resposta vai ao servidor local da GPU (
              <C>POST http://127.0.0.1:&lt;porta&gt;/v1/audio/speech</C> com o motor, a voz e o
              texto, chave aleatória por sessão) e o áudio volta em streaming.
            </p>
          </ApiInfo>
        ) : (
          <TtsApiInfo tts={tts} baseUrl={provider?.baseUrl ?? ''} family={family} />
        )
      }
    >
      <div>
        <Label help="Provedores de Configurações → Provedores que servem fala (o endpoint e a chave vêm de lá), o motor local Kokoro (no computador) ou a GPU (Modo avançado, abaixo).">
          Provedor
        </Label>
        <VoiceSourceSelect
          capability="tts"
          providers={providers}
          value={backend === 'local' ? LOCAL_SOURCE : isGpu ? GPU_SOURCE : (provider?.id ?? null)}
          onChange={pickSource}
          local={{
            label: 'Local — Kokoro',
            description: 'No computador (CPU) — o texto nunca sai daqui'
          }}
          gpu={
            gpuAvailable || isGpu
              ? {
                  enabled: gpuEngines.length > 0,
                  description: gpuEngines.length
                    ? `Motores na sua placa de vídeo: ${gpuEngines.map((e) => e.label).join(', ')}`
                    : 'Instale um motor de voz no Modo avançado (GPU local), abaixo'
                }
              : null
          }
          testId="tts-provider"
        />
        {gpuAvailable && !gpuEngines.length && !isGpu && (
          <p className="mt-1.5 text-[11.5px] text-subtle" data-testid="tts-gpu-hint">
            Local (GPU): instale um motor de voz no <GpuSectionLink testId="tts-gpu-install-link" />{' '}
            para usar a sua placa de vídeo.
          </p>
        )}
      </div>

      {missing && (
        <WarnNote testId="tts-provider-missing">
          O provedor escolhido não existe mais — escolha outro acima.
        </WarnNote>
      )}

      {!presetActive && (
        <div className="flex flex-wrap items-center gap-2" data-testid="tts-preset">
          <Button
            size="sm"
            variant="secondary"
            data-testid="tts-preset-openrouter"
            icon={openRouter ? undefined : <Settings2 className="size-3.5" />}
            onClick={applyPreset}
          >
            {openRouter ? 'Usar OpenRouter (ElevenLabs Flash)' : 'Cadastrar o OpenRouter'}
          </Button>
          <span className="text-[11.5px] text-subtle">
            {openRouter
              ? `fala rápida pela API, com o provedor “${openRouter.name}”`
              : 'em Provedores, para a fala rápida pela API (ElevenLabs Flash)'}
          </span>
          <HelpTip label="Fala rápida pela API">
            Combinação recomendada para a chamada de voz: fala pelo OpenRouter com o ElevenLabs
            Flash v2.5 (~0,5 s até o 1º áudio; o áudio chega em streaming) e transcrição com o motor
            local como reserva. O texto falado vai ao OpenRouter (cobrança por caractere). O Kokoro
            local continua disponível offline.
          </HelpTip>
        </div>
      )}

      {isApi && provider && (
        <div className="space-y-3" data-testid="tts-api">
          <div>
            <Label help="Modelos de fala dos provedores cadastrados, agrupados por provedor (escolher um de outro grupo troca o provedor). Só os testados para a chamada de voz: 1º áudio em até ~0,9 s numa frase curta e pt-BR aceitável (o badge mostra o tempo medido). Um id livre é aceito, com o aviso de que não foi testado.">
              Modelo
            </Label>
            <VoiceModelField
              capability="tts"
              catalogs={catalogs}
              providers={providers}
              value={{ providerId: tts.api.providerId, model: tts.api.model }}
              onChange={pickModel}
              testId="tts-model"
              family={family}
              recommended={recommended}
            />
          </div>
          <div>
            <Label help="Voz pedida ao provedor, agrupada por idioma (pt-BR primeiro; as recomendadas para o modelo no topo). A lista vem do modelo escolhido (OpenRouter: supported_voices; ElevenLabs: as vozes da sua conta). ▶ toca uma prévia (a do provedor quando existe; senão sintetiza uma frase curta — custa como uma frase falada). Digitar um id na busca permite usar qualquer voz.">
              Voz
            </Label>
            <VoicePicker
              groups={groupCatalogVoices(voices)}
              value={tts.api.voice}
              onChange={(voice) => saveApi({ voice })}
              onPreview={runPreview}
              previewing={preview}
              defaultLabel={
                family === 'openai' || noVoiceList ? 'Voz padrão da API (sem voice)' : undefined
              }
            />
          </div>
          <CallTransport tts={tts} family={family} onCommit={commit} />
        </div>
      )}

      {isGpu && <GpuTtsPanel tts={tts} status={gpuStatus} onCommit={commit} />}

      {backend === 'local' && (
        <div className="space-y-3" data-testid="tts-local">
          <div>
            <Label
              help="Voz do Kokoro-82M (ONNX). As vozes pt-BR vêm dos voice packs baixados abaixo (sem o pack instalado, a síntese avisa)."
              hint={
                <span className={tts.local?.installed ? 'text-success' : 'text-warning'}>
                  Kokoro {tts.local?.installed ? 'instalado' : 'não instalado — baixe abaixo'}
                </span>
              }
            >
              Voz
            </Label>
            <Select
              value={tts.local?.voice ?? 'pf_dora'}
              label="Voz do motor local"
              disabled={engine !== 'kokoro'}
              onChange={(voice) =>
                void commit({
                  ...tts,
                  local: {
                    engine: tts.local?.engine ?? 'kokoro',
                    voice,
                    installed: tts.local?.installed ?? false
                  }
                })
              }
              options={
                localVoices.length
                  ? localVoices.map((v) => ({
                      value: v.id,
                      label: v.installed ? `${v.label} — instalada` : `${v.label} — baixar abaixo`
                    }))
                  : [{ value: 'pf_dora', label: 'pf_dora (padrão)' }]
              }
            />
          </div>
          {engine !== 'kokoro' && (
            <WarnNote>
              O Chatterbox ainda não funciona —{' '}
              <button
                type="button"
                className="underline underline-offset-2"
                onClick={() =>
                  void commit({
                    ...tts,
                    local: {
                      engine: 'kokoro',
                      voice: tts.local?.voice ?? '',
                      installed: tts.local?.installed ?? false
                    }
                  }).then(refreshLocalVoices)
                }
              >
                usar o Kokoro
              </button>
              .
            </WarnNote>
          )}
          {runtime && engine === 'kokoro' && !runtime.ttsLocal.available && (
            <WarnNote testId="tts-runtime-warning">
              Motor local não está pronto: {runtime.ttsLocal.reason ?? 'runtime indisponível'}
            </WarnNote>
          )}
        </div>
      )}

      {/* ---- testar voz + clipes ---- */}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="secondary"
          data-testid="tts-test"
          data-state={test.state}
          disabled={test.state === 'busy'}
          icon={
            test.state === 'playing' ? (
              <Square className="size-3" fill="currentColor" />
            ) : (
              <Play className="size-3.5" />
            )
          }
          onClick={runTest}
        >
          {test.state === 'busy'
            ? 'Sintetizando…'
            : test.state === 'playing'
              ? 'Parar teste'
              : 'Testar voz'}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          data-testid="tts-clips-generate"
          disabled={clips.busy}
          onClick={runClips}
        >
          {clips.stale || clips.count ? 'Gerar clipes de novo' : 'Gerar clipes de voz'}
        </Button>
        <HelpTip label="Clipes de voz">
          Os clipes (interjeições e falas de espera da chamada de voz) são gerados com a voz e o
          provedor atuais (provedor de API, Kokoro ou o motor da GPU) e ficam em cache em{' '}
          <C>userData/voice-clips</C>, um cache por voz. Ao trocar a voz ou as frases, gere de novo
          — sem clipes, interjeições e falas de espera não tocam.
        </HelpTip>
        {clips.busy && (
          <span className="text-[11.5px] text-subtle tabular-nums" data-testid="tts-clips-progress">
            gerando clipes… {clips.done}/{clips.total || '…'}
          </span>
        )}
        {!clips.busy && clips.count !== null && clips.count > 0 && (
          <span className="text-[11.5px] text-subtle" data-testid="tts-clips-count">
            {clips.count} clipes gerados para “{currentVoiceLabel}”
          </span>
        )}
        {!clips.busy && clips.count === 0 && (
          <span className="text-[11.5px] text-warning" data-testid="tts-clips-missing">
            {clips.stale
              ? `clipes de “${currentVoiceLabel}” desatualizados (frases ou modelo mudaram) — gere de novo`
              : `sem clipes para “${currentVoiceLabel}”`}
          </span>
        )}
      </div>
      {test.state === 'playing' && (
        <p className="text-[11.5px] text-subtle" role="status" data-testid="tts-test-playing">
          Tocando “Olá, isto é um teste.” com{' '}
          {isApi
            ? tts.api.model || 'o modelo'
            : isGpu
              ? (gpuEngine?.label ?? 'o motor da GPU')
              : 'o Kokoro'}{' '}
          · {currentVoiceLabel}
        </p>
      )}
      <DismissibleError
        error={test.error}
        onDismiss={() => setTest((s) => ({ ...s, error: null }))}
        testId="tts-error"
        dismissLabel="Dispensar erro de síntese de fala"
      />
      <DismissibleError
        error={previewError}
        onDismiss={() => setPreviewError(null)}
        testId="tts-preview-error"
        dismissLabel="Dispensar erro da prévia de voz"
      />
      <DismissibleError
        error={clips.error}
        onDismiss={() => setClips((c) => ({ ...c, error: null }))}
        testId="tts-clips-error"
        dismissLabel="Dispensar erro de clipes"
      />
      {backend === 'local' && (
        <LocalModelList
          kind="tts"
          models={models}
          progress={modelProgress}
          onAction={onModelAction}
        />
      )}
    </AudioSection>
  )
}

/**
 * Como a fala da CHAMADA chega do provedor: "WebSocket (texto em streaming)" na ElevenLabs direta
 * com modelo que aceita (interruptor "Streaming por WebSocket", padrão ligado) ou "HTTP por frase"
 * com o motivo. Mesma decisão do main (`elevenLabsCallOptions` ↔ `ttsCallTransport`). "Testar
 * voz" e os clipes usam sempre o REST.
 */
function CallTransport({
  tts,
  family,
  onCommit
}: {
  tts: TtsSettings
  family: VoiceProviderSupport | null
  onCommit: (next: TtsSettings) => Promise<boolean>
}): React.JSX.Element {
  const t = ttsCallTransport(tts.api, family)
  const help =
    'WebSocket: o texto da resposta vai para a ElevenLabs enquanto o modelo ainda escreve e o áudio começa a voltar antes de a frase terminar — o 1º som sai mais cedo e a fala flui entre frases. HTTP por frase: o app espera cada frase ficar pronta e faz uma request por frase (um pouco mais de latência, mais simples; é o que os outros provedores usam). "Testar voz" e os clipes usam sempre HTTP.'
  const line = (
    <span data-testid="tts-call-transport-text">
      Na chamada:{' '}
      {t.ws ? (
        <span className="text-success">WebSocket (texto em streaming)</span>
      ) : (
        <>
          <span className="text-fg/85">HTTP por frase</span>
          {t.reason ? ` — ${t.reason}` : ''}
        </>
      )}
    </span>
  )
  const setWs = (on: boolean): void => {
    // ligado = sem o campo (padrão); desligado = `false` explícito
    const { elevenLabsWs: _drop, ...api } = tts.api
    void _drop
    void onCommit({ ...tts, api: on ? api : { ...api, elevenLabsWs: false } })
  }
  return (
    <div data-testid="tts-call-transport" data-ws={t.ws}>
      {t.toggle ? (
        <ToggleRow
          label="Streaming por WebSocket"
          checked={tts.api.elevenLabsWs !== false}
          onChange={setWs}
          help={help}
          status={line}
        />
      ) : (
        <p className="flex items-center gap-1.5 text-[11.5px] text-subtle">
          {line}
          <HelpTip label="Na chamada: WebSocket ou HTTP">{help}</HelpTip>
        </p>
      )}
    </div>
  )
}

/** `</>` da fala: o request exato de cada frase (API) ou o aviso de que nada sai (local). */
function TtsApiInfo({
  tts,
  baseUrl,
  family
}: {
  tts: TtsSettings
  baseUrl: string
  family: VoiceProviderSupport | null
}): React.JSX.Element {
  if (tts.backend === 'local')
    return (
      <ApiInfo title="Fala local (Kokoro)">
        <p>
          Nada sai do computador: o texto de cada frase da resposta é fonemizado pelo{' '}
          <C>espeak-ng</C> do sistema e sintetizado pelo Kokoro (ONNX) localmente.
        </p>
      </ApiInfo>
    )
  const base = (baseUrl || '{endpoint}').replace(/\/+$/, '')
  if (family === 'elevenlabs')
    return (
      <ApiInfo
        title="Fala: ElevenLabs direto"
        code={[
          `GET ${base.replace(/\/v\d+$/i, '')}/v1/models   ·   GET …/v1/voices   (listas, header xi-api-key)`,
          '',
          `Síntese: backend ElevenLabs (stream-input) com model_id = ${tts.api.model || '{modelo}'}`,
          `voice_id = ${tts.api.voice ?? '{voz}'}`,
          'text     = {frase da resposta}'
        ].join('\n')}
        codeLabel="A chave do provedor vai no header xi-api-key"
      >
        <p>Sai só o texto de cada frase falada.</p>
      </ApiInfo>
    )
  // OpenRouter não aceita wav: o app pede pcm (e embrulha em WAV) — ver SPEC → "Serviço de TTS"
  const body: Record<string, string> = {
    model: tts.api.model || '{modelo}',
    ...(tts.api.voice ? { voice: tts.api.voice } : {}),
    input: '{frase da resposta}',
    response_format: family === 'openrouter' ? 'pcm' : 'wav'
  }
  return (
    <ApiInfo
      title="Fala: request de cada frase falada"
      code={[
        `POST ${base}/audio/speech`,
        'Authorization: Bearer {chave do provedor}',
        'Content-Type: application/json',
        '',
        JSON.stringify(body, null, 2)
      ].join('\n')}
      codeLabel="Uma request por frase da resposta (e por clipe ao gerar os clipes de voz)"
    >
      <p>
        Sai só o texto de cada frase falada (a resposta do agente é dividida em frases). Sem voz
        definida, o campo <C>voice</C> é omitido e vale a voz padrão da API.
        {family === 'openrouter'
          ? ' No OpenRouter o áudio vem em PCM (streaming) e o app o embrulha em WAV.'
          : ''}
      </p>
    </ApiInfo>
  )
}
