import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  handleVoiceSession, MAX_SDP_BYTES, REALTIME_CALLS_URL, SESSIONS_PER_HOUR, transcriptionSession, type VoiceSessionDeps,
} from '../session'

// Run: `npm run test:voice`. Brief 36 — /api/voice/session: flag gate, SDP-only,
// size cap, 60-per-rolling-hour cap, and the key never appears in a response.
// Injected fakes — never touches Prisma or the network.

const KEY = 'sk-test-SECRET-1234567890'
const OFFER = 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\n'
const ANSWER = 'v=0\r\no=- 9 9 IN IP4 10.0.0.1\r\ns=answer\r\n'
const NOW = Date.UTC(2026, 8, 26, 20, 0, 0)

function setup(opts: { enabled?: boolean; recent?: number; upstream?: { status: number; body: string } | Error } = {}) {
  const rec = { counts: [] as Date[], logged: 0, fetches: [] as Array<{ url: string; init: RequestInit }> }
  const deps: VoiceSessionDeps = {
    enabled: opts.enabled ?? true,
    apiKey: KEY,
    now: () => NOW,
    countSessionsSince: async since => { rec.counts.push(since); return opts.recent ?? 0 },
    logSession: async () => { rec.logged++ },
    fetchImpl: (async (url: string, init: RequestInit) => {
      rec.fetches.push({ url, init })
      const up = opts.upstream ?? { status: 201, body: ANSWER }
      if (up instanceof Error) throw up
      return new Response(up.body, { status: up.status })
    }) as unknown as typeof fetch,
  }
  return { deps, rec }
}

const offer = (body = OFFER, type = 'application/sdp') =>
  new Request('http://localhost/api/voice/session', { method: 'POST', headers: { 'Content-Type': type }, body })

async function textOf(res: Response) {
  return `${[...res.headers.entries()].join(';')}\n${await res.text()}`
}

test('flag off → 404 and nothing else happens', async () => {
  const { deps, rec } = setup({ enabled: false })
  const res = await handleVoiceSession(offer(), deps)
  assert.equal(res.status, 404)
  assert.equal(rec.counts.length + rec.logged + rec.fetches.length, 0)
})

test('only application/sdp is accepted', async () => {
  const { deps, rec } = setup()
  for (const type of ['application/json', 'text/plain']) {
    assert.equal((await handleVoiceSession(offer(OFFER, type), deps)).status, 415)
  }
  assert.equal(rec.fetches.length, 0)
})

test('offers over 20 KB (or empty) are rejected before any upstream call', async () => {
  const { deps, rec } = setup()
  assert.equal((await handleVoiceSession(offer('a'.repeat(MAX_SDP_BYTES + 1)), deps)).status, 413)
  assert.equal((await handleVoiceSession(offer('   '), deps)).status, 400)
  assert.equal(rec.logged + rec.fetches.length, 0)
})

test('rate cap: the 61st session in a rolling hour gets 429, nothing logged or forwarded', async () => {
  const { deps, rec } = setup({ recent: SESSIONS_PER_HOUR })
  const res = await handleVoiceSession(offer(), deps)
  assert.equal(res.status, 429)
  assert.equal(rec.counts[0].getTime(), NOW - 3_600_000, 'counts from one hour ago')
  assert.equal(rec.logged + rec.fetches.length, 0)
  const under = setup({ recent: SESSIONS_PER_HOUR - 1 })
  assert.equal((await handleVoiceSession(offer(), under.deps)).status, 200)
  assert.equal(under.rec.logged, 1, 'an allowed session is logged (AuditLog VOICE_SESSION)')
})

test('success: forwards the offer + session config with the key, returns only the SDP answer', async () => {
  const { deps, rec } = setup()
  const res = await handleVoiceSession(offer(), deps)
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'application/sdp')
  const out = await textOf(res)
  assert.ok(out.endsWith(ANSWER))
  assert.ok(!out.includes(KEY))
  const { url, init } = rec.fetches[0]
  assert.equal(url, REALTIME_CALLS_URL)
  assert.equal((init.headers as Record<string, string>).Authorization, `Bearer ${KEY}`)
  const form = init.body as FormData
  assert.equal(form.get('sdp'), OFFER)
  assert.deepEqual(JSON.parse(String(form.get('session'))), transcriptionSession())
})

test('the key never leaks, even when the upstream error echoes it', async () => {
  for (const upstream of [{ status: 401, body: `{"error":{"message":"Incorrect API key provided: ${KEY}"}}` }, new Error(`boom ${KEY}`)]) {
    const { deps } = setup({ upstream })
    const res = await handleVoiceSession(offer(), deps)
    assert.equal(res.status, 502)
    assert.ok(!(await textOf(res)).includes(KEY))
  }
})

test('session config: live transcription, NYC prompt + keywords, no server VAD', () => {
  const s = transcriptionSession()
  const t = s.audio.input.transcription
  assert.equal(s.type, 'transcription')
  assert.equal(t.model, 'gpt-live-transcribe')
  assert.deepEqual(t.languages, ['en'])
  assert.equal(t.delay, 'low')
  assert.ok(t.prompt.startsWith('NYC real estate dictation'))
  assert.ok(t.keywords.includes('Bedford-Stuyvesant') || t.keywords.includes('Bed-Stuy'))
  for (const term of ['two-family', 'three-family', 'duplex', 'triplex', 'co-op', 'condo', 'multifamily']) assert.ok(t.keywords.includes(term))
  assert.equal(s.audio.input.turn_detection, null)
  assert.deepEqual(s.audio.input.noise_reduction, { type: 'near_field' })
})
