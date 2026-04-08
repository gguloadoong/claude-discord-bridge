#!/bin/bash
# Start all services in a split-pane "war room" dashboard
# Usage: bash start.sh
#
# Dashboard layout (example with 3 channels):
# ┌───────────────────────┬───────────────────────┐
# │ #frontend → ~/app     │ #backend → ~/api      │
# │ (Claude Code)         │ (Claude Code)         │
# ├───────────────────────┼───────────────────────┤
# │ #infra → ~/infra      │ Bot (3 channels)      │
# │ (Claude Code)         │                       │
# └───────────────────────┴───────────────────────┘
#
# Controls:
#   Ctrl+B → z       Zoom into current pane (fullscreen / back to grid)
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

# ─── Read channel list ──────────────────────────────────────────────────────

CHANNELS=()
while IFS='|' read -r slug port channel_id name cwd; do
  CHANNELS+=("$slug|$port|$channel_id|$name|$cwd")
done < <(node --input-type=module -e "
import { readFileSync } from 'fs';
const config = JSON.parse(readFileSync(process.argv[1], 'utf-8'));
for (const [id, info] of Object.entries(config.channels)) {
  console.log([info.slug, info.port, id, info.name, info.cwd].join('|'));
}
" -- "$CONFIG")

NUM_CHANNELS=${#CHANNELS[@]}
TOTAL_PANES=$((NUM_CHANNELS + 1))

echo "Starting Claude Discord Bridge..."
echo "  Channels: $NUM_CHANNELS"
echo ""

# ─── Create tmux session ────────────────────────────────────────────────────

# First channel creates the session
IFS='|' read -r slug port channel_id name cwd <<< "${CHANNELS[0]}"
echo "  #$name -> $cwd (port: $port)"

ESCAPED_CWD=$(printf '%q' "$cwd")
tmux new-session -d -s "$SESSION" -n dashboard \
  "export DISCORD_BOT_TOKEN=$(printf '%q' "$DISCORD_BOT_TOKEN"); [ -n \"$BRIDGE_SECRET\" ] && export BRIDGE_SECRET=$(printf '%q' "$BRIDGE_SECRET"); cd $ESCAPED_CWD && claude --dangerously-load-development-channels server:discord-bridge; echo '[exited]'; read"

# Set env for subsequent panes
tmux set-environment -t "$SESSION" DISCORD_BOT_TOKEN "$DISCORD_BOT_TOKEN"
if [ -n "$BRIDGE_SECRET" ]; then
  tmux set-environment -t "$SESSION" BRIDGE_SECRET "$BRIDGE_SECRET"
fi

sleep 1

# Remaining channels as split panes
for ((i = 1; i < NUM_CHANNELS; i++)); do
  IFS='|' read -r slug port channel_id name cwd <<< "${CHANNELS[$i]}"
  echo "  #$name -> $cwd (port: $port)"

  tmux split-window -t "$SESSION:dashboard" \
    "cd $(printf '%q' "$cwd") && claude --dangerously-load-development-channels server:discord-bridge; echo '[exited]'; read"

  sleep 1
done

# Bot pane (last)
tmux split-window -t "$SESSION:dashboard" \
  "cd $(printf '%q' "$BRIDGE_DIR") && node bot.js; echo '[bot exited]'; read"

sleep 1

# Re-layout into even grid
tmux select-layout -t "$SESSION:dashboard" tiled

# ─── Pane titles with channel info ──────────────────────────────────────────

PANE_IDX=0
ICONS=("📊" "🎬" "🏠" "📂" "📂" "📂" "📂" "📂")
for ((i = 0; i < NUM_CHANNELS; i++)); do
  IFS='|' read -r slug port channel_id name cwd <<< "${CHANNELS[$i]}"
  short_cwd="${cwd/#$HOME/~}"
  tmux select-pane -t "$SESSION:dashboard.$PANE_IDX" \
    -T "${ICONS[$i]} $name  $short_cwd [:$port]"
  PANE_IDX=$((PANE_IDX + 1))
done
tmux select-pane -t "$SESSION:dashboard.$PANE_IDX" \
  -T "🤖 Bot ($NUM_CHANNELS channels)"

# ─── War Room Styling ──────────────────────────────────────────────────────

# Pane borders with dead-process detection
tmux set-option -t "$SESSION" pane-border-status top
tmux set-option -t "$SESSION" pane-border-format \
  ' #{?pane_active,#[bg=colour25 fg=colour255 bold],#[fg=colour245]} #{pane_title} #[default]#{?pane_dead,#[fg=colour196] DEAD,} '
tmux set-option -t "$SESSION" pane-border-style 'fg=colour238'
tmux set-option -t "$SESSION" pane-active-border-style 'fg=colour39'

# Status bar
tmux set-option -t "$SESSION" status on
tmux set-option -t "$SESSION" status-interval 5
tmux set-option -t "$SESSION" status-style 'bg=colour233 fg=colour250'
tmux set-option -t "$SESSION" status-left \
  "#[bg=colour25 fg=colour255 bold]  BRIDGE #[bg=colour233 fg=colour245] ${NUM_CHANNELS} channels "
tmux set-option -t "$SESSION" status-left-length 30
tmux set-option -t "$SESSION" status-right \
  '#[fg=colour245]%H:%M #[fg=colour238]| #[fg=colour245]z=zoom q=jump d=detach #[fg=colour238]| #[fg=colour214]localhost:8800'
tmux set-option -t "$SESSION" status-right-length 55

# Window title (shows in macOS window bar)
tmux set-option -t "$SESSION" set-titles on
tmux set-option -t "$SESSION" set-titles-string 'Claude Bridge'

# Select first pane
tmux select-pane -t "$SESSION:dashboard.0"

# ─── Open in new iTerm2 window (macOS) ──────────────────────────────────────

if [ "$(uname)" = "Darwin" ] && command -v osascript &>/dev/null; then
  osascript -e "
    tell application \"iTerm2\"
      create window with default profile command \"tmux attach -t $SESSION\"
      activate
    end tell
  " 2>/dev/null || {
    echo ""
    echo "Claude Discord Bridge is running!"
    echo "  Open: tmux attach -t $SESSION"
  }
else
  echo ""
  echo "Claude Discord Bridge is running!"
  echo ""
  echo "  Open dashboard:  tmux attach -t $SESSION"
  echo ""
  echo "  Controls:"
  echo "    Ctrl+B -> z        Zoom in/out (fullscreen toggle)"
  echo "    Ctrl+B -> arrow    Move between panes"
  echo "    Ctrl+B -> q        Show pane numbers, then press number"
  echo "    Ctrl+B -> d        Detach (keeps running)"
  echo ""
  echo "  Stop:  npm stop"
fi
