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

const __dirname = dirname(fileURLToPath(import.meta.url))

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

// ─── Dashboard state ────────────────────────────────────────────────────────

const channelActivity = new Map()
const recentMessages = [] // rolling buffer, max 50
const MAX_RECENT = 50

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

// Build channel ID → config mapping
const channelMap = new Map()
for (const [channelId, info] of Object.entries(config.channels)) {
  channelMap.set(channelId, {
    port: info.port,
    name: info.name,
    slug: info.slug,
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

async function checkHealth() {
  for (const [channelId, info] of channelMap) {
    try {
      const res = await fetch(`http://127.0.0.1:${info.port}/health`, {
        signal: AbortSignal.timeout(3_000),
      })
      const wasDown = serverHealth.get(channelId) === false
      serverHealth.set(channelId, res.ok)
      if (res.ok && wasDown) {
        console.log(`[bot] ${info.name} (port ${info.port}) reconnected`)
      }
    } catch {
      if (serverHealth.get(channelId) !== false) {
        console.warn(`[bot] ${info.name} (port ${info.port}) is down`)
      }
      serverHealth.set(channelId, false)
    }
  }
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
})

client.on(Events.Error, (err) => {
  console.error('[bot] Discord client error:', err.message)
})

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return

  const target = channelMap.get(message.channelId)
  if (!target) return

  // Check user allowlist (if configured)
  if (target.allowedUsers && !target.allowedUsers.includes(message.author.id)) {
    return // silently ignore unauthorized users
  }

  // Warn if server is known to be down
  if (serverHealth.get(message.channelId) === false) {
    console.warn(`[bot] ${target.name} server is down, attempting delivery anyway...`)
  }

  const payload = {
    content: message.content,
    channel_id: message.channelId,
    message_id: message.id,
    user: message.author.displayName || message.author.username,
    user_id: message.author.id,
  }

  if (message.attachments.size > 0) {
    payload.attachments = message.attachments.map((a) => ({
      name: a.name,
      url: a.url,
      type: a.contentType,
      size: a.size,
    }))
  }

  try {
    recordMessage(message.channelId, payload.user, payload.content)
    await postWithRetry(`http://127.0.0.1:${target.port}`, payload)
    await message.react('\u{1F440}') // 👀
  } catch (err) {
    recordError(message.channelId)
    console.error(`[bot] ${target.name} delivery failed:`, err.message)
    await message.react('\u274C').catch(() => {}) // ❌
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
      })
    }
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    })
    res.end(JSON.stringify({
      channels,
      recentMessages: recentMessages.slice(0, 30),
      uptime: process.uptime(),
      timestamp: Date.now(),
    }))
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
