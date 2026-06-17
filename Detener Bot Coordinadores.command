#!/bin/bash
set -u

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_DIR="$ROOT_DIR/logs"
PID_FILE="$LOG_DIR/bot-coordinadores.pid"
PORT_FILE="$LOG_DIR/bot-coordinadores.port"
BOT_LABEL="${BOT_STOP_LABEL:-Bot Coordinadores}"

cd "$ROOT_DIR" || exit 1

read_env_value() {
  local key="$1"
  local fallback="$2"
  local env_file="$ROOT_DIR/.env"
  local line value

  if [[ -f "$env_file" ]]; then
    line="$(grep -E "^[[:space:]]*${key}[[:space:]]*=" "$env_file" | tail -n 1 || true)"
    if [[ -n "$line" ]]; then
      value="${line#*=}"
      value="$(printf "%s" "$value" | sed -E "s/^[[:space:]]+//; s/[[:space:]]+$//; s/^\"//; s/\"$//; s/^'//; s/'$//")"
      printf "%s" "$value"
      return
    fi
  fi

  printf "%s" "$fallback"
}

pause_and_exit() {
  local code="${1:-0}"
  echo
  read -r -p "Presiona Enter para cerrar esta ventana..." _
  exit "$code"
}

add_pid() {
  local candidate="$1"
  local existing

  [[ "$candidate" =~ ^[0-9]+$ ]] || return

  if [[ ${#PIDS_TO_STOP[*]} -gt 0 ]]; then
    for existing in "${PIDS_TO_STOP[@]}"; do
      [[ "$existing" == "$candidate" ]] && return
    done
  fi

  PIDS_TO_STOP+=("$candidate")
}

is_repo_cwd() {
  local pid="$1"
  local cwd

  cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n "s/^n//p" | head -n 1)"
  [[ "$cwd" == "$ROOT_DIR" ]]
}

stop_pids() {
  local label="$1"
  shift
  local pid
  local alive="yes"

  if [[ "$#" -eq 0 ]]; then
    return
  fi

  echo "Cerrando $label: $*"
  kill "$@" 2>/dev/null || true

  for _ in 1 2 3 4 5 6 7 8; do
    alive="no"
    for pid in "$@"; do
      if kill -0 "$pid" 2>/dev/null; then
        alive="yes"
      fi
    done

    [[ "$alive" == "no" ]] && return
    sleep 1
  done

  echo "Forzando cierre de $label..."
  kill -9 "$@" 2>/dev/null || true
}

if [[ -f "$PORT_FILE" ]]; then
  PORT="$(tr -cd '0-9' < "$PORT_FILE")"
else
  PORT="$(read_env_value "PORT" "3000")"
fi

if ! [[ "$PORT" =~ ^[0-9]+$ ]]; then
  PORT="3000"
fi

SESSION_DIR="$(read_env_value "WHATSAPP_SESSION_DIR" "session")"
if [[ "$SESSION_DIR" != /* ]]; then
  SESSION_DIR="$ROOT_DIR/$SESSION_DIR"
fi

echo "=== Detener $BOT_LABEL ==="
echo "Carpeta: $ROOT_DIR"
echo "Puerto: $PORT"
echo

declare -a PIDS_TO_STOP=()

if [[ -f "$PID_FILE" ]]; then
  PID_FROM_FILE="$(tr -cd '0-9' < "$PID_FILE")"
  if [[ -n "$PID_FROM_FILE" ]] && kill -0 "$PID_FROM_FILE" 2>/dev/null; then
    add_pid "$PID_FROM_FILE"
  fi
fi

while read -r pid command; do
  [[ "$command" == *"$ROOT_DIR/server.js"* ]] || [[ "$command" == *"server.js"* && "$command" == *"node"* ]] || continue

  if [[ "$command" == *"$ROOT_DIR/server.js"* ]] || is_repo_cwd "$pid"; then
    add_pid "$pid"
  fi
done < <(ps -axo pid=,command=)

while read -r port_pid; do
  if [[ -n "$port_pid" ]] && is_repo_cwd "$port_pid"; then
    add_pid "$port_pid"
  fi
done < <(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)

if [[ "${#PIDS_TO_STOP[@]}" -gt 0 ]] && curl -fsS "http://localhost:$PORT/api/control-state" >/dev/null 2>&1; then
  echo "Pidiendo al dashboard que detenga corridas activas..."
  curl -sS -X POST "http://localhost:$PORT/api/coordinadores-reminder-scheduler/stop" >/dev/null 2>&1 || true

  for type in initial followup reminder coordinadores coordinadoresReminder crmCritical; do
    curl -sS -X POST "http://localhost:$PORT/api/control/$type/stop" >/dev/null 2>&1 || true
  done

  sleep 3
elif [[ "${#PIDS_TO_STOP[@]}" -eq 0 ]]; then
  echo "No encontre un dashboard de esta carpeta respondiendo en http://localhost:$PORT."
fi

if [[ "${#PIDS_TO_STOP[@]}" -gt 0 ]]; then
  stop_pids "servidor" "${PIDS_TO_STOP[@]}"
else
  echo "No encontre un proceso del servidor para cerrar."
fi

rm -f "$PID_FILE"
rm -f "$PORT_FILE"

declare -a BOT_BROWSER_PIDS=()
while read -r pid command; do
  [[ "$command" == *"--user-data-dir=$SESSION_DIR"* ]] || continue
  BOT_BROWSER_PIDS+=("$pid")
done < <(ps -axo pid=,command=)

if [[ "${#BOT_BROWSER_PIDS[@]}" -gt 0 ]]; then
  stop_pids "Chrome/Puppeteer del bot" "${BOT_BROWSER_PIDS[@]}"
fi

echo
echo "Listo. $BOT_LABEL detenido."

pause_and_exit 0
