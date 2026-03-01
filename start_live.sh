#!/bin/bash
cd /home/ariad/.openclaw/workspace/Polyedge
set -a
source /home/ariad/.openclaw/workspace/Polyedge/.env
source /home/ariad/.openclaw/workspace/.env 2>/dev/null || true
set +a
export ARMED=true
# Loop forever — auto-restart on any exit
while true; do
  echo "[watchdog] Starting bot at $(date)"
  npx tsx src/runner.ts --monitor
  EXIT_CODE=$?
  echo "[watchdog] Bot exited with code $EXIT_CODE — restarting in 10s..."
  sleep 10
done
