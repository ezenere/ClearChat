// Chamadas laterais (juiz do Smart-Approve, resumidor da coleta de contexto, título automático):
// com um modelo de raciocínio obrigatório, avisa e mostra "Tokens de pensamento" (somados ao
// max_tokens da chamada). Modelo em que dá para desligar: só uma linha discreta. Política em
// @shared/sideReasoning (a mesma que o main usa na request). Ver SPEC.md → "Chamadas laterais".
import { Brain } from 'lucide-react'
import { useState } from 'react'
import { normalizeThinkingTokens, SIDE_THINKING } from '@shared/sideReasoning'
import { useSideReasoning } from '../../lib/sideReasoning'
import { C, HelpTip } from '../ui/Tooltip'

export function SideThinkingField({
  providerId,
  model,
  value,
  onChange,
  defaultTokens,
  call,
  testId
}: {
  providerId: string | null | undefined
  model: string | null | undefined
  /** Valor salvo (null/ausente = o padrão). */
  value: number | null | undefined
  onChange: (v: number | null) => void
  defaultTokens: number
  /** Nome da chamada no texto de ajuda (ex.: "do juiz"). */
  call: string
  testId: string
}): React.JSX.Element | null {
  const r = useSideReasoning(providerId, model)
  const [text, setText] = useState(value == null ? '' : String(value))
  const [prev, setPrev] = useState(value)
  if (prev !== value) {
    setPrev(value)
    setText(value == null ? '' : String(value))
  }
  if (!r) return null
  if (r.mode !== 'minimal')
    return r.explicitOff ? (
      <p data-testid={`${testId}-off`} className="text-[10.5px] text-faint">
        Raciocínio desligado nesta chamada.
      </p>
    ) : null
  const commit = (raw: string): void => {
    const n = parseInt(raw, 10)
    if (!raw.trim() || Number.isNaN(n)) return onChange(null)
    const v = normalizeThinkingTokens(n)
    setText(v == null ? '' : String(v))
    onChange(v)
  }
  return (
    <div
      data-testid={testId}
      className="space-y-1.5 rounded-lg border border-warning/25 bg-warning/[0.05] px-2.5 py-2"
    >
      <p
        data-testid={`${testId}-note`}
        className="flex items-start gap-1.5 text-[11.5px] leading-snug text-fg/85"
      >
        <Brain className="mt-px size-3.5 shrink-0 text-warning/80" />
        <span>
          {r.mandatory === false
            ? 'Este modelo pode raciocinar e não dá para garantir que desligue (fora da tabela) — esforço mínimo.'
            : 'Este modelo sempre raciocina (thinking obrigatório) — esforço mínimo.'}
        </span>
      </p>
      <div className="flex items-center gap-2.5">
        <span className="flex min-w-0 flex-1 items-center gap-1.5 text-[12px] text-fg/90">
          Tokens de pensamento
          <HelpTip label="Tokens de pensamento">
            O raciocínio conta no limite de tokens: este valor é <strong>somado</strong> ao{' '}
            <C>max_tokens</C> da chamada {call}, para o pensamento não consumir a resposta (que
            viria vazia ou cortada). Vazio = {defaultTokens.toLocaleString('pt-BR')} (padrão);{' '}
            {SIDE_THINKING.min}–{SIDE_THINKING.max.toLocaleString('pt-BR')}. Só vale em modelos de
            raciocínio obrigatório.
          </HelpTip>
        </span>
        <input
          type="number"
          value={text}
          step={256}
          min={SIDE_THINKING.min}
          max={SIDE_THINKING.max}
          placeholder={String(defaultTokens)}
          aria-label={`Tokens de pensamento ${call}`}
          onChange={(e) => {
            setText(e.target.value)
            const n = parseInt(e.target.value, 10)
            if (!e.target.value.trim()) onChange(null)
            else if (!Number.isNaN(n) && n >= SIDE_THINKING.min && n <= SIDE_THINKING.max)
              onChange(n)
          }}
          onBlur={(e) => commit(e.target.value)}
          className="field h-7 w-[92px] px-2 py-0 text-right font-mono text-[12px] tabular-nums [&::-webkit-inner-spin-button]:opacity-40"
        />
      </div>
    </div>
  )
}
