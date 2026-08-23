import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isEligible } from '../eligibility'
import { makeListing, makeBuyer } from './fixtures'

test('rental listing → not eligible', () => {
  const r = isEligible(makeListing({ transactionType: 'RENTAL' }), makeBuyer())
  assert.equal(r.eligible, false)
  assert.equal(r.reason, 'rental_out_of_scope')
})

test('renter-need buyer → not eligible', () => {
  const r = isEligible(makeListing(), makeBuyer({ transactionType: 'RENTER_NEED' }))
  assert.equal(r.eligible, false)
  assert.equal(r.reason, 'rental_out_of_scope')
})

test('currently listed (priorListingStatus ACTIVE) → not eligible', () => {
  const r = isEligible(
    makeListing({ priorListingStatus: 'ACTIVE', neighborhood: 'Chelsea' }),
    makeBuyer({ neighborhoods: ['Chelsea'] }),
  )
  assert.equal(r.eligible, false)
  assert.equal(r.reason, 'currently_listed')
})

test('wrong neighborhood, no adjacency, different borough → not eligible', () => {
  const r = isEligible(
    makeListing({ neighborhood: 'Chelsea' }), // Manhattan
    makeBuyer({ neighborhoods: ['Park Slope'] }), // Brooklyn, not adjacent
  )
  assert.equal(r.eligible, false)
  assert.equal(r.reason, 'wrong_neighborhood')
})

test('right neighborhood, wrong beds → not eligible', () => {
  const r = isEligible(
    makeListing({ neighborhood: 'Chelsea', beds: 5 }),
    makeBuyer({ neighborhoods: ['Chelsea'], bedsMin: 1, bedsMax: 1 }),
  )
  assert.equal(r.eligible, false)
  assert.equal(r.reason, 'wrong_beds')
})

test('wrong price range → not eligible', () => {
  const r = isEligible(
    makeListing({ neighborhood: 'Chelsea', price: 10_000_000 }),
    makeBuyer({ neighborhoods: ['Chelsea'], priceMax: 1_000_000 }),
  )
  assert.equal(r.eligible, false)
  assert.equal(r.reason, 'wrong_price')
})

test('valid pair → eligible', () => {
  const r = isEligible(
    makeListing({ neighborhood: 'Chelsea', beds: 2, price: 1_500_000 }),
    makeBuyer({ neighborhoods: ['Chelsea'], bedsMin: 2, bedsMax: 3, priceMin: 1_200_000, priceMax: 1_800_000 }),
  )
  assert.equal(r.eligible, true)
})
