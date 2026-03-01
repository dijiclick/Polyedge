#!/bin/bash
# Full watchdog: ensures polyedge + perplexity proxy are always running
# If rate limit detected → waits 15min cooldown before restarting

# Rate limit check first
/home/ariad/.openclaw/workspace/polyedge/rate_limit_recovery.sh
RL_EXIT=$?
[ $RL_EXIT -eq 0 ] && [ -f /tmp/polyedge_rl_recovery.lock ] && {
  echo "[$(date)] In rate-limit cooldown, skipping restart"
  exit 0
}

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
nohup /home/ariad/.openclaw/workspace/polyedge/start_live.sh >> /home/ariad/.openclaw/workspace/polyedge/polyedge.log 2>&1 &
echo $! > "$PIDFILE"
echo "[$(date)] Polyedge started (PID $!)"
