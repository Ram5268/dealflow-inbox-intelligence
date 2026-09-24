import { test } from 'node:test'
import assert from 'node:assert/strict'
import { composeCallPriority } from '../callPriority'
import type { RankingFeatureResult } from '../types'

const f = (key: string, score: number): RankingFeatureResult => ({ key, score, confidence: 'HIGH' })

test('empty features → priorityScore 50', () => {
  assert.equal(composeCallPriority([]).priorityScore, 50)
})

test('all HIGH score=1.0 → ~99', () => {
  const r = composeCallPriority([f('matchFitLift', 1), f('captureBonus', 1)])
  assert.ok(r.priorityScore >= 98, `got ${r.priorityScore}`)
})

test('all HIGH score=0.0 → ~1', () => {
  const r = composeCallPriority([f('matchFitLift', 0), f('captureBonus', 0)])
  assert.ok(r.priorityScore <= 2, `got ${r.priorityScore}`)
})

test('all HIGH score=0.5 → 50 (NO bias, unlike scorer)', () => {
  assert.equal(composeCallPriority([f('matchFitLift', 0.5), f('captureBonus', 0.5)]).priorityScore, 50)
})

test('contributions sum to ~100 (±2)', () => {
  const r = composeCallPriority([f('matchFitLift', 0.9), f('captureBonus', 0.4), f('cooldownPenalty', 0.2)])
  const sum = Object.values(r.contributions).reduce((a, b) => a + b, 0)
  assert.ok(Math.abs(sum - 100) <= 2, `sum ${sum}`)
})

test('unknown ranking weight key throws', () => {
  assert.throws(() => composeCallPriority([f('not_a_feature', 1)]), /No ranking weight configured/)
})
