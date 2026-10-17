import { Check, Copy } from 'lucide-react'
import 'katex/dist/katex.min.css'
import './markdown-math.css'
import { isValidElement, memo, useMemo, useState, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import rehypeKatex from 'rehype-katex'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import { normalizeFences } from '../../lib/fences'
import { cn } from '../../lib/format'
import { normalizeMath } from '../../lib/math'
import { tableMinWidthEm, type HastLike } from '../../lib/tableWidth'

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
  // tabela larga rola na horizontal dentro do próprio container (as colunas não são espremidas)
  table: ({ children, node }) => (
    <div className="md-table">
      <table style={node ? { minWidth: `${tableMinWidthEm(node as HastLike)}em` } : undefined}>
        {children}
      </table>
    </div>
  ),
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  )
}

// `$…$` fica ligado: o normalizeMath já escapou os cifrões que não formam fórmula (preços).
const remarkPlugins: React.ComponentProps<typeof ReactMarkdown>['remarkPlugins'] = [
  remarkGfm,
  [remarkMath, { singleDollarTextMath: true }]
]
// KaTeX antes do highlight (senão o highlight tentaria colorir `language-math`). Erro de TeX não
// derruba nada: o rehype-katex cai para throwOnError:false e mostra o TeX cru em vermelho suave.
const rehypePlugins: React.ComponentProps<typeof ReactMarkdown>['rehypePlugins'] = [
  [rehypeKatex, { errorColor: '#d98a8a', strict: 'ignore' }],
  [rehypeHighlight, { detect: false }]
]

export const Markdown = memo(function Markdown({
  text,
  streaming
}: {
  text: string
  streaming?: boolean
}): React.JSX.Element {
  // Cercas aninhadas → uma cerca externa mais longa; \[ \] e \( \) → $$ e $; preços escapados.
  const source = useMemo(() => normalizeMath(normalizeFences(text), streaming), [text, streaming])
  return (
    <div className={cn('md', streaming && 'stream-caret')}>
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={components}
      >
        {source}
      </ReactMarkdown>
    </div>
  )
})
