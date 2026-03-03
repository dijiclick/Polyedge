#!/usr/bin/env bash
# Polyedge Watchdog — restarts services if down, sends Telegram alert
set -euo pipefail

RESTARTED=""
TELEGRAM_BOT_TOKEN="8368586173:AAGcL1dNnR06Q5AsrIy26Ud9NtOcUPS4GbU"
TELEGRAM_CHAT_ID="63129119"
POLYEDGE_DIR="/home/ariad/.openclaw/workspace/Polyedge"

send_telegram() {
  local msg="$1"
  curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    -d chat_id="${TELEGRAM_CHAT_ID}" \
    -d text="🔧 Watchdog: ${msg}" \
    -d parse_mode="HTML" > /dev/null 2>&1 || true
}

# 1) Check if tsx src/runner.ts is running
if ! pgrep -f "tsx src/runner.ts" > /dev/null 2>&1; then
  echo "$(date): runner.ts not running, restarting in tmux:polyedge..."
  tmux kill-session -t polyedge 2>/dev/null || true
  tmux new-session -d -s polyedge "cd ${POLYEDGE_DIR} && source .env && ARMED=false npx tsx src/runner.ts --monitor 2>&1 | tee /tmp/paper-trading.log"
  RESTARTED="${RESTARTED}runner.ts "
fi

# 2) Check if perplexity-proxy is running
if ! pgrep -f "perplexity-proxy" > /dev/null 2>&1; then
  echo "$(date): perplexity-proxy not running, restarting..."
  cd ${POLYEDGE_DIR} && nohup npx perplexity-proxy > /tmp/perplexity-proxy.log 2>&1 &
  RESTARTED="${RESTARTED}perplexity-proxy "
fi

# 3) Send Telegram alert if anything was restarted
if [ -n "$RESTARTED" ]; then
  send_telegram "Restarted: ${RESTARTED}"
  echo "$(date): Telegram alert sent for: ${RESTARTED}"
else
  echo "$(date): All services running OK"
fi
