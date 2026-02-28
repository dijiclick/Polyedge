#!/bin/bash
# Rate limit recovery — if polyedge exits with rate limit error, wait 15min then restart

LOGFILE="/home/ariad/.openclaw/workspace/polyedge/polyedge.log"
PIDFILE="/tmp/polyedge.pid"
LOCKFILE="/tmp/polyedge_rl_recovery.lock"
WAIT_MIN=15

# Don't run if already in recovery wait
if [ -f "$LOCKFILE" ]; then
  LOCKED_AT=$(cat "$LOCKFILE")
  NOW=$(date +%s)
  ELAPSED=$(( (NOW - LOCKED_AT) / 60 ))
  if [ "$ELAPSED" -lt "$WAIT_MIN" ]; then
    echo "[$(date)] Rate limit cooldown: ${ELAPSED}/${WAIT_MIN} min elapsed, waiting..."
    exit 0
  else
    rm -f "$LOCKFILE"
  fi
fi

# Check if polyedge is running
if [ -f "$PIDFILE" ] && kill -0 "$(cat $PIDFILE)" 2>/dev/null; then
  exit 0  # Running fine
fi

# Check last log lines for rate limit signature
if tail -50 "$LOGFILE" 2>/dev/null | grep -qiE "rate.?limit|429|too many requests|quota|ECONNRESET|ETIMEDOUT"; then
  echo "[$(date)] Rate limit detected — waiting ${WAIT_MIN} min before restart"
  date +%s > "$LOCKFILE"
  exit 0
fi

# Not running and no rate limit — normal restart (handled by watchdog_full.sh)
exit 0
