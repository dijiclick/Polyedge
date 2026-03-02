#!/bin/bash
# fix-perplexity.sh
# Auto-detect and fix Perplexity proxy issues.
# Called by cron (*/5) and by edge-ai when it gets a proxy error.
#
# Checks:
#   1. Is proxy process running? If not, restart it.
#   2. Is proxy responding? If not, restart it.
#   3. Are tokens working? Test with a simple query.
#   4. If tokens dead → alert to Telegram (can't auto-refresh without browser)

PROXY_PY="/home/ariad/.openclaw/workspace/perplexity-proxy/server.py"
PROXY_PORT=8320
PROXY_LOG="/tmp/perp-proxy.log"
BOT_TOKEN="8368586173:AAGcL1dNnR06Q5AsrIy26Ud9NtOcUPS4GbU"
CHAT_ID="63129119"

tg_alert() {
  local msg="$1"
  /mnt/c/Windows/System32/curl.exe -s \
    "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
    -d "chat_id=${CHAT_ID}&text=${msg}&parse_mode=HTML" > /dev/null 2>&1
}

log() { echo "[perp-fix] $(date '+%H:%M:%S') $1"; }

# ── 1. Check if proxy process is running ──────────────────────────────────────
PROXY_PID=$(pgrep -f "python.*server.py" 2>/dev/null | head -1)

if [ -z "$PROXY_PID" ]; then
  log "Proxy not running — starting..."
  cd "$(dirname "$PROXY_PY")" || exit 1
  source /home/ariad/.openclaw/workspace/.env 2>/dev/null || true
  nohup python3 "$PROXY_PY" >> "$PROXY_LOG" 2>&1 &
  sleep 3
  PROXY_PID=$(pgrep -f "python.*server.py" 2>/dev/null | head -1)
  if [ -n "$PROXY_PID" ]; then
    log "Proxy restarted (PID $PROXY_PID)"
    tg_alert "✅ Perplexity proxy restarted (was dead)"
  else
    log "ERROR: Proxy failed to start"
    tg_alert "❌ Perplexity proxy failed to start — check logs"
    exit 1
  fi
else
  log "Proxy running (PID $PROXY_PID)"
fi

# ── 2. Check if proxy responds to HTTP ───────────────────────────────────────
HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "http://localhost:${PROXY_PORT}/v1/models" 2>/dev/null)

if [ "$HTTP_STATUS" != "200" ]; then
  log "Proxy not responding (HTTP $HTTP_STATUS) — killing and restarting..."
  kill "$PROXY_PID" 2>/dev/null
  sleep 2
  cd "$(dirname "$PROXY_PY")" || exit 1
  source /home/ariad/.openclaw/workspace/.env 2>/dev/null || true
  nohup python3 "$PROXY_PY" >> "$PROXY_LOG" 2>&1 &
  sleep 3
  log "Proxy restarted after HTTP failure"
  tg_alert "🔄 Perplexity proxy restarted (HTTP failure)"
fi

# ── 3. Test a real token query ────────────────────────────────────────────────
TEST_RESPONSE=$(curl -s --max-time 15 \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer test" \
  -d '{"model":"llama-3.1-sonar-small-128k-online","messages":[{"role":"user","content":"Say OK"}],"max_tokens":10}' \
  "http://localhost:${PROXY_PORT}/v1/chat/completions" 2>/dev/null)

if echo "$TEST_RESPONSE" | grep -q '"content"'; then
  log "Proxy healthy — tokens working ✓"
  exit 0
fi

# Check for specific error types
if echo "$TEST_RESPONSE" | grep -qi "401\|unauthorized\|invalid.*token\|session.*expired"; then
  log "ERROR: Tokens expired/invalid"
  tg_alert "⚠️ Perplexity tokens expired — need manual refresh at perplexity.ai (accounts: @dollicons.com / Boss@3838)"
  exit 2
fi

if echo "$TEST_RESPONSE" | grep -qi "429\|rate.limit\|too many"; then
  log "Rate limited — waiting"
  tg_alert "⏳ Perplexity rate limited — will auto-recover"
  exit 0
fi

if echo "$TEST_RESPONSE" | grep -qi "503\|502\|bad gateway\|service unavail"; then
  log "Perplexity API down — restarting proxy to cycle tokens"
  kill "$PROXY_PID" 2>/dev/null; sleep 2
  source /home/ariad/.openclaw/workspace/.env 2>/dev/null || true
  nohup python3 "$PROXY_PY" >> "$PROXY_LOG" 2>&1 &
  sleep 3
  log "Proxy restarted after API error"
  exit 0
fi

log "Unknown proxy response: ${TEST_RESPONSE:0:100}"
log "Attempting proxy restart..."
kill "$PROXY_PID" 2>/dev/null; sleep 2
source /home/ariad/.openclaw/workspace/.env 2>/dev/null || true
nohup python3 "$PROXY_PY" >> "$PROXY_LOG" 2>&1 &
sleep 3
log "Proxy restarted"
