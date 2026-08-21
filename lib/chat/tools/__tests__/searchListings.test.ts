import 'dotenv/config'
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { prisma } from '../../../prisma'
import { searchListings } from '../searchListings'
import { Category } from '@prisma/client'

// Brief 30.2 — searchListings range/null fixes (mirror of the search_parties beds
// fix). Runs under tsx (searchListings uses the @/ alias; ts-node can't resolve it).
// Hits the real Railway dev DB.
//
// NOTE: as of Brief 30.2 the seed set has ZERO listing-side range rows
// (beds=null+minBeds, or price=null+minPrice) — listings are scalar-shaped. So the
// range PATHS are proven by lib/matching/__tests__/bedsScore.test.ts + the
// bedsMatches unit tests; here we (a) guard that the beds fix doesn't regress the
// scalar path, and (b) skip-and-report the price-null case until a fixture exists.

const LISTING_CATS: Category[] = [
  Category.COMING_SOON_SALE, Category.OFF_MARKET_SALE, Category.ACTIVE_SALE_LISTING,
  Category.COMING_SOON_RENTAL, Category.RENTAL_LISTING,
]

after(async () => { await prisma.$disconnect() })

test('searchListings — listing with null price + min/max returns for price-filtered query', async (t) => {
  // Requires a seed listing with price=null but minPrice/maxPrice populated.
  const fixture = await prisma.extractedOpportunity.count({
    where: { category: { in: LISTING_CATS }, isDuplicate: false, price: null, minPrice: { not: null } },
  })
  if (fixture === 0) {
    t.skip('no price-null + minPrice/maxPrice listing in seed data (Brief 30.2 — reported to planner; do not fabricate)')
    return
  }
  const result = await searchListings({ priceMin: 3_000_000, priceMax: 3_500_000, includeTestData: true })
  const hit = result.cards.find(c => c.priceRange && c.priceRange[0] <= 3_500_000 && c.priceRange[1] >= 3_000_000)
  assert.ok(hit, 'expected a listing with range price to be returned; none found')
})

test('searchListings — beds=2 still returns listings (range-aware gate, no scalar regression)', async () => {
  const result = await searchListings({ beds: 2, includeTestData: true })
  assert.ok(result.cards.length > 0, 'expected at least one 2BR listing (scalar or range)')
})
