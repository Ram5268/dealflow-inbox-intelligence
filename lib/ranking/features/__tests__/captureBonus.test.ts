import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeCaptureBonus } from '../captureBonus'
import { makeAgg } from '../../__tests__/fixtures'

const s = (captureStatus: string) => computeCaptureBonus(makeAgg({ topMatch: { captureStatus } })).score

test('captureBonus by status', () => {
  assert.equal(s('OWN_BOTH_SIDES'), 1.0)
  assert.equal(s('OWN_LISTING_ONLY'), 0.7)
  assert.equal(s('OWN_BUYER_ONLY'), 0.7)
  assert.equal(s('EXTERNAL_BOTH'), 0.4)
})
