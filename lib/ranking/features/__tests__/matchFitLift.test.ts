import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeMatchFitLift } from '../matchFitLift'
import { makeAgg } from '../../__tests__/fixtures'

test('matchFitLift = matchFit/100, HIGH', () => {
  assert.deepEqual(computeMatchFitLift(makeAgg({ topMatch: { matchFit: 100 } })), { key: 'matchFitLift', score: 1.0, confidence: 'HIGH' })
  assert.deepEqual(computeMatchFitLift(makeAgg({ topMatch: { matchFit: 50 } })), { key: 'matchFitLift', score: 0.5, confidence: 'HIGH' })
  assert.deepEqual(computeMatchFitLift(makeAgg({ topMatch: { matchFit: 0 } })), { key: 'matchFitLift', score: 0.0, confidence: 'HIGH' })
})
