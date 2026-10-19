import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'
import { makeFakePrisma, contact, match, isoBuyer, ORG_ROW } from '../../../../lib/chat/__tests__/pr6Fixtures'
import { installFakeAiFetch, anthropicTool, anthropicText, openAiChat, type AiRequest } from '../../../../lib/__tests__/fakeAiFetch'

// Brief 43 PR 6 (N1, M-01, S-11): the real chat route with fake Anthropic and
// OpenAI answers. get_seller_matches reaches the page as a structured
// `sellerMatches` card (each buyer with an Open in Matches link), never as a
// link in Drift's text, and is stored with the reply so a reopened chat shows
// it. "Which of my sellers have buyers waiting?" is a count, never a list
// (D14 [Ryan, 2026-10-19]; D11 [Ryan, 2026-10-18]).
const fake = makeFakePrisma({
  organization: [ORG_ROW],
  chatSession: [], chatMessage: [], driftInteraction: [], guardFireEvent: [], matchDismissal: [], callQueueEntry: [],
  extractedOpportunity: [isoBuyer({ id: 'iso_1' }), isoBuyer({ id: 'iso_2', isTestData: false })],
  mojoContact: [
    contact({
      id: 'mc_pat', fullName: 'Pat Example', phone: '7185550142', address: '88 Example Ave', neighborhood: 'Bedford-Stuyvesant',
      metadata: { source: 'crm', crmLeadId: 'lead_pat', lastCallResult: 'Left Message' },
    }),
    contact({ id: 'mc_jordan', fullName: 'Jordan Sample', address: '12 Sample St', neighborhood: 'Crown Heights' }),
  ],
  match: [
    match({ id: 'm_1', opportunityId: 'mc_pat', counterpartId: 'iso_1', score: 91, tier: 'HOT' }),
    match({ id: 'm_2', opportunityId: 'mc_pat', counterpartId: 'iso_2', score: 72, tier: 'WARM' }),
    match({ id: 'm_3', opportunityId: 'mc_jordan', counterpartId: 'iso_1', score: 68, tier: 'WARM' }),
  ],
})
;(globalThis as unknown as { prisma: unknown }).prisma = fake.prisma

const ai = installFakeAiFetch()
const toolNamesOf = (req: AiRequest) => ((req.body.tools as Array<{ name: string }> | undefined) ?? []).map(t => t.name)
const lastUserContent = (req: AiRequest) => {
  const msgs = (req.body.messages as Array<{ role: string; content: unknown }> | undefined) ?? []
  return msgs[msgs.length - 1]?.content
}
const hasToolResult = (req: AiRequest) => {
  const last = lastUserContent(req)
  return Array.isArray(last) && last.some(b => (b as { type?: string }).type === 'tool_result')
}
let script: { tool: string; input: unknown; reply: string } = { tool: '', input: {}, reply: '' }
ai.reply(req => {
  if (req.url.includes('openai.com')) return openAiChat({})
  // The fact-check (no tools): grounded.
  if (toolNamesOf(req).length === 0) return anthropicText('{"isGrounded": true, "flags": []}')
  if (!hasToolResult(req)) return anthropicTool(script.tool, script.input)
  return anthropicTool('drift_response', { response: script.reply, suggestions: ['a', 'b'], referencedDeals: [] })
})

async function ask(message: string) {
  ai.requests.length = 0
  const { POST } = await import('../route')
  const res = await POST(new NextRequest('http://localhost/api/chat', { method: 'POST', body: JSON.stringify({ message }) }))
  const data = await res.json() as Record<string, unknown>
  assert.equal(res.status, 200, JSON.stringify(data))
  const afterTool = ai.requests.find(hasToolResult)!
  return { data, toolResultText: JSON.stringify(lastUserContent(afterTool)), firstTools: toolNamesOf(ai.requests.find(r => toolNamesOf(r).includes('drift_response'))!) }
}

test('get_seller_matches: the route returns sellerMatches, keeps every link out of the text and stores the card', async () => {
  script = { tool: 'get_seller_matches', input: { name: 'Pat Example' }, reply: 'Two buyers match Pat Example: one HOT and one WARM.' }
  const { data, toolResultText, firstTools } = await ask('which buyers match Pat Example?')

  for (const name of ['get_seller_matches', 'count_matches', 'count_sellers_with_buyers', 'find_seller']) assert.ok(firstTools.includes(name), name)

  const cards = data.sellerMatches as Array<Record<string, unknown>>
  assert.equal(cards.length, 1)
  assert.equal(cards[0].kind, 'seller_matches')
  assert.deepEqual(cards[0].seller, {
    kind: 'crm_seller', id: 'mc_pat', name: 'Pat Example', address: '88 Example Ave', neighborhood: 'Bedford-Stuyvesant', doNotContact: false,
  })
  assert.equal(cards[0].count, 2)
  const buyers = cards[0].buyers as Array<Record<string, unknown>>
  assert.deepEqual(buyers.map(b => [b.matchId, b.tier, b.matchesUrl]), [['m_1', 'HOT', '/matches?m=m_1'], ['m_2', 'WARM', '/matches?m=m_2']])
  assert.equal(cards[0].matchesUrl, '/matches?m=m_1')

  // No link in Drift's text, and none in the tool result Drift read.
  assert.equal(data.response, 'Two buyers match Pat Example: one HOT and one WARM.')
  assert.ok(!/https?:\/\/|\/matches/.test(String(data.response)))
  assert.ok(!/https?:|\/matches|m_1/.test(toolResultText), 'no link or match id reaches Drift')
  assert.ok(toolResultText.includes('HOT'))

  // Not a deal card and not a contact card.
  assert.deepEqual(data.deals, [])
  assert.deepEqual(data.sellerCards, [])

  // Stored with the reply (dealsJson, tagged kind seller_matches; no migration).
  const stored = fake.tables.chatMessage.filter(m => m.role === 'assistant').pop()!
  const storedCards = (stored.dealsJson as Array<Record<string, unknown>>).filter(d => d.kind === 'seller_matches')
  assert.equal(storedCards.length, 1)
  assert.deepEqual(storedCards[0], cards[0])
})

test('"which of my sellers have buyers waiting?": counts only, no seller list, no card', async () => {
  script = { tool: 'count_sellers_with_buyers', input: {}, reply: "2 of your sellers have HOT or WARM buyers waiting. They're ranked in your CRM Queue." }
  const { data, toolResultText } = await ask('which of my sellers have buyers waiting?')
  assert.deepEqual(data.sellerMatches, [])
  assert.deepEqual(data.sellerCards, [])
  assert.deepEqual(data.deals, [])
  assert.deepEqual(JSON.parse(JSON.parse(toolResultText)[0].content), { count: 2, withHot: 1 })
  for (const s of ['Pat', 'Jordan', 'Example Ave', 'Sample St', 'mc_', '555']) assert.ok(!toolResultText.includes(s), s)
})

test('count_matches: the real count reaches Drift', async () => {
  script = { tool: 'count_matches', input: { tier: 'WARM' }, reply: 'You have 2 WARM matches.' }
  const { toolResultText } = await ask('how many warm matches do I have?')
  assert.deepEqual(JSON.parse(JSON.parse(toolResultText)[0].content), { tier: 'WARM', count: 2, unseen: 2 })
})
