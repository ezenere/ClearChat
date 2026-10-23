// Configurações → Áudio → Fala (TTS): backend (Local/API). API: PROVEDOR (cadastrados em
// Provedores que servem fala — OpenRouter, ElevenLabs direto, OpenAI-compatível — ou "Endpoint
// personalizado" no avançado), MODELO e VOZ listados pelo provedor (descoberta no main), com ▶
// prévia por voz. Local: motor Kokoro, voz e os pesos para baixar (o catálogo local só aparece
// aqui). "Testar voz" (frase de demonstração com a config salva), "Gerar clipes de voz" e a
// contagem dos clipes da voz atual (com estado "desatualizados"). A chave nunca passa pela tela.
import { Play, Square, TriangleAlert } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { TtsVoicesView, VoiceModelInfo, VoiceRuntimeStatus } from '@shared/ipc'
import type { TtsLocalEngine, TtsSettings } from '@shared/voice'
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
import { useVoiceCatalog } from '../../lib/voice/useVoiceCatalog'
import { Button, Label } from '../ui/controls'
import { Select } from '../ui/Select'
import { ApiInfo, C, HelpTip } from '../ui/Tooltip'
import {
  ApiKeyField,
  BaseUrlField,
  CatalogStatus,
  CustomEndpointDisclosure,
  DismissibleError,
  LocalModelList,
  VoiceModelField,
  VoicePicker,
  VoiceProviderSelect
} from './voiceSettingsParts'
import {
  CUSTOM_ENDPOINT,
  effectiveFamily,
  playAudioBytes,
  type ProviderOption
} from '../../lib/voice/voiceSettingsHelpers'

const TTS_BACKEND_LABELS: Record<TtsSettings['backend'], { label: string; description: string }> = {
  api: {
    label: 'API',
    description: 'Provedor remoto (OpenRouter, ElevenLabs, OpenAI…) — o texto falado sai do app'
  },
  local: {
    label: 'Local',
    description: 'Motor Kokoro no dispositivo — o texto nunca sai do computador'
  }
}

/** Mensagem do IPC sem o prefixo da classe (`TtsError: …`) — o texto do main já é legível. */
const ipcError = (e: unknown): string => errorMessage(e).replace(/^[A-Z]\w*Error: /, '')

const TTS_ENGINE_LABELS: Record<TtsLocalEngine, string> = {
  kokoro: 'kokoro (Kokoro-82M, ONNX)',
  chatterbox: 'chatterbox — ainda não suportado'
}

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

/** Primeiro provedor do OpenRouter (atalho "Usar OpenRouter (ElevenLabs Flash)"). */
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
  /** Grava `ttsSettings` (a máscara da chave no valor = preserva a chave salva). */
  onCommit: (next: TtsSettings) => Promise<boolean>
  onModelAction: (model: VoiceModelInfo, action: LocalModelAction['action']) => void
}): React.JSX.Element | null {
  const voiceApi = api.voice
  const isApi = tts.backend === 'api'
  const provider = providers.find((p) => p.id === tts.api.providerId) ?? null
  const isCustom = !provider
  const family = effectiveFamily(provider, tts.api.baseUrl)
  const [advancedOpen, setAdvancedOpen] = useState<boolean | null>(null)
  const advanced = advancedOpen ?? isCustom
  const catalog = useVoiceCatalog(
    'tts',
    provider?.id ?? null,
    isApi,
    isCustom ? tts.api.baseUrl : ''
  )
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
    void voiceApi?.tts.clips
      .list()
      .then((m) =>
        setClips((c) => ({
          ...c,
          count: m && !m.stale ? m.clips.length : 0,
          stale: !!m?.stale
        }))
      )
      .catch(() => void 0)
  }, [voiceApi])

  const refreshLocalVoices = useCallback((): void => {
    void voiceApi?.tts
      .voices()
      .then((v) => setLocalVoices(v.local))
      .catch(() => void 0)
  }, [voiceApi])

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

  if (!voiceApi) return null

  const commit = async (next: TtsSettings): Promise<boolean> => {
    const ok = await onCommit(next)
    // voz/backend/motor mudaram → a contagem de clipes é a do cache da voz nova
    refreshClips()
    return ok
  }
  const saveApi = (patch: Partial<TtsSettings['api']>): void => {
    void commit({ ...tts, api: { ...tts.api, ...patch } })
  }
  /**
   * Troca de modelo: a voz salva que o modelo novo não aceita (OpenRouter: `supported_voices`) vira
   * a 1ª recomendada para pt-BR (ou a 1ª da lista); modelo sem vozes (ex.: Fish Audio) = voz padrão.
   */
  const commitModel = (model: string): void => {
    const m = catalog.catalog?.models.find((x) => x.id === model)
    let voice = tts.api.voice
    if (m?.voiceIds) {
      if (!m.voiceIds.length) voice = null
      else if (!voice || !m.voiceIds.includes(voice))
        voice = m.ptVoices?.find((v) => m.voiceIds!.includes(v)) ?? m.voiceIds[0]
    }
    void commit({ ...tts, api: { ...tts.api, model, voice } })
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

  const pickProvider = (v: string): void => {
    if (v === CUSTOM_ENDPOINT) {
      setAdvancedOpen(true)
      saveApi({ providerId: null })
      return
    }
    const p = providers.find((x) => x.id === v)
    const fam = p ? voiceProviderSupport(p) : null
    const keep = modelFitsFamily(tts.api.model, fam)
    setAdvancedOpen(false)
    saveApi({
      providerId: v,
      ...(keep || !fam ? {} : { model: TTS_DEFAULTS[fam].model, voice: TTS_DEFAULTS[fam].voice })
    })
  }

  const openRouter = providers.find((p) => voiceProviderSupport(p) === 'openrouter') ?? null
  const presetActive = isApi && family === 'openrouter' && tts.api.model === OPENROUTER_PRESET.model
  const applyPreset = (): void => {
    void commit({
      ...tts,
      backend: 'api',
      api: {
        ...tts.api,
        providerId: openRouter?.id ?? tts.api.providerId,
        ...(openRouter ? {} : { baseUrl: 'https://openrouter.ai/api/v1' }),
        model: OPENROUTER_PRESET.model,
        voice: OPENROUTER_PRESET.voice
      }
    })
  }

  // vozes do modelo escolhido (OpenRouter: `supported_voices` do modelo; ElevenLabs: da conta),
  // pt primeiro: as recomendadas do modelo para pt-BR, depois pt-BR/pt/multilíngue/resto
  const model =
    catalog.catalog?.models.find((m) => m.id === tts.api.model) ??
    catalog.catalog?.hiddenModels?.find((m) => m.id === tts.api.model) ??
    null
  const allVoices = catalog.catalog?.voices ?? []
  const voices: VoiceCatalogVoice[] = orderVoicesForPt(
    model?.voiceIds?.length
      ? model.voiceIds.map(
          (id) => allVoices.find((v) => v.id === id) ?? describeVoice(id, model.id)
        )
      : model?.voiceIds && family === 'openrouter'
        ? [] // modelo sem vozes listadas (ex.: Fish Audio): só a voz padrão
        : allVoices,
    model?.ptVoices ?? []
  )
  const noVoiceList = !!model?.voiceIds && model.voiceIds.length === 0

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
  const runPreview = (v: VoiceCatalogVoice): void => {
    if (preview?.id === v.id && preview.state === 'playing') {
      stopPlaying()
      setPreview(null)
      return
    }
    setTest((s) => ({ ...s, state: 'idle' }))
    setPreviewError(null)
    setPreview({ id: v.id, state: 'busy' })
    const get =
      v.previewUrl && voiceApi.catalog
        ? voiceApi.catalog.preview({ url: v.previewUrl })
        : voiceApi.tts.test({
            voice: v.id,
            ...(isApi && tts.api.model ? { model: tts.api.model } : {}),
            text: VOICE_PREVIEW_PHRASE
          })
    void get
      .then((r) => {
        setPreview({ id: v.id, state: 'playing' })
        play(
          r.audio,
          r.mime,
          () => setPreview(null),
          (msg) => {
            setPreview(null)
            setPreviewError(`Prévia de “${v.label}”: ${msg}`)
          }
        )
      })
      .catch((e) => {
        setPreview(null)
        setPreviewError(`Prévia de “${v.label}”: ${ipcError(e)}`)
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
  const currentVoiceLabel = isApi
    ? tts.api.voice
      ? (voices.find((v) => v.id === tts.api.voice)?.label ?? tts.api.voice)
      : 'voz padrão'
    : (localVoices.find((v) => v.id === tts.local?.voice)?.label ?? tts.local?.voice ?? 'pf_dora')

  return (
    <section className="border-t border-border pt-4" data-testid="tts-section">
      <div className="mb-3 flex items-baseline gap-2">
        <span className="text-[13px] font-medium text-fg/90">Fala (TTS)</span>
        <HelpTip label="Fala (TTS)">
          <p>
            Síntese de fala da chamada de voz: um provedor de API (cadastrado em Configurações →
            Provedores — OpenRouter, ElevenLabs, OpenAI-compatível) ou o motor local Kokoro (pesos
            ONNX baixados aqui; a fonemização pt-BR usa o <C>espeak-ng</C> do sistema). Modelos e
            vozes vêm da lista do provedor (OpenRouter: <C>/models?output_modalities=speech</C>, com
            as vozes de cada modelo).
          </p>
          <p className="mt-2">
            A chave do provedor fica no processo principal e nunca chega à tela.
          </p>
        </HelpTip>
        <TtsApiInfo tts={tts} baseUrl={provider?.baseUrl ?? tts.api.baseUrl} family={family} />
      </div>
      <div className="space-y-4">
        <div>
          <Label>Backend</Label>
          <Select
            value={tts.backend}
            label="Backend de fala"
            className="h-8 w-full max-w-[360px]"
            menuMinWidth={360}
            onChange={(backend) => void commit({ ...tts, backend })}
            options={(['local', 'api'] as TtsSettings['backend'][]).map((b) => ({
              value: b,
              label: TTS_BACKEND_LABELS[b].label,
              description: TTS_BACKEND_LABELS[b].description
            }))}
          />
        </div>
        {!presetActive && (
          <div className="flex flex-wrap items-center gap-2" data-testid="tts-preset">
            <Button
              size="sm"
              variant="secondary"
              data-testid="tts-preset-openrouter"
              onClick={applyPreset}
            >
              Usar OpenRouter (ElevenLabs Flash)
            </Button>
            <span className="text-[11px] text-subtle">
              {openRouter
                ? `fala rápida pela API, com o provedor “${openRouter.name}”`
                : 'cadastre o OpenRouter em Provedores (ou cole a chave no endpoint personalizado)'}
            </span>
            <HelpTip label="Híbrido rápido">
              <p>
                Combinação recomendada para a chamada de voz: transcrição <C>híbrida</C> (whisper{' '}
                <C>base</C> local como reserva) e fala pelo OpenRouter com o ElevenLabs Flash v2.5
                (~0,5 s até o 1º áudio; o áudio chega em streaming). O texto falado vai ao
                OpenRouter (cobrança por caractere). O Kokoro local continua disponível offline.
              </p>
            </HelpTip>
          </div>
        )}

        {isApi ? (
          <div className="space-y-3" data-testid="tts-api">
            <div>
              <Label help="Provedores de Configurações → Provedores que servem fala (o endpoint e a chave vêm do provedor). Servidor fora da lista (ex.: Kokoro-FastAPI local): Endpoint personalizado.">
                Provedor
              </Label>
              <VoiceProviderSelect
                capability="tts"
                providers={providers}
                value={provider ? provider.id : CUSTOM_ENDPOINT}
                onChange={pickProvider}
                testId="tts-provider"
              />
              {tts.api.providerId && !provider && (
                <p className="mt-1 text-[11px] text-warning" role="alert">
                  O provedor escolhido não existe mais — usando o endpoint personalizado abaixo.
                </p>
              )}
            </div>
            <div>
              <Label help="Só os modelos testados para a chamada de voz: 1º áudio em até ~0,9 s numa frase curta e pt-BR aceitável (medido; o badge mostra o tempo). Os lentos ou sem pt-BR ficam fora da lista; um id livre fica no Avançado, sem garantia.">
                Modelo
              </Label>
              <VoiceModelField
                capability="tts"
                state={catalog}
                value={tts.api.model}
                onCommit={commitModel}
                testId="tts-model"
                placeholder={
                  family === 'openrouter' ? 'elevenlabs/eleven-flash-v2.5' : 'gpt-4o-mini-tts'
                }
                family={family}
                recommended={recommended}
              />
            </div>
            <div>
              <Label help="Voz pedida ao provedor. A lista vem do modelo escolhido (OpenRouter: supported_voices; ElevenLabs: as vozes da sua conta). ▶ toca uma prévia (a do provedor quando existe; senão sintetiza uma frase curta — custa como uma frase falada). 'Outra voz (ID)' aceita qualquer id.">
                Voz
              </Label>
              <VoicePicker
                voices={voices}
                value={tts.api.voice}
                onChange={(voice) => saveApi({ voice })}
                onPreview={runPreview}
                previewing={preview}
                allowDefault={family === 'openai' || noVoiceList}
              />
              <CatalogStatus state={catalog} kind="vozes" />
            </div>
            <CustomEndpointDisclosure
              open={advanced}
              onToggle={() => setAdvancedOpen(!advanced)}
              testId="tts-advanced"
            >
              {isCustom ? (
                <>
                  <div>
                    <Label help="Base OpenAI-compatível (o app chama {baseUrl}/audio/speech). Ex.: Kokoro-FastAPI local.">
                      Endpoint (baseUrl)
                    </Label>
                    <BaseUrlField
                      value={tts.api.baseUrl}
                      onCommit={(baseUrl) => saveApi({ baseUrl })}
                      testId="tts-base-url"
                      placeholder="http://localhost:8880/v1"
                      label="Endpoint de síntese de fala (baseUrl)"
                    />
                  </div>
                  <div>
                    <Label help="Chave do endpoint personalizado (header Authorization: Bearer). Endpoint local pode ficar sem chave.">
                      Chave de API
                    </Label>
                    <ApiKeyField
                      mask={tts.api.apiKey}
                      onSave={(key) =>
                        commit({ ...tts, api: { ...tts.api, apiKey: key as string } })
                      }
                      what="fala"
                      testId="tts-api-key"
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
                    data-testid="tts-use-custom"
                    onClick={() => pickProvider(CUSTOM_ENDPOINT)}
                    className="rounded px-1 text-accent-strong underline-offset-2 hover:underline"
                  >
                    usar endpoint personalizado
                  </button>
                </div>
              )}
            </CustomEndpointDisclosure>
          </div>
        ) : (
          <div className="space-y-3" data-testid="tts-local">
            <div className="flex flex-wrap items-center gap-2">
              <Label className="mb-0">Motor local</Label>
              <Select
                value={engine}
                label="Motor local de fala"
                className="h-8 w-[300px]"
                menuMinWidth={320}
                onChange={(e) => {
                  void commit({
                    ...tts,
                    local: {
                      engine: e as TtsLocalEngine,
                      voice: tts.local?.voice ?? '',
                      installed: tts.local?.installed ?? false
                    }
                  }).then(refreshLocalVoices)
                }}
                // Chatterbox ainda não sintetiza: só aparece se já estiver salvo (para trocar)
                options={(engine === 'chatterbox'
                  ? (['kokoro', 'chatterbox'] as TtsLocalEngine[])
                  : (['kokoro'] as TtsLocalEngine[])
                ).map((e) => ({ value: e, label: TTS_ENGINE_LABELS[e] }))}
              />
              <span
                className={`rounded-full border px-1.5 py-px text-[10px] leading-4 ${
                  tts.local?.installed
                    ? 'border-success/30 text-success'
                    : 'border-warning/30 text-warning'
                }`}
              >
                {tts.local?.installed ? 'instalado' : 'não instalado'}
              </span>
            </div>
            {runtime && engine === 'kokoro' && !runtime.ttsLocal.available && (
              <p
                className="flex items-start gap-1 text-[11px] text-warning"
                role="alert"
                data-testid="tts-runtime-warning"
              >
                <TriangleAlert className="mt-0.5 size-3 shrink-0" /> Motor local não está pronto:{' '}
                {runtime.ttsLocal.reason ?? 'runtime indisponível'}
              </p>
            )}
            <div>
              <Label help="Voz do motor local. As vozes pt-BR do Kokoro vêm dos voice packs baixados aqui embaixo (sem o pack instalado, a síntese avisa).">
                Voz
              </Label>
              <Select
                value={tts.local?.voice ?? 'pf_dora'}
                label="Voz do motor local"
                className="h-8 w-full max-w-[360px]"
                menuMinWidth={360}
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
              {engine !== 'kokoro' && (
                <p className="mt-1.5 flex items-center gap-1 text-[11px] text-warning" role="alert">
                  <TriangleAlert className="size-3 shrink-0" /> O Chatterbox ainda não funciona —
                  escolha o motor kokoro ou o backend de API.
                </p>
              )}
            </div>
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
            <p>
              Os clipes (interjeições e falas de espera da chamada de voz) são gerados com a voz e o
              backend atuais (API → pelo provedor; Local → pelo Kokoro) e ficam em cache em{' '}
              <C>userData/voice-clips</C>, um cache por voz. Ao trocar a voz ou as frases, gere de
              novo — sem clipes, interjeições e falas de espera não tocam.
            </p>
          </HelpTip>
          {clips.busy && (
            <span className="text-[11px] text-subtle tabular-nums" data-testid="tts-clips-progress">
              gerando clipes… {clips.done}/{clips.total || '…'}
            </span>
          )}
          {!clips.busy && clips.count !== null && clips.count > 0 && (
            <span className="text-[11px] text-subtle" data-testid="tts-clips-count">
              {clips.count} clipes gerados para “{currentVoiceLabel}”
            </span>
          )}
          {!clips.busy && clips.count === 0 && (
            <span className="text-[11px] text-warning" data-testid="tts-clips-missing">
              {clips.stale
                ? `clipes de “${currentVoiceLabel}” desatualizados (frases ou modelo mudaram) — gere de novo`
                : `sem clipes para “${currentVoiceLabel}”`}
            </span>
          )}
        </div>
        {test.state === 'playing' && (
          <p className="text-[11px] text-subtle" role="status" data-testid="tts-test-playing">
            Tocando “Olá, isto é um teste.” com {isApi ? tts.api.model || 'o modelo' : 'o Kokoro'} ·{' '}
            {currentVoiceLabel}
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
        {!isApi && (
          <LocalModelList
            kind="tts"
            models={models}
            progress={modelProgress}
            onAction={onModelAction}
          />
        )}
      </div>
    </section>
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
