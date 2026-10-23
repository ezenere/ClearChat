// Chamada de voz por persona/chat (`ChatConfig.voice`, SPEC → "Chamada de voz — configuração por
// persona/chat"): liga/desliga (★ = herda — no chat, da persona de origem; na persona, do padrão
// global), modelo da chamada + parâmetros (`VoiceCallModelEditor`), tools próprias, o modo do
// prompt (complementar/substituto/nenhum) e o prompt do modo voz. Usada no painel do chat (aba
// Chat) e no editor de personas (aba Chat); precedência chat > persona > global (campos null do
// chat seguem a persona ao vivo). Interjeições/fillers ficam no painel da chamada.
import { Star } from 'lucide-react'
import { useState } from 'react'
import { TOOL_LABELS, TOOL_NAMES } from '@shared/tools'
import type { ChatConfig, ToolName } from '@shared/types'
import {
  DEFAULT_VOICE_CALL_CONFIG,
  VOICE_CALL_PROMPT_MODES,
  resolveVoiceCallConfig,
  resolveVoiceCallEnabled,
  type VoiceCallConfig,
  type VoiceCallPromptMode
} from '@shared/voice'
import { cn } from '../../lib/format'
import { useVoiceSettings } from '../../lib/voice/voiceSettings'
import { useStore } from '../../store'
import { CollapsibleSection, ToggleRow } from '../panel/fields'
import { AutoTextarea, Switch } from '../ui/controls'
import { ApiInfo, C } from '../ui/Tooltip'
import { VoiceCallModelEditor } from './VoiceCallModelEditor'

export function VoiceCallConfigSection({
  cfg,
  patch,
  scope = 'chat'
}: {
  cfg: ChatConfig
  patch: (p: Partial<ChatConfig>) => void
  /** Texto dos rótulos ("neste chat" × "nesta persona"). */
  scope?: 'chat' | 'persona'
}): React.JSX.Element {
  const defaults = useVoiceSettings((s) => s.view.voiceCallDefaults)
  const globalEnabled = defaults.enabled
  // chat: a persona de origem é a camada do meio (chat > persona > global), lida ao vivo
  const presetId = scope === 'chat' ? (cfg.presetId ?? null) : null
  const persona = useStore((s) =>
    presetId ? (s.presets.find((p) => p.id === presetId) ?? null) : null
  )
  const personaVoice = persona?.config.voice ?? null
  const voice: VoiceCallConfig = cfg.voice ?? DEFAULT_VOICE_CALL_CONFIG
  const set = (p: Partial<VoiceCallConfig>): void => patch({ voice: { ...voice, ...p } })
  const where = scope === 'chat' ? 'neste chat' : 'nesta persona'
  const { enabled, source } = resolveVoiceCallEnabled(voice, personaVoice, defaults)
  const resolved = resolveVoiceCallConfig(voice, defaults, personaVoice)
  // o que o "★" herda neste nível (persona no chat; global na persona)
  const inheritedEnabled = personaVoice?.enabled != null ? personaVoice.enabled : globalEnabled
  const inheritedFrom =
    personaVoice?.enabled != null ? `persona ${persona?.name ?? ''}`.trim() : 'global'
  const changed =
    voice.enabled !== null ||
    !!voice.model ||
    !!voice.tools ||
    !!voice.voicePrompt?.trim() ||
    !!voice.promptMode
  const summary = !enabled
    ? source === 'persona' && scope === 'chat'
      ? 'desligada pela persona'
      : 'desligada'
    : [
        resolved.model && 'modelo próprio',
        voice.tools && 'tools próprias',
        resolved.promptMode !== 'append'
          ? resolved.promptMode === 'replace'
            ? 'prompt substituto'
            : 'sem prompt de voz'
          : resolved.voicePrompt && 'prompt'
      ]
        .filter(Boolean)
        .join(' · ') || (voice.enabled === null ? 'padrão' : 'ligada')
  // modelo herdado quando vazio neste nível (mensagem do editor)
  const inheritedModel =
    scope === 'chat' && personaVoice?.model
      ? `o da persona (${personaVoice.model.model})`
      : defaults.model
        ? `o padrão global (${defaults.model.model})`
        : scope === 'chat'
          ? `o modelo do chat (${cfg.model || '—'})`
          : 'o modelo do chat'
  return (
    <CollapsibleSection
      id={`voice-call-${scope}`}
      title="Chamada de voz"
      section="voice-call"
      summary={{ text: summary, changed }}
      warning={!enabled ? `Chamada de voz desligada ${where}` : undefined}
      help={
        'Conversa falada com o agente (telefone no composer). Aqui: se a chamada fica disponível ' +
        `${where} e o que muda só nos turnos de voz — modelo e parâmetros, tools e o prompt do modo voz. ` +
        'Sem override, a chamada usa o modelo e as tools do próprio chat (com o raciocínio desligado).\nO histórico de um turno de voz é igual ao de um turno digitado; a config salva do chat nunca muda.'
      }
    >
      <div data-testid="voice-call-config" className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13px] text-fg/90">Disponível {where}</span>
          <div
            role="radiogroup"
            aria-label={`Chamada de voz ${where}`}
            data-testid="voice-call-enabled"
            data-effective={enabled ? 'on' : 'off'}
            className="flex rounded-lg border border-border bg-bg/60 p-0.5"
          >
            {([null, true, false] as const).map((v) => {
              const selected = voice.enabled === v
              return (
                <button
                  key={String(v)}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  data-value={v === null ? 'inherit' : v ? 'on' : 'off'}
                  onClick={() => set({ enabled: v })}
                  title={
                    v === null
                      ? inheritedFrom === 'global'
                        ? 'Segue Configurações → Áudio → Chamada de voz disponível'
                        : `Segue a ${inheritedFrom}`
                      : undefined
                  }
                  className={cn(
                    'flex items-center gap-1 rounded-md px-2 py-0.5 text-[11.5px] transition-colors',
                    selected ? 'bg-active text-fg shadow-sm' : 'text-subtle hover:text-fg'
                  )}
                >
                  {v === null ? (
                    <>
                      <Star aria-hidden className="size-2.5 fill-current opacity-70" />
                      {inheritedFrom === 'global' ? 'Padrão' : 'Da persona'} (
                      {inheritedEnabled ? 'ligada' : 'desligada'})
                    </>
                  ) : v ? (
                    'Ligada'
                  ) : (
                    'Desligada'
                  )}
                </button>
              )
            })}
          </div>
        </div>
        {!enabled && (
          <p data-testid="voice-call-disabled-note" className="text-[11.5px] text-warning">
            {source === 'persona' && scope === 'chat'
              ? `A persona “${persona?.name ?? ''}” desliga a chamada: o telefone fica desabilitado neste chat. Escolha “Ligada” para usar mesmo assim.`
              : source === 'global'
                ? 'Desligada em Configurações → Áudio: o telefone some dos chats sem override.'
                : `O telefone fica desabilitado ${scope === 'chat' ? 'neste chat' : 'nos chats desta persona (um chat pode religar)'}.`}
          </p>
        )}
        {enabled && (
          <>
            <VoiceCallModelEditor
              value={voice.model}
              onChange={(model) => set({ model })}
              scope={scope}
              inherited={inheritedModel}
            />
            <ToggleRow
              label="Tools próprias na chamada"
              help="Desligado: as mesmas tools do chat. Ligado: só as tools marcadas abaixo valem nos turnos de voz (nenhuma marcada = a chamada não usa tools)."
              checked={!!voice.tools?.enabledTools}
              onChange={(on) =>
                set({
                  tools: on
                    ? {
                        enabledTools: [...cfg.enabledTools],
                        maxToolOutputChars: voice.tools?.maxToolOutputChars ?? null
                      }
                    : null
                })
              }
            />
            {voice.tools?.enabledTools && (
              <VoiceToolsList
                tools={voice.tools.enabledTools}
                onChange={(enabledTools) =>
                  set({
                    tools: {
                      enabledTools,
                      maxToolOutputChars: voice.tools?.maxToolOutputChars ?? null
                    }
                  })
                }
              />
            )}
            <VoicePromptModeField
              value={voice.promptMode ?? null}
              inherited={
                scope === 'chat' && personaVoice?.promptMode ? personaVoice.promptMode : 'append'
              }
              inheritedFrom={scope === 'chat' && personaVoice?.promptMode ? 'persona' : 'padrão'}
              basePromptOn={defaults.basePromptEnabled}
              onChange={(promptMode) => set({ promptMode })}
            />
            {resolved.promptMode !== 'none' && (
              <VoicePromptField
                value={voice.voicePrompt ?? ''}
                inheritedText={
                  scope === 'chat' && !voice.voicePrompt
                    ? (personaVoice?.voicePrompt ?? null)
                    : null
                }
                mode={resolved.promptMode}
                onCommit={(text) => set({ voicePrompt: text.trim() ? text : null })}
              />
            )}
          </>
        )}
      </div>
    </CollapsibleSection>
  )
}

const PROMPT_MODE_LABEL: Record<VoiceCallPromptMode, string> = {
  append: 'Complementar',
  replace: 'Substituto',
  none: 'Nenhum'
}
const PROMPT_MODE_HELP: Record<VoiceCallPromptMode, string> = {
  append: 'System prompt normal + o prompt do modo voz no fim (padrão).',
  replace: 'Na chamada, o prompt do modo voz SUBSTITUI o system prompt normal.',
  none: 'Sem prompt de voz: só o system prompt normal (nem o prompt-base global de voz).'
}

/** Como o prompt do modo voz compõe com o system prompt (★ = herda da persona/padrão). */
function VoicePromptModeField({
  value,
  inherited,
  inheritedFrom,
  basePromptOn,
  onChange
}: {
  value: VoiceCallPromptMode | null
  inherited: VoiceCallPromptMode
  inheritedFrom: 'persona' | 'padrão'
  basePromptOn: boolean
  onChange: (mode: VoiceCallPromptMode | null) => void
}): React.JSX.Element {
  const effective = value ?? inherited
  return (
    <div>
      <div className="mb-1.5 flex items-center gap-1.5">
        <span className="text-xs font-medium text-muted">Prompt na chamada</span>
        <ApiInfo title="Como o prompt do modo voz entra nas requests da chamada">
          <p>
            <b>Complementar</b>: system prompt normal + prompt-base de voz + prompt do modo voz.
          </p>
          <p>
            <b>Substituto</b>: prompt-base de voz + prompt do modo voz NO LUGAR do system prompt
            normal (prompt do modo voz vazio = nada a pôr no lugar → como complementar).
          </p>
          <p>
            <b>Nenhum</b>: só o system prompt normal — sem o prompt-base global nem o do modo voz.
          </p>
          <p>
            O prompt-base global (respostas curtas, sem markdown) está{' '}
            {basePromptOn ? 'ligado' : 'desligado'} em Configurações → Áudio → Chamada de voz.
          </p>
        </ApiInfo>
      </div>
      <div
        role="radiogroup"
        aria-label="Prompt na chamada"
        data-testid="voice-call-prompt-mode"
        data-effective={effective}
        className="flex rounded-lg border border-border bg-bg/60 p-0.5"
      >
        {([null, ...VOICE_CALL_PROMPT_MODES] as const).map((m) => {
          const selected = value === m
          return (
            <button
              key={m ?? 'inherit'}
              type="button"
              role="radio"
              aria-checked={selected}
              data-value={m ?? 'inherit'}
              title={
                m
                  ? PROMPT_MODE_HELP[m]
                  : `Herda (${inheritedFrom}): ${PROMPT_MODE_LABEL[inherited]}`
              }
              onClick={() => onChange(m)}
              className={cn(
                'flex min-w-0 flex-1 items-center justify-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] transition-colors',
                selected ? 'bg-active text-fg shadow-sm' : 'text-subtle hover:text-fg'
              )}
            >
              {m ? (
                PROMPT_MODE_LABEL[m]
              ) : (
                <>
                  <Star aria-hidden className="size-2.5 shrink-0 fill-current opacity-70" />
                  {PROMPT_MODE_LABEL[inherited]}
                </>
              )}
            </button>
          )
        })}
      </div>
      <p className="mt-1 text-[11px] text-subtle">{PROMPT_MODE_HELP[effective]}</p>
    </div>
  )
}

function VoiceToolsList({
  tools,
  onChange
}: {
  tools: ToolName[]
  onChange: (tools: ToolName[]) => void
}): React.JSX.Element {
  return (
    <div
      data-testid="voice-call-tools"
      className="-mx-1.5 max-h-[220px] space-y-px overflow-y-auto rounded-lg border border-border/60 py-1"
    >
      {TOOL_NAMES.map((t) => {
        const on = tools.includes(t)
        return (
          <div
            key={t}
            className="flex h-7 items-center gap-2.5 rounded-lg px-2.5 hover:bg-hover/50"
          >
            <Switch
              size="sm"
              checked={on}
              label={TOOL_LABELS[t]}
              onChange={(v) =>
                onChange(
                  v
                    ? TOOL_NAMES.filter((n) => n === t || tools.includes(n))
                    : tools.filter((n) => n !== t)
                )
              }
            />
            <span
              className={cn(
                'min-w-0 flex-1 truncate text-[12px]',
                on ? 'text-fg/90' : 'text-subtle'
              )}
            >
              {TOOL_LABELS[t]}
            </span>
            <span className="truncate font-mono text-[10.5px] text-faint">{t}</span>
          </div>
        )
      })}
    </div>
  )
}

/** Acréscimo ao system prompt no modo voz (rascunho local; grava no blur). */
function VoicePromptField({
  value,
  inheritedText,
  mode,
  onCommit
}: {
  value: string
  /** Prompt herdado da persona (chat sem prompt próprio) — mostrado como placeholder. */
  inheritedText: string | null
  mode: VoiceCallPromptMode
  onCommit: (text: string) => void
}): React.JSX.Element {
  // rascunho só enquanto edita; fora disso mostra o valor salvo
  const [draft, setDraft] = useState<string | null>(null)
  return (
    <div>
      <div className="mb-1.5 flex items-center gap-1.5">
        <span className="text-xs font-medium text-muted">Prompt do modo voz</span>
        <ApiInfo
          title={
            mode === 'replace'
              ? 'Substitui o system prompt nos turnos de voz'
              : 'Somado ao system prompt nos turnos de voz'
          }
        >
          <p>
            {mode === 'replace'
              ? 'Vai NO LUGAR do system prompt do chat (depois do prompt-base de voz)'
              : 'Vai no fim do system prompt do chat, separado por uma linha em branco,'}{' '}
            em TODAS as requests feitas durante a chamada (inclusive respostas a mensagens digitadas
            enquanto a chamada está ativa). Fora da chamada nada muda.
          </p>
          <p>
            Ex.: <C>Responda em frases curtas e naturais, sem markdown nem listas.</C>
          </p>
        </ApiInfo>
      </div>
      <AutoTextarea
        value={draft ?? value}
        minRows={2}
        maxRows={8}
        aria-label="Prompt do modo voz"
        data-testid="voice-call-prompt"
        placeholder={
          inheritedText
            ? `da persona: ${inheritedText}`
            : 'ex.: responda em frases curtas e naturais, sem markdown'
        }
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft !== null && draft !== value) onCommit(draft)
          setDraft(null)
        }}
        className="field w-full px-2.5 py-1.5 text-[12.5px] leading-5"
      />
    </div>
  )
}
