#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_USER="${SUDO_USER:-${USER}}"
SERVICE_HOME="$(getent passwd "$SERVICE_USER" | cut -d: -f6)"
TAILSCALE_IP="${ARCHON_DESKTOP_TAILSCALE_IP:-$(tailscale ip -4 | sed -n '1p')}"
ENV_FILE="$PROJECT_ROOT/backend/.env"
UNIT_TEMPLATE="$PROJECT_ROOT/deploy/archon-desktop-server.service.in"
UNIT_FILE="/etc/systemd/system/archon-desktop-server.service"

if [[ -z "$TAILSCALE_IP" ]]; then
  echo "No Tailscale IPv4 address found" >&2
  exit 1
fi
if [[ ! -x "$PROJECT_ROOT/backend/.venv/bin/python" ]]; then
  echo "Backend virtualenv is missing; install backend dependencies first" >&2
  exit 1
fi

umask 077
if [[ ! -f "$ENV_FILE" ]]; then
  token="$(openssl rand -hex 32)"
  cat > "$ENV_FILE" <<EOF
ARCHON_DESKTOP_AUTH_TOKEN=$token
ARCHON_DESKTOP_BIND_HOST=$TAILSCALE_IP
ARCHON_DESKTOP_BIND_PORT=9700
ARCHON_DESKTOP_ARCHON_ROOT=$SERVICE_HOME
ARCHON_DESKTOP_HERMES_HOME=$SERVICE_HOME/.hermes
ARCHON_DESKTOP_DATA_DIR=$SERVICE_HOME/.local/share/archon-desktop
ARCHON_DESKTOP_PROFILE=archon
ARCHON_DESKTOP_START_WORKER=true
EOF
  unset token
else
  python3 - "$ENV_FILE" "$TAILSCALE_IP" "$SERVICE_HOME" <<'PY'
from pathlib import Path
import sys

path, ip, home = Path(sys.argv[1]), sys.argv[2], sys.argv[3]
values = {}
for raw in path.read_text().splitlines():
    if raw and not raw.lstrip().startswith('#') and '=' in raw:
        key, value = raw.split('=', 1)
        values[key] = value
if not values.get('ARCHON_DESKTOP_AUTH_TOKEN'):
    raise SystemExit('Existing .env has no auth token; refusing to replace it implicitly')
values.update({
    'ARCHON_DESKTOP_BIND_HOST': ip,
    'ARCHON_DESKTOP_BIND_PORT': '9700',
    'ARCHON_DESKTOP_ARCHON_ROOT': home,
    'ARCHON_DESKTOP_HERMES_HOME': f'{home}/.hermes',
    'ARCHON_DESKTOP_DATA_DIR': f'{home}/.local/share/archon-desktop',
    'ARCHON_DESKTOP_PROFILE': 'archon',
    'ARCHON_DESKTOP_START_WORKER': 'true',
})
path.write_text(''.join(f'{key}={value}\n' for key, value in values.items()))
PY
fi
chmod 600 "$ENV_FILE"

unit_tmp="$(mktemp)"
sed \
  -e "s|@PROJECT_ROOT@|$PROJECT_ROOT|g" \
  -e "s|@SERVICE_USER@|$SERVICE_USER|g" \
  -e "s|@SERVICE_HOME@|$SERVICE_HOME|g" \
  "$UNIT_TEMPLATE" > "$unit_tmp"
sudo install -m 0644 "$unit_tmp" "$UNIT_FILE"
rm -f "$unit_tmp"
sudo systemctl daemon-reload
sudo systemctl enable --now archon-desktop-server.service

echo "Installed on $TAILSCALE_IP:9700 for private tailnet access"
