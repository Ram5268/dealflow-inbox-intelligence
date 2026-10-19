import { current, fakePrisma, ORG, countFetches, urlOf } from '../../../../lib/__tests__/pr17FakePrisma' // first: no database client
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'
import { installFakeAiFetch } from '../../../../lib/__tests__/fakeAiFetch'
import { hashAddress, LIMIT_DEFAULTS, SPEND_GUARD_REQUEST, SPEND_GUARD_REFUSED } from '../../../../lib/spendGuard'
import { VOICE_SESSION_ACTION } from '../../../../lib/voice/session'

// Brief 43 PR 17 [engineering precaution] (DealFlow has no login [Ryan,
// 2026-09-24]): the three voice routes (voice mode is on in production)
// refuse before any OpenAI call. Text-to-speech: clips an hour per address and
// a daily character budget. Transcription: a ~2 MB body cap, 30 an hour per
// address, a daily count. Voice sessions: 10 an hour per address inside the
// existing 60 an hour. Fake Prisma, fake AI, network refused.

process.env.NEXT_PUBLIC_VOICE_ENABLED = 'true' // this test process only
const ai = installFakeAiFetch()
const outside = countFetches()
ai.reply(() => ({})) // text-to-speech: any bytes will do
const IP = '203.0.113.7'
const ago = (ms: number) => new Date(Date.now() - ms)
const HOUR = 3_600_000

beforeEach(() => {
  current.fake = fakePrisma()
  ai.requests.length = 0
  outside.length = 0
})

const counter = (route: string, ipHash: string, ageMs: number, chars?: number) => ({
  id: `c_${Math.random()}`, organizationId: ORG, action: SPEND_GUARD_REQUEST, createdAt: ago(ageMs),
  detailsJson: chars == null ? { route, ipHash } : { route, ipHash, chars },
})

function refusals() {
  return current.fake.data.auditLog.filter(r => r.action === SPEND_GUARD_REFUSED).map(r => r.detailsJson)
}
function assertNoAddressStored() {
  assert.ok(!JSON.stringify(current.fake.data.auditLog).includes(IP), 'the address is never stored')
}

// ── /api/tts ────────────────────────────────────────────────────────────────

async function tts(text: string) {
  const { POST } = await import('../../tts/route')
  return POST(new NextRequest('http://localhost/api/tts', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': IP }, body: JSON.stringify({ text }),
  }))
}

test('tts: the daily character budget refuses before any OpenAI call', async () => {
  current.fake.data.auditLog.push(counter('tts', 'someone_else', HOUR, LIMIT_DEFAULTS.TTS_DAILY_CHAR_CAP))
  const res = await tts('Three sellers in Bed-Stuy fit.')
  assert.equal(res.status, 429)
  assert.equal((await res.json()).error, 'spend_limit')
  assert.equal(outside.length, 0, 'no OpenAI call')
  assert.deepEqual(refusals(), [{ route: 'tts', reason: 'daily_chars' }])
})

test('tts: too many clips in an hour from one address refuses before any OpenAI call', async () => {
  const me = hashAddress(IP)
  for (let i = 0; i < LIMIT_DEFAULTS.TTS_PER_IP_PER_HOUR; i++) current.fake.data.auditLog.push(counter('tts', me, 10 * 60_000, 100))
  const res = await tts('Certainly.')
  assert.equal(res.status, 429)
  assert.equal(outside.length, 0)
  assert.deepEqual(refusals(), [{ route: 'tts', reason: 'ip_per_hour' }])
})

test('tts: under the limits it speaks, and the clip is counted with its characters', async () => {
  const res = await tts('Three sellers in Bed-Stuy fit the profile, and the strongest one is a brownstone.')
  assert.equal(res.status, 200)
  assert.equal(ai.requests.length, 1)
  const counted = current.fake.data.auditLog.filter(r => r.action === SPEND_GUARD_REQUEST)
  assert.deepEqual(counted.map(r => r.detailsJson), [{ route: 'tts', ipHash: hashAddress(IP), chars: 100 }])
  assertNoAddressStored()
})

test('tts: a DB failure in the guard refuses (no unguarded speech)', async () => {
  current.fake.failing.add('auditLog.findMany')
  const orig = console.error
  console.error = () => {}
  try {
    const res = await tts('Hello.')
    assert.equal(res.status, 429)
    assert.equal(outside.length, 0)
  } finally { console.error = orig }
})

// ── /api/transcribe ─────────────────────────────────────────────────────────

const audioBody = (bytes: number) => JSON.stringify({ audio: { mimeType: 'audio/webm', content: Buffer.alloc(bytes, 7).toString('base64') } })

async function transcribe(body: BodyInit, headers: Record<string, string> = {}) {
  const { POST } = await import('../../transcribe/route')
  return POST(new NextRequest('http://localhost/api/transcribe', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': IP, ...headers }, body, duplex: 'half',
  } as ConstructorParameters<typeof NextRequest>[1]))
}

test('transcribe: a 3 MB body is refused (413) before reading it or calling OpenAI', async () => {
  const big = audioBody(2_300_000) // ~3.07 MB once base64-encoded
  assert.ok(big.length > 3_000_000)
  const res = await transcribe(big, { 'content-length': String(Buffer.byteLength(big)) })
  assert.equal(res.status, 413)
  assert.equal((await res.json()).error, 'too_large')
  assert.equal(outside.length, 0, 'no OpenAI call')
  assert.deepEqual(refusals(), [{ route: 'transcribe', reason: 'body_too_large' }])
})

test('transcribe: a 3 MB body with no declared length stops being read just past the cap', async () => {
  let pulled = 0
  const total = 3_000_000
  const stream = new ReadableStream<Uint8Array>({
    pull(c) {
      if (pulled >= total) { c.close(); return }
      const n = Math.min(64 * 1024, total - pulled)
      pulled += n
      c.enqueue(new Uint8Array(n).fill(65))
    },
  }, { highWaterMark: 0 })
  const res = await transcribe(stream)
  assert.equal(res.status, 413)
  assert.ok(pulled < LIMIT_DEFAULTS.TRANSCRIBE_MAX_BYTES + 3 * 64 * 1024, `read ${pulled} bytes`)
  assert.equal(outside.length, 0)
})

test('transcribe: 30 an hour per address refuses before any OpenAI call', async () => {
  const me = hashAddress(IP)
  for (let i = 0; i < 30; i++) current.fake.data.auditLog.push(counter('transcribe', me, 5 * 60_000))
  const res = await transcribe(audioBody(20_000))
  assert.equal(res.status, 429)
  assert.equal(outside.length, 0)
  assert.deepEqual(refusals(), [{ route: 'transcribe', reason: 'ip_per_hour' }])
})

// A stub for one OpenAI address (the multipart bodies of transcription and the
// voice handshake aren't JSON, so the shared fake can't answer them).
async function withStub<T>(url: string, answer: () => Response, fn: () => Promise<T>): Promise<T> {
  const before = globalThis.fetch
  globalThis.fetch = (async (input: unknown) => {
    const u = urlOf(input)
    if (u.startsWith('data:')) return new Response('') // the OpenAI SDK's local FormData probe
    outside.push(u)
    if (u !== url) throw new Error(`test: unexpected network call to ${u.split(/[?#]/)[0]}`)
    return answer()
  }) as typeof fetch
  try { return await fn() } finally { globalThis.fetch = before }
}

test('transcribe: a normal dictation (~1 MB) goes through and is counted once', async () => {
  const res = await withStub('https://api.openai.com/v1/audio/transcriptions',
    () => new Response(JSON.stringify({ text: 'two family in bed stuy' }), { status: 200, headers: { 'content-type': 'application/json' } }),
    () => transcribe(audioBody(700_000)))
  assert.equal(res.status, 200)
  assert.equal((await res.json()).transcript, 'two family in bed stuy')
  assert.equal(outside.length, 1)
  const counted = current.fake.data.auditLog.filter(r => r.action === SPEND_GUARD_REQUEST)
  assert.deepEqual(counted.map(r => r.detailsJson), [{ route: 'transcribe', ipHash: hashAddress(IP) }])
  assertNoAddressStored()
})

// ── /api/voice/session ──────────────────────────────────────────────────────

const OFFER = 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\n'
async function session(ip = IP) {
  const { POST } = await import('../session/route')
  return POST(new Request('http://localhost/api/voice/session', {
    method: 'POST', headers: { 'content-type': 'application/sdp', 'x-forwarded-for': ip }, body: OFFER,
  }))
}
const voiceRow = (ipHash: string | null, ageMs: number) => ({
  id: `v_${Math.random()}`, organizationId: ORG, action: VOICE_SESSION_ACTION, createdAt: ago(ageMs),
  ...(ipHash ? { detailsJson: { ipHash } } : {}),
})

test('voice session: the 11th session in an hour from one address → 429 before the OpenAI handshake', async () => {
  for (let i = 0; i < 10; i++) current.fake.data.auditLog.push(voiceRow(hashAddress(IP), 20 * 60_000))
  const res = await session()
  assert.equal(res.status, 429)
  assert.equal((await res.json()).error, 'spend_limit')
  assert.equal(outside.length, 0, 'no handshake')
  assert.deepEqual(refusals(), [{ route: 'voice_session', reason: 'ip_per_hour' }])
  assert.equal(current.fake.data.auditLog.filter(r => r.action === VOICE_SESSION_ACTION).length, 10, 'nothing new logged')
})

test('voice session: another address still gets in, and its session row carries only the hash', async () => {
  for (let i = 0; i < 10; i++) current.fake.data.auditLog.push(voiceRow(hashAddress(IP), 20 * 60_000))
  const res = await withStub('https://api.openai.com/v1/realtime/calls',
    () => new Response('v=0\r\ns=answer\r\n', { status: 201 }),
    () => session('198.51.100.4'))
  assert.equal(res.status, 200)
  assert.equal(outside.length, 1)
  const mine = current.fake.data.auditLog.filter(r => r.action === VOICE_SESSION_ACTION).at(-1)!
  assert.deepEqual(mine.detailsJson, { ipHash: hashAddress('198.51.100.4') })
  assert.ok(!JSON.stringify(current.fake.data.auditLog).includes('198.51.100.4'))
})

test('voice session: the global 60 an hour still applies (older rows without a hash count there only)', async () => {
  for (let i = 0; i < 60; i++) current.fake.data.auditLog.push(voiceRow(null, 10 * 60_000))
  const res = await session()
  assert.equal(res.status, 429)
  assert.equal(outside.length, 0)
})
