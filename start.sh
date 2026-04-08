#!/bin/bash
# Start all services in a split-pane "war room" dashboard
# Usage: bash start.sh
#
# Dashboard layout (example with 3 channels):
# ┌─────────────────┬─────────────────┐
# │  #channel-1      │  #channel-2      │
# │  (Claude Code)   │  (Claude Code)   │
# ├─────────────────┼─────────────────┤
# │  #channel-3      │  Bot logs        │
# │  (Claude Code)   │                  │
# └─────────────────┴─────────────────┘
#
# Controls:
#   Ctrl+B → z       Zoom into current pane (fullscreen toggle)
#   Ctrl+B → arrow    Move between panes
#   Ctrl+B → q        Show pane numbers, then press number to jump
#   Ctrl+B → d        Detach (keeps running in background)

set -e

BRIDGE_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG="$BRIDGE_DIR/config.json"
SESSION="claude-discord-bridge"

# ─── Load .env ───────────────────────────────────────────────────────────────

if [ -f "$BRIDGE_DIR/.env" ]; then
  set -a
  source "$BRIDGE_DIR/.env"
  set +a
fi

if [ -z "$DISCORD_BOT_TOKEN" ]; then
  echo "Error: DISCORD_BOT_TOKEN not set. Run: npm run setup"
  exit 1
fi

if [ ! -f "$CONFIG" ]; then
  echo "Error: config.json not found. Run: npm run setup"
  exit 1
fi

# ─── Kill existing session ───────────────────────────────────────────────────

if tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "Stopping existing session..."
  tmux kill-session -t "$SESSION"
  sleep 1
fi

# ─── Build env string for tmux ───────────────────────────────────────────────

ENV_EXPORT="export DISCORD_BOT_TOKEN='$DISCORD_BOT_TOKEN'"
if [ -n "$BRIDGE_SECRET" ]; then
  ENV_EXPORT="$ENV_EXPORT; export BRIDGE_SECRET='$BRIDGE_SECRET'"
fi

# ─── Read channel list ──────────────────────────────────────────────────────

CHANNELS=()
while IFS='|' read -r slug port channel_id name cwd; do
  CHANNELS+=("$slug|$port|$channel_id|$name|$cwd")
done < <(node --input-type=module -e "
import { readFileSync } from 'fs';
const config = JSON.parse(readFileSync('$CONFIG', 'utf-8'));
for (const [id, info] of Object.entries(config.channels)) {
  console.log([info.slug, info.port, id, info.name, info.cwd].join('|'));
}
")

NUM_CHANNELS=${#CHANNELS[@]}
TOTAL_PANES=$((NUM_CHANNELS + 1))  # channels + bot

echo "Starting Claude Discord Bridge..."
echo "  Channels: $NUM_CHANNELS"
echo ""

# ─── Create tmux session with split-pane dashboard ──────────────────────────

# Calculate grid: aim for roughly square layout
if [ "$TOTAL_PANES" -le 2 ]; then
  COLS=2; ROWS=1
elif [ "$TOTAL_PANES" -le 4 ]; then
  COLS=2; ROWS=2
elif [ "$TOTAL_PANES" -le 6 ]; then
  COLS=3; ROWS=2
elif [ "$TOTAL_PANES" -le 9 ]; then
  COLS=3; ROWS=3
else
  COLS=4; ROWS=$(( (TOTAL_PANES + 3) / 4 ))
fi

# Pane 0: first channel (created with the session)
IFS='|' read -r slug port channel_id name cwd <<< "${CHANNELS[0]}"
echo "  #$name -> $cwd"

tmux new-session -d -s "$SESSION" -n dashboard \
  "$ENV_EXPORT; cd '$cwd' && claude --dangerously-load-development-channels server:discord-bridge; echo '[exited]'; read"

sleep 1

# Remaining channels as split panes
for ((i = 1; i < NUM_CHANNELS; i++)); do
  IFS='|' read -r slug port channel_id name cwd <<< "${CHANNELS[$i]}"
  echo "  #$name -> $cwd"

  tmux split-window -t "$SESSION:dashboard" \
    "$ENV_EXPORT; cd '$cwd' && claude --dangerously-load-development-channels server:discord-bridge; echo '[exited]'; read"

  sleep 1
done

# Bot pane (last pane, bottom-right)
tmux split-window -t "$SESSION:dashboard" \
  "$ENV_EXPORT; cd '$BRIDGE_DIR' && node bot.js; echo '[bot exited]'; read"

sleep 1

# Re-layout into even grid
tmux select-layout -t "$SESSION:dashboard" tiled

# ─── Style the panes ────────────────────────────────────────────────────────

# Set pane titles for identification
PANE_IDX=0
for ((i = 0; i < NUM_CHANNELS; i++)); do
  IFS='|' read -r slug port channel_id name cwd <<< "${CHANNELS[$i]}"
  tmux select-pane -t "$SESSION:dashboard.$PANE_IDX" -T "#$name"
  PANE_IDX=$((PANE_IDX + 1))
done
tmux select-pane -t "$SESSION:dashboard.$PANE_IDX" -T "Bot"

# Enable pane border labels
tmux set-option -t "$SESSION" pane-border-status top
tmux set-option -t "$SESSION" pane-border-format ' #{pane_title} '
tmux set-option -t "$SESSION" pane-border-style 'fg=colour240'
tmux set-option -t "$SESSION" pane-active-border-style 'fg=colour51'

# Select first pane
tmux select-pane -t "$SESSION:dashboard.0"

# ─── Open in new iTerm2 window ──────────────────────────────────────────────

if [ "$(uname)" = "Darwin" ] && command -v osascript &>/dev/null; then
  osascript -e "
    tell application \"iTerm2\"
      create window with default profile command \"tmux attach -t $SESSION\"
      activate
    end tell
  " 2>/dev/null || tmux attach -t "$SESSION"
else
  echo ""
  echo "Claude Discord Bridge is running!"
  echo ""
  echo "  Open dashboard:  tmux attach -t $SESSION"
  echo ""
  echo "  Controls:"
  echo "    Ctrl+B -> z        Zoom in/out (fullscreen toggle)"
  echo "    Ctrl+B -> arrow    Move between panes"
  echo "    Ctrl+B -> q        Show pane numbers"
  echo "    Ctrl+B -> d        Detach (keeps running)"
  echo ""
  echo "  Stop:  npm stop"
fi
