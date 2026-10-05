import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sellerPriceRange, nearestPrice, priceForBuyer, ESTIMATE_BAND } from '../sellerPrice'
import { isEligible } from '../eligibility'
import { computePrice } from '../features/price'
import { precomputeSubstitutionCounts } from '../compsCache'
import { makeListing, makeBuyer } from './fixtures'

const seller = (over: Parameters<typeof makeListing>[0] = {}) =>
  makeListing({ sourceType: 'contact', neighborhood: 'Park Slope', ...over })
const buyer = (over: Parameters<typeof makeBuyer>[0] = {}) =>
  makeBuyer({ neighborhoods: ['Park Slope'], ...over })

test('band is ±25%', () => {
  assert.equal(ESTIMATE_BAND, 0.25)
})

test('listing opportunity → its asking price as a point', () => {
  assert.deepEqual(sellerPriceRange(makeListing({ price: 1_500_000 })), { low: 1_500_000, high: 1_500_000, basis: 'asking' })
  assert.equal(sellerPriceRange(makeListing({ price: null })), null)
})

test('seller contact with only an estimate → ±25% range', () => {
  assert.deepEqual(sellerPriceRange(seller({ price: 2_000_000 })), { low: 1_500_000, high: 2_500_000, basis: 'estimate' })
})

test('expired or withdrawn listing → last asking price beats the estimate', () => {
  for (const status of ['EXPIRED', 'WITHDRAWN']) {
    const r = sellerPriceRange(seller({ price: 1_500_000, priorListingStatus: status, priorListingPrice: 1_795_000 }))
    assert.deepEqual(r, { low: 1_795_000, high: 1_795_000, basis: 'last_asking' })
  }
})

test('a SOLD or never-listed prior listing price is ignored → estimate range', () => {
  for (const status of ['SOLD', 'NEVER_LISTED', null]) {
    const r = sellerPriceRange(seller({ price: 1_000_000, priorListingStatus: status, priorListingPrice: 600_000 }))
    assert.equal(r?.basis, 'estimate')
  }
})

test('no estimate (null or 0) and no expired price → unknown', () => {
  assert.equal(sellerPriceRange(seller({ price: null })), null)
  assert.equal(sellerPriceRange(seller({ price: 0 })), null)
  assert.equal(sellerPriceRange(seller({ price: null, priorListingStatus: 'EXPIRED', priorListingPrice: null })), null)
})

test('nearestPrice picks the point of the range closest to the budget', () => {
  const r = { low: 1_500_000, high: 2_500_000, basis: 'estimate' as const }
  assert.equal(nearestPrice(r, 1_000_000, 1_200_000), 1_500_000) // range above budget → its low end
  assert.equal(nearestPrice(r, 3_000_000, 4_000_000), 2_500_000) // range below budget → its high end
  assert.equal(nearestPrice(r, 1_800_000, 2_000_000), 1_800_000) // overlap → inside the budget
  assert.equal(nearestPrice(r, null, 2_000_000), 1_500_000) // max only
  assert.equal(nearestPrice(r, 2_000_000, null), 2_000_000) // min only
})

test('priceForBuyer: unknown seller price stays null (pair kept, as before)', () => {
  assert.equal(priceForBuyer(seller({ price: null }), 1_000_000, 2_000_000), null)
})

test('estimate 2.4M vs buyer max 1.6M → eligible (range low 1.8M is within the 15% tolerance)', () => {
  // The old point gate rejected this: 2.4M > 1.6M × 1.15 = 1.84M.
  const r = isEligible(seller({ price: 2_400_000 }), buyer({ priceMax: 1_600_000 }))
  assert.equal(r.eligible, true)
})

test('estimate 2.6M vs buyer max 1.6M → not eligible (range low 1.95M > 1.84M)', () => {
  const r = isEligible(seller({ price: 2_600_000 }), buyer({ priceMax: 1_600_000 }))
  assert.deepEqual(r, { eligible: false, reason: 'wrong_price' })
})

test('estimate far below the buyer minimum → not eligible', () => {
  const r = isEligible(seller({ price: 1_000_000 }), buyer({ priceMin: 2_000_000, priceMax: 3_000_000 }))
  assert.deepEqual(r, { eligible: false, reason: 'wrong_price' }) // range high 1.25M < 2M × 0.85 = 1.7M
})

test('expired seller is judged on the last asking price, not the estimate', () => {
  // The estimate (1.5M) would fit a 1.6M budget, but the owner last asked 1.9M (> 1.84M).
  const r = isEligible(
    seller({ price: 1_500_000, priorListingStatus: 'EXPIRED', priorListingPrice: 1_900_000 }),
    buyer({ priceMax: 1_600_000 }),
  )
  assert.deepEqual(r, { eligible: false, reason: 'wrong_price' })
})

test('listing opportunities keep the old ±15% point gate', () => {
  assert.equal(isEligible(makeListing({ neighborhood: 'Park Slope', price: 1_900_000 }), buyer({ priceMax: 1_600_000 })).eligible, false)
  assert.equal(isEligible(makeListing({ neighborhood: 'Park Slope', price: 1_800_000 }), buyer({ priceMax: 1_600_000 })).eligible, true)
})

test('price feature: an estimate never scores above MEDIUM confidence', () => {
  const b = buyer({ priceMin: 1_500_000, priceMax: 2_000_000 })
  assert.deepEqual(computePrice(seller({ price: 2_200_000 }), b), { key: 'price', score: 1, confidence: 'MEDIUM' })
  assert.deepEqual(computePrice(makeListing({ price: 1_800_000 }), b), { key: 'price', score: 1, confidence: 'HIGH' })
  const lastAsk = seller({ price: 2_200_000, priorListingStatus: 'EXPIRED', priorListingPrice: 1_800_000 })
  assert.deepEqual(computePrice(lastAsk, b), { key: 'price', score: 1, confidence: 'HIGH' })
  assert.deepEqual(computePrice(seller({ price: null }), b), { key: 'price', score: 0.5, confidence: 'LOW' })
})

test('price feature: an estimate range partly past the budget scores on its nearest end', () => {
  // Range 1.875M-3.125M vs max 1.6M: nearest point 1.875M is 0.275M over; tolerance 0.15 × 1.6M = 0.24M → 0.
  assert.equal(computePrice(seller({ price: 2_500_000 }), buyer({ priceMax: 1_600_000 })).score, 0)
  // Range 1.65M-2.75M: 0.05M over → 1 - 0.05/0.24 ≈ 0.79.
  const s = computePrice(seller({ price: 2_200_000 }), buyer({ priceMax: 1_600_000 })).score
  assert.ok(Math.abs(s - (1 - 50_000 / 240_000)) < 1e-9, `got ${s}`)
})

test('scarcity counts use the same range rule', () => {
  const b = buyer({ id: 'b1', priceMax: 1_600_000 })
  const counts = precomputeSubstitutionCounts([b], [
    seller({ id: 's1', price: 2_400_000 }), // estimate range reaches the budget → counted
    seller({ id: 's2', price: 2_600_000 }), // out of reach → not counted
    seller({ id: 's3', price: 1_500_000, priorListingStatus: 'EXPIRED', priorListingPrice: 1_900_000 }), // last ask too high
  ])
  assert.equal(counts.get('b1'), 1)
})
