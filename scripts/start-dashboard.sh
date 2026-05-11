#!/bin/bash
set -euo pipefail

export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PORT="${PORT:-3000}"
PID_FILE="${PID_FILE:-/tmp/dashboard-whatsapp.pid}"
STDOUT_LOG="${STDOUT_LOG:-/tmp/dashboard-whatsapp.log}"
STDERR_LOG="${STDERR_LOG:-/tmp/dashboard-whatsapp-error.log}"
NODE_BIN="${NODE_BIN:-/usr/local/bin/node}"

cd "$APP_DIR" || exit 1

if lsof -tiTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  exit 0
fi

nohup "$NODE_BIN" "$APP_DIR/server.js" >> "$STDOUT_LOG" 2>> "$STDERR_LOG" < /dev/null &
echo $! > "$PID_FILE"
wait $!
