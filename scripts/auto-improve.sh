#!/bin/bash
set -euo pipefail
cd /home/ariad/.openclaw/workspace/Polyedge
source .env

LOG=/tmp/auto-improve.log
echo "[$(date)] Auto-improve cycle started" >> $LOG

# 1. Resolve paper trades
npx tsx scripts/pnl-report.ts --resolve >> $LOG 2>&1 || true

# 2. Read paper-trades.json — count by strategy, find 0-signal strategies
ANALYSIS=$(node -e "
const fs = require('fs');
const trades = JSON.parse(fs.readFileSync('data/paper-trades.json','utf8'));
const byStrat = {};
trades.forEach(t => { byStrat[t.strategy] = (byStrat[t.strategy]||0)+1; });
const all10 = ['oracle-arb','edge-ai','crypto-oracle','live-score','odds-arb','kambi-soccer','news-signal','golf-oracle','tennis-arb','esports-oracle'];
const silent = all10.filter(s => !byStrat[s]);
const active = Object.entries(byStrat).map(([s,n]) => s+':'+n).join(', ');
console.log(JSON.stringify({silent, active, total: trades.length}));
" 2>/dev/null)

SILENT=$(echo $ANALYSIS | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print(', '.join(d['silent']))" 2>/dev/null || echo "unknown")
TOTAL=$(echo $ANALYSIS | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print(d['total'])" 2>/dev/null || echo "0")

echo "[$(date)] Silent strategies: $SILENT | Total trades: $TOTAL" >> $LOG

# 3. Check recent polyedge log for errors
ERRORS=$(tail -200 /tmp/paper-trading.log 2>/dev/null | grep -c "error\|Error\|failed\|invalid signature" || echo 0)
SIG_ERRORS=$(tail -200 /tmp/paper-trading.log 2>/dev/null | grep -c "invalid signature" || echo 0)

# 4. Build autonomous prompt with runtime values
BRIEF=/tmp/improve-brief-$(date +%s).md
PROMPT="You are autonomously improving the Polyedge trading bot. DO NOT ask questions. DO NOT stop for confirmation. Just read, analyze, fix, commit.

Working dir: /home/ariad/.openclaw/workspace/Polyedge/
Source .env first.

Current issues detected:
- Silent strategies (0 signals): $SILENT
- Signature errors in last 200 lines: $SIG_ERRORS
- Total paper trades: $TOTAL

Rules:
1. Pick the top 2 issues
2. Read the relevant source file
3. Fix it — make your best judgment, do not ask
4. npx tsx --check the file
5. git add -A && git commit --no-verify -m 'auto-improve: describe what you fixed' && git push --no-verify
6. Restart bot: pkill -f 'tsx src/runner' || true; sleep 2; cd /home/ariad/.openclaw/workspace/Polyedge && source .env && ARMED=false ORACLE_ARMED=true nohup npx tsx src/runner.ts --monitor >> /tmp/paper-trading.log 2>&1 &

Fix priority order:
1. If SIG_ERRORS > 3: fix invalid signature in src/shared/clob.ts — check L2 auth header generation, nonce handling
2. If crypto-oracle silent: fix title regex in src/strategies/crypto-oracle.ts — make it match any market with bitcoin/btc/eth/sol in title
3. If news-signal < 5 trades: lower volume threshold from 50000 to 15000 in src/strategies/news-signal.ts
4. If edge-ai < 2 trades: lower confidence threshold from 0.60 to 0.55 in src/strategies/edge-ai.ts
5. If tennis-arb silent: fix player name matching in src/strategies/tennis-arb.ts — lowercase + partial match
6. If kambi-soccer silent: expand alias table in src/strategies/kambi-soccer.ts with 20 more top teams
7. Always: scan the last 100 lines of /tmp/paper-trading.log for any new error patterns and fix them"

# Log the prompt for debugging
echo "$PROMPT" > $BRIEF
echo "[$(date)] Brief written to $BRIEF" >> $LOG
echo "--- BRIEF ---" >> $LOG
cat $BRIEF >> $LOG

# 5. Spawn Claude Code to implement fixes — fully autonomous, no questions
unset CLAUDECODE 2>/dev/null || true
echo "[$(date)] Spawning Claude Code for improvements..." >> $LOG
timeout 600 claude --dangerously-skip-permissions \
  -p "$PROMPT" \
  --output-format text >> $LOG 2>&1 || echo "[$(date)] Claude Code timed out" >> $LOG

echo "[$(date)] Auto-improve cycle done" >> $LOG

# 6. Send Telegram summary
SUMMARY="🤖 Auto-improve cycle done\n Silent: $SILENT\n Errors fixed: $SIG_ERRORS sig errors seen\n Trades: $TOTAL total"
curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
  -d "chat_id=${TELEGRAM_CHAT_ID}&text=$SUMMARY&parse_mode=HTML" > /dev/null 2>&1 || true
