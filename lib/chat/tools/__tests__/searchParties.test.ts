import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bedsMatches } from '../searchParties'

// Brief 30.1 — search_parties beds recall fix.
// searchParties.ts imports the @/ alias, so this runs under tsx (NOT ts-node,
// which can't resolve @/). These bedsMatches unit tests are pure. Brief 41: the
// database test moved to searchParties.integration.test.ts (npm run
// test:integration), so `npm test` never touches a database.
//
// Root cause fixed: buyer ISOs store bed criteria as minBeds/maxBeds with scalar
// `beds` null (~90% of rows). The old `where.beds = input.beds` Prisma gate dropped
// them, so search_parties returned 0 for legitimate range buyers. bedsMatches now
// filters in-memory over the row's effective range [minBeds ?? beds, maxBeds ?? beds].

test('bedsMatches — exact query matches ISO range row', () => {
  // BUYER_A pattern: beds=null, minBeds=2, maxBeds=2. Query beds=2 → match.
  assert.ok(bedsMatches(2, null, null, null, 2, 2))
})

test('bedsMatches — exact query matches scalar-beds row', () => {
  // Legacy seed pattern: beds=2, minBeds=null, maxBeds=null. Query beds=2 → match.
  assert.ok(bedsMatches(2, null, null, 2, null, null))
})

test('bedsMatches — exact query excludes non-overlapping range row', () => {
  // Row wants 1BR only (minBeds=1, maxBeds=1). Query beds=2 → no match.
  assert.ok(!bedsMatches(2, null, null, null, 1, 1))
})

test('bedsMatches — range query overlaps ISO range row', () => {
  // Row wants 2-3BR. Query bedsMin=2, bedsMax=4 → overlap → match.
  assert.ok(bedsMatches(null, 2, 4, null, 2, 3))
})

test('bedsMatches — unknown row is not excluded (neutral)', () => {
  // Row has no beds info at all. Do not silently drop (mirrors geoMatches).
  assert.ok(bedsMatches(2, null, null, null, null, null))
})

test('bedsMatches — no query means no gate', () => {
  assert.ok(bedsMatches(null, null, null, null, 2, 2))
})
