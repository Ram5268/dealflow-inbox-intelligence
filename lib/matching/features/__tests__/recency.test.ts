import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeRecency } from '../recency'
import { makeListing } from '../../__tests__/fixtures'

// Brief 32 BUG FIX verification — exact values within ±0.02.
const now = new Date('2026-08-23T00:00:00Z')
const at = (ageDays: number) => makeListing({ createdAt: new Date(now.getTime() - ageDays * 86400000) })

test('recency decay table (±0.02)', () => {
  const cases: [number, number][] = [
    [0, 1.0], [5, 0.7], [7, 0.61], [14, 0.37], [30, 0.12], [60, 0.1],
  ]
  for (const [age, expected] of cases) {
    const r = computeRecency(at(age), now)
    assert.ok(Math.abs(r.score - expected) < 0.02, `age ${age}: got ${r.score}, want ${expected}`)
    assert.equal(r.confidence, 'HIGH')
  }
})
