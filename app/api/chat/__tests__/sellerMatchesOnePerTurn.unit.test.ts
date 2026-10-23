import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'
import { makeFakePrisma, contact, match, isoBuyer, ORG_ROW } from '../../../../lib/chat/__tests__/pr6Fixtures'
import { installFakeAiFetch, anthropicText, openAiChat, type AiRequest } from '../../../../lib/__tests__/fakeAiFetch'

// Brief 43 PR 6 review (D11 [Ryan, 2026-10-18]: Drift never lists CRM sellers;
// one named seller): a surname gives 3 candidates, and the model then asks
// get_seller_matches for each of them in parallel. The page must still get ONE
// matches card, and Drift must read only that one seller's address
// [engineering precaution]. Pure: fake Prisma and AI; fictional names.
const fake = makeFakePrisma({
  organization: [ORG_ROW],
  chatSession: [], chatMessage: [], driftInteraction: [], guardFireEvent: [], matchDismissal: [], callQueueEntry: [],
  extractedOpportunity: [isoBuyer({ id: 'iso_1' })],
  mojoContact: [
    contact({ id: 'mc_c', fullName: 'Casey Sample', address: '12 Sample St' }),
    contact({ id: 'mc_j', fullName: 'Jordan Sample', address: '14 Sample St' }),
    contact({ id: 'mc_r', fullName: 'Robin Sample', address: '16 Sample St' }),
  ],
  match: [
    match({ id: 'm_c', opportunityId: 'mc_c', counterpartId: 'iso_1', score: 90, tier: 'HOT' }),
    match({ id: 'm_j', opportunityId: 'mc_j', counterpartId: 'iso_1', score: 80, tier: 'HOT' }),
    match({ id: 'm_r', opportunityId: 'mc_r', counterpartId: 'iso_1', score: 70, tier: 'WARM' }),
  ],
})
;(globalThis as unknown as { prisma: unknown }).prisma = fake.prisma
const ai = installFakeAiFetch()
const msg = (content: unknown[]) => ({ id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-test', content, stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } })
const tools = (req: AiRequest) => ((req.body.tools as Array<{ name: string }> | undefined) ?? []).map(t => t.name)
let step = 0
let toolResultsSeen = ''
ai.reply(req => {
  if (req.url.includes('openai.com')) return openAiChat({})
  if (tools(req).length === 0) return anthropicText('{"isGrounded": true, "flags": []}')
  step++
  if (step === 1) return msg([{ type: 'tool_use', id: 't1', name: 'get_seller_matches', input: { name: 'Sample' } }])
  if (step === 2) return msg(['Casey Sample', 'Jordan Sample', 'Robin Sample'].map((n, i) => ({ type: 'tool_use', id: `t2_${i}`, name: 'get_seller_matches', input: { name: n } })))
  const msgs = (req.body.messages as Array<{ role: string; content: unknown }>)
  toolResultsSeen = JSON.stringify(msgs[msgs.length - 1].content)
  return msg([{ type: 'tool_use', id: 't3', name: 'drift_response', input: { response: 'Three of your sellers have buyers.', suggestions: ['a', 'b'], referencedDeals: [] } }])
})

test('a surname asked three ways in one message still gives one matches card', async () => {
  const { POST } = await import('../route')
  const res = await POST(new NextRequest('http://localhost/api/chat', { method: 'POST', body: JSON.stringify({ message: 'which buyers match the Sample family?' }) }))
  const data = await res.json() as { sellerMatches: Array<{ seller: { name: string } }> }
  assert.equal(res.status, 200)
  assert.equal(data.sellerMatches.length, 1, JSON.stringify(data.sellerMatches.map(c => c.seller.name)))
  const addressesToDrift = ['12 Sample St', '14 Sample St', '16 Sample St'].filter(a => toolResultsSeen.includes(a)).length
  assert.equal(addressesToDrift, 1, 'Drift reads one seller address, not three')
  assert.ok(toolResultsSeen.includes('One seller contact per message'))
  const stored = fake.tables.chatMessage.find(m => m.role === 'assistant')!
  assert.equal((stored.dealsJson as Array<{ kind?: string }>).filter(d => d.kind === 'seller_matches').length, 1)
})
