// Waveform de voz (canvas leve): barras de nível ao vivo (24–32) + estado "gravando" (pulso/onda).
// O contorno/cor vêm do Tailwind no wrapper (o canvas usa `currentColor`); os dados vêm do
// `usePushToTalk` (prop `level`) ou do modo simulação (`simulate`) para o mock de UI — este
// componente não faz captura, então funciona em builds com VITE_CLEAR_MOCK sem microfone.
import { useEffect, useRef } from 'react'
import { cn } from '../../lib/format'
import { simulatedLevel } from './simulate'

export interface WaveformProps {
  /** Nível RMS atual (0..1), tipicamente `usePushToTalk().level`. Ignorado em modo simulação. */
  level: number
  /** Estado "gravando": ativa o pulso/onda; parado mostra só a linha de base. */
  recording?: boolean
  /** Quantidade de barras (24–32; fora da faixa é aparado; padrão 28). */
  bars?: number
  /** Modo simulação (mock de UI): níveis falsos no lugar da captura real. */
  simulate?: boolean
  /** Classes Tailwind do wrapper (cor via `text-*`, tamanho via `h-*`/`w-*`). */
  className?: string
}

/** Amostra o histórico de níveis a ~30 Hz (mesmo ritmo dos eventos de nível da captura). */
const SAMPLE_MS = 33

/**
 * Waveform de nível em canvas (sem dependências): desenha o histórico de níveis como barras
 * arredondadas e, com `recording`, aplica um pulso suave (estilo do composer moderno).
 */
export function Waveform({
  level,
  recording = false,
  bars = 28,
  simulate = false,
  className
}: WaveformProps): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const levelRef = useRef(level)

  useEffect(() => {
    levelRef.current = level
  }, [level])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const barCount = Math.min(32, Math.max(24, Math.round(bars) || 28))
    const history = new Float32Array(barCount)
    let lastSample = 0
    let raf = requestAnimationFrame(function draw(now: number): void {
      raf = requestAnimationFrame(draw)
      // Amostra o nível a ~30 Hz e desloca o histórico (índice 0 = mais recente).
      if (now - lastSample >= SAMPLE_MS) {
        lastSample = now
        history.copyWithin(1, 0)
        history[0] = simulate ? simulatedLevel(now) : Math.min(1, Math.max(0, levelRef.current))
      }
      const dpr = window.devicePixelRatio || 1
      const width = canvas.clientWidth
      const height = canvas.clientHeight
      if (width === 0 || height === 0) return
      if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
        canvas.width = Math.round(width * dpr)
        canvas.height = Math.round(height * dpr)
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, width, height)
      ctx.fillStyle = getComputedStyle(canvas).color
      const gap = 2
      const barWidth = Math.max(1, (width - gap * (barCount - 1)) / barCount)
      const pulse = recording ? 1 + 0.1 * Math.sin(now / 160) : 1
      const radius = Math.min(2, barWidth / 2)
      for (let i = 0; i < barCount; i++) {
        // Barras mais antigas à esquerda: desenha o histórico invertido.
        const value = Math.min(1, history[barCount - 1 - i] * pulse)
        const barHeight = recording || value > 0 ? 2 + value * (height - 2) : 2
        const x = i * (barWidth + gap)
        const y = (height - barHeight) / 2
        // Gravando: onda viva (alfa alto no centro do histórico); parado: linha de base discreta.
        ctx.globalAlpha = recording ? 0.45 + 0.55 * value : 0.35
        ctx.beginPath()
        ctx.roundRect(x, y, barWidth, barHeight, radius)
        ctx.fill()
      }
      ctx.globalAlpha = 1
    })
    return () => cancelAnimationFrame(raf)
  }, [bars, simulate, recording])

  return (
    <span
      data-testid="voice-waveform"
      aria-hidden="true"
      className={cn('text-accent-strong inline-flex h-6 w-32 items-center', className)}
    >
      <canvas ref={canvasRef} className="h-full w-full" />
    </span>
  )
}
