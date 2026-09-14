#!/bin/bash
# Supervise one Claude Code channel session.
#
# Without this, `claude ...; read` leaves a dead pane forever: if the session
# exits, the channel goes silent until someone manually runs `npm start`.
#
# But restarting is not free — every restart is a brand new session that burns
# quota and can post a startup/handover message. So: crashes restart with
# backoff, a clean exit does not restart at all, and a crash loop gives up
# instead of hammering.
#
# Usage: run-channel.sh <cwd> <name>

CWD="$1"
NAME="${2:-channel}"

cd "$CWD" || { echo "[$NAME] cwd 없음: $CWD"; exec bash; }

MIN_DELAY=${RESTART_MIN_DELAY:-5}
MAX_DELAY=${RESTART_MAX_DELAY:-120}
MAX_FAILS=${RESTART_MAX_FAILS:-5}   # consecutive short-lived exits before giving up
SHORT_RUN=${RESTART_SHORT_RUN:-60}  # a session that died within this many seconds "failed"

delay=$MIN_DELAY
fails=0

while true; do
  started=$(date +%s)

  claude --dangerously-load-development-channels server:discord-bridge
  code=$?

  ran=$(( $(date +%s) - started ))

  # Clean exit from a session that was actually running = the user quit.
  # Restarting here would fight them, and would re-announce the session.
  if [ "$code" -eq 0 ] && [ "$ran" -ge "$SHORT_RUN" ]; then
    echo ""
    echo "[$NAME] 세션이 정상 종료됐습니다 (${ran}초 실행). 자동 재시작하지 않습니다."
    echo "[$NAME] 다시 띄우려면: npm start  (또는 디스코드에서 !재시작)"
    exec bash
  fi

  if [ "$ran" -ge "$SHORT_RUN" ]; then
    fails=0
    delay=$MIN_DELAY
  else
    fails=$(( fails + 1 ))
  fi

  if [ "$fails" -ge "$MAX_FAILS" ]; then
    echo ""
    echo "[$NAME] ⚠️  ${MAX_FAILS}회 연속으로 즉시 종료됐습니다 (마지막 code $code)."
    echo "[$NAME] 재시작을 멈춥니다 — 계속 띄우면 한도만 소모합니다."
    echo "[$NAME] 이 창에서 직접 'claude' 를 실행해 원인을 확인하세요."
    exec bash
  fi

  echo ""
  echo "[$NAME] 세션 종료 (code $code, ${ran}초 실행) — ${delay}초 후 재시작 [${fails}/${MAX_FAILS}]"
  echo "[$NAME] 중단하려면 Ctrl+C"
  sleep "$delay"

  if [ "$ran" -lt "$SHORT_RUN" ]; then
    delay=$(( delay * 2 ))
    [ "$delay" -gt "$MAX_DELAY" ] && delay=$MAX_DELAY
  fi
done
