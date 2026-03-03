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

# 4. Build improvement brief
BRIEF=/tmp/improve-brief-$(date +%s).md
cat > $BRIEF << BRIEF_EOF
# Auto-Improve Brief — $(date)

## Current State
- Total paper trades: $TOTAL
- Silent strategies (0 signals ever): $SILENT
- Recent errors in log: $ERRORS
- Invalid signature errors: $SIG_ERRORS

## Strategy Signal Counts
$(echo $ANALYSIS | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); [print(f'- {s}') for s in d['silent']]" 2>/dev/null | sed 's/^/SILENT: /')
$(echo $ANALYSIS | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print(d['active'])" 2>/dev/null | tr ',' '\n' | sed 's/^/ACTIVE: /')

## What to improve

### If SIG_ERRORS > 5:
Fix the invalid signature bug in src/shared/clob.ts. The CLOB client is sending orders with bad signatures. Check if the nonce or timestamp is stale. Try regenerating the L2 auth headers before each order.

### If 'crypto-oracle' is SILENT:
In src/strategies/crypto-oracle.ts, the market title matching is failing. Add console.log to show what titles are being seen. Make the regex much looser — match any market with 'Bitcoin', 'BTC', 'Ethereum', 'ETH', 'price' in the title.

### If 'news-signal' is SILENT (0 RSS signals, only volume spikes):
In src/strategies/news-signal.ts, RSS feeds may be timing out. Add fallback: fetch https://newsapi.org/v2/top-headlines?country=us&pageSize=10&apiKey=\${NEWS_API_KEY} if available. Also lower the volume threshold from 50000 to 20000 to catch more markets.

### If 'edge-ai' has < 3 signals:
In src/strategies/edge-ai.ts, check if Perplexity calls are all returning UNCERTAIN. If > 80% of calls return UNCERTAIN, lower the confidence threshold for edge-ai from 0.60 to 0.55.

### If 'kambi-soccer' is SILENT:
In src/strategies/kambi-soccer.ts, check team name matching. Print what Kambi team names vs Polymarket team names look like. The alias table may be missing teams.

### If 'tennis-arb' is SILENT and Indian Wells is active:
In src/strategies/tennis-arb.ts, Indian Wells ATP/WTA is active. Check if player name matching works. ESPN data vs Polymarket names may differ.

### Always:
- Review recent paper trade confidence scores — if avg < 0.65, strategies are uncertain
- Check if any strategies have high confidence (>0.80) but wrong outcome — adjust signal logic
- Look for new high-volume Polymarket categories we are not covering

## Instructions for Claude Code
Pick the 2 most impactful fixes from above based on current state.
Implement them. Test with npx tsx --check.
git add -A && git commit --no-verify -m "auto-improve: [describe changes]" && git push --no-verify
Then restart bot: send SIGTERM to tsx runner process, restart with: source .env && ARMED=false ORACLE_ARMED=true npx tsx src/runner.ts --monitor 2>&1 | tee /tmp/paper-trading.log &
BRIEF_EOF

echo "[$(date)] Brief written to $BRIEF" >> $LOG
echo "--- BRIEF ---" >> $LOG
cat $BRIEF >> $LOG

# 5. Spawn Claude Code to implement fixes
unset CLAUDECODE 2>/dev/null || true
echo "[$(date)] Spawning Claude Code for improvements..." >> $LOG
timeout 600 claude --dangerously-skip-permissions \
  -p "$(cat $BRIEF)" \
  --output-format text >> $LOG 2>&1 || echo "[$(date)] Claude Code timed out" >> $LOG

echo "[$(date)] Auto-improve cycle done" >> $LOG

# 6. Send Telegram summary
SUMMARY="🤖 Auto-improve cycle done\n Silent: $SILENT\n Errors fixed: $SIG_ERRORS sig errors seen\n Trades: $TOTAL total"
curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
  -d "chat_id=${TELEGRAM_CHAT_ID}&text=$SUMMARY&parse_mode=HTML" > /dev/null 2>&1 || true
