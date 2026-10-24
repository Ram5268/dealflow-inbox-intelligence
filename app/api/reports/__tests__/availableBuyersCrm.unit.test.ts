// Brief 48 PR 13 (Q8): the + button's buyer list (GET /api/reports/available-buyers)
// lists buyers and renters stored in Ryan's CRM table too, with their match
// counts, so Ryan can make a Buyer Match report for one; never a seller, never
// another organization's. Runs the real route on a stand-in for Prisma that
// evaluates every filter (lib/reports/__tests__/pr13FakePrisma.ts); no database.
// Made-up people only.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeFakePrisma, contact, emailBuyer, listingMatch, ORG_ROW } from '../../../../lib/reports/__tests__/pr13FakePrisma'

const fake = makeFakePrisma({
  organization: [ORG_ROW],
  extractedOpportunity: [emailBuyer({ id: 'email_buyer_1', extractedTitle: 'Example buyer request' })],
  mojoContact: [
    contact({ id: 'crm_buyer_1', intent: 'BUYER', isTestData: true, fullName: 'Pat Example', neighborhood: null,
      initialNeighborhood: 'Crown Heights', bedsMin: 2, bedsMax: 3, budgetMin: 900_000, budgetMax: 1_200_000 }),
    contact({ id: 'crm_renter_1', intent: 'RENTER', isTestData: true, fullName: 'Jordan Sample', neighborhood: 'Crown Heights',
      bedsMin: 1, bedsMax: 1, budgetMax: 3000 }),
    contact({ id: 'crm_seller_1', intent: 'SELLER', fullName: 'Casey Placeholder' }),
    contact({ id: 'crm_buyer_other_org', intent: 'BUYER', organizationId: 'org_other', fullName: 'Alex Fictional' }),
  ],
  match: [
    listingMatch('listing_1', 'crm_buyer_1', { counterpartType: 'mojo', tier: 'HOT' }),
    listingMatch('listing_2', 'crm_buyer_1', { counterpartType: 'mojo', tier: 'WARM' }),
    listingMatch('listing_3', 'email_buyer_1', { counterpartType: 'opportunity', tier: 'HOT' }),
  ],
})
;(globalThis as unknown as { prisma: unknown }).prisma = fake.prisma

test('the buyer list has the CRM buyers and renters, with their match counts', async () => {
  const { GET } = await import('../available-buyers/route')
  const res = await GET()
  assert.equal(res.status, 200)
  const { buyers } = await res.json() as { buyers: Array<{ id: string; displayName: string; criteriaSummary: string; matchCount: Record<string, number> }> }
  const byId = new Map(buyers.map(b => [b.id, b]))
  assert.deepEqual([...byId.keys()].sort(), ['crm_buyer_1', 'crm_renter_1', 'email_buyer_1'])
  const pat = byId.get('crm_buyer_1')!
  assert.equal(pat.displayName, 'Pat Example')
  assert.match(pat.criteriaSummary, /^CRM buyer · 2-3BR · Crown Heights · \$900K-\$1\.2M$/)
  assert.deepEqual(pat.matchCount, { hot: 1, warm: 1, near: 0 })
  assert.match(byId.get('crm_renter_1')!.criteriaSummary, /^CRM renter · 1BR · Crown Heights · \$3K$/)
  // The email buyer's counts come from its own ('opportunity') rows only.
  assert.deepEqual(byId.get('email_buyer_1')!.matchCount, { hot: 1, warm: 0, near: 0 })
})
