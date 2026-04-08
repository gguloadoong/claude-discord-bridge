#!/usr/bin/env node
/**
 * tmux pane monitor — periodically captures Claude Code terminal output
 * and extracts status information (agents, tools, state, progress).
 *
 * Exposes parsed state via HTTP so bot.js dashboard can consume it.
 */
import { execSync } from 'node:child_process'
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MONITOR_PORT = parseInt(process.env.MONITOR_PORT || '8899')
const SESSION = 'claude-discord-bridge'
const POLL_INTERVAL = 5_000 // 5 seconds

// ─── Load config to know pane mapping ───────────────────────────────────────

let config
try {
  config = JSON.parse(readFileSync(join(__dirname, 'config.json'), 'utf-8'))
} catch {
  console.error('[monitor] config.json not found')
  process.exit(1)
}

const channels = Object.entries(config.channels).map(([id, info], idx) => ({
  id,
  name: info.name,
  slug: info.slug,
  paneIndex: idx,
}))

// ─── State store ────────────────────────────────────────────────────────────

const paneState = new Map() // slug -> parsed state

// ─── tmux capture + parse ───────────────────────────────────────────────────

function capturePaneRaw(paneIndex) {
  try {
    return execSync(
      `tmux capture-pane -t ${SESSION}:dashboard.${paneIndex} -p -S -50`,
      { encoding: 'utf-8', timeout: 3000 },
    )
  } catch {
    return null
  }
}

function parsePane(raw) {
  if (!raw) return { state: 'offline', agent: null, tool: null, context: null, session: null, lastAction: null }

  const lines = raw.split('\n').filter(Boolean)
  const result = {
    state: 'idle',
    agent: null,
    tool: null,
    toolDetail: null,
    context: null,
    session: null,
    lastAction: null,
    lastActions: [],
  }

  // Parse from bottom up for most recent state
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]

    // OMC status line: [OMC#4.11.0] | 5h:22% | thinking | session:1m | ctx:4%
    const omcMatch = line.match(/\|\s*(thinking|idle|working)\s*\|/)
    if (omcMatch && !result.state.match(/thinking|working/)) {
      result.state = omcMatch[1]
    }

    const ctxMatch = line.match(/ctx:(\d+)%/)
    if (ctxMatch && !result.context) {
      result.context = parseInt(ctxMatch[1])
    }

    const sessionMatch = line.match(/session:(\S+)/)
    if (sessionMatch && !result.session) {
      result.session = sessionMatch[1]
    }
  }

  // Parse from top (recent actions) looking for agent/tool patterns
  const actionPatterns = [
    { re: /Agent\(.*?subagent_type="([^"]+)"/, type: 'agent' },
    { re: /Agent\(.*?description="([^"]+)"/, type: 'agent_desc' },
    { re: /⏺\s*Agent\s*\(([^)]+)\)/, type: 'agent_raw' },
    { re: /⏺\s*Bash\((.{0,60})/, type: 'tool', name: 'Bash' },
    { re: /⏺\s*Read\((.{0,60})/, type: 'tool', name: 'Read' },
    { re: /⏺\s*Edit\((.{0,60})/, type: 'tool', name: 'Edit' },
    { re: /⏺\s*Write\((.{0,60})/, type: 'tool', name: 'Write' },
    { re: /⏺\s*Grep\((.{0,60})/, type: 'tool', name: 'Grep' },
    { re: /⏺\s*Glob\((.{0,60})/, type: 'tool', name: 'Glob' },
    { re: /⏺\s*Skill\((.{0,40})/, type: 'tool', name: 'Skill' },
    { re: /⏺\s*discord-bridge\s*-\s*reply/, type: 'tool', name: 'Reply' },
    { re: /← discord-bridge · (.+)/, type: 'incoming' },
    { re: /Running\.\.\./, type: 'state_running' },
  ]

  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 40); i--) {
    const line = lines[i]

    for (const pat of actionPatterns) {
      const m = line.match(pat.re)
      if (!m) continue

      if (pat.type === 'agent' && !result.agent) {
        result.agent = m[1]
        result.state = 'working'
      }
      if (pat.type === 'agent_desc') {
        result.toolDetail = m[1]
      }
      if (pat.type === 'agent_raw' && !result.agent) {
        // Try to extract subagent type
        const sub = m[1].match(/subagent_type="([^"]+)"/)
        if (sub) result.agent = sub[1]
        result.state = 'working'
      }
      if (pat.type === 'tool' && !result.tool) {
        result.tool = pat.name
        result.toolDetail = m[1]?.trim() || null
        if (result.state === 'idle') result.state = 'working'
      }
      if (pat.type === 'incoming') {
        result.lastAction = m[1].trim()
      }
      if (pat.type === 'state_running') {
        result.state = 'working'
      }

      // Collect last few actions for timeline
      if (result.lastActions.length < 5) {
        result.lastActions.push({
          type: pat.type,
          name: pat.name || pat.type,
          detail: m[1]?.trim().slice(0, 60) || null,
        })
      }
    }
  }

  return result
}

// ─── Polling loop ───────────────────────────────────────────────────────────

function poll() {
  for (const ch of channels) {
    const raw = capturePaneRaw(ch.paneIndex)
    const state = parsePane(raw)
    paneState.set(ch.slug, {
      ...state,
      name: ch.name,
      slug: ch.slug,
      updatedAt: Date.now(),
    })
  }
}

setInterval(poll, POLL_INTERVAL)
poll() // initial

// ─── HTTP server ────────────────────────────────────────────────────────────

const server = createServer((req, res) => {
  if (req.url === '/api/monitor') {
    const data = {}
    for (const [slug, state] of paneState) {
      data[slug] = state
    }
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    })
    res.end(JSON.stringify(data))
    return
  }
  res.writeHead(404)
  res.end()
})

server.listen(MONITOR_PORT, '127.0.0.1', () => {
  console.log(`[monitor] Listening on http://127.0.0.1:${MONITOR_PORT}/api/monitor`)
  console.log(`[monitor] Watching ${channels.length} panes (poll: ${POLL_INTERVAL / 1000}s)`)
})
