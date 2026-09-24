import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeCarryingReasonableness } from '../carryingReasonableness'
import { carryingBucketKey } from '../../compsKey'
import { makeListing, makeContext } from '../../__tests__/fixtures'

// Shared bucket: Chelsea | band 2 ($1M/500k) | condo. Median monthly carrying = $1000.
const NBHD = 'Chelsea'
const PRICE = 1_000_000
const PT = 'condo'
const KEY = carryingBucketKey(NBHD, PRICE, PT)
const ctxWithMedian = () => makeContext({ compsMedians: new Map([[KEY, 1000]]) })
const listingMonthly = (monthly: number) =>
  makeListing({ neighborhood: NBHD, price: PRICE, propertyType: PT, monthlyMaintenance: monthly })

test('carrying < 1.15x median → 1.0 HIGH', () => {
  const r = computeCarryingReasonableness(listingMonthly(1000), ctxWithMedian())
  assert.equal(r.score, 1.0)
  assert.equal(r.confidence, 'HIGH')
})

test('carrying = 1.5x median → 0.3 HIGH', () => {
  assert.equal(computeCarryingReasonableness(listingMonthly(1500), ctxWithMedian()).score, 0.3)
})

test('carrying = 2.0x median → 0.05 HIGH', () => {
  assert.equal(computeCarryingReasonableness(listingMonthly(2000), ctxWithMedian()).score, 0.05)
})

test('no monthly data → 0.5 LOW', () => {
  const r = computeCarryingReasonableness(makeListing({ neighborhood: NBHD, price: PRICE, propertyType: PT }), ctxWithMedian())
  assert.equal(r.score, 0.5)
  assert.equal(r.confidence, 'LOW')
})

test('fewer than 5 comps (median absent) → 0.6 MEDIUM', () => {
  const r = computeCarryingReasonableness(listingMonthly(1000), makeContext()) // empty medians map
  assert.equal(r.score, 0.6)
  assert.equal(r.confidence, 'MEDIUM')
})
