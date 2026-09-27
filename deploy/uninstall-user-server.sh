#!/usr/bin/env bash
set -euo pipefail

SERVICE_NAME="archon-desktop-server.service"
SERVICE_USER="$(id -un)"
SERVICE_UID="$(id -u)"
SERVICE_HOME="$(getent passwd "$SERVICE_USER" | cut -d: -f6)"
CONFIG_HOME="${XDG_CONFIG_HOME:-$SERVICE_HOME/.config}"
UNIT_FILE="$CONFIG_HOME/systemd/user/$SERVICE_NAME"

if (($#)); then
  if (($# == 1)) && [[ "$1" == "-h" || "$1" == "--help" ]]; then
    cat <<'EOF'
Usage: deploy/uninstall-user-server.sh

Stops and disables the same-user Archon Desktop backend service, removes its
user unit, and preserves the environment file and backend data.
EOF
    exit 0
  fi
  printf '%s\n' "This uninstaller takes no arguments. Use --help for usage." >&2
  exit 2
fi

if [[ "$EUID" -eq 0 ]]; then
  printf '%s\n' "Run this uninstaller as the desktop account, without sudo." >&2
  exit 2
fi
[[ -n "$SERVICE_HOME" && "$SERVICE_HOME" = /* && "$CONFIG_HOME" = /* ]] || {
  printf '%s\n' "The current account has no valid absolute home or configuration directory." >&2
  exit 2
}
command -v systemctl >/dev/null || {
  printf '%s\n' "systemctl is unavailable; this uninstaller requires systemd." >&2
  exit 2
}
systemctl --user show-environment >/dev/null 2>&1 || {
  printf '%s\n' "The current systemd user manager is unavailable; log into the desktop session and retry." >&2
  exit 2
}

if [[ -e "$UNIT_FILE" || -L "$UNIT_FILE" ]]; then
  if [[ ! -f "$UNIT_FILE" || -L "$UNIT_FILE" ]]; then
    printf '%s\n' "Refusing to remove a non-regular user unit path at $UNIT_FILE." >&2
    exit 2
  fi
  UNIT_OWNER="$(stat -c '%u' -- "$UNIT_FILE")"
  if [[ "$UNIT_OWNER" != "$SERVICE_UID" ]] || ! grep -Fqx '# Managed by deploy/install-user-server.sh.' "$UNIT_FILE"; then
    printf '%s\n' "Refusing to remove a user unit not owned and marked as managed by this installer." >&2
    exit 2
  fi
  if systemctl --user is-active --quiet "$SERVICE_NAME"; then
    systemctl --user stop "$SERVICE_NAME"
  fi
  if systemctl --user is-enabled --quiet "$SERVICE_NAME"; then
    systemctl --user disable "$SERVICE_NAME"
  fi
  rm -f -- "$UNIT_FILE"
elif systemctl --user is-active --quiet "$SERVICE_NAME" || systemctl --user is-enabled --quiet "$SERVICE_NAME"; then
  printf '%s\n' "A same-name service is active or enabled, but no managed user unit exists at $UNIT_FILE; inspect it manually." >&2
  exit 2
fi
systemctl --user daemon-reload

printf 'Removed the same-user Archon Desktop backend service unit.\n'
printf 'The environment file and backend data were preserved.\n'
