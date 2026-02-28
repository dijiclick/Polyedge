#!/bin/bash
# Full watchdog: ensures polyedge + perplexity proxy are always running

# 1. Ensure Perplexity proxy is up
if ! curl -sf http://localhost:8320/health > /dev/null 2>&1; then
  echo "[$(date)] Restarting Perplexity proxy..."
  source /home/ariad/.venvs/scrapling/bin/activate
  nohup python3 /home/ariad/.openclaw/workspace/perplexity-proxy/server.py >> /tmp/perp-proxy.log 2>&1 &
  sleep 3
fi

# 2. Ensure polyedge is running
PIDFILE="/tmp/polyedge.pid"
if [ -f "$PIDFILE" ]; then
  PID=$(cat "$PIDFILE")
  if kill -0 "$PID" 2>/dev/null; then
    exit 0  # already running
  fi
fi

# Not running — start it
echo "[$(date)] Restarting polyedge..."
set -a && source /home/ariad/.openclaw/workspace/polyedge/.env && set +a
cd /home/ariad/.openclaw/workspace/polyedge
nohup npx tsx src/runner.ts --monitor >> /home/ariad/.openclaw/workspace/polyedge/polyedge.log 2>&1 &
echo $! > "$PIDFILE"
echo "[$(date)] Polyedge started (PID $!)"
