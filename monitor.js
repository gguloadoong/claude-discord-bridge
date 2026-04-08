#!/usr/bin/env node
/**
 * Monitor — captures Claude Code terminal output + GitHub project data.
 * Exposes parsed state via HTTP for the web dashboard.
 */
import { execSync } from 'node:child_process'
import { createServer } from 'node:http'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MONITOR_PORT = parseInt(process.env.MONITOR_PORT || '8899')
const SESSION = 'claude-discord-bridge'
const PANE_POLL = 5_000    // 5s for tmux
const GH_POLL = 60_000     // 60s for GitHub
const PERSIST_INTERVAL = 30_000 // 30s

// ─── Config ─────────────────────────────────────────────────────────────────

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
  cwd: info.cwd,
  repo: info.repo || null,
}))

// ─── Persistent state ───────────────────────────────────────────────────────

const PERSIST_PATH = join(__dirname, '.dashboard-state.json')
let persistedState = { dailyMessages: {}, errors: [] }
try {
  if (existsSync(PERSIST_PATH)) {
    persistedState = JSON.parse(readFileSync(PERSIST_PATH, 'utf-8'))
    // Reset daily counts if new day
    const today = new Date().toISOString().slice(0, 10)
    if (persistedState.date !== today) {
      persistedState.dailyMessages = {}
      persistedState.date = today
    }
  }
} catch {}

function persist() {
  try {
    persistedState.date = new Date().toISOString().slice(0, 10)
    writeFileSync(PERSIST_PATH, JSON.stringify(persistedState, null, 2))
  } catch {}
}

setInterval(persist, PERSIST_INTERVAL)

// ─── State stores ───────────────────────────────────────────────────────────

const paneState = new Map()   // slug -> parsed terminal state
const githubState = new Map() // slug -> GitHub data

// ─── tmux capture + parse ───────────────────────────────────────────────────

function capturePaneRaw(paneIndex) {
  try {
    return execSync(
      `tmux capture-pane -t ${SESSION}:dashboard.${paneIndex} -p -S -50`,
      { encoding: 'utf-8', timeout: 3000 },
    )
  } catch { return null }
}

function parsePane(raw) {
  if (!raw) return { state: 'offline', agent: null, tool: null, context: null, session: null }

  const lines = raw.split('\n').filter(Boolean)
  const result = {
    state: 'idle',
    agent: null,
    tool: null,
    toolDetail: null,
    context: null,
    session: null,
    lastIncoming: null,
  }

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]

    // OMC status line
    const stateMatch = line.match(/\|\s*(thinking|idle|working)\s*\|/)
    if (stateMatch && result.state === 'idle') result.state = stateMatch[1]

    const ctxMatch = line.match(/ctx:(\d+)%/)
    if (ctxMatch && !result.context) result.context = parseInt(ctxMatch[1])

    const sessionMatch = line.match(/session:(\S+)/)
    if (sessionMatch && !result.session) result.session = sessionMatch[1]
  }

  // Recent actions (bottom 40 lines)
  const patterns = [
    { re: /⏺\s*Agent\(.*?subagent_type="([^"]+)"/, key: 'agent' },
    { re: /⏺\s*Bash\((.{0,60})/, key: 'tool', name: 'Bash' },
    { re: /⏺\s*Read\((.{0,60})/, key: 'tool', name: 'Read' },
    { re: /⏺\s*Edit\((.{0,60})/, key: 'tool', name: 'Edit' },
    { re: /⏺\s*Write\((.{0,60})/, key: 'tool', name: 'Write' },
    { re: /⏺\s*Grep\((.{0,60})/, key: 'tool', name: 'Grep' },
    { re: /⏺\s*Skill\((.{0,40})/, key: 'tool', name: 'Skill' },
    { re: /⏺\s*discord-bridge\s*-\s*reply/, key: 'tool', name: 'Reply' },
    { re: /← discord-bridge · (.+)/, key: 'incoming' },
    { re: /Running\.\.\./, key: 'running' },
  ]

  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 40); i--) {
    const line = lines[i]
    for (const p of patterns) {
      const m = line.match(p.re)
      if (!m) continue
      if (p.key === 'agent' && !result.agent) { result.agent = m[1]; result.state = 'working' }
      if (p.key === 'tool' && !result.tool) { result.tool = p.name; result.toolDetail = m[1]?.trim() || null; if (result.state === 'idle') result.state = 'working' }
      if (p.key === 'incoming' && !result.lastIncoming) result.lastIncoming = m[1].trim()
      if (p.key === 'running') result.state = 'working'
    }
  }

  return result
}

function pollPanes() {
  for (const ch of channels) {
    const raw = capturePaneRaw(ch.paneIndex)
    paneState.set(ch.slug, { ...parsePane(raw), name: ch.name, slug: ch.slug, updatedAt: Date.now() })
  }
}

// ─── GitHub data collection ─────────────────────────────────────────────────

function ghExec(cmd, cwd) {
  try {
    return execSync(cmd, { encoding: 'utf-8', timeout: 15000, cwd }).trim()
  } catch { return '' }
}

function pollGitHub() {
  for (const ch of channels) {
    if (!ch.repo) {
      githubState.set(ch.slug, null)
      continue
    }

    const data = {}

    // Commits today
    try {
      const today = new Date().toISOString().slice(0, 10)
      const logRaw = ghExec(`git log --oneline --since="${today}T00:00:00"`, ch.cwd)
      const commits = logRaw ? logRaw.split('\n').filter(Boolean) : []
      data.commitsToday = commits.length
      data.recentCommits = commits.slice(0, 5).map(c => {
        const spaceIdx = c.indexOf(' ')
        const msg = c.slice(spaceIdx + 1)
        // Translate prefixes for non-dev CEO
        return msg
          .replace(/^feat:\s*/i, '새 기능: ')
          .replace(/^fix:\s*/i, '버그 수정: ')
          .replace(/^refactor:\s*/i, '코드 정리: ')
          .replace(/^docs:\s*/i, '문서: ')
          .replace(/^chore:\s*/i, '관리: ')
          .replace(/^style:\s*/i, '스타일: ')
          .replace(/^test:\s*/i, '테스트: ')
      })
    } catch { data.commitsToday = 0; data.recentCommits = [] }

    // Open PRs
    try {
      const prRaw = ghExec(`gh pr list -R ${ch.repo} --json number,title,state --limit 10`, ch.cwd)
      data.openPRs = prRaw ? JSON.parse(prRaw) : []
    } catch { data.openPRs = [] }

    // Merged PRs (recent)
    try {
      const mergedRaw = ghExec(`gh pr list -R ${ch.repo} --state merged --json number,title,mergedAt --limit 5`, ch.cwd)
      data.mergedPRs = mergedRaw ? JSON.parse(mergedRaw) : []
    } catch { data.mergedPRs = [] }

    // Open issues
    try {
      const issueRaw = ghExec(`gh issue list -R ${ch.repo} --state open --json number,title,labels --limit 10`, ch.cwd)
      data.openIssues = issueRaw ? JSON.parse(issueRaw) : []
    } catch { data.openIssues = [] }

    // Git status (changed files)
    try {
      const statusRaw = ghExec('git status --porcelain', ch.cwd)
      data.changedFiles = statusRaw ? statusRaw.split('\n').filter(Boolean).length : 0
    } catch { data.changedFiles = 0 }

    // Current branch
    try {
      data.branch = ghExec('git branch --show-current', ch.cwd)
    } catch { data.branch = '' }

    data.updatedAt = Date.now()
    githubState.set(ch.slug, data)
  }
}

// ─── Polling ────────────────────────────────────────────────────────────────

setInterval(pollPanes, PANE_POLL)
setInterval(pollGitHub, GH_POLL)
pollPanes()
pollGitHub()

// ─── HTTP server ────────────────────────────────────────────────────────────

const server = createServer((req, res) => {
  if (req.url === '/api/monitor') {
    const data = {}
    for (const ch of channels) {
      data[ch.slug] = {
        ...(paneState.get(ch.slug) || {}),
        github: githubState.get(ch.slug) || null,
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
    res.end(JSON.stringify(data))
    return
  }
  res.writeHead(404)
  res.end()
})

server.listen(MONITOR_PORT, '127.0.0.1', () => {
  console.log(`[monitor] http://127.0.0.1:${MONITOR_PORT}/api/monitor`)
  console.log(`[monitor] Panes: ${PANE_POLL / 1000}s | GitHub: ${GH_POLL / 1000}s | ${channels.length} channels`)
})
