import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'crypto'
import {
  CLOCK_SKEW_MS, MAX_LEADS_PER_REQUEST, SCORE_WINDOW_MS, checkImportBatch, parseScoreImportBody, sha256Hex, tokenMatches,
  type ImportBatchState,
} from '../request'

// Brief 45 (PR E): POST /api/crm/score-import's body check and the one-time
// token handshake with the CRM (CONTRACT §7). No database.

const TOKEN = crypto.randomBytes(32).toString('base64url')
const ids = (n: number) => Array.from({ length: n }, (_, i) => `lead_${i}`)
const body = (over: Record<string, unknown> = {}) => ({ importId: 'imp_1', token: TOKEN, leadIds: ['lead_a'], ...over })

test('a 32-byte base64url token is 43 characters (what the CRM sends)', () => {
  assert.equal(TOKEN.length, 43)
  assert.ok(parseScoreImportBody(body()))
})

test('chunking: 1 to 500 lead ids pass; 0, 501 and duplicates are refused', () => {
  assert.equal(MAX_LEADS_PER_REQUEST, 500)
  assert.equal(parseScoreImportBody(body({ leadIds: [] })), null)
  assert.deepEqual(parseScoreImportBody(body({ leadIds: ids(1) }))?.leadIds, ['lead_0'])
  assert.equal(parseScoreImportBody(body({ leadIds: ids(500) }))?.leadIds.length, 500)
  assert.equal(parseScoreImportBody(body({ leadIds: ids(501) })), null)
  assert.equal(parseScoreImportBody(body({ leadIds: ['lead_a', 'lead_b', 'lead_a'] })), null)
})

test('ids and the token must have the stated shape; anything else is refused', () => {
  for (const bad of [
    null, 'x', [], {}, body({ importId: '' }), body({ importId: 'a'.repeat(65) }), body({ importId: "imp'1" }), body({ importId: 7 }),
    body({ token: TOKEN.slice(1) }), body({ token: TOKEN + 'A' }), body({ token: TOKEN.slice(0, 42) + '=' }), body({ token: undefined }),
    body({ leadIds: 'lead_a' }), body({ leadIds: ['lead a'] }), body({ leadIds: ['a'.repeat(65)] }), body({ leadIds: [''] }), body({ leadIds: [1] }),
    body({ extra: true }), // the contract's three fields, nothing else
  ]) assert.equal(parseScoreImportBody(bad), null, JSON.stringify(bad))
  assert.ok(parseScoreImportBody(body({ importId: 'cmabc_DEF-123', leadIds: ['cm_x-1', 'a'.repeat(64)] })))
})

test('token check: SHA-256 of the token against the stored hash, in constant time', () => {
  const stored = sha256Hex(TOKEN)
  assert.match(stored, /^[0-9a-f]{64}$/)
  assert.equal(stored, crypto.createHash('sha256').update(TOKEN).digest('hex'))
  assert.equal(tokenMatches(TOKEN, stored), true) // right token
  assert.equal(tokenMatches(TOKEN, stored.toUpperCase()), true) // hex case doesn't matter
  assert.equal(tokenMatches(crypto.randomBytes(32).toString('base64url'), stored), false) // wrong token
  assert.equal(tokenMatches(TOKEN, stored.slice(2)), false) // stored hash of the wrong length
  assert.equal(tokenMatches(TOKEN, stored + '00'), false)
  assert.equal(tokenMatches(TOKEN, 'z'.repeat(64)), false) // not hex
  assert.equal(tokenMatches(TOKEN, null), false) // no stored hash
  assert.equal(tokenMatches(TOKEN, ''), false)
  assert.equal(tokenMatches(TOKEN, TOKEN), false) // the raw token is never accepted as its own hash
})

test('the comparison goes through crypto.timingSafeEqual on two 32-byte digests', () => {
  const real = crypto.timingSafeEqual
  const seen: number[][] = []
  ;(crypto as { timingSafeEqual: typeof real }).timingSafeEqual = (a, b) => { seen.push([a.byteLength, b.byteLength]); return real(a, b) }
  try {
    tokenMatches(TOKEN, sha256Hex(TOKEN))
    tokenMatches('B'.repeat(43), sha256Hex(TOKEN))
  } finally {
    ;(crypto as { timingSafeEqual: typeof real }).timingSafeEqual = real
  }
  assert.deepEqual(seen, [[32, 32], [32, 32]])
})

const NOW = new Date('2026-10-18T19:00:00.000Z')
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000)
const batch = (over: Partial<ImportBatchState> = {}): ImportBatchState => ({
  orgSlug: 'dealflow-ryan', status: 'completed', completedAt: minutesAgo(5), tokenHash: sha256Hex(TOKEN), scoredAt: null, ...over,
})
const check = (b: ImportBatchState | null, token = TOKEN) => checkImportBatch(b, token, NOW)

test('a completed, unscored import with the right token, finished under 60 minutes ago, is accepted', () => {
  assert.equal(check(batch()), null)
})

test('404 not_found: an unknown import, or one in another organization', () => {
  assert.deepEqual(check(null), { status: 404, error: 'not_found' })
  assert.deepEqual(check(batch({ orgSlug: 'another-org' })), { status: 404, error: 'not_found' })
})

test('403 bad_token: a wrong token or no stored hash, checked before any state is revealed', () => {
  const wrong = crypto.randomBytes(32).toString('base64url')
  assert.deepEqual(check(batch(), wrong), { status: 403, error: 'bad_token' })
  assert.deepEqual(check(batch({ tokenHash: null })), { status: 403, error: 'bad_token' })
  // Every state problem at once: the wrong token still only learns bad_token.
  const everything = batch({ status: 'importing', completedAt: minutesAgo(600), scoredAt: minutesAgo(1) })
  assert.deepEqual(check(everything, wrong), { status: 403, error: 'bad_token' })
  assert.deepEqual(check(batch({ ...everything, tokenHash: null })), { status: 403, error: 'bad_token' })
})

test('403 states, in order: not_completed, then expired, then already_scored', () => {
  assert.deepEqual(check(batch({ status: 'importing' })), { status: 403, error: 'not_completed' })
  assert.deepEqual(check(batch({ status: 'pending', completedAt: null })), { status: 403, error: 'not_completed' })
  assert.deepEqual(check(batch({ status: 'importing', completedAt: minutesAgo(600), scoredAt: NOW })), { status: 403, error: 'not_completed' })
  assert.deepEqual(check(batch({ completedAt: minutesAgo(61), scoredAt: NOW })), { status: 403, error: 'expired' })
  assert.deepEqual(check(batch({ scoredAt: minutesAgo(1) })), { status: 403, error: 'already_scored' })
})

test('expired at the 60-minute boundary: under 60 minutes is fine, 60 minutes or more is not', () => {
  assert.equal(SCORE_WINDOW_MS, 60 * 60_000)
  assert.equal(check(batch({ completedAt: new Date(NOW.getTime() - SCORE_WINDOW_MS + 1) })), null)
  assert.deepEqual(check(batch({ completedAt: new Date(NOW.getTime() - SCORE_WINDOW_MS) })), { status: 403, error: 'expired' })
  assert.deepEqual(check(batch({ completedAt: new Date(NOW.getTime() - SCORE_WINDOW_MS - 1) })), { status: 403, error: 'expired' })
  // A completed import with no completion time can't be shown to be recent.
  assert.deepEqual(check(batch({ completedAt: null })), { status: 403, error: 'expired' })
  // A clock a little ahead on the CRM's side is still "recent".
  assert.equal(check(batch({ completedAt: new Date(NOW.getTime() + 30_000) })), null)
})

test('a completion time more than 5 minutes in the future is expired (clock skew allowance)', () => {
  assert.equal(CLOCK_SKEW_MS, 5 * 60_000)
  const ahead = (ms: number) => batch({ completedAt: new Date(NOW.getTime() + ms) })
  assert.equal(check(ahead(CLOCK_SKEW_MS)), null)
  assert.deepEqual(check(ahead(CLOCK_SKEW_MS + 1)), { status: 403, error: 'expired' })
  assert.deepEqual(check(ahead(24 * 60 * 60_000)), { status: 403, error: 'expired' })
  // Still checked after the token: a wrong token learns only bad_token.
  assert.deepEqual(check(ahead(24 * 60 * 60_000), 'B'.repeat(43)), { status: 403, error: 'bad_token' })
})
