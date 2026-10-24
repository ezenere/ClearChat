// Peças compartilhadas das seções de Transcrição (STT) e Fala (TTS) de Configurações → Áudio:
// seletor de PROVEDOR (só os cadastrados em Configurações → Provedores que servem a capacidade +
// as opções locais embutidas — o cadastro de endpoint fica centralizado em Provedores), seletor de
// MODELO = o mesmo do chat
// (`ModelPicker`, agrupado por provedor, com a latência medida/pt-BR à direita), seletor de VOZ no
// mesmo desenho (busca, grupos, ▶ prévia por linha), motor/modelos locais e avisos. A chave real
// nunca vem ao renderer (o main lista e sintetiza com ela).
import {
  Check,
  ChevronDown,
  CornerDownLeft,
  Download,
  LoaderCircle,
  Play,
  Search,
  Settings2,
  Square,
  TriangleAlert,
  X
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { VoiceModelInfo } from '@shared/ipc'
import type { ModelInfo } from '@shared/types'
import type { SttLocalConfig } from '@shared/voice'
import {
  callTtsWarning,
  formatLatency,
  resolveModelAlias,
  voiceProviderSupport,
  type VoiceCapability,
  type VoiceCatalogModel,
  type VoiceCatalogVoice,
  type VoiceProviderSupport
} from '@shared/voiceCatalog'
import type { ModelRef } from '@shared/models'
import { cn } from '../../lib/format'
import type { PickerModels } from '../../lib/modelPicker'
import type { VoiceCatalogs } from '../../lib/voice/useVoiceCatalogs'
import {
  GPU_SOURCE,
  LOCAL_SOURCE,
  voiceProvidersFor,
  type ProviderOption
} from '../../lib/voice/voiceSettingsHelpers'
import {
  formatModelLanguages,
  formatModelSize,
  modelAction,
  type LocalModelAction
} from '../../lib/voice/modelList'
import { useStore } from '../../store'
import { Button, IconButton, Label } from '../ui/controls'
import { Popover } from '../ui/layers'
import { ModelPicker, type ModelPickerSource } from '../ui/ModelPicker'
import { Select } from '../ui/Select'
import { CARD, WarnNote } from './audioUi'

const FAMILY_LABEL: Record<VoiceProviderSupport, string> = {
  openrouter: 'OpenRouter',
  elevenlabs: 'ElevenLabs',
  openai: 'OpenAI-compatível'
}

const isLocalUrl = (url: string): boolean => {
  try {
    const h = new URL(url).hostname
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]'
  } catch {
    return false
  }
}

// ---------------- provedor ----------------

/**
 * Provedor da transcrição/fala: os provedores de Configurações → Provedores que servem a
 * capacidade (um servidor local OpenAI-compatível cadastrado lá — `localhost`, sem chave — também
 * vale) + as opções embutidas: motor local (whisper.cpp / Kokoro) e "Local (GPU)" (Modo avançado).
 * `value` = providerId, `LOCAL_SOURCE`, `GPU_SOURCE` ou null (nenhum escolhido / provedor apagado).
 */
export function VoiceSourceSelect({
  capability,
  providers,
  value,
  onChange,
  local,
  gpu,
  testId
}: {
  capability: VoiceCapability
  providers: ProviderOption[]
  value: string | null
  onChange: (v: string) => void
  local: { label: string; description: string }
  /** null = backend da GPU ausente neste build. */
  gpu: { enabled: boolean; description: string } | null
  testId: string
}): React.JSX.Element {
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const usable = voiceProvidersFor(providers, capability)
  const what = capability === 'stt' ? 'transcrição' : 'fala'
  return (
    <div data-testid={testId}>
      <Select
        value={value}
        label={capability === 'stt' ? 'Provedor da transcrição' : 'Provedor da fala'}
        placeholder="Escolha um provedor…"
        onChange={onChange}
        options={[
          ...usable.map((p) => {
            const fam = voiceProviderSupport(p)
            return {
              value: p.id,
              label: p.name,
              description: [
                fam ? FAMILY_LABEL[fam] : null,
                p.baseUrl,
                isLocalUrl(p.baseUrl) ? 'servidor local' : null
              ]
                .filter(Boolean)
                .join(' · ')
            }
          }),
          { value: LOCAL_SOURCE, label: local.label, description: local.description },
          ...(gpu
            ? [
                {
                  value: GPU_SOURCE,
                  label: 'Local (GPU)',
                  description: gpu.description,
                  disabled: !gpu.enabled && value !== GPU_SOURCE
                }
              ]
            : [])
        ]}
      />
      {!usable.length && (
        <p
          className="mt-1.5 flex flex-wrap items-center gap-x-1.5 text-[11.5px] text-subtle"
          data-testid={`${testId}-empty`}
        >
          Nenhum provedor cadastrado serve {what}. Cadastre o OpenRouter, a OpenAI, o Groq
          {capability === 'tts' ? ', o ElevenLabs' : ''} ou um servidor local OpenAI-compatível em
          <button
            type="button"
            onClick={() => setSettingsOpen(true, 'providers')}
            className="inline-flex items-center gap-1 text-accent-strong hover:underline"
          >
            <Settings2 className="size-3" /> Provedores
          </button>
        </p>
      )}
    </div>
  )
}

// ---------------- modelo ----------------

const correctionNote = (from: string, to: string): string =>
  `Modelo corrigido: “${from}” → “${to}” (o id que este provedor usa).`

/** Badge de latência medida ("~0,5 s") / "lento" (meta à direita da linha do modelo). */
function ModelLatencyBadge({ m }: { m: VoiceCatalogModel }): React.JSX.Element | null {
  if (m.latencyMs == null && !m.slow) return null
  return (
    <span
      className={cn(
        'inline-block rounded-full border px-1.5 py-px text-[10px] leading-4 tabular-nums',
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
 * Modelo de STT/TTS no MESMO seletor do chat (`ModelPicker`): todos os provedores de voz numa lista
 * agrupada (contagem, busca "em todos os provedores ou digitar um ID", recarregar), com a latência
 * medida e o pt-BR à direita. Escolher um modelo de outro grupo troca o provedor junto. Lista
 * CURADA (TTS no OpenRouter/ElevenLabs): só os modelos medidos para a chamada; um id livre é aceito
 * com o aviso "não testado para chamada"; um salvo lento mostra a troca de um clique. Id fora da
 * lista com UM equivalente óbvio é corrigido sozinho (nota visível).
 */
export function VoiceModelField({
  capability,
  catalogs,
  providers,
  value,
  onChange,
  testId,
  family = null,
  recommended
}: {
  capability: VoiceCapability
  catalogs: VoiceCatalogs
  /** Provedores cadastrados (filtrados pela capacidade aqui). */
  providers: ProviderOption[]
  /** Provedor + modelo salvos (providerId null = nenhum provedor escolhido: sem lista). */
  value: { providerId: string | null; model: string }
  onChange: (ref: ModelRef) => void
  testId: string
  family?: VoiceProviderSupport | null
  recommended?: { label: string; onUse: () => void }
}): React.JSX.Element {
  const usable = useMemo(() => voiceProvidersFor(providers, capability), [providers, capability])
  const { entries, load } = catalogs
  const state = catalogs.stateFor(value.providerId)
  const catalog = state.catalog
  const what = capability === 'stt' ? 'transcrição' : 'fala'

  // fonte do seletor: um grupo por provedor de voz (listas do catálogo, memoizadas)
  const byKey = useMemo(() => {
    const m = new Map<string, VoiceCatalogModel>()
    for (const [pid, e] of Object.entries(entries))
      for (const x of e?.catalog?.models ?? []) m.set(`${pid}\u0000${x.id}`, x)
    return m
  }, [entries])
  const source = useMemo<ModelPickerSource>(() => {
    const models: Record<string, PickerModels | undefined> = {}
    for (const p of usable) {
      const e = entries[p.id]
      if (!e) continue
      const list: ModelInfo[] = (e.catalog?.models ?? []).map((x) => ({ id: x.id, name: x.label }))
      models[p.id] = {
        status:
          e.status === 'loading' && !list.length
            ? 'loading'
            : e.status === 'error'
              ? 'error'
              : 'ok',
        list,
        ...(e.error || e.catalog?.error ? { error: e.error ?? e.catalog?.error ?? undefined } : {})
      }
    }
    return { providers: usable.map((p) => ({ id: p.id, name: p.name })), models, load }
  }, [usable, entries, load])

  const models = useMemo(() => catalog?.models ?? [], [catalog])
  const ids = useMemo(() => models.map((m) => m.id), [models])
  const curated = !!catalog?.curated
  const allIds = useMemo(
    () => [...ids, ...(catalog?.hiddenModels ?? []).map((m) => m.id)],
    [ids, catalog]
  )
  const [note, setNote] = useState<string | null>(null)
  const cur = value.model.trim()
  const inList = ids.includes(cur)
  const fix = cur && allIds.length && !inList ? resolveModelAlias(cur, allIds) : null
  const fixTo = fix?.corrected ? fix.id : null
  const hiddenSaved = curated && !!fix && !fix.corrected
  const slowWarning = hiddenSaved
    ? (callTtsWarning(family, cur) ?? 'Modelo lento para chamada — escolha um da lista.')
    : null
  if (fixTo && note !== correctionNote(cur, fixTo)) setNote(correctionNote(cur, fixTo))
  const pid = value.providerId
  useEffect(() => {
    if (fixTo && pid) onChange({ providerId: pid, model: fixTo })
  }, [fixTo, pid, onChange])
  const unknown = !!cur && ids.length > 0 && !inList && !fix && !curated
  const untested = curated && !!cur && !inList && !fix
  const fail = state.error ?? catalog?.error ?? null

  return (
    <div>
      <ModelPicker
        value={pid && cur ? { providerId: pid, model: cur } : null}
        onChange={(ref) => {
          setNote(null)
          onChange(ref)
        }}
        source={source}
        testId={testId}
        label={`Modelo de ${what}`}
        placeholder={pid ? 'Escolha um modelo…' : 'Escolha o provedor acima'}
        emptyText={`Nenhum provedor cadastrado serve ${what}.`}
        badges={(p, m) => {
          const x = byKey.get(`${p}\u0000${m.id}`)
          return x?.ptVoices?.length ? (
            <span className="shrink-0 rounded-full border border-border px-1.5 py-px text-[10px] leading-4 text-subtle">
              pt-BR
            </span>
          ) : null
        }}
        meta={(p, m) => {
          const x = byKey.get(`${p}\u0000${m.id}`)
          if (!x) return null
          return (
            <span className="flex flex-col items-end gap-0.5">
              <ModelLatencyBadge m={x} />
              {x.priceHint && <span className="text-[10px] text-faint">{x.priceHint}</span>}
            </span>
          )
        }}
      />
      <div className="mt-1.5 space-y-1 empty:hidden">
        {state.loading && (
          <p
            className="flex items-center gap-1 text-[11.5px] text-subtle"
            data-testid="voice-catalog-loading"
          >
            <LoaderCircle className="size-3 animate-spin" /> buscando modelos no provedor…
          </p>
        )}
        {!state.loading && catalog && models.length > 0 && (
          <p className="text-[11.5px] text-subtle" data-testid="voice-catalog-count">
            {models.length} modelos
            {catalog.source === 'static'
              ? ' (lista embutida)'
              : catalog.source !== 'none'
                ? ` listados pelo ${FAMILY_LABEL[catalog.source]}`
                : ''}
            {curated ? ' · só os testados para a chamada' : ''}
          </p>
        )}
        {fail && !state.loading && (
          <WarnNote testId="voice-catalog-error">Não foi possível listar modelos: {fail}</WarnNote>
        )}
        {catalog?.hint && !state.loading && (
          <p className="text-[11.5px] text-subtle" data-testid="voice-catalog-hint">
            {catalog.hint}
          </p>
        )}
        {untested && (
          <WarnNote testId={`${testId}-untested`} role="note">
            Id livre “{cur}”: não testado para chamada (pode demorar a falar ou não falar pt-BR).
          </WarnNote>
        )}
        {slowWarning && (
          <div
            className="flex flex-wrap items-center gap-x-2 gap-y-1"
            data-testid={`${testId}-slow`}
          >
            <WarnNote>{slowWarning}</WarnNote>
            {recommended && (
              <Button
                size="sm"
                variant="secondary"
                data-testid={`${testId}-use-recommended`}
                onClick={recommended.onUse}
              >
                Usar {recommended.label}
              </Button>
            )}
          </div>
        )}
        {note && (
          <p
            className="text-[11.5px] text-accent-strong"
            role="status"
            data-testid={`${testId}-corrected`}
          >
            {note}
          </p>
        )}
        {unknown && (
          <WarnNote testId={`${testId}-unknown`}>
            O provedor não lista “{cur}” — escolha um modelo da lista (a request pode falhar).
          </WarnNote>
        )}
      </div>
    </div>
  )
}

// ---------------- voz ----------------

const GENDER_LABEL: Record<NonNullable<VoiceCatalogVoice['gender']>, string> = {
  female: 'feminina',
  male: 'masculina',
  neutral: 'neutra'
}

const BADGE = 'shrink-0 whitespace-nowrap rounded-full border px-1.5 py-px text-[10px] leading-4'

/** Badges de uma voz do catálogo (recomendada, idioma, gênero, sotaque). */
export function VoiceBadges({ v }: { v: VoiceCatalogVoice }): React.JSX.Element {
  return (
    <>
      {v.recommended && (
        <span className={cn(BADGE, 'border-success/30 text-success')}>recomendada</span>
      )}
      {v.language && <span className={cn(BADGE, 'border-border text-subtle')}>{v.language}</span>}
      {v.gender && (
        <span className={cn(BADGE, 'border-border text-subtle')}>{GENDER_LABEL[v.gender]}</span>
      )}
      {v.accent && <span className={cn(BADGE, 'border-border text-subtle')}>{v.accent}</span>}
    </>
  )
}

/** Uma voz no seletor. */
export interface VoicePickerItem {
  id: string
  label: string
  badges?: ReactNode
  /** Texto miúdo à direita (ex.: o id técnico). */
  meta?: ReactNode
}

/** Grupo do seletor (por idioma/sotaque nas vozes de API, por origem nas da GPU). */
export interface VoicePickerGroup {
  key: string
  title: string
  voices: VoicePickerItem[]
  /** Linha extra do grupo (ex.: "Baixar", "Gravar ou enviar…", texto de vazio); recebe o "fechar". */
  extra?: ReactNode | ((close: () => void) => ReactNode)
}

/**
 * Seletor de voz no desenho do seletor de modelo: gatilho com a voz atual (+ ▶ dela), lista com
 * busca, grupos com contagem, ▶ prévia por linha e "Usar “id”" (id livre) quando `allowFree`.
 * `defaultLabel` = item "voz padrão" (valor null).
 */
export function VoicePicker({
  groups,
  value,
  onChange,
  onPreview,
  previewing,
  defaultLabel,
  allowFree = true,
  testId = 'tts-voice',
  optionTestId = 'voice-option',
  previewTestId = 'voice-preview',
  label = 'Voz da fala',
  placeholder = 'Escolha uma voz…'
}: {
  groups: VoicePickerGroup[]
  value: string | null
  onChange: (voice: string | null) => void
  onPreview: (id: string, label: string) => void
  /** Voz com prévia em andamento (carregando/tocando). */
  previewing: { id: string; state: 'busy' | 'playing' } | null
  defaultLabel?: string
  allowFree?: boolean
  testId?: string
  optionTestId?: string
  previewTestId?: string
  label?: string
  placeholder?: string
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const anchor = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const all = groups.flatMap((g) => g.voices)
  const current = all.find((v) => v.id === value) ?? null
  const q = query.trim().toLowerCase()
  const match = (v: VoicePickerItem, g: VoicePickerGroup): boolean =>
    !q ||
    `${v.id} ${v.label} ${g.title} ${typeof v.meta === 'string' ? v.meta : ''}`
      .toLowerCase()
      .includes(q)
  const shown = groups
    .map((g) => ({ ...g, voices: g.voices.filter((v) => match(v, g)) }))
    .filter((g) => g.voices.length || (!q && g.extra))
  const free = allowFree && q && !all.some((v) => v.id === query.trim()) ? query.trim() : null
  const pick = (id: string | null): void => {
    onChange(id)
    setOpen(false)
    setQuery('')
  }
  const previewBtn = (id: string, name: string, tid: string): React.JSX.Element => {
    const st = previewing?.id === id ? previewing.state : null
    return (
      <IconButton
        size="sm"
        label={st === 'playing' ? `Parar prévia: ${name}` : `Ouvir prévia: ${name}`}
        data-testid={tid}
        data-state={st ?? 'idle'}
        disabled={st === 'busy'}
        onClick={(e) => {
          e.stopPropagation()
          onPreview(id, name)
        }}
      >
        {st === 'busy' ? (
          <LoaderCircle className="animate-spin" />
        ) : st === 'playing' ? (
          <Square fill="currentColor" />
        ) : (
          <Play />
        )}
      </IconButton>
    )
  }
  return (
    <div>
      <div className="flex items-center gap-1.5">
        <div
          ref={anchor}
          role="combobox"
          tabIndex={0}
          aria-label={label}
          aria-haspopup="listbox"
          aria-expanded={open}
          data-testid={testId}
          data-value={value ?? ''}
          onClick={() => {
            setOpen((o) => !o)
            setQuery('')
            requestAnimationFrame(() => input.current?.focus())
          }}
          onKeyDown={(e) => {
            if (!open && (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown')) {
              e.preventDefault()
              setOpen(true)
              requestAnimationFrame(() => input.current?.focus())
            }
          }}
          className={cn(
            'field no-drag flex min-w-0 flex-1 cursor-default items-center gap-2',
            open && 'border-border-strong'
          )}
        >
          <span className="flex min-w-0 flex-1 items-center gap-1.5 truncate">
            {current ? (
              <>
                <span className="truncate">{current.label}</span>
                {current.badges}
              </>
            ) : value ? (
              <span className="truncate font-mono text-[12px]">{value}</span>
            ) : (
              <span className="text-subtle">{defaultLabel ?? placeholder}</span>
            )}
          </span>
          <ChevronDown
            className={cn(
              'size-3.5 shrink-0 text-subtle transition-transform',
              open && 'rotate-180'
            )}
          />
        </div>
        {(current || value) &&
          previewBtn(current?.id ?? value!, current?.label ?? value!, `${testId}-preview-current`)}
      </div>
      {value && !current && all.length > 0 && (
        <p className="mt-1 text-[11.5px] text-subtle" data-testid={`${testId}-custom-note`}>
          Voz por id (fora da lista do provedor).
        </p>
      )}
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchor={anchor}
        minWidth={400}
        maxHeight={440}
      >
        <div className="flex max-h-[440px] min-h-0 flex-col" data-testid={`${testId}-menu`}>
          <div className="flex shrink-0 items-center gap-2 border-b border-border px-3">
            <Search className="size-3.5 shrink-0 text-subtle" />
            <input
              ref={input}
              value={query}
              aria-label="Buscar voz"
              data-testid={`${testId}-search`}
              placeholder={
                allowFree
                  ? 'Buscar por nome, idioma ou sotaque — ou digitar um ID…'
                  : 'Buscar por nome, idioma ou sotaque…'
              }
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  const first = shown.find((g) => g.voices.length)?.voices[0]
                  if (first) pick(first.id)
                  else if (free) pick(free)
                }
              }}
              className="h-10 min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-subtle"
            />
          </div>
          <div role="listbox" aria-label="Vozes" className="min-h-0 flex-1 overflow-y-auto pb-1">
            {defaultLabel && !q && (
              <button
                type="button"
                role="option"
                aria-selected={value === null}
                onClick={() => pick(null)}
                className="mx-1 mt-1 flex h-9 w-[calc(100%-8px)] items-center gap-2 rounded-lg px-2.5 text-left text-[13px] hover:bg-hover"
              >
                <span className="min-w-0 flex-1 text-subtle">{defaultLabel}</span>
                {value === null && <Check className="size-3.5 text-accent-strong" />}
              </button>
            )}
            {shown.map((g, gi) => (
              <div key={g.key} data-testid={`${testId}-group-${g.key}`}>
                <div
                  className={cn(
                    'flex h-8 items-center gap-1.5 bg-elevated px-3',
                    (gi > 0 || defaultLabel) && 'border-t border-border/60'
                  )}
                >
                  <span className="truncate text-[11.5px] font-semibold tracking-[0.02em] text-muted">
                    {g.title}
                  </span>
                  <span className="text-[10.5px] text-faint tabular-nums">{g.voices.length}</span>
                </div>
                {g.voices.map((v) => (
                  <div
                    key={v.id}
                    className="group mx-1 flex h-[40px] w-[calc(100%-8px)] items-center gap-1 rounded-lg pr-2.5 pl-1 hover:bg-hover"
                  >
                    {previewBtn(v.id, v.label, `${previewTestId}-${v.id}`)}
                    <button
                      type="button"
                      role="option"
                      aria-selected={v.id === value}
                      aria-label={`Escolher a voz ${v.label}`}
                      data-testid={`${optionTestId}-${v.id}`}
                      onClick={() => pick(v.id)}
                      className="flex h-full min-w-0 flex-1 items-center gap-1.5 text-left text-[13px]"
                    >
                      <span
                        className={cn(
                          'shrink-0',
                          v.id === value ? 'text-accent-strong' : 'text-fg'
                        )}
                      >
                        {v.label}
                      </span>
                      {v.badges}
                      <span className="ml-auto min-w-0 truncate pl-2 font-mono text-[10.5px] text-faint">
                        {v.meta}
                      </span>
                      <span className="flex w-3.5 shrink-0 justify-center">
                        {v.id === value && <Check className="size-3.5 text-accent-strong" />}
                      </span>
                    </button>
                  </div>
                ))}
                {!q && g.extra && (
                  <div className="px-3 py-1.5">
                    {typeof g.extra === 'function' ? g.extra(() => setOpen(false)) : g.extra}
                  </div>
                )}
              </div>
            ))}
            {!shown.length && !free && (
              <div className="px-3 py-3 text-xs text-subtle">
                {all.length ? 'Nenhuma voz com essa busca.' : 'O provedor não listou vozes.'}
              </div>
            )}
            {free && (
              <>
                <div className="flex h-[30px] items-end border-t border-border/60 px-3 pb-1 text-[10.5px] font-semibold tracking-[0.06em] text-faint uppercase">
                  ID livre
                </div>
                <button
                  type="button"
                  role="option"
                  aria-selected={false}
                  data-testid={`${testId}-custom-use`}
                  onClick={() => pick(free)}
                  className="mx-1 flex h-[32px] w-[calc(100%-8px)] items-center gap-2 rounded-lg px-2.5 text-left text-[12.5px] hover:bg-hover"
                >
                  <CornerDownLeft className="size-3.5 shrink-0 text-subtle" />
                  <span className="shrink-0 text-muted">Usar</span>
                  <span className="min-w-0 truncate font-mono text-[11.5px] text-fg">
                    &ldquo;{free}&rdquo;
                  </span>
                  <span className="shrink-0 text-muted">como id de voz</span>
                </button>
              </>
            )}
          </div>
        </div>
      </Popover>
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
  help = 'Transcrição no próprio computador com o whisper.cpp — baixe um modelo abaixo. Os arquivos ficam em userData/models (verificados por tamanho, magic bytes e sha256).',
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
    <div className={cn(CARD, 'px-3.5 py-3')} data-testid="stt-local-engine">
      <div className="flex flex-wrap items-center gap-2">
        <Label className="mb-0" help={help}>
          {title}
        </Label>
        {onEngine ? (
          <Select
            value={engine}
            label="Motor local de transcrição"
            className="h-7 w-[150px] text-[12.5px]"
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
          className={cn(
            BADGE,
            'ml-auto',
            local?.installed ? 'border-success/30 text-success' : 'border-warning/30 text-warning'
          )}
        >
          {local?.installed ? 'instalado' : 'não instalado'}
        </span>
      </div>
      {children}
      {runtimeProblem && (
        <div className="mt-2">
          <WarnNote testId="stt-runtime-warning">
            Motor local não está pronto: {runtimeProblem}
          </WarnNote>
        </div>
      )}
      {error && (
        <div className="mt-2">
          <DismissibleError
            error={error}
            onDismiss={onDismissError}
            testId="voice-model-error"
            dismissLabel="Dispensar erro de modelos locais"
          />
        </div>
      )}
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
    <div className="mt-2.5 space-y-2.5">
      {groups.map((g) => (
        <div key={g.engine} data-testid={`voice-models-${g.engine}`}>
          <div className="mb-1 font-mono text-[10px] tracking-wide text-faint uppercase">
            {g.engine}
          </div>
          <div className="divide-y divide-border/60 overflow-hidden rounded-lg border border-border/70">
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
    <div className="bg-bg/20 px-3 py-2" data-testid={`voice-model-${model.id}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[12.5px] font-medium text-fg/90">{model.name}</span>
        <span
          className={cn(
            BADGE,
            model.state === 'installed'
              ? 'border-success/30 text-success'
              : model.state === 'corrupt'
                ? 'border-danger/30 text-danger'
                : 'border-border text-subtle'
          )}
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
              <span className="text-[10.5px] text-subtle">download indisponível</span>
            </>
          )}
        </span>
      </div>
      <p className="mt-0.5 text-[11.5px] leading-snug text-subtle">{model.description}</p>
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
        <div className="mt-1">
          <WarnNote testId={`voice-model-warning-${model.id}`}>{a.warning}</WarnNote>
        </div>
      )}
    </div>
  )
}
