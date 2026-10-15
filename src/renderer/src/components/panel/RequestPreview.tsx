import hljs from 'highlight.js/lib/core'
import json from 'highlight.js/lib/languages/json'
import { useEffect, useMemo, useState } from 'react'
import type { RequestPreview as Preview } from '@shared/ipc'
import { api, errorMessage } from '../../lib/api'
import { useStore } from '../../store'
import { CopyButton } from '../chat/Markdown'
import { Modal } from '../ui/layers'
import { Spinner } from '../ui/controls'

hljs.registerLanguage('json', json)

function Json({ value }: { value: unknown }): React.JSX.Element {
  const html = useMemo(
    () => hljs.highlight(JSON.stringify(value, null, 2), { language: 'json' }).value,
    [value]
  )
  return (
    <pre
      className="hljs overflow-auto rounded-xl border border-border !bg-[#0d0d12] px-4 py-3 font-mono text-[11.5px] leading-[1.6] break-words whitespace-pre-wrap"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

function PreviewBody({ sessionId }: { sessionId: string }): React.JSX.Element {
  const flushConfig = useStore((s) => s.flushConfig)
  const [res, setRes] = useState<{ data?: Preview; error?: string } | null>(null)

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const chatId = useStore.getState().sessions[sessionId]?.chatId
        if (chatId) await flushConfig(chatId)
        const data = await api.agent.previewRequest(sessionId)
        if (alive) setRes({ data })
      } catch (err) {
        if (alive) setRes({ error: errorMessage(err) })
      }
    })()
    return () => {
      alive = false
    }
  }, [sessionId, flushConfig])

  const data = res?.data
  const full = data
    ? JSON.stringify({ url: data.url, headers: data.headers, body: data.body }, null, 2)
    : ''

  if (!res) {
    return (
      <div className="flex items-center gap-2 py-8 text-xs text-subtle">
        <Spinner /> Montando request…
      </div>
    )
  }
  if (!data) {
    return (
      <div className="rounded-xl border border-danger/25 bg-danger/[0.06] px-3.5 py-3 text-xs text-danger">
        {res.error}
      </div>
    )
  }
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 rounded-xl border border-border bg-bg/50 px-3.5 py-2.5 font-mono text-[12px]">
        <span className="rounded bg-success/10 px-1.5 py-0.5 text-[10.5px] font-semibold text-success">
          POST
        </span>
        <span className="min-w-0 flex-1 truncate text-fg/90">{data.url}</span>
        <span className="flex items-center font-sans">
          <CopyButton text={JSON.stringify(data.body, null, 2)} label="Copiar body" />
          <CopyButton text={full} label="Copiar tudo" />
        </span>
      </div>
      <div>
        <div className="mb-1.5 text-[11px] font-semibold tracking-[0.06em] text-subtle uppercase">
          Headers
        </div>
        <Json value={data.headers} />
      </div>
      <div>
        <div className="mb-1.5 text-[11px] font-semibold tracking-[0.06em] text-subtle uppercase">
          Body
        </div>
        {data.notes?.map((n) => (
          <div
            key={n}
            className="mb-2 rounded-lg border border-accent/20 bg-accent-soft/40 px-3 py-2 text-[11.5px] text-muted"
          >
            {n}
          </div>
        ))}
        <Json value={data.body} />
      </div>
    </div>
  )
}

export function RequestPreviewModal(): React.JSX.Element {
  const sessionId = useStore((s) => s.previewSessionId)
  const setPreview = useStore((s) => s.setPreview)
  return (
    <Modal
      open={!!sessionId}
      onClose={() => setPreview(null)}
      width={880}
      title="Próxima request"
      subtitle="Exatamente o que será enviado na próxima chamada ao modelo (API key mascarada)."
    >
      {sessionId && <PreviewBody key={sessionId} sessionId={sessionId} />}
    </Modal>
  )
}
