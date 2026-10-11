// Brief 41.1 (review F6, F7) — the "why it fits" line never says "few
// alternatives for this buyer" (sales pressure) or names the listing's age,
// says "in budget" only when the price is inside the budget, and a homeowner
// row shows only our own wording (never a name or a figure). Pure: the real
// scorer on test fixtures, no DB.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FIT_KEYS, GENERIC_FIT_REASON, NEVER_NAMED, plainFitReason } from '../fitReason'
import { reasonOf } from '../nightly/select'
import { scorePair } from '../scorer'
import { makeBuyer, makeContext, makeListing } from './fixtures'
import type { MatchFitResult } from '../scorerTypes'

const mf = (contributions: Record<string, number>, scores: Record<string, number>, homeownerSeller = false): MatchFitResult =>
  ({ matchFit: 70, matchFitConfidence: 'HIGH', contributions, unknownFactors: [], scores, homeownerSeller })
const RETIRED = /alternatives|scarcity|uniqueness|fresh|listing age|listing date/i
const now = new Date('2026-10-06T09:00:00Z')

test('how few alternatives the buyer has, and the listing age, are never named', () => {
  assert.ok(NEVER_NAMED.has('substitutionScarcity') && NEVER_NAMED.has('recency'))
  assert.ok(!FIT_KEYS.includes('substitutionScarcity') && !FIT_KEYS.includes('recency'))
  assert.equal(reasonOf(mf({ substitutionScarcity: 50, recency: 20, beds: 30 }, { substitutionScarcity: 1, recency: 1, beds: 1 })), 'Bedroom count')
  assert.equal(reasonOf(mf({ substitutionScarcity: 50, recency: 30, beds: 20 }, { substitutionScarcity: 0.2, recency: 0.1, beds: 1 })), 'Bedroom count')
  assert.equal(reasonOf(mf({ substitutionScarcity: 70, recency: 30 }, { substitutionScarcity: 1, recency: 1 })), GENERIC_FIT_REASON)
})

test('the real scorer never writes them, even for a buyer with almost no alternatives', () => {
  const hoods = ['Park Slope', 'Gowanus', 'Bushwick', null]
  const reasons = new Set<string>()
  for (const [i, count] of [1, 2, 3, 8, 40].entries()) {
    const buyer = makeBuyer({ id: `b${i}`, neighborhoods: ['Park Slope'], priceMin: 1_500_000, priceMax: 2_000_000, bedsMin: 2, bedsMax: 4 })
    const ctx = makeContext({ now, substitutionCounts: new Map([[buyer.id, count]]) })
    for (const [j, price] of [null, 1_800_000, 2_000_000, 2_400_000].entries()) {
      for (const [k, hood] of hoods.entries()) {
        for (const sourceType of ['opportunity', 'contact'] as const) {
          const listing = makeListing({ id: `l${j}${k}${sourceType}`, sourceType, neighborhood: hood, price, beds: 3, createdAt: now })
          const r = scorePair(listing, buyer, ctx)
          if (r.eligibility.eligible) reasons.add(reasonOf(r.matchFit))
        }
      }
    }
  }
  assert.ok(reasons.size > 3, [...reasons].join(' | '))
  for (const r of reasons) assert.doesNotMatch(r, RETIRED, r)
})

test('"in budget" only when the asking price is inside the budget (score 1)', () => {
  const buyer = makeBuyer({ id: 'b1', neighborhoods: ['Park Slope'], priceMin: 1_500_000, priceMax: 2_000_000, bedsMin: 2, bedsMax: 3 })
  const reasonAt = (price: number) => {
    const listing = makeListing({ id: 'o', sourceType: 'opportunity', neighborhood: 'Park Slope', price, beds: 2, createdAt: now })
    const r = scorePair(listing, buyer, makeContext({ now }))
    return { score: r.matchFit.scores?.price, reason: reasonOf(r.matchFit) }
  }
  const inRange = reasonAt(2_000_000)
  assert.equal(inRange.score, 1)
  assert.match(inRange.reason, /in budget/i)
  // 1%, 1.5% and 2% over the buyer's max still score 0.9 or more, but aren't in budget.
  for (const price of [2_020_000, 2_030_000, 2_040_000]) {
    const over = reasonAt(price)
    assert.ok(over.score! >= 0.85 && over.score! < 1, `${price}: ${over.score}`)
    assert.doesNotMatch(over.reason, /budget|price/i, `${price}: ${over.reason}`)
  }
  assert.equal(reasonOf(mf({ price: 50, beds: 50 }, { price: 0.99, beds: 1 })), 'Bedroom count')
  assert.equal(reasonOf(mf({ price: 50, beds: 50 }, { price: 1, beds: 1 })), 'In budget, bedroom count')
})

test('a stored reason is shown without the retired wording', () => {
  assert.equal(plainFitReason('Bedroom count, few alternatives for this buyer'), 'Bedroom count')
  assert.equal(plainFitReason('Few alternatives for this buyer'), GENERIC_FIT_REASON)
  assert.equal(plainFitReason('Right neighborhood, bedroom count, fresh listing'), 'Right neighborhood, bedroom count')
  assert.equal(plainFitReason('Bathrooms; weaker on uniqueness and listing age'), 'Bathrooms')
  assert.equal(plainFitReason('Weaker on listing age and location'), 'Weaker on location')
  assert.equal(plainFitReason('substitutionScarcity + beds + recency'), 'Matched on bedrooms')
  // Older engines' free text about the buyer's lack of alternatives, too.
  assert.equal(plainFitReason('Strong fit: few alternatives in Park Slope at this price'), GENERIC_FIT_REASON)
  // Our current wording is shown as it is.
  assert.equal(plainFitReason('In budget, bedroom count; weaker on location'), 'In budget, bedroom count; weaker on location')
  assert.equal(plainFitReason(GENERIC_FIT_REASON), GENERIC_FIT_REASON)
})

test('a homeowner row shows only our own wording, and never price', () => {
  const home = (r: string) => plainFitReason(r, { homeowner: true })
  // The legacy engine's line names the homeowner; any other text becomes the generic line.
  assert.equal(home('Mojo lead Jane Q Homeowner at 361 Degraw St may match ISO: Investor buyer'), GENERIC_FIT_REASON)
  assert.equal(home('Good block, quiet street, owner open to offers'), GENERIC_FIT_REASON)
  assert.equal(home('goldenHandcuff + Bushwick'), GENERIC_FIT_REASON)
  // Our wording is kept, minus price and the retired words.
  assert.equal(home('Right neighborhood, bedroom count'), 'Right neighborhood, bedroom count')
  assert.equal(home('Right neighborhood, in budget; weaker on price'), 'Right neighborhood')
  assert.equal(home('Bedroom count, few alternatives for this buyer'), 'Bedroom count')
  assert.equal(home('Matched on bedrooms, price'), 'Matched on bedrooms')
  // Showing a line twice gives the same line.
  for (const r of ['Right neighborhood, bedroom count; weaker on property type', 'Matched on bedrooms', 'Weaker on location']) {
    assert.equal(home(home(r)), home(r))
  }
})

test('a figure without "$" never reaches a homeowner line, nor a home value any line', () => {
  for (const r of ['Owner estimate 1,840,000 fits the budget', 'valued near 1840000', 'Owner estimate 1.84M fits', 'Est. $1,840,000']) {
    assert.equal(plainFitReason(r, { homeowner: true }), GENERIC_FIT_REASON, r)
  }
  for (const r of ['Owner estimate 1,840,000 fits the budget', 'Estimated value 1840000, in range', 'Appraised at 1,840,000']) {
    assert.equal(plainFitReason(r), GENERIC_FIT_REASON, r)
  }
  // A listing's own asking price in older text is still shown.
  assert.equal(plainFitReason('Exact Soho 2BR at $4.5M, squarely in budget.'), 'Exact Soho 2BR at $4.5M, squarely in budget.')
  // A scorer key in older free text never is.
  assert.equal(plainFitReason('goldenHandcuff + Bushwick'), GENERIC_FIT_REASON)
})
