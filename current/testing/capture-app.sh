#!/usr/bin/env bash
# Capture a built app's real renderer under a virtual display via CDP.
#
# Usage: capture-app.sh <extracted-app-dir> <out.png> [port] [width] [height]
# Requires ELECTRON (electron binary) and PYTHON (with websockets) in the env.
# Disposable: it launches the app on a throwaway display and kills it afterwards.
set -euo pipefail

APP_DIR="$1"; OUT="$2"; PORT="${3:-9333}"; W="${4:-1440}"; H="${5:-900}"
ELECTRON="${ELECTRON:?set ELECTRON to the electron binary}"
PYTHON="${PYTHON:?set PYTHON to a python with websockets}"
HERE="$(cd "$(dirname "$0")" && pwd)"

export ELECTRON_DISABLE_SANDBOX=1
xvfb-run -a -s "-screen 0 1920x1200x24" "$ELECTRON" --no-sandbox \
  --remote-debugging-port="$PORT" "$APP_DIR" >/tmp/p2-capture-app.log 2>&1 &
APP_PID=$!
cleanup() {
  kill "$APP_PID" 2>/dev/null || true
  pkill -f "remote-debugging-port=$PORT" 2>/dev/null || true
}
trap cleanup EXIT

"$PYTHON" "$HERE/capture-cdp.py" "$PORT" "$OUT" "$W" "$H"
