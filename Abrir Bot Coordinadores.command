#!/bin/bash
set -u

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_DIR="$ROOT_DIR/logs"
PID_FILE="$LOG_DIR/bot-coordinadores.pid"
PORT_FILE="$LOG_DIR/bot-coordinadores.port"
LOG_FILE="$LOG_DIR/bot-coordinadores.log"
BOT_LABEL="${BOT_DASHBOARD_LABEL:-Bot Coordinadores}"
URL_DEFAULT_PATH="${BOT_DASHBOARD_PATH:-/coordinadores.html}"

mkdir -p "$LOG_DIR" "$ROOT_DIR/data"
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

is_repo_cwd() {
  local pid="$1"
  local cwd

  cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n "s/^n//p" | head -n 1)"
  [[ "$cwd" == "$ROOT_DIR" ]]
}

port_has_this_repo() {
  local port="$1"
  local pid command

  while read -r pid; do
    [[ -n "$pid" ]] || continue
    command="$(ps -p "$pid" -o command= 2>/dev/null || true)"

    if [[ "$command" == *"$ROOT_DIR/server.js"* ]] || is_repo_cwd "$pid"; then
      return 0
    fi
  done < <(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)

  return 1
}

is_port_free() {
  local port="$1"
  ! lsof -tiTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1
}

find_free_port() {
  local port="$1"

  while ! is_port_free "$port"; do
    port=$((port + 1))
  done

  printf "%s" "$port"
}

echo "=== $BOT_LABEL ==="
echo "Carpeta: $ROOT_DIR"
echo

if [[ ! -f "$ROOT_DIR/.env" && -f "$ROOT_DIR/.env.example" ]]; then
  cp "$ROOT_DIR/.env.example" "$ROOT_DIR/.env"
  echo "Cree .env desde .env.example."
  echo "Importante: completa .env con GOOGLE_SHEET_ID, credenciales y la session de WhatsApp para enviar de verdad."
  echo
fi

PORT="$(read_env_value "PORT" "3000")"
if ! [[ "$PORT" =~ ^[0-9]+$ ]]; then
  echo "PORT invalido en .env: $PORT. Uso 3000."
  PORT="3000"
fi

NODE_BIN="$(command -v node || true)"
NPM_BIN="$(command -v npm || true)"

if [[ -z "$NODE_BIN" ]]; then
  echo "No encontre Node.js. Instala Node 20 o superior y vuelve a abrir este archivo."
  pause_and_exit 1
fi

if [[ -z "$NPM_BIN" ]]; then
  echo "No encontre npm. Revisa la instalacion de Node.js."
  pause_and_exit 1
fi

if [[ ! -d "$ROOT_DIR/node_modules" ]]; then
  echo "No encontre node_modules. Instalando dependencias con npm install..."
  "$NPM_BIN" install
  if [[ $? -ne 0 ]]; then
    echo "Fallo npm install. Revisa el error de arriba."
    pause_and_exit 1
  fi
  echo
fi

if [[ -f "$PID_FILE" ]]; then
  OLD_PID="$(tr -cd '0-9' < "$PID_FILE")"
  if [[ -n "$OLD_PID" ]] && kill -0 "$OLD_PID" 2>/dev/null; then
    if [[ -f "$PORT_FILE" ]]; then
      SAVED_PORT="$(tr -cd '0-9' < "$PORT_FILE")"
      if [[ -n "$SAVED_PORT" ]]; then
        PORT="$SAVED_PORT"
      fi
    fi

    APP_URL="http://localhost:${PORT}${URL_DEFAULT_PATH}"
    echo "El bot ya esta abierto con PID $OLD_PID."
    echo "Abriendo dashboard: $APP_URL"
    open "$APP_URL"
    pause_and_exit 0
  fi

  rm -f "$PID_FILE"
fi

if ! is_port_free "$PORT"; then
  if port_has_this_repo "$PORT"; then
    APP_URL="http://localhost:${PORT}${URL_DEFAULT_PATH}"
    echo "El bot ya esta abierto en el puerto $PORT."
    echo "$PORT" > "$PORT_FILE"
    echo "Abriendo dashboard: $APP_URL"
    open "$APP_URL"
    pause_and_exit 0
  fi

  REQUESTED_PORT="$PORT"
  PORT="$(find_free_port "$((PORT + 1))")"
  echo "El puerto $REQUESTED_PORT esta ocupado por otro proceso. Uso el puerto libre $PORT para este repo."
  echo
fi

APP_URL="http://localhost:${PORT}${URL_DEFAULT_PATH}"

echo "Levantando servidor..."
echo "Log: $LOG_FILE"
: > "$LOG_FILE"

PORT="$PORT" nohup "$NODE_BIN" "$ROOT_DIR/server.js" >> "$LOG_FILE" 2>&1 < /dev/null &
SERVER_PID=$!
echo "$SERVER_PID" > "$PID_FILE"
echo "$PORT" > "$PORT_FILE"

echo "PID: $SERVER_PID"
echo "Esperando a que responda http://localhost:$PORT ..."

READY="no"
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30; do
  if curl -fsS "http://localhost:$PORT/" >/dev/null 2>&1; then
    READY="yes"
    break
  fi

  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "El servidor se cerro al iniciar. Ultimas lineas del log:"
    tail -40 "$LOG_FILE"
    rm -f "$PID_FILE" "$PORT_FILE"
    pause_and_exit 1
  fi

  sleep 1
done

if [[ "$READY" != "yes" ]]; then
  echo "El servidor no respondio a tiempo. Revisa el log:"
  echo "$LOG_FILE"
  pause_and_exit 1
fi

echo
echo "Bot abierto."
echo "Dashboard: $APP_URL"
open "$APP_URL"

pause_and_exit 0
