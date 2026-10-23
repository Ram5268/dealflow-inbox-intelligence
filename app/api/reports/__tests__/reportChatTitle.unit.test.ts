import { current, fakePrisma, type Row } from '../../../../lib/__tests__/pr17FakePrisma' // first: no database client
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'
import { installFakeAiFetch } from '../../../../lib/__tests__/fakeAiFetch'
import { GENERATOR_REGISTRY } from '../../../../lib/reports/generators'
import { getTemplate } from '../../../../lib/reports/templates'

// Brief 43 PR 16 (Q36; N13): a chat started by the + report button has no
// message of Ryan's for the title call to read, so it stayed untitled and kept
// History's retitle call firing on every open. It is now titled from the
// report's template name when the chat is made.

const ai = installFakeAiFetch() // the route makes an Anthropic client; nothing is called
ai.reply(() => { throw new Error('test: no AI call expected') })

GENERATOR_REGISTRY['buyer-match'] = {
  full: async () => ({ subject: 'Jordan Sample', sections: [], markdown: '', sources: [], matchCount: 0 } as never),
  section: async () => { throw new Error('test: not used') },
}

beforeEach(() => {
  current.fake = fakePrisma()
  const reports: Row[] = []
  ;(current.fake.db as unknown as Record<string, unknown>).report = {
    create: async (a: { data: Row }) => { const row = { id: `report_${reports.length + 1}`, createdAt: new Date(), ...a.data }; reports.push(row); return row },
  }
})

async function plusReport(body: Record<string, unknown>) {
  const { POST } = await import('../route')
  const res = await POST(new NextRequest('http://localhost/api/reports', { method: 'POST', body: JSON.stringify(body) }))
  return { status: res.status, body: await res.json() }
}

test('a + report on a fresh chat makes a chat titled from the template name', async () => {
  const { status, body } = await plusReport({ templateId: 'buyer-match', params: { buyerId: 'buyer_1' }, writeToChat: true })
  assert.equal(status, 200)
  const session = current.fake.data.chatSession.find(s => s.id === body.sessionId)
  assert.ok(session)
  assert.equal(session.title, getTemplate('buyer-match')!.name)
})

test('a + report in an existing chat leaves its title alone', async () => {
  current.fake.data.chatSession.push({ id: 's_old', organizationId: 'org_pr17', title: 'Coming Soon Under 2M', archived: false, createdAt: new Date(), updatedAt: new Date() })
  const { body } = await plusReport({ templateId: 'buyer-match', params: { buyerId: 'buyer_1' }, sessionId: 's_old', writeToChat: true })
  assert.equal(body.sessionId, 's_old')
  assert.equal(current.fake.data.chatSession.find(s => s.id === 's_old')?.title, 'Coming Soon Under 2M')
})
