// Campo de texto DURANTE o ditado (`voice-draft`): espelho somente-leitura que toma o lugar da
// textarea (mesma fonte, padding, quebra e altura máxima) com o texto digitado na cor normal e o
// ditado no ponto de inserção, translúcido (`voice-partial`) — "Preparando a GPU…"/"Ouvindo…"/
// "Transcrevendo…" em itálico enquanto não há texto. A composição vem de `dictationPreview` (o
// mesmo espaçamento do ✓: o texto não pula ao concluir). A textarea não muda até o desfecho (o
// Composer insere o final com `execCommand('insertText')`). Focável (Esc cancela, Enter conclui e
// envia — atalhos no Composer); o fim do ditado fica sempre à vista (rola por dentro como a
// textarea).
import { forwardRef, useLayoutEffect, useRef } from 'react'
import { cn } from '../../lib/format'
import { dictationPreview, type DictationAnchor } from '../../lib/voice/dictation'
import type { DictationState } from '../../lib/voice/useDictation'

/** Altura máxima = a da textarea do composer (14 linhas de 24 px + padding 14/4). */
const MAX_HEIGHT = 14 * 24 + 18

export const DictationDraft = forwardRef<
  HTMLDivElement,
  {
    /** Rascunho digitado (o valor da textarea, intocado durante o ditado). */
    text: string
    /** Cursor/seleção do início do ditado. */
    anchor: DictationAnchor | null
    partial: string
    state: DictationState
    /**
     * Ditado na GPU esperando o servidor (auto-start — o microfone já grava): o marcador mostra
     * este texto ("Preparando a GPU… <fase>") no lugar do "Ouvindo…" até a GPU ficar pronta.
     */
    gpuText: string | null
    onKeyDown?: (e: React.KeyboardEvent<HTMLDivElement>) => void
  }
>(function DictationDraft({ text, anchor, partial, state, gpuText, onKeyDown }, outerRef) {
  const box = useRef<HTMLDivElement | null>(null)
  const spoken = useRef<HTMLSpanElement>(null)
  const live = partial.trim()
  const marker = gpuText ? gpuText : state === 'stopping' ? 'Transcrevendo…' : 'Ouvindo…'
  const p = dictationPreview(text, anchor, live || marker)
  const kind = live
    ? state === 'stopping'
      ? 'finalizing'
      : 'partial'
    : gpuText
      ? 'gpu'
      : 'placeholder'

  // o fim do que está sendo ditado sempre à vista (rascunho longo rola por dentro)
  useLayoutEffect(() => {
    const el = box.current
    const sp = spoken.current
    if (!el || !sp) return
    const top = sp.offsetTop
    const bottom = top + sp.offsetHeight
    if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight + 4
    else if (top < el.scrollTop) el.scrollTop = Math.max(0, top - 4)
  })

  return (
    <div
      ref={(el) => {
        box.current = el
        if (typeof outerRef === 'function') outerRef(el)
        else if (outerRef) outerRef.current = el
      }}
      role="textbox"
      aria-readonly="true"
      aria-multiline="true"
      aria-label="Mensagem (ditando — Esc cancela, Enter conclui e envia)"
      tabIndex={0}
      data-testid="voice-draft"
      data-state={state}
      onKeyDown={onKeyDown}
      style={{ maxHeight: MAX_HEIGHT }}
      className="relative block min-h-[42px] w-full cursor-default overflow-y-auto px-4 pt-3.5 pb-1 text-[14px] leading-6 break-words whitespace-pre-wrap outline-none"
    >
      {p.before && <span data-testid="voice-draft-typed">{p.before}</span>}
      {p.lead}
      <span
        ref={spoken}
        data-testid="voice-partial"
        data-state={kind}
        className={cn(
          live ? 'text-fg/50' : 'text-fg/35 italic',
          state === 'stopping' && 'animate-pulse-soft'
        )}
      >
        {p.spoken}
      </span>
      {state === 'recording' && (
        <span
          aria-hidden="true"
          className="ml-px inline-block h-[1.05em] w-[1.5px] translate-y-[0.18em] animate-pulse-soft rounded-full bg-accent-strong"
        />
      )}
      {p.trail}
      {p.after && <span data-testid="voice-draft-typed">{p.after}</span>}
    </div>
  )
})
