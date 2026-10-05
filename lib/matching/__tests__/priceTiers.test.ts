import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scorePair, capForPriceChance } from '../scorer'
import { tierOf, MIN_MATCH_FIT } from '../nightly/select'
import { makeListing, makeBuyer, makeContext } from './fixtures'

// Full-scorer checks for sellers known only by our estimate: a near-certain price fit
// scores like a known in-budget price, the tier follows the chance the buyer can
// afford it, and known prices are never capped.
const ctx = makeContext({ now: new Date('2026-10-05T12:00:00Z'), substitutionCounts: new Map([['b1', 20]]) })
const seller = (est: number | null, over: Parameters<typeof makeListing>[0] = {}) => makeListing({
  id: 's1', sourceType: 'contact', neighborhood: 'Bedford-Stuyvesant', borough: 'Brooklyn',
  price: est, estimatedValue: est, beds: 3, baths: 2, propertyType: 'Duplex', propertyTypeDetail: 'Duplex',
  unitCount: 2, yearBuilt: 1899, buildingSqft: 2400, lastSaleDate: new Date('2008-05-01'),
  ownerOccupied: true, createdAt: new Date('2026-09-01'), ...over,
})
const upTo = makeBuyer({ id: 'b1', neighborhoods: ['Bedford-Stuyvesant'], priceMax: 1_600_000, bedsMin: 3 })
const fit = (l: ReturnType<typeof seller>) => scorePair(l, upTo, ctx)

test('estimate well inside the budget (99% chance) is HOT, same as a known price there', () => {
  const r = fit(seller(1_000_000))
  assert.equal(r.eligibility.eligible, true)
  assert.equal(tierOf(r.matchFit.matchFit), 'HOT')
  const known = scorePair(makeListing({ ...seller(1_000_000), sourceType: 'opportunity' }), upTo, ctx)
  assert.ok(Math.abs(r.matchFit.matchFit - known.matchFit.matchFit) <= 2, `${r.matchFit.matchFit} vs ${known.matchFit.matchFit}`)
})

test('31% chance → at most WARM', () => {
  const r = fit(seller(2_000_000))
  assert.equal(r.eligibility.eligible, true)
  assert.equal(tierOf(r.matchFit.matchFit), 'WARM')
})

test('13% chance → kept, but only POSSIBLE', () => {
  const r = fit(seller(2_400_000))
  assert.equal(r.eligibility.eligible, true)
  assert.equal(tierOf(r.matchFit.matchFit), 'POSSIBLE')
  assert.ok(r.matchFit.matchFit >= MIN_MATCH_FIT, `${r.matchFit.matchFit}`)
})

test('under a 10% chance → not matched', () => {
  assert.deepEqual(fit(seller(2_600_000)).eligibility, { eligible: false, reason: 'wrong_price' })
})

test('likely fit in an adjacent area with unknown beds stays above the nightly cut-off', () => {
  const r = fit(seller(1_500_000, { neighborhood: 'Clinton Hill', beds: null, baths: null })) // 81% chance
  assert.ok(r.matchFit.matchFit >= MIN_MATCH_FIT, `${r.matchFit.matchFit}`)
})

test('known and unknown prices are never capped', () => {
  const mf = { matchFit: 95, matchFitConfidence: 'HIGH' as const, contributions: {}, unknownFactors: [] }
  const listing = makeListing({ price: 3_000_000 }) // an email listing's asking price
  assert.equal(capForPriceChance(mf, listing, upTo), mf)
  assert.equal(capForPriceChance(mf, seller(null), upTo), mf)
  assert.equal(capForPriceChance(mf, seller(2_400_000, { priorListingStatus: 'EXPIRED', priorListingPrice: 1_500_000 }), upTo), mf)
  assert.equal(capForPriceChance(mf, seller(2_400_000), makeBuyer({ id: 'b1' })), mf) // buyer gave no budget
})

test('cap levels: under 25% → 64, under 50% → 79', () => {
  const mf = { matchFit: 95, matchFitConfidence: 'HIGH' as const, contributions: {}, unknownFactors: [] }
  assert.equal(capForPriceChance(mf, seller(2_400_000), upTo).matchFit, 64) // 13%
  assert.equal(capForPriceChance(mf, seller(2_000_000), upTo).matchFit, 79) // 31%
  assert.equal(capForPriceChance(mf, seller(1_500_000), upTo).matchFit, 95) // 81%
})
