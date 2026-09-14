#!/usr/bin/env node
/**
 * MCP Channel Server — one instance per project.
 *
 * Receives messages from bot.js via HTTP, forwards to Claude Code via MCP stdio.
 * Replies go back to Discord via REST API.
 *
 * Usage: node channel-server.js <port> <channel-id> <channel-name>
 * Env:   DISCORD_BOT_TOKEN, BRIDGE_SECRET (optional)
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'

const PORT = parseInt(process.argv[2] || '8801')
const CHANNEL_ID = process.argv[3] || ''
const CHANNEL_NAME = process.argv[4] || 'discord'
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || ''
const SHARED_SECRET = process.env.BRIDGE_SECRET || ''

// Per-channel permission to speak first. Default off: a channel answers, it
// does not announce. Only a channel with "allow_proactive": true in
// config.json may push alerts on its own.
let ALLOW_PROACTIVE = false
try {
  const cfgPath = process.env.CONFIG_PATH ||
    join(dirname(fileURLToPath(import.meta.url)), 'config.json')
  ALLOW_PROACTIVE =
    JSON.parse(readFileSync(cfgPath, 'utf-8')).channels?.[CHANNEL_ID]?.allow_proactive === true
} catch {}

const MAX_BODY_SIZE = 64 * 1024 // 64KB
const DISCORD_TIMEOUT = 10_000 // 10s

// stderr only — stdout is MCP stdio transport
const log = (...args) => process.stderr.write(`[${CHANNEL_NAME}] ${args.join(' ')}\n`)

// ─── Liveness state (exposed on /health so the bot & doctor can see it) ─────

let mcpAlive = false          // is the Claude Code session still on the other end?
let lastInboundAt = null      // last user message forwarded into the session
let lastReplyAt = null        // last reply that actually landed in Discord
let lastSendError = null      // last Discord API failure, if any
let inboundCount = 0
let replyCount = 0

// Threads/forum posts under this channel. Messages there are routed here by
// bot.js, so replies addressed to a known thread id must be allowed through.
const knownThreads = new Set()

// ─── Discord REST helpers ───────────────────────────────────────────────────

const DISCORD_API = 'https://discord.com/api/v10'

// Human-readable cause for the failures that actually make a channel go silent.
function explainDiscordError(status) {
  switch (status) {
    case 401: return '봇 토큰이 유효하지 않습니다 (DISCORD_BOT_TOKEN 확인)'
    case 403: return '봇에게 이 채널의 메시지 보내기/보기 권한이 없습니다'
    case 404: return '채널을 찾을 수 없습니다 (config.json의 channel id 확인)'
    case 429: return 'Discord rate limit — 잠시 후 재시도하세요'
    default: return `Discord API ${status}`
  }
}

async function discordFetch(path, options = {}) {
  const res = await fetch(`${DISCORD_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bot ${BOT_TOKEN}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
    signal: AbortSignal.timeout(DISCORD_TIMEOUT),
  })
  if (!res.ok) {
    const err = await res.text().catch(() => 'unknown')
    res.errorText = err
    lastSendError = { status: res.status, reason: explainDiscordError(res.status), at: Date.now() }
    log(`Discord API error: ${res.status} ${err}`)
    log(`  -> ${lastSendError.reason}`)
  }
  return res
}

// Returns { ok, ids, status, reason } — callers MUST surface failures to the
// model. Silently swallowing a 403 here is what makes the channel look dead:
// Claude believes it answered while nothing ever reached Discord.
async function discordSend(channelId, text, replyTo) {
  const chunks = splitMessage(text, 1950)
  const ids = []

  for (let i = 0; i < chunks.length; i++) {
    const body = { content: chunks[i] }
    if (i === 0 && replyTo) {
      body.message_reference = { message_id: replyTo }
    }
    const res = await discordFetch(`/channels/${channelId}/messages`, {
      method: 'POST',
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      return { ok: false, ids, status: res.status, reason: explainDiscordError(res.status) }
    }
    ids.push((await res.json()).id)
  }

  return { ok: true, ids }
}

function splitMessage(text, maxLen) {
  if (text.length <= maxLen) return [text]

  const chunks = []
  let remaining = text

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining)
      break
    }
    // Prefer splitting at newline, then space, then hard cut
    let splitAt = remaining.lastIndexOf('\n', maxLen)
    if (splitAt < maxLen * 0.3) splitAt = remaining.lastIndexOf(' ', maxLen)
    if (splitAt < maxLen * 0.3) splitAt = maxLen

    chunks.push(remaining.slice(0, splitAt))
    remaining = remaining.slice(splitAt).trimStart()
  }
  return chunks
}

// ─── MCP Server ─────────────────────────────────────────────────────────────

const mcp = new Server(
  { name: `discord-${CHANNEL_NAME}`, version: '1.0.0' },
  {
    capabilities: {
      experimental: {
        'claude/channel': {},
        'claude/channel/permission': {},
      },
      tools: {},
    },
    instructions: [
      `Messages from Discord #${CHANNEL_NAME} arrive as <channel source="discord-${CHANNEL_NAME}" chat_id="..." user="..." message_id="...">`,
      `Use the reply tool to respond. Pass chat_id and optionally reply_to (message_id) from the tag.`,
      `Use edit_message to update a previous reply. Use react to add emoji reactions.`,
      `Use fetch_messages to read recent channel history.`,
      `Long messages are automatically split across multiple Discord messages.`,
      ``,
      `CRITICAL: The user is ONLY watching Discord, NOT the terminal.`,
      `- NEVER ask questions or present choices in the terminal. ALWAYS use the reply tool to ask questions in Discord.`,
      `- If you need the user to choose between options, send the options via reply tool and wait for their Discord response.`,
      `- If you need clarification, ask via reply tool. Do NOT use interactive terminal prompts.`,
      `- The user cannot see terminal output. Everything must go through Discord.`,
      ``,
      // 자동 발송 비활성화 (대화 릴레이는 유지).
      // 기본값은 "말 걸 때만 말한다". 알림을 먼저 보내야 하는 채널만
      // config.json에 allow_proactive: true 를 넣어 예외로 허용한다.
      ...(ALLOW_PROACTIVE
        ? [
            `- Do NOT send a "ready"/"online"/startup greeting (e.g. "봇이 준비되었습니다") when this session starts or reconnects.`,
            `- This channel is opted in to alert pushes (allow_proactive), so scheduled alerts the user explicitly asked for are allowed. Nothing else: no status updates, no handover or session-summary notices.`,
          ]
        : [
            `- NEVER send an unprompted message to this channel, for any reason.`,
            `- Only use reply/reply_embed/react in DIRECT RESPONSE to an actual <channel> notification triggered by a user's Discord message. If no user message triggered you, send nothing.`,
            `- This ban explicitly covers: startup/reconnect greetings ("봇이 준비되었습니다", "이제 말 걸어도 됩니다"), status or progress updates, and handover / session-takeover / context-summary notices ("인수인계", "세션을 이어받았습니다", "이전 대화를 요약하면"). Starting or resuming a session is NOT a reason to post.`,
          ]),
      `- Answering is still mandatory: every <channel> notification from a user gets a reply via the reply/reply_embed tool.`,
      `- If a reply tool returns an error, the message never reached Discord. Do not assume it was delivered — report the failure and retry.`,
    ].join('\n'),
  },
)

// ─── MCP Tools ──────────────────────────────────────────────────────────────

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'reply',
      description: 'Send a message to the Discord channel',
      inputSchema: {
        type: 'object',
        properties: {
          chat_id: { type: 'string', description: 'Discord channel ID (from chat_id attribute)' },
          text: { type: 'string', description: 'Message content' },
          reply_to: { type: 'string', description: 'Message ID to reply to (optional, from message_id attribute)' },
        },
        required: ['chat_id', 'text'],
      },
    },
    {
      name: 'edit_message',
      description: 'Edit a previously sent message',
      inputSchema: {
        type: 'object',
        properties: {
          chat_id: { type: 'string', description: 'Discord channel ID' },
          message_id: { type: 'string', description: 'Message ID to edit' },
          text: { type: 'string', description: 'New message content' },
        },
        required: ['chat_id', 'message_id', 'text'],
      },
    },
    {
      name: 'react',
      description: 'Add an emoji reaction to a message',
      inputSchema: {
        type: 'object',
        properties: {
          chat_id: { type: 'string', description: 'Discord channel ID' },
          message_id: { type: 'string', description: 'Message ID to react to' },
          emoji: { type: 'string', description: 'Emoji to react with (e.g. "👍", "✅")' },
        },
        required: ['chat_id', 'message_id', 'emoji'],
      },
    },
    {
      name: 'reply_embed',
      description: 'Send a rich embed message to the Discord channel (colored sidebar, title, fields, footer)',
      inputSchema: {
        type: 'object',
        properties: {
          chat_id: { type: 'string', description: 'Discord channel ID (from chat_id attribute)' },
          reply_to: { type: 'string', description: 'Message ID to reply to (optional)' },
          text: { type: 'string', description: 'Plain text content above the embed (optional)' },
          title: { type: 'string', description: 'Embed title' },
          description: { type: 'string', description: 'Embed description (supports markdown)' },
          color: { type: 'number', description: 'Embed sidebar color as decimal (e.g. 3447003 for blue, 15158332 for red, 3066993 for green, 16776960 for yellow). Default: 3447003' },
          fields: {
            type: 'array',
            description: 'Embed fields',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', description: 'Field name (bold header)' },
                value: { type: 'string', description: 'Field value (supports markdown)' },
                inline: { type: 'boolean', description: 'Show side-by-side (default false)' },
              },
              required: ['name', 'value'],
            },
          },
          footer: { type: 'string', description: 'Footer text (optional)' },
          thumbnail: { type: 'string', description: 'Thumbnail URL (optional, small image top-right)' },
          image: { type: 'string', description: 'Large image URL (optional, bottom of embed)' },
        },
        required: ['chat_id'],
      },
    },
    {
      name: 'fetch_messages',
      description: 'Fetch recent messages from the Discord channel',
      inputSchema: {
        type: 'object',
        properties: {
          chat_id: { type: 'string', description: 'Discord channel ID' },
          limit: { type: 'number', description: 'Number of messages to fetch (max 50, default 10)' },
        },
        required: ['chat_id'],
      },
    },
  ],
}))

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params

  // Validate chat_id matches this channel or one of its threads
  // (prevent cross-channel access)
  if (args.chat_id && args.chat_id !== CHANNEL_ID && !knownThreads.has(args.chat_id)) {
    return { content: [{ type: 'text', text: `error: chat_id must be ${CHANNEL_ID}` }], isError: true }
  }

  // Validate required text field
  if ((name === 'reply' || name === 'edit_message') && !args.text) {
    return { content: [{ type: 'text', text: 'error: text is required' }], isError: true }
  }

  switch (name) {
    case 'reply': {
      const sent = await discordSend(args.chat_id, args.text, args.reply_to)
      if (!sent.ok) {
        return {
          content: [{ type: 'text', text: `error: Discord 전송 실패 (${sent.status}) — ${sent.reason}` }],
          isError: true,
        }
      }
      lastReplyAt = Date.now()
      replyCount++
      return { content: [{ type: 'text', text: `sent (message_ids: ${sent.ids.join(', ')})` }] }
    }

    case 'edit_message': {
      const chunks = splitMessage(args.text, 1950)
      const res = await discordFetch(`/channels/${args.chat_id}/messages/${args.message_id}`, {
        method: 'PATCH',
        body: JSON.stringify({ content: chunks[0] }),
      })
      if (!res.ok) {
        return {
          content: [{ type: 'text', text: `error: 수정 실패 (${res.status}) — ${explainDiscordError(res.status)}` }],
          isError: true,
        }
      }
      lastReplyAt = Date.now()
      return { content: [{ type: 'text', text: 'edited' }] }
    }

    case 'reply_embed': {
      const embed = {}
      if (args.title) embed.title = args.title
      if (args.description) embed.description = args.description
      embed.color = args.color || 3447003
      if (args.fields) embed.fields = args.fields.map((f) => ({ name: f.name, value: f.value, inline: f.inline || false }))
      if (args.footer) embed.footer = { text: args.footer }
      if (args.thumbnail) embed.thumbnail = { url: args.thumbnail }
      if (args.image) embed.image = { url: args.image }

      const body = { embeds: [embed] }
      if (args.text) body.content = args.text
      if (args.reply_to) body.message_reference = { message_id: args.reply_to }

      const res = await discordFetch(`/channels/${args.chat_id}/messages`, {
        method: 'POST',
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        return {
          content: [{ type: 'text', text: `error: embed 전송 실패 (${res.status}) — ${explainDiscordError(res.status)}` }],
          isError: true,
        }
      }
      const msg = await res.json()
      lastReplyAt = Date.now()
      replyCount++
      return { content: [{ type: 'text', text: `sent embed (message_id: ${msg.id})` }] }
    }

    case 'react': {
      const emoji = encodeURIComponent(args.emoji)
      const res = await discordFetch(
        `/channels/${args.chat_id}/messages/${args.message_id}/reactions/${emoji}/@me`,
        { method: 'PUT' },
      )
      if (!res.ok) {
        return {
          content: [{ type: 'text', text: `error: 리액션 실패 (${res.status}) — ${explainDiscordError(res.status)}` }],
          isError: true,
        }
      }
      return { content: [{ type: 'text', text: 'reacted' }] }
    }

    case 'fetch_messages': {
      const limit = Math.min(args.limit || 10, 50)
      const res = await discordFetch(`/channels/${args.chat_id}/messages?limit=${limit}`)
      if (!res.ok) return { content: [{ type: 'text', text: 'fetch failed' }] }

      const messages = await res.json()
      const formatted = messages
        .reverse()
        .map((m) => `[${m.author.username}] ${m.content}`)
        .join('\n')
      return { content: [{ type: 'text', text: formatted || '(no messages)' }] }
    }

    default:
      throw new Error(`unknown tool: ${name}`)
  }
})

// ─── Permission relay ───────────────────────────────────────────────────────

const PermissionRequestSchema = z.object({
  method: z.literal('notifications/claude/channel/permission_request'),
  params: z.object({
    request_id: z.string(),
    tool_name: z.string(),
    description: z.string(),
    input_preview: z.string(),
  }),
})

mcp.setNotificationHandler(PermissionRequestSchema, async ({ params }) => {
  const text = [
    `**[Permission Request]**`,
    `Tool: \`${params.tool_name}\``,
    `${params.description}`,
  ].join('\n')

  // Send with Yes/No buttons
  await discordFetch(`/channels/${CHANNEL_ID}/messages`, {
    method: 'POST',
    body: JSON.stringify({
      content: text,
      components: [{
        type: 1, // ActionRow
        components: [
          {
            type: 2, // Button
            style: 3, // Success (green)
            label: 'Approve',
            custom_id: `perm_yes_${params.request_id}_${PORT}`,
            emoji: { name: '\u2705' },
          },
          {
            type: 2,
            style: 4, // Danger (red)
            label: 'Deny',
            custom_id: `perm_no_${params.request_id}_${PORT}`,
            emoji: { name: '\u274C' },
          },
        ],
      }],
    }),
  })
})

// ─── Connect MCP ────────────────────────────────────────────────────────────

mcp.onerror = (err) => log(`MCP error: ${err?.message || err}`)

// When the Claude Code session exits, the stdio pipe closes. Without this the
// process keeps its HTTP port open, keeps answering /health with "ok", and
// every forwarded message vanishes into a dead transport — the channel looks
// alive from Discord but never answers. Die instead, so bot.js sees it as down.
function mcpGone(why) {
  if (!mcpAlive) return
  mcpAlive = false
  log(`MCP transport closed (${why}) — Claude 세션이 종료된 것 같습니다. 서버를 내립니다.`)
  setTimeout(() => process.exit(0), 500).unref?.()
}

mcp.onclose = () => mcpGone('transport closed')
process.stdin.on('end', () => mcpGone('stdin EOF'))
process.stdin.on('close', () => mcpGone('stdin closed'))

await mcp.connect(new StdioServerTransport())
mcpAlive = true
log(`MCP connected (port: ${PORT}, channel: ${CHANNEL_ID})`)

// ─── HTTP server ────────────────────────────────────────────────────────────

const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i

const httpServer = createServer(async (req, res) => {
  // Health check — reports the MCP session state, not just "the port is open"
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(mcpAlive ? 200 : 503, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      status: mcpAlive ? 'ok' : 'mcp-disconnected',
      channel: CHANNEL_NAME,
      channel_id: CHANNEL_ID,
      port: PORT,
      mcp: mcpAlive ? 'connected' : 'closed',
      lastInboundAt,
      lastReplyAt,
      inboundCount,
      replyCount,
      lastSendError,
      uptime: Math.round(process.uptime()),
    }))
    return
  }

  if (req.method !== 'POST') {
    res.writeHead(404)
    res.end()
    return
  }

  // Validate shared secret if configured
  if (SHARED_SECRET && req.headers['x-bridge-secret'] !== SHARED_SECRET) {
    res.writeHead(403)
    res.end('forbidden')
    return
  }

  // Read body with size limit (Buffer-safe for multi-byte UTF-8)
  const chunks = []
  let size = 0
  try {
    for await (const chunk of req) {
      size += chunk.length
      if (size > MAX_BODY_SIZE) {
        res.writeHead(413)
        res.end('payload too large')
        return
      }
      chunks.push(chunk)
    }
  } catch {
    res.writeHead(400)
    res.end('bad request')
    return
  }

  const body = Buffer.concat(chunks).toString('utf-8')

  try {
    const data = JSON.parse(body)

    // Validate channel_id matches expected channel
    if (data.channel_id && data.channel_id !== CHANNEL_ID) {
      log(`Rejected message for channel ${data.channel_id} (expected ${CHANNEL_ID})`)
      res.writeHead(403)
      res.end('channel mismatch')
      return
    }

    // Message came from a thread/forum post under this channel
    if (data.thread_id) knownThreads.add(data.thread_id)

    // Refuse instead of pretending: a message accepted here after the Claude
    // session died would be acknowledged in Discord and then never answered.
    if (!mcpAlive) {
      log('Message rejected: MCP session is not connected')
      res.writeHead(503)
      res.end('mcp disconnected')
      return
    }

    // Check for permission verdict
    const m = PERMISSION_REPLY_RE.exec(data.content)
    if (m) {
      await mcp.notification({
        method: 'notifications/claude/channel/permission',
        params: {
          request_id: m[2].toLowerCase(),
          behavior: m[1].toLowerCase().startsWith('y') ? 'allow' : 'deny',
        },
      })
      res.writeHead(200)
      res.end('verdict')
      return
    }

    // Build content with attachment info
    let content = data.content || ''
    if (data.attachments && data.attachments.length > 0) {
      const attachInfo = data.attachments
        .map((a) => `[attachment: ${a.name} (${a.type}, ${a.url})]`)
        .join('\n')
      content = content ? `${content}\n${attachInfo}` : attachInfo
    }

    // Forward as channel notification. Replies for a thread must go to the
    // thread, not the parent channel, so hand the model the thread id.
    const chatId = data.thread_id || data.channel_id
    if (data.thread_id) {
      content = `${content}\n[thread: ${data.thread_id} — reply with chat_id=${data.thread_id}]`
    }

    await mcp.notification({
      method: 'notifications/claude/channel',
      params: {
        content,
        meta: {
          chat_id: chatId,
          message_id: data.message_id,
          user: data.user,
        },
      },
    })

    lastInboundAt = Date.now()
    inboundCount++

    res.writeHead(200)
    res.end('ok')
  } catch (err) {
    log(`HTTP error: ${err.message}`)
    // "Not connected" means the Claude session is gone — say so honestly.
    const disconnected = /not connected/i.test(err.message || '')
    if (disconnected) mcpGone('notification failed')
    res.writeHead(disconnected ? 503 : 500)
    res.end(disconnected ? 'mcp disconnected' : 'error')
  }
})

httpServer.listen(PORT, '127.0.0.1', () => {
  log(`HTTP listening on 127.0.0.1:${PORT}`)
})
