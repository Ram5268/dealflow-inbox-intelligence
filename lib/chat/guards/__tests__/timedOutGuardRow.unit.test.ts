// Brief 43 PR 4 (Q4; Z-05): a turn that runs out of time writes one guard-log
// row with a 'timeout' verdict, counts only. A stand-in Prisma records the row.
import { test } from 'node:test'
import assert from 'node:assert/strict'

const created: Array<Record<string, unknown>> = []
;(globalThis as unknown as { prisma: unknown }).prisma = {
  guardFireEvent: { create: async ({ data }: { data: Record<string, unknown> }) => { created.push(data); return data } },
}

test('the timeout row: verdict, counts and timing, no message text', async () => {
  const { timedOutGuardInput, logGuardFireEvent } = await import('../instrumentation')
  // The route's allToolCalls shape: inputs and card ids too, which the row leaves out.
  const toolCalls = [
    { name: 'search_listings', input: { neighborhoods: ['Bedford-Stuyvesant'] }, totalMatched: 4, cardIds: ['a', 'b'] },
    { name: 'search_parties', input: { name: 'Pat Example' }, totalMatched: 0, cardIds: [] },
  ]
  const input = timedOutGuardInput({
    organizationId: 'org-test',
    sessionId: null,
    elapsedMs: 52_100,
    toolCalls,
    finalResponseSent: "I couldn't finish that; try a narrower question.",
  })
  await logGuardFireEvent(input)
  assert.equal(created.length, 1)
  const row = created[0]
  assert.equal(row.verifierVerdict, 'timeout')
  assert.equal(row.sessionId, '', 'no chat was saved')
  assert.equal(row.userTurn, '')
  assert.equal(row.assistantAttempt, '')
  assert.equal(row.priorAssistantTurn, null)
  assert.deepEqual(row.toolCallsAttempted, [
    { name: 'search_listings', totalMatched: 4 },
    { name: 'search_parties', totalMatched: 0 },
  ])
  assert.doesNotMatch(JSON.stringify(row), /Pat Example|Bedford/, 'no tool inputs')
  assert.equal(row.verifierReason, 'timed out after 52.1 s with 2 tool calls')
  assert.equal(row.finalResponseSent, "I couldn't finish that; try a narrower question.")
})

test('a normal row still derives its verdict from the guard telemetry', async () => {
  const { logGuardFireEvent } = await import('../instrumentation')
  created.length = 0
  await logGuardFireEvent({
    organizationId: 'org-test', sessionId: 'chat-1', userTurn: 'hey', priorAssistantTurn: null, assistantAttempt: 'Hello.',
    toolCallsAttempted: [], finalResponseSent: 'Hello.',
    telemetry: { enabled: true, finalAttempt: 0, fellbackToCanned: false, history: [], totalVerifierCostUsd: 0 },
  })
  assert.equal(created[0].verifierVerdict, 'pass')
  assert.equal(created[0].sessionId, 'chat-1')
})
