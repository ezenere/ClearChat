// Configurações → Áudio: ditado por voz (microfone padrão, push-to-talk com captura de tecla,
// auto-stop por silêncio, idioma), transcrição (STT — `SttSettingsSection`: modo, provedor
// cadastrado + modelo descoberto, motor local só nos modos Local/Híbrido) e fala (TTS —
// `TtsSettingsSection`: backend, provedor + modelo + voz descobertos com prévia, Kokoro só no
// backend Local, "Testar voz" e clipes) e os padrões da chamada de voz (ligada, silêncio do turno,
// interjeições/fillers). Espelha o padrão de "Pesquisa na web" (`WebSearchSettings.tsx`): cada
// controle grava na hora via `saveVoiceSetting` (espelho reativo `useVoiceSettings` — o composer e
// a chamada acompanham na hora) e falha de gravação vira aviso visível. A chave real dos
// provedores/endpoints nunca sai do main (contrato testado em `e2e/voiceSettings.test.ts`).
import { TriangleAlert, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import type {
  VoiceModelInfo,
  VoiceRuntimeStatus,
  VoiceSettingKind,
  VoiceSettingsMap
} from '@shared/ipc'
import type { SttSettings, TtsSettings, VoiceCallDefaults, InterjectionClass } from '@shared/voice'
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
import type { LocalModelAction } from '../../lib/voice/modelList'
import { Button, Kbd, Label, Switch } from '../ui/controls'
import { Select } from '../ui/Select'
import { HelpTip } from '../ui/Tooltip'
import { SttSettingsSection } from './SttSettingsSection'
import { TtsSettingsSection } from './TtsSettingsSection'
import { VoiceCallModelEditor } from './VoiceCallModelEditor'
import type { ProviderOption } from '../../lib/voice/voiceSettingsHelpers'
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
  /** Provedores cadastrados (id/nome/endpoint/tipo) — STT/TTS usam a chave deles pelo `providerId`. */
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
        if (alive)
          setProviders(
            list.map((p) => ({ id: p.id, name: p.name, baseUrl: p.baseUrl, kind: p.kind }))
          )
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
  /** Grava `ttsSettings` (a máscara da chave no valor = preserva a chave salva). */
  const commitTts = async (next: TtsSettings): Promise<boolean> => {
    setTts(next)
    const saved = await persist('ttsSettings', next)
    if (saved) setTts(saved)
    return !!saved
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

      {/* ---- STT (provedor + modelo; motor local só nos modos Local/Híbrido) ---- */}
      <SttSettingsSection
        stt={stt}
        language={input.language}
        providers={providers}
        models={models}
        modelProgress={modelProgress}
        modelError={modelError}
        runtime={runtime}
        onCommit={commitStt}
        onModelAction={runModelAction}
        onDismissModelError={() => setModelError(null)}
      />

      {/* ---- TTS (provedor + modelo + voz; Kokoro só no backend Local; teste e clipes) ---- */}
      <TtsSettingsSection
        tts={tts}
        providers={providers}
        models={models}
        modelProgress={modelProgress}
        runtime={runtime}
        onCommit={commitTts}
        onModelAction={runModelAction}
      />

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
              help="Transcrição especulativa pela API quando não há motor local. Com as parciais ao vivo ligadas ela já acontece (a especulação reaproveitada vira a final — sem custo extra no caso comum, texto ~1 s antes); isto liga também sem as parciais."
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

      {/* ---- chamada de voz: modelo da chamada padrão (global) + parâmetros ---- */}
      <section className="border-t border-border pt-4" data-testid="voice-call-model-settings">
        <div className="max-w-[520px]">
          <VoiceCallModelEditor
            value={callDefaults.model}
            onChange={(model) => saveCallDefaults({ model })}
            scope="global"
            inherited="o modelo de cada chat"
          />
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
