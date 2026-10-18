import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'
import { installFakeAiFetch, anthropicText, systemPromptOf } from '../../../../lib/__tests__/fakeAiFetch'

// Ryan's decision, 2026-10-17: saved seller notes may keep these details.
// Buyer-facing text still never names motivation (engineering precaution,
// Brief 41 H7). So an outreach draft for an old or odd Match row whose supply
// side is a seller lead (no matcher writes one; ownerNotesNeverSupply.test.ts)
// is drafted exactly like one for a homeowner: the address or "Homeowner in
// <neighborhood>", "price on request", the homeowner fit line. Runs the real
// route under tsx with stand-ins for Prisma and the model; nothing is sent.

const ai = installFakeAiFetch()
ai.reply(() => anthropicText(JSON.stringify({ body: 'A Park Slope townhouse with four bedrooms. Worth a look?' })))

const lead = {
  id: 'lead-1', category: 'SELLER_LEAD', address: null as string | null, neighborhood: 'Park Slope', borough: 'Brooklyn',
  price: 1_900_000, minPrice: null, maxPrice: null, beds: 4, squareFeet: 2400,
  extractedTitle: 'Estate sale: Park Slope townhouse', sourceBrokerage: 'Example Realty', sourceAgentName: 'Referring Agent',
  availabilityDate: '2026-12-01', isTestData: true,
}
const listing = {
  ...lead, id: 'listing-1', category: 'ACTIVE_SALE_LISTING', price: 1_750_000, extractedTitle: 'Renovated Park Slope 4BR',
  sourceBrokerage: 'Listing Brokerage', sourceAgentName: 'Listing Agent',
}
const buyer = {
  id: 'buyer-1', category: 'BUYER_ISO', extractedTitle: 'Investor buyer', sourceAgentName: 'Buyer Agent', sourceAgentEmail: 'buyer-agent@example.com',
  price: null, minPrice: 1_500_000, maxPrice: 2_000_000, beds: 4, neighborhood: 'Park Slope', isTestData: true,
}
const match = {
  id: 'm1', organizationId: 'org-test', counterpartType: 'opportunity', counterpartId: 'buyer-1',
  reason: 'The executor wants a quick sale; Estate sale townhouse may match ISO (score 90)', opportunityId: 'lead-1', opportunityType: 'opportunity',
}
const opps = new Map<string, Record<string, unknown>>([['lead-1', lead], ['listing-1', listing], ['buyer-1', buyer]])
const audits: unknown[] = []
const pick = (row: Record<string, unknown> | undefined, select?: Record<string, boolean>) =>
  row ? (select ? Object.fromEntries(Object.keys(select).map(k => [k, row[k]])) : row) : null
;(globalThis as unknown as { prisma: unknown }).prisma = {
  match: { findUnique: async () => match },
  extractedOpportunity: {
    findUnique: async ({ where, select }: { where: { id: string }; select?: Record<string, boolean> }) => pick(opps.get(where.id), select),
    findMany: async ({ where }: { where: { id: { in: string[] } } }) => where.id.in.map(id => opps.get(id)).filter(Boolean),
  },
  mojoContact: { findUnique: async () => null, findMany: async () => [] },
  auditLog: { findMany: async () => [], create: async (args: unknown) => { audits.push(args); return {} } },
}

async function draft(supplyId: string) {
  match.opportunityId = supplyId
  const { POST } = await import('../[id]/draft-outreach/route')
  const req = new NextRequest('http://localhost/api/matches/m1/draft-outreach', { method: 'POST', body: JSON.stringify({ channel: 'email' }) })
  const res = await POST(req, { params: Promise.resolve({ id: 'm1' }) })
  assert.equal(res.status, 200)
  return { json: await res.json() as { subject: string; body: string }, prompt: systemPromptOf(ai.requests[ai.requests.length - 1]) }
}

const FORBIDDEN = /(?<!real )estate|executor|probate|divorc|1,900,000|1\.9\s?m|\$1\.9|Example Realty|Referring Agent/i

test("a draft for a seller lead with no address: no title, no price, no reason in the lead's words", async () => {
  lead.address = null
  const { json, prompt } = await draft('lead-1')
  assert.match(prompt, /Property: Homeowner in Park Slope · 4BR · price on request/)
  assert.match(prompt, /Match reason: Fits the buyer's criteria/)
  assert.doesNotMatch(prompt, FORBIDDEN)
  assert.equal(json.subject, 'Homeowner in Park Slope — worth a look?') // the model gave no subject
})

test('a draft for a seller lead with an address names only the address', async () => {
  lead.address = '12 Example St'
  const { json, prompt } = await draft('lead-1')
  assert.match(prompt, /Property: 12 Example St · 4BR · price on request/)
  assert.doesNotMatch(prompt, FORBIDDEN)
  assert.equal(json.subject, '12 Example St — worth a look?')
})

test('a draft for an ordinary listing is unchanged: its title when there is no address, and its asking price', async () => {
  const { json, prompt } = await draft('listing-1')
  assert.match(prompt, /Property: Renovated Park Slope 4BR · 4BR · \$1\.75M/)
  assert.equal(json.subject, 'Renovated Park Slope 4BR — worth a look?')
  assert.equal(audits.length, 3) // every draft's spend is logged
})
