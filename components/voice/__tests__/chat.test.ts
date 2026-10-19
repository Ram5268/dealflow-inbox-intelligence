import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CHAT_FAILED, CHAT_OFFLINE, sendVoiceTurn, type SessionRef } from '../chat'

// Run: `npm run test:voice`. Brief 36 — the stale-sessionId fix: the session a
// fresh chat's first voice turn creates is reused by every later turn (the old
// voice mode sent sessionId: null each time and opened a new session per turn).
// Also: errors are reported, never spoken.

type Call = { url: string; body: Record<string, unknown> }

function fakeFetch(responses: Array<{ status?: number; json: object } | Error>) {
  const calls: Call[] = []
  const impl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init?.body)) })
    const next = responses.shift()
    if (!next) throw new Error('no more responses')
    if (next instanceof Error) throw next
    return new Response(JSON.stringify(next.json), { status: next.status ?? 200 })
  }) as unknown as typeof fetch
  return { impl, calls }
}

test('every turn reuses the latest sessionId (fresh chat)', async () => {
  const session: SessionRef = { current: null }
  const { impl, calls } = fakeFetch([
    { json: { sessionId: 'sess-new', interactionId: 'i1', response: 'Certainly. Two sellers fit.' } },
    { json: { sessionId: 'sess-new', interactionId: 'i2', response: 'The brownstone.' } },
    { json: { sessionId: 'sess-new', interactionId: 'i3', response: 'Done.' } },
  ])
  await sendVoiceTurn('any sellers in bed-stuy?', session, impl)
  await sendVoiceTurn('which is strongest?', session, impl)
  await sendVoiceTurn('thanks', session, impl)
  assert.deepEqual(calls.map(c => c.body.sessionId), [null, 'sess-new', 'sess-new'])
  assert.equal(session.current, 'sess-new')
  assert.ok(calls.every(c => c.url === '/api/chat' && c.body.voice === true))
})

test('an existing session is used from the first turn', async () => {
  const session: SessionRef = { current: 'sess-1' }
  const { impl, calls } = fakeFetch([{ json: { sessionId: 'sess-1', interactionId: 'i1', response: 'Right away.' } }])
  const r = await sendVoiceTurn('pull those', session, impl)
  assert.deepEqual(r, { ok: true, text: 'Right away.', interactionId: 'i1' })
  assert.equal(calls[0].body.sessionId, 'sess-1')
})

test('the calendar-confirm reply has no interactionId → null (thumbs hidden)', async () => {
  const { impl } = fakeFetch([{ json: { sessionId: 's', response: 'Added to your calendar.', deals: [], suggestions: [] } }])
  assert.deepEqual(await sendVoiceTurn('yes', { current: 's' }, impl), { ok: true, text: 'Added to your calendar.', interactionId: null })
})

test('server errors are never spoken, even with a response body', async () => {
  const session: SessionRef = { current: 's' }
  const { impl } = fakeFetch([
    { status: 500, json: { error: 'Error: boom', response: 'Server error: Error: boom' } },
    { json: { sessionId: 's', response: 'Server error: something' } },
    { json: { sessionId: 's', response: '   ' } },
  ])
  for (let i = 0; i < 3; i++) assert.deepEqual(await sendVoiceTurn('hi', session, impl), { ok: false, error: CHAT_FAILED })
})

test('network failure → offline error; the session is kept', async () => {
  const session: SessionRef = { current: 's' }
  const { impl } = fakeFetch([new TypeError('Failed to fetch')])
  assert.deepEqual(await sendVoiceTurn('hi', session, impl), { ok: false, error: CHAT_OFFLINE })
  assert.equal(session.current, 's')
})

test('a spending-limit refusal shows its own words (it says what to do)', async () => {
  const { impl } = fakeFetch([{ status: 429, json: { error: 'spend_limit', message: "Drift's daily spending limit is reached. It resets at midnight.", response: "Drift's daily spending limit is reached. It resets at midnight." } }])
  assert.deepEqual(await sendVoiceTurn('hi', { current: 's' }, impl), { ok: false, error: "Drift's daily spending limit is reached. It resets at midnight." })
})
