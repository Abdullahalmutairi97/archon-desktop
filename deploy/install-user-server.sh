#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
SERVICE_NAME="archon-desktop-server.service"
CONFIRM_ROOTS="false"
ARCHON_ROOT=""
WORKSPACE_ROOTS=()
SERVICE_USER="$(id -un)"
SERVICE_UID="$(id -u)"
SERVICE_HOME="$(getent passwd "$SERVICE_USER" | cut -d: -f6)"
CONFIG_HOME="${XDG_CONFIG_HOME:-$SERVICE_HOME/.config}"
ENV_FILE="${CONFIG_HOME}/archon-desktop/server.env"
UNIT_TEMPLATE="$PROJECT_ROOT/deploy/archon-desktop-user-server.service.in"
UNIT_DIR="$CONFIG_HOME/systemd/user"
UNIT_FILE="$UNIT_DIR/$SERVICE_NAME"
PYTHON="$PROJECT_ROOT/backend/.venv/bin/python"
UNIT_EXISTS="false"

usage() {
  cat <<'EOF'
Usage: deploy/install-user-server.sh --archon-root ABSOLUTE_PATH --workspace-root ABSOLUTE_PATH [options]

Required:
  --archon-root PATH          Existing absolute Archon root; it must also be
                              supplied as one of the --workspace-root values.
  --workspace-root PATH       Include every configured scratch and registered project root.
                              Repeat for each root.
  --confirm-workspace-roots-complete
                              Confirm that the full workspace set was supplied.

Options:
  --env-file PATH             External service environment file (default:
                              $XDG_CONFIG_HOME/archon-desktop/server.env, or
                              ~/.config/archon-desktop/server.env).
  -h, --help                  Show this help.

Installs and starts a same-user systemd service. It binds only to loopback and
enables local owner pairing. It does not enable lingering or install system-wide.
EOF
}

fail() {
  printf '%s\n' "$1" >&2
  exit 2
}

while (($#)); do
  case "$1" in
    --archon-root)
      (($# >= 2)) || fail "--archon-root requires a path"
      [[ -z "$ARCHON_ROOT" ]] || fail "Supply --archon-root only once."
      ARCHON_ROOT="$2"
      shift 2
      ;;
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
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "Unknown installer option. Use --help for usage."
      ;;
  esac
done

[[ "$EUID" -ne 0 ]] || fail "Run this installer as the desktop account, without sudo."
[[ "$SERVICE_USER" =~ ^[a-z_][a-z0-9_-]*\$?$ ]] || fail "Could not determine the current service account"
[[ -n "$SERVICE_HOME" && "$SERVICE_HOME" = /* ]] || fail "The current account has no absolute home directory"
[[ "$CONFIG_HOME" = /* && "$ENV_FILE" = /* ]] || fail "Configuration and environment paths must be absolute"
[[ -n "$ARCHON_ROOT" && "$ARCHON_ROOT" = /* ]] || fail "Supply an existing absolute --archon-root path."
[[ "$CONFIRM_ROOTS" == "true" && ${#WORKSPACE_ROOTS[@]} -gt 0 ]] || {
  fail "Supply --archon-root, every workspace root, and --confirm-workspace-roots-complete."
}
[[ -x "$PYTHON" ]] || fail "Backend virtualenv is missing; install backend dependencies first"
[[ -f "$UNIT_TEMPLATE" ]] || fail "The user-service unit template is missing"
command -v systemctl >/dev/null || fail "systemctl is unavailable; this installer requires systemd"
systemctl --user show-environment >/dev/null 2>&1 || fail "The current systemd user manager is unavailable; log into the desktop session and retry"
if [[ -e "$UNIT_FILE" || -L "$UNIT_FILE" ]]; then
  [[ -f "$UNIT_FILE" && ! -L "$UNIT_FILE" ]] || fail "A non-regular user unit path already exists at $UNIT_FILE."
  grep -Fqx '# Managed by deploy/install-user-server.sh.' "$UNIT_FILE" || fail "A user unit already exists at $UNIT_FILE and is not marked as managed by this installer."
  UNIT_EXISTS="true"
fi

ENV_FILE_RESOLVED="$(realpath -m -- "$ENV_FILE")"
case "$ENV_FILE_RESOLVED" in
  "$PROJECT_ROOT"|"$PROJECT_ROOT"/*)
    fail "Refusing to use a service environment file inside this repository."
    ;;
esac

if ! ARCHON_ROOT_RESOLVED="$(PYTHONPATH="$PROJECT_ROOT/backend" "$PYTHON" - "$ENV_FILE_RESOLVED" "$ARCHON_ROOT" "${WORKSPACE_ROOTS[@]}" <<'PY'
from pathlib import Path
import sys

from archon_server.provision import validate_external_output_location

try:
    env_file = Path(sys.argv[1])
    requested_root = Path(sys.argv[2])
    if not requested_root.is_absolute():
        raise ValueError
    if "\n" in str(requested_root) or "\r" in str(requested_root):
        raise ValueError
    archon_root = requested_root.resolve(strict=True)
    if not archon_root.is_dir():
        raise ValueError
    validate_external_output_location(
        env_file, sys.argv[3:], confirm_workspace_roots_complete=True
    )
    if not any(archon_root == Path(root).resolve(strict=True) for root in sys.argv[3:]):
        raise ValueError
except (OSError, ValueError):
    raise SystemExit("The external environment path or workspace roots failed validation.") from None
print(archon_root)
PY
)"; then
  fail "The external environment path or workspace roots failed validation."
fi

if [[ -L "$ENV_FILE" ]]; then
  fail "The external environment path must not be a symlink."
elif [[ -e "$ENV_FILE" ]]; then
  [[ -f "$ENV_FILE" ]] || fail "The existing environment path is not a regular file."
  MODE="$(stat -c '%a' -- "$ENV_FILE")"
  FILE_OWNER="$(stat -c '%u' -- "$ENV_FILE")"
  [[ "$MODE" == "600" ]] || fail "The existing environment file must already have mode 0600; it was not changed."
  [[ "$FILE_OWNER" == "$SERVICE_UID" ]] || fail "The existing environment file must be owned by this account; it was not changed."
  PARENT_MODE="$(stat -c '%a' -- "$(dirname -- "$ENV_FILE")")"
  PARENT_OWNER="$(stat -c '%u' -- "$(dirname -- "$ENV_FILE")")"
  [[ "$PARENT_MODE" == "700" && "$PARENT_OWNER" == "$SERVICE_UID" ]] || fail "The existing environment parent must be owned by this account with mode 0700; it was not changed."
  "$PYTHON" - "$ENV_FILE" "$ARCHON_ROOT_RESOLVED" <<'PY'
from pathlib import Path
import re
import sys

path = Path(sys.argv[1])
expected_archon_root = sys.argv[2]
required = {
    "ARCHON_DESKTOP_ARCHON_ROOT": expected_archon_root,
    "ARCHON_DESKTOP_LOCAL_OWNER_MODE": "true",
    "ARCHON_DESKTOP_BIND_HOST": "127.0.0.1",
    "ARCHON_DESKTOP_REMOTE_ACCESS_MODE": "disabled",
}
seen: dict[str, str] = {}
for line in path.read_text().splitlines():
    stripped = line.strip()
    if not stripped or stripped.startswith("#"):
        continue
    match = re.fullmatch(r"([A-Z0-9_]+)\s*=\s*(.*?)\s*", stripped)
    if not match:
        continue
    key, value = match.groups()
    if key in required or key in {"ARCHON_DESKTOP_REMOTE_BASE_URL", "ARCHON_DESKTOP_FIXTURE_MODE"}:
        if key in seen:
            raise SystemExit("The existing environment file has duplicate local service settings.")
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
            sentinel = "\x00"
            value = value.replace("\\\\", sentinel).replace('\\"', '"').replace(sentinel, "\\")
        seen[key] = value
for key, expected in required.items():
    if seen.get(key) != expected:
        raise SystemExit("The existing environment file must configure local pairing, loopback binding and disabled remote access.")
if "ARCHON_DESKTOP_REMOTE_BASE_URL" in seen:
    raise SystemExit("Unset ARCHON_DESKTOP_REMOTE_BASE_URL when remote access is disabled.")
if seen.get("ARCHON_DESKTOP_FIXTURE_MODE", "false").lower() == "true":
    raise SystemExit("Fixture mode cannot be enabled in the local service environment.")
PY
else
  PROVISION_ARGS=(
    --output "$ENV_FILE"
    --confirm-workspace-roots-complete
  )
  for workspace_root in "${WORKSPACE_ROOTS[@]}"; do
    PROVISION_ARGS+=(--workspace-root "$workspace_root")
  done
  (cd "$PROJECT_ROOT/backend" && PYTHONPATH="$PROJECT_ROOT/backend" "$PYTHON" -m archon_server.provision "${PROVISION_ARGS[@]}")
  "$PYTHON" - "$ENV_FILE" "$ARCHON_ROOT_RESOLVED" <<'PY'
from pathlib import Path
import os
import stat
import sys

path = Path(sys.argv[1])
archon_root = sys.argv[2]
if "\n" in archon_root or "\r" in archon_root:
    raise SystemExit("The Archon root cannot contain a newline.")
quoted_archon_root = '"' + archon_root.replace("\\", "\\\\").replace('"', '\\"') + '"'
flags = os.O_WRONLY | os.O_APPEND | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
fd = os.open(path, flags)
try:
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o600:
        raise SystemExit("The new environment file failed owner or permission checks.")
    settings = (
        f"ARCHON_DESKTOP_ARCHON_ROOT={quoted_archon_root}\n"
        "ARCHON_DESKTOP_LOCAL_OWNER_MODE=true\n"
        "ARCHON_DESKTOP_BIND_HOST=127.0.0.1\n"
        "ARCHON_DESKTOP_REMOTE_ACCESS_MODE=disabled\n"
    )
    os.write(fd, settings.encode("utf-8"))
    os.fsync(fd)
finally:
    os.close(fd)
PY
fi

UNIT_TMP="$(mktemp)"
cleanup() { rm -f -- "$UNIT_TMP"; }
trap cleanup EXIT
"$PYTHON" - "$UNIT_TEMPLATE" "$UNIT_TMP" "$SERVICE_HOME" "$PROJECT_ROOT" "$ENV_FILE_RESOLVED" <<'PY'
from pathlib import Path
import re
import sys

template_path, output_path, home, project, env_file = map(Path, sys.argv[1:])
template = template_path.read_text()

def quote(value: str) -> str:
    if "\n" in value or "\r" in value:
        raise SystemExit("systemd paths and values cannot contain newlines")
    escaped = value.replace("\\", "\\\\").replace('"', '\\"').replace("%", "%%")
    return f'"{escaped}"'

values = {
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

mkdir -p -- "$UNIT_DIR"
if [[ "$UNIT_EXISTS" == "true" ]]; then
  cmp -s -- "$UNIT_TMP" "$UNIT_FILE" || fail "The managed user unit differs from this checkout's generated unit; inspect and remove it explicitly before reinstalling."
else
  install -m 0644 -- "$UNIT_TMP" "$UNIT_FILE"
fi
systemctl --user daemon-reload
systemctl --user enable --now "$SERVICE_NAME"

printf 'Installed and started the same-user Archon Desktop backend service.\n'
printf 'It stays available when the desktop UI closes; logout stops it unless an administrator has enabled lingering.\n'
