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

```bash
tmux attach -t claude-discord-bridge
```

Switch windows:
| Keys | Window |
|------|--------|
| `Ctrl+B` → `0` | Bot logs |
| `Ctrl+B` → `1` | First project |
| `Ctrl+B` → `2` | Second project |
| `Ctrl+B` → `n` | Next window |
| `Ctrl+B` → `d` | Detach (keeps running) |

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

### Security

**Shared secret** (recommended for shared machines):

```bash
# Generate a random secret
openssl rand -hex 16

# Add to .env
BRIDGE_SECRET=your_generated_secret
```

When set, bot.js sends the secret in `X-Bridge-Secret` header, and channel-server.js rejects requests without it.

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
