import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sellerPrice, fitProbability, MIN_FIT_PROBABILITY } from '../sellerPrice'
import { isEligible, isSellerPriceEligible } from '../eligibility'
import { computePrice, estimateScore } from '../features/price'
import { precomputeSubstitutionCounts } from '../compsCache'
import { makeListing, makeBuyer } from './fixtures'

const seller = (over: Parameters<typeof makeListing>[0] = {}) =>
  makeListing({ sourceType: 'contact', neighborhood: 'Park Slope', ...over })
const buyer = (over: Parameters<typeof makeBuyer>[0] = {}) =>
  makeBuyer({ neighborhoods: ['Park Slope'], ...over })
const near = (actual: number, expected: number, tol = 0.0015) =>
  assert.ok(Math.abs(actual - expected) <= tol, `expected ≈${expected}, got ${actual}`)

test('cutoff is a 10% chance', () => {
  assert.equal(MIN_FIT_PROBABILITY, 0.1)
})

test('listing opportunity → its asking price', () => {
  assert.deepEqual(sellerPrice(makeListing({ price: 1_500_000 })), { price: 1_500_000, basis: 'asking' })
  assert.equal(sellerPrice(makeListing({ price: null })), null)
})

test('seller contact with only an estimate → estimate', () => {
  assert.deepEqual(sellerPrice(seller({ price: 2_000_000 })), { price: 2_000_000, basis: 'estimate' })
})

test('expired or withdrawn listing → last asking price beats the estimate', () => {
  for (const status of ['EXPIRED', 'WITHDRAWN']) {
    const sp = sellerPrice(seller({ price: 1_500_000, priorListingStatus: status, priorListingPrice: 1_795_000 }))
    assert.deepEqual(sp, { price: 1_795_000, basis: 'last_asking' })
  }
})

test('a SOLD or never-listed prior listing price is ignored → estimate', () => {
  for (const status of ['SOLD', 'NEVER_LISTED', null]) {
    assert.equal(sellerPrice(seller({ price: 1_000_000, priorListingStatus: status, priorListingPrice: 600_000 }))?.basis, 'estimate')
  }
})

test('no estimate (null or 0) and no expired price → unknown, pair kept', () => {
  assert.equal(sellerPrice(seller({ price: null })), null)
  assert.equal(sellerPrice(seller({ price: 0 })), null)
  assert.equal(sellerPrice(seller({ price: null, priorListingStatus: 'EXPIRED', priorListingPrice: null })), null)
  assert.equal(isSellerPriceEligible(seller({ price: null }), 1_000_000, 2_000_000), true)
})

test('fitProbability: back-test examples for a buyer with up to $1.6M', () => {
  near(fitProbability(1_500_000, null, 1_600_000), 0.814)
  near(fitProbability(2_000_000, null, 1_600_000), 0.307)
  near(fitProbability(2_400_000, null, 1_600_000), 0.128)
  near(fitProbability(2_600_000, null, 1_600_000), 0.085)
  near(fitProbability(3_000_000, null, 1_600_000), 0.046)
})

test('fitProbability: back-test examples for a buyer with $1.2M-$1.6M', () => {
  near(fitProbability(1_000_000, 1_200_000, 1_600_000), 0.490)
  near(fitProbability(1_400_000, 1_200_000, 1_600_000), 0.786)
  near(fitProbability(1_800_000, 1_200_000, 1_600_000), 0.461)
  near(fitProbability(2_200_000, 1_200_000, 1_600_000), 0.168)
})

test('fitProbability: far inside an open-ended budget → 1, and it falls as the estimate rises', () => {
  assert.equal(fitProbability(1_000_000, null, 2_000_000), 1)
  assert.equal(fitProbability(1_000_000, 0, 2_000_000), 1) // a 0 minimum means no minimum
  let prev = 1
  for (let e = 1_500_000; e <= 4_000_000; e += 100_000) {
    const p = fitProbability(e, null, 1_600_000)
    assert.ok(p <= prev, `not decreasing at ${e}`)
    prev = p
  }
})

test('estimate 2.4M vs buyer max 1.6M → eligible (13% chance); 2.6M → not (8.5%)', () => {
  assert.equal(isEligible(seller({ price: 2_400_000 }), buyer({ priceMax: 1_600_000 })).eligible, true)
  assert.deepEqual(isEligible(seller({ price: 2_600_000 }), buyer({ priceMax: 1_600_000 })), { eligible: false, reason: 'wrong_price' })
})

test('estimate far below the buyer minimum → not eligible', () => {
  const r = isEligible(seller({ price: 1_000_000 }), buyer({ priceMin: 2_400_000, priceMax: 3_000_000 }))
  assert.deepEqual(r, { eligible: false, reason: 'wrong_price' })
})

test('expired seller is judged on the last asking price, not the estimate', () => {
  // The estimate (1.5M) has an 81% chance of fitting a 1.6M budget, but the owner last asked 1.9M (> 1.6M × 1.15).
  const r = isEligible(
    seller({ price: 1_500_000, priorListingStatus: 'EXPIRED', priorListingPrice: 1_900_000 }),
    buyer({ priceMax: 1_600_000 }),
  )
  assert.deepEqual(r, { eligible: false, reason: 'wrong_price' })
})

test('listing opportunities keep the old ±15% gate', () => {
  assert.equal(isEligible(makeListing({ neighborhood: 'Park Slope', price: 1_900_000 }), buyer({ priceMax: 1_600_000 })).eligible, false)
  assert.equal(isEligible(makeListing({ neighborhood: 'Park Slope', price: 1_800_000 }), buyer({ priceMax: 1_600_000 })).eligible, true)
})

test('price feature: an estimate scores the evidence its chance carries, same confidence rule as known prices', () => {
  const b = buyer({ priceMin: 1_200_000, priceMax: 1_600_000 })
  const s = computePrice(seller({ price: 1_400_000 }), b) // 78.6% chance
  assert.equal(s.confidence, 'HIGH')
  near(s.score, 0.942, 0.001)
  assert.equal(computePrice(seller({ price: 1_400_000 }), buyer({ priceMax: 1_600_000 })).confidence, 'MEDIUM') // one bound
  assert.deepEqual(computePrice(makeListing({ price: 1_500_000 }), b), { key: 'price', score: 1, confidence: 'HIGH' })
  const lastAsk = seller({ price: 2_200_000, priorListingStatus: 'EXPIRED', priorListingPrice: 1_500_000 })
  assert.deepEqual(computePrice(lastAsk, b), { key: 'price', score: 1, confidence: 'HIGH' })
  assert.deepEqual(computePrice(seller({ price: null }), b), { key: 'price', score: 0.5, confidence: 'LOW' })
})

test('price feature ranks the closer estimate higher (a flat range would tie them)', () => {
  const b = buyer({ priceMin: 1_200_000, priceMax: 1_600_000 })
  const close = computePrice(seller({ price: 1_400_000 }), b).score
  const high = computePrice(seller({ price: 1_800_000 }), b).score
  const higher = computePrice(seller({ price: 2_200_000 }), b).score
  assert.ok(close > high && high > higher, `${close} > ${high} > ${higher}`)
})

test('estimateScore: no chance → 0, even → 0.5, certain → 1, rising in between', () => {
  near(estimateScore(0), 0, 1e-9)
  near(estimateScore(0.5), 0.5, 1e-9)
  near(estimateScore(1), 1, 1e-9)
  let prev = -1
  for (let i = 0; i <= 20; i++) {
    const s = estimateScore(i / 20)
    assert.ok(s >= prev, `not rising at ${i / 20}`)
    prev = s
  }
})

test('single-price budget (min = max): the best chance is about even', () => {
  near(fitProbability(1_500_000, 1_600_000, 1_600_000), 0.527, 0.001)
  assert.equal(isEligible(seller({ price: 1_500_000 }), buyer({ priceMin: 1_600_000, priceMax: 1_600_000 })).eligible, true)
})

test('status spelled "Expired" or " withdrawn " still uses the last asking price', () => {
  for (const status of ['Expired', ' withdrawn ']) {
    assert.equal(sellerPrice(seller({ price: 1_500_000, priorListingStatus: status, priorListingPrice: 1_795_000 }))?.basis, 'last_asking')
  }
})

test('EXPIRED with no usable last asking price falls back to the estimate', () => {
  for (const ask of [0, -1, NaN, Infinity]) {
    assert.equal(sellerPrice(seller({ price: 1_500_000, priorListingStatus: 'EXPIRED', priorListingPrice: ask }))?.basis, 'estimate')
  }
})

test('unusable estimates count as no price', () => {
  for (const est of [NaN, Infinity, -1]) assert.equal(sellerPrice(seller({ price: est })), null)
})

test('unusable budgets give a 0% chance and never a NaN score', () => {
  const bad: Array<[number | null, number | null]> = [[null, -5], [null, 0], [null, NaN], [NaN, 1_600_000], [2_000_000, 1_000_000]]
  for (const [min, max] of bad) {
    assert.equal(fitProbability(1_500_000, min, max), 0, `chance for ${min}-${max}`)
    assert.equal(isSellerPriceEligible(seller({ price: 1_500_000 }), min, max), false, `eligible for ${min}-${max}`)
    const s = computePrice(seller({ price: 1_500_000 }), buyer({ priceMin: min, priceMax: max }))
    assert.ok(Number.isFinite(s.score), `score for ${min}-${max}: ${s.score}`)
  }
})

test('scarcity counts use the same rule', () => {
  const b = buyer({ id: 'b1', priceMax: 1_600_000 })
  const counts = precomputeSubstitutionCounts([b], [
    seller({ id: 's1', price: 2_400_000 }), // 13% chance → counted
    seller({ id: 's2', price: 2_600_000 }), // 8.5% → not counted
    seller({ id: 's3', price: 1_500_000, priorListingStatus: 'EXPIRED', priorListingPrice: 1_900_000 }), // last ask too high
  ])
  assert.equal(counts.get('b1'), 1)
})
