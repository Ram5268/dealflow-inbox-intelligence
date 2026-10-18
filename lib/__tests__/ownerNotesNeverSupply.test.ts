// Ryan's decision, 2026-10-17: saved seller notes may keep these details.
// Buyer-facing text still never names motivation (engineering precaution,
// Brief 41 H7).
//
// Buyer-facing text fell back to a supply's title when it had no address, and
// a seller or landlord lead's or a client conversation's title may now name an
// estate, a divorce or an illness. Today none of them is ever a match's supply
// side; these pin it. Each matcher that writes Match rows, and the report's
// off-market section, runs on a stand-in for Prisma that offers lead and
// conversation rows fitting the buyer and renter on every criterion next to
// real listings: the listings get paired, the leads never do. (If an old or odd
// row is there anyway, the report and drafts show it like a homeowner:
// ownerNotesBuyerFacing.test.ts, draftOwnerNotes.test.ts.) No database, no
// network. Runs under tsx: matchmaking.ts imports '@/' paths.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SUPPLY_SALE, SUPPLY_RENTAL } from '../domain/Categories'
import { installFakeAiFetch, anthropicTool } from './fakeAiFetch'

const OWNER_NOTES = ['SELLER_LEAD', 'LANDLORD_LEAD', 'CLIENT_CONVERSATION']
const now = new Date()

const opp = (id: string, category: string, over: Record<string, unknown> = {}) => ({
  id, category, organizationId: 'org-test', isTestData: false, isDuplicate: false, provenance: null, processingStatus: 'active',
  transactionType: 'SALE', propertyType: 'townhouse', extractedTitle: `${category} with its own notes`, extractedSummary: 'Notes.',
  address: '12 Example St', neighborhood: 'Park Slope', neighborhoods: [] as string[], borough: 'Brooklyn',
  price: 1_800_000, minPrice: null, maxPrice: null, beds: 4, baths: 2, minBeds: null, maxBeds: null, mustHaves: null,
  timeline: null, sourceBrokerage: null, sourceAgentName: null, availabilityDate: null, createdAt: now, ...over,
})
const LEADS = [
  opp('seller-lead', 'SELLER_LEAD'),
  opp('landlord-lead', 'LANDLORD_LEAD', { transactionType: 'RENTAL', price: 4_000, beds: 2 }),
  opp('sale-conversation', 'CLIENT_CONVERSATION'),
  opp('rental-conversation', 'CLIENT_CONVERSATION', { price: 4_000, beds: 2 }),
]
const LEAD_IDS = new Set(LEADS.map(l => l.id))
const LISTINGS = [
  opp('sale-listing', 'ACTIVE_SALE_LISTING'),
  opp('off-market-listing', 'OFF_MARKET_SALE'),
  opp('rental-listing', 'RENTAL_LISTING', { transactionType: 'RENTAL', price: 4_000, beds: 2 }),
]
const DEMAND = [
  opp('buyer', 'BUYER_ISO', { transactionType: 'BUYER_NEED', price: null, minPrice: 1_500_000, maxPrice: 2_000_000, minBeds: 3, maxBeds: 5, neighborhoods: ['Park Slope'] }),
  opp('renter', 'RENTER_INQUIRY', { transactionType: 'RENTAL', price: null, minPrice: 3_000, maxPrice: 5_000, minBeds: 2, maxBeds: 3, neighborhoods: ['Park Slope'] }),
]
// A CRM homeowner (the nightly job's supply).
const CONTACT = {
  id: 'crm-homeowner', organizationId: 'org-test', isTestData: false, intent: 'SELLER', tags: [] as string[], metadata: { source: 'crm' },
  fullName: null, address: '14 Example St', neighborhood: 'Park Slope', zipCode: '11215', propertyBeds: 4, propertyBaths: 2,
  unitCount: 1, estimatedValue: null, createdAt: now,
}

// Enough of Prisma's where for these queries: equality, `in` and `hasSome`.
// OR/AND (the comp-reference gates) and other operators offer the row, which
// only makes the check stricter.
function fits(row: Record<string, unknown>, where: Record<string, unknown> = {}): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (k === 'OR' || k === 'AND' || k === 'NOT') return true
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      if ('in' in v) return (v as { in: unknown[] }).in.includes(row[k])
      if ('hasSome' in v) return (v as { hasSome: unknown[] }).hasSome.some(x => (row[k] as unknown[] | undefined)?.includes(x))
      return true
    }
    return row[k] === v
  })
}
let rows: Array<Record<string, unknown>> = []
const asked: Array<Record<string, unknown>> = []
const created: Array<Record<string, unknown>> = []
;(globalThis as unknown as { prisma: unknown }).prisma = {
  organization: { findUnique: async () => ({ id: 'org-test' }) },
  extractedOpportunity: {
    findUnique: async ({ where }: { where: { id: string } }) => rows.find(r => r.id === where.id) ?? null,
    findMany: async ({ where }: { where: Record<string, unknown> }) => { asked.push(where); return rows.filter(r => fits(r, where)) },
  },
  mojoContact: { findMany: async ({ where }: { where: Record<string, unknown> }) => [CONTACT].filter(c => fits(c, where)) },
  matchDismissal: { findMany: async () => [] },
  match: { create: async ({ data }: { data: Record<string, unknown> }) => { created.push(data); return data } },
  featureFlag: { findUnique: async () => null }, // Brief 44: the USE_OUR_ESTIMATES switch has no row (off)
}
const ai = installFakeAiFetch()
ai.reply(() => anthropicTool('score_match', { tier: 'Hot', reason: 'Exact neighborhood, price fits.' }))

test('the shared supply sets hold no lead or conversation category', () => {
  for (const c of OWNER_NOTES) assert.ok(![...SUPPLY_SALE, ...SUPPLY_RENTAL].includes(c as never), c)
})

test('the engine (used by the email sync) pairs a buyer or renter with listings only', async () => {
  const { findMatchesForParty, findMatchesForListing } = await import('../matching/engine')
  rows = [...LEADS, ...LISTINGS, ...DEMAND]
  for (const party of ['buyer', 'renter']) {
    asked.length = 0
    const { results } = await findMatchesForParty(party)
    const supply = results.map(r => r.listing.id)
    assert.ok(supply.length > 0, `${party}: the listings that fit are paired`)
    assert.ok(supply.every(id => !LEAD_IDS.has(id)), `${party}: ${supply}`)
    const categories = asked.flatMap(w => ((w.category as { in?: string[] } | undefined)?.in ?? []))
    assert.ok(categories.length > 0 && OWNER_NOTES.every(c => !categories.includes(c)), `${party}: ${categories}`)
  }
  // From a listing, the other side is buyer or renter demand only.
  for (const [listing, party] of [['sale-listing', 'buyer'], ['rental-listing', 'renter']]) {
    const { results } = await findMatchesForListing(listing)
    assert.deepEqual(results.map(r => r.party.id), [party], listing)
  }
  // A lead or a conversation can't start a listing-side match either.
  for (const lead of LEADS) await assert.rejects(findMatchesForListing(lead.id), /not a SUPPLY listing/, lead.id)
})

test('the classic matcher (the manual sync) never pairs a lead or a conversation, however well it fits', async () => {
  const { runMatchmaking } = await import('../matchmaking')
  rows = [...LEADS, ...LISTINGS, ...DEMAND]
  created.length = 0
  await runMatchmaking(rows.map(r => r.id as string))
  const opportunityRows = created.filter(m => m.counterpartType === 'opportunity')
  assert.ok(opportunityRows.length >= 4, 'the fitting listings are paired both ways')
  for (const m of created) {
    assert.ok(!LEAD_IDS.has(m.opportunityId as string) && !LEAD_IDS.has(m.counterpartId as string), JSON.stringify(m))
  }
})

test('nightly scoring scores CRM homeowners only, never an email lead', async () => {
  const { loadScoringInputs } = await import('../matching/nightly/runScoring')
  rows = [...LEADS, ...LISTINGS, ...DEMAND]
  const { listings, buyers } = await loadScoringInputs('org-test')
  assert.deepEqual(listings.map(l => [l.id, l.sourceType]), [['crm-homeowner', 'contact']])
  assert.deepEqual(buyers.map(b => b.id), ['buyer'])
})

test("the report's off-market section lists pre-market listings only", async () => {
  const { offMarketSection } = await import('../reports/generators/buyer-match/sections/off-market')
  rows = [...LEADS, ...LISTINGS, ...DEMAND]
  const buyer = {
    id: 'buyer', category: 'BUYER_ISO', name: 'Buyer', neighborhoods: ['Park Slope'], borough: 'Brooklyn', minBeds: 3, maxBeds: 5,
    beds: null, minPrice: 1_500_000, maxPrice: 2_000_000, price: null, mustHaves: null, dealbreakers: null, timeline: null,
    propertyTypes: [], isTestData: false, createdAt: now,
  }
  const ctx = { buyerId: 'buyer', prisma: (globalThis as unknown as { prisma: never }).prisma, buyer, matches: async () => [] }
  const items = (await offMarketSection(ctx as never)).content.items!
  assert.deepEqual(items.map(i => i.listingId), ['off-market-listing'])
})
