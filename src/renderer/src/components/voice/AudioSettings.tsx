// Configurações → Áudio: ditado por voz (microfone padrão, push-to-talk com captura de tecla,
// auto-stop por silêncio, idioma), transcrição (STT — modo, endpoint de API com chave mascarada,
// motor local com download real dos modelos, parciais ao vivo) e fala (TTS — backend API/local,
// endpoint com chave mascarada, vozes do Kokoro, "Testar voz" e geração dos clipes de
// interjeição/filler; os pesos do motor baixam pela mesma lista de modelos locais) e os padrões da
// chamada de voz (ligada, silêncio do turno, interjeições/fillers). Espelha o padrão de "Pesquisa
// na web" (`WebSearchSettings.tsx`): cada controle grava na hora via `saveVoiceSetting` (espelho
// reativo `useVoiceSettings` — o composer e a chamada acompanham na hora) e falha de gravação vira
// aviso visível. Chaves de API: campo vazio com a máscara no placeholder, "Salvar"/"Remover"
// explícitos e olho que mostra só o que foi digitado (a chave real nunca sai do main); limpar o
// campo NÃO apaga a chave (contrato do main testado em `e2e/voiceSettings.test.ts`).
import {
  Check,
  Download,
  Eye,
  EyeOff,
  KeyRound,
  Play,
  Square,
  TriangleAlert,
  X
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type {
  TtsSynthResult,
  TtsVoicesView,
  VoiceModelInfo,
  VoiceRuntimeStatus,
  VoiceSettingKind,
  VoiceSettingsMap
} from '@shared/ipc'
import type {
  SttLocalConfig,
  SttMode,
  SttSettings,
  TtsLocalEngine,
  TtsSettings,
  VoiceCallDefaults,
  InterjectionClass
} from '@shared/voice'
import {
  DEFAULT_AUDIO_INPUT,
  DEFAULT_STT_SETTINGS,
  DEFAULT_TTS_SETTINGS,
  DEFAULT_TURN_SILENCE_MS,
  DEFAULT_VOICE_CALL_DEFAULTS,
  INTERJECTION_CLASSES
} from '@shared/voice'
import type { AudioInputSettings } from '@shared/voice'
import { api, errorMessage } from '../../lib/api'
import { pttHotkeyProblem } from '../../lib/audio/hotkey'
import { menuInputDevices } from '../../lib/audio/devices'
import { formatHotkeyLabel, hotkeyFromEvent } from '../../lib/voice/hotkeyLabel'
import { loadVoiceSettings, saveVoiceSetting } from '../../lib/voice/voiceSettings'
import { useEscapeLayer } from '../ui/escape'
import {
  formatModelLanguages,
  formatModelSize,
  modelAction,
  type LocalModelAction
} from '../../lib/voice/modelList'
import { Button, IconButton, Kbd, Label, Switch } from '../ui/controls'
import { Select } from '../ui/Select'
import { ApiInfo, C, HelpTip } from '../ui/Tooltip'
import { useInputDeviceList } from '../../lib/voice/useInputDevices'

/** Idiomas comuns do ditado (o campo aceita livre — "Outro…" abre o texto). */
const LANGUAGES: { value: string; label: string }[] = [
  { value: 'pt-BR', label: 'Português (Brasil)' },
  { value: 'pt-PT', label: 'Português (Portugal)' },
  { value: 'en-US', label: 'Inglês (EUA)' },
  { value: 'en-GB', label: 'Inglês (Reino Unido)' },
  { value: 'es-ES', label: 'Espanhol' },
  { value: 'fr-FR', label: 'Francês' },
  { value: 'de-DE', label: 'Alemão' },
  { value: 'it-IT', label: 'Italiano' },
  { value: 'ja-JP', label: 'Japonês' },
  { value: 'zh-CN', label: 'Chinês (simplificado)' },
  { value: 'ko-KR', label: 'Coreano' },
  { value: 'ru-RU', label: 'Russo' }
]
const CUSTOM_LANGUAGE = '__custom__'

const STT_MODE_LABELS: Record<SttMode, { label: string; description: string }> = {
  api: { label: 'API', description: 'Endpoint remoto OpenAI-compatível (/audio/transcriptions)' },
  local: {
    label: 'Local',
    description: 'Motor no dispositivo (whisper.cpp) — o áudio nunca sai do computador'
  },
  hybrid: { label: 'Híbrido', description: 'API com fallback local em falhas de disponibilidade' }
}

const TTS_BACKEND_LABELS: Record<TtsSettings['backend'], { label: string; description: string }> = {
  api: {
    label: 'API',
    description: 'Endpoint remoto OpenAI-compatível (POST /audio/speech → bytes de áudio)'
  },
  local: {
    label: 'Local',
    description: 'Motor Kokoro no dispositivo — o texto nunca sai do computador'
  }
}

/**
 * Combo "híbrido rápido" (SPEC → "Serviço de TTS → OpenRouter"): fala pela API do OpenRouter com o
 * ElevenLabs Flash v2.5 (~0,5 s até o 1º áudio, PCM em streaming na chamada). Voz curta do
 * ElevenLabs ('sarah', 'george'…) — passa como está.
 */
const OPENROUTER_TTS_PRESET = {
  baseUrl: 'https://openrouter.ai/api/v1',
  model: 'elevenlabs/eleven-flash-v2.5',
  voice: 'sarah'
} as const

/** Sugestões de voz do ElevenLabs via OpenRouter (o campo aceita qualquer id). */
const ELEVENLABS_VOICES = ['sarah', 'george', 'laura', 'charlie', 'roger', 'alice', 'brian', 'lily']

/** Provedor salvo para reaproveitar a chave (só id/nome/endpoint — a chave nunca vem para cá). */
interface ProviderOption {
  id: string
  name: string
  baseUrl: string
}

const isOpenRouterUrl = (u: string): boolean => /(^|\.|\/\/)openrouter\.ai(\/|:|$)/i.test(u.trim())

const TTS_ENGINE_LABELS: Record<TtsLocalEngine, string> = {
  kokoro: 'kokoro (Kokoro-82M, ONNX)',
  chatterbox: 'chatterbox — ainda não suportado'
}

/** Rótulos pt-BR das classes de interjeição (o id técnico fica no tooltip). */
const INTERJECTION_LABELS: Record<InterjectionClass, { label: string; example: string }> = {
  ACK: { label: 'Confirmação', example: '“uhum”, “sei”' },
  AGREEMENT: { label: 'Concordância', example: '“isso”, “exato”' },
  ENCOURAGEMENT: { label: 'Incentivo', example: '“boa!”, “legal”' },
  THINKING: { label: 'Pensando', example: '“hum…”, “deixa eu ver”' }
}

export function AudioSettings(): React.JSX.Element | null {
  const voice = api.voice
  const [input, setInput] = useState<AudioInputSettings>(DEFAULT_AUDIO_INPUT)
  const [stt, setStt] = useState<SttSettings>(DEFAULT_STT_SETTINGS)
  const [tts, setTts] = useState<TtsSettings>(DEFAULT_TTS_SETTINGS)
  /** Padrões globais da chamada de voz (interjeições/fillers — SPEC → "Chamada de voz"). */
  const [callDefaults, setCallDefaults] = useState<VoiceCallDefaults>(DEFAULT_VOICE_CALL_DEFAULTS)
  /** Falha ao gravar alguma setting (aviso visível no topo — nada falha em silêncio). */
  const [saveError, setSaveError] = useState<string | null>(null)
  /** Prontidão dos runtimes locais (whisper/onnxruntime/espeak-ng); null = sem probe no main. */
  const [runtime, setRuntime] = useState<VoiceRuntimeStatus | null>(null)
  /** Rascunho do idioma livre ("Outro…") enquanto digita; null = lista comum. */
  const [langDraft, setLangDraft] = useState<string | null>(null)
  /** Vozs de fala (`voice:tts:voices`): engine local + sugestões livres para a API. */
  const [ttsVoices, setTtsVoices] = useState<TtsVoicesView>({ local: [], api: [] })
  /** Estado do "Testar voz" (sintetiza a frase de demonstração e reproduz). */
  const [ttsTest, setTtsTest] = useState<{
    state: 'idle' | 'busy' | 'playing'
    error: string | null
  }>({ state: 'idle', error: null })
  /** Estado da geração dos clipes de interjeição/filler. */
  const [ttsClips, setTtsClips] = useState<{
    busy: boolean
    done: number
    total: number
    error: string | null
    count: number | null
  }>({ busy: false, done: 0, total: 0, error: null, count: null })
  /** Provedores salvos (id/nome/endpoint) para reaproveitar a chave no STT/TTS (`providerId`). */
  const [providers, setProviders] = useState<ProviderOption[]>([])
  /** Modelos locais (catálogo + estado em disco, `voice:models:list`). */
  const [models, setModels] = useState<VoiceModelInfo[]>([])
  /** Progresso de download por modelo id (evento `voice:models:progress`). */
  const [modelProgress, setModelProgress] = useState<
    Record<string, { bytes: number; total: number }>
  >({})
  /** Erro de download/remoção de modelo (aviso legível no painel). */
  const [modelError, setModelError] = useState<string | null>(null)
  const { devices: allDevices, loaded: devicesLoaded } = useInputDeviceList()
  const { systemLabel, devices } = menuInputDevices(allDevices)
  /** `<audio>` do "Testar voz" em reprodução (Parar / fechar o modal interrompe). */
  const testAudio = useRef<{ el: HTMLAudioElement; url: string } | null>(null)

  useEffect(() => {
    let alive = true
    void loadVoiceSettings().then((all) => {
      if (!alive) return
      setInput(all.audioInput)
      setStt(all.sttSettings)
      setTts(all.ttsSettings)
      setCallDefaults(all.voiceCallDefaults)
    })
    void api.providers
      ?.list()
      .then((list) => {
        // só o que a tela precisa: a chave do provedor é usada pelo main a partir do `providerId`
        if (alive) setProviders(list.map((p) => ({ id: p.id, name: p.name, baseUrl: p.baseUrl })))
      })
      .catch(() => void 0)
    void voice?.models
      .list()
      .then((list) => {
        if (alive) setModels(list)
      })
      .catch(() => void 0)
    void voice?.runtime
      ?.status()
      .then((r) => {
        if (alive) setRuntime(r)
      })
      .catch(() => void 0)
    void voice?.tts
      .voices()
      .then((view) => {
        if (alive) setTtsVoices(view)
      })
      .catch(() => void 0)
    void voice?.tts.clips
      .list()
      .then((m) => {
        if (alive) setTtsClips((c) => ({ ...c, count: m && !m.stale ? m.clips.length : 0 }))
      })
      .catch(() => void 0)
    return () => {
      alive = false
    }
  }, [voice])

  // fechar o modal (desmontar) interrompe o "Testar voz"
  useEffect(
    () => () => {
      const t = testAudio.current
      testAudio.current = null
      if (t) {
        t.el.pause()
        URL.revokeObjectURL(t.url)
      }
    },
    []
  )

  // progresso dos downloads em voo (main → renderer); o estado 'downloading' vem junto
  useEffect(
    () =>
      api.onVoiceModelProgress?.((e) => {
        setModelProgress((p) => ({ ...p, [e.id]: { bytes: e.bytes, total: e.total } }))
        setModels((ms) => ms.map((m) => (m.id === e.id ? { ...m, state: 'downloading' } : m)))
      }),
    []
  )

  // progresso da geração de clipes (`voice:tts:clips:progress`)
  useEffect(
    () =>
      api.onVoiceTtsClipsProgress?.((e) => {
        setTtsClips((c) => ({ ...c, busy: true, done: e.done, total: e.total }))
      }),
    []
  )

  if (!voice) {
    return (
      <p className="text-sm text-subtle" data-testid="audio-settings">
        API de voz indisponível neste build.
      </p>
    )
  }

  /** Grava um grupo e devolve o valor normalizado (null = falhou; o aviso fica visível no topo). */
  const persist = async <K extends VoiceSettingKind>(
    kind: K,
    value: unknown
  ): Promise<VoiceSettingsMap[K] | null> => {
    try {
      const saved = await saveVoiceSetting(kind, value)
      setSaveError(null)
      return saved
    } catch (e) {
      setSaveError(`Não foi possível salvar: ${errorMessage(e)}`)
      return null
    }
  }

  const saveInput = (patch: Partial<AudioInputSettings>): void => {
    const next = { ...input, ...patch }
    setInput(next)
    void persist('audioInput', next).then((saved) => saved && setInput(saved))
  }

  /** Grava `voiceCallDefaults` (padrões globais da chamada de voz — herdados por persona/chat). */
  const saveCallDefaults = (patch: Partial<VoiceCallDefaults>): void => {
    const next = { ...callDefaults, ...patch }
    setCallDefaults(next)
    void persist('voiceCallDefaults', next).then((saved) => saved && setCallDefaults(saved))
  }

  /** Grava `sttSettings` (a máscara da chave no valor = preserva a chave salva). */
  const commitStt = async (next: SttSettings): Promise<boolean> => {
    setStt(next)
    const saved = await persist('sttSettings', next)
    if (saved) setStt(saved)
    return !!saved
  }
  const saveStt = (patch: Partial<Omit<SttSettings, 'api'>>): void => {
    void commitStt({ ...stt, ...patch })
  }
  const saveSttApi = (patch: Partial<SttSettings['api']>): void => {
    void commitStt({ ...stt, api: { ...stt.api, ...patch } })
  }
  /** "Salvar"/"Remover" da chave de STT: `null` remove; string = chave nova. */
  const saveSttKey = (key: string | null): Promise<boolean> =>
    commitStt({ ...stt, api: { ...stt.api, apiKey: key as string } })

  // ---- TTS (síntese de fala + clipes) ----

  /** Recarrega a contagem de clipes da voz ATUAL (cada voz tem o seu cache). */
  const refreshClipCount = (): void => {
    void voice.tts.clips
      .list()
      .then((m) => setTtsClips((c) => ({ ...c, count: m && !m.stale ? m.clips.length : 0 })))
      .catch(() => void 0)
  }

  /** Grava `ttsSettings` (a máscara da chave no valor = preserva a chave salva). */
  const commitTts = async (next: TtsSettings): Promise<boolean> => {
    setTts(next)
    const saved = await persist('ttsSettings', next)
    if (saved) setTts(saved)
    // voz/backend/motor mudaram → a contagem de clipes é a do cache da voz nova
    refreshClipCount()
    return !!saved
  }
  const saveTts = (patch: Partial<Omit<TtsSettings, 'api'>>): void => {
    void commitTts({ ...tts, ...patch })
  }
  const saveTtsApi = (patch: Partial<TtsSettings['api']>): void => {
    void commitTts({ ...tts, api: { ...tts.api, ...patch } })
  }
  const saveTtsKey = (key: string | null): Promise<boolean> =>
    commitTts({ ...tts, api: { ...tts.api, apiKey: key as string } })

  /** Primeiro provedor salvo do OpenRouter (a chave dele serve à fala/transcrição pelo `providerId`). */
  const openRouterProvider = providers.find((p) => isOpenRouterUrl(p.baseUrl)) ?? null
  /** Provedor escolhido para a fala (null = endpoint avulso / provedor apagado). */
  const ttsProvider = providers.find((p) => p.id === tts.api.providerId) ?? null
  const sttProvider = providers.find((p) => p.id === stt.api.providerId) ?? null

  /** "Usar OpenRouter (ElevenLabs Flash)": backend API + endpoint/modelo/voz + chave do provedor salvo. */
  const applyOpenRouterTts = (): void => {
    void commitTts({
      ...tts,
      backend: 'api',
      api: {
        ...tts.api,
        providerId: openRouterProvider?.id ?? tts.api.providerId,
        baseUrl: OPENROUTER_TTS_PRESET.baseUrl,
        model: OPENROUTER_TTS_PRESET.model,
        voice: OPENROUTER_TTS_PRESET.voice
      }
    })
  }

  /** Recarrega as vozes (`voice:tts:voices`) — a lista local muda com o engine escolhido. */
  const refreshTtsVoices = (): void => {
    void voice.tts
      .voices()
      .then(setTtsVoices)
      .catch(() => void 0)
  }

  /** Para o áudio do "Testar voz" (botão Parar, novo teste ou modal fechando). */
  const stopTtsTest = (): void => {
    const t = testAudio.current
    testAudio.current = null
    if (t) {
      t.el.pause()
      URL.revokeObjectURL(t.url)
    }
    setTtsTest((s) => ({ ...s, state: 'idle' }))
  }

  /** "Testar voz": sintetiza a frase de demonstração e reproduz (bytes → blob → `<audio>`). */
  const runTtsTest = (): void => {
    if (ttsTest.state === 'playing') {
      stopTtsTest()
      return
    }
    setTtsTest({ state: 'busy', error: null })
    void voice.tts
      .test()
      .then((r) => {
        setTtsTest({ state: 'playing', error: null })
        testAudio.current = playTtsAudio(
          r,
          () => {
            testAudio.current = null
            setTtsTest((s) => ({ ...s, state: 'idle' }))
          },
          (error) => {
            testAudio.current = null
            setTtsTest({ state: 'idle', error })
          }
        )
      })
      .catch((e) => setTtsTest({ state: 'idle', error: errorMessage(e) }))
  }

  /** "Gerar clipes de voz": pré-gera as falas curtas (interjeições/fillers) da voz atual. */
  const runTtsClips = (): void => {
    setTtsClips((c) => ({ ...c, busy: true, done: 0, total: 0, error: null }))
    void voice.tts.clips
      .generate()
      .then((m) =>
        setTtsClips({
          busy: false,
          done: m.clips.length,
          total: m.clips.length,
          error: null,
          count: m.clips.length
        })
      )
      .catch((e) => setTtsClips((c) => ({ ...c, busy: false, error: errorMessage(e) })))
  }

  // ---- modelos locais (download/remoção com progresso) ----

  const refreshModels = (): void => {
    void voice.models
      .list()
      .then(setModels)
      .catch(() => void 0)
  }

  /** O main sincroniza `installed` nas settings ao instalar/remover — relee os grupos. */
  const refreshModelSettings = (): void => {
    void voice.settings
      .get()
      .then((all) => {
        setStt(all.sttSettings)
        setTts(all.ttsSettings)
      })
      .catch(() => void 0)
    refreshRuntime()
  }

  /** Probe dos runtimes locais (`voice.runtime.status`, quando o main expõe) — "pronto" de verdade. */
  const refreshRuntime = (): void => {
    void voice.runtime
      ?.status()
      .then(setRuntime)
      .catch(() => void 0)
  }

  /** Ação da linha do modelo (`modelAction`): baixar/rebaixar, cancelar ou remover. */
  const runModelAction = (model: VoiceModelInfo, action: LocalModelAction['action']): void => {
    if (!action) return
    setModelError(null)
    if (action === 'cancel') {
      void voice.models.cancel({ id: model.id }).catch(() => void 0)
      return
    }
    if (action === 'remove') {
      setModels((ms) =>
        ms.map((m) =>
          m.id === model.id ? { ...m, state: 'notInstalled', installedBytes: null } : m
        )
      )
      void voice.models
        .remove({ id: model.id })
        .then(refreshModelSettings)
        .catch((e) => {
          setModelError(errorMessage(e))
          refreshModels()
        })
      return
    }
    // 'download' | 'retry': baixa com progresso (`voice:models:progress`); cancelado resolve null
    setModels((ms) => ms.map((m) => (m.id === model.id ? { ...m, state: 'downloading' } : m)))
    setModelProgress((p) => ({ ...p, [model.id]: { bytes: 0, total: model.sizeBytes } }))
    void voice.models
      .download({ id: model.id })
      .then((info) => {
        if (info) setModels((ms) => ms.map((m) => (m.id === model.id ? info : m)))
        else refreshModels() // cancelado: volta ao estado em disco
        refreshModelSettings()
      })
      .catch((e) => {
        setModelError(errorMessage(e))
        refreshModels()
      })
  }

  const langIsCommon = LANGUAGES.some((l) => l.value === input.language)
  // microfone salvo fora da lista (desconectado): opção marcada com aviso (a captura usa o padrão)
  const micMissing =
    devicesLoaded &&
    input.deviceId !== null &&
    allDevices.every((d) => !!d.deviceId) &&
    !allDevices.some((d) => d.deviceId === input.deviceId)
  const pttProblem = input.pttKey ? pttHotkeyProblem(input.pttKey) : null
  /** O PTT só está ATIVO com uma tecla válida — ligado sem tecla aparece desligado. */
  const pttActive = input.pttEnabled && !!input.pttKey && !pttProblem
  const ttsEngine = tts.local?.engine ?? 'kokoro'

  return (
    <div className="space-y-6" data-testid="audio-settings">
      {saveError && (
        <div
          role="alert"
          data-testid="voice-settings-error"
          className="flex items-center gap-2 rounded-lg border border-danger/30 bg-danger/[0.06] px-2.5 py-1.5 text-[12px] text-danger"
        >
          <TriangleAlert className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1">{saveError}</span>
          <button
            type="button"
            aria-label="Dispensar erro de gravação"
            onClick={() => setSaveError(null)}
            className="shrink-0 rounded-md p-1 transition-colors hover:bg-danger/15"
          >
            <X className="size-3.5" />
          </button>
        </div>
      )}
      {/* ---- microfone ---- */}
      <section>
        <Label help="Microfone usado no ditado por voz e na chamada de voz (o menu do botão de microfone do composer mostra a mesma lista). Se o microfone escolhido for desconectado, a gravação usa o padrão do sistema e avisa.">
          Microfone padrão
        </Label>
        <Select
          value={input.deviceId ?? '__default__'}
          label="Microfone padrão"
          className="h-8 w-full max-w-[360px]"
          menuMinWidth={360}
          onChange={(v) => saveInput({ deviceId: v === '__default__' ? null : v })}
          options={[
            {
              value: '__default__',
              label: systemLabel ? `Padrão do sistema (${systemLabel})` : 'Padrão do sistema'
            },
            ...(micMissing && input.deviceId
              ? [
                  {
                    value: input.deviceId,
                    label: 'Microfone salvo (desconectado)',
                    description: 'Não encontrado — a gravação usa o padrão do sistema'
                  }
                ]
              : []),
            ...devices.map((d, i) => ({
              value: d.deviceId,
              label: d.label || `Microfone ${i + 1}`
            }))
          ]}
        />
        {micMissing && (
          <p
            className="mt-1.5 flex items-center gap-1 text-[11px] text-warning"
            data-testid="mic-missing-warning"
          >
            <TriangleAlert className="size-3 shrink-0" /> O microfone salvo não está conectado — a
            gravação usa o padrão do sistema até ele voltar.
          </p>
        )}
        {devicesLoaded && devices.length === 0 && (
          <p className="mt-1.5 text-[11px] text-subtle">
            Nenhum microfone encontrado (ou permissão ainda não concedida).
          </p>
        )}
      </section>

      {/* ---- push-to-talk ---- */}
      <section>
        <div className="mb-2 flex items-center gap-2">
          <Label
            className="mb-0"
            help={
              'Segure a tecla para falar e solte para parar e transcrever. Só funciona com a janela do ClearChat em foco e fica desligada enquanto o ditado não está disponível (chamada de voz, pergunta pendente, Configurações abertas).\nA tecla precisa ser F1–F24 ou ter Ctrl/Alt/Meta — uma tecla que digita deixaria de funcionar no app.\nO clique no microfone do composer funciona com ou sem push-to-talk.'
            }
          >
            Push-to-talk
          </Label>
          <Switch
            checked={pttActive}
            disabled={!input.pttKey || !!pttProblem}
            label="Push-to-talk"
            onChange={(v) => saveInput({ pttEnabled: v })}
          />
          {!input.pttKey && (
            <span className="text-[11px] text-subtle" data-testid="ptt-inactive-hint">
              inativo — defina uma tecla
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Kbd>{input.pttKey ? formatHotkeyLabel(input.pttKey) : 'sem tecla'}</Kbd>
          <KeyCaptureField
            value={input.pttKey}
            // tecla nova liga o push-to-talk (definir a tecla é a intenção de usar)
            onChange={(pttKey) => saveInput({ pttKey, pttEnabled: true })}
          />
          {input.pttKey && (
            <Button size="sm" variant="ghost" onClick={() => saveInput({ pttKey: null })}>
              Remover tecla
            </Button>
          )}
        </div>
        {pttProblem && (
          <p
            className="mt-1.5 flex items-center gap-1 text-[11px] text-warning"
            role="alert"
            data-testid="ptt-key-invalid"
          >
            <TriangleAlert className="size-3 shrink-0" /> A tecla salva não vale como push-to-talk:{' '}
            {pttProblem}
          </p>
        )}
      </section>

      {/* ---- auto-stop por silêncio ---- */}
      <section>
        <div className="mb-2 flex items-center gap-2">
          <Label
            className="mb-0"
            help={
              'Encerra a gravação do ditado sozinha quando você para de falar. O tempo conta de silêncio CONTÍNUO (falar de novo zera a contagem).\nMilissegundos de silêncio (padrão 5000). 0 = sem limite: a gravação só para no botão, na tecla do push-to-talk ou em Esc.\nA chamada de voz tem o próprio silêncio de turno (mais abaixo).'
            }
          >
            Parar por silêncio
          </Label>
          <Switch
            checked={input.silenceStopEnabled}
            label="Parar por silêncio"
            onChange={(v) => saveInput({ silenceStopEnabled: v })}
          />
        </div>
        <div className="flex items-center gap-2">
          <SilenceMsField
            value={input.silenceStopMs}
            disabled={!input.silenceStopEnabled}
            onCommit={(silenceStopMs) => saveInput({ silenceStopMs })}
          />
          <span className="text-[11px] text-subtle">ms · 0 = sem limite</span>
        </div>
      </section>

      {/* ---- idioma ---- */}
      <section>
        <Label help="Idioma pedido à API de transcrição (melhora a precisão). Idiomas fora da lista também são aceitos (código livre, ex.: 'nl').">
          Idioma do ditado
        </Label>
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={langIsCommon ? input.language : CUSTOM_LANGUAGE}
            label="Idioma do ditado"
            className="h-8 w-[240px]"
            menuMinWidth={240}
            onChange={(v) => {
              if (v === CUSTOM_LANGUAGE) setLangDraft(langIsCommon ? '' : input.language)
              else {
                setLangDraft(null)
                saveInput({ language: v })
              }
            }}
            options={[
              ...LANGUAGES,
              {
                value: CUSTOM_LANGUAGE,
                label: 'Outro (digitar)…',
                description: 'Código livre (ISO)'
              }
            ]}
          />
          {!langIsCommon || langDraft !== null ? (
            <input
              type="text"
              value={langDraft ?? input.language}
              spellCheck={false}
              aria-label="Idioma (código)"
              data-testid="language-custom"
              placeholder="ex.: nl, pl, tr"
              onChange={(e) => setLangDraft(e.target.value)}
              onBlur={() => {
                const v = (langDraft ?? '').trim()
                setLangDraft(null)
                // vazio não grava (o normalizador manda '' de volta ao padrão pt-BR)
                if (v) saveInput({ language: v })
              }}
              onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
              className="field h-8 w-[140px] px-2 py-0 font-mono text-[12px]"
            />
          ) : null}
        </div>
      </section>

      {/* ---- STT ---- */}
      <section className="border-t border-border pt-4">
        <div className="mb-3 flex items-baseline gap-2">
          <span className="text-[13px] font-medium text-fg/90">Transcrição (STT)</span>
          <HelpTip label="Transcrição de voz em texto">
            <p>
              O áudio gravado no ditado e na chamada de voz vira texto por um endpoint
              OpenAI-compatível <code className="font-mono">/audio/transcriptions</code> (padrão
              Groq) ou pelo motor local (whisper.cpp). Híbrido usa a API e cai no motor local quando
              a API falha. A chave de API fica no banco local e nunca chega à tela — o campo mostra
              só a máscara.
            </p>
          </HelpTip>
          <SttApiInfo stt={stt} language={input.language} />
        </div>
        <div className="space-y-4">
          <div>
            <Label>Modo</Label>
            <Select
              value={stt.mode}
              label="Modo de transcrição"
              className="h-8 w-full max-w-[360px]"
              menuMinWidth={360}
              onChange={(mode) => saveStt({ mode })}
              options={(['api', 'local', 'hybrid'] as SttMode[]).map((m) => ({
                value: m,
                label: STT_MODE_LABELS[m].label,
                description: STT_MODE_LABELS[m].description
              }))}
            />
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-3">
            <div>
              <Label>Endpoint (baseUrl)</Label>
              <input
                type="text"
                value={sttProvider ? sttProvider.baseUrl : stt.api.baseUrl}
                disabled={!!sttProvider}
                spellCheck={false}
                aria-label="Endpoint de transcrição (baseUrl)"
                data-testid="stt-base-url"
                placeholder="https://api.groq.com/openai/v1"
                onChange={(e) => setStt({ ...stt, api: { ...stt.api, baseUrl: e.target.value } })}
                onBlur={() => saveSttApi({})}
                className="field h-8 px-2 py-0 font-mono text-[12px]"
              />
            </div>
            <div>
              <Label>Modelo</Label>
              <input
                type="text"
                value={stt.api.model}
                spellCheck={false}
                aria-label="Modelo de transcrição"
                data-testid="stt-model"
                placeholder="whisper-large-v3-turbo"
                onChange={(e) => setStt({ ...stt, api: { ...stt.api, model: e.target.value } })}
                onBlur={() => saveSttApi({})}
                className="field h-8 px-2 py-0 font-mono text-[12px]"
              />
            </div>
            <div className="col-span-2">
              <Label help="Chave do endpoint (header Authorization: Bearer). A máscara da chave salva aparece no campo vazio; cole uma chave nova e clique em Salvar para trocar, ou em Remover (X) para apagar.">
                Chave de API
              </Label>
              <ProviderKeyChoice
                providers={providers}
                value={stt.api.providerId}
                testId="stt-provider"
                onChange={(providerId) => saveSttApi({ providerId })}
              />
              {sttProvider ? (
                <p className="mt-1 text-[11px] text-subtle" data-testid="stt-provider-key">
                  Usa o endpoint e a chave do provedor “{sttProvider.name}” (no OpenRouter: modelos{' '}
                  <C>openai/whisper-large-v3-turbo</C> ou <C>elevenlabs/scribe-v2</C>).
                </p>
              ) : (
                <ApiKeyField mask={stt.api.apiKey} onSave={saveSttKey} />
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Label
              className="mb-0"
              help="Melhor-esforço enquanto você fala: o texto parcial aparece no composer (fora do texto editável) e a transcrição final entra no rascunho ao parar. No modo API cada parcial é uma request extra ao endpoint; no modo Local elas vêm do motor local."
            >
              Parciais ao vivo
            </Label>
            <Switch
              checked={stt.livePartials}
              label="Parciais ao vivo"
              onChange={(livePartials) => saveStt({ livePartials })}
            />
          </div>
          <LocalEnginePanel
            local={stt.local}
            models={models}
            progress={modelProgress}
            error={modelError}
            onEngine={(engine) =>
              saveStt({
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
            onAction={runModelAction}
            onDismissError={() => setModelError(null)}
            runtimeProblem={
              runtime && stt.local?.installed && !runtime.sttLocal.available
                ? (runtime.sttLocal.reason ?? 'runtime indisponível')
                : null
            }
          />
        </div>
      </section>

      {/* ---- TTS (síntese de fala: API ou motor local Kokoro + clipes) ---- */}
      <section className="border-t border-border pt-4" data-testid="tts-section">
        <div className="mb-3 flex items-baseline gap-2">
          <span className="text-[13px] font-medium text-fg/90">Fala (TTS)</span>
          <HelpTip label="Fala (TTS)">
            <p>
              Síntese de fala para a chamada de voz: um endpoint OpenAI-compatível{' '}
              <code className="font-mono">POST /audio/speech</code> ou o motor local Kokoro (pesos
              ONNX baixados aqui embaixo; a fonemização pt-BR usa o <C>espeak-ng</C> do sistema). A
              chave de API fica no banco local e nunca chega à tela — o campo mostra só a máscara.
            </p>
          </HelpTip>
          <TtsApiInfo tts={tts} />
        </div>
        <div className="space-y-4">
          <div>
            <Label>Backend</Label>
            <Select
              value={tts.backend}
              label="Backend de fala"
              className="h-8 w-full max-w-[360px]"
              menuMinWidth={360}
              onChange={(backend) => saveTts({ backend })}
              options={(['local', 'api'] as TtsSettings['backend'][]).map((b) => ({
                value: b,
                label: TTS_BACKEND_LABELS[b].label,
                description: TTS_BACKEND_LABELS[b].description
              }))}
            />
          </div>
          {!(
            tts.backend === 'api' &&
            tts.api.model === OPENROUTER_TTS_PRESET.model &&
            isOpenRouterUrl(ttsProvider?.baseUrl ?? tts.api.baseUrl)
          ) && (
            <div className="flex flex-wrap items-center gap-2" data-testid="tts-preset">
              <Button
                size="sm"
                variant="secondary"
                data-testid="tts-preset-openrouter"
                onClick={applyOpenRouterTts}
              >
                Usar OpenRouter (ElevenLabs Flash)
              </Button>
              <span className="text-[11px] text-subtle">
                {openRouterProvider
                  ? `fala rápida pela API, com a chave do provedor “${openRouterProvider.name}”`
                  : 'fala rápida pela API — cole a chave do OpenRouter depois de aplicar'}
              </span>
              <HelpTip label="Híbrido rápido">
                <p>
                  Combinação recomendada para a chamada de voz: transcrição <C>híbrida</C> (whisper{' '}
                  <C>base</C> local como reserva) e fala pelo OpenRouter com o ElevenLabs Flash v2.5
                  (~0,5 s até o 1º áudio; o áudio chega em streaming e a frase começa a tocar antes
                  de terminar de baixar). O texto falado vai ao OpenRouter (cobrança por caractere).
                  O Kokoro local continua disponível offline e para os clipes.
                </p>
              </HelpTip>
            </div>
          )}
          {tts.backend === 'api' ? (
            <div className="grid grid-cols-2 gap-x-4 gap-y-3">
              <div>
                <Label>Endpoint (baseUrl)</Label>
                <input
                  type="text"
                  value={ttsProvider ? ttsProvider.baseUrl : tts.api.baseUrl}
                  disabled={!!ttsProvider}
                  title={ttsProvider ? `Endpoint do provedor “${ttsProvider.name}”` : undefined}
                  spellCheck={false}
                  aria-label="Endpoint de síntese de fala (baseUrl)"
                  data-testid="tts-base-url"
                  placeholder="https://api.openai.com/v1"
                  onChange={(e) => setTts({ ...tts, api: { ...tts.api, baseUrl: e.target.value } })}
                  onBlur={() => saveTtsApi({})}
                  className="field h-8 px-2 py-0 font-mono text-[12px]"
                />
              </div>
              <div>
                <Label>Modelo</Label>
                <input
                  type="text"
                  value={tts.api.model}
                  spellCheck={false}
                  aria-label="Modelo de síntese de fala"
                  data-testid="tts-model"
                  placeholder="gpt-4o-mini-tts"
                  onChange={(e) => setTts({ ...tts, api: { ...tts.api, model: e.target.value } })}
                  onBlur={() => saveTtsApi({})}
                  className="field h-8 px-2 py-0 font-mono text-[12px]"
                />
              </div>
              <div>
                <Label help="Voz pedida à API (campo livre; as sugestões abaixo são as vozes comuns dos endpoints OpenAI-compatíveis). Vazio = a voz padrão da API.">
                  Voz
                </Label>
                <input
                  type="text"
                  list="tts-api-voices"
                  value={tts.api.voice ?? ''}
                  spellCheck={false}
                  aria-label="Voz da síntese de fala"
                  data-testid="tts-voice"
                  placeholder="alloy"
                  onChange={(e) => setTts({ ...tts, api: { ...tts.api, voice: e.target.value } })}
                  onBlur={() => saveTtsApi({ voice: tts.api.voice?.trim() ? tts.api.voice : null })}
                  className="field h-8 px-2 py-0 font-mono text-[12px]"
                />
                <datalist id="tts-api-voices">
                  {(tts.api.model.startsWith('elevenlabs/')
                    ? ELEVENLABS_VOICES
                    : ttsVoices.api.map((v) => v.id)
                  ).map((id) => (
                    <option key={id} value={id} />
                  ))}
                </datalist>
              </div>
              <div>
                <Label help="Chave do endpoint (header Authorization: Bearer). A máscara da chave salva aparece no campo vazio; cole uma chave nova e clique em Salvar para trocar, ou em Remover (X) para apagar.">
                  Chave de API
                </Label>
                <ProviderKeyChoice
                  providers={providers}
                  value={tts.api.providerId}
                  testId="tts-provider"
                  onChange={(providerId) => saveTtsApi({ providerId })}
                />
                {ttsProvider ? (
                  <p className="mt-1 text-[11px] text-subtle" data-testid="tts-provider-key">
                    Usa a chave do provedor “{ttsProvider.name}” (fica no processo principal).
                  </p>
                ) : (
                  <ApiKeyField
                    mask={tts.api.apiKey}
                    onSave={saveTtsKey}
                    what="fala"
                    testId="tts-api-key"
                  />
                )}
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <Label className="mb-0">Motor local</Label>
                <Select
                  value={ttsEngine}
                  label="Motor local de fala"
                  className="h-8 w-[300px]"
                  menuMinWidth={320}
                  onChange={(engine) => {
                    saveTts({
                      local: {
                        engine: engine as TtsLocalEngine,
                        voice: tts.local?.voice ?? '',
                        installed: tts.local?.installed ?? false
                      }
                    })
                    refreshTtsVoices()
                  }}
                  // Chatterbox ainda não sintetiza: só aparece se já estiver salvo (para trocar)
                  options={(ttsEngine === 'chatterbox'
                    ? (['kokoro', 'chatterbox'] as TtsLocalEngine[])
                    : (['kokoro'] as TtsLocalEngine[])
                  ).map((e) => ({
                    value: e,
                    label: TTS_ENGINE_LABELS[e]
                  }))}
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
              {runtime && ttsEngine === 'kokoro' && !runtime.ttsLocal.available && (
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
                  disabled={ttsEngine !== 'kokoro'}
                  onChange={(voice) =>
                    saveTts({
                      local: {
                        engine: tts.local?.engine ?? 'kokoro',
                        voice,
                        installed: tts.local?.installed ?? false
                      }
                    })
                  }
                  options={
                    ttsVoices.local.length
                      ? ttsVoices.local.map((v) => ({
                          value: v.id,
                          label: v.installed
                            ? `${v.label} — instalada`
                            : `${v.label} — baixar abaixo`
                        }))
                      : [{ value: 'pf_dora', label: 'pf_dora (padrão)' }]
                  }
                />
                {ttsEngine !== 'kokoro' && (
                  <p
                    className="mt-1.5 flex items-center gap-1 text-[11px] text-warning"
                    role="alert"
                  >
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
              disabled={ttsTest.state === 'busy'}
              icon={
                ttsTest.state === 'playing' ? (
                  <Square className="size-3" fill="currentColor" />
                ) : (
                  <Play className="size-3.5" />
                )
              }
              onClick={runTtsTest}
            >
              {ttsTest.state === 'busy'
                ? 'Sintetizando…'
                : ttsTest.state === 'playing'
                  ? 'Parar teste'
                  : 'Testar voz'}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              data-testid="tts-clips-generate"
              disabled={ttsClips.busy}
              onClick={runTtsClips}
            >
              Gerar clipes de voz
            </Button>
            <HelpTip label="Clipes de voz">
              <p>
                Os clipes (interjeições e falas de espera da chamada de voz) são gerados com a voz
                escolhida e ficam em cache em <C>userData/voice-clips</C>, um cache por voz. Ao
                trocar a voz, gere de novo — sem clipes, interjeições e falas de espera não tocam.
              </p>
            </HelpTip>
            {ttsClips.busy && (
              <span
                className="text-[11px] text-subtle tabular-nums"
                data-testid="tts-clips-progress"
              >
                gerando clipes… {ttsClips.done}/{ttsClips.total || '…'}
              </span>
            )}
            {!ttsClips.busy && ttsClips.count !== null && ttsClips.count > 0 && (
              <span className="text-[11px] text-subtle" data-testid="tts-clips-count">
                {ttsClips.count} clipes gerados para a voz atual
              </span>
            )}
            {!ttsClips.busy && ttsClips.count === 0 && (
              <span className="text-[11px] text-warning" data-testid="tts-clips-missing">
                sem clipes para a voz atual
              </span>
            )}
          </div>
          {ttsTest.error && (
            <div
              role="alert"
              data-testid="tts-error"
              className="flex items-center gap-2 rounded-lg border border-danger/30 bg-danger/[0.06] px-2.5 py-1.5 text-[12px] text-danger"
            >
              <TriangleAlert className="size-3.5 shrink-0" />
              <span className="min-w-0 flex-1">{ttsTest.error}</span>
              <button
                type="button"
                aria-label="Dispensar erro de síntese de fala"
                onClick={() => setTtsTest((s) => ({ ...s, error: null }))}
                className="shrink-0 rounded-md p-1 transition-colors hover:bg-danger/15"
              >
                <X className="size-3.5" />
              </button>
            </div>
          )}
          {ttsClips.error && (
            <div
              role="alert"
              data-testid="tts-clips-error"
              className="flex items-center gap-2 rounded-lg border border-danger/30 bg-danger/[0.06] px-2.5 py-1.5 text-[12px] text-danger"
            >
              <TriangleAlert className="size-3.5 shrink-0" />
              <span className="min-w-0 flex-1">{ttsClips.error}</span>
              <button
                type="button"
                aria-label="Dispensar erro de clipes"
                onClick={() => setTtsClips((c) => ({ ...c, error: null }))}
                className="shrink-0 rounded-md p-1 transition-colors hover:bg-danger/15"
              >
                <X className="size-3.5" />
              </button>
            </div>
          )}
          <LocalModelList
            kind="tts"
            models={models}
            progress={modelProgress}
            onAction={runModelAction}
          />
        </div>
      </section>

      {/* ---- chamada de voz: disponível + silêncio do turno (padrões globais) ---- */}
      <section className="border-t border-border pt-4" data-testid="voice-call-settings">
        <div className="mb-3 flex items-baseline gap-2">
          <span className="text-[13px] font-medium text-fg/90">Chamada de voz</span>
          <HelpTip label="Chamada de voz">
            <p>
              Conversa falada com o agente (botão de telefone no composer): você fala, o silêncio
              encerra a sua vez, a fala vira mensagem do chat e a resposta é falada. Estes são os
              padrões GLOBAIS — cada persona/chat pode ligar/desligar a chamada e ter modelo, tools
              e prompt próprios (painel do chat → aba Chat → Chamada de voz).
            </p>
            <p className="mt-2">
              Precisa da transcrição (STT) e da fala (TTS) configuradas acima; o que faltar é
              avisado ao tentar entrar na chamada.
            </p>
          </HelpTip>
        </div>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
          <div className="flex items-center gap-2">
            <Label
              className="mb-0"
              help="Desligada, o botão de telefone some de todos os chats (exceto os que ligam a chamada explicitamente na própria config)."
            >
              Chamada de voz disponível
            </Label>
            <Switch
              checked={callDefaults.enabled}
              label="Chamada de voz disponível"
              onChange={(enabled) => saveCallDefaults({ enabled })}
            />
          </div>
          <div className="flex items-center gap-2">
            <Label
              className="mb-0"
              help={`Silêncio contínuo (ms) que encerra a SUA vez de falar quando não há transcrição especulativa (fim de turno adaptativo desligado, ou STT só por API sem especulação) — padrão ${DEFAULT_TURN_SILENCE_MS} ms. Independente do "Parar por silêncio" do ditado.`}
            >
              Silêncio que encerra a fala (ms)
            </Label>
            <NumberField
              value={callDefaults.turn.silenceStopMs ?? DEFAULT_TURN_SILENCE_MS}
              min={200}
              max={10000}
              step={100}
              label="Silêncio que encerra a fala na chamada (ms)"
              testId="voice-call-turn-silence"
              onCommit={(v) =>
                saveCallDefaults({
                  // o padrão volta a ser "segue o padrão" (null) — muda junto se o padrão mudar
                  turn: {
                    ...callDefaults.turn,
                    silenceStopMs: v === DEFAULT_TURN_SILENCE_MS ? null : v
                  }
                })
              }
            />
          </div>
          <div className="flex items-center gap-2">
            <Label
              className="mb-0"
              help='Aos ~250 ms de pausa o app transcreve o que você já disse (motor local) e decide: pergunta/comando fecha a vez rápido; frase que termina em vírgula, "e", "mas", "porque"… espera mais. Se você não voltar a falar, essa transcrição já é a final.'
            >
              Fim de turno adaptativo
            </Label>
            <Switch
              checked={callDefaults.turn.adaptive}
              label="Fim de turno adaptativo"
              onChange={(adaptive) =>
                saveCallDefaults({ turn: { ...callDefaults.turn, adaptive } })
              }
            />
          </div>
          <div className="flex items-center gap-2">
            <Label
              className="mb-0"
              help="Permite a transcrição especulativa pela API quando não há motor local (1 request a mais por pausa — custo)."
            >
              Especular pela API
            </Label>
            <Switch
              checked={callDefaults.turn.speculativeApi}
              label="Especular pela API"
              onChange={(speculativeApi) =>
                saveCallDefaults({ turn: { ...callDefaults.turn, speculativeApi } })
              }
            />
          </div>
        </div>
        <div className="mt-3 grid grid-cols-3 gap-x-4 gap-y-3 sm:max-w-[560px]">
          <div>
            <Label help='Silêncio (ms) que fecha uma fala completa: pergunta, comando ou fecho ("obrigado").'>
              Fala completa (ms)
            </Label>
            <NumberField
              value={callDefaults.turn.completeSilenceMs}
              min={200}
              max={5000}
              step={50}
              label="Silêncio para fala completa (ms)"
              testId="voice-call-turn-complete"
              onCommit={(v) =>
                saveCallDefaults({ turn: { ...callDefaults.turn, completeSilenceMs: v } })
              }
            />
          </div>
          <div>
            <Label help="Silêncio (ms) que fecha uma afirmação (o ponto final do STT não prova que você terminou — pode ser uma história no meio).">
              Afirmação (ms)
            </Label>
            <NumberField
              value={callDefaults.turn.statementSilenceMs}
              min={200}
              max={10000}
              step={50}
              label="Silêncio para afirmação (ms)"
              testId="voice-call-turn-statement"
              onCommit={(v) =>
                saveCallDefaults({ turn: { ...callDefaults.turn, statementSilenceMs: v } })
              }
            />
          </div>
          <div>
            <Label help="Silêncio (ms) que fecha uma fala inacabada (termina em vírgula, conectivo ou hesitação) — o teto.">
              Fala inacabada (ms)
            </Label>
            <NumberField
              value={callDefaults.turn.unfinishedSilenceMs}
              min={200}
              max={10000}
              step={50}
              label="Silêncio para fala inacabada (ms)"
              testId="voice-call-turn-unfinished"
              onCommit={(v) =>
                saveCallDefaults({ turn: { ...callDefaults.turn, unfinishedSilenceMs: v } })
              }
            />
          </div>
          <div>
            <Label help="Teto de tokens da resposta nos turnos de voz (respostas curtas, fala começa antes). 0 = sem teto. Não vale quando o modelo da chamada define max_tokens ou raciocínio.">
              Teto de tokens
            </Label>
            <NumberField
              value={callDefaults.maxTokens}
              min={0}
              max={8000}
              step={10}
              label="Teto de tokens da resposta na chamada"
              testId="voice-call-max-tokens"
              onCommit={(v) => saveCallDefaults({ maxTokens: v })}
            />
          </div>
          <div>
            <Label help='Espera (ms) entre o fim da sua fala e o preâmbulo ("Hum, deixa eu ver…"). Se a 1ª frase da resposta ficar pronta antes, o preâmbulo nem sai. 0 = já.'>
              Preâmbulo após (ms)
            </Label>
            <NumberField
              value={callDefaults.fillers.delayMs}
              min={0}
              max={5000}
              step={50}
              label="Espera do preâmbulo (ms)"
              testId="voice-call-filler-delay"
              onCommit={(v) =>
                saveCallDefaults({ fillers: { ...callDefaults.fillers, delayMs: v } })
              }
            />
          </div>
        </div>
      </section>

      {/* ---- chamada de voz: atos de fala curta (interjeições/fillers) ---- */}
      <section className="border-t border-border pt-4" data-testid="voice-acts-settings">
        <div className="mb-3 flex items-baseline gap-2">
          <span className="text-[13px] font-medium text-fg/90">
            Chamada de voz — interjeições e fillers
          </span>
          <HelpTip label="Interjeições e fillers da chamada de voz">
            <p>
              Atos de fala curta da chamada de voz, decididos por regras simples (sem classificador
              treinado). Estes são os padrões GLOBAIS — persona/chat podem sobrescrever (★ do painel
              da chamada).
            </p>
            <p className="mt-2">
              Interjeições entram nas pausas da sua fala (clipe curto tipo &quot;uhum&quot;); o
              filler toca quando a resposta demora a começar. Em modo sombra nada toca: as decisões
              só são registradas em <code className="font-mono">voice-eval/</code> para calibração.
            </p>
          </HelpTip>
        </div>
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
            <div className="flex items-center gap-2">
              <Label
                className="mb-0"
                help="Interjeições durante a sua fala (só em pausas, com cooldown; nunca sobre a fala do assistente)."
              >
                Interjeições
              </Label>
              <Switch
                checked={callDefaults.interjections.enabled}
                label="Interjeições"
                onChange={(v) =>
                  saveCallDefaults({
                    interjections: { ...callDefaults.interjections, enabled: v }
                  })
                }
              />
            </div>
            <div className="flex items-center gap-2">
              <Label
                className="mb-0"
                help="Modo sombra: o motor decide mas NÃO toca — as decisões ficam no log de avaliação (voice-eval) para calibração. Vale para interjeições E fillers."
              >
                Modo sombra
              </Label>
              <Switch
                checked={callDefaults.interjections.shadow}
                label="Modo sombra"
                onChange={(v) =>
                  saveCallDefaults({
                    interjections: { ...callDefaults.interjections, shadow: v }
                  })
                }
              />
            </div>
            <div className="flex items-center gap-2">
              <Label
                className="mb-0"
                help={
                  'Preâmbulo curto logo depois da sua fala ("Hum, deixa eu ver aqui.", "Beleza, só um minutinho.") escolhido pelo tipo de pedido, enquanto a resposta não começa. No máximo 1 por turno; a resposta espera ele terminar.'
                }
              >
                Fillers
              </Label>
              <Switch
                checked={callDefaults.fillers.enabled}
                label="Fillers"
                onChange={(v) =>
                  saveCallDefaults({ fillers: { ...callDefaults.fillers, enabled: v } })
                }
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:max-w-[560px]">
            <div>
              <Label help="Intervalo mínimo entre interjeições (ms).">
                Cooldown entre interjeições (ms)
              </Label>
              <NumberField
                value={callDefaults.interjections.cooldownMs}
                min={0}
                step={100}
                label="Cooldown entre interjeições (ms)"
                testId="voice-interjection-cooldown"
                onCommit={(v) =>
                  saveCallDefaults({
                    interjections: { ...callDefaults.interjections, cooldownMs: v }
                  })
                }
              />
            </div>
            <div>
              <Label help="Probabilidade de a interjeição sair quando as regras deixam (0–1; 0 = nunca, 1 = sempre).">
                Probabilidade de disparo (0–1)
              </Label>
              <NumberField
                value={callDefaults.interjections.fireProbability}
                min={0}
                max={1}
                step={0.05}
                label="Probabilidade de disparo (0 a 1)"
                testId="voice-interjection-probability"
                onCommit={(v) =>
                  saveCallDefaults({
                    interjections: { ...callDefaults.interjections, fireProbability: v }
                  })
                }
              />
            </div>
            <div>
              <Label help="Sua fala acumulada (ms) antes de uma interjeição poder sair.">
                Fala mínima (ms)
              </Label>
              <NumberField
                value={callDefaults.interjections.minSpeechMs}
                min={0}
                step={100}
                label="Fala mínima para interjeição (ms)"
                testId="voice-interjection-min-speech"
                onCommit={(v) =>
                  saveCallDefaults({
                    interjections: { ...callDefaults.interjections, minSpeechMs: v }
                  })
                }
              />
            </div>
            <div>
              <Label help="Sua pausa contínua (ms) em que a interjeição pode entrar.">
                Pausa mínima (ms)
              </Label>
              <NumberField
                value={callDefaults.interjections.minPauseMs}
                min={0}
                step={50}
                label="Pausa mínima para interjeição (ms)"
                testId="voice-interjection-min-pause"
                onCommit={(v) =>
                  saveCallDefaults({
                    interjections: { ...callDefaults.interjections, minPauseMs: v }
                  })
                }
              />
            </div>
          </div>

          <div>
            <Label
              help={
                "Tipos de interjeição que podem sair (os clipes vêm de 'Gerar clipes de voz' acima). Nenhum marcado = todos.\nO tipo vem do fim da transcrição parcial: pergunta evita 'Pensando'; negação/incerteza não interjeita; sem confiança sai 'Confirmação'."
              }
            >
              Interjeições permitidas
            </Label>
            <div
              className="flex flex-wrap items-center gap-3"
              data-testid="voice-interjection-classes"
            >
              {INTERJECTION_CLASSES.map((cls) => {
                const checked = callDefaults.interjections.classes.includes(cls)
                return (
                  <label
                    key={cls}
                    title={`${cls} — ex.: ${INTERJECTION_LABELS[cls].example}`}
                    className="flex cursor-pointer items-center gap-1.5 text-[12px]"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      aria-label={`Interjeição: ${INTERJECTION_LABELS[cls].label}`}
                      data-class={cls}
                      onChange={() => {
                        const classes = checked
                          ? callDefaults.interjections.classes.filter((c) => c !== cls)
                          : [...callDefaults.interjections.classes, cls]
                        saveCallDefaults({
                          interjections: {
                            ...callDefaults.interjections,
                            classes: INTERJECTION_CLASSES.filter((c) =>
                              classes.includes(c as InterjectionClass)
                            ) as InterjectionClass[]
                          }
                        })
                      }}
                      className="size-3.5 accent-accent-strong"
                    />
                    {INTERJECTION_LABELS[cls].label}
                    <span className="text-[10.5px] text-faint">
                      {INTERJECTION_LABELS[cls].example}
                    </span>
                  </label>
                )
              })}
            </div>
          </div>
          {/* `fillers.prompt` ainda não é consumido (a decisão é por regra): campo escondido até ser */}
        </div>
      </section>
    </div>
  )
}

/**
 * Reproduz o áudio sintetizado (bytes → blob → `<audio>`); falhas viram mensagem legível. Devolve o
 * elemento + blob URL para o chamador poder PARAR (botão "Parar teste" ou o modal fechando).
 */
function playTtsAudio(
  r: TtsSynthResult,
  onEnd: () => void,
  onError: (msg: string) => void
): { el: HTMLAudioElement; url: string } | null {
  try {
    // cópia: `Uint8Array<ArrayBuffer>` satisfaz `BlobPart` em qualquer origem do buffer
    const blob = new Blob([new Uint8Array(r.audio)], { type: r.mime })
    const url = URL.createObjectURL(blob)
    const el = new Audio(url)
    el.onended = (): void => {
      URL.revokeObjectURL(url)
      onEnd()
    }
    el.onerror = (): void => {
      URL.revokeObjectURL(url)
      onError('não foi possível reproduzir o áudio sintetizado')
    }
    void el.play().catch((e: unknown) => {
      URL.revokeObjectURL(url)
      // pausa do "Parar teste" antes de começar não é erro
      if ((e as { name?: string })?.name === 'AbortError') return
      onError(errorMessage(e))
    })
    return { el, url }
  } catch (e) {
    onError(errorMessage(e))
    return null
  }
}

/**
 * Campo da chave (padrão de `WebSearchSettings`): começa VAZIO com a máscara da chave salva no
 * placeholder; colar uma chave mostra "Salvar" (Enter também salva); com chave salva e campo vazio,
 * X remove. Limpar o campo nunca apaga nada. O olho mostra/oculta só o que foi digitado — a chave
 * real não sai do main.
 */
function ApiKeyField({
  mask,
  onSave,
  what = 'transcrição',
  testId = 'stt-api-key'
}: {
  mask: string
  /** `null` remove; string = chave nova. Resolve `true` quando gravou. */
  onSave: (key: string | null) => Promise<boolean>
  /** Rótulo do domínio (transcrição/fala) nos textos de aria/placeholder. */
  what?: string
  /** `data-testid` do campo (STT usa o padrão; TTS usa 'tts-api-key'). */
  testId?: string
}): React.JSX.Element {
  const [value, setValue] = useState('')
  const [show, setShow] = useState(false)
  const [busy, setBusy] = useState(false)
  const dirty = value.trim() !== ''
  const save = async (key: string | null): Promise<void> => {
    setBusy(true)
    const ok = await onSave(key)
    setBusy(false)
    if (ok) {
      setValue('')
      setShow(false)
    }
  }
  return (
    <div className="flex items-center gap-1.5">
      <div className="relative min-w-0 flex-1">
        <KeyRound className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-faint" />
        <input
          type={show ? 'text' : 'password'}
          value={value}
          spellCheck={false}
          autoComplete="off"
          aria-label={`Chave de API (${what})`}
          data-testid={testId}
          placeholder={mask ? `${mask} — digite para trocar` : `Cole a chave da API de ${what}`}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && dirty) {
              e.preventDefault()
              void save(value.trim())
            }
          }}
          className="field h-8 w-full py-0 pr-9 pl-7 font-mono text-[12px] placeholder:font-mono"
        />
        <button
          type="button"
          onClick={() => setShow((v) => !v)}
          disabled={!value}
          aria-label={show ? 'Ocultar chave digitada' : 'Mostrar chave digitada'}
          className="absolute top-1/2 right-1.5 -translate-y-1/2 rounded-md p-1.5 text-subtle hover:bg-hover hover:text-fg disabled:opacity-40"
        >
          {show ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
        </button>
      </div>
      {dirty && (
        <Button
          size="sm"
          variant="primary"
          loading={busy}
          data-testid={`${testId}-save`}
          onClick={() => void save(value.trim())}
        >
          Salvar
        </Button>
      )}
      {mask && !dirty && (
        <IconButton
          size="sm"
          label="Remover chave"
          aria-label={`Remover chave (${what})`}
          data-testid={`${testId}-remove`}
          onClick={() => void save(null)}
        >
          <X />
        </IconButton>
      )}
    </div>
  )
}

/** `</>` da transcrição: a request multipart exata do `/audio/transcriptions`. */
/**
 * "Chave de": endpoint avulso (chave própria, campo abaixo) ou um provedor salvo — com provedor, o
 * main usa o endpoint e a chave dele (`providerId`); a chave nunca passa pela tela.
 */
function ProviderKeyChoice({
  providers,
  value,
  onChange,
  testId
}: {
  providers: ProviderOption[]
  value: string | null
  onChange: (providerId: string | null) => void
  testId: string
}): React.JSX.Element | null {
  if (!providers.length && !value) return null
  const known = providers.some((p) => p.id === value)
  return (
    <div className="mb-1.5" data-testid={testId}>
      <Select
        value={value && known ? value : ''}
        label="Origem da chave"
        className="h-8 w-full max-w-[360px]"
        menuMinWidth={320}
        onChange={(v) => onChange(v ? v : null)}
        options={[
          { value: '', label: 'Chave própria (campo abaixo)' },
          ...providers.map((p) => ({
            value: p.id,
            label: `Provedor: ${p.name}`,
            description: p.baseUrl
          }))
        ]}
      />
      {value && !known && (
        <p className="mt-1 text-[11px] text-warning" role="alert">
          O provedor escolhido não existe mais — usando o endpoint e a chave próprios.
        </p>
      )}
    </div>
  )
}

function SttApiInfo({ stt, language }: { stt: SttSettings; language: string }): React.JSX.Element {
  const lang = language.split(/[-_]/)[0]?.toLowerCase() || language
  return (
    <ApiInfo
      title="Transcrição: request de cada gravação (e das parciais)"
      code={[
        `POST ${stt.api.baseUrl.replace(/\/+$/, '')}/audio/transcriptions`,
        'Authorization: Bearer {sua chave}',
        'Content-Type: multipart/form-data',
        '',
        'file            = audio.wav (PCM16 mono 16 kHz — o áudio gravado)',
        `model           = ${stt.api.model}`,
        `language        = ${lang}`,
        'response_format = json'
      ].join('\n')}
      codeLabel="Modos API e Híbrido (a chave salva entra no lugar de {sua chave})"
    >
      <p>
        Só o áudio gravado e esses campos saem do app. Com <C>Parciais ao vivo</C> ligado, o mesmo
        request é repetido em janelas enquanto você fala (melhor-esforço); a transcrição final manda
        o áudio inteiro. No modo <C>Local</C> nada sai do computador.
      </p>
    </ApiInfo>
  )
}

/** `</>` da fala: o JSON exato do `/audio/speech` (backend API). */
function TtsApiInfo({ tts }: { tts: TtsSettings }): React.JSX.Element {
  if (tts.backend === 'local')
    return (
      <ApiInfo title="Fala local (Kokoro)">
        <p>
          Nada sai do computador: o texto de cada frase da resposta é fonemizado pelo{' '}
          <C>espeak-ng</C> do sistema e sintetizado pelo Kokoro (ONNX) localmente.
        </p>
      </ApiInfo>
    )
  const body: Record<string, string> = {
    model: tts.api.model || '{modelo}',
    ...(tts.api.voice ? { voice: tts.api.voice } : {}),
    input: '{frase da resposta}',
    response_format: 'wav'
  }
  return (
    <ApiInfo
      title="Fala: request de cada frase falada"
      code={[
        `POST ${(tts.api.baseUrl || '{endpoint}').replace(/\/+$/, '')}/audio/speech`,
        'Authorization: Bearer {sua chave}',
        'Content-Type: application/json',
        '',
        JSON.stringify(body, null, 2)
      ].join('\n')}
      codeLabel="Uma request por frase da resposta (e por clipe ao gerar os clipes de voz)"
    >
      <p>
        Sai só o texto de cada frase falada (a resposta do agente é dividida em frases). Sem voz
        definida, o campo <C>voice</C> é omitido e vale a voz padrão da API.
      </p>
    </ApiInfo>
  )
}

/** Campo dos ms de silêncio: rascunho enquanto edita, commit no blur/Enter (0 = sem limite). */
function SilenceMsField({
  value,
  disabled,
  onCommit
}: {
  value: number
  disabled?: boolean
  onCommit: (ms: number) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState<string | null>(null)
  const text = draft ?? String(value)
  const commit = (): void => {
    const n = Math.round(Number(text))
    const v = Number.isFinite(n) && text.trim() ? Math.max(0, n) : value
    setDraft(null)
    if (v !== value) onCommit(v)
  }
  return (
    <input
      type="number"
      min={0}
      step={100}
      value={text}
      disabled={disabled}
      aria-label="Silêncio que encerra a gravação (ms)"
      data-testid="silence-stop-ms"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && commit()}
      className="field h-8 w-[110px] px-2 py-0 text-right font-mono text-[12.5px] tabular-nums disabled:opacity-50"
    />
  )
}

/** Campo numérico genérico com commit no blur/Enter (mesmo padrão do `SilenceMsField`). */
function NumberField({
  value,
  min,
  max,
  step,
  label,
  testId,
  onCommit
}: {
  value: number
  min: number
  max?: number
  step: number
  label: string
  testId: string
  onCommit: (v: number) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState<string | null>(null)
  const text = draft ?? String(value)
  const commit = (): void => {
    const n = Number(text)
    let v = Number.isFinite(n) && text.trim() ? n : value
    v = Math.max(min, max != null ? Math.min(max, v) : v)
    setDraft(null)
    if (v !== value) onCommit(v)
  }
  return (
    <input
      type="number"
      min={min}
      max={max}
      step={step}
      value={text}
      aria-label={label}
      data-testid={testId}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && commit()}
      className="field h-8 w-[110px] px-2 py-0 text-right font-mono text-[12.5px] tabular-nums"
    />
  )
}

/**
 * Motor local de STT: seletor de engine + status (espelho de `sttSettings.local.installed`) e a
 * lista dos modelos do catálogo por engine com download/remoção reais (progresso, estados e avisos
 * de `modelAction`). Erros de download/remoção viram aviso legível no painel.
 */
export function LocalEnginePanel({
  local,
  models,
  progress,
  error,
  onEngine,
  onAction,
  onDismissError,
  runtimeProblem
}: {
  local: SttLocalConfig | null
  models: VoiceModelInfo[]
  progress: Record<string, { bytes: number; total: number }>
  error: string | null
  onEngine?: (engine: SttLocalConfig['engine']) => void
  onAction: (model: VoiceModelInfo, action: LocalModelAction['action']) => void
  onDismissError: () => void
  /** Modelo instalado mas o runtime não carrega (probe do main) — motivo legível. */
  runtimeProblem?: string | null
}): React.JSX.Element {
  const engine = local?.engine ?? 'whisper.cpp'
  return (
    <div
      className="rounded-xl border border-border bg-elevated/30 px-3 py-2.5"
      data-testid="stt-local-engine"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Label
          className="mb-0"
          help="Transcrição no próprio computador (modos Local e Híbrido) com o whisper.cpp — baixe um modelo abaixo. Os arquivos ficam em userData/models (verificados por tamanho, magic bytes e sha256)."
        >
          Motor local
        </Label>
        {onEngine ? (
          <Select
            value={engine}
            label="Motor local de transcrição"
            className="h-8 w-[160px]"
            menuMinWidth={220}
            onChange={(v) => onEngine(v as SttLocalConfig['engine'])}
            options={[
              { value: 'whisper.cpp', label: 'whisper.cpp' },
              { value: 'vosk', label: 'vosk' },
              { value: 'nemotron', label: 'nemotron' }
            ]}
          />
        ) : (
          <span className="font-mono text-[12px] text-muted">{engine}</span>
        )}
        <span
          className={`rounded-full border px-1.5 py-px text-[10px] leading-4 ${
            local?.installed ? 'border-success/30 text-success' : 'border-warning/30 text-warning'
          }`}
        >
          {local?.installed ? 'instalado' : 'não instalado'}
        </span>
      </div>
      {runtimeProblem && (
        <p
          className="mt-2 flex items-start gap-1 text-[11px] text-warning"
          role="alert"
          data-testid="stt-runtime-warning"
        >
          <TriangleAlert className="mt-0.5 size-3 shrink-0" /> Motor local não está pronto:{' '}
          {runtimeProblem}
        </p>
      )}
      <ModelError error={error} onDismiss={onDismissError} />
      <LocalModelList kind="stt" models={models} progress={progress} onAction={onAction} />
    </div>
  )
}

/** Lista dos modelos locais agrupados por engine (nome, descrição, idiomas, tamanho). */
function LocalModelList({
  kind,
  models,
  progress,
  onAction
}: {
  kind: VoiceModelInfo['kind']
  models: VoiceModelInfo[]
  progress: Record<string, { bytes: number; total: number }>
  onAction: (model: VoiceModelInfo, action: LocalModelAction['action']) => void
}): React.JSX.Element | null {
  // Chatterbox ainda não sintetiza: os pesos só aparecem se já estiverem em disco (para remover)
  const items = models.filter(
    (m) => m.kind === kind && (m.engine !== 'chatterbox' || m.state !== 'notInstalled')
  )
  if (!items.length) return null
  const groups: { engine: string; items: VoiceModelInfo[] }[] = []
  for (const m of items) {
    const g = groups.find((x) => x.engine === m.engine)
    if (g) g.items.push(m)
    else groups.push({ engine: m.engine, items: [m] })
  }
  return (
    <div className="mt-2 space-y-2.5">
      {groups.map((g) => (
        <div key={g.engine} data-testid={`voice-models-${g.engine}`}>
          <div className="mb-1 font-mono text-[10px] tracking-wide text-faint uppercase">
            {g.engine}
          </div>
          <div className="space-y-1.5">
            {g.items.map((m) => (
              <ModelRow key={m.id} model={m} progress={progress[m.id]} onAction={onAction} />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

/** Linha de um modelo local: nome/descrição/idiomas/tamanho + estado, ação e progresso. */
function ModelRow({
  model,
  progress,
  onAction
}: {
  model: VoiceModelInfo
  progress?: { bytes: number; total: number }
  onAction: (model: VoiceModelInfo, action: LocalModelAction['action']) => void
}): React.JSX.Element {
  const a = modelAction(model.state, model.hasDownload)
  const total = progress?.total || model.sizeBytes || 1
  const pct = progress ? Math.max(0, Math.min(100, Math.round((progress.bytes / total) * 100))) : 0
  return (
    <div
      className="rounded-lg border border-border/70 bg-elevated/20 px-2.5 py-2"
      data-testid={`voice-model-${model.id}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[12px] font-medium text-fg/90">{model.name}</span>
        <span
          className={`rounded-full border px-1.5 py-px text-[10px] leading-4 ${
            model.state === 'installed'
              ? 'border-success/30 text-success'
              : model.state === 'corrupt'
                ? 'border-danger/30 text-danger'
                : 'border-warning/30 text-warning'
          }`}
        >
          {a.badge}
        </span>
        {model.state === 'installed' && (
          <span className="inline-flex items-center gap-1 text-[11px] text-success">
            <Check className="size-3" />
            {formatModelSize(model.installedBytes ?? model.sizeBytes)}
          </span>
        )}
        <span className="ml-auto flex items-center gap-1.5">
          {a.action ? (
            <Button
              size="sm"
              variant={a.action === 'remove' ? 'ghost' : 'secondary'}
              data-testid={`voice-model-action-${model.id}`}
              icon={
                a.action === 'remove' ? (
                  <X className="size-3.5" />
                ) : a.action === 'cancel' ? (
                  <X className="size-3.5" />
                ) : (
                  <Download className="size-3.5" />
                )
              }
              onClick={() => onAction(model, a.action)}
            >
              {a.label}
            </Button>
          ) : (
            <>
              <Button size="sm" variant="secondary" disabled>
                {a.label}
              </Button>
              <span className="text-[10px] text-subtle">download indisponível</span>
            </>
          )}
        </span>
      </div>
      <p className="mt-1 text-[11px] leading-relaxed text-subtle">{model.description}</p>
      <p className="text-[10.5px] text-faint">
        {formatModelLanguages(model.languages)}
        {model.sizeBytes > 0 ? ` · ${formatModelSize(model.sizeBytes)}` : ' · tamanho desconhecido'}
      </p>
      {model.state === 'downloading' && (
        <div className="mt-1.5">
          <div
            className="h-1.5 overflow-hidden rounded-full bg-elevated"
            role="progressbar"
            aria-label={`Download de ${model.name}`}
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
            data-testid={`voice-model-progress-${model.id}`}
          >
            <div
              className="h-full rounded-full bg-accent transition-[width] duration-150"
              style={{ width: `${pct}%` }}
            />
          </div>
          <p className="mt-0.5 text-[10.5px] text-subtle tabular-nums">
            {formatModelSize(progress?.bytes ?? 0)} / {formatModelSize(total)} ({pct}%)
          </p>
        </div>
      )}
      {a.warning && (
        <p
          className="mt-1 flex items-center gap-1 text-[11px] text-warning"
          role="alert"
          data-testid={`voice-model-warning-${model.id}`}
        >
          <TriangleAlert className="size-3 shrink-0" /> {a.warning}
        </p>
      )}
    </div>
  )
}

/** Erro de download/remoção de modelo (padrão dos avisos do composer) com X para dispensar. */
function ModelError({
  error,
  onDismiss
}: {
  error: string | null
  onDismiss: () => void
}): React.JSX.Element | null {
  if (!error) return null
  return (
    <div
      role="alert"
      data-testid="voice-model-error"
      className="mt-2 flex items-center gap-2 rounded-lg border border-danger/30 bg-danger/[0.06] px-2.5 py-1.5 text-[12px] text-danger"
    >
      <TriangleAlert className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1">{error}</span>
      <button
        type="button"
        aria-label="Dispensar erro de modelos locais"
        onClick={onDismiss}
        className="shrink-0 rounded-md p-1 transition-colors hover:bg-danger/15"
      >
        <X className="size-3.5" />
      </button>
    </div>
  )
}

/**
 * Captura da tecla do push-to-talk: mostra a atual e grava a próxima pressionada. Esc cancela SÓ a
 * captura (camada própria na pilha de Esc — o modal de Configurações continua aberto). Tecla que
 * não vale como PTT (`pttHotkeyProblem`: digitaria texto) é recusada com o motivo, e a captura
 * continua esperando.
 */
function KeyCaptureField({
  value,
  onChange
}: {
  value: string | null
  onChange: (v: string) => void
}): React.JSX.Element {
  const [capturing, setCapturing] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  useEscapeLayer(capturing, () => {
    setCapturing(false)
    setProblem(null)
  })
  useEffect(() => {
    if (!capturing) return
    const onKey = (e: KeyboardEvent): void => {
      // Esc é da camada de Esc (fecha só a captura)
      if (e.key === 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      const hotkey = hotkeyFromEvent(e)
      if (!hotkey) return
      const why = pttHotkeyProblem(hotkey)
      if (why) {
        setProblem(`${formatHotkeyLabel(hotkey)}: ${why}`)
        return
      }
      setProblem(null)
      onChange(hotkey)
      setCapturing(false)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [capturing, onChange])
  return (
    <>
      <Button
        size="sm"
        variant={capturing ? 'primary' : 'secondary'}
        data-testid="ptt-key-capture"
        onClick={() => {
          setProblem(null)
          setCapturing((c) => !c)
        }}
      >
        {capturing ? 'Pressione a tecla… (Esc cancela)' : value ? 'Alterar tecla' : 'Definir tecla'}
      </Button>
      {problem && (
        <span
          role="alert"
          data-testid="ptt-key-problem"
          className="basis-full text-[11px] leading-snug text-warning"
        >
          {problem}
        </span>
      )}
    </>
  )
}
