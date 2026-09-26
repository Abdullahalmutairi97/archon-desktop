#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
ENV_FILE="/etc/archon-desktop/server.env"
CONFIRM_ROOTS="false"
WORKSPACE_ROOTS=()
SERVICE_USER="${SUDO_USER:-${USER:-}}"
UNIT_TEMPLATE="$PROJECT_ROOT/deploy/archon-desktop-server.service.in"
UNIT_FILE="/etc/systemd/system/archon-desktop-server.service"
PYTHON="$PROJECT_ROOT/backend/.venv/bin/python"

usage() {
  cat <<'EOF'
Usage: sudo deploy/install-server.sh --workspace-root ABSOLUTE_PATH [options]

Required:
  --workspace-root PATH       Include every configured scratch and registered project root.
                              Repeat for each root.
  --confirm-workspace-roots-complete
                              Confirm that the full workspace set was supplied.

Options:
  --env-file PATH             External service environment file (default:
                              /etc/archon-desktop/server.env).
  --service-user USER         Account that runs the service (default: invoking user).
  -h, --help                  Show this help.

The backend binds to loopback. Remote access requires a separately managed private,
authenticated HTTPS proxy. This installer does not configure or verify that proxy.
EOF
}

fail() {
  printf '%s\n' "$1" >&2
  exit 2
}

while (($#)); do
  case "$1" in
    --env-file)
      (($# >= 2)) || fail "--env-file requires a path"
      ENV_FILE="$2"
      shift 2
      ;;
    --workspace-root)
      (($# >= 2)) || fail "--workspace-root requires a path"
      WORKSPACE_ROOTS+=("$2")
      shift 2
      ;;
    --confirm-workspace-roots-complete)
      CONFIRM_ROOTS="true"
      shift
      ;;
    --service-user)
      (($# >= 2)) || fail "--service-user requires an account name"
      SERVICE_USER="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "Unknown installer option. Use --help for usage."
      ;;
  esac
done

[[ "$ENV_FILE" = /* ]] || fail "--env-file must be an absolute external path"
[[ "$CONFIRM_ROOTS" == "true" && ${#WORKSPACE_ROOTS[@]} -gt 0 ]] || {
  fail "Supply every workspace root and --confirm-workspace-roots-complete."
}
[[ "$SERVICE_USER" =~ ^[a-z_][a-z0-9_-]*\$?$ ]] || fail "Invalid service account name"
getent passwd "$SERVICE_USER" >/dev/null || fail "The selected service account does not exist"
SERVICE_HOME="$(getent passwd "$SERVICE_USER" | cut -d: -f6)"
[[ -n "$SERVICE_HOME" && "$SERVICE_HOME" = /* ]] || fail "The service account has no absolute home directory"
[[ -x "$PYTHON" ]] || fail "Backend virtualenv is missing; install backend dependencies first"
[[ -f "$UNIT_TEMPLATE" ]] || fail "The systemd unit template is missing"

ENV_FILE_RESOLVED="$(realpath -m -- "$ENV_FILE")"
case "$ENV_FILE_RESOLVED" in
  "$PROJECT_ROOT"|"$PROJECT_ROOT"/*)
    cat >&2 <<'EOF'
Refusing to use a service environment file inside this repository (including backend/.env).
For a manual migration, schedule a maintenance window, stop the existing service, and create
an external mode-0600 environment file with a secure editor or the provision helper. If
preserving the existing bearer token is required, transfer it through that protected editor;
never print it or commit either file. Then point --env-file at the external file and update
clients if you generated a new credential.
EOF
    exit 2
    ;;
esac

if ! PYTHONPATH="$PROJECT_ROOT/backend" "$PYTHON" - "$ENV_FILE_RESOLVED" "${WORKSPACE_ROOTS[@]}" <<'PY'
from pathlib import Path
import sys

from archon_server.provision import validate_external_output_location

try:
    validate_external_output_location(
        sys.argv[1], sys.argv[2:], confirm_workspace_roots_complete=True
    )
except (OSError, ValueError):
    raise SystemExit("The external environment path or workspace roots failed validation.") from None
PY
then
  fail "The external environment path or workspace roots failed validation."
fi

if [[ -L "$ENV_FILE" ]]; then
  fail "The external environment path must not be a symlink."
elif [[ -e "$ENV_FILE" ]]; then
  [[ -f "$ENV_FILE" ]] || fail "The existing environment path is not a regular file."
  MODE="$(stat -c '%a' -- "$ENV_FILE")"
  [[ "$MODE" == "600" ]] || fail "The existing environment file must already have mode 0600; it was not changed."
  PARENT_MODE="$(stat -c '%a' -- "$(dirname -- "$ENV_FILE")")"
  PARENT_OWNER="$(stat -c '%u' -- "$(dirname -- "$ENV_FILE")")"
  SERVICE_UID="$(id -u "$SERVICE_USER")"
  [[ "$PARENT_MODE" == "700" ]] || fail "The existing environment parent must already have mode 0700; it was not changed."
  [[ "$PARENT_OWNER" == "0" || "$PARENT_OWNER" == "$SERVICE_UID" ]] || fail "The existing environment parent has an unexpected owner."
  printf 'Using the existing private external environment file at %s without modifying it.\n' "$ENV_FILE"
else
  PROVISION_ARGS=(
    --output "$ENV_FILE"
    --confirm-workspace-roots-complete
  )
  for workspace_root in "${WORKSPACE_ROOTS[@]}"; do
    PROVISION_ARGS+=(--workspace-root "$workspace_root")
  done
  (cd "$PROJECT_ROOT/backend" && sudo env "PYTHONPATH=$PROJECT_ROOT/backend" "$PYTHON" -m archon_server.provision "${PROVISION_ARGS[@]}")
fi

UNIT_TMP="$(mktemp)"
cleanup() { rm -f -- "$UNIT_TMP"; }
trap cleanup EXIT
"$PYTHON" - "$UNIT_TEMPLATE" "$UNIT_TMP" "$SERVICE_USER" "$SERVICE_HOME" "$PROJECT_ROOT" "$ENV_FILE_RESOLVED" <<'PY'
from pathlib import Path
import re
import sys

template_path, output_path, user, home, project, env_file = map(Path, sys.argv[1:])
template = template_path.read_text()

def quote(value: str) -> str:
    if "\n" in value or "\r" in value:
        raise SystemExit("systemd paths and values cannot contain newlines")
    escaped = value.replace("\\", "\\\\").replace('"', '\\"').replace("%", "%%")
    return f'"{escaped}"'

values = {
    "@SERVICE_USER@": str(user),
    "@SERVICE_HOME@": quote(str(home)),
    "@WORKING_DIRECTORY@": quote(str(project / "backend")),
    "@ENV_FILE@": quote(str(env_file)),
    "@PYTHON@": quote(str(project / "backend" / ".venv" / "bin" / "python")),
}
for marker, replacement in values.items():
    if marker not in template:
        raise SystemExit(f"unit template is missing {marker}")
    template = template.replace(marker, replacement)
if re.search(r"@[A-Z_]+@", template):
    raise SystemExit("unit template contains an unresolved placeholder")
output_path.write_text(template)
PY

sudo install -m 0644 -- "$UNIT_TMP" "$UNIT_FILE"
sudo systemctl daemon-reload
sudo systemctl enable --now archon-desktop-server.service

printf 'Installed the loopback-only Archon Desktop backend service.\n'
printf 'Remote TLS/private-ingress state is not verified by this installer.\n'
