import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tierCounts } from '../digestCounts'

// Brief 35: the digest counted HOT rows scoring 80-89 as Warm too, which made
// "Possible" negative. Each match now counts once, by tier.

test('counts by Match.tier, once each', () => {
  const rows = [
    { tier: 'HOT', score: 96 }, { tier: 'HOT', score: 84 }, { tier: 'WARM', score: 70 },
    { tier: 'POSSIBLE', score: 55 }, { tier: 'POSSIBLE', score: 50 },
  ]
  assert.deepEqual(tierCounts(rows), { hot: 2, warm: 1, possible: 2 })
})

test('null tier falls back to score bands 80 / 65', () => {
  const rows = [{ tier: null, score: 91 }, { tier: null, score: 80 }, { tier: null, score: 79 }, { tier: null, score: 65 }, { tier: null, score: 64 }]
  assert.deepEqual(tierCounts(rows), { hot: 2, warm: 2, possible: 1 })
})

test('never negative; totals always add up', () => {
  const rows = Array.from({ length: 100 }, (_, i) => ({ tier: i % 3 === 0 ? 'HOT' : null, score: 50 + (i % 50) }))
  const c = tierCounts(rows)
  assert.ok(c.hot >= 0 && c.warm >= 0 && c.possible >= 0)
  assert.equal(c.hot + c.warm + c.possible, rows.length)
})
