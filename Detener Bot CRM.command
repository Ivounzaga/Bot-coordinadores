#!/bin/bash
set -u

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"

BOT_STOP_LABEL="Bot CRM Criticos" \
"$ROOT_DIR/Detener Bot Coordinadores.command"
