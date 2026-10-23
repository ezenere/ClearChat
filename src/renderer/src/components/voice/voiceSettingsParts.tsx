// Peças compartilhadas das seções de Transcrição (STT) e Fala (TTS) de Configurações → Áudio:
// seletor de provedor (provedores cadastrados que servem a capacidade + "Endpoint personalizado"),
// seletor de modelo alimentado pela descoberta (`voice.catalog.list`, com correção de apelidos),
// seletor de voz com badges e ▶ prévia, disclosure do endpoint personalizado (avançado), campo de
// chave mascarada, motor/modelos locais e o player dos bytes de áudio. A chave real nunca vem ao
// renderer (o main lista e sintetiza com ela).
import {
  Check,
  ChevronDown,
  ChevronRight,
  Download,
  Eye,
  EyeOff,
  KeyRound,
  LoaderCircle,
  Play,
  RefreshCw,
  Square,
  TriangleAlert,
  X
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { VoiceModelInfo } from '@shared/ipc'
import type { SttLocalConfig } from '@shared/voice'
import {
  callTtsWarning,
  formatLatency,
  providerSupportsVoice,
  resolveModelAlias,
  voiceProviderSupport,
  type VoiceCapability,
  type VoiceCatalogModel,
  type VoiceCatalogVoice,
  type VoiceProviderSupport
} from '@shared/voiceCatalog'
import { cn } from '../../lib/format'
import type { VoiceCatalogState } from '../../lib/voice/useVoiceCatalog'
import { CUSTOM_ENDPOINT, type ProviderOption } from '../../lib/voice/voiceSettingsHelpers'
import {
  formatModelLanguages,
  formatModelSize,
  modelAction,
  type LocalModelAction
} from '../../lib/voice/modelList'
import { Button, IconButton, Label } from '../ui/controls'
import { Popover } from '../ui/layers'
import { Select } from '../ui/Select'

const FAMILY_LABEL: Record<VoiceProviderSupport, string> = {
  openrouter: 'OpenRouter',
  elevenlabs: 'ElevenLabs',
  openai: 'OpenAI-compatível'
}

// ---------------- provedor ----------------

/**
 * Provedor da transcrição/fala: os provedores de Configurações → Provedores que servem a
 * capacidade (Anthropic não tem áudio; ElevenLabs direto só fala) + "Endpoint personalizado".
 * `value` = providerId, ou `CUSTOM_ENDPOINT`.
 */
export function VoiceProviderSelect({
  capability,
  providers,
  value,
  onChange,
  testId
}: {
  capability: VoiceCapability
  providers: ProviderOption[]
  value: string
  onChange: (v: string) => void
  testId: string
}): React.JSX.Element {
  const usable = providers.filter((p) => providerSupportsVoice(p, capability))
  const missing = value !== CUSTOM_ENDPOINT && !providers.some((p) => p.id === value)
  return (
    <div data-testid={testId}>
      <Select
        value={missing ? CUSTOM_ENDPOINT : value}
        label={capability === 'stt' ? 'Provedor da transcrição' : 'Provedor da fala'}
        className="h-8 w-full max-w-[360px]"
        menuMinWidth={360}
        onChange={onChange}
        options={[
          ...usable.map((p) => {
            const fam = voiceProviderSupport(p)
            return {
              value: p.id,
              label: p.name,
              description: `${fam ? FAMILY_LABEL[fam] : ''} · ${p.baseUrl}`
            }
          }),
          {
            value: CUSTOM_ENDPOINT,
            label: 'Endpoint personalizado…',
            description: 'Servidor OpenAI-compatível fora dos Provedores (avançado)'
          }
        ]}
      />
      {!usable.length && (
        <p className="mt-1 text-[11px] text-subtle" data-testid={`${testId}-empty`}>
          Nenhum provedor cadastrado serve {capability === 'stt' ? 'transcrição' : 'fala'} —
          cadastre o OpenRouter (ou Groq/OpenAI{capability === 'tts' ? '/ElevenLabs' : ''}) em
          Configurações → Provedores, ou use um endpoint personalizado.
        </p>
      )}
    </div>
  )
}

// ---------------- modelo ----------------

const OTHER_MODEL = '__other_model__'

const correctionNote = (from: string, to: string): string =>
  `Modelo corrigido: “${from}” → “${to}” (o id que este provedor usa).`

/** Badge de latência medida ("~0,5 s") / "lento" na lista de modelos. */
function ModelLatencyBadge({ m }: { m: VoiceCatalogModel }): React.JSX.Element | null {
  if (m.latencyMs == null && !m.slow) return null
  return (
    <span
      className={cn(
        'ml-1.5 inline-block rounded-full border px-1.5 py-px align-middle text-[10px] leading-4 tabular-nums',
        m.slow ? 'border-warning/30 text-warning' : 'border-success/30 text-success'
      )}
      data-testid={`model-latency-${m.id}`}
      title={
        m.slow
          ? 'Lento para a chamada de voz (medido)'
          : 'Tempo medido até o 1º áudio de uma frase curta em pt-BR'
      }
    >
      {m.slow ? 'lento' : ''}
      {m.slow && m.latencyMs != null ? ' · ' : ''}
      {m.latencyMs != null ? formatLatency(m.latencyMs) : ''}
    </span>
  )
}

/**
 * Modelo de STT/TTS: lista do provedor (descoberta) com nome + id + preço; id fora da lista →
 * corrigido sozinho quando há UM equivalente (`resolveModelAlias` — ex.: `whisper-large-v3-turbo`
 * → `openai/whisper-large-v3-turbo`, com nota visível) ou aviso; provedor sem listagem → texto livre.
 * Lista CURADA (TTS no OpenRouter/ElevenLabs — `catalog.curated`): só os modelos medidos para a
 * chamada, com a latência em badge; o id livre fica no "Avançado" ("não testado para chamada") e um
 * modelo salvo escondido (lento) mostra o aviso com a troca de um clique (`onUseRecommended`).
 */
export function VoiceModelField({
  capability,
  state,
  value,
  onCommit,
  testId,
  placeholder,
  family = null,
  recommended
}: {
  capability: VoiceCapability
  state: VoiceCatalogState
  value: string
  onCommit: (model: string) => void
  testId: string
  placeholder: string
  /** Família do provedor (texto do aviso da curadoria). */
  family?: VoiceProviderSupport | null
  /** Troca de um clique no aviso de modelo lento (lista curada). */
  recommended?: { label: string; onUse: () => void }
}): React.JSX.Element {
  const { catalog, loading, error } = state
  const models = useMemo(() => catalog?.models ?? [], [catalog])
  const ids = useMemo(() => models.map((m) => m.id), [models])
  const curated = !!catalog?.curated
  // ids que o provedor lista mas a curadoria escondeu (o salvo antigo é reconhecido, não "desconhecido")
  const allIds = useMemo(
    () => [...ids, ...(catalog?.hiddenModels ?? []).map((m) => m.id)],
    [ids, catalog]
  )
  const [draft, setDraft] = useState<string | null>(null)
  const [typing, setTyping] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const inList = ids.includes(value)

  // id salvo que o provedor não conhece: corrige o apelido óbvio (com nota visível) ou avisa
  const fix = value.trim() && allIds.length && !inList ? resolveModelAlias(value, allIds) : null
  const fixTo = fix?.corrected ? fix.id : null
  // modelo salvo que existe no provedor mas ficou fora da lista curada (lento/sem pt-BR)
  const hiddenSaved = curated && !!fix && !fix.corrected
  const slowWarning = hiddenSaved
    ? (callTtsWarning(family, value) ?? 'Modelo lento para chamada — escolha um da lista.')
    : null
  // nota guardada durante o render (padrão "estado derivado do render anterior"): sobrevive ao
  // valor novo que a correção grava
  if (fixTo && note !== correctionNote(value, fixTo)) setNote(correctionNote(value, fixTo))
  useEffect(() => {
    if (fixTo) onCommit(fixTo)
  }, [fixTo, onCommit])

  const unknown = !!value.trim() && ids.length > 0 && !inList && !fix
  const showText = !models.length || typing
  const what = capability === 'stt' ? 'transcrição' : 'fala'
  return (
    <div>
      {!showText ? (
        <Select
          value={value || null}
          label={`Modelo de ${what}`}
          className="h-8 w-full max-w-[460px]"
          menuMinWidth={460}
          placeholder="Escolha um modelo…"
          onChange={(v) => {
            if (v === OTHER_MODEL) {
              setTyping(true)
              setDraft(value)
              return
            }
            setNote(null)
            onCommit(v)
          }}
          options={[
            ...models.map((m) => ({
              value: m.id,
              label: (
                <>
                  {m.label}
                  <ModelLatencyBadge m={m} />
                </>
              ),
              description: [m.id, m.slow ? 'lento para a chamada' : null, m.priceHint]
                .filter(Boolean)
                .join(' · ')
            })),
            ...(value && !inList
              ? [
                  {
                    value,
                    label: `${value} (${hiddenSaved ? 'lento para chamada' : 'não listado'})`,
                    description: hiddenSaved ? 'id salvo — fora da lista testada' : 'id salvo'
                  }
                ]
              : []),
            // lista curada: o id livre fica no "Avançado" abaixo (não testado para chamada)
            ...(curated
              ? []
              : [
                  {
                    value: OTHER_MODEL,
                    label: 'Outro id (digitar)…',
                    description: 'Id livre do modelo'
                  }
                ])
          ]}
        />
      ) : (
        <div className="flex items-center gap-1.5">
          <input
            type="text"
            value={draft ?? value}
            spellCheck={false}
            aria-label={`Modelo de ${what}`}
            data-testid={testId}
            placeholder={placeholder}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => {
              const v = (draft ?? value).trim()
              setDraft(null)
              setNote(null)
              if (v !== value) onCommit(v)
            }}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
            className="field h-8 w-full max-w-[460px] px-2 py-0 font-mono text-[12px]"
          />
          {models.length > 0 && (
            <Button size="sm" variant="ghost" onClick={() => setTyping(false)}>
              Lista
            </Button>
          )}
        </div>
      )}
      {!showText && <span className="sr-only" data-testid={testId} data-value={value} />}
      {curated && showText && models.length > 0 && (
        <p className="mt-1 text-[11px] text-warning" data-testid={`${testId}-untested`}>
          Id livre: não testado para chamada (pode demorar a falar ou não falar pt-BR).
        </p>
      )}
      {slowWarning && (
        <div
          className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-warning"
          role="alert"
          data-testid={`${testId}-slow`}
        >
          <span className="flex items-center gap-1">
            <TriangleAlert className="size-3 shrink-0" /> {slowWarning}
          </span>
          {recommended && (
            <Button
              size="sm"
              variant="secondary"
              data-testid={`${testId}-use-recommended`}
              onClick={() => {
                setTyping(false)
                recommended.onUse()
              }}
            >
              Usar {recommended.label}
            </Button>
          )}
        </div>
      )}
      <CatalogStatus state={state} kind="modelos" />
      {curated && !showText && (
        <button
          type="button"
          data-testid={`${testId}-other`}
          onClick={() => {
            setTyping(true)
            setDraft(value)
          }}
          className="mt-0.5 inline-flex items-center gap-1 rounded px-1 text-[11px] text-subtle hover:bg-hover hover:text-fg"
        >
          <ChevronRight className="size-3" /> Avançado: outro modelo (ID) — não testado para chamada
        </button>
      )}
      {note && (
        <p
          className="mt-1 text-[11px] text-accent-strong"
          role="status"
          data-testid={`${testId}-corrected`}
        >
          {note}
        </p>
      )}
      {unknown && (
        <p
          className="mt-1 flex items-center gap-1 text-[11px] text-warning"
          role="alert"
          data-testid={`${testId}-unknown`}
        >
          <TriangleAlert className="size-3 shrink-0" /> O provedor não lista “{value}” — escolha um
          modelo da lista (a request pode falhar).
        </p>
      )}
      {!catalog && !loading && !error && null}
    </div>
  )
}

/** Linha de estado da descoberta: carregando, N itens · fonte · atualizar, erro/dica visíveis. */
export function CatalogStatus({
  state,
  kind
}: {
  state: VoiceCatalogState
  kind: 'modelos' | 'vozes'
}): React.JSX.Element | null {
  const { catalog, loading, error, reload } = state
  if (kind === 'vozes' && !error && !catalog?.error) return null
  const fail = error ?? catalog?.error ?? null
  const count = kind === 'modelos' ? (catalog?.models.length ?? 0) : (catalog?.voices.length ?? 0)
  const source =
    catalog?.source === 'static'
      ? 'lista embutida'
      : catalog && catalog.source !== 'none'
        ? `listados pelo ${FAMILY_LABEL[catalog.source]}`
        : ''
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-subtle">
      {loading ? (
        <span className="inline-flex items-center gap-1" data-testid={`voice-catalog-loading`}>
          <LoaderCircle className="size-3 animate-spin" /> buscando {kind} no provedor…
        </span>
      ) : (
        catalog &&
        count > 0 &&
        kind === 'modelos' && (
          <span data-testid="voice-catalog-count">
            {count} {kind} {source}
          </span>
        )
      )}
      {!loading && (catalog || fail) && kind === 'modelos' && (
        <button
          type="button"
          onClick={() => reload(true)}
          className="inline-flex items-center gap-1 rounded px-1 text-subtle hover:bg-hover hover:text-fg"
          aria-label={`Atualizar a lista de ${kind}`}
        >
          <RefreshCw className="size-3" /> atualizar
        </button>
      )}
      {fail && !loading && (
        <span
          className="flex basis-full items-start gap-1 text-warning"
          role="alert"
          data-testid="voice-catalog-error"
        >
          <TriangleAlert className="mt-0.5 size-3 shrink-0" /> Não foi possível listar {kind}:{' '}
          {fail}
        </span>
      )}
      {catalog?.hint && !loading && kind === 'modelos' && (
        <span className="basis-full" data-testid="voice-catalog-hint">
          {catalog.hint}
        </span>
      )}
    </div>
  )
}

// ---------------- voz ----------------

const GENDER_LABEL: Record<NonNullable<VoiceCatalogVoice['gender']>, string> = {
  female: 'feminina',
  male: 'masculina',
  neutral: 'neutra'
}

function VoiceBadges({ v }: { v: VoiceCatalogVoice }): React.JSX.Element {
  const badge =
    'shrink-0 whitespace-nowrap rounded-full border border-border px-1.5 py-px text-[10px] leading-4 text-subtle'
  return (
    <>
      {v.recommended && (
        <span className="shrink-0 whitespace-nowrap rounded-full border border-success/30 px-1.5 py-px text-[10px] leading-4 text-success">
          recomendada
        </span>
      )}
      {v.language && <span className={badge}>{v.language}</span>}
      {v.gender && <span className={badge}>{GENDER_LABEL[v.gender]}</span>}
      {v.accent && <span className={badge}>{v.accent}</span>}
    </>
  )
}

/**
 * Seletor de voz: lista do provedor (rótulo + idioma/gênero/sotaque) com ▶ prévia por voz (o
 * `preview_url` do provedor quando existe; senão a frase de prévia sintetizada pelo teste) e
 * "Outra voz (ID)" livre. `allowDefault` = item "voz padrão da API" (omite `voice`).
 */
export function VoicePicker({
  voices,
  value,
  onChange,
  onPreview,
  previewing,
  allowDefault,
  testId = 'tts-voice'
}: {
  voices: VoiceCatalogVoice[]
  value: string | null
  onChange: (voice: string | null) => void
  onPreview: (v: VoiceCatalogVoice) => void
  /** Id da voz com prévia em andamento (carregando/tocando). */
  previewing: { id: string; state: 'busy' | 'playing' } | null
  allowDefault: boolean
  testId?: string
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const [custom, setCustom] = useState('')
  const anchor = useRef<HTMLButtonElement>(null)
  const current = voices.find((v) => v.id === value) ?? null
  const q = filter.trim().toLowerCase()
  const shown = q
    ? voices.filter((v) =>
        [v.id, v.label, v.language, v.accent].some((x) => x?.toLowerCase().includes(q))
      )
    : voices
  const pick = (id: string | null): void => {
    onChange(id)
    setOpen(false)
    setFilter('')
    anchor.current?.focus()
  }
  return (
    <div>
      <div className="flex items-center gap-1.5">
        <button
          ref={anchor}
          type="button"
          aria-label="Voz da fala"
          aria-haspopup="dialog"
          aria-expanded={open}
          data-testid={testId}
          data-value={value ?? ''}
          onClick={() => setOpen((o) => !o)}
          className={cn(
            'field no-drag flex h-8 w-full max-w-[360px] items-center gap-2 text-left',
            open && 'border-border-strong'
          )}
        >
          <span className="flex min-w-0 flex-1 items-center gap-1.5 truncate">
            {current ? (
              <>
                <span className="truncate">{current.label}</span>
                <VoiceBadges v={current} />
              </>
            ) : value ? (
              <span className="truncate font-mono text-[12px]">{value}</span>
            ) : (
              <span className="text-subtle">
                {allowDefault ? 'Voz padrão da API' : 'Escolha uma voz…'}
              </span>
            )}
          </span>
          <ChevronDown className={cn('size-3.5 shrink-0 text-subtle', open && 'rotate-180')} />
        </button>
        {(current || value) && (
          <PreviewButton
            label={current?.label ?? value ?? ''}
            state={previewing?.id === (current?.id ?? value) ? previewing.state : null}
            onClick={() => onPreview(current ?? { id: value!, label: value! })}
            testId={`${testId}-preview-current`}
          />
        )}
      </div>
      {value && !current && voices.length > 0 && (
        <p className="mt-1 text-[11px] text-subtle" data-testid={`${testId}-custom-note`}>
          Voz por id (fora da lista do provedor).
        </p>
      )}
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchor={anchor}
        minWidth={380}
        maxHeight={420}
      >
        <div className="flex max-h-[420px] flex-col" data-testid={`${testId}-menu`}>
          {voices.length > 10 && (
            <div className="border-b border-border p-1.5">
              <input
                type="text"
                value={filter}
                autoFocus
                aria-label="Filtrar vozes"
                placeholder="Filtrar por nome, idioma, sotaque…"
                onChange={(e) => setFilter(e.target.value)}
                className="field h-7 w-full px-2 py-0 text-[12px]"
              />
            </div>
          )}
          <ul className="min-h-0 flex-1 overflow-y-auto p-1" aria-label="Vozes">
            {allowDefault && (
              <li>
                <button
                  type="button"
                  onClick={() => pick(null)}
                  className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] hover:bg-hover"
                >
                  <span className="min-w-0 flex-1 text-subtle">Voz padrão da API (sem voice)</span>
                  {value === null && <Check className="size-3.5 text-accent-strong" />}
                </button>
              </li>
            )}
            {shown.map((v) => (
              <li key={v.id} className="flex items-center gap-1 rounded-lg hover:bg-hover">
                <PreviewButton
                  label={v.label}
                  state={previewing?.id === v.id ? previewing.state : null}
                  onClick={() => onPreview(v)}
                  testId={`voice-preview-${v.id}`}
                />
                <button
                  type="button"
                  aria-label={`Escolher a voz ${v.label}`}
                  data-testid={`voice-option-${v.id}`}
                  onClick={() => pick(v.id)}
                  className="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 pr-2.5 text-left text-[13px]"
                >
                  <span className="shrink-0">{v.label}</span>
                  <VoiceBadges v={v} />
                  <span className="ml-auto min-w-0 truncate font-mono text-[10.5px] text-faint">
                    {v.id !== v.label.toLowerCase() ? v.id : ''}
                  </span>
                  {v.id === value && <Check className="size-3.5 shrink-0 text-accent-strong" />}
                </button>
              </li>
            ))}
            {!shown.length && (
              <li className="px-2.5 py-2 text-xs text-subtle">
                {voices.length ? 'Nenhuma voz com esse filtro.' : 'O provedor não listou vozes.'}
              </li>
            )}
          </ul>
          <div className="flex items-center gap-1.5 border-t border-border p-1.5">
            <input
              type="text"
              value={custom}
              spellCheck={false}
              aria-label="Outra voz (ID)"
              data-testid={`${testId}-custom`}
              placeholder="Outra voz (ID)"
              onChange={(e) => setCustom(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && custom.trim()) {
                  e.preventDefault()
                  pick(custom.trim())
                  setCustom('')
                }
              }}
              className="field h-7 min-w-0 flex-1 px-2 py-0 font-mono text-[12px]"
            />
            <Button
              size="sm"
              variant="secondary"
              disabled={!custom.trim()}
              data-testid={`${testId}-custom-use`}
              onClick={() => {
                pick(custom.trim())
                setCustom('')
              }}
            >
              Usar
            </Button>
          </div>
        </div>
      </Popover>
    </div>
  )
}

function PreviewButton({
  label,
  state,
  onClick,
  testId
}: {
  label: string
  state: 'busy' | 'playing' | null
  onClick: () => void
  testId: string
}): React.JSX.Element {
  return (
    <IconButton
      size="sm"
      label={state === 'playing' ? `Parar prévia: ${label}` : `Ouvir prévia: ${label}`}
      data-testid={testId}
      data-state={state ?? 'idle'}
      onClick={onClick}
      disabled={state === 'busy'}
    >
      {state === 'busy' ? (
        <LoaderCircle className="animate-spin" />
      ) : state === 'playing' ? (
        <Square fill="currentColor" />
      ) : (
        <Play />
      )}
    </IconButton>
  )
}

// ---------------- endpoint personalizado (avançado) ----------------

/** Disclosure "Avançado: endpoint personalizado" (fechado por padrão; aberto se a setting é avulsa). */
export function CustomEndpointDisclosure({
  open,
  onToggle,
  testId,
  children
}: {
  open: boolean
  onToggle: () => void
  testId: string
  children: ReactNode
}): React.JSX.Element {
  return (
    <div className="rounded-lg border border-border/70" data-testid={testId}>
      <button
        type="button"
        aria-expanded={open}
        data-testid={`${testId}-toggle`}
        onClick={onToggle}
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-[12px] text-muted hover:text-fg"
      >
        {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        Avançado: endpoint personalizado
      </button>
      {open && <div className="space-y-3 border-t border-border/70 px-2.5 py-2.5">{children}</div>}
    </div>
  )
}

/** Campo de baseUrl com commit no blur/Enter. */
export function BaseUrlField({
  value,
  onCommit,
  testId,
  placeholder,
  label
}: {
  value: string
  onCommit: (v: string) => void
  testId: string
  placeholder: string
  label: string
}): React.JSX.Element {
  const [draft, setDraft] = useState<string | null>(null)
  return (
    <input
      type="text"
      value={draft ?? value}
      spellCheck={false}
      aria-label={label}
      data-testid={testId}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        const v = (draft ?? value).trim()
        setDraft(null)
        if (v !== value) onCommit(v)
      }}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      className="field h-8 w-full max-w-[460px] px-2 py-0 font-mono text-[12px]"
    />
  )
}

// ---------------- chave de API (endpoint personalizado) ----------------

/**
 * Campo da chave (padrão de `WebSearchSettings`): começa VAZIO com a máscara da chave salva no
 * placeholder; colar uma chave mostra "Salvar" (Enter também salva); com chave salva e campo vazio,
 * X remove. Limpar o campo nunca apaga nada. O olho mostra/oculta só o que foi digitado — a chave
 * real não sai do main.
 */
export function ApiKeyField({
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
    <div className="flex max-w-[460px] items-center gap-1.5">
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

// ---------------- avisos ----------------

/** Aviso de erro dispensável (padrão dos avisos de Configurações → Áudio). */
export function DismissibleError({
  error,
  onDismiss,
  testId,
  dismissLabel
}: {
  error: string | null
  onDismiss: () => void
  testId: string
  dismissLabel: string
}): React.JSX.Element | null {
  if (!error) return null
  return (
    <div
      role="alert"
      data-testid={testId}
      className="flex items-center gap-2 rounded-lg border border-danger/30 bg-danger/[0.06] px-2.5 py-1.5 text-[12px] text-danger"
    >
      <TriangleAlert className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1">{error}</span>
      <button
        type="button"
        aria-label={dismissLabel}
        onClick={onDismiss}
        className="shrink-0 rounded-md p-1 transition-colors hover:bg-danger/15"
      >
        <X className="size-3.5" />
      </button>
    </div>
  )
}

// ---------------- motor/modelos locais ----------------

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
  runtimeProblem,
  title = 'Motor local',
  help = 'Transcrição no próprio computador (modos Local e Híbrido) com o whisper.cpp — baixe um modelo abaixo. Os arquivos ficam em userData/models (verificados por tamanho, magic bytes e sha256).',
  children
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
  title?: string
  help?: string
  /** Linha extra abaixo do cabeçalho (ex.: "modelo em uso" no híbrido). */
  children?: ReactNode
}): React.JSX.Element {
  const engine = local?.engine ?? 'whisper.cpp'
  return (
    <div
      className="rounded-xl border border-border bg-elevated/30 px-3 py-2.5"
      data-testid="stt-local-engine"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Label className="mb-0" help={help}>
          {title}
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
      {children}
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
      <LocalModelList
        kind="stt"
        models={models.filter((m) => m.kind !== 'stt' || m.engine === engine)}
        progress={progress}
        onAction={onAction}
      />
    </div>
  )
}

/** Lista dos modelos locais agrupados por engine (nome, descrição, idiomas, tamanho). */
export function LocalModelList({
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
                a.action === 'remove' || a.action === 'cancel' ? (
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
    <div className="mt-2">
      <DismissibleError
        error={error}
        onDismiss={onDismiss}
        testId="voice-model-error"
        dismissLabel="Dispensar erro de modelos locais"
      />
    </div>
  )
}
