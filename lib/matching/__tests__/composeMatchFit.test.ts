import { test } from 'node:test'
import assert from 'node:assert/strict'
import { composeMatchFit } from '../scorer'
import type { FeatureResult } from '../scorerTypes'

const f = (key: string, score: number, confidence: 'HIGH' | 'MEDIUM' | 'LOW'): FeatureResult => ({ key, score, confidence })
// Brief 32.A.1: BIAS_LOGIT = -0.5 applied AFTER normalization shifts every result down.

test('empty features array → neutral 50, LOW confidence, no crash', () => {
  const r = composeMatchFit([])
  assert.equal(r.matchFit, 50)
  assert.equal(r.matchFitConfidence, 'LOW')
  assert.deepEqual(r.contributions, {})
  assert.deepEqual(r.unknownFactors, [])
})

test('all HIGH score=1.0 → matchFit >= 95 (bias barely dents the top)', () => {
  const r = composeMatchFit([f('neighborhood', 1, 'HIGH'), f('price', 1, 'HIGH'), f('beds', 1, 'HIGH')])
  assert.ok(r.matchFit >= 95, `got ${r.matchFit}`) // logit(1)-0.5 = 4.115 → sigmoid ≈ 0.984 → 98
})

test('all HIGH score=0.0 → matchFit <= 5', () => {
  const r = composeMatchFit([f('neighborhood', 0, 'HIGH'), f('price', 0, 'HIGH')])
  assert.ok(r.matchFit <= 5, `got ${r.matchFit}`)
})

test('BIAS: all-neutral (score=0.5 HIGH) → matchFit ≈ 38 (was 50)', () => {
  const r = composeMatchFit([f('neighborhood', 0.5, 'HIGH'), f('price', 0.5, 'HIGH')])
  // normalized = 0 + (-0.5) = -0.5 → sigmoid(-0.5) ≈ 0.3775 → 38
  assert.ok(r.matchFit >= 35 && r.matchFit <= 41, `got ${r.matchFit}`)
})

test('all LOW → matchFit 50 (weight=0 path), LOW confidence, all keys unknown', () => {
  const r = composeMatchFit([f('neighborhood', 0.9, 'LOW'), f('price', 0.1, 'LOW')])
  assert.equal(r.matchFit, 50)
  assert.equal(r.matchFitConfidence, 'LOW')
  assert.deepEqual(r.unknownFactors.sort(), ['neighborhood', 'price'])
  assert.deepEqual(r.contributions, {})
})

test('MEDIUM contributes at half weight (bias-adjusted value)', () => {
  const r = composeMatchFit([f('neighborhood', 1, 'HIGH'), f('price', 0, 'MEDIUM')])
  // normalized 1.9779 - 0.5 = 1.4779 → sigmoid ≈ 0.8143 → 81 (was 88 pre-bias)
  assert.equal(r.matchFit, 81)
  assert.ok(r.contributions.neighborhood > r.contributions.price)
})

test('contributions sum to ~100 (±2); bias does not affect contributions', () => {
  const r = composeMatchFit([f('neighborhood', 0.9, 'HIGH'), f('price', 0.2, 'HIGH'), f('carryingReasonableness', 0.5, 'LOW')])
  const sum = Object.values(r.contributions).reduce((a, b) => a + b, 0)
  assert.ok(Math.abs(sum - 100) <= 2, `sum ${sum}`)
  assert.deepEqual(r.unknownFactors, ['carryingReasonableness'])
})

test('matchFitConfidence from abstention count: 4→HIGH, 5/8→MEDIUM, 9→LOW', () => {
  const low = (n: number) => Array.from({ length: n }, (_, i) => f(`abstain_${i}`, 0.5, 'LOW'))
  const anchor = f('neighborhood', 0.6, 'HIGH') // keeps weightedTotalConf > 0
  assert.equal(composeMatchFit([anchor, ...low(4)]).matchFitConfidence, 'HIGH')
  assert.equal(composeMatchFit([anchor, ...low(5)]).matchFitConfidence, 'MEDIUM')
  assert.equal(composeMatchFit([anchor, ...low(8)]).matchFitConfidence, 'MEDIUM')
  assert.equal(composeMatchFit([anchor, ...low(9)]).matchFitConfidence, 'LOW')
})

test('unknown feature key throws (weights are the source of truth)', () => {
  assert.throws(() => composeMatchFit([f('not_a_feature', 1, 'HIGH')]), /No weight configured/)
})
