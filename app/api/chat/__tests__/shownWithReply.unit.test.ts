import { db, script, driftCalls, reset, postChat, getChat, postPlusReport, historySent } from './pr8ChatHarness'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { anthropicTool } from '../../../../lib/__tests__/fakeAiFetch'

// Brief 43 PR 8 (Q14; X-01, N13; DRIFT_SCRIPT #5 and #16): what Ryan saw with a
// reply is what Drift remembers next turn. The real chat and "+" report routes,
// with fake Prisma, scripted AI replies and a stand-in report generator; no
// database, no network. Every listing, buyer and name here is fictional.

const SALE = { category: 'COMING_SOON_SALE', transactionType: 'SALE', neighborhood: 'Bedford-Stuyvesant', borough: 'Brooklyn', neighborhoods: [], isDuplicate: false, processingStatus: 'active', isTestData: true, beds: 3, minBeds: null, maxBeds: null, minPrice: null, maxPrice: null, streetEasyId: null }
const LISTINGS = [
  { ...SALE, id: 'opp_188', address: '188 Example Ave', extractedTitle: 'Coming soon: 3-family on Example Ave', price: 1_600_000, confidenceScore: 0.95 },
  { ...SALE, id: 'opp_88', address: '88 Example Ave', extractedTitle: 'Coming soon: 3-family on Example Ave', price: 1_850_000, confidenceScore: 0.9 },
  { ...SALE, id: 'opp_12', address: '12 Sample St', extractedTitle: 'Coming soon: brownstone on Sample St', price: 2_400_000, confidenceScore: 0.8 },
]
const BUYER = { id: 'buyer_1', category: 'BUYER_ISO', transactionType: 'SALE', address: null, extractedTitle: 'Buyer: 2 beds in Park Slope (Jordan Sample)', neighborhood: 'Park Slope', borough: 'Brooklyn', neighborhoods: ['Park Slope'], isDuplicate: false, processingStatus: 'active', isTestData: true, beds: null, minBeds: 2, maxBeds: 2, price: null, minPrice: 1_200_000, maxPrice: 1_500_000, confidenceScore: 0.9, streetEasyId: null }

const reply = (response: string, referencedDeals: string[] = []) =>
  anthropicTool('drift_response', { response, suggestions: ['a', 'b'], referencedDeals })
const ids = (deals: unknown) => (deals as Array<{ id: string }>).map(d => d.id)
const assistantRows = () => db.messages.filter(m => m.role === 'assistant') as Array<{ content: string; dealsJson?: unknown }>
// The reply turns Drift's model saw at the start of the latest turn.
const replyTurnsSent = () => historySent(driftCalls[driftCalls.length - 1]).filter(m => m.role === 'assistant').map(m => String(m.content))

test('#5: the page shows the cards Drift named, in its order, and next turn "the second one" is card 2', async () => {
  reset()
  db.opportunities = [...LISTINGS]
  // Drift found three and named two: 88 first, then 12 (not the match-score order).
  script.push(
    anthropicTool('search_listings', { category: ['COMING_SOON_SALE'], neighborhoods: ['Bedford-Stuyvesant'] }),
    reply('Two coming-soon sales in Bed-Stuy: 88 Example Ave at $1,850,000 and 12 Sample St at $2,400,000.', ['opp_88', 'opp_12']),
  )
  const first = await postChat({ message: 'any coming soon in bedstuy?' })
  assert.equal(first.status, 200)
  assert.deepEqual(ids(first.json.deals), ['opp_88', 'opp_12'])
  // Stored the same way, so a reopened chat shows the same two in the same order.
  assert.deepEqual(ids(assistantRows()[0].dealsJson), ['opp_88', 'opp_12'])
  const { messages } = await getChat(String(first.json.sessionId))
  assert.equal(messages.find(m => m.role === 'assistant')!.content, 'Two coming-soon sales in Bed-Stuy: 88 Example Ave at $1,850,000 and 12 Sample St at $2,400,000.')

  // Next turn: Drift's history holds its reply and the cards Ryan saw, in order.
  script.push(reply('12 Sample St is a brownstone at $2,400,000.', ['opp_12']))
  await postChat({ message: 'tell me more about the second one', sessionId: first.json.sessionId })
  const [shownTurn] = replyTurnsSent()
  assert.match(shownTurn, /^Two coming-soon sales in Bed-Stuy/)
  assert.match(shownTurn, /\[Shown with this reply: 1\) 88 Example Ave, \$1,850,000 \(id opp_88\); 2\) 12 Sample St, \$2,400,000 \(id opp_12\)\]/)
  assert.ok(!shownTurn.includes('"response"'), 'the stored JSON never reaches the model')
  // Card 2 on the page is item 2 in Drift's memory.
  assert.equal(ids(first.json.deals)[1], 'opp_12')
})

test('a reply that names no card shows every card found, best match first, as before', async () => {
  for (const named of [[], ['opp_999']]) {
    reset()
    db.opportunities = [...LISTINGS]
    script.push(anthropicTool('search_listings', { category: ['COMING_SOON_SALE'] }), reply('Three coming-soon sales.', named))
    const { json } = await postChat({ message: 'any coming soon?' })
    assert.deepEqual(ids(json.deals), ['opp_188', 'opp_88', 'opp_12'], JSON.stringify(named))
  }
})

test("Drift's own copy of a Shown note never reaches Ryan", async () => {
  reset()
  db.opportunities = [...LISTINGS]
  script.push(
    anthropicTool('search_listings', { category: ['COMING_SOON_SALE'] }),
    reply('88 Example Ave fits. [Shown with this reply: 1) 88 Example Ave, $1,850,000 (id opp_88)]', ['opp_88']),
  )
  const { json } = await postChat({ message: 'any coming soon?' })
  assert.equal(json.response, '88 Example Ave fits.')
})

test('#15 to #16: after a report from chat, the next turn has the buyer id and the report id', async () => {
  reset()
  db.opportunities = [BUYER, ...LISTINGS]
  script.push(
    anthropicTool('search_parties', { role: 'buyer', neighborhoods: ['Park Slope'] }),
    anthropicTool('generate_report', { templateId: 'buyer-match', params: { buyerId: 'buyer_1' } }),
    reply('Done. Here is the Buyer Match report for Jordan Sample.', ['buyer_1']),
  )
  const first = await postChat({ message: 'draft me a buyer match report for Jordan Sample' })
  assert.equal(first.status, 200)
  const reportId = (first.json.attachedReport as { reportId: string }).reportId
  script.push(reply('Two near-misses for Jordan Sample.'))
  await postChat({ message: 'just the near-misses for that buyer', sessionId: first.json.sessionId })
  const [turn] = replyTurnsSent()
  assert.match(turn, /Buyer id: buyer_1/)
  assert.ok(turn.includes(`Report id: ${reportId}`), turn)
})

test('a report section from chat keeps its buyer id for the next turn', async () => {
  reset()
  db.opportunities = [BUYER]
  script.push(
    anthropicTool('search_parties', { role: 'buyer' }),
    anthropicTool('generate_report_section', { templateId: 'buyer-match', sectionKey: 'near-misses', params: { buyerId: 'buyer_1' } }),
    reply('Two near-misses: 188 Example Ave and 12 Sample St.'),
  )
  const first = await postChat({ message: 'near-misses for the Park Slope buyer' })
  script.push(reply('The curated match is 88 Example Ave.'))
  await postChat({ message: 'and the curated matches for that buyer?', sessionId: first.json.sessionId })
  assert.match(replyTurnsSent()[0], /Buyer id: buyer_1/)
})

test('N13: a chat opened by a "+" report keeps its buyer id and a 3-line summary for the follow-up', async () => {
  reset()
  db.opportunities = [BUYER]
  const plus = await postPlusReport({ templateId: 'buyer-match', params: { buyerId: 'buyer_1' }, writeToChat: true })
  assert.equal(plus.status, 200)
  const sessionId = String(plus.json.sessionId)
  // The page still shows the one line.
  const { messages } = await getChat(sessionId)
  assert.equal(messages[0].content, "Here's the Buyer Match & Search Report for Jordan Sample · 2026-10-19.")

  script.push(reply('Two near-misses for Jordan Sample.'))
  await postChat({ message: 'just the near-misses for that buyer', sessionId })
  const sent = historySent(driftCalls[0])
  // The placeholder user turn still opens the conversation (Brief 41).
  assert.deepEqual(sent[0], { role: 'user', content: '(earlier in this chat)' })
  const turn = String(sent[1].content)
  assert.match(turn, /^Here's the Buyer Match & Search Report for Jordan Sample/)
  assert.match(turn, /Buyer id: buyer_1/)
  assert.ok(turn.includes(`Report id: ${plus.json.reportId}`), turn)
  const summary = turn.slice(turn.indexOf('Report summary:\n') + 'Report summary:\n'.length).replace(/\]$/, '').split('\n')
  assert.deepEqual(summary, [
    'Criteria: Park Slope · 2 beds · $1.2M–$1.5M',
    'Matches this period: 3, Clear fits (HOT): 1, Warm: 2',
    'Curated matches: 1, Near misses: 2',
  ])
  // Counts only past the criteria: no listing or homeowner address rides along.
  assert.ok(!/Example Ave|Sample St/.test(summary.join('\n')))
})

test('older stored replies (plain text, or JSON with no note) still load', async () => {
  reset()
  db.opportunities = [...LISTINGS]
  const at = (s: number) => new Date(Date.UTC(2026, 9, 1, 12, 0, s))
  db.sessions.push({ id: 'sess_old', title: 'Old chat' })
  db.messages.push(
    { id: 'o1', sessionId: 'sess_old', role: 'user', content: 'any coming soon in bedstuy?', createdAt: at(1) },
    { id: 'o2', sessionId: 'sess_old', role: 'assistant', content: 'Two coming-soon sales in Bed-Stuy.', dealsJson: LISTINGS, createdAt: at(2) },
    { id: 'o3', sessionId: 'sess_old', role: 'user', content: 'draft a text to the buyer agent', createdAt: at(3) },
    { id: 'o4', sessionId: 'sess_old', role: 'assistant', content: JSON.stringify({ response: "Here's a draft.", suggestions: [], draft: { channel: 'text', audience: 'buyer_side', body: 'Hi, a 3-family in Bed-Stuy may suit your buyer. Ryan Martin' } }), createdAt: at(4) },
  )
  script.push(reply('Sure.'))
  const { status } = await postChat({ message: 'thanks', sessionId: 'sess_old' })
  assert.equal(status, 200)
  const turns = replyTurnsSent()
  assert.deepEqual(turns[0], 'Two coming-soon sales in Bed-Stuy.') // no note: its order isn't known
  assert.match(turns[1], /^Here's a draft\.\n\nDraft \(text, buyer_side\):\nHi, a 3-family/)
  assert.ok(!turns.some(t => t.includes('[Shown')))
  const { messages } = await getChat('sess_old')
  assert.deepEqual(messages.filter(m => m.role === 'assistant').slice(0, 2).map(m => m.content), ['Two coming-soon sales in Bed-Stuy.', "Here's a draft."])
})
