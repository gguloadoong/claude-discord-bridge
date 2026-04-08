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
    await postWithRetry(`http://127.0.0.1:${target.port}`, payload)
    await message.react('\u{1F440}') // 👀
  } catch (err) {
    console.error(`[bot] ${target.name} delivery failed:`, err.message)
    await message.react('\u274C').catch(() => {}) // ❌
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

client.login(BOT_TOKEN)
