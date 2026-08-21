import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bedsScore } from '../bedsScore'

// Brief 30.2 — bedsScore extended to handle the ISO side storing beds as a range
// (minBeds/maxBeds with scalar beds null). Pure module → runs under ts-node in
// `npm test`. Backward-compat cases mirror the pre-existing scalar tests in
// priceOverlap.test.ts (which stay untouched, out of scope).

test('bedsScore — backward compat: 2-arg scalar-only calls unchanged', () => {
  assert.equal(bedsScore(2, 2), 20)
  assert.equal(bedsScore(2, 3), 10)
  assert.equal(bedsScore(2, 4), 0)
  assert.equal(bedsScore(null, 2), 5)
  assert.equal(bedsScore(2, null), 5)
  assert.equal(bedsScore(0, 0), 20)  // studio ↔ studio, prior fix
})

test('bedsScore — ISO range exact match', () => {
  // Listing has 2BR, ISO wants 2BR (stored as range min=2 max=2, scalar null)
  assert.equal(bedsScore(2, null, 2, 2), 20)
})

test('bedsScore — ISO range covers listing', () => {
  // Listing 3BR, ISO wants 2-4BR
  assert.equal(bedsScore(3, null, 2, 4), 20)
})

test('bedsScore — listing ±1 outside ISO range', () => {
  // Listing 4BR, ISO wants 2-3BR → ±1 from top of range
  assert.equal(bedsScore(4, null, 2, 3), 10)
  // Listing 1BR, ISO wants 2-3BR → ±1 from bottom of range
  assert.equal(bedsScore(1, null, 2, 3), 10)
})

test('bedsScore — listing far outside range', () => {
  assert.equal(bedsScore(5, null, 2, 2), 0)
})

test('bedsScore — ISO fully unknown → neutral 5', () => {
  assert.equal(bedsScore(2, null, null, null), 5)
})

test('bedsScore — scalar isoBeds takes precedence over min/max when both present', () => {
  // Edge case: extractor populated both. Prefer scalar (exact) semantics.
  assert.equal(bedsScore(3, 2, 1, 5), 10)  // scalar wins → distance 1 → 10
})
