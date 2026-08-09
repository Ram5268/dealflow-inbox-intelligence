import { test } from 'node:test'
import assert from 'node:assert/strict'
import { geoAllows } from './geoFilter'

// Run: `npm test` (ts-node executes this file; node:test auto-runs + exits
// non-zero on failure). No external test-runner dependency.
//
// The pre-filter is GENEROUS by design: it must drop clear non-matches (wrong
// borough, disjoint specific neighborhoods) while never dropping real signal
// (missing geo, adjacent/contiguous neighborhoods, broad criteria).

const party = (borough: string | null, ...neighborhoods: string[]) => ({ borough, neighborhoods })
const listing = (borough: string | null, ...neighborhoods: string[]) => ({ borough, neighborhoods })

// ── Rule 1: different known boroughs → EXCLUDE ───────────────────────────────
test('Manhattan buyer vs Brooklyn listing → excluded', () => {
  assert.equal(geoAllows(party('Manhattan', 'Chelsea'), listing('Brooklyn', 'Williamsburg')), false)
})
test('borough derived from hoods disagrees (Chelsea vs Williamsburg, no explicit borough) → excluded', () => {
  assert.equal(geoAllows(party(null, 'Chelsea'), listing(null, 'Williamsburg')), false)
})
test('explicit borough beats a stray hood: Manhattan party vs Brooklyn listing → excluded', () => {
  assert.equal(geoAllows(party('Manhattan'), listing('Brooklyn', 'Park Slope')), false)
})

// ── Rule 2: missing borough on either side → INCLUDE ─────────────────────────
test('party has no resolvable geo at all → included', () => {
  assert.equal(geoAllows(party(null), listing('Manhattan', 'Chelsea')), true)
})
test('listing borough unknown → included', () => {
  assert.equal(geoAllows(party('Brooklyn', 'Park Slope'), listing(null)), true)
})
test('unrecognized neighborhood string (no borough) → included, not dropped', () => {
  assert.equal(geoAllows(party(null, 'Somewhere Vague'), listing('Manhattan', 'Chelsea')), true)
})

// ── Rule 3: same borough, both specific → overlap decides ────────────────────
test('exact neighborhood match (Chelsea/Chelsea) → included', () => {
  assert.equal(geoAllows(party('Manhattan', 'Chelsea'), listing('Manhattan', 'Chelsea')), true)
})
test('UES vs Yorkville (adjacent, same borough) → included', () => {
  assert.equal(geoAllows(party('Manhattan', 'Upper East Side'), listing('Manhattan', 'Yorkville')), true)
})
test('Chelsea vs West Chelsea (contiguous sub-area) → included', () => {
  assert.equal(geoAllows(party('Manhattan', 'Chelsea'), listing('Manhattan', 'West Chelsea')), true)
})
test('Park Slope vs Cobble Hill (adjacent Brooklyn) → included', () => {
  assert.equal(geoAllows(party('Brooklyn', 'Park Slope'), listing('Brooklyn', 'Cobble Hill')), true)
})
test('Tribeca vs Yorkville (same borough, NOT adjacent) → excluded', () => {
  assert.equal(geoAllows(party('Manhattan', 'Tribeca'), listing('Manhattan', 'Yorkville')), false)
})
test('Bushwick vs Bay Ridge (both Brooklyn, disjoint) → excluded', () => {
  assert.equal(geoAllows(party('Brooklyn', 'Bushwick'), listing('Brooklyn', 'Bay Ridge')), false)
})
test('multi-hood party, one overlaps (UES/Tribeca vs Yorkville) → included', () => {
  assert.equal(geoAllows(party('Manhattan', 'Tribeca', 'Upper East Side'), listing('Manhattan', 'Yorkville')), true)
})

// ── Rule 4: same borough, one side broad (no hoods) → INCLUDE ────────────────
test('broad Manhattan party (no hoods) vs Chelsea listing → included', () => {
  assert.equal(geoAllows(party('Manhattan'), listing('Manhattan', 'Chelsea')), true)
})
test('specific party vs listing with borough but no neighborhood → included', () => {
  assert.equal(geoAllows(party('Manhattan', 'Chelsea'), listing('Manhattan')), true)
})

// Alias resolution flows through fromRaw: "UES" resolves to Upper East Side.
test('alias "UES" vs Yorkville → included (alias resolved to canonical)', () => {
  assert.equal(geoAllows(party('Manhattan', 'UES'), listing('Manhattan', 'Yorkville')), true)
})
