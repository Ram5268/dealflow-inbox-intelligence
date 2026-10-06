import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Category } from '@prisma/client'
import { curatedMatchesSection } from '../sections/curated-matches'
import { nearMissesSection } from '../sections/near-misses'
import type { GenContext, BuyerRecord, MatchedListing } from '../../types'

// Run via `npm test`. Pure — feeds a known matcher output (mock) and asserts the
// tier split: curated = HOT only, near-misses = WARM/POSSIBLE only, item shape.

const BUYER: BuyerRecord = {
  id: 'buyer_1', category: Category.BUYER_ISO, name: 'Sarah Chen',
  neighborhoods: ['Soho'], borough: 'Manhattan',
  minBeds: 2, maxBeds: 2, beds: null, minPrice: 4_250_000, maxPrice: 4_750_000, price: null,
  mustHaves: null, dealbreakers: null, timeline: null, propertyTypes: [], isTestData: true, createdAt: new Date(),
}

function listing(id: string, address: string, price: number) {
  return {
    id, category: Category.ACTIVE_SALE_LISTING, address, neighborhood: 'Soho', borough: 'Manhattan',
    price, beds: 2, squareFeet: 1500, extractedTitle: address, sourceBrokerage: 'Compass', sourceAgentName: null, availabilityDate: null, isHomeowner: false,
  }
}

const MATCHES: MatchedListing[] = [
  { matchId: 'm1', tier: 'HOT', score: 90, reason: 'Exact Soho 2BR at $4.5M, squarely in budget.', listing: listing('L1', '394 DeKalb Ave', 4_500_000) },
  { matchId: 'm2', tier: 'WARM', score: 70, reason: 'Noho, one neighborhood over; beds match.', listing: listing('L2', '328 DeKalb Ave', 3_500_000) },
  { matchId: 'm3', tier: 'POSSIBLE', score: 55, reason: 'Over budget by ~8%.', listing: listing('L3', '12 Bond St', 5_100_000) },
]

function mockCtx(matches: MatchedListing[]): GenContext {
  return { buyerId: BUYER.id, prisma: {} as GenContext['prisma'], buyer: BUYER, matches: async () => matches }
}

test('curated matches returns only HOT listings, with fit rationale', async () => {
  const r = await curatedMatchesSection(mockCtx(MATCHES))
  assert.equal(r.key, 'curated-matches')
  assert.equal(r.content.items?.length, 1, 'only the HOT match is curated')
  const item = r.content.items![0]
  assert.equal(item.listingId, 'L1')
  assert.equal(item.address, '394 DeKalb Ave')
  assert.equal(item.priceLabel, '$4,500,000')
  assert.equal(item.fit, 'Exact Soho 2BR at $4.5M, squarely in budget.', 'fit is the matcher reason')
  // sources: matcher + one inbox listing id.
  assert.ok(r.sources.some(s => s.type === 'matcher'))
  assert.ok(r.sources.some(s => s.type === 'inbox' && s.id === 'L1'))
})

test('near-misses returns WARM + POSSIBLE with the exclusion reason', async () => {
  const r = await nearMissesSection(mockCtx(MATCHES))
  assert.equal(r.key, 'near-misses')
  assert.equal(r.content.items?.length, 2, 'WARM + POSSIBLE, not HOT')
  const ids = r.content.items!.map(i => i.listingId)
  assert.deepEqual(ids, ['L2', 'L3'])
  assert.equal(r.content.items![0].why, 'Noho, one neighborhood over; beds match.')
  assert.ok(r.content.prose?.includes('$'), 'prose surfaces prices inline')
})

test('empty matcher output yields empty curated + near-miss sets, no invention', async () => {
  const curated = await curatedMatchesSection(mockCtx([]))
  const near = await nearMissesSection(mockCtx([]))
  assert.equal(curated.content.items?.length, 0)
  assert.equal(near.content.items?.length, 0)
  assert.ok(/no clear fits/i.test(curated.content.prose ?? ''))
  assert.ok(/no near-misses/i.test(near.content.prose ?? ''))
})
