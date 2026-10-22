// Configurações → Áudio: ditado por voz (microfone padrão, push-to-talk com captura de tecla,
// auto-stop por silêncio, idioma), transcrição (STT — modo, endpoint de API com chave mascarada,
// motor local com download real dos modelos, parciais ao vivo) e fala (TTS — backend API/local,
// endpoint com chave mascarada, vozes do Kokoro, "Testar voz" e geração dos clipes de
// interjeição/filler; os pesos do motor baixam pela mesma lista de modelos locais). Espelha o
// padrão de "Pesquisa na web" (`WebSearchSettings.tsx`): cada controle grava na hora via
// `voice:settings:set`; as chaves de API são ECOADAS mascaradas nos campos — escrever por cima da
// máscara preserva a chave real (contrato do main, testado em `e2e/voiceSettings.test.ts`).
import { Check, Download, KeyRound, Play, TriangleAlert, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { TtsSynthResult, TtsVoicesView, VoiceModelInfo } from '@shared/ipc'
import type {
  SttLocalConfig,
  SttMode,
  SttSettings,
  TtsLocalEngine,
  TtsSettings
} from '@shared/voice'
import { DEFAULT_AUDIO_INPUT, DEFAULT_STT_SETTINGS, DEFAULT_TTS_SETTINGS } from '@shared/voice'
import type { AudioInputSettings } from '@shared/voice'
import { api, errorMessage } from '../../lib/api'
import { formatHotkeyLabel, hotkeyFromEvent } from '../../lib/voice/hotkeyLabel'
import {
  formatModelLanguages,
  formatModelSize,
  modelAction,
  type LocalModelAction
} from '../../lib/voice/modelList'
import { Button, Kbd, Label, Switch } from '../ui/controls'
import { Select } from '../ui/Select'
import { HelpTip } from '../ui/Tooltip'
import { useInputDevices } from '../../lib/voice/useInputDevices'

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
    description: 'Motor no dispositivo — o áudio nunca sai do computador (motor em outra fatia)'
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

const TTS_ENGINE_LABELS: Record<TtsLocalEngine, string> = {
  kokoro: 'kokoro (Kokoro-82M, ONNX)',
  chatterbox: 'chatterbox (runtime em outra fatia)'
}

export function AudioSettings(): React.JSX.Element | null {
  const voice = api.voice
  const [input, setInput] = useState<AudioInputSettings>(DEFAULT_AUDIO_INPUT)
  const [stt, setStt] = useState<SttSettings>(DEFAULT_STT_SETTINGS)
  const [tts, setTts] = useState<TtsSettings>(DEFAULT_TTS_SETTINGS)
  const [keyDraft, setKeyDraft] = useState('')
  const [ttsKeyDraft, setTtsKeyDraft] = useState('')
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
  /** Modelos locais (catálogo + estado em disco, `voice:models:list`). */
  const [models, setModels] = useState<VoiceModelInfo[]>([])
  /** Progresso de download por modelo id (evento `voice:models:progress`). */
  const [modelProgress, setModelProgress] = useState<
    Record<string, { bytes: number; total: number }>
  >({})
  /** Erro de download/remoção de modelo (aviso legível no painel). */
  const [modelError, setModelError] = useState<string | null>(null)
  const devices = useInputDevices()

  useEffect(() => {
    let alive = true
    void voice?.settings
      .get()
      .then((all) => {
        if (!alive) return
        setInput(all.audioInput)
        setStt(all.sttSettings)
        setTts(all.ttsSettings)
        setKeyDraft(all.sttSettings.api.apiKey)
        setTtsKeyDraft(all.ttsSettings.api.apiKey)
      })
      .catch(() => void 0)
    void voice?.models
      .list()
      .then((list) => {
        if (alive) setModels(list)
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
        if (alive) setTtsClips((c) => ({ ...c, count: m ? m.clips.length : 0 }))
      })
      .catch(() => void 0)
    return () => {
      alive = false
    }
  }, [voice])

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

  const saveInput = (patch: Partial<AudioInputSettings>): void => {
    const next = { ...input, ...patch }
    setInput(next)
    void voice.settings
      .set('audioInput', next)
      .then(setInput)
      .catch(() => {
        // erro de gravação: o valor da tela fica; o próximo save tenta de novo
      })
  }

  /** Grava `sttSettings`; `sentKey` é o que foi de fato enviado no campo da chave (para a máscara). */
  const commitStt = (next: SttSettings, sentKey: string): void => {
    setStt(next)
    void voice.settings
      .set('sttSettings', next)
      .then((saved) => {
        setStt(saved)
        // só adota a máscara se o campo da chave não tiver edição em andamento
        setKeyDraft((d) => (d === sentKey ? saved.api.apiKey : d))
      })
      .catch(() => {
        // erro de gravação: o valor da tela fica; o próximo save tenta de novo
      })
  }

  const saveStt = (patch: Partial<Omit<SttSettings, 'api'>>): void => {
    commitStt({ ...stt, ...patch }, stt.api.apiKey)
  }
  const saveSttApi = (patch: Partial<SttSettings['api']>): void => {
    commitStt({ ...stt, api: { ...stt.api, ...patch } }, patch.apiKey ?? stt.api.apiKey)
  }

  // ---- TTS (síntese de fala + clipes) ----

  /** Grava `ttsSettings`; `sentKey` é o que foi de fato enviado no campo da chave (para a máscara). */
  const commitTts = (next: TtsSettings, sentKey: string): void => {
    setTts(next)
    void voice.settings
      .set('ttsSettings', next)
      .then((saved) => {
        setTts(saved)
        setTtsKeyDraft((d) => (d === sentKey ? saved.api.apiKey : d))
      })
      .catch(() => {
        // erro de gravação: o valor da tela fica; o próximo save tenta de novo
      })
  }
  const saveTts = (patch: Partial<Omit<TtsSettings, 'api'>>): void => {
    commitTts({ ...tts, ...patch }, tts.api.apiKey)
  }
  const saveTtsApi = (patch: Partial<TtsSettings['api']>): void => {
    commitTts({ ...tts, api: { ...tts.api, ...patch } }, patch.apiKey ?? tts.api.apiKey)
  }

  /** Recarrega as vozes (`voice:tts:voices`) — a lista local muda com o engine escolhido. */
  const refreshTtsVoices = (): void => {
    void voice.tts
      .voices()
      .then(setTtsVoices)
      .catch(() => void 0)
  }

  /** "Testar voz": sintetiza a frase de demonstração e reproduz (bytes → blob → `<audio>`). */
  const runTtsTest = (): void => {
    setTtsTest({ state: 'busy', error: null })
    void voice.tts
      .test()
      .then((r) => {
        setTtsTest({ state: 'playing', error: null })
        playTtsAudio(
          r,
          () => setTtsTest((s) => ({ ...s, state: 'idle' })),
          (error) => setTtsTest({ state: 'idle', error })
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

  return (
    <div className="space-y-6" data-testid="audio-settings">
      {/* ---- microfone ---- */}
      <section>
        <Label help="Microfone usado no ditado por voz (o menu do botão de microfone do composer mostra a mesma lista).">
          Microfone padrão
        </Label>
        <Select
          value={input.deviceId ?? '__default__'}
          label="Microfone padrão"
          className="h-8 w-full max-w-[360px]"
          menuMinWidth={360}
          onChange={(v) => saveInput({ deviceId: v === '__default__' ? null : v })}
          options={[
            { value: '__default__', label: 'Padrão do sistema' },
            ...devices.map((d, i) => ({
              value: d.deviceId,
              label: d.label || `Microfone ${i + 1}`
            }))
          ]}
        />
        {devices.length === 0 && (
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
            help="Com o push-to-talk ligado, a tecla abaixo segura a gravação (segurar = falar, soltar = parar e transcrever). Sem tecla configurada, use o botão de microfone do composer (clique inicia, clique de novo para)."
          >
            Push-to-talk
          </Label>
          <Switch
            checked={input.pttEnabled}
            label="Push-to-talk"
            onChange={(v) => saveInput({ pttEnabled: v })}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Kbd>{input.pttKey ? formatHotkeyLabel(input.pttKey) : 'sem tecla'}</Kbd>
          <KeyCaptureField value={input.pttKey} onChange={(pttKey) => saveInput({ pttKey })} />
          {input.pttKey && (
            <Button size="sm" variant="ghost" onClick={() => saveInput({ pttKey: null })}>
              Remover tecla
            </Button>
          )}
        </div>
        <p className="mt-1.5 text-xs leading-relaxed text-subtle">
          A tecla só funciona com a janela do ClearChat em foco. O clique no microfone do composer
          continua funcionando com o push-to-talk ligado ou desligado.
        </p>
      </section>

      {/* ---- auto-stop por silêncio ---- */}
      <section>
        <div className="mb-2 flex items-center gap-2">
          <Label
            className="mb-0"
            help="Encerra a gravação sozinha quando você para de falar. O tempo conta de silêncio CONTÍNUO (falar de novo zera a contagem)."
          >
            Parar por silêncio
          </Label>
          <Switch
            checked={input.silenceStopEnabled}
            label="Parar por silêncio"
            onChange={(v) => saveInput({ silenceStopEnabled: v })}
          />
        </div>
        <SilenceMsField
          value={input.silenceStopMs}
          disabled={!input.silenceStopEnabled}
          onCommit={(silenceStopMs) => saveInput({ silenceStopMs })}
        />
        <p className="mt-1.5 text-xs leading-relaxed text-subtle">
          Milissegundos de silêncio que encerram a gravação (padrão 5000).{' '}
          <strong>0 = sem limite</strong> — a gravação só para no botão, na tecla do push-to-talk ou
          em Esc.
        </p>
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
              O áudio gravado no ditado vira texto por um endpoint OpenAI-compatível{' '}
              <code className="font-mono">/audio/transcriptions</code> (padrão Groq) ou por um motor
              local. A chave de API fica no banco local e nunca chega à tela — o campo mostra só a
              máscara.
            </p>
          </HelpTip>
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
                value={stt.api.baseUrl}
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
              <Label help="Chave do endpoint (header Authorization: Bearer). O campo mostra a máscara da chave salva; digitar uma chave nova substitui, limpar o campo remove.">
                Chave de API
              </Label>
              <ApiKeyField
                mask={stt.api.apiKey}
                draft={keyDraft}
                onDraft={setKeyDraft}
                onCommit={() => saveSttApi({ apiKey: keyDraft.trim() })}
              />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Label
              className="mb-0"
              help="Melhor-esforço enquanto você fala: o texto parcial aparece no composer e a transcrição final o reescreve ao parar. No modo Local as parciais de verdade vêm do motor local (outra fatia)."
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
              ONNX baixados aqui embaixo). A chave de API fica no banco local e nunca chega à tela —
              o campo mostra só a máscara.
            </p>
          </HelpTip>
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
          {tts.backend === 'api' ? (
            <div className="grid grid-cols-2 gap-x-4 gap-y-3">
              <div>
                <Label>Endpoint (baseUrl)</Label>
                <input
                  type="text"
                  value={tts.api.baseUrl}
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
                  {ttsVoices.api.map((v) => (
                    <option key={v.id} value={v.id} />
                  ))}
                </datalist>
              </div>
              <div>
                <Label help="Chave do endpoint (header Authorization: Bearer). O campo mostra a máscara da chave salva; digitar uma chave nova substitui, limpar o campo remove.">
                  Chave de API
                </Label>
                <ApiKeyField
                  mask={tts.api.apiKey}
                  draft={ttsKeyDraft}
                  onDraft={setTtsKeyDraft}
                  onCommit={() => saveTtsApi({ apiKey: ttsKeyDraft.trim() })}
                  what="fala"
                  testId="tts-api-key"
                />
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <Label className="mb-0">Motor local</Label>
                <Select
                  value={tts.local?.engine ?? 'kokoro'}
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
                  options={(['kokoro', 'chatterbox'] as TtsLocalEngine[]).map((e) => ({
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
              <div>
                <Label help="Voz do motor local. As vozes pt-BR do Kokoro vêm dos voice packs baixados aqui embaixo (sem o pack instalado, a síntese avisa).">
                  Voz
                </Label>
                <Select
                  value={tts.local?.voice ?? 'pf_dora'}
                  label="Voz do motor local"
                  className="h-8 w-full max-w-[360px]"
                  menuMinWidth={360}
                  disabled={(tts.local?.engine ?? 'kokoro') !== 'kokoro'}
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
                {(tts.local?.engine ?? 'kokoro') !== 'kokoro' && (
                  <p className="mt-1.5 text-xs leading-relaxed text-subtle">
                    O runtime do Chatterbox entra numa fatia futura — até lá, use o motor{' '}
                    <strong>kokoro</strong> ou o backend de API.
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
              disabled={ttsTest.state !== 'idle'}
              icon={<Play className="size-3.5" />}
              onClick={runTtsTest}
            >
              {ttsTest.state === 'busy'
                ? 'Sintetizando…'
                : ttsTest.state === 'playing'
                  ? 'Reproduzindo…'
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
            {ttsClips.busy && (
              <span
                className="text-[11px] text-subtle tabular-nums"
                data-testid="tts-clips-progress"
              >
                gerando clipes… {ttsClips.done}/{ttsClips.total || 15}
              </span>
            )}
            {!ttsClips.busy && ttsClips.count !== null && ttsClips.count > 0 && (
              <span className="text-[11px] text-subtle" data-testid="tts-clips-count">
                {ttsClips.count} clipes gerados para a voz atual
              </span>
            )}
          </div>
          <p className="text-xs leading-relaxed text-subtle">
            Os clipes (interjeições e falas de espera da chamada de voz) são gerados pela voz
            escolhida e ficam em cache em <code className="font-mono">userData/voice-clips</code> —
            regenerados sozinhos quando a voz muda.
          </p>
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
    </div>
  )
}

/** Reproduz o áudio sintetizado (bytes → blob → `<audio>`); falhas viram mensagem legível. */
function playTtsAudio(r: TtsSynthResult, onEnd: () => void, onError: (msg: string) => void): void {
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
      onError(errorMessage(e))
    })
  } catch (e) {
    onError(errorMessage(e))
  }
}

/** Campo da chave com máscara ecoada: `type=password`, sem botão "mostrar" (a chave real não sai do main). */
function ApiKeyField({
  mask,
  draft,
  onDraft,
  onCommit,
  what = 'transcrição',
  testId = 'stt-api-key'
}: {
  mask: string
  draft: string
  onDraft: (v: string) => void
  onCommit: () => void
  /** Rótulo do domínio (transcrição/fala) nos textos de aria/placeholder. */
  what?: string
  /** `data-testid` do campo (STT usa o padrão; TTS usa 'tts-api-key'). */
  testId?: string
}): React.JSX.Element {
  const [focused, setFocused] = useState(false)
  return (
    <div className="relative">
      <KeyRound className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-faint" />
      <input
        type="password"
        value={draft}
        spellCheck={false}
        autoComplete="off"
        aria-label={`Chave de API (${what})`}
        data-testid={testId}
        placeholder={mask ? `${mask} — digite para trocar` : `Cole a chave da API de ${what}`}
        onFocus={() => setFocused(true)}
        onChange={(e) => onDraft(e.target.value)}
        onBlur={() => {
          setFocused(false)
          if (draft.trim() !== mask) onCommit()
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            ;(e.target as HTMLInputElement).blur()
          }
        }}
        className="field h-8 w-full py-0 pr-8 pl-7 font-mono text-[12px] placeholder:font-mono"
      />
      {!focused && draft && draft !== mask && (
        <button
          type="button"
          aria-label="Descartar chave digitada"
          onClick={() => onDraft(mask)}
          className="absolute top-1/2 right-1.5 -translate-y-1/2 rounded-md p-1 text-subtle hover:bg-hover hover:text-fg"
        >
          <X className="size-3.5" />
        </button>
      )}
    </div>
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
  onDismissError
}: {
  local: SttLocalConfig | null
  models: VoiceModelInfo[]
  progress: Record<string, { bytes: number; total: number }>
  error: string | null
  onEngine?: (engine: SttLocalConfig['engine']) => void
  onAction: (model: VoiceModelInfo, action: LocalModelAction['action']) => void
  onDismissError: () => void
}): React.JSX.Element {
  const engine = local?.engine ?? 'whisper.cpp'
  return (
    <div
      className="rounded-xl border border-border bg-elevated/30 px-3 py-2.5"
      data-testid="stt-local-engine"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Label className="mb-0">Motor local</Label>
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
      <ModelError error={error} onDismiss={onDismissError} />
      <LocalModelList kind="stt" models={models} progress={progress} onAction={onAction} />
      <p className="mt-2 text-[11px] leading-relaxed text-subtle">
        Os arquivos ficam em <code className="font-mono">userData/models</code> (verificados por
        tamanho/magic bytes/sha256). A inferência local (rodar whisper/vosk/nemotron) entra numa
        fatia futura — até lá, use o modo <strong>API</strong> ou <strong>Híbrido</strong>.
      </p>
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
  const items = models.filter((m) => m.kind === kind)
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
              <span className="text-[10px] text-subtle">disponível na fatia de TTS</span>
            </>
          )}
        </span>
      </div>
      <p className="mt-1 text-[11px] leading-relaxed text-subtle">{model.description}</p>
      <p className="text-[10.5px] text-faint">
        {formatModelLanguages(model.languages)}
        {model.sizeBytes > 0
          ? ` · ${formatModelSize(model.sizeBytes)}`
          : ' · tamanho a definir na fatia de TTS'}
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

/** Captura da tecla do push-to-talk: mostra a atual e grava a próxima pressionada (Esc cancela). */
function KeyCaptureField({
  value,
  onChange
}: {
  value: string | null
  onChange: (v: string) => void
}): React.JSX.Element {
  const [capturing, setCapturing] = useState(false)
  useEffect(() => {
    if (!capturing) return
    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') {
        setCapturing(false)
        return
      }
      const hotkey = hotkeyFromEvent(e)
      if (hotkey) {
        onChange(hotkey)
        setCapturing(false)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [capturing, onChange])
  return (
    <Button
      size="sm"
      variant={capturing ? 'primary' : 'secondary'}
      data-testid="ptt-key-capture"
      onClick={() => setCapturing((c) => !c)}
    >
      {capturing ? 'Pressione a tecla… (Esc cancela)' : value ? 'Alterar tecla' : 'Definir tecla'}
    </Button>
  )
}
