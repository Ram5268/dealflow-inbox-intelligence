import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MIN_MATCH_FIT, reasonOf, tierOf, topForSeller, toMatchRow, type Candidate } from '../select'

const c = (buyerId: string, matchFit: number): Candidate => ({
  sellerId: 's1', buyerId, counterpartType: 'opportunity', captureStatus: 'EXTERNAL_BOTH',
  matchFit: { matchFit, matchFitConfidence: 'LOW', contributions: { beds: 50, neighborhood: 30, recency: 15, tenure: 5 }, unknownFactors: ['price'] },
})

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
  assert.equal(reasonOf({ beds: 50, neighborhood: 30, recency: 15, tenure: 5 }), 'beds + neighborhood + recency')
})

test('toMatchRow carries the scorer outputs', () => {
  assert.deepEqual(toMatchRow(c('b1', 83)), {
    opportunityId: 's1', counterpartId: 'b1', counterpartType: 'opportunity', score: 83, tier: 'HOT',
    reason: 'beds + neighborhood + recency', captureStatus: 'EXTERNAL_BOTH', matchFitConfidence: 'LOW',
    contributions: { beds: 50, neighborhood: 30, recency: 15, tenure: 5 }, unknownFactors: ['price'],
  })
})
