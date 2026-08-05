import { test } from 'node:test'
import assert from 'node:assert/strict'
import { priceOverlapScore } from './priceOverlap'
import { bedsScore } from './bedsScore'

// Run: `npm test` (ts-node executes this file; node:test auto-runs + exits
// non-zero on failure). No external test-runner dependency.

function approx(actual: number, expected: number, eps = 0.01) {
  assert.ok(Math.abs(actual - expected) <= eps, `expected ~${expected} (±${eps}), got ${actual}`)
}

// ── Brief 2.5 Step 4b required cases ─────────────────────────────────────────
test('in-range rent → 1', () => {
  assert.equal(priceOverlapScore(4000, 3000, 4000), 1)
})
test('slight-over rent (4050 vs 4000) → ~0.75', () => {
  approx(priceOverlapScore(4050, 3000, 4000), 0.75)
})
test('way-over rent (4200 vs 4000) → 0', () => {
  assert.equal(priceOverlapScore(4200, 3000, 4000), 0)
})
test('in-range sale (1.8M in [1.5M,2M]) → 1', () => {
  assert.equal(priceOverlapScore(1800000, 1500000, 2000000), 1)
})
test('slight-over sale (2.05M vs 2.0M) → ~0.5', () => {
  approx(priceOverlapScore(2050000, 1500000, 2000000), 0.5)
})
test('under-budget (3800 vs [4000,5000]) → ~0.2', () => {
  approx(priceOverlapScore(3800, 4000, 5000), 0.2)
})
test('null listing price → 0', () => {
  assert.equal(priceOverlapScore(null, 3000, 4000), 0)
})

// ── Extra edge coverage ──────────────────────────────────────────────────────
test('no budget at all (min & max null) → 0', () => {
  assert.equal(priceOverlapScore(3000, null, null), 0)
})
test('open-ended max (only min, price above it) → 1', () => {
  assert.equal(priceOverlapScore(5000, 3000, null), 1)
})
test('exactly at tolerance edge (5% over max) → 0', () => {
  // 4200 is 5% over 4000; distance 200 == bound 200 → score 0 (not > 0).
  assert.equal(priceOverlapScore(4200, 3000, 4000), 0)
})

// ── Brief 3.0 Step 4 — studio bedsScore fix ──────────────────────────────────
test('studio↔studio (0,0) → full credit 20 (not 5)', () => {
  assert.equal(bedsScore(0, 0), 20)
})
test('one side unknown (null,0) → neutral 5', () => {
  assert.equal(bedsScore(null, 0), 5)
})
test('mismatch (2BR demand vs studio listing) → 0', () => {
  assert.equal(bedsScore(0, 2), 0)
})
test('exact non-studio (2,2) → 20', () => {
  assert.equal(bedsScore(2, 2), 20)
})
test('±1 bedroom (2,3) → 10', () => {
  assert.equal(bedsScore(2, 3), 10)
})
test('both unknown (undefined,undefined) → 5', () => {
  assert.equal(bedsScore(undefined, undefined), 5)
})
