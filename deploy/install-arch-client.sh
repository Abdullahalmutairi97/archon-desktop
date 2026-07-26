#!/usr/bin/env bash
set -euo pipefail

REMOTE="${ARCHON_VPS:-archon@100.80.70.23}"
REMOTE_ROOT="/home/archon/projects/archon-desktop"
VERSION="0.5.0"
LAUNCH=false
if [[ "${1:-}" == "--launch" ]]; then LAUNCH=true; fi
case "$(uname -m)" in
  x86_64) PACKAGE_ARCH="x86_64" ;;
  aarch64|arm64) PACKAGE_ARCH="arm64" ;;
  *) printf 'Unsupported architecture: %s\n' "$(uname -m)" >&2; exit 1 ;;
esac

APP_ROOT="$HOME/.local/opt/archon-desktop"
APP_DIR="$APP_ROOT/app"
APPLICATIONS="$HOME/.local/share/applications"
ICONS="$HOME/.local/share/icons/hicolor/512x512/apps"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$APP_ROOT" "$APPLICATIONS" "$ICONS"
scp -q "$REMOTE:$REMOTE_ROOT/desktop/release/Archon-Desktop-$VERSION-$PACKAGE_ARCH.AppImage" "$TMP/Archon.AppImage"
scp -q "$REMOTE:$REMOTE_ROOT/desktop/build/icon.png" "$TMP/archon-desktop.png"
chmod +x "$TMP/Archon.AppImage"
(
  cd "$TMP"
  ./Archon.AppImage --appimage-extract >/dev/null
)
rm -rf "$APP_DIR.previous"
if [[ -d "$APP_DIR" ]]; then mv "$APP_DIR" "$APP_DIR.previous"; fi
mv "$TMP/squashfs-root" "$APP_DIR"
install -m 0644 "$TMP/archon-desktop.png" "$ICONS/archon-desktop.png"

cat > "$APPLICATIONS/archon-desktop.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Archon
Comment=Private command center for Archon
Exec=$APP_DIR/AppRun
Icon=archon-desktop
Terminal=false
Categories=Development;Utility;
StartupNotify=true
StartupWMClass=archon-desktop
EOF
chmod 0644 "$APPLICATIONS/archon-desktop.desktop"

if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$APPLICATIONS" >/dev/null 2>&1 || true
fi
if command -v gtk-update-icon-cache >/dev/null 2>&1; then
  gtk-update-icon-cache -q "$HOME/.local/share/icons/hicolor" >/dev/null 2>&1 || true
fi

DESKTOP_DIR=""
if command -v xdg-user-dir >/dev/null 2>&1; then DESKTOP_DIR="$(xdg-user-dir DESKTOP 2>/dev/null || true)"; fi
if [[ -z "$DESKTOP_DIR" && -d "$HOME/Desktop" ]]; then DESKTOP_DIR="$HOME/Desktop"; fi
if [[ -n "$DESKTOP_DIR" && -d "$DESKTOP_DIR" ]]; then
  cp "$APPLICATIONS/archon-desktop.desktop" "$DESKTOP_DIR/Archon.desktop"
  chmod +x "$DESKTOP_DIR/Archon.desktop"
  if command -v gio >/dev/null 2>&1; then gio set "$DESKTOP_DIR/Archon.desktop" metadata::trusted true >/dev/null 2>&1 || true; fi
fi

rm -rf "$APP_DIR.previous"
if [[ "$LAUNCH" == true ]]; then
  mkdir -p "$HOME/.cache"
  pkill -u "$(id -u)" -x archon-desktop >/dev/null 2>&1 || true
  nohup "$APP_DIR/AppRun" >"$HOME/.cache/archon-desktop-launch.log" 2>&1 </dev/null &
fi
printf '\nArchon %s installed. Open “Archon” from your application menu or desktop.\n' "$VERSION"
