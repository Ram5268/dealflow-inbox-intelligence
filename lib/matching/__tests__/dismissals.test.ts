import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { PrismaClient } from '@prisma/client'
import { ID_CHUNK, inChunks, loadDismissedPairs } from '../dismissals'

// Brief 35: dismissal and id-IN lookups stay under Prisma's bind limit.

test('inChunks splits ids into ≤5,000-id queries', async () => {
  const sizes: number[] = []
  const ids = Array.from({ length: 12_001 }, (_, i) => `id${i}`)
  const out = await inChunks(ids, async chunk => { sizes.push(chunk.length); return chunk })
  assert.equal(ID_CHUNK, 5_000)
  assert.deepEqual(sizes, [5_000, 5_000, 2_001])
  assert.equal(out.length, 12_001)
})

test('loadDismissedPairs queries by listingId in chunks and matches either orientation', async () => {
  const queries: number[] = []
  const db = {
    matchDismissal: {
      findMany: async ({ where }: { where: { listingId: { in: string[] } } }) => {
        queries.push(where.listingId.in.length)
        return [{ partyId: 'buyer1', listingId: 'seller1' }, { partyId: 'iso2', listingId: 'listing2' }]
          .filter(d => where.listingId.in.includes(d.listingId))
      },
    },
  } as unknown as Pick<PrismaClient, 'matchDismissal'>
  const matches = [
    { opportunityId: 'seller1', counterpartId: 'buyer1' }, // contact supply
    { opportunityId: 'iso2', counterpartId: 'listing2' }, // legacy ISO-triggered row
    { opportunityId: 'seller3', counterpartId: 'buyer3' },
    ...Array.from({ length: 6_000 }, (_, i) => ({ opportunityId: `o${i}`, counterpartId: `c${i}` })),
  ]
  const isDismissed = await loadDismissedPairs(db, matches)
  assert.deepEqual(queries, [5_000, 5_000, 2_006])
  assert.deepEqual(matches.slice(0, 3).map(isDismissed), [true, true, false])
})
