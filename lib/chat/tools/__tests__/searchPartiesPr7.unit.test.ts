// Brief 43 PR 7: search_parties correctness (Q10, Q13). drift-1's p4 probe
// cases as regressions: a buyer is kept when the price falls inside their
// budget, and an area means that area. Buyers and renters only (role 'buyer' /
// 'renter'), on a stand-in for Prisma that evaluates the where clause
// (pr7FakeDb.ts). No database, no network.
import { fakeDb } from './pr7FakeDb'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { searchParties, budgetOverlap } from '../searchParties'

delete process.env.TEST_MODE_ONLY

type Row = Record<string, unknown>
const ORG = 'org-pr7'
let k = 0
function iso(over: Row = {}): Row {
  k++
  return {
    id: `iso${k}`, organizationId: ORG, category: 'BUYER_ISO', isDuplicate: false, processingStatus: 'active', provenance: null,
    extractedTitle: `Buyer ${k}`, neighborhood: 'Bushwick', neighborhoods: ['Bushwick'], borough: 'Brooklyn',
    beds: null, minBeds: 3, maxBeds: 4, minPrice: 1_000_000, maxPrice: 2_000_000, isTestData: true,
    createdAt: new Date(Date.UTC(2026, 9, 1) - k * 3_600_000), ...over,
  }
}
function load(rows: Row[]) {
  fakeDb.reset({ organization: [{ id: ORG, slug: 'dealflow-ryan' }], extractedOpportunity: rows, mojoContact: [] })
}

function bushwickBuyers() {
  load([
    iso({ extractedTitle: '1.0M-2.0M', minPrice: 1_000_000, maxPrice: 2_000_000 }),
    iso({ extractedTitle: '1.7M-1.9M', minPrice: 1_700_000, maxPrice: 1_900_000 }),
    iso({ extractedTitle: '1.0M-2.5M', minPrice: 1_000_000, maxPrice: 2_500_000 }),
    iso({ extractedTitle: 'max 2.0M', minPrice: null, maxPrice: 2_000_000 }),
    iso({ extractedTitle: 'min 1.5M', minPrice: 1_500_000, maxPrice: null }),
    iso({ extractedTitle: 'max 1.2M', minPrice: null, maxPrice: 1_200_000 }),
    iso({ extractedTitle: '2.4M-3.0M', minPrice: 2_400_000, maxPrice: 3_000_000 }),
    iso({ extractedTitle: 'no budget', minPrice: null, maxPrice: null }),
  ])
}
const KEPT = ['1.0M-2.0M', '1.7M-1.9M', '1.0M-2.5M', 'max 2.0M', 'min 1.5M']

test('B-02 / Q10: buyers for a $1.8M house keep a $1.0M-$2.0M buyer and a max-only $2.0M buyer', async () => {
  bushwickBuyers()
  const r = await searchParties({ role: 'buyer', neighborhoods: ['Bushwick'], priceRangeOverlaps: { min: 1_800_000, max: 1_800_000 } })
  assert.deepEqual(r.cards.map(c => c.title), KEPT)
  assert.equal(r.totalMatched, KEPT.length)
})

test('B-02 / Q10: the same buyers for a $1.7M-$1.9M range', async () => {
  bushwickBuyers()
  const r = await searchParties({ role: 'buyer', neighborhoods: ['Bushwick'], priceRangeOverlaps: { min: 1_700_000, max: 1_900_000 } })
  assert.deepEqual(r.cards.map(c => c.title), KEPT)
})

test('Q10: a price up to 5% over a buyer\'s maximum is a near fit, past that it is out', async () => {
  load([
    iso({ extractedTitle: 'max 1.75M', minPrice: 1_200_000, maxPrice: 1_750_000 }),
    iso({ extractedTitle: 'max 1.7M', minPrice: 1_200_000, maxPrice: 1_700_000 }),
  ])
  const r = await searchParties({ role: 'buyer', priceRangeOverlaps: { min: 1_800_000, max: 1_800_000 } })
  assert.deepEqual(r.cards.map(c => c.title), ['max 1.75M'])
  assert.ok((r.cards[0].priceOverlapScore ?? 1) < 1)
})

test('budgetOverlap: a price inside the budget is a full fit; no budget is no fit', () => {
  assert.equal(budgetOverlap({ min: 1_800_000, max: 1_800_000 }, 1_000_000, 2_000_000), 1)
  assert.equal(budgetOverlap({ min: 1_800_000, max: 1_800_000 }, null, 2_000_000), 1)
  assert.equal(budgetOverlap({ min: 1_800_000, max: 1_800_000 }, 1_500_000, null), 1)
  assert.equal(budgetOverlap({ min: 1_900_000, max: 1_700_000 }, 1_000_000, 1_750_000), 1) // reversed range
  assert.equal(budgetOverlap({ min: 1_800_000, max: 1_800_000 }, null, 1_200_000), 0)
  assert.equal(budgetOverlap({ min: 1_800_000, max: 1_800_000 }, null, null), 0)
})

test('Q13: buyers in Williamsburg do not include East Williamsburg buyers', async () => {
  load([
    iso({ extractedTitle: 'wburg', neighborhood: 'Williamsburg', neighborhoods: ['Williamsburg'] }),
    iso({ extractedTitle: 'east wburg', neighborhood: 'East Williamsburg', neighborhoods: ['East Williamsburg'] }),
    iso({ extractedTitle: 'greenpoint or wburg', neighborhood: 'Greenpoint', neighborhoods: ['Greenpoint', 'Williamsburg'] }),
    iso({ extractedTitle: 'harlem', neighborhood: 'East Harlem', neighborhoods: ['East Harlem'] }),
  ])
  const r = await searchParties({ role: 'buyer', neighborhoods: ['Williamsburg'] })
  assert.deepEqual(r.cards.map(c => c.title), ['wburg', 'greenpoint or wburg'])
  const harlem = await searchParties({ role: 'buyer', neighborhoods: ['Harlem'] })
  assert.deepEqual(harlem.cards.map(c => c.title), [])
  const nearby = await searchParties({ role: 'buyer', neighborhoods: ['Williamsburg'], nearby: true })
  assert.deepEqual(nearby.cards.map(c => c.title), ['wburg', 'east wburg', 'greenpoint or wburg'])
})

test('renters: an area means that area, and the budget test is the same', async () => {
  load([
    iso({ category: 'RENTER_INQUIRY', extractedTitle: 'flatbush 3-4k', neighborhood: 'Flatbush', neighborhoods: ['Flatbush'], minPrice: 3_000, maxPrice: 4_000 }),
    iso({ category: 'RENTER_INQUIRY', extractedTitle: 'east flatbush 3-4k', neighborhood: 'East Flatbush', neighborhoods: ['East Flatbush'], minPrice: 3_000, maxPrice: 4_000 }),
  ])
  const r = await searchParties({ role: 'renter', neighborhoods: ['Flatbush'], priceRangeOverlaps: { min: 3_500, max: 3_500 } })
  assert.deepEqual(r.cards.map(c => c.title), ['flatbush 3-4k'])
})
