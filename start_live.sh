#!/bin/bash
cd /home/ariad/.openclaw/workspace/polyedge
set -a
source /home/ariad/.openclaw/workspace/polyedge/.env
source /home/ariad/.openclaw/workspace/.env
set +a
export ARMED=true
exec npx tsx src/runner.ts --monitor
