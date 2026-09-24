import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeMatchFitConfidenceLift } from '../matchFitConfidenceLift'
import { makeAgg } from '../../__tests__/fixtures'

const s = (matchFitConfidence: 'HIGH' | 'MEDIUM' | 'LOW') =>
  computeMatchFitConfidenceLift(makeAgg({ topMatch: { matchFitConfidence } })).score

test('matchFitConfidenceLift by confidence', () => {
  assert.equal(s('HIGH'), 1.0)
  assert.equal(s('MEDIUM'), 0.6)
  assert.equal(s('LOW'), 0.3)
})
