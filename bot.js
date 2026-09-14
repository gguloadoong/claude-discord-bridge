#!/usr/bin/env node
/**
 * Central Discord bot — receives messages from Discord channels
 * and routes them to the correct Claude Code instance via HTTP.
 *
 * Each channel maps to a port where a channel-server.js is listening.
 * The bot does NOT process messages itself — it only routes.
 */
import { Client, GatewayIntentBits, Events } from 'discord.js'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const __dirname = dirname(fileURLToPath(import.meta.url))
const execFileAsync = promisify(execFile)

// ─── Config ─────────────────────────────────────────────────────────────────

const CONFIG_PATH = process.env.CONFIG_PATH || join(__dirname, 'config.json')
let config
try {
  config = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'))
} catch (e) {
  console.error('[bot] config.json not found. Run: npm run setup')
  process.exit(1)
}

const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN
if (!BOT_TOKEN) {
  console.error('[bot] DISCORD_BOT_TOKEN is required.')
  console.error('  export DISCORD_BOT_TOKEN="your-token"')
  console.error('  or create a .env file with DISCORD_BOT_TOKEN=your-token')
  process.exit(1)
}

const SHARED_SECRET = process.env.BRIDGE_SECRET || ''
const DASHBOARD_PORT = parseInt(process.env.DASHBOARD_PORT || '8800')

// If a delivered message gets no reply within this window, tell the user in
// Discord instead of leaving them staring at a 👀 that never turns into an
// answer. Set REPLY_TIMEOUT_MS=0 to disable.
const REPLY_TIMEOUT_MS = parseInt(process.env.REPLY_TIMEOUT_MS ?? '120000')
const NOTICE_COOLDOWN_MS = 5 * 60_000
const MONITOR_PORT = parseInt(process.env.MONITOR_PORT || '8899')

// The bot posts its own diagnostic notices (limit hit, session down, waiting
// on a terminal prompt). Those are unprompted messages too — set
// BOT_NOTICES=0 to keep them in the log only.
const NOTICES_ENABLED = process.env.BOT_NOTICES !== '0'

// ─── Dashboard state ────────────────────────────────────────────────────────

const channelActivity = new Map()
const recentMessages = [] // rolling buffer, max 50
const MAX_RECENT = 200

function recordMessage(channelId, user, content) {
  const entry = channelActivity.get(channelId) || { messagesToday: 0, errors: 0 }
  entry.lastMessage = { user, preview: content.slice(0, 80), time: Date.now() }
  entry.messagesToday++
  channelActivity.set(channelId, entry)

  const info = channelMap.get(channelId)
  recentMessages.unshift({
    channel: info?.name || channelId,
    slug: info?.slug || 'unknown',
    user,
    preview: content.slice(0, 80),
    time: Date.now(),
  })
  if (recentMessages.length > MAX_RECENT) recentMessages.length = MAX_RECENT
}

function recordError(channelId) {
  const entry = channelActivity.get(channelId) || { messagesToday: 0, errors: 0 }
  entry.errors++
  entry.lastError = Date.now()
  channelActivity.set(channelId, entry)
}

// Build channel ID → config mapping.
// paneIndex mirrors start.sh: panes are created in config order, so index N
// is the tmux pane running channel N. Needed to restart a wedged session.
const channelMap = new Map()
let paneCounter = 0
for (const [channelId, info] of Object.entries(config.channels)) {
  channelMap.set(channelId, {
    port: info.port,
    name: info.name,
    slug: info.slug,
    cwd: info.cwd,
    paneIndex: paneCounter++,
    allowedUsers: info.allowed_users || null, // null = allow all
  })
}

// ─── HTTP helpers ───────────────────────────────────────────────────────────

async function postWithRetry(url, payload, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(SHARED_SECRET && { 'X-Bridge-Secret': SHARED_SECRET }),
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      })
      if (res.ok) return res
      console.error(`[bot] HTTP ${res.status} from ${url}`)
    } catch (e) {
      if (i === retries) throw e
      console.error(`[bot] Retry ${i + 1}/${retries}: ${e.message}`)
    }
    await new Promise((r) => setTimeout(r, 500 * (i + 1)))
  }
  throw new Error(`All ${retries + 1} attempts failed`)
}

// ─── Health check ───────────────────────────────────────────────────────────

const serverHealth = new Map()
const serverDetail = new Map()

async function checkHealth() {
  for (const [channelId, info] of channelMap) {
    try {
      const res = await fetch(`http://127.0.0.1:${info.port}/health`, {
        signal: AbortSignal.timeout(3_000),
      })
      const detail = await res.json().catch(() => null)
      serverDetail.set(channelId, detail)

      const wasDown = serverHealth.get(channelId) === false
      serverHealth.set(channelId, res.ok)
      if (res.ok && wasDown) {
        console.log(`[bot] ${info.name} (port ${info.port}) reconnected`)
      }
      // 503 = port open but the Claude session behind it is gone
      if (!res.ok && !wasDown) {
        console.warn(`[bot] ${info.name} (port ${info.port}) unhealthy: ${detail?.status || res.status}`)
      }
    } catch {
      if (serverHealth.get(channelId) !== false) {
        console.warn(`[bot] ${info.name} (port ${info.port}) is down`)
      }
      serverHealth.set(channelId, false)
      serverDetail.set(channelId, null)
    }
  }
}

// ─── Usage limit tracking ───────────────────────────────────────────────────
//
// A usage limit is account-wide, so it parks every channel session at once
// while each one still looks healthy: the process is alive, the MCP port is
// open, /health says ok. Only the terminal banner shows it — monitor.js reads
// that and we relay it to Discord, because the user is watching Discord only.

const limitState = new Map() // channelId -> { active, raw, resetsAt, autoResume }
const inputState = new Map()  // channelId -> waiting on a terminal prompt

async function channelOf(id) {
  return client.channels.cache.get(id) || (await client.channels.fetch(id).catch(() => null))
}

async function checkLimits() {
  let data
  try {
    const res = await fetch(`http://127.0.0.1:${MONITOR_PORT}/api/monitor`, {
      signal: AbortSignal.timeout(3_000),
    })
    if (!res.ok) return
    data = await res.json()
  } catch {
    return // monitor.js not running — limit reporting is best-effort
  }

  for (const [channelId, info] of channelMap) {
    const limit = data[info.slug]?.limit
    if (!limit) continue

    const was = limitState.get(channelId)?.active === true
    limitState.set(channelId, limit)

    // A pane sitting on an interactive prompt is just as silent as a dead
    // one, and the user never sees the terminal.
    const needsInput = data[info.slug]?.needsInput
    const waited = inputState.get(channelId) === true
    inputState.set(channelId, needsInput?.active === true)
    if (needsInput?.active && !waited) {
      console.warn(`[bot] #${info.name}: 터미널 입력 대기 — ${needsInput.raw}`)
      const channel = await channelOf(channelId)
      if (channel) {
        await notice(channel, `input:${channelId}`, [
          `🖐 **#${info.name}** 세션이 터미널 입력을 기다리고 있습니다.`,
          `> ${needsInput.raw}`,
          '터미널에서 직접 응답하거나 `!재시작`으로 세션을 다시 띄워주세요.',
        ].join('\n'))
      }
    }

    if (limit.active && !was) {
      console.warn(`[bot] #${info.name}: 사용 한도 초과 감지 — ${limit.raw}`)
      const channel = await channelOf(channelId)
      if (channel) await notice(channel, `limit:${channelId}`, limitMessage(info, limit))
    } else if (!limit.active && was) {
      console.log(`[bot] #${info.name}: 한도 해제됨`)
      const channel = await channelOf(channelId)
      if (channel) {
        await notice(
          channel,
          `recovered:${channelId}`,
          `✅ **#${info.name}** 사용 한도가 풀렸습니다. 다시 말 걸어주세요.`,
        )
      }
    }
  }
}

function limitMessage(info, limit) {
  return [
    `⏸ **#${info.name}** — Claude 사용 한도 초과로 세션이 멈춰 있습니다.`,
    limit.resetsAt
      ? `한도 재설정: **${limit.resetsAt}**${limit.autoResume ? ' (자동 재개)' : ''}`
      : limit.autoResume
        ? '한도가 풀리면 자동으로 재개됩니다.'
        : '한도가 풀릴 때까지 응답할 수 없습니다.',
    '한도는 계정 단위라 모든 채널이 함께 멈춥니다. 지금 보낸 메시지는 누락될 수 있으니 재개 후 다시 보내주세요.',
  ].join('\n')
}

// ─── Control commands ───────────────────────────────────────────────────────
//
// Answered by the bot itself, never by the Claude session. That is the whole
// point: when a session is wedged (parked by a usage limit, or left idle after
// its turn was cancelled) the user only sees silence, and the terminal is not
// something they watch. These commands still work in that state.

const CONTROL_RE = /^\s*[!/](ping|상태|status|재시작|restart|help|도움말)\s*$/i

const TMUX_SESSION = process.env.TMUX_SESSION || 'claude-discord-bridge'
const RUNNER = join(__dirname, 'run-channel.sh')

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`

async function restartSession(target) {
  const pane = `${TMUX_SESSION}:dashboard.${target.paneIndex}`
  const cmd = `bash ${shq(RUNNER)} ${shq(target.cwd)} ${shq(target.name)}`
  // -k kills the pane's current process; run-channel.sh then supervises the
  // fresh session exactly as start.sh does.
  await execFileAsync('tmux', ['respawn-pane', '-k', '-t', pane, cmd])
}

function healthLine(channelId, target) {
  const up = serverHealth.get(channelId)
  const detail = serverDetail.get(channelId)
  const limit = limitState.get(channelId)

  if (limit?.active) {
    return `⏸ 한도 초과${limit.resetsAt ? ` — ${limit.resetsAt} 재설정` : ''}`
  }
  if (inputState.get(channelId)) return '🖐 터미널 입력 대기 중'
  if (up === false) return `🔴 채널 서버 응답 없음 (포트 ${target.port})`
  if (detail?.mcp === 'closed') return '🔴 Claude 세션 끊김'

  const seen = detail?.lastInboundAt
  const replied = detail?.lastReplyAt
  if (seen && (!replied || replied < seen)) {
    return `🟡 메시지는 받았지만 아직 응답 없음 (수신 ${detail.inboundCount}건 / 응답 ${detail.replyCount}건)`
  }
  return `🟢 정상 (수신 ${detail?.inboundCount ?? 0}건 / 응답 ${detail?.replyCount ?? 0}건)`
}

async function handleControl(cmd, message, target, routeKey) {
  const c = cmd.toLowerCase()

  if (c === 'ping') {
    await message.reply(
      `🏓 봇 정상 (uptime ${Math.round(process.uptime() / 60)}분)\n` +
      `**#${target.name}**: ${healthLine(routeKey, target)}`,
    ).catch(() => {})
    return
  }

  if (c === 'status' || c === '상태') {
    const lines = [`**📋 브리지 상태** (uptime ${Math.round(process.uptime() / 60)}분)`, '']
    for (const [id, info] of channelMap) {
      lines.push(`${id === routeKey ? '▸' : ' '} **#${info.name}** — ${healthLine(id, info)}`)
    }
    await message.reply(lines.join('\n')).catch(() => {})
    return
  }

  if (c === 'restart' || c === '재시작') {
    await message.reply(`♻️ **#${target.name}** 세션을 재시작합니다...`).catch(() => {})
    try {
      await restartSession(target)
      clearReplyWatchdog(routeKey)
      limitState.set(routeKey, { active: false })
      await message.channel.send(
        `✅ 재시작 완료. 10초쯤 뒤에 다시 말 걸어주세요.`,
      ).catch(() => {})
      console.log(`[bot] #${target.name}: ${message.author.username} 요청으로 세션 재시작`)
    } catch (err) {
      console.error(`[bot] 재시작 실패: ${err.message}`)
      await message.channel.send(
        `❌ 재시작 실패: ${err.message}\ntmux 세션(\`${TMUX_SESSION}\`)이 실행 중인지 확인해주세요.`,
      ).catch(() => {})
    }
    return
  }

  await message.reply([
    '**사용 가능한 명령** (세션이 멈춰도 봇이 직접 답합니다)',
    '`!ping` — 봇과 이 채널 상태',
    '`!상태` — 전체 채널 상태',
    '`!재시작` — 이 채널의 Claude 세션 재시작',
  ].join('\n')).catch(() => {})
}

// ─── Discord client ─────────────────────────────────────────────────────────

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
})

client.once(Events.ClientReady, (c) => {
  console.log(`[bot] Logged in as ${c.user.tag}`)
  for (const [id, info] of channelMap) {
    console.log(`[bot] #${info.name} (${id}) -> localhost:${info.port}`)
  }
  // Health check every 30s
  checkHealth()
  setInterval(checkHealth, 30_000)
  checkLimits()
  setInterval(checkLimits, 30_000)
})

client.on(Events.Error, (err) => {
  console.error('[bot] Discord client error:', err.message)
})

// ─── Routing (channel or one of its threads) ────────────────────────────────

/**
 * Resolve a message to its channel-server. Messages posted inside a thread or
 * forum post carry the thread's id, which is not in config.json — routing them
 * to the parent channel keeps threads from silently going nowhere.
 */
function resolveRoute(message) {
  const direct = channelMap.get(message.channelId)
  if (direct) return { target: direct, routeKey: message.channelId, threadId: null }

  const parentId = message.channel?.isThread?.() ? message.channel.parentId : null
  if (parentId) {
    const parent = channelMap.get(parentId)
    if (parent) return { target: parent, routeKey: parentId, threadId: message.channelId }
  }
  return null
}

// ─── User-facing notices (deduped, so we never spam a channel) ──────────────

const lastNotice = new Map()

async function notice(channel, key, text) {
  if (!NOTICES_ENABLED) {
    console.log(`[bot] notice suppressed (BOT_NOTICES=0) [${key}]: ${text.split('\n')[0]}`)
    return
  }
  const now = Date.now()
  if (now - (lastNotice.get(key) || 0) < NOTICE_COOLDOWN_MS) return
  lastNotice.set(key, now)
  await channel.send(text).catch((err) => {
    console.error(`[bot] notice send failed (${err.message}) — 채널 쓰기 권한을 확인하세요`)
  })
}

// ─── No-reply watchdog ──────────────────────────────────────────────────────

const pendingReply = new Map() // routeKey -> timer

/**
 * Warn the user when a delivered message never gets an answer.
 *
 * A healthy session that is simply busy (a long task) must not be nagged, so
 * the first timeout re-checks the channel-server: only a dead MCP session gets
 * an immediate alert. A live-but-silent session is given a much longer grace
 * period before a softer nudge.
 */
function armReplyWatchdog(routeKey, message, target, stage = 1) {
  if (!REPLY_TIMEOUT_MS || pendingReply.has(routeKey)) return

  const wait = stage === 1 ? REPLY_TIMEOUT_MS : REPLY_TIMEOUT_MS * 3
  const timer = setTimeout(async () => {
    pendingReply.delete(routeKey)

    let alive = false
    try {
      const res = await fetch(`http://127.0.0.1:${target.port}/health`, {
        signal: AbortSignal.timeout(3_000),
      })
      alive = res.ok
    } catch {
      alive = false
    }

    // A usage limit explains the silence better than anything else — check it
    // before blaming the session.
    const limit = limitState.get(routeKey)
    if (limit?.active) {
      await notice(message.channel, `limit:${routeKey}`, limitMessage(target, limit))
      return
    }

    if (!alive) {
      recordError(routeKey)
      await notice(
        message.channel,
        `noreply:${routeKey}`,
        [
          `⏳ 메시지는 전달됐는데 **#${target.name}** 세션이 응답하지 않습니다.`,
          `Claude 세션이 종료됐거나 멈춘 것 같아요 (포트 ${target.port}).`,
          '`npm run doctor`로 진단하거나 `npm start`로 다시 띄워주세요.',
        ].join('\n'),
      )
      return
    }

    if (stage === 1) {
      // Session is alive — probably still working. Give it more time.
      console.warn(`[bot] #${target.name}: ${Math.round(wait / 1000)}초째 응답 없음 (세션은 살아있음)`)
      armReplyWatchdog(routeKey, message, target, 2)
      return
    }

    await notice(
      message.channel,
      `noreply:${routeKey}`,
      [
        `⏳ **#${target.name}** 세션은 살아있는데 아직 답이 없어요.`,
        '긴 작업 중이거나 터미널에서 입력(권한 승인 등)을 기다리는 중일 수 있습니다.',
      ].join('\n'),
    )
  }, wait)

  timer.unref?.()
  pendingReply.set(routeKey, timer)
}

function clearReplyWatchdog(routeKey) {
  const timer = pendingReply.get(routeKey)
  if (timer) {
    clearTimeout(timer)
    pendingReply.delete(routeKey)
  }
}

// ─── Message handling ───────────────────────────────────────────────────────

const loggedUnmapped = new Set()
const loggedDenied = new Set()

client.on(Events.MessageCreate, async (message) => {
  const route = resolveRoute(message)
  if (!route) {
    // Unmapped channel: log once per channel so a wrong or stale id in
    // config.json is visible instead of failing silently forever.
    if (!message.author.bot && !loggedUnmapped.has(message.channelId)) {
      loggedUnmapped.add(message.channelId)
      console.warn(
        `[bot] 매핑되지 않은 채널의 메시지 무시: #${message.channel?.name || '?'} ` +
        `(${message.channelId}) — config.json에 등록되지 않았습니다`,
      )
    }
    return
  }

  const { target, routeKey, threadId } = route

  // Track bot replies for dashboard conversation flow
  if (message.author.bot && message.author.id === client.user.id) {
    clearReplyWatchdog(routeKey)
    // A real reply proves the session is working — it is not limited.
    if (limitState.get(routeKey)?.active) limitState.set(routeKey, { active: false })
    recentMessages.unshift({
      channel: target.name,
      slug: target.slug,
      user: 'Claude',
      preview: message.content.slice(0, 120),
      time: Date.now(),
      isReply: true,
    })
    if (recentMessages.length > MAX_RECENT) recentMessages.length = MAX_RECENT
    return
  }

  if (message.author.bot) return

  // Check user allowlist (if configured)
  if (target.allowedUsers && !target.allowedUsers.includes(message.author.id)) {
    const key = `${routeKey}:${message.author.id}`
    if (!loggedDenied.has(key)) {
      loggedDenied.add(key)
      console.warn(
        `[bot] #${target.name}: ${message.author.username}(${message.author.id})는 ` +
        `allowed_users에 없어 무시됨`,
      )
    }
    return // silently ignore unauthorized users
  }

  // Control commands are handled here, by the bot — they must keep working
  // when the session behind the channel cannot answer.
  const cmd = message.content.match(CONTROL_RE)?.[1]
  if (cmd) {
    await handleControl(cmd, message, target, routeKey)
    return
  }

  // Empty body: either a sticker/embed-only message, or the MESSAGE CONTENT
  // intent is off — in which case every message arrives blank and the channel
  // looks mute.
  if (!message.content && message.attachments.size === 0) {
    console.warn(
      `[bot] #${target.name}: 본문이 빈 메시지 — MESSAGE CONTENT INTENT가 꺼져 있을 수 있습니다 (npm run doctor)`,
    )
    await notice(
      message.channel,
      `empty:${routeKey}`,
      '⚠️ 메시지 본문을 읽지 못했어요. 스티커 전용 메시지이거나, 봇의 **MESSAGE CONTENT INTENT**가 꺼져 있을 수 있습니다. (`npm run doctor`)',
    )
    return
  }

  // Usage limit — tell the user up front rather than after a silent timeout
  const limit = limitState.get(routeKey)
  if (limit?.active) {
    await notice(message.channel, `limit:${routeKey}`, limitMessage(target, limit))
  }

  // Server known to be down — say so instead of leaving the user hanging
  if (serverHealth.get(routeKey) === false) {
    const detail = serverDetail.get(routeKey)
    console.warn(`[bot] ${target.name} server is down, attempting delivery anyway...`)
    await notice(
      message.channel,
      `down:${routeKey}`,
      [
        `🔴 **#${target.name}** 채널 세션이 응답하지 않습니다${detail?.status ? ` (${detail.status})` : ''}.`,
        '터미널에서 세션이 살아있는지 확인하거나 `npm start`로 다시 실행해 주세요.',
      ].join('\n'),
    )
  }

  const payload = {
    content: message.content,
    channel_id: routeKey,
    message_id: message.id,
    user: message.author.displayName || message.author.username,
    user_id: message.author.id,
  }

  if (threadId) payload.thread_id = threadId

  if (message.attachments.size > 0) {
    payload.attachments = message.attachments.map((a) => ({
      name: a.name,
      url: a.url,
      type: a.contentType,
      size: a.size,
    }))
  }

  try {
    recordMessage(routeKey, payload.user, payload.content)
    await postWithRetry(`http://127.0.0.1:${target.port}`, payload)
    await message.react('\u{1F440}') // 👀
    armReplyWatchdog(routeKey, message, target)
  } catch (err) {
    recordError(routeKey)
    console.error(`[bot] ${target.name} delivery failed:`, err.message)
    await message.react('\u274C').catch(() => {}) // ❌
    await notice(
      message.channel,
      `fail:${routeKey}`,
      [
        `**#${target.name}** 세션에 메시지를 전달하지 못했습니다 (포트 ${target.port}).`,
        '`npm run doctor`로 원인을 확인해 주세요.',
      ].join('\n'),
    )
  }
})

// ─── Button interactions (permission approve/deny) ──────────────────────────

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isButton()) return

  const customId = interaction.customId
  // Format: perm_yes_<requestId>_<port> or perm_no_<requestId>_<port>
  const match = customId.match(/^perm_(yes|no)_([a-km-z]{5})_(\d+)$/)
  if (!match) return

  const [, verdict, requestId, port] = match
  const behavior = verdict === 'yes' ? 'allow' : 'deny'

  try {
    await fetch(`http://127.0.0.1:${port}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(SHARED_SECRET && { 'X-Bridge-Secret': SHARED_SECRET }),
      },
      body: JSON.stringify({
        content: `${verdict} ${requestId}`,
        channel_id: interaction.channelId,
        message_id: interaction.message.id,
        user: interaction.user.displayName || interaction.user.username,
        user_id: interaction.user.id,
      }),
      signal: AbortSignal.timeout(5_000),
    })

    const label = behavior === 'allow' ? 'Approved' : 'Denied'
    const emoji = behavior === 'allow' ? '\u2705' : '\u274C'
    await interaction.update({
      content: `${interaction.message.content}\n\n${emoji} **${label}** by ${interaction.user.displayName || interaction.user.username}`,
      components: [], // Remove buttons after click
    })
  } catch (err) {
    console.error(`[bot] Permission button error:`, err.message)
    await interaction.reply({ content: 'Failed to process. Try typing the command manually.', ephemeral: true }).catch(() => {})
  }
})

// ─── Graceful shutdown ──────────────────────────────────────────────────────

function shutdown() {
  console.log('\n[bot] Shutting down...')
  client.destroy()
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

// ─── Dashboard HTTP server ──────────────────────────────────────────────────

import { createServer } from 'node:http'

const dashboardServer = createServer(async (req, res) => {
  if (req.url === '/api/status') {
    const channels = []
    for (const [id, info] of channelMap) {
      const activity = channelActivity.get(id) || {}
      channels.push({
        id,
        name: info.name,
        slug: info.slug,
        port: info.port,
        online: serverHealth.get(id) !== false,
        lastMessage: activity.lastMessage || null,
        messagesToday: activity.messagesToday || 0,
        errors: activity.errors || 0,
        lastError: activity.lastError || null,
        health: serverDetail.get(id) || null,
      })
    }
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    })
    res.end(JSON.stringify({
      channels,
      recentMessages: recentMessages.slice(0, 100),
      uptime: process.uptime(),
      timestamp: Date.now(),
      guildId: config.guild_id || '',
    }))
    return
  }

  // Summary API — generates text summary for Discord
  if (req.url === '/api/summary') {
    const lines = ['**📋 상황 보고**', '']
    const icons = { market: '📊', shorts: '🎬', general: '🏠' }
    for (const [id, info] of channelMap) {
      const act = channelActivity.get(id) || {}
      const online = serverHealth.get(id) !== false
      const icon = icons[info.slug] || '📂'
      const status = online ? '🟢' : '🔴'
      let line = `${status} **${icon} ${info.name}**`
      if (act.messagesToday > 0) line += ` — 메시지 ${act.messagesToday}건`
      if (act.lastMessage) line += `, 마지막: "${act.lastMessage.preview.slice(0, 50)}"`
      lines.push(line)
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ text: lines.join('\n') }))
    return
  }

  // Trigger summary send to general channel
  if (req.url === '/api/send-summary' && req.method === 'POST') {
    const generalId = Object.entries(config.channels).find(([, v]) => v.slug === 'general')?.[0]
    if (generalId) {
      const summaryRes = await fetch(`http://127.0.0.1:${DASHBOARD_PORT}/api/summary`)
      const { text } = await summaryRes.json()
      await fetch(`https://discord.com/api/v10/channels/${generalId}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bot ${BOT_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: text }),
      })
      res.writeHead(200)
      res.end('sent')
    } else {
      res.writeHead(404)
      res.end('no general channel')
    }
    return
  }

  if (req.url === '/' || req.url === '/dashboard') {
    try {
      const html = readFileSync(join(__dirname, 'dashboard.html'), 'utf-8')
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(html)
    } catch {
      res.writeHead(500)
      res.end('dashboard.html not found')
    }
    return
  }

  res.writeHead(404)
  res.end()
})

dashboardServer.listen(DASHBOARD_PORT, '127.0.0.1', () => {
  console.log(`[bot] Dashboard: http://127.0.0.1:${DASHBOARD_PORT}`)
})

client.login(BOT_TOKEN)
