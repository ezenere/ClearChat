#!/usr/bin/env bash
# Instala o AppImage do ClearChat só para o usuário atual (sem root):
#   ~/.local/bin/ClearChat.AppImage (+ link ~/.local/bin/clearchat)
#   ~/.local/share/applications/clearchat.desktop
#   ~/.local/share/icons/hicolor/<N>x<N>/apps/clearchat.png (+ scalable/apps/clearchat.svg)
#
# Uso: npm run install:local [-- caminho/para/ClearChat.AppImage]
#      npm run install:local -- --uninstall
# Respeita $HOME e $XDG_DATA_HOME (útil para testar num diretório de rascunho).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_ID=clearchat
BIN_DIR="$HOME/.local/bin"
DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}"
APPS_DIR="$DATA_DIR/applications"
ICONS_DIR="$DATA_DIR/icons/hicolor"
TARGET="$BIN_DIR/ClearChat.AppImage"
SIZES=(16 24 32 48 64 128 256 512 1024)

refresh() {
  command -v update-desktop-database >/dev/null && update-desktop-database -q "$APPS_DIR" || true
  command -v gtk-update-icon-cache >/dev/null && gtk-update-icon-cache -q -t "$ICONS_DIR" 2>/dev/null || true
}

if [ "${1:-}" = "--uninstall" ]; then
  rm -f "$TARGET" "$BIN_DIR/$APP_ID" "$APPS_DIR/$APP_ID.desktop" "$ICONS_DIR/scalable/apps/$APP_ID.svg"
  for s in "${SIZES[@]}"; do rm -f "$ICONS_DIR/${s}x${s}/apps/$APP_ID.png"; done
  refresh
  echo "ClearChat removido (seus dados em ~/.config/ClearChat foram mantidos)."
  exit 0
fi

SRC="${1:-}"
if [ -z "$SRC" ]; then
  SRC="$(ls -t "$ROOT"/dist/ClearChat-*.AppImage 2>/dev/null | head -n1 || true)"
fi
if [ -z "$SRC" ] || [ ! -f "$SRC" ]; then
  echo "AppImage não encontrado. Rode 'npm run dist:appimage' antes (ou passe o caminho)." >&2
  exit 1
fi

mkdir -p "$BIN_DIR" "$APPS_DIR"
install -m 755 "$SRC" "$TARGET"
ln -sf "$TARGET" "$BIN_DIR/$APP_ID"

for s in "${SIZES[@]}"; do
  install -D -m 644 "$ROOT/build/icons/${s}x${s}.png" "$ICONS_DIR/${s}x${s}/apps/$APP_ID.png"
done
install -D -m 644 "$ROOT/build/icon.svg" "$ICONS_DIR/scalable/apps/$APP_ID.svg"

cat >"$APPS_DIR/$APP_ID.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=ClearChat
GenericName=Chat com IA
Comment=Chat minimalista com IA para qualquer endpoint OpenAI-compatible (OpenRouter, OpenAI, servidores locais)
Exec="$TARGET" %U
TryExec=$TARGET
Icon=$APP_ID
Terminal=false
Categories=Development;
Keywords=ai;ia;chat;llm;openai;openrouter;assistente;
StartupWMClass=$APP_ID
StartupNotify=true
EOF
chmod 644 "$APPS_DIR/$APP_ID.desktop"

refresh
echo "ClearChat instalado:"
echo "  $TARGET"
echo "  $APPS_DIR/$APP_ID.desktop"
echo "  $ICONS_DIR/<N>x<N>/apps/$APP_ID.png"
case ":$PATH:" in *":$BIN_DIR:"*) ;; *) echo "Dica: adicione $BIN_DIR ao PATH para rodar 'clearchat' no terminal." ;; esac
