import { createHmac, randomBytes } from 'node:crypto'
import { prisma } from './prisma'
import { getCurrentOrgId } from './auth/orgContext'

// Brief 43 PR 17 — spend guards on the routes that call paid AI services: chat,
// text-to-speech, transcription and voice sessions (Brief 46 §7, top fix #8).
// [engineering precaution] DealFlow has no login, by Ryan's choice
// [Ryan, 2026-09-24], so anyone who finds its address could run up the AI bill;
// Brief 46 measured 2–10¢ per chat message, about $1 at worst. None of these
// limits is a rule of Ryan's. Each is an env setting he can raise without a
// code change; an empty or garbage value means the default, never "no limit"
// and never 0.
//
// Counting, with no migration: every request a guard lets through writes one
// small AuditLog row (action SPEND_GUARD_REQUEST, detailsJson { route, ipHash },
// plus `chars` for speech), because serverless copies share no memory. Only a
// salted HMAC of the address is stored, never the address. A refusal writes no
// counter row, only one counts-only SPEND_GUARD_REFUSED row: { route, reason }.
// AuditLog is indexed on organizationId only (no action/createdAt index, and
// this PR adds none), so a check is one scan of a small table; the rows it
// reads back are bounded by the day's global caps. Normal use adds roughly 75
// rows a day (about 10 chat turns, 60 spoken sentences, a few dictations).

export const SPEND_GUARD_REQUEST = 'SPEND_GUARD_REQUEST'
export const SPEND_GUARD_REFUSED = 'SPEND_GUARD_REFUSED'
export type GuardedRoute = 'chat' | 'tts' | 'transcribe' | 'voice_session'
type Env = Record<string, string | undefined>

export const DAILY_SPEND_MESSAGE = "Drift's daily spending limit is reached. It resets at midnight."
const CHAT_IP_DAY_MESSAGE = "This connection has reached today's message limit for Drift. It resets at midnight."
const CHAT_IP_MINUTE_MESSAGE = "That's a lot of messages in one minute. Wait a minute and try again."
const TTS_HOUR_MESSAGE = "Drift's voice has reached its hourly limit. Try again in a little while."
const TTS_DAY_MESSAGE = "Drift's voice has reached its daily limit. It resets at midnight."
const TTS_UNAVAILABLE_MESSAGE = "Drift's voice is unavailable for a moment. Try again shortly."
const DICTATION_HOUR_MESSAGE = 'Dictation has reached its hourly limit. Try again in a little while.'
const DICTATION_DAY_MESSAGE = 'Dictation has reached its daily limit. It resets at midnight.'
const DICTATION_UNAVAILABLE_MESSAGE = 'Dictation is unavailable for a moment. Try again shortly.'
export const DICTATION_TOO_LARGE_MESSAGE = 'That recording is too long. Try a shorter one.'

// Defaults sit well above Ryan's own use: about 10 chat turns on a normal day
// (Brief 46); the ★ 10 re-run sends 10 in about 3 minutes; Brief 42 Stage 2 is
// at most 70 messages in a day.
export const LIMIT_DEFAULTS = {
  // Brief 43 §4 PR 17's $5, summed from DriftInteraction.costUsd over the New York day.
  CHAT_DAILY_USD_CAP: 5,
  // Backstop while costUsd undercounts (no cache tokens; no fact-check, parser
  // or title calls) until Brief 43 PR 15. 200 is 20 normal days, or Stage 2
  // plus a normal day 2.5 times over; at Brief 46's typical 4–7¢ a message it
  // bounds a day at roughly $8–14 even if costUsd saw nothing.
  CHAT_DAILY_MESSAGE_CAP: 200,
  CHAT_PER_IP_PER_MINUTE: 10,
  CHAT_PER_IP_PER_DAY: 100,
  // Voice mode asks for one clip per sentence (components/voice/player.ts), so
  // one spoken reply is about 3–8 clips: 300 an hour is about 50 spoken replies.
  // (Brief 43 says 30 an hour; counted per clip, that would cut Ryan off after
  // about 5 spoken replies.)
  TTS_PER_IP_PER_HOUR: 300,
  // About 110 minutes of speech a day (≈ $1.70 at gpt-4o-mini-tts's ≈ 1.5¢ a
  // minute). A 10-turn voice conversation is about 6,000 characters.
  TTS_DAILY_CHAR_CAP: 100_000,
  TRANSCRIBE_PER_IP_PER_HOUR: 30,
  // Dictation is one call per take; Ryan's day is a handful.
  TRANSCRIBE_DAILY_CAP: 200,
  // The JSON body (base64 audio): about 90 seconds of dictation at 128 kbps.
  // (Vercel refuses bodies over 4.5 MB whatever this says.)
  TRANSCRIBE_MAX_BYTES: 2 * 1024 * 1024,
  // Inside the existing global 60 an hour (lib/voice/session.ts).
  VOICE_SESSIONS_PER_IP_PER_HOUR: 10,
  RETITLE_MAX_PER_CALL: 20,
}
export type LimitName = keyof typeof LIMIT_DEFAULTS

export function limit(name: LimitName, env: Env = process.env): number {
  const raw = env[name]?.trim()
  const n = raw ? Number(raw) : NaN
  const v = name === 'CHAT_DAILY_USD_CAP' ? n : Math.floor(n)
  return Number.isFinite(v) && v > 0 ? v : LIMIT_DEFAULTS[name]
}

// ── the New York day (every "a day" limit resets at midnight New York time) ──

const NY_PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
})
function nyWall(t: number): Record<string, number> {
  return Object.fromEntries(NY_PARTS.formatToParts(new Date(t)).map(p => [p.type, Number(p.value)]))
}
// New York wall-clock time minus UTC, in ms (e.g. -4 h in summer).
function nyOffsetMs(t: number): number {
  const p = nyWall(t)
  return Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second) - (t - (t % 1000))
}
export function startOfNewYorkDay(now: Date = new Date()): Date {
  const t = now.getTime()
  const p = nyWall(t)
  const wallMidnight = Date.UTC(p.year, p.month - 1, p.day)
  // Use midnight's own offset, which differs from now's on the two DST days.
  return new Date(wallMidnight - nyOffsetMs(wallMidnight - nyOffsetMs(t)))
}

// ── the address bucket and its salted hash ──────────────────────────────────

// A missing or unreadable address shares one bucket: not a way around the limit.
export const UNKNOWN_ADDRESS = 'unknown'

function ipv4(s: string): string | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s)
  return m && m.slice(1).every(o => Number(o) <= 255) ? m.slice(1).map(Number).join('.') : null
}

// IPv6 is bucketed by its /64: one device or home network gets a whole /64,
// so counting single addresses would let it rotate past any limit.
function ipv6Prefix(s: string): string | null {
  const dotted = s.lastIndexOf(':')
  if (s.includes('.')) {
    if (!ipv4(s.slice(dotted + 1))) return null
    s = `${s.slice(0, dotted + 1)}0:0` // an embedded IPv4 tail is two groups
  }
  const halves = s.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  if (![...head, ...tail].every(g => /^[0-9a-f]{1,4}$/.test(g))) return null
  const fill = 8 - head.length - tail.length
  if (halves.length === 2 ? fill < 1 : fill !== 0) return null
  const groups = [...head, ...Array(Math.max(fill, 0)).fill('0'), ...tail]
  return `${groups.slice(0, 4).map(g => parseInt(g, 16).toString(16)).join(':')}::/64`
}

export function normalizeAddress(raw: string): string {
  let s = raw.trim().toLowerCase()
  if (!s || s.length > 100) return UNKNOWN_ADDRESS
  const bracketed = /^\[([^\]]*)\](?::\d+)?$/.exec(s)
  if (bracketed) s = bracketed[1]
  else if (/^[\d.]+:\d+$/.test(s)) s = s.slice(0, s.lastIndexOf(':')) // v4:port
  s = s.replace(/%[^%]*$/, '') // an IPv6 zone id
  const mapped = /^::ffff:([\d.]+)$/.exec(s)
  if (mapped) s = mapped[1]
  return ipv4(s) ?? (s.includes(':') ? ipv6Prefix(s) : null) ?? UNKNOWN_ADDRESS
}

// The caller's address as Vercel sets it: x-forwarded-for (Vercel overwrites
// it with the client's address), then x-real-ip.
export function clientAddress(headers: Headers): string {
  const forwarded = headers.get('x-forwarded-for')?.split(',')[0]?.trim()
  return normalizeAddress(forwarded || headers.get('x-real-ip') || '')
}

// The HMAC key: an optional SPEND_GUARD_SALT, else a server-only secret
// production already has (CRON_SECRET, then the AI keys), so Ryan sets nothing
// new. Any environment that can spend has an AI key; one with no secret at all
// gets a random per-process key, never a public constant. Changing the secret
// only restarts the per-address windows.
const PROCESS_KEY = randomBytes(32).toString('hex')
const KEY_SOURCES = ['SPEND_GUARD_SALT', 'CRON_SECRET', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY'] as const
function hashKey(env: Env): string {
  for (const name of KEY_SOURCES) {
    const v = env[name]?.trim()
    if (v && v.length >= 16) return v
  }
  return PROCESS_KEY
}
export function hashAddress(address: string, env: Env = process.env): string {
  return createHmac('sha256', hashKey(env)).update(`spend-guard-v1|${address}`).digest('hex').slice(0, 32)
}

// ── windows (pure) ──────────────────────────────────────────────────────────

export interface CounterRow { createdAt: Date; ipHash: string | null; chars: number }
export interface WindowRule {
  reason: string
  message: string
  max: number
  since: Date
  perIp: boolean
  measure: 'count' | 'chars'
}

// The first rule this request would break: a count rule once `max` requests
// are already in its window, a character rule once this request's characters
// would take the window past `max`.
export function firstBreach(rows: CounterRow[], ipHash: string, rules: WindowRule[], charge = 0): WindowRule | null {
  for (const rule of rules) {
    const inWindow = rows.filter(r => r.createdAt >= rule.since && (!rule.perIp || r.ipHash === ipHash))
    const breached = rule.measure === 'count'
      ? inWindow.length >= rule.max
      : inWindow.reduce((sum, r) => sum + r.chars, 0) + charge > rule.max
    if (breached) return rule
  }
  return null
}

const ago = (now: Date, ms: number) => new Date(now.getTime() - ms)
const MINUTE = 60_000
const HOUR = 60 * MINUTE

export function chatRules(now: Date, env: Env = process.env): WindowRule[] {
  const day = startOfNewYorkDay(now)
  return [
    { reason: 'daily_messages', message: DAILY_SPEND_MESSAGE, max: limit('CHAT_DAILY_MESSAGE_CAP', env), since: day, perIp: false, measure: 'count' },
    { reason: 'ip_per_day', message: CHAT_IP_DAY_MESSAGE, max: limit('CHAT_PER_IP_PER_DAY', env), since: day, perIp: true, measure: 'count' },
    { reason: 'ip_per_minute', message: CHAT_IP_MINUTE_MESSAGE, max: limit('CHAT_PER_IP_PER_MINUTE', env), since: ago(now, MINUTE), perIp: true, measure: 'count' },
  ]
}

export function ttsRules(now: Date, env: Env = process.env): WindowRule[] {
  return [
    { reason: 'daily_chars', message: TTS_DAY_MESSAGE, max: limit('TTS_DAILY_CHAR_CAP', env), since: startOfNewYorkDay(now), perIp: false, measure: 'chars' },
    { reason: 'ip_per_hour', message: TTS_HOUR_MESSAGE, max: limit('TTS_PER_IP_PER_HOUR', env), since: ago(now, HOUR), perIp: true, measure: 'count' },
  ]
}

export function transcribeRules(now: Date, env: Env = process.env): WindowRule[] {
  return [
    { reason: 'daily_count', message: DICTATION_DAY_MESSAGE, max: limit('TRANSCRIBE_DAILY_CAP', env), since: startOfNewYorkDay(now), perIp: false, measure: 'count' },
    { reason: 'ip_per_hour', message: DICTATION_HOUR_MESSAGE, max: limit('TRANSCRIBE_PER_IP_PER_HOUR', env), since: ago(now, HOUR), perIp: true, measure: 'count' },
  ]
}

const earliest = (rules: WindowRule[]) => new Date(Math.min(...rules.map(r => r.since.getTime())))

// Speech is charged what the provider reads (lib/voice/tts.ts cuts at 4,000),
// and at least a short sentence, which also bounds the rows a day can hold.
export const TTS_MIN_CHARGE = 100
const TTS_PROVIDER_MAX_CHARS = 4000
const ttsCharge = (text: string) => Math.max(TTS_MIN_CHARGE, Math.min(text.length, TTS_PROVIDER_MAX_CHARS))

// ── the store (Prisma; injectable for tests) ────────────────────────────────

export interface SpendGuardStore {
  recentRows(route: GuardedRoute, since: Date): Promise<CounterRow[]>
  chatSpendUsdSince(since: Date): Promise<number>
  record(route: GuardedRoute, ipHash: string, chars?: number): Promise<void>
  refused(route: GuardedRoute, reason: string): Promise<void>
}

export const prismaSpendStore: SpendGuardStore = {
  async recentRows(route, since) {
    const rows = await prisma.auditLog.findMany({
      where: { action: SPEND_GUARD_REQUEST, createdAt: { gte: since }, detailsJson: { path: ['route'], equals: route } },
      select: { createdAt: true, detailsJson: true },
    })
    return rows.map(r => {
      const d = (r.detailsJson ?? {}) as { ipHash?: unknown; chars?: unknown }
      return {
        createdAt: r.createdAt,
        ipHash: typeof d.ipHash === 'string' ? d.ipHash : null,
        chars: typeof d.chars === 'number' ? d.chars : 0,
      }
    })
  },
  async chatSpendUsdSince(since) {
    const agg = await prisma.driftInteraction.aggregate({ where: { createdAt: { gte: since } }, _sum: { costUsd: true } })
    return agg._sum.costUsd ?? 0
  },
  async record(route, ipHash, chars) {
    await prisma.auditLog.create({
      data: {
        organizationId: await getCurrentOrgId(),
        action: SPEND_GUARD_REQUEST,
        detailsJson: chars == null ? { route, ipHash } : { route, ipHash, chars },
      },
    })
  },
  async refused(route, reason) {
    await prisma.auditLog.create({
      data: { organizationId: await getCurrentOrgId(), action: SPEND_GUARD_REFUSED, detailsJson: { route, reason } },
    })
  },
}

// ── responses ───────────────────────────────────────────────────────────────

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 200)

function jsonResponse(body: object, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })
}

// A plain 429 with no address, hash or limit numbers in it.
export function spendLimitResponse(message: string, extra: Record<string, unknown> = {}): Response {
  return jsonResponse({ error: 'spend_limit', message, ...extra }, 429)
}

export function tooLargeResponse(message: string): Response {
  return jsonResponse({ error: 'too_large', message }, 413)
}

// One counts-only row per refusal; best effort (a logging failure never turns
// a refusal into something else).
export async function logSpendRefusal(route: GuardedRoute, reason: string, store: SpendGuardStore = prismaSpendStore): Promise<void> {
  try {
    await store.refused(route, reason)
  } catch (err) {
    console.error(`[spendGuard] couldn't log a ${route} refusal:`, errText(err))
  }
}

async function refuse(store: SpendGuardStore, route: GuardedRoute, reason: string, message: string, extra?: Record<string, unknown>) {
  await logSpendRefusal(route, reason, store)
  return spendLimitResponse(message, extra)
}

// ── the guards ──────────────────────────────────────────────────────────────

export interface GuardOptions { store?: SpendGuardStore; now?: Date; env?: Env }

// POST /api/chat. Returns a 429 to send as-is, or null to carry on. The refusal
// also carries `response`, which the chat page shows as Drift's bubble; nothing
// is written to the chat and no session is created. A DB hiccup inside the
// guard lets the message through (proceed and log): Ryan's own use must keep
// working, and a real outage fails the route's own session lookup before any
// paid call anyway.
export async function guardChat(req: Request, o: GuardOptions = {}): Promise<Response | null> {
  const store = o.store ?? prismaSpendStore
  const now = o.now ?? new Date()
  const env = o.env ?? process.env
  try {
    const ipHash = hashAddress(clientAddress(req.headers), env)
    const rules = chatRules(now, env)
    const [rows, spentUsd] = await Promise.all([
      store.recentRows('chat', earliest(rules)),
      store.chatSpendUsdSince(startOfNewYorkDay(now)),
    ])
    if (spentUsd >= limit('CHAT_DAILY_USD_CAP', env)) {
      return refuse(store, 'chat', 'daily_usd', DAILY_SPEND_MESSAGE, { response: DAILY_SPEND_MESSAGE })
    }
    const hit = firstBreach(rows, ipHash, rules)
    if (hit) return refuse(store, 'chat', hit.reason, hit.message, { response: hit.message })
    await store.record('chat', ipHash)
    return null
  } catch (err) {
    console.error('[spendGuard] chat check failed; letting the message through:', errText(err))
    return null
  }
}

// The voice routes fail closed on a DB error: the cap is all that stands
// between a stranger and the bill there, and Ryan loses nothing he could use
// (with the database down, chat itself can't answer).
async function guardCounted(
  route: 'tts' | 'transcribe', rules: WindowRule[], unavailable: string, req: Request, o: GuardOptions, charge?: number,
): Promise<Response | null> {
  const store = o.store ?? prismaSpendStore
  try {
    const ipHash = hashAddress(clientAddress(req.headers), o.env ?? process.env)
    const hit = firstBreach(await store.recentRows(route, earliest(rules)), ipHash, rules, charge ?? 0)
    if (hit) return refuse(store, route, hit.reason, hit.message)
    await store.record(route, ipHash, charge)
    return null
  } catch (err) {
    console.error(`[spendGuard] ${route} check failed; refusing:`, errText(err))
    return refuse(store, route, 'guard_unavailable', unavailable)
  }
}

// POST /api/tts: clips an hour per address, and a daily character budget.
export function guardTts(req: Request, text: string, o: GuardOptions = {}): Promise<Response | null> {
  const now = o.now ?? new Date()
  return guardCounted('tts', ttsRules(now, o.env ?? process.env), TTS_UNAVAILABLE_MESSAGE, req, o, ttsCharge(text))
}

// POST /api/transcribe: takes an hour per address, and a daily count.
export function guardTranscribe(req: Request, o: GuardOptions = {}): Promise<Response | null> {
  const now = o.now ?? new Date()
  return guardCounted('transcribe', transcribeRules(now, o.env ?? process.env), DICTATION_UNAVAILABLE_MESSAGE, req, o)
}

// The request body as text, or null once it passes `maxBytes`: a declared
// length over the cap is refused without reading a byte, and an undeclared
// one stops being read just past the cap.
export async function readBodyCapped(req: Request, maxBytes: number): Promise<string | null> {
  const declared = Number(req.headers.get('content-length') ?? NaN)
  if (Number.isFinite(declared) && declared > maxBytes) return null
  if (!req.body) return ''
  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}
