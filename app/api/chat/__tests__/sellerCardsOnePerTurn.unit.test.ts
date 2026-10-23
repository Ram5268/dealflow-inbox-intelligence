import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'
import { makeFakePrisma, contact, ORG_ROW } from '../../../../lib/chat/__tests__/pr5FakePrisma'
import { installFakeAiFetch, anthropicText, openAiChat, type AiRequest } from '../../../../lib/__tests__/fakeAiFetch'

// Brief 43 PR 5 review (D11 [Ryan, 2026-10-18]: Drift never lists CRM sellers;
// one named seller's contact): a surname gives 3 candidates, and the model then
// looks each one up in parallel. The page must still get ONE contact card, not
// three [engineering precaution]. Pure: fake Prisma and AI; fictional names.
const fake = makeFakePrisma({
  organization: [ORG_ROW],
  chatSession: [], chatMessage: [], extractedOpportunity: [], driftInteraction: [], guardFireEvent: [],
  mojoContact: [
    contact({ fullName: 'Casey Sample', address: '12 Sample St' }),
    contact({ fullName: 'Jordan Sample', address: '14 Sample St' }),
    contact({ fullName: 'Robin Sample', address: '16 Sample St' }),
  ],
})
;(globalThis as unknown as { prisma: unknown }).prisma = fake.prisma
const ai = installFakeAiFetch()
const msg = (content: unknown[]) => ({ id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-test', content, stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } })
const tools = (req: AiRequest) => ((req.body.tools as Array<{ name: string }> | undefined) ?? []).map(t => t.name)
let step = 0
ai.reply(req => {
  if (req.url.includes('openai.com')) return openAiChat({})
  if (tools(req).length === 0) return anthropicText('{"isGrounded": true, "flags": []}')
  step++
  if (step === 1) return msg([{ type: 'tool_use', id: 't1', name: 'find_seller', input: { name: 'Sample' } }])
  if (step === 2) return msg(['Casey Sample', 'Jordan Sample', 'Robin Sample'].map((n, i) => ({ type: 'tool_use', id: `t2_${i}`, name: 'find_seller', input: { name: n } })))
  return msg([{ type: 'tool_use', id: 't3', name: 'drift_response', input: { response: "Here's their contact.", suggestions: ['a', 'b'], referencedDeals: [] } }])
})

test('a surname looked up three times in one turn still gives one contact card', async () => {
  const { POST } = await import('../route')
  const res = await POST(new NextRequest('http://localhost/api/chat', { method: 'POST', body: JSON.stringify({ message: "what's the number for the Sample family?" }) }))
  const data = await res.json() as { sellerCards: Array<{ name: string }> }
  assert.equal(res.status, 200)
  assert.equal(data.sellerCards.length, 1, JSON.stringify(data.sellerCards.map(c => c.name)))
  const stored = fake.tables.chatMessage.find(m => m.role === 'assistant')!
  assert.equal((stored.dealsJson as Array<{ kind?: string }>).filter(d => d.kind === 'crm_seller').length, 1)
})
