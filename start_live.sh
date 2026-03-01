#!/bin/bash
cd /home/ariad/.openclaw/workspace/Polyedge
set -a
source /home/ariad/.openclaw/workspace/Polyedge/.env
source /home/ariad/.openclaw/workspace/.env 2>/dev/null || true
set +a
export ARMED=true
exec npx tsx src/runner.ts --monitor
