import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import './pr17FakePrisma' // no database client, ever
import {
  LIMIT_DEFAULTS, DAILY_SPEND_MESSAGE, SPEND_GUARD_REFUSED, SPEND_GUARD_REQUEST, TTS_MIN_CHARGE,
  limit, startOfNewYorkDay, clientAddress, hashAddress, firstBreach, chatRules, ttsRules, transcribeRules,
  guardChat, guardTts, guardTranscribe, readBodyCapped, spendLimitResponse,
  type CounterRow, type SpendGuardStore,
} from '../spendGuard'

// Brief 43 PR 17 [engineering precaution] (DealFlow has no login [Ryan,
// 2026-09-24]): the limiter windows, the address bucket and its salted
// hash, the env settings, and the guard decisions, with an injected store.

const NOW = new Date('2026-10-19T16:00:00Z') // 12:00 EDT
const MIN = 60_000
const HOUR = 60 * MIN

// ── env settings ────────────────────────────────────────────────────────────

test('limits: unset, empty, garbage, zero and negative values all fall back to the default', () => {
  for (const raw of [undefined, '', '   ', 'abc', '0', '-5', 'NaN', 'Infinity', '0.4']) {
    const env = raw === undefined ? {} : { CHAT_PER_IP_PER_MINUTE: raw, CHAT_DAILY_USD_CAP: raw }
    assert.equal(limit('CHAT_PER_IP_PER_MINUTE', env), LIMIT_DEFAULTS.CHAT_PER_IP_PER_MINUTE, `count for ${raw}`)
    if (raw !== '0.4') assert.equal(limit('CHAT_DAILY_USD_CAP', env), LIMIT_DEFAULTS.CHAT_DAILY_USD_CAP, `usd for ${raw}`)
  }
})

test('limits: a valid setting is used, so Ryan can raise any limit without a code change', () => {
  assert.equal(limit('CHAT_DAILY_USD_CAP', { CHAT_DAILY_USD_CAP: '12.5' }), 12.5)
  assert.equal(limit('CHAT_DAILY_USD_CAP', { CHAT_DAILY_USD_CAP: '0.4' }), 0.4)
  assert.equal(limit('TTS_DAILY_CHAR_CAP', { TTS_DAILY_CHAR_CAP: ' 250000 ' }), 250_000)
  assert.equal(limit('CHAT_PER_IP_PER_DAY', { CHAT_PER_IP_PER_DAY: '150.9' }), 150)
  for (const name of Object.keys(LIMIT_DEFAULTS) as Array<keyof typeof LIMIT_DEFAULTS>) {
    assert.ok(limit(name, {}) > 0, `${name} default is a real limit`)
  }
})

test('defaults sit well above Ryan’s normal day and the planned test runs', () => {
  // ~10 chat turns on a normal day; the ★ 10 re-run sends 10 in ~3 minutes;
  // Brief 42 Stage 2 is at most 70 messages.
  assert.equal(LIMIT_DEFAULTS.CHAT_DAILY_USD_CAP, 5)
  assert.equal(LIMIT_DEFAULTS.CHAT_PER_IP_PER_MINUTE, 10)
  assert.equal(LIMIT_DEFAULTS.CHAT_PER_IP_PER_DAY, 100)
  assert.ok(LIMIT_DEFAULTS.CHAT_DAILY_MESSAGE_CAP >= 2 * (70 + 10))
  assert.ok(LIMIT_DEFAULTS.TRANSCRIBE_MAX_BYTES >= 2_000_000 && LIMIT_DEFAULTS.TRANSCRIBE_MAX_BYTES < 3_000_000)
  assert.equal(LIMIT_DEFAULTS.VOICE_SESSIONS_PER_IP_PER_HOUR, 10)
  assert.equal(LIMIT_DEFAULTS.RETITLE_MAX_PER_CALL, 20)
})

// ── the New York day ────────────────────────────────────────────────────────

test('the day starts at midnight New York time, across both daylight-saving changes', () => {
  assert.equal(startOfNewYorkDay(NOW).toISOString(), '2026-10-19T04:00:00.000Z') // EDT
  assert.equal(startOfNewYorkDay(new Date('2026-10-20T03:59:00Z')).toISOString(), '2026-10-19T04:00:00.000Z') // 23:59 EDT
  assert.equal(startOfNewYorkDay(new Date('2026-10-20T04:00:00Z')).toISOString(), '2026-10-20T04:00:00.000Z')
  assert.equal(startOfNewYorkDay(new Date('2026-12-01T12:00:00Z')).toISOString(), '2026-12-01T05:00:00.000Z') // EST
  // Spring forward (Mar 8, 2026, 2am): midnight was still EST.
  assert.equal(startOfNewYorkDay(new Date('2026-03-08T14:00:00Z')).toISOString(), '2026-03-08T05:00:00.000Z')
  // Fall back (Nov 1, 2026, 2am): midnight was still EDT.
  assert.equal(startOfNewYorkDay(new Date('2026-11-01T15:00:00Z')).toISOString(), '2026-11-01T04:00:00.000Z')
})

// ── the address bucket and its hash ─────────────────────────────────────────

const h = (init: Record<string, string>) => new Headers(init)

test('address: x-forwarded-for first (as Vercel sets it), then x-real-ip; missing or garbage is one shared bucket', () => {
  assert.equal(clientAddress(h({ 'x-forwarded-for': '203.0.113.7' })), '203.0.113.7')
  assert.equal(clientAddress(h({ 'x-forwarded-for': ' 203.0.113.7 , 10.0.0.1' })), '203.0.113.7')
  assert.equal(clientAddress(h({ 'x-real-ip': '198.51.100.4' })), '198.51.100.4')
  assert.equal(clientAddress(h({ 'x-forwarded-for': '203.0.113.7', 'x-real-ip': '198.51.100.4' })), '203.0.113.7')
  assert.equal(clientAddress(h({ 'x-forwarded-for': '203.0.113.7:51234' })), '203.0.113.7')
  assert.equal(clientAddress(h({ 'x-forwarded-for': '::ffff:203.0.113.7' })), '203.0.113.7')
  // A missing address is a shared bucket, not a way around the limit.
  assert.equal(clientAddress(h({})), 'unknown')
  assert.equal(clientAddress(h({ 'x-forwarded-for': '' })), 'unknown')
  assert.equal(clientAddress(h({ 'x-forwarded-for': 'not-an-address' })), 'unknown')
  assert.equal(clientAddress(h({ 'x-forwarded-for': '999.1.1.1' })), 'unknown')
})

test('address: IPv6 is bucketed by its /64, so one device can’t rotate through its own addresses', () => {
  const a = clientAddress(h({ 'x-forwarded-for': '2001:db8:85a3:12::1' }))
  const b = clientAddress(h({ 'x-forwarded-for': '2001:0DB8:85a3:0012:ffff:eeee:dddd:cccc' }))
  const c = clientAddress(h({ 'x-forwarded-for': '[2001:db8:85a3:12::99]:443' }))
  assert.equal(a, '2001:db8:85a3:12::/64')
  assert.equal(b, a)
  assert.equal(c, a)
  assert.notEqual(clientAddress(h({ 'x-forwarded-for': '2001:db8:85a3:13::1' })), a)
  assert.equal(clientAddress(h({ 'x-forwarded-for': '::1' })), '0:0:0:0::/64')
  assert.equal(clientAddress(h({ 'x-forwarded-for': '2001:db8::zz' })), 'unknown')
})

test('hash: an HMAC of the address, never the address, keyed by a server-only secret', () => {
  const env = { SPEND_GUARD_SALT: 'a-test-salt-that-is-long-enough' }
  const one = hashAddress('203.0.113.7', env)
  assert.match(one, /^[0-9a-f]{32}$/)
  assert.ok(!one.includes('203'))
  assert.equal(hashAddress('203.0.113.7', env), one, 'stable, so windows can count it')
  assert.notEqual(hashAddress('203.0.113.8', env), one)
  assert.notEqual(hashAddress('203.0.113.7', { SPEND_GUARD_SALT: 'another-test-salt-long-enough' }), one, 'the salt matters')
  // No new setting needed: it falls back to the server's existing cron secret,
  // then the AI keys (any environment that can spend has one of them).
  const cron = { CRON_SECRET: 'cron-secret-for-this-test-only' }
  assert.equal(hashAddress('203.0.113.7', cron), hashAddress('203.0.113.7', { ...cron, SPEND_GUARD_SALT: 'short' }))
  assert.notEqual(hashAddress('203.0.113.7', cron), hashAddress('203.0.113.7', { ANTHROPIC_API_KEY: 'anthropic-test-placeholder' }))
  // With no secret at all (no AI key either, so nothing can spend) it uses a
  // random per-process key: stable here, never an empty or public key.
  const bare = hashAddress('203.0.113.7', {})
  assert.equal(hashAddress('203.0.113.7', { SPEND_GUARD_SALT: '' }), bare)
  assert.notEqual(bare, createHmac('sha256', '').update('spend-guard-v1|203.0.113.7').digest('hex').slice(0, 32))
  assert.notEqual(bare, hashAddress('203.0.113.7', cron))
})

// ── windows ─────────────────────────────────────────────────────────────────

const rows = (n: number, ipHash: string | null, ageMs: number, chars = 0): CounterRow[] =>
  Array.from({ length: n }, () => ({ createdAt: new Date(NOW.getTime() - ageMs), ipHash, chars }))

test('chat windows: the 11th message in a minute from one address is refused; the 10th is not', () => {
  const rules = chatRules(NOW, {})
  assert.equal(firstBreach(rows(9, 'me', 30_000), 'me', rules), null)
  assert.equal(firstBreach(rows(10, 'me', 30_000), 'me', rules)?.reason, 'ip_per_minute')
  // Older than a minute: counts for the day, not the minute.
  assert.equal(firstBreach(rows(10, 'me', 61_000), 'me', rules), null)
  // Another address's messages don't count against this one.
  assert.equal(firstBreach(rows(10, 'other', 30_000), 'me', rules), null)
})

test('chat windows: 100 a day per address, and the daily message backstop across all addresses', () => {
  const rules = chatRules(NOW, {})
  assert.equal(firstBreach(rows(99, 'me', 2 * HOUR), 'me', rules), null)
  assert.equal(firstBreach(rows(100, 'me', 2 * HOUR), 'me', rules)?.reason, 'ip_per_day')
  // Yesterday (before midnight New York time) doesn't count.
  assert.equal(firstBreach(rows(100, 'me', 13 * HOUR), 'me', rules), null)
  const many = Array.from({ length: LIMIT_DEFAULTS.CHAT_DAILY_MESSAGE_CAP }, (_, i) => ({ createdAt: new Date(NOW.getTime() - HOUR), ipHash: `ip${i}`, chars: 0 }))
  const hit = firstBreach(many, 'me', rules)
  assert.equal(hit?.reason, 'daily_messages')
  assert.equal(hit?.message, DAILY_SPEND_MESSAGE)
  assert.equal(firstBreach(many.slice(1), 'me', rules), null)
  // A raised setting moves the line.
  assert.equal(firstBreach(rows(10, 'me', 30_000), 'me', chatRules(NOW, { CHAT_PER_IP_PER_MINUTE: '20' })), null)
})

test('tts windows: per-address clips an hour, and a daily character budget across all addresses', () => {
  const rules = ttsRules(NOW, {})
  const perHour = LIMIT_DEFAULTS.TTS_PER_IP_PER_HOUR
  assert.equal(firstBreach(rows(perHour - 1, 'me', 10 * MIN, 100), 'me', rules, 100), null)
  assert.equal(firstBreach(rows(perHour, 'me', 10 * MIN, 100), 'me', rules, 100)?.reason, 'ip_per_hour')
  assert.equal(firstBreach(rows(perHour, 'me', 61 * MIN, 100), 'me', rules, 100), null)
  const cap = LIMIT_DEFAULTS.TTS_DAILY_CHAR_CAP
  const spent = [{ createdAt: new Date(NOW.getTime() - 2 * HOUR), ipHash: 'other', chars: cap - 500 }]
  assert.equal(firstBreach(spent, 'me', rules, 500), null, 'exactly at the budget is allowed')
  assert.equal(firstBreach(spent, 'me', rules, 501)?.reason, 'daily_chars')
})

test('transcription windows: 30 an hour per address, and a daily count across all addresses', () => {
  const rules = transcribeRules(NOW, {})
  assert.equal(firstBreach(rows(29, 'me', 5 * MIN), 'me', rules), null)
  assert.equal(firstBreach(rows(30, 'me', 5 * MIN), 'me', rules)?.reason, 'ip_per_hour')
  const many = Array.from({ length: LIMIT_DEFAULTS.TRANSCRIBE_DAILY_CAP }, (_, i) => ({ createdAt: new Date(NOW.getTime() - 3 * HOUR), ipHash: `ip${i}`, chars: 0 }))
  assert.equal(firstBreach(many, 'me', rules)?.reason, 'daily_count')
})

// ── the guards, with an injected store ──────────────────────────────────────

function store(seed: CounterRow[] = [], spentUsd = 0, fail?: 'read' | 'write') {
  const recorded: Array<{ route: string; ipHash: string; chars?: number }> = []
  const refused: Array<{ route: string; reason: string }> = []
  const s: SpendGuardStore = {
    async recentRows(_route, since) {
      if (fail === 'read') throw new Error('db down')
      return seed.filter(r => r.createdAt >= since)
    },
    async chatSpendUsdSince() {
      if (fail === 'read') throw new Error('db down')
      return spentUsd
    },
    async record(route, ipHash, chars) {
      if (fail === 'write') throw new Error('db down')
      recorded.push({ route, ipHash, chars })
    },
    async refused(route, reason) { refused.push({ route, reason }) },
  }
  return { s, recorded, refused }
}

const SALT = { SPEND_GUARD_SALT: 'a-test-salt-that-is-long-enough' }
const req = (ip?: string) => new Request('http://localhost/api/x', { method: 'POST', headers: ip ? { 'x-forwarded-for': ip } : {} })
const ME = hashAddress('203.0.113.7', SALT)

test('guardChat: over the daily dollar cap → 429 with the stock text, nothing recorded, one counts-only refusal', async () => {
  const { s, recorded, refused } = store([], 5.01)
  const res = await guardChat(req('203.0.113.7'), { store: s, now: NOW, env: SALT })
  assert.ok(res)
  assert.equal(res.status, 429)
  const body = await res.json()
  assert.deepEqual(body, { error: 'spend_limit', message: DAILY_SPEND_MESSAGE, response: DAILY_SPEND_MESSAGE })
  assert.equal(DAILY_SPEND_MESSAGE, "Drift's daily spending limit is reached. It resets at midnight.")
  assert.equal(recorded.length, 0)
  assert.deepEqual(refused, [{ route: 'chat', reason: 'daily_usd' }])
})

test('guardChat: under every limit → null, and the request is counted under the hashed address', async () => {
  const { s, recorded, refused } = store([], 4.99)
  assert.equal(await guardChat(req('203.0.113.7'), { store: s, now: NOW, env: SALT }), null)
  assert.deepEqual(recorded, [{ route: 'chat', ipHash: ME, chars: undefined }])
  assert.equal(refused.length, 0)
  assert.ok(!JSON.stringify(recorded).includes('203.0.113.7'))
})

test('guardChat: a message-count backstop and the per-address windows refuse too', async () => {
  const today = (n: number, ipHash: string, ageMs = HOUR) => rows(n, ipHash, ageMs)
  const minute = store(today(10, ME, 20_000))
  const r1 = await guardChat(req('203.0.113.7'), { store: minute.s, now: NOW, env: SALT })
  assert.equal(r1?.status, 429)
  assert.deepEqual(minute.refused, [{ route: 'chat', reason: 'ip_per_minute' }])
  // Another address is still fine.
  assert.equal(await guardChat(req('198.51.100.4'), { store: minute.s, now: NOW, env: SALT }), null)
  // No address at all shares one bucket: it doesn't get around the limit.
  const anon = store(today(10, hashAddress('unknown', SALT), 20_000))
  assert.equal((await guardChat(req(), { store: anon.s, now: NOW, env: SALT }))?.status, 429)
})

test('guardChat: a DB hiccup in the guard lets the message through (Ryan keeps working) and logs it', async () => {
  for (const fail of ['read', 'write'] as const) {
    const { s } = store([], 0, fail)
    const errors: unknown[] = []
    const orig = console.error
    console.error = (...a: unknown[]) => { errors.push(a) }
    try {
      assert.equal(await guardChat(req('203.0.113.7'), { store: s, now: NOW, env: SALT }), null)
    } finally { console.error = orig }
    assert.equal(errors.length, 1)
  }
})

test('guardTts: counts characters (at least a short sentence each) and refuses past the daily budget', async () => {
  const cap = LIMIT_DEFAULTS.TTS_DAILY_CHAR_CAP
  const ok = store()
  assert.equal(await guardTts(req('203.0.113.7'), 'Hi.', { store: ok.s, now: NOW, env: SALT }), null)
  assert.deepEqual(ok.recorded, [{ route: 'tts', ipHash: ME, chars: TTS_MIN_CHARGE }])
  const long = store()
  await guardTts(req('203.0.113.7'), 'x'.repeat(9000), { store: long.s, now: NOW, env: SALT })
  assert.equal(long.recorded[0].chars, 4000, 'the provider reads at most 4,000 characters')
  const full = store([{ createdAt: new Date(NOW.getTime() - HOUR), ipHash: 'other', chars: cap }])
  const res = await guardTts(req('203.0.113.7'), 'One more sentence.', { store: full.s, now: NOW, env: SALT })
  assert.equal(res?.status, 429)
  assert.equal((await res!.json()).error, 'spend_limit')
  assert.deepEqual(full.refused, [{ route: 'tts', reason: 'daily_chars' }])
  assert.equal(full.recorded.length, 0)
})

test('guardTts and guardTranscribe: a DB failure refuses (the cap is all that stands between a stranger and the bill)', async () => {
  for (const fail of ['read', 'write'] as const) {
    const orig = console.error
    console.error = () => {}
    try {
      const t = store([], 0, fail)
      assert.equal((await guardTts(req('203.0.113.7'), 'Hello there.', { store: t.s, now: NOW, env: SALT }))?.status, 429)
      assert.deepEqual(t.refused, [{ route: 'tts', reason: 'guard_unavailable' }])
      const d = store([], 0, fail)
      assert.equal((await guardTranscribe(req('203.0.113.7'), { store: d.s, now: NOW, env: SALT }))?.status, 429)
      assert.deepEqual(d.refused, [{ route: 'transcribe', reason: 'guard_unavailable' }])
    } finally { console.error = orig }
  }
})

test('refusal JSON is plain: no address, no hash, no limit numbers', async () => {
  const res = spendLimitResponse('Try again later.')
  assert.equal(res.status, 429)
  assert.equal(res.headers.get('content-type'), 'application/json')
  assert.deepEqual(await res.json(), { error: 'spend_limit', message: 'Try again later.' })
  assert.equal(SPEND_GUARD_REFUSED, 'SPEND_GUARD_REFUSED')
  // Neither action name may contain "SYNC": the health page's last-sync lookup
  // matches any action containing it.
  assert.ok(!/SYNC/.test(SPEND_GUARD_REFUSED + SPEND_GUARD_REQUEST))
})

// ── reading a capped body ───────────────────────────────────────────────────

function streamOf(totalBytes: number, chunk = 64 * 1024) {
  let sent = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(c) {
      if (sent >= totalBytes) { c.close(); return }
      const n = Math.min(chunk, totalBytes - sent)
      sent += n
      c.enqueue(new Uint8Array(n).fill(65))
    },
  }, { highWaterMark: 0 }) // pull only when read
  return { stream, pulled: () => sent }
}

test('readBodyCapped: a declared length over the cap is refused without reading a byte', async () => {
  const { stream, pulled } = streamOf(3_000_000)
  const r = new Request('http://localhost/x', { method: 'POST', body: stream, headers: { 'content-length': '3000000' }, duplex: 'half' } as RequestInit)
  assert.equal(await readBodyCapped(r, 2_000_000), null)
  assert.equal(pulled(), 0)
})

test('readBodyCapped: an undeclared length stops reading just past the cap', async () => {
  const { stream, pulled } = streamOf(3_000_000)
  const r = new Request('http://localhost/x', { method: 'POST', body: stream, duplex: 'half' } as RequestInit)
  assert.equal(await readBodyCapped(r, 2_000_000), null)
  assert.ok(pulled() < 2_000_000 + 3 * 64 * 1024, `read ${pulled()} bytes`)
})

test('readBodyCapped: a body under the cap comes back whole', async () => {
  const r = new Request('http://localhost/x', { method: 'POST', body: JSON.stringify({ a: 'é'.repeat(10) }) })
  assert.equal(await readBodyCapped(r, 2_000_000), JSON.stringify({ a: 'é'.repeat(10) }))
  assert.equal(await readBodyCapped(new Request('http://localhost/x', { method: 'POST' }), 10), '')
})
