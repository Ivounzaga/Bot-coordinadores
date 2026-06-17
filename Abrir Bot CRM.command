#!/bin/bash
set -u

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"

BOT_DASHBOARD_LABEL="Bot CRM Criticos" \
BOT_DASHBOARD_PATH="/crm-bot.html" \
"$ROOT_DIR/Abrir Bot Coordinadores.command"
