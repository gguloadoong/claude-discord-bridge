#!/usr/bin/env node
/**
 * Doctor — "디스코드에서 말 걸어도 답이 없다"를 진단한다.
 *
 * 메시지가 죽는 지점은 다섯 군데다:
 *   1) config.json에 채널이 없거나 id가 틀림       → 봇이 그냥 무시
 *   2) MESSAGE CONTENT intent가 꺼짐               → 본문이 빈 채로 도착
 *   3) 봇에게 채널 권한 없음 (보기/보내기/반응)     → 읽거나 답장 불가
 *   4) channel-server가 죽음 / 포트 안 열림         → 전달 실패
 *   5) 포트는 열렸는데 Claude 세션이 끊김           → 전달은 되고 답만 없음
 *
 * Usage: npm run doctor
 */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DISCORD_API = 'https://discord.com/api/v10'

const OK = '✅'
const WARN = '⚠️ '
const BAD = '❌'

let problems = 0
let warnings = 0

const ok = (msg) => console.log(`  ${OK} ${msg}`)
const warn = (msg) => { warnings++; console.log(`  ${WARN} ${msg}`) }
const bad = (msg) => { problems++; console.log(`  ${BAD} ${msg}`) }
const hint = (msg) => console.log(`     → ${msg}`)
const section = (title) => console.log(`\n${title}`)

// ─── .env ───────────────────────────────────────────────────────────────────

function loadEnv() {
  const envPath = join(__dirname, '.env')
  if (!existsSync(envPath)) return
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (!m) continue
    const value = m[2].replace(/^["']|["']$/g, '')
    if (!process.env[m[1]]) process.env[m[1]] = value
  }
}

loadEnv()

const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || ''

// ─── Permission bits ────────────────────────────────────────────────────────

const PERM = {
  ADMINISTRATOR: 1n << 3n,
  ADD_REACTIONS: 1n << 6n,
  VIEW_CHANNEL: 1n << 10n,
  SEND_MESSAGES: 1n << 11n,
  EMBED_LINKS: 1n << 14n,
  READ_MESSAGE_HISTORY: 1n << 16n,
  SEND_MESSAGES_IN_THREADS: 1n << 38n,
}

const REQUIRED = [
  ['VIEW_CHANNEL', '채널 보기'],
  ['SEND_MESSAGES', '메시지 보내기'],
  ['READ_MESSAGE_HISTORY', '메시지 기록 보기'],
  ['ADD_REACTIONS', '반응 추가'],
  ['EMBED_LINKS', '링크 첨부 (embed 응답용)'],
]

const CHANNEL_TYPES = {
  0: '텍스트 채널', 2: '음성 채널', 4: '카테고리', 5: '공지 채널',
  10: '공지 스레드', 11: '공개 스레드', 12: '비공개 스레드', 15: '포럼', 16: '미디어',
}

async function api(path) {
  const res = await fetch(`${DISCORD_API}${path}`, {
    headers: { Authorization: `Bot ${BOT_TOKEN}` },
    signal: AbortSignal.timeout(10_000),
  })
  const body = await res.json().catch(() => null)
  return { ok: res.ok, status: res.status, body }
}

/** Effective permissions for the bot in a channel (base roles + overwrites). */
function computePerms(channel, member, roles, botUserId) {
  const roleMap = new Map(roles.map((r) => [r.id, BigInt(r.permissions)]))
  const everyoneId = roles.find((r) => r.name === '@everyone')?.id

  let perms = roleMap.get(everyoneId) ?? 0n
  for (const roleId of member.roles || []) perms |= roleMap.get(roleId) ?? 0n
  if (perms & PERM.ADMINISTRATOR) return { perms: ~0n, admin: true }

  const overwrites = channel.permission_overwrites || []
  const find = (id) => overwrites.find((o) => o.id === id)

  const everyoneOw = find(everyoneId)
  if (everyoneOw) {
    perms &= ~BigInt(everyoneOw.deny)
    perms |= BigInt(everyoneOw.allow)
  }

  let allow = 0n
  let deny = 0n
  for (const roleId of member.roles || []) {
    const ow = find(roleId)
    if (!ow) continue
    deny |= BigInt(ow.deny)
    allow |= BigInt(ow.allow)
  }
  perms &= ~deny
  perms |= allow

  const memberOw = find(botUserId)
  if (memberOw) {
    perms &= ~BigInt(memberOw.deny)
    perms |= BigInt(memberOw.allow)
  }

  return { perms, admin: false }
}

const ago = (ts) => {
  if (!ts) return '없음'
  const s = Math.round((Date.now() - ts) / 1000)
  if (s < 60) return `${s}초 전`
  if (s < 3600) return `${Math.round(s / 60)}분 전`
  return `${Math.round(s / 3600)}시간 전`
}

// ─── Checks ─────────────────────────────────────────────────────────────────

console.log('\n\u{1F50E} Claude Discord Bridge 진단\n' + '─'.repeat(52))

// 1. config.json
section('1. 설정 파일')

const configPath = process.env.CONFIG_PATH || join(__dirname, 'config.json')
let config
try {
  config = JSON.parse(readFileSync(configPath, 'utf-8'))
  const count = Object.keys(config.channels || {}).length
  if (!count) bad('config.json에 채널이 하나도 없습니다')
  else ok(`config.json — 채널 ${count}개`)
} catch (e) {
  bad(`config.json을 읽을 수 없습니다: ${e.message}`)
  hint('npm run setup 을 실행하세요')
  process.exit(1)
}

if (!BOT_TOKEN) {
  bad('DISCORD_BOT_TOKEN이 없습니다 (.env 또는 환경변수)')
  process.exit(1)
}
ok('DISCORD_BOT_TOKEN 설정됨')

// 2. Bot identity + intents
section('2. 봇 계정 / 인텐트')

const me = await api('/users/@me')
if (!me.ok) {
  bad(`봇 토큰이 유효하지 않습니다 (HTTP ${me.status})`)
  hint('Discord 개발자 포털에서 토큰을 다시 발급받아 .env에 넣으세요')
  process.exit(1)
}
ok(`봇: ${me.body.username} (${me.body.id})`)

const app = await api('/applications/@me')
if (app.ok) {
  const flags = BigInt(app.body.flags || 0)
  const MESSAGE_CONTENT = 1n << 18n
  const MESSAGE_CONTENT_LIMITED = 1n << 19n
  if (flags & MESSAGE_CONTENT || flags & MESSAGE_CONTENT_LIMITED) {
    ok('MESSAGE CONTENT INTENT 켜짐')
  } else {
    bad('MESSAGE CONTENT INTENT가 꺼져 있습니다 — 메시지 본문이 빈 채로 도착합니다')
    hint('개발자 포털 > Bot > Privileged Gateway Intents > MESSAGE CONTENT INTENT 켜기')
    hint('켠 뒤 npm start 로 봇을 재시작해야 적용됩니다')
  }
} else {
  warn(`application 정보를 못 읽었습니다 (HTTP ${app.status}) — 인텐트 확인 생략`)
}

// 3. Per-channel checks
section('3. 채널별 점검')

for (const [channelId, info] of Object.entries(config.channels)) {
  console.log(`\n  \u{1F4C2} #${info.name} (${channelId}) — 포트 ${info.port}`)

  const ch = await api(`/channels/${channelId}`)
  if (!ch.ok) {
    bad(`채널에 접근할 수 없습니다 (HTTP ${ch.status})`)
    hint(ch.status === 404
      ? 'channel id가 틀렸거나 채널이 삭제되었습니다. 채널 우클릭 > ID 복사로 확인하세요'
      : '봇이 이 서버에 없거나 채널 보기 권한이 없습니다')
    continue
  }

  const type = CHANNEL_TYPES[ch.body.type] || `type ${ch.body.type}`
  ok(`채널 확인: #${ch.body.name} (${type})`)
  if (ch.body.type === 15 || ch.body.type === 16) {
    warn('포럼/미디어 채널입니다 — 글은 스레드로 생기며, 스레드 메시지는 부모 채널로 라우팅됩니다')
  }

  // Permissions
  const guildId = ch.body.guild_id
  if (guildId) {
    const [member, roles] = await Promise.all([
      api(`/guilds/${guildId}/members/${me.body.id}`),
      api(`/guilds/${guildId}/roles`),
    ])
    if (member.ok && roles.ok) {
      const { perms, admin } = computePerms(ch.body, member.body, roles.body, me.body.id)
      if (admin) {
        ok('권한: 관리자 (모든 권한)')
      } else {
        const missing = REQUIRED.filter(([bit]) => !(perms & PERM[bit]))
        if (missing.length === 0) {
          ok('권한: 보기 / 보내기 / 기록 / 반응 모두 있음')
        } else {
          for (const [bit, label] of missing) {
            if (bit === 'SEND_MESSAGES') {
              bad(`권한 없음: ${label} — 봇이 답장을 보낼 수 없습니다 (이게 "답이 없는" 원인입니다)`)
            } else if (bit === 'VIEW_CHANNEL') {
              bad(`권한 없음: ${label} — 봇이 메시지를 아예 못 받습니다`)
            } else {
              warn(`권한 없음: ${label}`)
            }
          }
          hint('채널 설정 > 권한 > 봇 역할에 위 권한을 허용하세요')
        }
      }
    } else {
      warn('권한을 확인하지 못했습니다 (봇이 서버 멤버가 아닐 수 있음)')
    }
  }

  if (info.allowed_users?.length) {
    ok(`allowed_users ${info.allowed_users.length}명만 허용 — 목록에 없으면 무시됩니다`)
    hint(`허용된 ID: ${info.allowed_users.join(', ')}`)
  }

  // Local channel-server
  try {
    const res = await fetch(`http://127.0.0.1:${info.port}/health`, {
      signal: AbortSignal.timeout(3_000),
    })
    const health = await res.json().catch(() => null)

    if (res.ok) {
      ok(`채널 서버 정상 (포트 ${info.port}, MCP ${health?.mcp || '?'})`)
    } else if (health?.mcp === 'closed') {
      bad('포트는 열려 있지만 Claude 세션이 끊겼습니다 — 메시지를 보내도 답이 오지 않습니다')
      hint('npm start 로 세션을 다시 띄우세요')
    } else {
      bad(`채널 서버가 비정상 상태입니다 (HTTP ${res.status})`)
    }

    if (health) {
      console.log(`     최근 수신: ${ago(health.lastInboundAt)} (${health.inboundCount || 0}건)` +
        ` / 최근 응답: ${ago(health.lastReplyAt)} (${health.replyCount || 0}건)`)
      if (health.lastSendError) {
        bad(`최근 전송 실패: ${health.lastSendError.status} — ${health.lastSendError.reason}`)
      }
      if (health.inboundCount > 0 && !health.replyCount) {
        bad('메시지는 받았지만 한 번도 응답하지 못했습니다')
        hint('채널 권한(메시지 보내기)과 터미널의 Claude 세션 상태를 확인하세요')
      }
    }
  } catch {
    bad(`채널 서버가 응답하지 않습니다 (127.0.0.1:${info.port})`)
    hint('npm start 로 브리지를 실행하세요 (tmux 세션: claude-discord-bridge)')
  }
}

// 4. Bot process
section('4. 봇 프로세스')

try {
  const res = await fetch(`http://127.0.0.1:${process.env.DASHBOARD_PORT || 8800}/api/status`, {
    signal: AbortSignal.timeout(3_000),
  })
  const status = await res.json()
  ok(`bot.js 실행 중 (uptime ${Math.round(status.uptime / 60)}분)`)
  const offline = status.channels.filter((c) => !c.online)
  if (offline.length) warn(`오프라인 채널: ${offline.map((c) => `#${c.name}`).join(', ')}`)
} catch {
  bad('bot.js가 실행 중이 아닙니다 (대시보드 포트 응답 없음)')
  hint('npm start 로 실행하세요')
}

// ─── Summary ────────────────────────────────────────────────────────────────

console.log('\n' + '─'.repeat(52))
if (problems === 0 && warnings === 0) {
  console.log(`${OK} 문제를 찾지 못했습니다. 디스코드에서 다시 말을 걸어보세요.`)
} else {
  console.log(`문제 ${problems}건, 경고 ${warnings}건 — 위의 ${BAD} 항목부터 해결하세요.\n`)
}

process.exit(problems > 0 ? 1 : 0)
