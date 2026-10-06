import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MIN_MATCH_FIT, reasonOf, tierOf, topForSeller, toMatchRow, type Candidate } from '../select'
import type { MatchFitResult } from '../../scorerTypes'

const c = (buyerId: string, matchFit: number): Candidate => ({
  sellerId: 's1', buyerId, counterpartType: 'opportunity', captureStatus: 'EXTERNAL_BOTH',
  matchFit: {
    matchFit, matchFitConfidence: 'LOW', contributions: { beds: 50, neighborhood: 30, recency: 15, tenure: 5 }, unknownFactors: ['price'],
    helped: ['beds', 'neighborhood', 'recency'], hurt: ['tenure'], priceFromEstimate: false,
  },
})
const mf = (contributions: Record<string, number>, helped: string[], hurt: string[] = [], priceFromEstimate = false): MatchFitResult =>
  ({ matchFit: 70, matchFitConfidence: 'HIGH', contributions, unknownFactors: [], helped, hurt, priceFromEstimate })

test('pairs below the threshold are dropped', () => {
  assert.equal(MIN_MATCH_FIT, 50)
  assert.deepEqual(topForSeller([c('a', 49), c('b', 50), c('c', 12)]).map(x => x.buyerId), ['b'])
})

test('top 10 per seller, best first; ties by buyer id ascending', () => {
  const many = Array.from({ length: 14 }, (_, i) => c(`b${String(i).padStart(2, '0')}`, 60 + (i % 3)))
  const kept = topForSeller(many)
  assert.equal(kept.length, 10)
  assert.deepEqual(kept.map(x => x.matchFit.matchFit), [62, 62, 62, 62, 61, 61, 61, 61, 61, 60])
  assert.deepEqual(kept.slice(0, 4).map(x => x.buyerId), ['b02', 'b05', 'b08', 'b11'])
})

test('tiers and reason', () => {
  assert.deepEqual([tierOf(80), tierOf(79), tierOf(65), tierOf(64), tierOf(50)], ['HOT', 'WARM', 'WARM', 'POSSIBLE', 'POSSIBLE'])
  // Brief 41 (H7): plain English, the fit features that helped (top 3), never a
  // seller-motivation key.
  assert.equal(reasonOf(mf({ beds: 50, neighborhood: 30, recency: 15, tenure: 5 }, ['beds', 'neighborhood', 'recency', 'tenure'])), 'Bedroom count, right neighborhood, fresh listing')
  assert.equal(reasonOf(mf({ preForeclosure: 60, highEquity: 25, neighborhood: 10, absenteeOwner: 5 }, ['preForeclosure', 'highEquity', 'neighborhood', 'absenteeOwner'])), 'Right neighborhood')
  assert.equal(reasonOf(mf({ tenure: 70, vacancy: 30 }, ['tenure', 'vacancy'])), "Fits the buyer's criteria")
})

test('a drawback is never called a strength (Brief 41 review)', () => {
  // Price and neighborhood pulled the score down: they're named as weaker, not as fits.
  const r = reasonOf(mf({ price: 40, neighborhood: 25, beds: 20, baths: 10, preForeclosure: 5 }, ['beds', 'baths', 'preForeclosure'], ['price', 'neighborhood']))
  assert.equal(r, 'Bedroom count, bathrooms; weaker on price and location')
  assert.doesNotMatch(r, /in budget|right neighborhood/i)
  // Only drawbacks: just those.
  assert.equal(reasonOf(mf({ neighborhood: 70, beds: 30 }, [], ['neighborhood', 'beds'])), 'Weaker on location and bedrooms')
  // A drawback with a small share isn't worth naming.
  assert.equal(reasonOf(mf({ beds: 60, neighborhood: 35, baths: 5 }, ['beds', 'neighborhood'], ['baths'])), 'Bedroom count, right neighborhood')
})

test('price is never named when the seller\'s only price is our estimate', () => {
  assert.equal(reasonOf(mf({ price: 50, beds: 30, neighborhood: 20 }, ['price', 'beds', 'neighborhood'], [], true)), 'Bedroom count, right neighborhood')
  assert.equal(reasonOf(mf({ price: 50, beds: 30, neighborhood: 20 }, ['beds', 'neighborhood'], ['price'], true)), 'Bedroom count, right neighborhood')
  // A real asking price (or an expired listing's last asking price) is named.
  assert.equal(reasonOf(mf({ price: 50, beds: 30, neighborhood: 20 }, ['beds', 'neighborhood'], ['price'])), 'Bedroom count, right neighborhood; weaker on price')
})

test('toMatchRow carries the scorer outputs', () => {
  assert.deepEqual(toMatchRow(c('b1', 83)), {
    opportunityId: 's1', counterpartId: 'b1', counterpartType: 'opportunity', score: 83, tier: 'HOT',
    reason: 'Bedroom count, right neighborhood, fresh listing', captureStatus: 'EXTERNAL_BOTH', matchFitConfidence: 'LOW',
    contributions: { beds: 50, neighborhood: 30, recency: 15, tenure: 5 }, unknownFactors: ['price'],
  })
})
