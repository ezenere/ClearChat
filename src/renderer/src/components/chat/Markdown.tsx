import { Check, Copy } from 'lucide-react'
import { isValidElement, memo, useState, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import remarkGfm from 'remark-gfm'
import { cn } from '../../lib/format'

function textOf(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (isValidElement(node)) return textOf((node.props as { children?: ReactNode }).children)
  return ''
}

export function CopyButton({
  text,
  className,
  label = 'Copiar'
}: {
  text: string
  className?: string
  label?: string
}): React.JSX.Element {
  const [done, setDone] = useState(false)
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setDone(true)
          setTimeout(() => setDone(false), 1400)
        })
      }}
      className={cn(
        'inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-subtle transition-colors hover:bg-hover hover:text-fg',
        className
      )}
    >
      {done ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
      {done ? 'Copiado' : label}
    </button>
  )
}

function CodeBlock({ children }: { children?: ReactNode }): React.JSX.Element {
  const child = Array.isArray(children) ? children[0] : children
  const cls = isValidElement(child) ? ((child.props as { className?: string }).className ?? '') : ''
  const lang = /language-([\w+-]+)/.exec(cls)?.[1]
  const text = textOf(children).replace(/\n$/, '')
  return (
    <div className="group/code my-3 overflow-hidden rounded-xl border border-border bg-[#0d0d12]">
      <div className="flex h-8 items-center justify-between border-b border-border/70 bg-white/[0.015] pr-1.5 pl-3">
        <span className="font-mono text-[11px] text-subtle">{lang ?? 'texto'}</span>
        <CopyButton text={text} />
      </div>
      <pre className="overflow-x-auto px-3.5 py-3 font-mono text-[12.5px] leading-[1.6]">
        {children}
      </pre>
    </div>
  )
}

const components: Components = {
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  )
}

export const Markdown = memo(function Markdown({
  text,
  streaming
}: {
  text: string
  streaming?: boolean
}): React.JSX.Element {
  return (
    <div className={cn('md', streaming && 'stream-caret')}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: false }]]}
        components={components}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
})
