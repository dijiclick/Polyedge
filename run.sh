#!/bin/bash
# Polyedge launcher — loads .env and runs the trading system
set -a
source /home/ariad/.openclaw/workspace/polyedge/.env
set +a

# Start Perplexity proxy if not already running
if ! curl -sf http://localhost:8320/health > /dev/null 2>&1; then
  echo "[$(date)] Starting Perplexity proxy..."
  source /home/ariad/.venvs/scrapling/bin/activate
  nohup python3 /home/ariad/.openclaw/workspace/perplexity-proxy/server.py \
    > /tmp/perp-proxy.log 2>&1 &
  sleep 3
  if curl -sf http://localhost:8320/health > /dev/null 2>&1; then
    echo "[$(date)] ✅ Perplexity proxy up at http://localhost:8320/v1"
  else
    echo "[$(date)] ⚠️  Perplexity proxy failed to start (check /tmp/perp-proxy.log)"
  fi
else
  echo "[$(date)] ✅ Perplexity proxy already running"
fi

cd /home/ariad/.openclaw/workspace/polyedge
echo "[$(date)] Starting polyedge (ARMED=$ARMED, RISK=$RISK_LEVEL)"
exec npx tsx src/runner.ts --monitor
