// Brief 41 (H11): first, so the guard runs before anything touches a database.
import '../../../__tests__/requireTestDb'
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { prisma } from '../../../prisma'
import { searchParties } from '../searchParties'

// Brief 30.1 — search_parties beds recall fix, against the database (moved out
// of searchParties.test.ts in Brief 41; run by npm run test:integration).

after(async () => { await prisma.$disconnect() })

// Integration — hits real DB against a known seed id (BUYER_A).
test('searchParties returns BUYER_A for beds=2, neighborhoods=[soho], price 4-5M', async () => {
  const result = await searchParties({
    role: 'buyer',
    neighborhoods: ['soho'],
    beds: 2,
    priceRangeOverlaps: { min: 4_000_000, max: 5_000_000 },
  })
  const ids = result.cards.map(c => c.id)
  assert.ok(
    ids.includes('cmsp7l5he001qloo89haui4u2'),
    `BUYER_A missing from search_parties result. Got: ${ids.join(',')}`,
  )
})
