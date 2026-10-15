import { useId } from 'react'
import { cn } from '../lib/format'

// Mesma arte do ícone do app (build/icon.svg, gerado por scripts/icons/make-svg.py), sem a margem:
// squircle (superelipse n=4.6) com o gradiente do acento + balão de chat branco com uma linha.

function squirclePath(n = 4.6, steps = 160): string {
  const pts: string[] = []
  for (let i = 0; i < steps; i++) {
    const t = (2 * Math.PI * i) / steps
    const c = Math.cos(t)
    const s = Math.sin(t)
    const x = 50 + 50 * Math.sign(c) * Math.abs(c) ** (2 / n)
    const y = 50 + 50 * Math.sign(s) * Math.abs(s) ** (2 / n)
    pts.push(`${x.toFixed(2)} ${y.toFixed(2)}`)
  }
  return `M${pts.join(' L')} Z`
}

const SQUIRCLE = squirclePath()
const BUBBLE =
  'M5 7.5A2.5 2.5 0 0 1 7.5 5h9A2.5 2.5 0 0 1 19 7.5v6a2.5 2.5 0 0 1-2.5 2.5H11l-3.6 2.7a.6.6 0 0 1-.96-.48V16A2.5 2.5 0 0 1 5 13.5v-6Z'

export function Logo({ className }: { className?: string }): React.JSX.Element {
  const id = useId().replace(/:/g, '')
  return (
    <svg
      viewBox="0 0 100 100"
      aria-hidden
      className={cn('shrink-0 drop-shadow-[0_4px_10px_rgb(139_92_246/0.45)]', className)}
    >
      <defs>
        <linearGradient
          id={`${id}bg`}
          x1="0"
          y1="0"
          x2="100"
          y2="100"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="#b39dfc" />
          <stop offset="0.45" stopColor="#8b5cf6" />
          <stop offset="1" stopColor="#4c32c4" />
        </linearGradient>
        <radialGradient id={`${id}glow`} cx="32" cy="0" r="75" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#fff" stopOpacity="0.3" />
          <stop offset="0.55" stopColor="#fff" stopOpacity="0.05" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </radialGradient>
      </defs>
      <path d={SQUIRCLE} fill={`url(#${id}bg)`} />
      <path d={SQUIRCLE} fill={`url(#${id}glow)`} />
      <g transform="translate(-1.43 -0.26) scale(4.2857)">
        <path d={BUBBLE} fill="#fff" fillOpacity="0.97" />
        <path d="M9 10.5h6" stroke="#7c5ae6" strokeWidth="1.8" strokeLinecap="round" />
      </g>
    </svg>
  )
}
