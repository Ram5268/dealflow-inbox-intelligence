import { test } from 'node:test'
import assert from 'node:assert/strict'
import { composeMatchFit } from '../scorer'
import type { FeatureResult } from '../scorerTypes'

const f = (key: string, score: number, confidence: 'HIGH' | 'MEDIUM' | 'LOW'): FeatureResult => ({ key, score, confidence })

test('empty features array → neutral 50, no crash', () => {
  const r = composeMatchFit([])
  assert.equal(r.matchFit, 50)
  assert.deepEqual(r.contributions, {})
  assert.deepEqual(r.unknownFactors, [])
})

test('all HIGH score=1.0 → matchFit >= 95', () => {
  const r = composeMatchFit([f('neighborhood', 1, 'HIGH'), f('price', 1, 'HIGH'), f('beds', 1, 'HIGH')])
  assert.ok(r.matchFit >= 95, `got ${r.matchFit}`)
})

test('all HIGH score=0.0 → matchFit <= 5', () => {
  const r = composeMatchFit([f('neighborhood', 0, 'HIGH'), f('price', 0, 'HIGH')])
  assert.ok(r.matchFit <= 5, `got ${r.matchFit}`)
})

test('all HIGH score=0.5 → matchFit == 50', () => {
  const r = composeMatchFit([f('neighborhood', 0.5, 'HIGH'), f('price', 0.5, 'HIGH')])
  assert.equal(r.matchFit, 50)
})

test('all LOW → matchFit 50 AND all keys in unknownFactors', () => {
  const r = composeMatchFit([f('neighborhood', 0.9, 'LOW'), f('price', 0.1, 'LOW')])
  assert.equal(r.matchFit, 50)
  assert.deepEqual(r.unknownFactors.sort(), ['neighborhood', 'price'])
  assert.deepEqual(r.contributions, {})
})

test('MEDIUM contributes at half weight (vs HIGH)', () => {
  // neighborhood (w2.5) HIGH score=1 (+), price (w2.0) MEDIUM score=0 (−).
  const r = composeMatchFit([f('neighborhood', 1, 'HIGH'), f('price', 0, 'MEDIUM')])
  // If price voted at full weight the negative pull would be much stronger.
  assert.equal(r.matchFit, 88)
  // neighborhood's |contribution| (2.5·logit) dominates price's (1.0·logit).
  assert.ok(r.contributions.neighborhood > r.contributions.price)
})

test('contributions sum to ~100 (±2) and unknownFactors populated correctly', () => {
  const r = composeMatchFit([
    f('neighborhood', 0.9, 'HIGH'),
    f('price', 0.2, 'HIGH'),
    f('carryingReasonableness', 0.5, 'LOW'),
  ])
  const sum = Object.values(r.contributions).reduce((a, b) => a + b, 0)
  assert.ok(Math.abs(sum - 100) <= 2, `sum ${sum}`)
  assert.deepEqual(r.unknownFactors, ['carryingReasonableness'])
  assert.ok(!('carryingReasonableness' in r.contributions))
})

test('unknown feature key throws (weights are the source of truth)', () => {
  assert.throws(() => composeMatchFit([f('not_a_feature', 1, 'HIGH')]), /No weight configured/)
})
