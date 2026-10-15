// Anexos na UI: chips do composer, miniaturas/chips nas mensagens do usuário e lightbox.
import { AudioLines, ChevronDown, FileText, FileType2, TriangleAlert, X } from 'lucide-react'
import { useState } from 'react'
import { createPortal } from 'react-dom'
import {
  attachmentUrl,
  formatSize,
  KIND_LABEL,
  textFileBody,
  type ModalitySupport
} from '@shared/attachments'
import type { AttachmentKind, AttachmentMeta, ContentPart } from '@shared/types'
import { cn } from '../../lib/format'
import type { PendingAttachment } from '../../store'
import { AttachmentApiInfo } from '../apiDocs'
import { Spinner } from '../ui/controls'
import { useEscapeLayer } from '../ui/escape'
import { Tip } from '../ui/Tooltip'

export function KindIcon({
  kind,
  className
}: {
  kind: AttachmentKind
  className?: string
}): React.JSX.Element {
  const Icon = kind === 'pdf' ? FileType2 : kind === 'audio' ? AudioLines : FileText
  return <Icon className={cn('size-4', className)} strokeWidth={1.75} />
}

const KIND_TINT: Record<AttachmentKind, string> = {
  image: 'text-accent-strong bg-accent-soft',
  pdf: 'text-danger/90 bg-danger/10',
  audio: 'text-success/90 bg-success/10',
  text: 'text-muted bg-white/[0.05]'
}

/** Lightbox simples (Esc / clique fora fecha). */
export function Lightbox({
  src,
  name,
  onClose
}: {
  src: string
  name: string
  onClose: () => void
}): React.JSX.Element {
  useEscapeLayer(true, onClose)
  return createPortal(
    <div
      role="dialog"
      aria-label={name}
      className="no-drag fixed inset-0 z-[60] flex animate-fade-in flex-col items-center justify-center gap-3 bg-black/80 p-8 backdrop-blur-sm"
      onMouseDown={onClose}
    >
      <img
        src={src}
        alt={name}
        className="max-h-[86vh] max-w-full animate-pop-in rounded-xl border border-white/10 object-contain shadow-modal"
        onMouseDown={(e) => e.stopPropagation()}
      />
      <span className="max-w-[80vw] truncate text-xs text-muted">{name}</span>
    </div>,
    document.body
  )
}

// ---------- composer ----------

export function ComposerAttachmentChip({
  item,
  support,
  onRemove
}: {
  item: PendingAttachment
  support?: ModalitySupport
  onRemove: () => void
}): React.JSX.Element {
  const info = item.info
  const [zoom, setZoom] = useState(false)
  const warn = support === 'unsupported' || support === 'unknown'
  return (
    <div
      data-attachment-chip={item.name}
      className={cn(
        'group/chip relative flex h-12 max-w-[240px] min-w-0 animate-pop-in items-center gap-2.5 rounded-xl border bg-elevated/80 py-1.5 pr-8 pl-1.5',
        warn ? 'border-warning/35' : 'border-border'
      )}
    >
      {info?.kind === 'image' ? (
        <button
          type="button"
          onClick={() => setZoom(true)}
          className="size-9 shrink-0 overflow-hidden rounded-lg border border-white/5 bg-bg"
          aria-label={`Ver ${item.name}`}
        >
          <img src={attachmentUrl(info.file)} alt="" className="size-full object-cover" />
        </button>
      ) : (
        <span
          className={cn(
            'flex size-9 shrink-0 items-center justify-center rounded-lg',
            info ? KIND_TINT[info.kind] : 'bg-white/[0.04] text-subtle'
          )}
        >
          {info ? <KindIcon kind={info.kind} /> : <Spinner />}
        </span>
      )}
      <div className="min-w-0 leading-tight">
        <div className="truncate text-[12.5px] text-fg/90" title={item.name}>
          {item.name}
        </div>
        <div className="flex items-center gap-1 text-[11px] text-subtle">
          {warn && <TriangleAlert className="size-3 text-warning" />}
          {info ? (
            <>
              {KIND_LABEL[info.kind]} · {formatSize(item.size)}
            </>
          ) : (
            'carregando…'
          )}
          {info && (
            <AttachmentApiInfo meta={info} openRouterParsed={support === 'parsed'} side="top" />
          )}
        </div>
      </div>
      <Tip label="Remover anexo">
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remover ${item.name}`}
          className="absolute top-1 right-1 rounded-md p-1 text-subtle opacity-70 transition-[opacity,color,background-color] group-hover/chip:opacity-100 hover:bg-hover hover:text-fg"
        >
          <X className="size-3.5" />
        </button>
      </Tip>
      {zoom && info && (
        <Lightbox src={attachmentUrl(info.file)} name={item.name} onClose={() => setZoom(false)} />
      )}
    </div>
  )
}

// ---------- mensagens ----------

function ImageThumb({ meta }: { meta: AttachmentMeta }): React.JSX.Element {
  const [zoom, setZoom] = useState(false)
  const [broken, setBroken] = useState(false)
  return (
    <div className="group/att relative">
      {broken ? (
        <div className="flex h-24 w-36 flex-col items-center justify-center gap-1 rounded-xl border border-danger/25 bg-danger/[0.05] px-2 text-center text-[11px] text-danger/90">
          <TriangleAlert className="size-4" />
          arquivo ausente
          <span className="w-full truncate text-subtle">{meta.name}</span>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setZoom(true)}
          aria-label={`Ampliar ${meta.name}`}
          className="block overflow-hidden rounded-xl border border-border bg-bg shadow-[0_4px_16px_-8px_rgb(0_0_0/0.6)] transition-[border-color,transform] hover:border-border-strong"
        >
          <img
            src={attachmentUrl(meta.file)}
            alt={meta.name}
            onError={() => setBroken(true)}
            className="max-h-44 max-w-[260px] min-w-16 object-contain"
          />
        </button>
      )}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center gap-1 rounded-b-xl bg-gradient-to-t from-black/75 to-transparent px-2 pt-5 pb-1 text-[10.5px] text-white/85 opacity-0 transition-opacity group-hover/att:opacity-100">
        <span className="min-w-0 flex-1 truncate">
          {meta.name} · {formatSize(meta.size)}
        </span>
        <span className="pointer-events-auto">
          <AttachmentApiInfo meta={meta} className="text-white/70" />
        </span>
      </div>
      {zoom && (
        <Lightbox src={attachmentUrl(meta.file)} name={meta.name} onClose={() => setZoom(false)} />
      )}
    </div>
  )
}

function FileChip({ meta, text }: { meta: AttachmentMeta; text?: string }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const body = text != null ? textFileBody(text) : null
  return (
    <div className={cn('min-w-0', open && 'w-full')}>
      <div className="flex h-11 max-w-[280px] items-center gap-2.5 rounded-xl border border-border bg-elevated/70 py-1.5 pr-2 pl-1.5">
        <span
          className={cn(
            'flex size-8 shrink-0 items-center justify-center rounded-lg',
            KIND_TINT[meta.kind]
          )}
        >
          <KindIcon kind={meta.kind} />
        </span>
        <div className="min-w-0 flex-1 leading-tight">
          <div className="truncate text-[12.5px] text-fg/90" title={meta.name}>
            {meta.name}
          </div>
          <div className="text-[11px] text-subtle">
            {KIND_LABEL[meta.kind]} · {formatSize(meta.size)}
            {meta.truncated ? ' · cortado' : ''}
          </div>
        </div>
        <AttachmentApiInfo meta={meta} />
        {body != null && (
          <Tip label={open ? 'Recolher' : 'Ver conteúdo'}>
            <button
              type="button"
              onClick={() => setOpen(!open)}
              aria-label={open ? 'Recolher' : 'Ver conteúdo'}
              className="rounded-md p-1 text-subtle hover:bg-hover hover:text-fg"
            >
              <ChevronDown className={cn('size-3.5 transition-transform', open && 'rotate-180')} />
            </button>
          </Tip>
        )}
      </div>
      {open && body != null && (
        <pre className="mt-1.5 max-h-72 animate-fade-in overflow-auto rounded-xl border border-border bg-bg/70 p-3 text-left font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-fg/85">
          {body}
        </pre>
      )}
    </div>
  )
}

/** Anexos de uma mensagem do usuário (acima do balão). */
export function MessageAttachments({ parts }: { parts: ContentPart[] }): React.JSX.Element | null {
  const items = parts.filter((p) => p._attachment)
  if (!items.length) return null
  return (
    <div className="flex max-w-[85%] flex-wrap justify-end gap-2" data-message-attachments>
      {items.map((p, i) => {
        const meta = p._attachment!
        if (meta.kind === 'image') return <ImageThumb key={i} meta={meta} />
        return <FileChip key={i} meta={meta} text={p.type === 'text' ? p.text : undefined} />
      })}
    </div>
  )
}

/** Imagens/PDF devolvidos por read_file (resultado de tool) — miniatura clicável / chip. */
export function ToolResultMedia({ parts }: { parts: ContentPart[] }): React.JSX.Element | null {
  const items = parts.filter((p) => p._attachment)
  if (!items.length) return null
  return (
    <div className="flex flex-wrap gap-2" data-tool-media>
      {items.map((p, i) => {
        const meta = p._attachment!
        if (meta.kind === 'image') return <ImageThumb key={i} meta={meta} />
        return <FileChip key={i} meta={meta} />
      })}
    </div>
  )
}
