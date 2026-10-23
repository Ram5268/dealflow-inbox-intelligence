import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'
import { makeFakePrisma, contact, ORG_ROW, valuationRun, valuation, TARGET_LINE } from '../../../../lib/chat/__tests__/pr12Fixtures'
import { installFakeAiFetch, anthropicTool, anthropicText, openAiChat, type AiRequest } from '../../../../lib/__tests__/fakeAiFetch'

// Brief 43 PR 12 (D9: Brief 42 default D9, restated in Brief 46 §4.2): a whole
// chat turn for "what's Pat Example's house worth?". Drift reads our estimate from
// find_seller and says it, labeled internal; the guard passes it (it came from the
// tool); the seller card the page gets, and the one stored with the reply, carry
// no value of ours [Ryan, 2026-10-17]. Pure: fake Prisma, fake Anthropic and
// OpenAI answers, every other network call refused. Fictional people only.
const fake = makeFakePrisma({
  organization: [ORG_ROW],
  chatSession: [], chatMessage: [], extractedOpportunity: [], driftInteraction: [], guardFireEvent: [],
  mojoContact: [
    contact({ id: 'mc_pat', fullName: 'Pat Example', phone: '7185550142', address: '88 Example Ave', metadata: { source: 'crm', crmLeadId: 'lead_pat' } }),
  ],
  valuationRun: [valuationRun()],
  propertyValuation: [valuation('mc_pat')],
})
;(globalThis as unknown as { prisma: unknown }).prisma = fake.prisma

const ai = installFakeAiFetch()
const toolNamesOf = (req: AiRequest) => ((req.body.tools as Array<{ name: string }> | undefined) ?? []).map(t => t.name)
const lastUserContent = (req: AiRequest) => {
  const msgs = (req.body.messages as Array<{ role: string; content: unknown }> | undefined) ?? []
  return msgs[msgs.length - 1]?.content
}
const toolResultOf = (req: AiRequest) => {
  const last = lastUserContent(req)
  const block = Array.isArray(last) ? last.find(b => (b as { type?: string }).type === 'tool_result') as { content?: string } | undefined : undefined
  return block?.content ?? null
}
ai.reply(req => {
  if (req.url.includes('openai.com')) return openAiChat({})
  if (toolNamesOf(req).length === 0) return anthropicText('{"isGrounded": true, "flags": []}')
  const result = toolResultOf(req)
  if (result == null) return anthropicTool('find_seller', { name: 'Pat Example' })
  // Drift says the line the tool gave it, as the prompt asks.
  const say = (JSON.parse(result) as { match?: { internalEstimate?: { say?: string } | null } }).match?.internalEstimate?.say
  return anthropicTool('drift_response', { response: say ?? "There's no value on file for that home.", suggestions: ['a', 'b'], referencedDeals: [] })
})

test("what's it worth: the estimate in Drift's reply, never on the page's seller card or the stored card", async () => {
  const { POST } = await import('../route')
  const res = await POST(new NextRequest('http://localhost/api/chat', { method: 'POST', body: JSON.stringify({ message: "what's Pat Example's house worth?" }) }))
  const data = await res.json() as Record<string, unknown>
  assert.equal(res.status, 200, JSON.stringify(data))

  // The guard passed the reply (no stock reply): the figures came from the tool.
  assert.equal(data.response, TARGET_LINE)

  // Drift read the line and the figures, but not the run id.
  const afterTool = ai.requests.find(r => toolResultOf(r) != null)!
  const seen = toolResultOf(afterTool)!
  assert.ok(seen.includes(TARGET_LINE))
  assert.ok(!seen.includes('run_oct'))

  // The card the page shows: the contact only.
  const cards = data.sellerCards as Array<Record<string, unknown>>
  assert.equal(cards.length, 1)
  assert.equal(cards[0].name, 'Pat Example')
  assert.ok(!('internalEstimate' in cards[0]))
  assert.ok(!/1830000|1520000|2140000/.test(JSON.stringify(cards)))

  // The stored reply keeps the text (Ryan's own chat) and a card without our value.
  const stored = fake.tables.chatMessage.find(m => m.role === 'assistant')!
  assert.equal(stored.content, TARGET_LINE)
  assert.ok(!/1830000|1520000|2140000|internalEstimate/.test(JSON.stringify(stored.dealsJson)))
})
