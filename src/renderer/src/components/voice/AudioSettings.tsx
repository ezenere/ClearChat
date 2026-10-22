// Configurações → Áudio: ditado por voz (microfone padrão, push-to-talk com captura de tecla,
// auto-stop por silêncio, idioma) e transcrição (STT — modo, endpoint de API com chave mascarada,
// motor local sem download nesta fatia, parciais ao vivo). TTS entra em outra fatia (só o heading).
// Espelha o padrão de "Pesquisa na web" (`WebSearchSettings.tsx`): cada controle grava na hora via
// `voice:settings:set`; a chave de API é ECOADA mascarada no campo — escrever por cima da máscara
// preserva a chave real (contrato do main, testado em `e2e/voiceSettings.test.ts`).
import { Download, KeyRound, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { SttLocalConfig, SttMode, SttSettings, TtsSettings } from '@shared/voice'
import { DEFAULT_AUDIO_INPUT, DEFAULT_STT_SETTINGS, DEFAULT_TTS_SETTINGS } from '@shared/voice'
import type { AudioInputSettings } from '@shared/voice'
import { api } from '../../lib/api'
import { formatHotkeyLabel, hotkeyFromEvent } from '../../lib/voice/hotkeyLabel'
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

export function AudioSettings(): React.JSX.Element | null {
  const voice = api.voice
  const [input, setInput] = useState<AudioInputSettings>(DEFAULT_AUDIO_INPUT)
  const [stt, setStt] = useState<SttSettings>(DEFAULT_STT_SETTINGS)
  const [tts, setTts] = useState<TtsSettings>(DEFAULT_TTS_SETTINGS)
  const [keyDraft, setKeyDraft] = useState('')
  /** Rascunho do idioma livre ("Outro…") enquanto digita; null = lista comum. */
  const [langDraft, setLangDraft] = useState<string | null>(null)
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
      })
      .catch(() => void 0)
    return () => {
      alive = false
    }
  }, [voice])

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
            onEngine={(engine) =>
              saveStt({
                local: stt.local
                  ? { ...stt.local, engine }
                  : { engine, model: '', installed: false }
              })
            }
          />
        </div>
      </section>

      {/* ---- TTS (outra fatia) ---- */}
      <section className="border-t border-border pt-4" data-testid="tts-section">
        <div className="mb-1 flex items-baseline gap-2">
          <span className="text-[13px] font-medium text-fg/90">Fala (TTS)</span>
          <HelpTip label="Fala (TTS)">
            <p>
              Síntese de fala para a chamada de voz (Feature B). Os contratos de configuração já
              existem (<code className="font-mono">ttsSettings</code>: backend API/local, Kokoro
              local por padrão) — a UI e o falante entram na próxima fatia.
            </p>
          </HelpTip>
        </div>
        <p className="text-xs leading-relaxed text-subtle">
          Configurado na próxima fatia. Padrão provisório: motor local Kokoro (não instalado){' '}
          {tts.backend === 'api' ? '· backend atual: API' : ''}.
        </p>
      </section>
    </div>
  )
}

/** Campo da chave com máscara ecoada: `type=password`, sem botão "mostrar" (a chave real não sai do main). */
function ApiKeyField({
  mask,
  draft,
  onDraft,
  onCommit
}: {
  mask: string
  draft: string
  onDraft: (v: string) => void
  onCommit: () => void
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
        aria-label="Chave de API (transcrição)"
        data-testid="stt-api-key"
        placeholder={mask ? `${mask} — digite para trocar` : 'Cole a chave da API de transcrição'}
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
 * Estado do motor local de STT — pronto para plugar o download (outra fatia): `onDownload` ausente
 * mantém o botão "Baixar" desabilitado com a nota da fatia futura.
 */ export function LocalEnginePanel({
  local,
  onEngine,
  onDownload
}: {
  local: SttLocalConfig | null
  onEngine?: (engine: SttLocalConfig['engine']) => void
  onDownload?: (engine: SttLocalConfig['engine']) => void
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
        <Button
          size="sm"
          variant="secondary"
          icon={<Download className="size-3.5" />}
          disabled={!onDownload || local?.installed}
          onClick={() => onDownload?.(engine)}
        >
          Baixar
        </Button>
      </div>
      {!local?.installed && (
        <p className="mt-1.5 text-[11px] leading-relaxed text-subtle">
          O download dos modelos locais entra na próxima fatia — o botão fica desabilitado até lá.
          Até lá, use o modo <strong>API</strong> ou <strong>Híbrido</strong>.
        </p>
      )}
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
