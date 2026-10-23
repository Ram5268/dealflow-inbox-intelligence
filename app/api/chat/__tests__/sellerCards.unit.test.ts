import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'
import { makeFakePrisma, contact, ORG_ROW } from '../../../../lib/chat/__tests__/pr5FakePrisma'
import { installFakeAiFetch, anthropicTool, anthropicText, openAiChat, type AiRequest } from '../../../../lib/__tests__/fakeAiFetch'

// Brief 43 PR 5 (D11 [Ryan, 2026-10-18], Q9, Q19): Drift's find_seller result
// reaches the page as structured `sellerCards` (name, phone, address, Open in
// CRM link), never as a URL in Drift's text, and the stored message carries the
// card so a reopened chat shows it again. Pure: fake Prisma, fake Anthropic and
// OpenAI answers, every other network call refused.
const fake = makeFakePrisma({
  organization: [ORG_ROW],
  chatSession: [], chatMessage: [], extractedOpportunity: [], driftInteraction: [], guardFireEvent: [],
  mojoContact: [
    contact({
      id: 'mc_pat', fullName: 'Pat Example', phone: '7185550142', address: '88 Example Ave', neighborhood: 'Bedford-Stuyvesant',
      metadata: { source: 'crm', crmLeadId: 'lead_pat', lastCallResult: 'Left Message' },
    }),
    contact({ fullName: 'Jordan Sample' }),
  ],
})
;(globalThis as unknown as { prisma: unknown }).prisma = fake.prisma

const ai = installFakeAiFetch()
const toolNamesOf = (req: AiRequest) => ((req.body.tools as Array<{ name: string }> | undefined) ?? []).map(t => t.name)
const lastUserContent = (req: AiRequest) => {
  const msgs = (req.body.messages as Array<{ role: string; content: unknown }> | undefined) ?? []
  return msgs[msgs.length - 1]?.content
}
ai.reply(req => {
  if (req.url.includes('openai.com')) return openAiChat({})
  // The fact-check (no tools): grounded.
  if (toolNamesOf(req).length === 0) return anthropicText('{"isGrounded": true, "flags": []}')
  const last = lastUserContent(req)
  const sawToolResult = Array.isArray(last) && last.some(b => (b as { type?: string }).type === 'tool_result')
  if (!sawToolResult) return anthropicTool('find_seller', { name: 'Pat Example' })
  return anthropicTool('drift_response', { response: "Here's their contact.", suggestions: ['a', 'b'], referencedDeals: [] })
})

test('find_seller: the route returns sellerCards, keeps the link out of the text and stores the card with the message', async () => {
  const { POST } = await import('../route')
  const res = await POST(new NextRequest('http://localhost/api/chat', { method: 'POST', body: JSON.stringify({ message: "what's the number for Pat Example?" }) }))
  const data = await res.json() as Record<string, unknown>
  assert.equal(res.status, 200, JSON.stringify(data))

  // Drift was offered the two seller tools.
  const first = ai.requests.find(r => r.url.includes('anthropic.com') && toolNamesOf(r).includes('drift_response'))!
  assert.ok(toolNamesOf(first).includes('find_seller'))
  assert.ok(toolNamesOf(first).includes('count_sellers'))

  // The card, structured.
  const cards = data.sellerCards as Array<Record<string, unknown>>
  assert.equal(cards.length, 1)
  assert.equal(cards[0].kind, 'crm_seller')
  assert.equal(cards[0].name, 'Pat Example')
  assert.equal(cards[0].phone, '(718) 555-0142')
  assert.equal(cards[0].address, '88 Example Ave')
  assert.equal(cards[0].doNotContact, false)
  assert.match(String(cards[0].crmUrl), /\/leads\/lead_pat$/)

  // No URL in Drift's text, and none in the tool result Drift read.
  assert.equal(data.response, "Here's their contact.")
  assert.ok(!/https?:\/\//.test(String(data.response)))
  const afterTool = ai.requests.find(r => {
    const last = lastUserContent(r)
    return Array.isArray(last) && last.some(b => (b as { type?: string }).type === 'tool_result')
  })!
  const toolResultText = JSON.stringify(lastUserContent(afterTool))
  assert.ok(toolResultText.includes('(718) 555-0142'))
  assert.ok(!/https?:/.test(toolResultText), 'the Open in CRM link never reaches Drift')

  // The seller card is not a deal card.
  assert.deepEqual(data.deals, [])

  // A reopened chat shows the card again: it is stored with the reply (dealsJson, tagged kind crm_seller).
  const stored = fake.tables.chatMessage.find(m => m.role === 'assistant')!
  const storedCards = (stored.dealsJson as Array<Record<string, unknown>>).filter(d => d.kind === 'crm_seller')
  assert.equal(storedCards.length, 1)
  assert.equal(storedCards[0].id, 'mc_pat')
  assert.equal(stored.content, "Here's their contact.")
})
