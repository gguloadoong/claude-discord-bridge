#!/usr/bin/env node
/**
 * Interactive setup — creates config.json and per-project .mcp.json files.
 * Usage: node setup.js
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

const rl = createInterface({ input: process.stdin, output: process.stdout })
const ask = (q) => new Promise((r) => rl.question(q, r))

console.log('')
console.log('=== Claude Discord Bridge Setup ===')
console.log('')
console.log('You need:')
console.log('  1. A Discord bot token (https://discord.com/developers/applications)')
console.log('  2. Channel IDs (Discord Settings > Advanced > Developer Mode ON > right-click channel > Copy ID)')
console.log('')

// ─── Bot token ──────────────────────────────────────────────────────────────

const envPath = join(__dirname, '.env')
let token = ''

if (existsSync(envPath)) {
  const existing = readFileSync(envPath, 'utf-8')
  if (existing.includes('DISCORD_BOT_TOKEN=')) {
    console.log('[ok] .env file exists with bot token')
    token = 'exists'
  }
}

if (!token) {
  token = await ask('Discord Bot Token: ')
  if (!token.trim()) {
    console.error('Token is required.')
    process.exit(1)
  }
  let envContent = `DISCORD_BOT_TOKEN=${token.trim()}\n`

  const secret = await ask('Shared secret for bot<->server auth (optional, press Enter to skip): ')
  if (secret.trim()) {
    envContent += `BRIDGE_SECRET=${secret.trim()}\n`
  }

  writeFileSync(envPath, envContent)
  console.log('[ok] .env saved')
}

console.log('')

// ─── Channels ───────────────────────────────────────────────────────────────

const channels = {}
let port = 8801

console.log('Add your channels. Type "done" when finished.')
console.log('')

let index = 1
while (true) {
  const channelId = await ask(`Channel ${index} ID (or "done"): `)
  if (channelId.trim().toLowerCase() === 'done') break
  if (!/^\d{17,20}$/.test(channelId.trim())) {
    console.log('  Invalid ID — should be 17-20 digits. Try again.')
    continue
  }

  const name = await ask(`  Display name (e.g. "my-api"): `)
  const slug = await ask(`  Short slug for tmux window (e.g. "api"): `)
  const cwd = await ask(`  Project directory (absolute path): `)

  if (!existsSync(cwd.trim())) {
    console.log(`  Warning: ${cwd.trim()} does not exist yet.`)
  }

  channels[channelId.trim()] = {
    name: name.trim() || `project-${index}`,
    slug: slug.trim() || `proj${index}`,
    port,
    cwd: cwd.trim(),
  }

  console.log(`  [ok] #${name.trim()} -> port ${port} -> ${cwd.trim()}`)
  console.log('')
  port++
  index++
}

if (Object.keys(channels).length === 0) {
  console.error('No channels added. Exiting.')
  process.exit(1)
}

// ─── Write config.json ──────────────────────────────────────────────────────

const configPath = join(__dirname, 'config.json')
writeFileSync(configPath, JSON.stringify({ channels }, null, 2) + '\n')
console.log('')
console.log(`[ok] config.json saved (${Object.keys(channels).length} channels)`)

// ─── Write per-project .mcp.json ────────────────────────────────────────────

for (const [channelId, info] of Object.entries(channels)) {
  const mcpPath = join(info.cwd, '.mcp.json')
  let mcpConfig = {}

  // Merge with existing .mcp.json if present
  if (existsSync(mcpPath)) {
    try {
      mcpConfig = JSON.parse(readFileSync(mcpPath, 'utf-8'))
    } catch {}
  }

  if (!mcpConfig.mcpServers) mcpConfig.mcpServers = {}
  mcpConfig.mcpServers['discord-bridge'] = {
    command: 'node',
    args: [join(__dirname, 'channel-server.js'), String(info.port), channelId, info.name],
  }

  writeFileSync(mcpPath, JSON.stringify(mcpConfig, null, 2) + '\n')
  console.log(`[ok] ${mcpPath}`)
}

console.log('')
console.log('=== Setup complete! ===')
console.log('')
console.log('  Start:  npm start')
console.log('  Stop:   npm stop')
console.log('  Monitor: tmux attach -t claude-discord-bridge')
console.log('')

rl.close()
