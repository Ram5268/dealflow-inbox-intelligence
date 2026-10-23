import { test } from 'node:test'
import assert from 'node:assert/strict'
import { encodeStoredReply, readStoredReply } from '../storedReply'

// Brief 43 PR 3: a reply with a draft is stored as JSON in ChatMessage.content
// (no migration), the way a calendar proposal already is, and read back for the
// page. Pure, no database.

const draft = { channel: 'text' as const, audience: 'homeowner' as const, body: 'Hi, this is Ryan Martin. Would you ever consider selling?' }

test('a plain reply is stored as its text, exactly as before', () => {
  assert.equal(encodeStoredReply({ response: 'Three listings fit.' }), 'Three listings fit.')
  assert.equal(encodeStoredReply({ response: 'Three listings fit.', pendingEvent: null, draft: null }), 'Three listings fit.')
})

// Brief 43 PR 14 (D7): without the follow-up suggestions.
test('a calendar proposal is stored as before (the confirm path reads it), with no suggestions', () => {
  const pendingEvent = { subject: 'Showing', startISO: '2026-10-20T15:00:00-04:00' }
  assert.equal(
    encodeStoredReply({ response: 'Shall I add it?', pendingEvent }),
    JSON.stringify({ response: 'Shall I add it?', pendingEvent }),
  )
})

test('a reply with a draft is stored as JSON and read back as text plus the draft', () => {
  const stored = encodeStoredReply({ response: "Here's a draft for you to copy.", draft })
  assert.deepEqual(JSON.parse(stored).draft, draft)
  assert.ok(!('suggestions' in JSON.parse(stored)), 'no suggestions (D7)')
  assert.deepEqual(readStoredReply(stored), { response: "Here's a draft for you to copy.", draft })
})

test('reading: plain text, a calendar proposal, and text that only looks like JSON', () => {
  assert.deepEqual(readStoredReply('Three listings fit.'), { response: 'Three listings fit.', draft: null })
  assert.deepEqual(readStoredReply(JSON.stringify({ response: 'Shall I add it?', suggestions: [], pendingEvent: { subject: 's' } })), { response: 'Shall I add it?', draft: null })
  assert.deepEqual(readStoredReply('{not json'), { response: '{not json', draft: null })
  assert.deepEqual(readStoredReply('{"other": 1}'), { response: '{"other": 1}', draft: null })
  assert.deepEqual(readStoredReply(JSON.stringify({ response: 'x', draft: { body: '' } })), { response: 'x', draft: null })
})

// Brief 43 PR 14 (D7): rows saved before the change still read the same way.
test('old rows with suggestions still read as their text and draft', () => {
  assert.deepEqual(readStoredReply(JSON.stringify({ response: 'Old reply.', suggestions: ['Show the near-misses', 'Widen the criteria'] })), { response: 'Old reply.', draft: null })
  assert.deepEqual(readStoredReply(JSON.stringify({ response: 'Old draft.', suggestions: ['a', 'b'], draft })), { response: 'Old draft.', draft })
})
