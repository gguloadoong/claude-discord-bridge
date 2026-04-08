#!/usr/bin/env node
/**
 * TUI Dashboard — terminal-based status board.
 * Pulls from monitor API + bot status API and renders a clean view.
 */

const MONITOR = 'http://127.0.0.1:8899/api/monitor'
const STATUS = 'http://127.0.0.1:8800/api/status'
const REFRESH = 3_000

// ─── ANSI helpers ───────────────────────────────────────────────────────────

const ESC = '\x1b['
const c = {
  reset: ESC + '0m',
  bold: ESC + '1m',
  dim: ESC + '2m',
  blue: ESC + '38;5;75m',
  green: ESC + '38;5;78m',
  yellow: ESC + '38;5;220m',
  red: ESC + '38;5;203m',
  grey: ESC + '38;5;245m',
  darkGrey: ESC + '38;5;238m',
  white: ESC + '38;5;255m',
  cyan: ESC + '38;5;117m',
  purple: ESC + '38;5;141m',
  bgDark: ESC + '48;5;234m',
  bgHeader: ESC + '48;5;25m',
  clear: ESC + '2J' + ESC + 'H',
  hideCursor: ESC + '?25l',
  showCursor: ESC + '?25h',
}

const ICONS = { market: '📊', shorts: '🎬', general: '🏠' }
const STATE_STYLE = {
  working: { label: '작업중', dot: c.blue + '●', color: c.blue },
  thinking: { label: '생각중', dot: c.yellow + '●', color: c.yellow },
  idle: { label: '대기', dot: c.grey + '○', color: c.grey },
  offline: { label: '오프라인', dot: c.red + '●', color: c.red },
}

function timeAgo(ts) {
  if (!ts) return ''
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 10) return '방금'
  if (s < 60) return s + '초 전'
  const m = Math.floor(s / 60)
  if (m < 60) return m + '분 전'
  return Math.floor(m / 60) + '시간 전'
}

function ctxBar(pct, width = 20) {
  if (pct == null) return c.darkGrey + '─'.repeat(width) + c.reset
  const filled = Math.round(pct / 100 * width)
  const clr = pct < 50 ? c.green : pct < 80 ? c.yellow : c.red
  return clr + '█'.repeat(filled) + c.darkGrey + '░'.repeat(width - filled) + c.reset
}

function pad(str, len) {
  // Account for ANSI escape codes in length
  const visible = str.replace(/\x1b\[[0-9;]*m/g, '')
  const diff = len - visible.length
  return diff > 0 ? str + ' '.repeat(diff) : str
}

function truncate(str, len) {
  if (!str) return ''
  return str.length > len ? str.slice(0, len - 1) + '…' : str
}

// ─── Render ─────────────────────────────────────────────────────────────────

function render(statusData, monitorData) {
  const cols = process.stdout.columns || 80
  const now = new Date()
  const time = now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0')

  const channels = statusData.channels || []
  const onlineCount = channels.filter(ch => ch.online).length
  const workingCount = Object.values(monitorData).filter(m => m.state === 'working' || m.state === 'thinking').length

  let out = ''
  out += c.clear
  out += c.hideCursor

  // ─── Header ─────────────────────────────────────────────
  const headerStatus = workingCount > 0
    ? c.blue + c.bold + workingCount + ' working' + c.reset
    : c.green + onlineCount + '/' + channels.length + ' online' + c.reset

  out += c.bgHeader + c.white + c.bold
  out += '  CLAUDE BRIDGE' + c.reset + c.bgHeader + c.white
  out += ' '.repeat(Math.max(0, cols - 35 - time.length))
  out += headerStatus + c.bgHeader + '  ' + c.grey + time + '  '
  out += c.reset + '\n'

  // ─── Alerts ─────────────────────────────────────────────
  let hasAlert = false
  channels.forEach(ch => {
    const m = monitorData[ch.slug] || {}
    if (!ch.online) {
      out += c.red + c.bold + '  ⚠ ' + ch.name + ' 오프라인' + c.reset + '\n'
      hasAlert = true
    }
    if (m.context > 80) {
      out += c.yellow + '  ⚠ ' + ch.name + ' 컨텍스트 ' + m.context + '% — 세션 재시작 필요' + c.reset + '\n'
      hasAlert = true
    }
  })
  if (hasAlert) out += '\n'

  // ─── Project cards ──────────────────────────────────────
  out += c.darkGrey + '  ' + '─'.repeat(cols - 4) + c.reset + '\n'

  channels.forEach(ch => {
    const m = monitorData[ch.slug] || {}
    const gh = m.github || null
    const icon = ICONS[ch.slug] || '📂'
    const st = !ch.online ? 'offline' : (m.state || 'idle')
    const style = STATE_STYLE[st] || STATE_STYLE.idle

    // Line 1: Project name + status
    out += '\n'
    out += '  ' + icon + ' ' + c.bold + c.white + ch.name + c.reset
    out += '  ' + style.dot + ' ' + style.color + style.label + c.reset
    if (m.session) out += c.darkGrey + '  세션 ' + m.session + c.reset
    out += '\n'

    // Line 2: Current task
    if (ch.lastMessage && (st === 'working' || st === 'thinking')) {
      out += '     ' + c.cyan + '"' + truncate(ch.lastMessage.preview, cols - 25) + '"' + c.reset
      out += c.darkGrey + '  (' + timeAgo(ch.lastMessage.time) + ' 시작)' + c.reset + '\n'
    } else if (ch.lastMessage) {
      out += '     ' + c.grey + '마지막: "' + truncate(ch.lastMessage.preview, cols - 30) + '"' + c.reset
      out += c.darkGrey + '  (' + timeAgo(ch.lastMessage.time) + ')' + c.reset + '\n'
    }

    // Line 3: Agent/Tool
    if (m.agent || m.tool) {
      out += '     '
      if (m.agent) out += c.blue + '⚙ ' + m.agent + c.reset + '  '
      if (m.tool) out += c.grey + '🔧 ' + m.tool + (m.toolDetail ? ': ' + truncate(m.toolDetail, 30) : '') + c.reset
      out += '\n'
    }

    // Line 4: Stats bar
    const ctxPct = m.context != null ? m.context + '%' : '--'
    let statsLine = '     ' + c.darkGrey + 'CTX ' + c.reset + ctxBar(m.context, 12) + ' ' + c.grey + ctxPct + c.reset

    if (gh) {
      statsLine += c.darkGrey + '  │  ' + c.reset
      statsLine += c.white + gh.commitsToday + c.grey + ' 커밋  '
      statsLine += c.white + gh.openPRs.length + c.grey + ' PR  '
      statsLine += c.white + gh.openIssues.length + c.grey + ' 이슈'
      if (gh.changedFiles > 0) statsLine += '  ' + c.yellow + gh.changedFiles + ' 변경' + c.reset
    }
    statsLine += c.reset
    out += statsLine + '\n'

    // Line 5: Recent commits (if working or has commits today)
    if (gh && gh.recentCommits && gh.recentCommits.length > 0) {
      const showCount = st === 'working' ? 2 : 1
      gh.recentCommits.slice(0, showCount).forEach(commit => {
        out += '     ' + c.darkGrey + '└ ' + c.grey + truncate(commit, cols - 10) + c.reset + '\n'
      })
    }

    out += c.darkGrey + '  ' + '─'.repeat(cols - 4) + c.reset + '\n'
  })

  // ─── Recent messages ────────────────────────────────────
  const recent = (statusData.recentMessages || []).slice(0, 5)
  if (recent.length > 0) {
    out += '\n  ' + c.grey + c.bold + 'RECENT' + c.reset + '\n'
    recent.forEach(m => {
      const icon = ICONS[m.slug] || '📂'
      const t = new Date(m.time)
      const ts = t.getHours().toString().padStart(2, '0') + ':' + t.getMinutes().toString().padStart(2, '0')
      out += '  ' + c.darkGrey + ts + c.reset + '  ' + icon + ' ' + c.blue + m.user + c.reset + '  ' + c.grey + truncate(m.preview, cols - 25) + c.reset + '\n'
    })
  }

  // ─── Footer ─────────────────────────────────────────────
  out += '\n' + c.darkGrey
  out += '  Ctrl+B 1=마켓  2=쇼츠  3=제너럴  4=봇'
  out += '  │  z=풀스크린  d=나가기'
  out += '  │  localhost:8800=웹' + c.reset + '\n'

  process.stdout.write(out)
}

// ─── Main loop ──────────────────────────────────────────────────────────────

async function tick() {
  let statusData = { channels: [], recentMessages: [] }
  let monitorData = {}

  try {
    const [s, m] = await Promise.all([
      fetch(STATUS).then(r => r.json()).catch(() => null),
      fetch(MONITOR).then(r => r.json()).catch(() => ({})),
    ])
    if (s) statusData = s
    monitorData = m || {}
  } catch {}

  render(statusData, monitorData)
}

// Clean exit
process.on('SIGINT', () => {
  process.stdout.write(c.showCursor + c.clear)
  process.exit(0)
})
process.on('SIGTERM', () => {
  process.stdout.write(c.showCursor + c.clear)
  process.exit(0)
})

setInterval(tick, REFRESH)
tick()
