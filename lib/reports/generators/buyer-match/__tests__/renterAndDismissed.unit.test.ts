// Brief 48 PR 13 (M29; TEST_PLAN R-08, R-09): a renter's Buyer Match report
// did mortgage maths on the monthly rent ("20% down on $4,000 implies roughly
// $20 a month"), and every report listed matches Ryan had dismissed. A renter
// now gets a rent read (no mortgage, no price per square foot), and a dismissed
// match stays out of the report, as it does on /matches.
// The real report loader and sections run on a stand-in for Prisma that
// evaluates every filter (pr13FakePrisma.ts) and a stand-in for FRED's rate;
// no database, no network. Made-up people and places only.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import type { PrismaClient } from '@prisma/client'
import { makeFakePrisma, emailBuyer, emailListing, listingMatch, fakeFredRate } from '../../../__tests__/pr13FakePrisma'
import { gatherContext } from '../context'
import { budgetRealitySection } from '../sections/budget-reality'
import { generateBuyerMatchReport } from '../index'

const restoreFetch = fakeFredRate()
after(restoreFetch)

const MORTGAGE = /mortgage|20% down|down payment|P&I|principal|\bloan\b|30-?yr|30-year|per square foot|\$\/SF/i

const renter = emailBuyer({
  id: 'renter_1', category: 'RENTER_INQUIRY', extractedTitle: 'Renter wants a 2BR in Crown Heights',
  neighborhoods: ['Crown Heights'], minBeds: 2, maxBeds: 2, minPrice: null, maxPrice: 4000,
})
const rentals = [3800, 4200, 3500].map((price, n) => emailListing({
  id: `rental_${n}`, category: 'RENTAL_LISTING', neighborhood: 'Crown Heights', price, beds: 2, squareFeet: 900,
  address: `${20 + n} Example Pl`,
}))
const buyer = emailBuyer({ id: 'buyer_m29', neighborhoods: ['Park Slope'], minPrice: 1_500_000, maxPrice: 2_000_000 })
const homes = [['a', '101'], ['b', '202'], ['c', '303']].map(([k, no]) =>
  emailListing({ id: `home_${k}`, address: `${no} Sample St`, price: 1_800_000, beds: 3 }))

const fake = makeFakePrisma({
  extractedOpportunity: [renter, ...rentals, buyer, ...homes],
  mojoContact: [],
  match: [
    ...rentals.map(r => listingMatch(r.id as string, 'renter_1', { tier: 'HOT' })),
    ...homes.map(h => listingMatch(h.id as string, 'buyer_m29', { tier: 'HOT' })),
  ],
  matchDismissal: [
    // Ryan dismissed home_b for this buyer (how the dismiss route stores it) ...
    { id: 'd1', partyId: 'buyer_m29', listingId: 'home_b' },
    // ... and home_c the other way round (an older row's orientation).
    { id: 'd2', partyId: 'home_c', listingId: 'buyer_m29' },
  ],
})
const prisma = fake.prisma as unknown as PrismaClient

test("a renter's budget check reads the rent, with no mortgage maths", async () => {
  const ctx = await gatherContext({ buyerId: 'renter_1', prisma })
  const s = await budgetRealitySection(ctx)
  const text = [s.content.prose ?? '', ...(s.content.metrics ?? []).map(m => `${m.label}: ${m.value}`)].join('\n')
  assert.doesNotMatch(text, MORTGAGE, text)
  assert.ok(!s.sources.some(x => x.type === 'fred'), 'no rate lookup for a renter')
  assert.match(s.content.prose ?? '', /\$3,800 a month/, 'the median asking rent')
  assert.match(s.content.prose ?? '', /\$4,000 a month/, "the renter's budget")
  assert.match(s.content.prose ?? '', /2 of the 3 matched rentals/, 'how many are within it')
})

test('a buyer still gets the mortgage read at the current rate', async () => {
  const ctx = await gatherContext({ buyerId: 'buyer_m29', prisma })
  const s = await budgetRealitySection(ctx)
  assert.match(s.content.prose ?? '', /20% down on \$2,000,000/)
  assert.ok(s.sources.some(x => x.type === 'fred'))
})

// Review r2: a buyer or renter who gave only a minimum ("$3,000+"; mapISO
// stores minPrice 3000 and price 3000) has no ceiling. The budget check used to
// read that minimum as the ceiling ("up to $3,000 a month; 0 of the 3 matched
// rentals are within it") while the same report's fit lines called them "in
// budget". It now says the budget starts there, with no maximum on file.
test('a minimum-only budget is never read as a ceiling', async () => {
  const floorRenter = emailBuyer({ id: 'renter_floor', category: 'RENTER_INQUIRY', neighborhoods: ['Crown Heights'],
    minBeds: null, maxBeds: null, minPrice: 3000, maxPrice: null })
  const floorBuyer = emailBuyer({ id: 'buyer_floor', minPrice: 1_600_000, maxPrice: null })
  assert.deepEqual([floorRenter.price, floorBuyer.price], [3000, 1_600_000], 'stored the way mapISO stores them')
  const flats = [3200, 3500, 3800].map((price, n) => emailListing({ id: `floor_rental_${n}`, category: 'RENTAL_LISTING', price, beds: 1 }))
  const db = makeFakePrisma({
    extractedOpportunity: [floorRenter, floorBuyer, ...flats],
    mojoContact: [],
    match: flats.map(f => listingMatch(f.id as string, 'renter_floor')),
    matchDismissal: [],
  }).prisma as unknown as PrismaClient

  const rent = await budgetRealitySection(await gatherContext({ buyerId: 'renter_floor', prisma: db }))
  assert.doesNotMatch(rent.content.prose ?? '', /up to|within it/, rent.content.prose)
  assert.match(rent.content.prose ?? '', /The renter's budget starts at \$3,000 a month, with no maximum on file\./)
  assert.ok(!(rent.content.metrics ?? []).some(m => m.label === 'Budget ceiling'))

  const buy = await budgetRealitySection(await gatherContext({ buyerId: 'buyer_floor', prisma: db }))
  assert.doesNotMatch(buy.content.prose ?? '', /ceiling is|20% down|mortgage/, buy.content.prose)
  assert.match(buy.content.prose ?? '', /The buyer's budget starts at \$1,600,000, with no maximum on file\./)
  assert.ok(!buy.sources.some(x => x.type === 'fred'), 'no mortgage read without a ceiling')
})

test('a dismissed match stays out of the report, whichever way the dismissal is stored', async () => {
  const report = await generateBuyerMatchReport({ buyerId: 'buyer_m29', prisma })
  assert.match(report.markdown, /\b101 Sample St/)
  assert.doesNotMatch(report.markdown, /\b(?:202|303) Sample St/)
  const curated = report.sections.find(s => s.key === 'curated-matches')!
  assert.deepEqual((curated.content.items ?? []).map(i => i.listingId), ['home_a'])
  assert.equal(report.matchCount, 1, 'the HOT count on the report card leaves them out too')
  const inventory = report.sections.find(s => s.key === 'matching-inventory')!
  assert.match(inventory.content.prose ?? '', /^1 listing tier/)
})
