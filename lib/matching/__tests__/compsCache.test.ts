import { test } from 'node:test'
import assert from 'node:assert/strict'
import { medianByBucket, precomputeSubstitutionCounts, type CarryingRow } from '../compsCache'
import { carryingBucketKey } from '../compsKey'
import { makeListing, makeBuyer } from './fixtures'

test('empty listing set → empty medians map', () => {
  const r = medianByBucket([])
  assert.equal(r.medians.size, 0)
  assert.equal(r.counts.size, 0)
})

test('populated bucket (>=5 comps) → correct median', () => {
  const rows: CarryingRow[] = [1000, 1200, 1400, 1600, 1800].map(m => ({
    neighborhood: 'Chelsea', price: 1_000_000, propertyType: 'condo', monthly: m,
  }))
  const key = carryingBucketKey('Chelsea', 1_000_000, 'condo')
  const r = medianByBucket(rows)
  assert.equal(r.medians.get(key), 1400) // median of 5 sorted values
  assert.equal(r.counts.get(key), 5)
})

test('bucket with < 5 comps → excluded from medians (but counted)', () => {
  const rows: CarryingRow[] = [1000, 2000, 3000].map(m => ({
    neighborhood: 'Tribeca', price: 3_000_000, propertyType: 'condo', monthly: m,
  }))
  const key = carryingBucketKey('Tribeca', 3_000_000, 'condo')
  const r = medianByBucket(rows)
  assert.equal(r.medians.has(key), false)
  assert.equal(r.counts.get(key), 3)
})

test('substitution counts: buyer with few matching listings gets a low count', () => {
  const listings = [
    makeListing({ id: 'a', neighborhood: 'Chelsea', beds: 2, price: 1_500_000 }),
    makeListing({ id: 'b', neighborhood: 'Chelsea', beds: 2, price: 1_600_000 }),
    makeListing({ id: 'c', neighborhood: 'Park Slope', beds: 4, price: 4_000_000 }), // different borough + beds + price
  ]
  const buyer = makeBuyer({ id: 'B', neighborhoods: ['Chelsea'], bedsMin: 2, bedsMax: 2, priceMin: 1_400_000, priceMax: 1_700_000 })
  const counts = precomputeSubstitutionCounts([buyer], listings)
  assert.equal(counts.get('B'), 2)
})
