// Chamada de voz por persona/chat (`ChatConfig.voice`, SPEC → "Chamada de voz — configuração por
// persona/chat"): liga/desliga (★ = segue o padrão global `voiceCallDefaults.enabled`), modelo
// próprio (reusa o `ModelPicker`), tools próprias (lista de tools do chat) e o acréscimo ao system
// prompt no modo voz. Usada no painel do chat (aba Chat) e no editor de personas (aba Chat) — o
// chat herda da persona por snapshot na criação. Interjeições/fillers ficam no painel da chamada.
import { Star } from 'lucide-react'
import { useState } from 'react'
import { TOOL_LABELS, TOOL_NAMES } from '@shared/tools'
import type { ChatConfig, ToolName } from '@shared/types'
import { DEFAULT_VOICE_CALL_CONFIG, type VoiceCallConfig } from '@shared/voice'
import { cn } from '../../lib/format'
import { useVoiceSettings } from '../../lib/voice/voiceSettings'
import { CollapsibleSection, ToggleRow } from '../panel/fields'
import { AutoTextarea, Switch } from '../ui/controls'
import { ModelPicker } from '../ui/ModelPicker'
import { ApiInfo, C } from '../ui/Tooltip'

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
  const globalEnabled = useVoiceSettings((s) => s.view.voiceCallDefaults.enabled)
  const voice: VoiceCallConfig = cfg.voice ?? DEFAULT_VOICE_CALL_CONFIG
  const set = (p: Partial<VoiceCallConfig>): void => patch({ voice: { ...voice, ...p } })
  const enabled = voice.enabled ?? globalEnabled
  const where = scope === 'chat' ? 'neste chat' : 'nesta persona'
  const changed =
    voice.enabled !== null || !!voice.model || !!voice.tools || !!voice.voicePrompt?.trim()
  const summary = !enabled
    ? 'desligada'
    : [
        voice.model && 'modelo próprio',
        voice.tools && 'tools próprias',
        voice.voicePrompt && 'prompt'
      ]
        .filter(Boolean)
        .join(' · ') || (voice.enabled === null ? 'padrão' : 'ligada')
  return (
    <CollapsibleSection
      id={`voice-call-${scope}`}
      title="Chamada de voz"
      section="voice-call"
      summary={{ text: summary, changed }}
      help={
        'Conversa falada com o agente (telefone no composer). Aqui: se a chamada fica disponível ' +
        `${where} e o que muda só nos turnos de voz — modelo, tools e um acréscimo ao system prompt. ` +
        'Sem override, a chamada usa o modelo e as tools do próprio chat.\nO histórico de um turno de voz é igual ao de um turno digitado; a config salva do chat nunca muda.'
      }
    >
      <div data-testid="voice-call-config" className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13px] text-fg/90">Disponível {where}</span>
          <div
            role="radiogroup"
            aria-label={`Chamada de voz ${where}`}
            data-testid="voice-call-enabled"
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
                      ? 'Segue Configurações → Áudio → Chamada de voz disponível'
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
                      Padrão ({globalEnabled ? 'ligada' : 'desligada'})
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
        {enabled && (
          <>
            <ToggleRow
              label="Modelo próprio na chamada"
              help="Desligado: a chamada usa o modelo do chat. Ligado: os turnos de voz usam o modelo escolhido (útil para um modelo mais rápido na conversa falada)."
              checked={!!voice.model}
              onChange={(on) =>
                set({
                  model: on ? { providerId: cfg.providerId, model: cfg.model, params: {} } : null
                })
              }
            />
            {voice.model && (
              <div data-testid="voice-call-model">
                <ModelPicker
                  value={{ providerId: voice.model.providerId, model: voice.model.model }}
                  onChange={(ref) =>
                    set({
                      model: {
                        providerId: ref.providerId,
                        model: ref.model,
                        params: voice.model?.params ?? {}
                      }
                    })
                  }
                />
              </div>
            )}
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
            <VoicePromptField
              value={voice.voicePrompt ?? ''}
              onCommit={(text) => set({ voicePrompt: text.trim() ? text : null })}
            />
          </>
        )}
      </div>
    </CollapsibleSection>
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
  onCommit
}: {
  value: string
  onCommit: (text: string) => void
}): React.JSX.Element {
  // rascunho só enquanto edita; fora disso mostra o valor salvo
  const [draft, setDraft] = useState<string | null>(null)
  return (
    <div>
      <div className="mb-1.5 flex items-center gap-1.5">
        <span className="text-xs font-medium text-muted">Prompt do modo voz</span>
        <ApiInfo title="Somado ao system prompt nos turnos de voz">
          <p>
            Vai no fim do system prompt do chat, separado por uma linha em branco, em TODAS as
            requests feitas durante a chamada (inclusive respostas a mensagens digitadas enquanto a
            chamada está ativa). Fora da chamada nada muda.
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
        placeholder="ex.: responda em frases curtas e naturais, sem markdown"
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
