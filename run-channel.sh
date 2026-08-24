#!/bin/bash
# Supervise one Claude Code channel session.
#
# Without this, `claude ...; read` leaves a dead pane forever: if the session
# exits (crash, network drop, /exit), the channel goes silent until someone
# manually runs `npm start`. Restart it instead, with backoff so a session that
# dies instantly does not spin.
#
# Usage: run-channel.sh <cwd> <name>

CWD="$1"
NAME="${2:-channel}"

cd "$CWD" || { echo "[$NAME] cwd 없음: $CWD"; exec bash; }

MIN_DELAY=5
MAX_DELAY=120
delay=$MIN_DELAY

while true; do
  started=$(date +%s)

  claude --dangerously-load-development-channels server:discord-bridge
  code=$?

  ran=$(( $(date +%s) - started ))

  # A session that stayed up is a normal restart; a session that died on
  # startup is a failure loop — back off from that one only.
  if [ "$ran" -ge 60 ]; then
    delay=$MIN_DELAY
  fi

  echo ""
  echo "[$NAME] 세션 종료 (code $code, ${ran}초 실행) — ${delay}초 후 재시작"
  echo "[$NAME] 중단하려면 Ctrl+C"
  sleep "$delay"

  if [ "$ran" -lt 60 ]; then
    delay=$(( delay * 2 ))
    [ "$delay" -gt "$MAX_DELAY" ] && delay=$MAX_DELAY
  fi
done
