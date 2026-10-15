#!/usr/bin/env bash
# Renderiza build/icon.svg (e uma variante com margem de 1 px p/ 16–32 px) em todos os formatos de ícone:
#   build/icons/NxN.png (Linux), build/icon.png (1024), build/icon.ico, build/icon.icns,
#   resources/icon.png (ícone da janela, 512).
# Requer rsvg-convert (librsvg) e ImageMagick (magick). Uso: scripts/icons/render.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
python3 scripts/icons/make-svg.py

mkdir -p build/icons
for s in 16 24 32 48 64 128 256 512 1024; do
  src=build/icon.svg
  if [ "$s" -le 32 ]; then
    src=$(mktemp --suffix=.svg)
    python3 scripts/icons/make-svg.py --small "$s" "$src"
  fi
  rsvg-convert -w "$s" -h "$s" "$src" -o "build/icons/${s}x${s}.png"
done
cp build/icons/1024x1024.png build/icon.png
cp build/icons/512x512.png resources/icon.png
magick build/icons/{16x16,24x24,32x32,48x48,64x64,128x128,256x256}.png build/icon.ico
python3 scripts/icons/make-icns.py build/icons build/icon.icns
ls -la build/icon.* build/icons resources/icon.png
