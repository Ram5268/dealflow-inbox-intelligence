import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  verifyResponse,
  computeCostUsd,
  type VerifierClient,
  type ToolResultForVerify,
} from '../llmVerifier'

// Run: `npm test` (ts-node via node:test). No real API calls — every case
// injects a fake Anthropic client, so this suite is free and deterministic.

// Build a fake client whose messages.create returns the given text + usage.
// Cast through unknown: we only implement the one method verifyResponse uses.
function fakeClient(text: string, tokensIn = 500, tokensOut = 40, throwErr = false): VerifierClient {
  return {
    messages: {
      create: async () => {
        if (throwErr) throw new Error('simulated API failure')
        return {
          content: [{ type: 'text', text }],
          usage: { input_tokens: tokensIn, output_tokens: tokensOut },
        }
      },
    },
  } as unknown as VerifierClient
}

const SEED_TOOL_RESULTS: ToolResultForVerify[] = [
  {
    name: 'search_listings',
    input: { address: '30 Park Pl' },
    output: {
      cards: [
        { id: 'SEED_SALE_20', category: 'ACTIVE_SALE_LISTING', address: '30 Park Pl', price: 15000000, beds: 3, neighborhood: 'Tribeca' },
        { id: 'SEED_RENT_20', category: 'RENTAL_LISTING', address: '30 Park Pl', price: 15000, beds: 3, neighborhood: 'Tribeca' },
      ],
      totalMatched: 2,
    },
  },
]

// ── Grounded response → isGrounded true, no flags ────────────────────────────
test('grounded response passes', async () => {
  const client = fakeClient('{"isGrounded": true, "flags": []}')
  const r = await verifyResponse(
    'what do i have at 30 Park Pl?',
    SEED_TOOL_RESULTS,
    null,
    'You have two at 30 Park Pl: a $15,000,000 sale and a $15,000/mo rental, both 3BR.',
    { client },
  )
  assert.equal(r.isGrounded, true)
  assert.deepEqual(r.flags, [])
  assert.ok(r.costUsd > 0)
})

// ── Ungrounded ACRIS invention → isGrounded false, flags present ─────────────
test('ungrounded ACRIS invention is flagged', async () => {
  const verifierJson = JSON.stringify({
    isGrounded: false,
    flags: [
      { claim: '$6,750,000 on 2026-06-16', reason: 'No ACRIS/sale-history data in tool results.' },
      { claim: 'CONDO 54 PARK PLACE LLC', reason: 'Ownership entity not present in tool results.' },
    ],
  })
  const client = fakeClient(verifierJson)
  const r = await verifyResponse(
    'what do i have at 30 Park Pl?',
    SEED_TOOL_RESULTS,
    null,
    'ACRIS shows last sale $6,750,000 on 2026-06-16 from CONDO 54 PARK PLACE LLC.',
    { client },
  )
  assert.equal(r.isGrounded, false)
  assert.equal(r.flags.length, 2)
  assert.equal(r.flags[0].claim, '$6,750,000 on 2026-06-16')
})

// ── Malformed verifier output → accepted, with a log flag ────────────────────
// Brief 43 PR 10 (Q32) changed this: it used to fail safe to ungrounded, which
// turned a good reply into two paid rewrites and then a stock reply.
test('malformed verifier output is accepted with a log flag', async () => {
  const client = fakeClient('I think this looks mostly fine, no JSON here.')
  const r = await verifyResponse('q', SEED_TOOL_RESULTS, null, 'some response', { client })
  assert.equal(r.isGrounded, true)
  assert.deepEqual(r.flags, [])
  assert.equal(r.error, 'verifier_parse_error')
})

// ── isGrounded:true but flags present → treated as ungrounded (defensive) ─────
test('verifier claiming grounded while listing flags is treated ungrounded', async () => {
  const client = fakeClient('{"isGrounded": true, "flags": [{"claim": "x", "reason": "y"}]}')
  const r = await verifyResponse('q', SEED_TOOL_RESULTS, null, 'resp', { client })
  assert.equal(r.isGrounded, false)
  assert.equal(r.flags.length, 1)
})

// ── Empty response short-circuits to grounded (no client call needed) ────────
test('empty response is trivially grounded', async () => {
  let called = false
  const client = {
    messages: { create: async () => { called = true; return {} as never } },
  } as unknown as VerifierClient
  const r = await verifyResponse('q', [], null, '   ', { client })
  assert.equal(r.isGrounded, true)
  assert.deepEqual(r.flags, [])
  assert.equal(called, false, 'should not call the model for an empty response')
})

// ── API error → accepted with a log flag, no throw (Brief 43 PR 10, Q32) ─────
test('verifier API error is accepted with a log flag', async () => {
  const client = fakeClient('', 0, 0, true)
  const r = await verifyResponse('q', SEED_TOOL_RESULTS, null, 'resp', { client })
  assert.equal(r.isGrounded, true)
  assert.deepEqual(r.flags, [])
  assert.equal(r.error, 'verifier_api_error')
})

// ── Brief 5.1.2 Gate 3, Step 4 — failure-path contracts ──────────────────────
// These pin the runtime behavior the chat route relies on: a verifier that
// returns garbage or throws must NEVER crash the chat route.
// Brief 43 PR 10 (Q32) changed the direction: with no readable verdict the
// reply is accepted (the regex guard has already run on it) and the attempt
// carries `error` for the guard log. A verdict that can still be read, even cut
// off, still decides.

// 4a — verifier returns non-JSON prose → accepted, logged as parse_error.
test('Gate3/4a: malformed non-JSON verifier output → accepted, parse_error logged', async () => {
  const client = fakeClient('this is not JSON')
  const r = await verifyResponse('q', SEED_TOOL_RESULTS, null, 'some candidate response', { client })
  assert.equal(r.isGrounded, true)
  assert.equal(r.flags.length, 0)
  assert.equal(r.error, 'verifier_parse_error')
})

// 4a(ii) — truncated JSON that still says "not grounded" → the second parse
// reads it, so the rewrite still happens (one generic flag: the list was cut).
test('Gate3/4a: truncated "not grounded" JSON → still ungrounded', async () => {
  const client = fakeClient('{"isGrounded": false, "flags": [')
  const r = await verifyResponse('q', SEED_TOOL_RESULTS, null, 'resp', { client })
  assert.equal(r.isGrounded, false)
  assert.equal(r.flags.length, 1)
  assert.equal(r.error, undefined)
})

// 4b — verifier API throws (e.g. rate_limit) → accepted with a log flag, no throw into route.
test('Gate3/4b: verifier API error (rate_limit) → accepted, does not propagate', async () => {
  const throwing = {
    messages: { create: async () => { throw new Error('rate_limit') } },
  } as unknown as VerifierClient
  let threw = false
  let r
  try {
    r = await verifyResponse('q', SEED_TOOL_RESULTS, null, 'resp', { client: throwing })
  } catch {
    threw = true
  }
  assert.equal(threw, false, 'verifyResponse must not propagate the API error')
  assert.equal(r!.isGrounded, true)
  assert.deepEqual(r!.flags, [])
  assert.equal(r!.error, 'verifier_api_error')
})

// ── Cost calc unit test ──────────────────────────────────────────────────────
test('computeCostUsd uses Sonnet 4.6 pricing ($3/M in, $15/M out)', () => {
  // 1M input + 1M output => $3 + $15 = $18
  assert.equal(computeCostUsd(1_000_000, 1_000_000), 18)
  // 500 in + 40 out
  const c = computeCostUsd(500, 40)
  assert.ok(Math.abs(c - (500 / 1e6 * 3 + 40 / 1e6 * 15)) < 1e-12)
})
