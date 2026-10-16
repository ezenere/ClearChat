// Falha de conexão com o provedor (erro de rede): card bloqueante no lugar do campo de texto do
// composer, como o questionário. Enter = Tentar de novo · Esc = Cancelar (= Parar).
// Ver SPEC.md → "Falha de conexão (nova tentativa)".
import { RotateCw, WifiOff, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { RetryRequest } from '@shared/types'
import { useStore } from '../../store'
import { Button, Kbd } from '../ui/controls'

export function RetryForm({ request }: { request: RetryRequest }): React.JSX.Element {
  const retryConnection = useStore((s) => s.retryConnection)
  const cancelRetry = useStore((s) => s.cancelRetry)
  const [sending, setSending] = useState(false)
  const retryRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    retryRef.current?.focus()
  }, [request.id])

  const retry = (): void => {
    if (sending) return
    setSending(true)
    void retryConnection(request.id).finally(() => setSending(false))
  }
  const cancel = (): void => {
    if (sending) return
    setSending(true)
    void cancelRetry(request.id).finally(() => setSending(false))
  }

  return (
    <div
      data-testid="retry-card"
      role="alertdialog"
      aria-label="Falha de conexão com o provedor"
      tabIndex={-1}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing) return
        if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          cancel()
        } else if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault()
          // Enter no botão Cancelar focado = Cancelar; senão Tentar de novo
          if ((e.target as HTMLElement).dataset?.action === 'cancel') cancel()
          else retry()
        }
      }}
      className="px-4 pt-3.5 pb-1 outline-none"
    >
      <div className="flex items-start gap-2.5">
        <WifiOff className="mt-0.5 size-4 shrink-0 text-warning" />
        <div className="min-w-0 flex-1">
          <p className="text-[13.5px] font-medium text-fg">Falha de conexão com o provedor</p>
          <p
            data-testid="retry-error"
            className="mt-0.5 line-clamp-3 font-mono text-[11.5px] break-words text-muted"
            title={request.error}
          >
            {request.error}
          </p>
          <p className="mt-1 text-[11.5px] text-subtle">
            {request.providerName ? `${request.providerName} · ` : ''}
            {request.model} · a resposta parcial foi descartada; tentar de novo repete a mesma
            chamada do zero.
          </p>
          <div className="mt-2.5 mb-1 flex flex-wrap items-center gap-2">
            <Button
              ref={retryRef}
              variant="primary"
              size="sm"
              data-action="retry"
              loading={sending}
              onClick={retry}
              icon={<RotateCw className="size-3.5" />}
            >
              Tentar de novo <Kbd>Enter</Kbd>
            </Button>
            <Button
              variant="secondary"
              size="sm"
              data-action="cancel"
              disabled={sending}
              onClick={cancel}
              icon={<X className="size-3.5" />}
            >
              Cancelar <Kbd>Esc</Kbd>
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
