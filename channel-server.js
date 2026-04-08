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
import { z } from 'zod'

const PORT = parseInt(process.argv[2] || '8801')
const CHANNEL_ID = process.argv[3] || ''
const CHANNEL_NAME = process.argv[4] || 'discord'
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || ''
const SHARED_SECRET = process.env.BRIDGE_SECRET || ''

const MAX_BODY_SIZE = 64 * 1024 // 64KB
const DISCORD_TIMEOUT = 10_000 // 10s

// stderr only — stdout is MCP stdio transport
const log = (...args) => process.stderr.write(`[${CHANNEL_NAME}] ${args.join(' ')}\n`)

// ─── Discord REST helpers ───────────────────────────────────────────────────

const DISCORD_API = 'https://discord.com/api/v10'

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
    log(`Discord API error: ${res.status} ${err}`)
  }
  return res
}

async function discordSend(channelId, text, replyTo) {
  const chunks = splitMessage(text, 1950)
  const results = []

  for (let i = 0; i < chunks.length; i++) {
    const body = { content: chunks[i] }
    if (i === 0 && replyTo) {
      body.message_reference = { message_id: replyTo }
    }
    const res = await discordFetch(`/channels/${channelId}/messages`, {
      method: 'POST',
      body: JSON.stringify(body),
    })
    if (res.ok) results.push(await res.json())
  }

  return results
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

  switch (name) {
    case 'reply': {
      const results = await discordSend(args.chat_id, args.text, args.reply_to)
      const ids = results.map((r) => r.id).join(', ')
      return { content: [{ type: 'text', text: `sent (message_ids: ${ids})` }] }
    }

    case 'edit_message': {
      const chunks = splitMessage(args.text, 1950)
      await discordFetch(`/channels/${args.chat_id}/messages/${args.message_id}`, {
        method: 'PATCH',
        body: JSON.stringify({ content: chunks[0] }),
      })
      return { content: [{ type: 'text', text: 'edited' }] }
    }

    case 'react': {
      const emoji = encodeURIComponent(args.emoji)
      await discordFetch(
        `/channels/${args.chat_id}/messages/${args.message_id}/reactions/${emoji}/@me`,
        { method: 'PUT' },
      )
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
    `Description: ${params.description}`,
    '',
    `Reply \`yes ${params.request_id}\` or \`no ${params.request_id}\``,
  ].join('\n')

  await discordSend(CHANNEL_ID, text)
})

// ─── Connect MCP ────────────────────────────────────────────────────────────

await mcp.connect(new StdioServerTransport())
log(`MCP connected (port: ${PORT}, channel: ${CHANNEL_ID})`)

// ─── HTTP server ────────────────────────────────────────────────────────────

const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i

const httpServer = createServer(async (req, res) => {
  // Health check
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ status: 'ok', channel: CHANNEL_NAME, port: PORT }))
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

  // Read body with size limit
  let body = ''
  let size = 0
  try {
    for await (const chunk of req) {
      size += chunk.length
      if (size > MAX_BODY_SIZE) {
        res.writeHead(413)
        res.end('payload too large')
        return
      }
      body += chunk
    }
  } catch {
    res.writeHead(400)
    res.end('bad request')
    return
  }

  try {
    const data = JSON.parse(body)

    // Validate channel_id matches expected channel
    if (data.channel_id && data.channel_id !== CHANNEL_ID) {
      log(`Rejected message for channel ${data.channel_id} (expected ${CHANNEL_ID})`)
      res.writeHead(403)
      res.end('channel mismatch')
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

    // Forward as channel notification
    await mcp.notification({
      method: 'notifications/claude/channel',
      params: {
        content,
        meta: {
          chat_id: data.channel_id,
          message_id: data.message_id,
          user: data.user,
        },
      },
    })

    res.writeHead(200)
    res.end('ok')
  } catch (err) {
    log(`HTTP error: ${err.message}`)
    res.writeHead(500)
    res.end('error')
  }
})

httpServer.listen(PORT, '127.0.0.1', () => {
  log(`HTTP listening on 127.0.0.1:${PORT}`)
})
