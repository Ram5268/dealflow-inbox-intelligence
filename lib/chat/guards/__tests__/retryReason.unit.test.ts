// Brief 43 PR 15 (Q35; Brief 42 Z-05, Y-02): a guard retry records why it
// retried. The reason used to come from the final attempt, which is clean on a
// successful retry, so all 44 retries in Stage 1's newest 500 logged turns had
// an empty reason. Brief 46 drift-2 probe p6 as a regression. A stand-in Prisma
// records the row; nothing leaves this process.
import { test } from 'node:test'
import assert from 'node:assert/strict'

const created: Array<Record<string, unknown>> = []
;(globalThis as unknown as { prisma: unknown }).prisma = {
  guardFireEvent: { create: async ({ data }: { data: Record<string, unknown> }) => { created.push(data); return data } },
}

const twoAttempts = {
  enabled: true, finalAttempt: 1, fellbackToCanned: false, totalVerifierCostUsd: 0,
  history: [
    { attempt: 0, regexFlags: [{ pattern: 'ownership_assertion', match: 'owner is' }], verifierFlags: [], verifierCost: 0 },
    { attempt: 1, regexFlags: [], verifierFlags: [], verifierCost: 0 },
  ],
}

test('a retry that ended clean keeps the first flagged attempt\'s reason', async () => {
  const { deriveVerdict, summarizeReason, logGuardFireEvent } = await import('../instrumentation')
  assert.equal(deriveVerdict(twoAttempts), 'retry')
  assert.equal(summarizeReason(twoAttempts), "Structural: 'owner is' (ownership_assertion)")
  created.length = 0
  await logGuardFireEvent({
    organizationId: 'org-test', sessionId: 'sess-test', userTurn: 'who owns 88 Example Ave?', priorAssistantTurn: null,
    assistantAttempt: 'The owner is Pat Example.', toolCallsAttempted: [], telemetry: twoAttempts, finalResponseSent: 'I can look that up.',
  })
  assert.equal(created[0].verifierVerdict, 'retry')
  assert.equal(created[0].verifierReason, "Structural: 'owner is' (ownership_assertion)")
})

test('the first flagged attempt wins over a later one; a fact-check flag is a reason too', async () => {
  const { summarizeReason } = await import('../instrumentation')
  const t = {
    ...twoAttempts, finalAttempt: 2, fellbackToCanned: true,
    history: [
      { attempt: 0, regexFlags: [], verifierFlags: [{ claim: '2,400 sq ft', reason: 'not in the tool results' }], verifierCost: 0.01 },
      { attempt: 1, regexFlags: [{ pattern: 'external_url', match: 'https://example.com' }], verifierFlags: [], verifierCost: 0.01 },
      { attempt: 2, regexFlags: [{ pattern: 'external_url', match: 'https://example.com' }], verifierFlags: [], verifierCost: 0.01 },
    ],
  }
  assert.equal(summarizeReason(t), "Semantic: '2,400 sq ft' — not in the tool results")
})

test('a clean pass still has no reason', async () => {
  const { summarizeReason } = await import('../instrumentation')
  assert.equal(summarizeReason({ ...twoAttempts, finalAttempt: 0, history: [twoAttempts.history[1]] }), '')
  assert.equal(summarizeReason({ ...twoAttempts, finalAttempt: 0, history: [] }), '')
})

test('the guard row logs live StreetEasy searches as counts only', async () => {
  const { streetEasyLog, timedOutGuardInput } = await import('../instrumentation')
  assert.deepEqual(streetEasyLog(0, 0), [])
  assert.deepEqual(streetEasyLog(1, 12), [{ name: 'streeteasy_search', searches: 1, listings: 12 }])
  const row = timedOutGuardInput({
    organizationId: 'org-test', sessionId: null, elapsedMs: 52_000, toolCalls: [{ name: 'search_listings', totalMatched: 3 }],
    finalResponseSent: 'x', streetEasy: { searches: 1, listings: 0 },
  })
  assert.deepEqual(row.toolCallsAttempted, [{ name: 'search_listings', totalMatched: 3 }, { name: 'streeteasy_search', searches: 1, listings: 0 }])
  assert.match(String(row.reason), /with 1 tool call$/, 'a StreetEasy search is not a tool call')
})
