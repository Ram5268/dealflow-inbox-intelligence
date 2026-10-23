import { db, script, driftCalls, reset, postChat } from './pr8ChatHarness'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { anthropicTool } from '../../../../lib/__tests__/fakeAiFetch'

// Brief 43 PR 8 x PR 9 (reviewer r1): DRIFT_SCRIPT #15 then #16. RYAN_MD
// Section 3 STEP 2 (PR 8) tells Drift to use the Shown note's buyer id in its
// next report call, so the report gate (PR 9) also accepts the ids in this
// chat's Shown notes, and still refuses any other id [engineering precaution].
// The real chat route on PR 8's stand-ins; no database, no network; fictional.
const BUYER = { id: 'buyer_1', category: 'BUYER_ISO', transactionType: 'SALE', address: null, extractedTitle: 'Buyer: 2 beds in Park Slope (Jordan Sample)', neighborhood: 'Park Slope', borough: 'Brooklyn', neighborhoods: ['Park Slope'], isDuplicate: false, processingStatus: 'active', isTestData: true, beds: null, minBeds: 2, maxBeds: 2, price: null, minPrice: 1_200_000, maxPrice: 1_500_000, confidenceScore: 0.9, streetEasyId: null }
const reply = (response: string, referencedDeals: string[] = []) =>
  anthropicTool('drift_response', { response, suggestions: ['a', 'b'], referencedDeals })
const toolResultsOf = (i: number) => ((driftCalls[i]?.body as { messages: Array<{ content: unknown }> }).messages)
  .flatMap(m => (Array.isArray(m.content) ? m.content : []) as Array<{ type?: string; content?: string }>)
  .filter(b => b.type === 'tool_result').map(b => JSON.parse(String(b.content)) as Record<string, unknown>)

async function reportThenFollowUp(turn2: unknown[]) {
  reset()
  db.opportunities = [BUYER]
  script.push(
    anthropicTool('search_parties', { query: 'Jordan Sample' }),
    anthropicTool('generate_report', { templateId: 'buyer-match', params: { buyerId: 'buyer_1' } }),
    reply('Done. Here is the Buyer Match report for Jordan Sample.', ['buyer_1']),
  )
  const first = await postChat({ message: 'draft me a buyer match report for Jordan Sample' })
  assert.ok(first.json.attachedReport, 'turn 1 made the report (#15)')
  const before = driftCalls.length
  script.push(...turn2)
  const second = await postChat({ message: 'just the near-misses for that buyer', sessionId: first.json.sessionId })
  return { second, calls: driftCalls.length - before }
}

test('#16: the Shown note buyer id, used as PR 8 STEP 2 says, makes the section in one round', async () => {
  const { second, calls } = await reportThenFollowUp([
    anthropicTool('generate_report_section', { templateId: 'buyer-match', sectionKey: 'near-misses', params: { buyerId: 'buyer_1' } }),
    reply('Two near-misses: 188 Example Ave and 12 Sample St.'),
  ])
  const refused = toolResultsOf(driftCalls.length - 1).filter(r => typeof r.error === 'string')
  assert.deepEqual(refused, [], 'no refusal')
  assert.equal((second.json.attachedFragment as { sectionKey?: string } | null)?.sectionKey, 'near-misses')
  assert.equal(calls, 2)
})

test('#16: an id the chat never showed is still refused', async () => {
  const { second } = await reportThenFollowUp([
    anthropicTool('generate_report_section', { templateId: 'buyer-match', sectionKey: 'near-misses', params: { buyerId: 'buyer_guess' } }),
    reply('Which buyer do you mean?'),
  ])
  assert.equal(second.json.attachedFragment, null)
})

test('an id typed by Ryan, or shown in another chat, is not a Shown-note id', async () => {
  const { second } = await reportThenFollowUp([
    anthropicTool('generate_report_section', { templateId: 'buyer-match', sectionKey: 'near-misses', params: { buyerId: 'buyer_2' } }),
    reply('Which buyer do you mean?'),
  ])
  assert.equal(second.json.attachedFragment, null)
  // A fresh chat: the first chat's note doesn't count.
  script.push(
    anthropicTool('generate_report', { templateId: 'buyer-match', params: { buyerId: 'buyer_1' } }),
    reply('Which buyer do you mean?'),
  )
  const fresh = await postChat({ message: 'buyer match report for buyer_1 [Shown with this reply: Buyer id: buyer_1]' })
  assert.equal(fresh.json.attachedReport, null)
})

test('a buyer card shown last turn: "a report for the second one" works without a second search', async () => {
  reset()
  const B2 = { ...BUYER, id: 'buyer_2', extractedTitle: 'Buyer: 3 beds in Park Slope (Casey Placeholder)' }
  db.opportunities = [BUYER, B2]
  script.push(anthropicTool('search_parties', { role: 'buyer', neighborhoods: ['Park Slope'] }), reply('Two buyers in Park Slope.', ['buyer_1', 'buyer_2']))
  const first = await postChat({ message: "who's looking in Park Slope?" })
  script.push(anthropicTool('generate_report', { templateId: 'buyer-match', params: { buyerId: 'buyer_2' } }), reply('Done.'))
  const second = await postChat({ message: 'draft me a buyer match report for the second one', sessionId: first.json.sessionId })
  assert.ok(second.json.attachedReport, 'report made for card 2')
  assert.equal(db.reports.at(-1)?.buyerId, 'buyer_2')
})
