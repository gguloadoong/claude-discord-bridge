# Claude Discord Bridge

Route Discord channels to separate [Claude Code](https://claude.ai/code) terminal sessions — each channel controls a different project.

```
┌──────────── Discord Server ─────────────┐
│  #frontend   #backend   #infra          │
└─────┬────────────┬────────────┬─────────┘
      │            │            │
      ▼            ▼            ▼
┌──────────┐ ┌──────────┐ ┌──────────┐
│ Claude   │ │ Claude   │ │ Claude   │
│ Code     │ │ Code     │ │ Code     │
│ ~/app    │ │ ~/api    │ │ ~/infra  │
└──────────┘ └──────────┘ └──────────┘
```

Talk in a Discord channel → Claude Code works on the mapped project → replies in the same channel.

## Features

- **Multi-project routing** — each Discord channel maps to a separate Claude Code session working on a different repo
- **Two-way communication** — Claude replies, edits messages, reacts with emoji, and reads channel history
- **Permission relay** — approve/deny tool use (file edits, shell commands) directly from Discord
- **Auto-reconnect** — bot retries failed deliveries, health-checks channel servers every 30s
- **Security** — localhost-only servers, optional shared secret auth, channel ID validation, request size limits
- **Easy monitoring** — all sessions run in tmux, switch between them with `Ctrl+B` + number

## Prerequisites

- [Node.js](https://nodejs.org) 18+
- [Claude Code](https://claude.ai/code) CLI installed and logged in
- [tmux](https://github.com/tmux/tmux)
- A [Discord bot](https://discord.com/developers/applications) with **Message Content Intent** enabled

## Quick Start

### 1. Create a Discord Bot

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. New Application → Bot → **Reset Token** → copy the token
3. Enable **Privileged Gateway Intents**:
   - `MESSAGE CONTENT INTENT` ✅
   - `SERVER MEMBERS INTENT` (optional)
4. Invite bot to your server with **Send Messages**, **Add Reactions**, **Read Message History** permissions:
   ```
   https://discord.com/oauth2/authorize?client_id=YOUR_APP_ID&permissions=76800&scope=bot
   ```

### 2. Install

```bash
git clone https://github.com/YOUR_USERNAME/claude-discord-bridge.git
cd claude-discord-bridge
npm install
```

### 3. Setup

```bash
npm run setup
```

This walks you through:
- Entering your bot token
- Adding channels (ID, name, project directory)
- Auto-generating `config.json` and per-project `.mcp.json` files

**Finding Channel IDs:** Discord Settings → Advanced → Developer Mode ON → right-click channel → Copy Channel ID

### 4. Start

```bash
npm start
```

This creates a tmux session with:
- Window 0: Discord bot
- Window 1+: One Claude Code session per channel

### 5. Monitor

The dashboard opens automatically in a new terminal window (macOS iTerm2). All channels are visible at once in a split-pane grid:

```
┌───────────────────────────┬───────────────────────────┐
│ #frontend -> ~/app [:8801]│ #backend -> ~/api [:8802] │
│                           │                           │
│  (Claude Code session)    │  (Claude Code session)    │
│                           │                           │
├───────────────────────────┼───────────────────────────┤
│ #infra -> ~/infra [:8803] │ Bot (3 channels)          │
│                           │                           │
│  (Claude Code session)    │  (bot routing logs)       │
│                           │                           │
└───────────────────────────┴───────────────────────────┘
  BRIDGE | ...                  Ctrl+B z=zoom q=jump d=detach
```

Each pane title shows: **channel name → project path [port]**

| Keys | Action |
|------|--------|
| `Ctrl+B` → `z` | **Zoom** — fullscreen the current pane (press again to return to grid) |
| `Ctrl+B` → `arrow` | Move focus between panes |
| `Ctrl+B` → `q` → number | Jump to a specific pane by number |
| `Ctrl+B` → `d` | Detach (keeps running in background) |

To reattach later:
```bash
tmux attach -t claude-discord-bridge
```

### 6. Stop

```bash
npm stop
```

## How It Works

```
Discord message
    │
    ▼
┌─────────┐     HTTP POST      ┌──────────────────┐     MCP stdio     ┌────────────┐
│  bot.js │ ──────────────────► │ channel-server.js│ ◄────────────────► │ Claude Code│
│         │  localhost:880x     │  (one per project)│                    │  (terminal) │
│  Routes │                     │                  │  Discord REST API  │            │
│  by     │                     │  Forwards to     │ ──────────────────► │  Reads,    │
│  channel│                     │  Claude Code     │  (replies, reacts) │  writes,   │
│  ID     │                     │                  │                    │  runs code │
└─────────┘                     └──────────────────┘                    └────────────┘
```

1. **bot.js** connects to Discord, receives messages, routes by channel ID to the correct port
2. **channel-server.js** (one per project) receives via HTTP, forwards to Claude Code via [MCP channel protocol](https://code.claude.com/docs/en/channels-reference)
3. **Claude Code** processes the request, uses tools to reply/react back through Discord REST API

## Configuration

### config.json

```json
{
  "channels": {
    "1234567890123456789": {
      "name": "frontend",
      "slug": "fe",
      "port": 8801,
      "cwd": "/home/user/my-frontend"
    }
  }
}
```

| Field | Description |
|-------|-------------|
| `name` | Display name (shown in logs) |
| `slug` | Short name for tmux window tab |
| `port` | Local HTTP port (unique per channel, starting from 8801) |
| `cwd` | Absolute path to the project directory |

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DISCORD_BOT_TOKEN` | Yes | Your Discord bot token |
| `BRIDGE_SECRET` | No | Shared secret for bot↔server authentication |
| `CONFIG_PATH` | No | Custom path to config.json |
| `REPLY_TIMEOUT_MS` | No | Warn in Discord if a delivered message gets no reply (default `120000`, `0` disables) |

### Security

**Shared secret** (recommended for shared machines):

```bash
# Generate a random secret
openssl rand -hex 16

# Add to .env
BRIDGE_SECRET=your_generated_secret
```

When set, bot.js sends the secret in `X-Bridge-Secret` header, and channel-server.js rejects requests without it.

**User allowlist** (recommended):

Add `allowed_users` to a channel in `config.json` to restrict who can trigger Claude Code:

```json
{
  "name": "my-project",
  "slug": "proj",
  "port": 8801,
  "cwd": "/path/to/project",
  "allowed_users": ["123456789012345678"]
}
```

Find your Discord user ID: User Settings → Advanced → Developer Mode ON → click your avatar → Copy User ID.

> **Warning**: Without `allowed_users`, anyone with access to the Discord channel can control Claude Code on the mapped project. Set this for any channel that isn't fully private.

## Discord Commands

Just talk naturally in the channel. Claude Code will:

- Read and modify files in the mapped project
- Run shell commands
- Create commits, PRs, etc.

### Permission Approval

When Claude needs to run a potentially dangerous tool, it sends a permission request:

```
[Permission Request]
Tool: Bash
Description: Run npm test

Reply `yes abcde` or `no abcde`
```

Reply with the exact code to approve or deny.

## Troubleshooting

### Diagnose first: `npm run doctor`

```bash
npm run doctor
```

Checks every point where a message can die, and prints what to fix:

1. `config.json` missing or wrong channel ID → the bot silently ignores the channel
2. **Message Content Intent** off → messages arrive with an empty body
3. Missing channel permissions (View / Send / History / Reactions) → the bot can read but cannot answer
4. `channel-server` not running → delivery fails (❌ reaction)
5. Port open but the Claude session behind it is gone → the message is delivered and never answered

### Recovering from Discord

The bot answers these itself, so they keep working when the session behind a
channel cannot reply — parked by a usage limit, or sitting on a terminal
prompt nobody is watching:

| Command | What it does |
|---------|--------------|
| `!ping` | Bot uptime and this channel's state |
| `!상태` / `!status` | State of every channel |
| `!재시작` / `!restart` | Restarts this channel's Claude session (`tmux respawn-pane`) |

`!재시작` respawns the pane under `run-channel.sh`, so the fresh session is
supervised exactly as `npm start` would have it. Only `allowed_users` may run
these when an allowlist is configured.

### "The session restarted and went quiet"

A fresh Claude Code session can stop on an interactive prompt — first-run theme
setup, *do you trust the files in this folder*, a re-login. The MCP server never
comes up, so the channel looks identical to every other failure. `monitor.js`
detects those prompts and the bot reports them to Discord with the prompt text.

### "Every channel went silent at once"

Usage limits are account-wide, so a single limit parks **all** channel sessions
at the same time. Claude Code does not exit — it prints
`Usage limit reached · continuing automatically when it resets` and waits. The
process stays up, the MCP port stays open, and `/health` keeps reporting `ok`,
so nothing downstream notices; messages are delivered into a session that
cannot answer.

`monitor.js` now reads that banner from the pane and `bot.js` relays it to
Discord — the limit, the reset time, and a follow-up when it clears. Messages
sent during the window are **not** replayed automatically (re-running a queued
command in a trading channel is not safe); resend them after the recovery
notice.

`npm run doctor` reports the limit state per channel under *5. 사용 한도 / 세션 상태*.

### "The bot reacts 👀 but never replies"

This is case 3 or 5 above.

- **Case 3** — the bot lacks *Send Messages* in that channel. Claude answers, Discord rejects it with a 403, and nothing appears. `npm run doctor` reports it per channel; the reply tool now returns the error instead of reporting a fake success.
- **Case 5** — the Claude Code session in that pane exited, but `channel-server.js` kept its port open. The channel server now shuts down when the session's stdio pipe closes, so `bot.js` marks the channel offline and posts a notice in Discord.

If a delivered message gets no reply, the bot checks the channel server and warns in Discord. Tune or disable it with `REPLY_TIMEOUT_MS` (default `120000`, `0` disables).

### Bot doesn't react to messages
- Check bot has **Message Content Intent** enabled in Discord Developer Portal
- Verify bot is in the server and has permissions in the channel
- Check bot logs: `tmux attach -t claude-discord-bridge` → `Ctrl+B → 0`

### Channel server is down
- Bot logs will show connection errors with ❌ emoji on the message
- Check the specific window: `Ctrl+B → <number>`
- Restart: `npm stop && npm start`

### Claude Code shows "channel not allowed"
- The `--dangerously-load-development-channels` flag is required during research preview
- If on a Team/Enterprise plan, admin must enable channels

### Messages not routing
- Verify channel IDs in `config.json` match your Discord channels
- Run `node -e "import('fs').then(f => console.log(JSON.parse(f.readFileSync('config.json','utf-8'))))"` to check

## Project Structure

```
claude-discord-bridge/
├── bot.js              # Discord gateway bot (message router)
├── channel-server.js   # MCP channel server (one per project)
├── setup.js            # Interactive setup wizard
├── doctor.js           # Diagnoses "the bot doesn't answer" (npm run doctor)
├── run-channel.sh      # Supervises one channel session (restarts if it exits)
├── start.sh            # tmux session launcher
├── config.json         # Channel → project mapping (generated)
├── config.example.json # Template for config.json
├── .env                # Bot token (generated, git-ignored)
├── package.json
├── LICENSE
└── README.md
```

## License

MIT
