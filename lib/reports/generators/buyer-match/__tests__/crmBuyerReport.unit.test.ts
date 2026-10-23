// Brief 48 PR 13 (Q8; TEST_PLAN B-01, M-02, R-01): a buyer stored in Ryan's
// CRM table (a MojoContact with intent BUYER or RENTER, which nightly matching
// already uses as demand, and which Drift's search_parties returns since Brief
// 43 PR 5) couldn't get a Buyer Match report: the report only read email buyers,
// so it failed "not found". It now reads both.
// The real report loader and sections run on a stand-in for Prisma that
// evaluates every filter (pr13FakePrisma.ts); no database, no network, no
// model. Made-up people and places only.
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import type { PrismaClient } from '@prisma/client'
import { makeFakePrisma, contact, emailListing, listingMatch } from '../../../__tests__/pr13FakePrisma'
import { gatherContext } from '../context'
import { generateBuyerMatchReport } from '../index'

const crmBuyer = contact({
  id: 'crm_buyer_1', intent: 'BUYER', isTestData: true, fullName: 'Pat Example', phone: '7185550142',
  email: 'pat@example.test', address: null, neighborhood: null, initialNeighborhood: 'Crown Heights',
  bedsMin: 2, bedsMax: 3, budgetMin: 900_000, budgetMax: 1_200_000, timing: '3 to 6 months',
  notes: 'Called twice, prefers texts after 6pm', metadata: { source: 'csv' },
})
const crmRenter = contact({
  id: 'crm_renter_1', intent: 'RENTER', isTestData: true, fullName: 'Jordan Sample', neighborhood: 'Crown Heights',
  bedsMin: 1, bedsMax: 1, budgetMin: null, budgetMax: 3000, notes: null, metadata: { source: 'csv' },
})
const crmSeller = contact({ id: 'crm_seller_1', intent: 'SELLER', fullName: 'Casey Placeholder' })
const realCrmBuyer = contact({ id: 'crm_buyer_real', intent: 'BUYER', isTestData: false, fullName: 'Robin Sample', initialNeighborhood: 'Crown Heights', budgetMax: 1_000_000 })
const home = emailListing({ id: 'listing_ch', address: '41 Example Pl', neighborhood: 'Crown Heights', price: 1_100_000, beds: 3 })
const flat = emailListing({ id: 'rental_ch', category: 'RENTAL_LISTING', address: '9 Example Pl', neighborhood: 'Crown Heights', price: 2_800, beds: 1 })

const fake = makeFakePrisma({
  extractedOpportunity: [home, flat],
  mojoContact: [crmBuyer, crmRenter, crmSeller, realCrmBuyer],
  match: [
    // Nightly-style rows put a CRM buyer on the counterpart side as 'mojo'.
    listingMatch('listing_ch', 'crm_buyer_1', { counterpartType: 'mojo', tier: 'HOT' }),
    listingMatch('rental_ch', 'crm_renter_1', { counterpartType: 'mojo', tier: 'HOT' }),
    // An email buyer that happens to share the id must not be read as this one.
    listingMatch('rental_ch', 'crm_buyer_1', { counterpartType: 'opportunity', tier: 'HOT' }),
  ],
  matchDismissal: [],
})
const prisma = fake.prisma as unknown as PrismaClient

afterEach(() => { delete process.env.TEST_MODE_ONLY })

test('a CRM buyer gets a Buyer Match report from its own matches', async () => {
  const report = await generateBuyerMatchReport({ buyerId: 'crm_buyer_1', prisma })
  assert.match(report.subject, /^Pat Example — \d{4}-\d{2}-\d{2}$/)
  const criteria = report.sections.find(s => s.key === 'criteria')!
  assert.match(criteria.content.prose ?? '', /Pat Example is looking in Crown Heights for 2–3BR at \$900,000–\$1,200,000\./)
  assert.match(criteria.content.prose ?? '', /Timeline: 3 to 6 months\./)
  const curated = report.sections.find(s => s.key === 'curated-matches')!
  assert.deepEqual((curated.content.items ?? []).map(i => i.listingId), ['listing_ch'], "its 'mojo' rows only")
  assert.equal(report.matchCount, 1)
})

test("a CRM buyer's call notes, phone and email never reach the report", async () => {
  const report = await generateBuyerMatchReport({ buyerId: 'crm_buyer_1', prisma })
  const all = JSON.stringify(report)
  assert.doesNotMatch(all, /Called twice|texts after|555-?0142|7185550142|pat@example/i)
})

test('a CRM renter is read as a renter', async () => {
  const ctx = await gatherContext({ buyerId: 'crm_renter_1', prisma })
  assert.equal(ctx.buyer.category, 'RENTER_INQUIRY')
  assert.equal(ctx.buyer.maxPrice, 3000)
  assert.deepEqual((await ctx.matches()).map(m => m.listing.id), ['rental_ch'])
})

test("a CRM seller is refused, and the error doesn't name them", async () => {
  await assert.rejects(gatherContext({ buyerId: 'crm_seller_1', prisma }), (e: Error) => {
    assert.match(e.message, /not a buyer or renter/)
    assert.doesNotMatch(e.message, /Casey|Placeholder/)
    return true
  })
  await assert.rejects(gatherContext({ buyerId: 'nobody', prisma }), /not found/)
})

test('in test mode, a real CRM buyer is not read (test buyers still are)', async () => {
  process.env.TEST_MODE_ONLY = 'true'
  await assert.rejects(gatherContext({ buyerId: 'crm_buyer_real', prisma }), /not found/)
  assert.equal((await gatherContext({ buyerId: 'crm_buyer_1', prisma })).buyer.name, 'Pat Example')
})
