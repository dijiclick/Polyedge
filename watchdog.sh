#!/bin/bash
# Polyedge watchdog — restart on crash, stop after 9h
# Called by cron every 5 minutes

WORKDIR="/home/ariad/.openclaw/workspace/polyedge"
PIDFILE="$WORKDIR/.polyedge.pid"
STARTFILE="$WORKDIR/.polyedge.start"
LOGFILE="$WORKDIR/polyedge.log"
DURATION_SEC=32400   # 9 hours

now=$(date +%s)

# ── Check if we're past the 9h window ──────────────────────────────────────
if [ -f "$STARTFILE" ]; then
  start_ts=$(cat "$STARTFILE")
  elapsed=$(( now - start_ts ))
  if [ "$elapsed" -ge "$DURATION_SEC" ]; then
    echo "[$(date)] 9h session complete (${elapsed}s elapsed). Stopping." >> "$LOGFILE"
    # Kill any running process
    if [ -f "$PIDFILE" ]; then
      kill "$(cat $PIDFILE)" 2>/dev/null
      rm -f "$PIDFILE"
    fi
    # Remove cron entry
    crontab -l 2>/dev/null | grep -v "polyedge/watchdog.sh" | crontab -
    echo "[$(date)] Cron removed. Session ended." >> "$LOGFILE"
    exit 0
  fi
  remaining=$(( DURATION_SEC - elapsed ))
  echo "[$(date)] Elapsed: ${elapsed}s | Remaining: ${remaining}s" >> "$LOGFILE"
else
  # First run — record start time
  echo "$now" > "$STARTFILE"
  echo "[$(date)] Session started. Runs for 9h until $(date -d @$(( now + DURATION_SEC )))" >> "$LOGFILE"
fi

# ── Check if process is alive ───────────────────────────────────────────────
if [ -f "$PIDFILE" ]; then
  pid=$(cat "$PIDFILE")
  if kill -0 "$pid" 2>/dev/null; then
    echo "[$(date)] Process $pid alive. OK." >> "$LOGFILE"
    exit 0
  else
    echo "[$(date)] Process $pid is dead. Restarting..." >> "$LOGFILE"
    rm -f "$PIDFILE"
  fi
else
  echo "[$(date)] No PID file. Starting fresh..." >> "$LOGFILE"
fi

# ── Launch the system ───────────────────────────────────────────────────────
nohup bash "$WORKDIR/run.sh" >> "$LOGFILE" 2>&1 &
NEW_PID=$!
echo "$NEW_PID" > "$PIDFILE"
echo "[$(date)] Launched PID $NEW_PID" >> "$LOGFILE"
