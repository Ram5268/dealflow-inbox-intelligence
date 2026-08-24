import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeCooldownPenalty } from '../cooldownPenalty'
import { makeAgg, makeCtx } from '../../__tests__/fixtures'

const NOW = new Date('2026-08-24T00:00:00Z')
const ctx = makeCtx({ now: NOW })
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86400000)
const s = (lastCalled: Date | null) => computeCooldownPenalty(makeAgg({ contact: { lastCalled } }), ctx).score

test('cooldownPenalty by recency', () => {
  assert.equal(s(null), 1.0)
  assert.equal(s(daysAgo(60)), 1.0)
  assert.equal(s(daysAgo(20)), 0.7)
  assert.equal(s(daysAgo(10)), 0.4)
  assert.equal(s(daysAgo(5)), 0.2)
  assert.equal(s(daysAgo(1)), 0.05)
})

test('cooldownPenalty uses the MOST RECENT of lastCalled / lastDialDate', () => {
  const c = makeAgg({ contact: { lastCalled: daysAgo(60), lastDialDate: daysAgo(1) } })
  assert.equal(computeCooldownPenalty(c, ctx).score, 0.05) // 1-day-ago dial dominates
})
