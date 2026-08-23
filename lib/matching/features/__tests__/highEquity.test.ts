import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeHighEquity } from '../highEquity'
import { makeListing } from '../../__tests__/fixtures'

const withRatio = (ratio: number) => makeListing({ estimatedValue: 1_000_000, equityBalance: ratio * 1_000_000 })

test('highEquity scoring table', () => {
  assert.equal(computeHighEquity(withRatio(0.8)).score, 1.0)
  assert.equal(computeHighEquity(withRatio(0.4)).score, 0.5)
  assert.equal(computeHighEquity(withRatio(0.05)).score, 0.1)
  const unknown = computeHighEquity(makeListing({ equityBalance: null, estimatedValue: null }))
  assert.equal(unknown.score, 0.5)
  assert.equal(unknown.confidence, 'LOW')
})
