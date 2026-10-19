// Brief 44 (PR 4): the buyer-type factor for a seller priced by our value reads the
// chance the real price is under or over its $1.5M / $2M / $5M lines (the spread
// table in sellerPrice.ts), not the value as an exact price. Every other price
// (asking, last asking, an estimate without our marker) keeps the exact lines.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeBuyerArchetypeSituation } from '../features/buyerArchetypeSituation'
import { chancePriceUnder, fitProbability } from '../sellerPrice'
import { scorePair } from '../scorer'
import { makeListing, makeBuyer, makeContext } from './fixtures'

const ours = (value: number, over: Parameters<typeof makeListing>[0] = {}) =>
  makeListing({ id: 's1', sourceType: 'contact', neighborhood: 'Park Slope', price: value, estimatedValue: value, ourEstimate: true, ...over })
const point = (value: number, over: Parameters<typeof makeListing>[0] = {}) =>
  makeListing({ id: 's1', sourceType: 'contact', neighborhood: 'Park Slope', price: value, estimatedValue: value, ...over })
const score = (l: ReturnType<typeof makeListing>, arch: string) => computeBuyerArchetypeSituation(l, makeBuyer({ buyerArchetype: arch })).score
const near = (actual: number, expected: number, tol = 1e-9) => assert.ok(Math.abs(actual - expected) <= tol, `expected ≈${expected}, got ${actual}`)

test('chancePriceUnder reads the same spread table as fitProbability', () => {
  for (const est of [600_000, 1_000_000, 1_400_000, 1_500_000, 1_900_000, 2_500_000, 4_000_000, 7_000_000]) {
    for (const line of [1_500_000, 2_000_000, 5_000_000]) {
      near(chancePriceUnder(est, line), fitProbability(est, null, line / 1.15))
    }
  }
  near(chancePriceUnder(1_500_000, 1_500_000), 0.4571, 0.0001) // the median sale lands a little above our value
  assert.equal(chancePriceUnder(500_000, 5_000_000), 1)
  assert.equal(chancePriceUnder(20_000_000, 1_500_000), 0)
  for (const bad of [0, -1, NaN, Infinity]) assert.equal(chancePriceUnder(bad, 1_500_000), 0, `${bad}`)
})

test('first-time FHA buyer: 0.9 if under $1.5M, 0.3 if over, weighted by the chance of each', () => {
  for (const est of [900_000, 1_300_000, 1_450_000, 1_550_000, 1_800_000, 2_500_000]) {
    const p = chancePriceUnder(est, 1_500_000)
    near(score(ours(est), 'FIRST_TIME_FHA'), 0.9 * p + 0.3 * (1 - p))
  }
  // Near the line it is neither the full 0.9 nor 0.3 any more.
  const s = score(ours(1_450_000), 'FIRST_TIME_FHA')
  assert.ok(s > 0.3 && s < 0.9, `${s}`)
  // Distress still comes first.
  assert.equal(score(ours(1_000_000, { preForeclosureStatus: 'LIS_PENDENS' }), 'FIRST_TIME_FHA'), 0.2)
})

test('luxury buyers: 1.0 over $5M, 0.6 for $2M-$5M, 0.2 under $2M, weighted by the chance of each', () => {
  for (const est of [1_000_000, 1_900_000, 2_100_000, 3_500_000, 4_800_000, 5_200_000, 9_000_000]) {
    const under2 = chancePriceUnder(est, 2_000_000)
    const under5 = chancePriceUnder(est, 5_000_000)
    const expected = 1.0 * (1 - under5) + 0.6 * (under5 - under2) + 0.2 * under2
    near(score(ours(est), 'LUXURY_ALL_CASH'), expected)
    near(score(ours(est), 'LUXURY_FINANCED'), expected)
    // The financed buyer keeps its distress cap.
    near(score(ours(est, { preForeclosureStatus: 'AUCTION_SCHEDULED' }), 'LUXURY_FINANCED'), Math.min(expected, 0.5))
  }
  near(score(ours(9_000_000), 'LUXURY_ALL_CASH'), 0.9827, 0.0005) // 1 in 27 such homes would sell under $5M
})

test('the chance view moves smoothly with our value: no jump at the lines', () => {
  let prevFha = Infinity
  let prevLux = -Infinity
  for (let est = 800_000; est <= 7_000_000; est += 50_000) {
    const fha = score(ours(est), 'FIRST_TIME_FHA')
    const lux = score(ours(est), 'LUXURY_ALL_CASH')
    assert.ok(fha <= prevFha + 1e-12, `FHA rises at ${est}`)
    assert.ok(lux >= prevLux - 1e-12, `luxury falls at ${est}`)
    if (Number.isFinite(prevFha)) assert.ok(prevFha - fha < 0.05, `FHA jumps at ${est}`)
    if (Number.isFinite(prevLux)) assert.ok(lux - prevLux < 0.05, `luxury jumps at ${est}`)
    prevFha = fha
    prevLux = lux
  }
})

test("point prices keep today's exact lines: asking, last asking, and estimates without our marker", () => {
  assert.equal(score(point(1_450_000), 'FIRST_TIME_FHA'), 0.9)
  assert.equal(score(point(1_550_000), 'FIRST_TIME_FHA'), 0.3)
  assert.equal(score(point(1_900_000), 'LUXURY_ALL_CASH'), 0.2)
  assert.equal(score(point(2_100_000), 'LUXURY_FINANCED'), 0.6)
  assert.equal(score(point(5_000_000), 'LUXURY_ALL_CASH'), 1.0)
  // The marker on an expired listing with a last asking price, or on an email listing, changes nothing.
  const lastAsk = ours(1_450_000, { priorListingStatus: 'EXPIRED', priorListingPrice: 1_700_000 })
  assert.equal(score(lastAsk, 'FIRST_TIME_FHA'), 0.9)
  const listing = makeListing({ id: 'o1', sourceType: 'opportunity', price: 2_100_000, ourEstimate: true })
  assert.equal(score(listing, 'LUXURY_ALL_CASH'), 0.6)
  // No price at all: as today.
  assert.equal(score(makeListing({ sourceType: 'contact' }), 'FIRST_TIME_FHA'), 0.5)
  assert.equal(score(makeListing({ sourceType: 'contact' }), 'LUXURY_ALL_CASH'), 0.5)
})

test('the marker changes nothing but the buyer-type factor, and only for FHA and luxury buyers', () => {
  const ctx = makeContext({ now: new Date('2026-10-18T12:00:00Z'), substitutionCounts: new Map([['b1', 12]]) })
  const archetypes = [null, 'CASH_BUYER', 'EXCHANGE_1031', 'TRADITIONAL_FINANCING', 'INVESTOR_LANDLORD', 'FIRST_TIME_FHA', 'LUXURY_ALL_CASH', 'LUXURY_FINANCED', 'SOMETHING_NEW']
  const priceSensitive = new Set(['FIRST_TIME_FHA', 'LUXURY_ALL_CASH', 'LUXURY_FINANCED'])
  for (const est of [1_200_000, 1_600_000, 2_300_000]) {
    for (const arch of archetypes) {
      const b = makeBuyer({ id: 'b1', neighborhoods: ['Park Slope'], priceMin: 1_000_000, priceMax: 2_000_000, bedsMin: 3, buyerArchetype: arch })
      const base = { beds: 3, unitCount: 1, propertyTypeDetail: 'Single Family Residence', propertyType: 'Single Family Residence' }
      const withMarker = scorePair(ours(est, base), b, ctx)
      const without = scorePair(point(est, base), b, ctx)
      const { buyerArchetypeSituation: a1, ...rest1 } = withMarker.matchFit.scores ?? {}
      const { buyerArchetypeSituation: a2, ...rest2 } = without.matchFit.scores ?? {}
      assert.deepEqual(rest1, rest2, `${arch} at ${est}`)
      assert.deepEqual(withMarker.eligibility, without.eligibility)
      if (priceSensitive.has(arch!)) assert.notEqual(a1, a2, `${arch} at ${est}`)
      else assert.deepEqual(withMarker, without, `${arch} at ${est}`)
    }
  }
})
