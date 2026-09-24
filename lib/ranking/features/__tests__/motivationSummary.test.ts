import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeMotivationSummary } from '../motivationSummary'
import { makeAgg } from '../../__tests__/fixtures'
import type { AggregatedMatch } from '../../types'

const m = (matchFit: number, contributions: Record<string, number>): AggregatedMatch =>
  ({ id: `m${matchFit}`, matchFit, captureStatus: 'EXTERNAL_BOTH', contributions })

test('HOT match with preForeclosure+foreclosureUrgency > 25% → 1.0', () => {
  const c = makeAgg({
    topMatch: { matchFit: 85, contributions: { preForeclosure: 20, foreclosureUrgency: 10 } },
    contributingMatches: [m(85, { preForeclosure: 20, foreclosureUrgency: 10 })],
  })
  assert.equal(computeMotivationSummary(c).score, 1.0)
})

test('WARM match with vacancy 18% → 0.7', () => {
  const c = makeAgg({
    topMatch: { matchFit: 70, contributions: { vacancy: 18 } },
    contributingMatches: [m(70, { vacancy: 18 })],
  })
  assert.equal(computeMotivationSummary(c).score, 0.7)
})

test('no distress signals → 0.4', () => {
  const c = makeAgg({
    topMatch: { matchFit: 90, contributions: { neighborhood: 30, price: 25 } },
    contributingMatches: [m(90, { neighborhood: 30, price: 25 })],
  })
  assert.equal(computeMotivationSummary(c).score, 0.4)
})
