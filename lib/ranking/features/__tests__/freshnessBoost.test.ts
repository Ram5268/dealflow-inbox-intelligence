import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeFreshnessBoost } from '../freshnessBoost'
import { makeAgg, makeCtx } from '../../__tests__/fixtures'

const NOW = new Date('2026-08-24T00:00:00Z')
const ctx = makeCtx({ now: NOW })
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86400000)
const s = (createdAt: Date) => computeFreshnessBoost(makeAgg({ topMatch: { createdAt } }), ctx).score

test('freshnessBoost by match age', () => {
  assert.equal(s(NOW), 1.0)
  assert.equal(s(daysAgo(5)), 0.8)
  assert.equal(s(daysAgo(20)), 0.4)
  assert.equal(s(daysAgo(60)), 0.2)
})
