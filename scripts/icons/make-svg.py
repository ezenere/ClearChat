#!/usr/bin/env python3
"""Gera os SVGs-mestre do ícone do ClearChat a partir da marca do app (Logo.tsx).

- build/icon.svg        mestre 1024x1024: squircle com margem de ~10% (grade de ícones do macOS,
                        também ótimo em docks Linux/Windows), sombra suave, gradiente do acento.
- --small N OUT         variante para 16–32 px: margem de 1 px, sem sombra, traço mais grosso.

Uso: python3 scripts/icons/make-svg.py   (depois: scripts/icons/render.sh)
"""
import math
import os

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))

# Marca (mesmo desenho do Logo.tsx, viewBox 24x24): balão de chat + uma linha de texto.
BUBBLE = (
    'M5 7.5A2.5 2.5 0 0 1 7.5 5h9A2.5 2.5 0 0 1 19 7.5v6a2.5 2.5 0 0 1-2.5 2.5H11'
    'l-3.6 2.7a.6.6 0 0 1-.96-.48V16A2.5 2.5 0 0 1 5 13.5v-6Z'
)
# Caixa do balão no viewBox 24: x 5..19, y 5..18.92
BUBBLE_BOX = (5.0, 5.0, 19.0, 18.92)


def squircle(cx: float, cy: float, half: float, n: float = 5.0, steps: int = 720) -> str:
    """Superelipse |x|^n + |y|^n = 1 (forma 'continuous corner' de docks modernos)."""
    pts = []
    for i in range(steps):
        t = 2 * math.pi * i / steps
        c, s = math.cos(t), math.sin(t)
        x = cx + half * math.copysign(abs(c) ** (2 / n), c)
        y = cy + half * math.copysign(abs(s) ** (2 / n), s)
        pts.append(f'{x:.2f} {y:.2f}')
    return 'M' + ' L'.join(pts) + ' Z'


def make(size: int, margin: float, bubble_frac: float, line_w: float, shadow: bool, n: float) -> str:
    half = size * (1 - 2 * margin) / 2
    cx = cy = size / 2
    body = squircle(cx, cy, half, n)
    body_w = 2 * half
    x0, y0, x1, y1 = BUBBLE_BOX
    scale = body_w * bubble_frac / (x1 - x0)
    # centro óptico: caixa do balão centrada, levemente acima (o rabinho pesa embaixo)
    bx = cx - scale * (x0 + x1) / 2
    by = cy - scale * (y0 + y1) / 2 + body_w * 0.01
    top = cy - half
    bottom = cy + half
    sh = ''
    if shadow:
        sh = f'''
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="150%">
      <feGaussianBlur in="SourceAlpha" stdDeviation="{size * 0.014:.1f}"/>
      <feOffset dy="{size * 0.012:.1f}"/>
      <feComponentTransfer><feFuncA type="linear" slope="0.35"/></feComponentTransfer>
      <feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
    <filter id="bubbleShadow" x="-20%" y="-20%" width="140%" height="150%">
      <feGaussianBlur in="SourceAlpha" stdDeviation="{size * 0.012:.1f}"/>
      <feOffset dy="{size * 0.010:.1f}"/>
      <feComponentTransfer><feFuncA type="linear" slope="0.28"/></feComponentTransfer>
      <feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>'''
    body_filter = ' filter="url(#shadow)"' if shadow else ''
    bubble_filter = ' filter="url(#bubbleShadow)"' if shadow else ''
    rim = max(1.0, size * 0.003)
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" viewBox="0 0 {size} {size}">
  <title>ClearChat</title>
  <defs>
    <linearGradient id="bg" x1="{cx - half:.1f}" y1="{top:.1f}" x2="{cx + half:.1f}" y2="{bottom:.1f}" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#b39dfc"/>
      <stop offset="0.45" stop-color="#8b5cf6"/>
      <stop offset="1" stop-color="#4c32c4"/>
    </linearGradient>
    <radialGradient id="glow" cx="{cx - half * 0.35:.1f}" cy="{top:.1f}" r="{half * 1.5:.1f}" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.30"/>
      <stop offset="0.55" stop-color="#ffffff" stop-opacity="0.05"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="rim" x1="0" y1="{top:.1f}" x2="0" y2="{bottom:.1f}" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.45"/>
      <stop offset="0.5" stop-color="#ffffff" stop-opacity="0.06"/>
      <stop offset="1" stop-color="#000000" stop-opacity="0.18"/>
    </linearGradient>
    <linearGradient id="bubble" x1="0" y1="5" x2="0" y2="19" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#ffffff"/>
      <stop offset="1" stop-color="#ece6ff"/>
    </linearGradient>
    <linearGradient id="line" x1="9" y1="0" x2="15" y2="0" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#8b5cf6"/>
      <stop offset="1" stop-color="#6d4ae0"/>
    </linearGradient>
    <clipPath id="clip"><path d="{body}"/></clipPath>{sh}
  </defs>
  <g{body_filter}>
    <path d="{body}" fill="url(#bg)"/>
  </g>
  <g clip-path="url(#clip)">
    <rect width="{size}" height="{size}" fill="url(#glow)"/>
  </g>
  <path d="{body}" fill="none" stroke="url(#rim)" stroke-width="{rim * 2:.2f}" clip-path="url(#clip)"/>
  <g transform="translate({bx:.2f} {by:.2f}) scale({scale:.4f})"{bubble_filter}>
    <path d="{BUBBLE}" fill="url(#bubble)"/>
    <path d="M9 10.5h6" stroke="url(#line)" stroke-width="{line_w}" stroke-linecap="round"/>
  </g>
</svg>
'''


def small(px: int) -> str:
    """Variante p/ tamanhos pequenos: margem de exatamente 1 px (bordas alinhadas à grade)."""
    return make(1024, margin=1 / px, bubble_frac=0.64, line_w=2.1, shadow=False, n=4.2)


def main() -> None:
    import sys

    if len(sys.argv) == 4 and sys.argv[1] == '--small':
        with open(sys.argv[3], 'w') as f:
            f.write(small(int(sys.argv[2])))
        return
    out = os.path.join(ROOT, 'build')
    with open(os.path.join(out, 'icon.svg'), 'w') as f:
        f.write(make(1024, margin=0.098, bubble_frac=0.56, line_w=1.6, shadow=True, n=5.0))
    # Favicon/Logo do renderer: mesma arte sem margem nem sombra.
    pub = os.path.join(ROOT, 'src', 'renderer', 'public')
    os.makedirs(pub, exist_ok=True)
    with open(os.path.join(pub, 'favicon.svg'), 'w') as f:
        f.write(make(256, margin=0.0, bubble_frac=0.6, line_w=1.8, shadow=False, n=4.6))


if __name__ == '__main__':
    main()
