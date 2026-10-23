// Brief 43 PR 15 (Q31): search_listings and search_parties return 20 cards
// unless Drift asks for more (it was 50; every card is paid again on each later
// round). Drift is still told the full count (totalMatched). On the stand-in
// Prisma that evaluates the where clause (pr7FakeDb.ts). Fictional rows only.
import { fakeDb } from './pr7FakeDb'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { searchListings } from '../searchListings'
import { searchParties } from '../searchParties'
import { SEARCH_LISTINGS_TOOL, SEARCH_PARTIES_TOOL } from '../schemas'

delete process.env.TEST_MODE_ONLY

type Row = Record<string, unknown>
const ORG = 'org-pr15'
const T0 = Date.UTC(2026, 9, 1)
const listing = (n: number): Row => ({
  id: `L${n}`, organizationId: ORG, category: 'ACTIVE_SALE_LISTING', isDuplicate: false, processingStatus: 'active',
  extractedTitle: `Listing ${n}`, address: `${n} Sample St`, neighborhood: 'Crown Heights', neighborhoods: [], borough: null,
  beds: 3, minBeds: null, maxBeds: null, price: 1_000_000, minPrice: null, maxPrice: null, isTestData: true,
  units: null, propertyType: null, squareFeet: null, availabilityDate: null, sourceBrokerage: null,
  createdAt: new Date(T0 - n * 3_600_000),
})
const buyer = (n: number): Row => ({
  id: `iso${n}`, organizationId: ORG, category: 'BUYER_ISO', isDuplicate: false, processingStatus: 'active', provenance: null,
  extractedTitle: `Buyer ${n}`, neighborhood: 'Bushwick', neighborhoods: ['Bushwick'], borough: 'Brooklyn',
  beds: null, minBeds: 3, maxBeds: 4, minPrice: 1_000_000, maxPrice: 2_000_000, isTestData: true,
  createdAt: new Date(T0 - n * 3_600_000),
})
const range = (n: number) => Array.from({ length: n }, (_, i) => i + 1)

test('search_listings: 20 cards by default, all of them when Drift asks', async () => {
  fakeDb.reset({ organization: [{ id: ORG, slug: 'dealflow-ryan' }], extractedOpportunity: range(30).map(listing) })
  const r = await searchListings({ neighborhoods: ['Crown Heights'] })
  assert.equal(r.cards.length, 20)
  assert.equal(r.totalMatched, 30)
  assert.equal((await searchListings({ neighborhoods: ['Crown Heights'], limit: 50 })).cards.length, 30)
})

test('search_parties: 20 cards by default', async () => {
  fakeDb.reset({ organization: [{ id: ORG, slug: 'dealflow-ryan' }], extractedOpportunity: range(30).map(buyer), mojoContact: [] })
  const r = await searchParties({ role: 'buyer', neighborhoods: ['Bushwick'] })
  assert.equal(r.cards.length, 20)
  assert.equal(r.totalMatched, 30)
})

test("the tools' descriptions tell Drift the default is 20", () => {
  const limitText = (tool: typeof SEARCH_LISTINGS_TOOL) =>
    String(((tool.input_schema as { properties: Record<string, { description?: string }> }).properties.limit).description)
  assert.match(limitText(SEARCH_LISTINGS_TOOL), /default 20, max 200/)
  assert.match(limitText(SEARCH_PARTIES_TOOL), /default 20, max 200/)
})
