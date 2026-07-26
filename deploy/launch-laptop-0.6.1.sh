#!/usr/bin/env bash
set -euo pipefail

TARGET="abdullah@100.100.131.23"
HOST="100.100.131.23"
LOCAL_APPIMAGE="/home/archon/projects/archon-desktop/desktop/release/Archon-Desktop-0.6.1-x86_64.AppImage"
LOCAL_ASAR="/home/archon/projects/archon-desktop/desktop/release/linux-unpacked/resources/app.asar"
REMOTE_APPIMAGE="/home/abdullah/.cache/Archon-Desktop-0.6.1-x86_64.preview.AppImage.partial"
INSTALL_ROOT="/home/abdullah/.local/opt/archon-desktop"

for _ in $(seq 1 60); do
  if tailscale ping -c 1 --timeout=3s "$HOST" >/dev/null 2>&1; then
    break
  fi
  sleep 10
done

tailscale ping -c 1 --timeout=5s "$HOST" >/dev/null
rsync -ah --partial --append-verify --timeout=45 -e 'ssh -o BatchMode=yes -o ConnectTimeout=10' "$LOCAL_APPIMAGE" "$TARGET:$REMOTE_APPIMAGE"

expected_image=$(sha256sum "$LOCAL_APPIMAGE" | cut -d' ' -f1)
actual_image=$(ssh -o BatchMode=yes "$TARGET" "sha256sum '$REMOTE_APPIMAGE' | cut -d' ' -f1")
[[ "$actual_image" == "$expected_image" ]]

expected_asar=$(sha256sum "$LOCAL_ASAR" | cut -d' ' -f1)
ssh -o BatchMode=yes "$TARGET" "/bin/bash -lc 'set -euo pipefail
pkg=\"$REMOTE_APPIMAGE\"
root=\"/tmp/archon-desktop-0.6.1-extract\"
stage=\"$INSTALL_ROOT/app.stage-0.6.1\"
current=\"$INSTALL_ROOT/app\"
config=\"/home/abdullah/.config/archon-desktop/connection.json\"
config_before=\$(sha256sum \"\$config\" | cut -d\" \" -f1)
chmod 755 \"\$pkg\"
rm -rf \"\$root\" \"\$stage\"
mkdir -p \"\$root\" \"$INSTALL_ROOT\"
cd \"\$root\"
\"\$pkg\" --appimage-extract >/dev/null
mv squashfs-root \"\$stage\"
test -x \"\$stage/archon-desktop\"
pkill -TERM -f \"^\$current/archon-desktop\" 2>/dev/null || true
sleep 2
if [ -d \"\$current\" ]; then
  rm -rf \"$INSTALL_ROOT/app.backup-0.6.0\"
  mv \"\$current\" \"$INSTALL_ROOT/app.backup-0.6.0\"
fi
mv \"\$stage\" \"\$current\"
config_after=\$(sha256sum \"\$config\" | cut -d\" \" -f1)
[ \"\$config_before\" = \"\$config_after\" ]
[ \"\$(stat -c %a \"\$config\")\" = 600 ]
rm -rf \"\$root\"'
"

actual_asar=$(ssh -o BatchMode=yes "$TARGET" "sha256sum '$INSTALL_ROOT/app/resources/app.asar' | cut -d' ' -f1")
[[ "$actual_asar" == "$expected_asar" ]]
echo "ARCHON_LAUNCHED artifact=$expected_image asar=$expected_asar"

exec ssh -o BatchMode=yes "$TARGET" "env DISPLAY=:0 WAYLAND_DISPLAY=wayland-0 XDG_RUNTIME_DIR=/run/user/1000 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus XDG_CURRENT_DESKTOP=KDE KDE_FULL_SESSION=true QT_QPA_PLATFORM=wayland '$INSTALL_ROOT/app/archon-desktop' --ozone-platform=wayland"
