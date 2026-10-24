// Configurações → Áudio, no padrão das outras abas (seções `h3` + (?) separadas por borda, campos
// de largura total, `ToggleRow` com o switch à direita, linhas "rótulo … número"): ditado
// (microfone padrão, idioma, push-to-talk com captura de tecla, auto-stop por silêncio),
// transcrição (STT — `SttSettingsSection`: provedor de Configurações → Provedores ou motor
// local/GPU, modelo no seletor do chat), fala (TTS — `TtsSettingsSection`: provedor/local/GPU,
// modelo, voz com prévia, "Testar voz" e clipes), os padrões da chamada de voz (ligada, fim de
// turno, modelo da chamada, interjeições/fillers) e, no fim, o "Modo avançado (GPU local)"
// (`gpu/GpuModeSection`, fechado por padrão). Cada controle grava na hora via `saveVoiceSetting`
// (espelho reativo `useVoiceSettings` — o composer e a chamada acompanham) e falha de gravação vira
// aviso visível. Os provedores vêm do store (cadastro só em Configurações → Provedores); a chave
// real nunca sai do main (contrato testado em `e2e/voiceSettings.test.ts`).
import { TriangleAlert, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
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
import { useStore } from '../../store'
import { useEscapeLayer } from '../ui/escape'
import type { LocalModelAction } from '../../lib/voice/modelList'
import { ToggleRow } from '../panel/fields'
import { Button, Kbd, Label } from '../ui/controls'
import { Select } from '../ui/Select'
import { HelpTip } from '../ui/Tooltip'
import { AudioSection, NumberRow, SubHeading, WarnNote } from './audioUi'
import { SttSettingsSection } from './SttSettingsSection'
import { TtsSettingsSection } from './TtsSettingsSection'
import { VoiceCallModelEditor } from './VoiceCallModelEditor'
import { GpuModeSection } from './gpu/GpuModeSection'
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
  /** Provedores cadastrados (store — o cadastro é só em Configurações → Provedores). */
  const storeProviders = useStore((s) => s.providers)
  const providers = useMemo<ProviderOption[]>(
    () => storeProviders.map((p) => ({ id: p.id, name: p.name, baseUrl: p.baseUrl, kind: p.kind })),
    [storeProviders]
  )
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

  /** Relê stt/tts do main (o main grava sozinho ao instalar/remover modelos locais). */
  const reloadVoiceGroups = useCallback((): void => {
    void loadVoiceSettings()
      .then((all) => {
        setStt(all.sttSettings)
        setTts(all.ttsSettings)
      })
      .catch(() => void 0)
  }, [])

  /** Grava `sttSettings` (provedor/modelo/opções — a chave fica no provedor). */
  const commitStt = useCallback(async (next: SttSettings): Promise<boolean> => {
    setStt(next)
    try {
      const saved = await saveVoiceSetting('sttSettings', next)
      setSaveError(null)
      setStt(saved)
      return true
    } catch (e) {
      setSaveError(`Não foi possível salvar: ${errorMessage(e)}`)
      return false
    }
  }, [])
  /** Grava `ttsSettings` (provedor/modelo/voz/opções — a chave fica no provedor). */
  const commitTts = useCallback(async (next: TtsSettings): Promise<boolean> => {
    setTts(next)
    try {
      const saved = await saveVoiceSetting('ttsSettings', next)
      setSaveError(null)
      setTts(saved)
      return true
    } catch (e) {
      setSaveError(`Não foi possível salvar: ${errorMessage(e)}`)
      return false
    }
  }, [])

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

  // ---- modelos locais (download/remoção com progresso) ----

  const refreshModels = (): void => {
    void voice.models
      .list()
      .then(setModels)
      .catch(() => void 0)
  }

  /** Probe dos runtimes locais (`voice.runtime.status`, quando o main expõe) — "pronto" de verdade. */
  const refreshRuntime = (): void => {
    void voice.runtime
      ?.status()
      .then(setRuntime)
      .catch(() => void 0)
  }

  /** O main sincroniza `installed` nas settings ao instalar/remover — relê os grupos. */
  const refreshModelSettings = (): void => {
    reloadVoiceGroups()
    refreshRuntime()
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
  const turn = callDefaults.turn
  const ij = callDefaults.interjections

  return (
    <div className="space-y-5" data-testid="audio-settings">
      <div className="flex items-center gap-1.5 text-xs leading-relaxed text-subtle">
        Ditado, transcrição, fala e chamada de voz — valem para todos os chats.
        <HelpTip label="Áudio">
          Cada persona/chat pode ligar/desligar a chamada de voz e ter modelo, tools e prompt
          próprios (painel do chat → aba Voz). Os provedores de transcrição e fala são os de
          Configurações → Provedores.
        </HelpTip>
      </div>
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

      {/* ---- ditado: microfone, idioma, push-to-talk, silêncio ---- */}
      <AudioSection
        title="Ditado"
        first
        testId="dictation-settings"
        help="Gravação de voz no composer (botão de microfone ou push-to-talk): a fala vira texto no rascunho — o envio é sempre manual. O microfone também vale para a chamada de voz."
      >
        <div>
          <Label help="Microfone usado no ditado por voz e na chamada de voz (o menu do botão de microfone do composer mostra a mesma lista). Se o microfone escolhido for desconectado, a gravação usa o padrão do sistema e avisa.">
            Microfone padrão
          </Label>
          <Select
            value={input.deviceId ?? '__default__'}
            label="Microfone padrão"
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
            <div className="mt-1.5">
              <WarnNote testId="mic-missing-warning" role="note">
                O microfone salvo não está conectado — a gravação usa o padrão do sistema até ele
                voltar.
              </WarnNote>
            </div>
          )}
          {devicesLoaded && devices.length === 0 && (
            <p className="mt-1.5 text-[11.5px] text-subtle">
              Nenhum microfone encontrado (ou permissão ainda não concedida).
            </p>
          )}
        </div>

        <div>
          <Label help="Idioma pedido à transcrição (melhora a precisão). Idiomas fora da lista também são aceitos (código livre, ex.: 'nl').">
            Idioma do ditado
          </Label>
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <Select
                value={langIsCommon ? input.language : CUSTOM_LANGUAGE}
                label="Idioma do ditado"
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
            </div>
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
                className="field w-[140px] font-mono text-[12.5px]"
              />
            ) : null}
          </div>
        </div>

        <div className="space-y-2">
          <ToggleRow
            label="Push-to-talk"
            checked={pttActive}
            onChange={(v) => input.pttKey && !pttProblem && saveInput({ pttEnabled: v })}
            help={
              'Segure a tecla para falar e solte para parar e transcrever. Só funciona com a janela do ClearChat em foco e fica desligada enquanto o ditado não está disponível (chamada de voz, pergunta pendente, Configurações abertas).\nA tecla precisa ser F1–F24 ou ter Ctrl/Alt/Meta — uma tecla que digita deixaria de funcionar no app.\nO clique no microfone do composer funciona com ou sem push-to-talk.'
            }
            status={
              !input.pttKey ? (
                <span data-testid="ptt-inactive-hint">inativo — defina uma tecla</span>
              ) : undefined
            }
          />
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
            <WarnNote testId="ptt-key-invalid">
              A tecla salva não vale como push-to-talk: {pttProblem}
            </WarnNote>
          )}
        </div>

        <ToggleRow
          label="Parar por silêncio"
          checked={input.silenceStopEnabled}
          onChange={(v) => saveInput({ silenceStopEnabled: v })}
          help={
            'Encerra a gravação do ditado sozinha quando você para de falar. O tempo conta de silêncio CONTÍNUO (falar de novo zera a contagem).\nA chamada de voz tem o próprio silêncio de turno (mais abaixo).'
          }
        />
        <NumberRow
          label="Silêncio que encerra a gravação"
          help="Milissegundos de silêncio contínuo (padrão 5000). 0 = sem limite: a gravação só para no botão, na tecla do push-to-talk ou em Esc."
          value={input.silenceStopMs}
          min={0}
          step={100}
          unit="ms"
          disabled={!input.silenceStopEnabled}
          status={input.silenceStopMs === 0 ? '0 = sem limite' : undefined}
          testId="silence-stop-ms"
          ariaLabel="Silêncio que encerra a gravação (ms)"
          onCommit={(silenceStopMs) => saveInput({ silenceStopMs: Math.round(silenceStopMs) })}
        />
      </AudioSection>

      {/* ---- STT (provedor/local/GPU + modelo) ---- */}
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

      {/* ---- TTS (provedor/local/GPU + modelo + voz; teste e clipes) ---- */}
      <TtsSettingsSection
        tts={tts}
        providers={providers}
        models={models}
        modelProgress={modelProgress}
        runtime={runtime}
        onCommit={commitTts}
        onModelAction={runModelAction}
      />

      {/* ---- chamada de voz: disponível + fim de turno (padrões globais) ---- */}
      <AudioSection
        title="Chamada de voz"
        testId="voice-call-settings"
        help={
          <>
            <p>
              Conversa falada com o agente (botão de telefone no composer): você fala, o silêncio
              encerra a sua vez, a fala vira mensagem do chat e a resposta é falada. Estes são os
              padrões GLOBAIS — cada persona/chat pode ligar/desligar a chamada e ter modelo, tools
              e prompt próprios (painel do chat → aba Voz).
            </p>
            <p>
              Precisa da transcrição (STT) e da fala (TTS) configuradas acima; o que faltar é
              avisado ao tentar entrar na chamada.
            </p>
          </>
        }
      >
        <ToggleRow
          label="Chamada de voz disponível"
          checked={callDefaults.enabled}
          onChange={(enabled) => saveCallDefaults({ enabled })}
          help="Desligada, o botão de telefone some de todos os chats (exceto os que ligam a chamada explicitamente na própria config)."
        />
        <SubHeading>Fim da sua vez de falar</SubHeading>
        <ToggleRow
          label="Fim de turno adaptativo"
          checked={turn.adaptive}
          onChange={(adaptive) => saveCallDefaults({ turn: { ...turn, adaptive } })}
          help='Aos ~250 ms de pausa o app transcreve o que você já disse (motor local) e decide: pergunta/comando fecha a vez rápido; frase que termina em vírgula, "e", "mas", "porque"… espera mais. Se você não voltar a falar, essa transcrição já é a final.'
        />
        <ToggleRow
          label="Especular pela API"
          checked={turn.speculativeApi}
          onChange={(speculativeApi) => saveCallDefaults({ turn: { ...turn, speculativeApi } })}
          help="Transcrição especulativa pela API quando não há motor local. Com as parciais ao vivo ligadas ela já acontece (a especulação reaproveitada vira a final — sem custo extra no caso comum, texto ~1 s antes); isto liga também sem as parciais."
        />
        <NumberRow
          label="Silêncio que encerra a fala"
          help={`Silêncio contínuo que encerra a SUA vez quando não há transcrição especulativa (fim de turno adaptativo desligado, ou STT só por API sem especulação) — padrão ${DEFAULT_TURN_SILENCE_MS} ms. Independente do "Parar por silêncio" do ditado.`}
          value={turn.silenceStopMs ?? DEFAULT_TURN_SILENCE_MS}
          min={200}
          max={10000}
          step={100}
          unit="ms"
          testId="voice-call-turn-silence"
          ariaLabel="Silêncio que encerra a fala na chamada (ms)"
          onCommit={(v) =>
            // o padrão volta a ser "segue o padrão" (null) — muda junto se o padrão mudar
            saveCallDefaults({
              turn: { ...turn, silenceStopMs: v === DEFAULT_TURN_SILENCE_MS ? null : v }
            })
          }
        />
        <NumberRow
          label="Fala completa"
          help='Silêncio que fecha uma fala completa: pergunta, comando ou fecho ("obrigado").'
          value={turn.completeSilenceMs}
          min={200}
          max={5000}
          step={50}
          unit="ms"
          testId="voice-call-turn-complete"
          ariaLabel="Silêncio para fala completa (ms)"
          onCommit={(v) => saveCallDefaults({ turn: { ...turn, completeSilenceMs: v } })}
        />
        <NumberRow
          label="Afirmação"
          help="Silêncio que fecha uma afirmação (o ponto final do STT não prova que você terminou — pode ser uma história no meio)."
          value={turn.statementSilenceMs}
          min={200}
          max={10000}
          step={50}
          unit="ms"
          testId="voice-call-turn-statement"
          ariaLabel="Silêncio para afirmação (ms)"
          onCommit={(v) => saveCallDefaults({ turn: { ...turn, statementSilenceMs: v } })}
        />
        <NumberRow
          label="Fala inacabada"
          help="Silêncio que fecha uma fala inacabada (termina em vírgula, conectivo ou hesitação) — o teto."
          value={turn.unfinishedSilenceMs}
          min={200}
          max={10000}
          step={50}
          unit="ms"
          testId="voice-call-turn-unfinished"
          ariaLabel="Silêncio para fala inacabada (ms)"
          onCommit={(v) => saveCallDefaults({ turn: { ...turn, unfinishedSilenceMs: v } })}
        />
      </AudioSection>

      {/* ---- chamada de voz: modelo da chamada padrão (global) + parâmetros ---- */}
      <section className="border-t border-border pt-4" data-testid="voice-call-model-settings">
        <VoiceCallModelEditor
          value={callDefaults.model}
          onChange={(model) => saveCallDefaults({ model })}
          scope="global"
          inherited="o modelo de cada chat"
        />
      </section>

      {/* ---- chamada de voz: atos de fala curta (interjeições/fillers) ---- */}
      <AudioSection
        title="Interjeições e fillers"
        testId="voice-acts-settings"
        help={
          <>
            <p>
              Atos de fala curta da chamada de voz, decididos por regras simples (sem classificador
              treinado). Estes são os padrões GLOBAIS — persona/chat podem sobrescrever (★ da aba
              Voz do painel).
            </p>
            <p>
              Interjeições entram nas pausas da sua fala (clipe curto tipo &quot;uhum&quot;); o
              filler toca quando a resposta demora a começar. Em modo sombra nada toca: as decisões
              só são registradas em <code className="font-mono">voice-eval/</code> para calibração.
            </p>
          </>
        }
      >
        <ToggleRow
          label="Interjeições"
          checked={ij.enabled}
          onChange={(v) => saveCallDefaults({ interjections: { ...ij, enabled: v } })}
          help="Interjeições durante a sua fala (só em pausas, com cooldown; nunca sobre a fala do assistente)."
        />
        <ToggleRow
          label="Fillers"
          checked={callDefaults.fillers.enabled}
          onChange={(v) => saveCallDefaults({ fillers: { ...callDefaults.fillers, enabled: v } })}
          help='Preâmbulo curto logo depois da sua fala ("Hum, deixa eu ver aqui.", "Beleza, só um minutinho.") escolhido pelo tipo de pedido, enquanto a resposta não começa. No máximo 1 por turno; a resposta espera ele terminar.'
        />
        <ToggleRow
          label="Modo sombra"
          checked={ij.shadow}
          onChange={(v) => saveCallDefaults({ interjections: { ...ij, shadow: v } })}
          help="O motor decide mas NÃO toca — as decisões ficam no log de avaliação (voice-eval) para calibração. Vale para interjeições E fillers."
        />
        <NumberRow
          label="Preâmbulo após"
          help='Espera entre o fim da sua fala e o preâmbulo ("Hum, deixa eu ver…"). Se a 1ª frase da resposta ficar pronta antes, o preâmbulo nem sai. 0 = já.'
          value={callDefaults.fillers.delayMs}
          min={0}
          max={5000}
          step={50}
          unit="ms"
          testId="voice-call-filler-delay"
          ariaLabel="Espera do preâmbulo (ms)"
          onCommit={(v) => saveCallDefaults({ fillers: { ...callDefaults.fillers, delayMs: v } })}
        />
        <NumberRow
          label="Cooldown entre interjeições"
          help="Intervalo mínimo entre interjeições."
          value={ij.cooldownMs}
          min={0}
          step={100}
          unit="ms"
          testId="voice-interjection-cooldown"
          ariaLabel="Cooldown entre interjeições (ms)"
          onCommit={(v) => saveCallDefaults({ interjections: { ...ij, cooldownMs: v } })}
        />
        <NumberRow
          label="Probabilidade de disparo"
          help="Probabilidade de a interjeição sair quando as regras deixam (0–1; 0 = nunca, 1 = sempre)."
          value={ij.fireProbability}
          min={0}
          max={1}
          step={0.05}
          testId="voice-interjection-probability"
          ariaLabel="Probabilidade de disparo (0 a 1)"
          onCommit={(v) => saveCallDefaults({ interjections: { ...ij, fireProbability: v } })}
        />
        <NumberRow
          label="Fala mínima"
          help="Sua fala acumulada antes de uma interjeição poder sair."
          value={ij.minSpeechMs}
          min={0}
          step={100}
          unit="ms"
          testId="voice-interjection-min-speech"
          ariaLabel="Fala mínima para interjeição (ms)"
          onCommit={(v) => saveCallDefaults({ interjections: { ...ij, minSpeechMs: v } })}
        />
        <NumberRow
          label="Pausa mínima"
          help="Sua pausa contínua em que a interjeição pode entrar."
          value={ij.minPauseMs}
          min={0}
          step={50}
          unit="ms"
          testId="voice-interjection-min-pause"
          ariaLabel="Pausa mínima para interjeição (ms)"
          onCommit={(v) => saveCallDefaults({ interjections: { ...ij, minPauseMs: v } })}
        />
        <div>
          <Label
            help={
              "Tipos de interjeição que podem sair (os clipes vêm de 'Gerar clipes de voz' em Fala). Nenhum marcado = todos.\nO tipo vem do fim da transcrição parcial: pergunta evita 'Pensando'; negação/incerteza não interjeita; sem confiança sai 'Confirmação'."
            }
          >
            Interjeições permitidas
          </Label>
          <div
            className="grid grid-cols-2 gap-x-4 gap-y-2"
            data-testid="voice-interjection-classes"
          >
            {INTERJECTION_CLASSES.map((cls) => {
              const checked = ij.classes.includes(cls)
              return (
                <label
                  key={cls}
                  title={`${cls} — ex.: ${INTERJECTION_LABELS[cls].example}`}
                  className="flex cursor-pointer items-center gap-2 text-[13px] text-fg/90"
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    aria-label={`Interjeição: ${INTERJECTION_LABELS[cls].label}`}
                    data-class={cls}
                    onChange={() => {
                      const classes = checked
                        ? ij.classes.filter((c) => c !== cls)
                        : [...ij.classes, cls]
                      saveCallDefaults({
                        interjections: {
                          ...ij,
                          classes: INTERJECTION_CLASSES.filter((c) =>
                            classes.includes(c as InterjectionClass)
                          ) as InterjectionClass[]
                        }
                      })
                    }}
                    className="size-3.5 accent-accent-strong"
                  />
                  {INTERJECTION_LABELS[cls].label}
                  <span className="text-[11px] text-faint">{INTERJECTION_LABELS[cls].example}</span>
                </label>
              )
            })}
          </div>
        </div>
        {/* `fillers.prompt` ainda não é consumido (a decisão é por regra): campo escondido até ser */}
      </AudioSection>

      {/* ---- modo avançado: motores de voz/transcrição na GPU local (fechado por padrão) ---- */}
      <GpuModeSection tts={tts} onCommitTts={commitTts} />
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
