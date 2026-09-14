#!/bin/bash
# Smoke test: every entry point must actually LOAD.
# `node --check` only parses — it never catches a missing import, which is how
# a ReferenceError at line 15 shipped once. This runs the real thing.
#
# Usage: npm run smoke

set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

cat > "$TMP/config.json" <<'JSON'
{"channels":{"111111111111111111":{"name":"smoke","slug":"smoke","port":18797,"cwd":"/tmp"}}}
JSON

fail=0
pass() { echo "  ✅ $1"; }
bad()  { echo "  ❌ $1"; fail=1; }

echo "1. 문법"
for f in bot.js channel-server.js monitor.js doctor.js setup.js; do
  node --check "$DIR/$f" 2>/dev/null && pass "$f" || bad "$f 문법 오류"
done

echo "2. 모듈 로드 (import 누락 탐지)"

out=$(cd "$DIR" && CONFIG_PATH="$TMP/config.json" DISCORD_BOT_TOKEN=smoke \
  DASHBOARD_PORT=18797 MONITOR_PORT=18798 timeout 8 node bot.js 2>&1)
if grep -q "ReferenceError\|is not defined\|Cannot find" <<<"$out"; then
  bad "bot.js 로드 실패"; sed 's/^/     /' <<<"$out" | head -5
elif grep -q "Dashboard: http" <<<"$out"; then
  pass "bot.js"
else
  bad "bot.js 시작 로그 없음"; sed 's/^/     /' <<<"$out" | head -5
fi

out=$(cd "$DIR" && CONFIG_PATH="$TMP/config.json" DISCORD_BOT_TOKEN=smoke \
  timeout 5 node channel-server.js 18799 111111111111111111 smoke </dev/null 2>&1)
if grep -q "MCP connected" <<<"$out"; then pass "channel-server.js"
else bad "channel-server.js 로드 실패"; sed 's/^/     /' <<<"$out" | head -5; fi

out=$(cd "$TMP" && cp "$DIR"/*.js . 2>/dev/null; cd "$TMP" && \
  MONITOR_PORT=18796 timeout 5 node monitor.js 2>&1)
if grep -q "ReferenceError\|is not defined" <<<"$out"; then
  bad "monitor.js 로드 실패"; sed 's/^/     /' <<<"$out" | head -5
else pass "monitor.js"; fi

out=$(cd "$DIR" && CONFIG_PATH="$TMP/config.json" DISCORD_BOT_TOKEN=smoke \
  MONITOR_PORT=18795 timeout 25 node doctor.js 2>&1)
if grep -q "ReferenceError\|is not defined" <<<"$out"; then
  bad "doctor.js 로드 실패"; sed 's/^/     /' <<<"$out" | head -5
else pass "doctor.js"; fi

echo "3. 셸 스크립트"
for f in start.sh run-channel.sh; do
  bash -n "$DIR/$f" && pass "$f" || bad "$f 문법 오류"
done

echo
[ $fail -eq 0 ] && echo "모두 통과" || echo "실패 있음"
exit $fail
