import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scanForStructuralHallucinations } from '../regexGuard'

// Run: `npm test` (ts-node executes this file via node:test; auto-runs + exits
// non-zero on failure). No external test-runner dependency.

function patternsHit(response: string): Set<string> {
  return new Set(scanForStructuralHallucinations(response).map(f => f.pattern))
}

// ── Bug #1 — ACRIS invention (the exact stress-test hallucination) ───────────
test('Bug #1 ACRIS response flags source + entity + dated amount', () => {
  const resp =
    'ACRIS on 30 Park Pl: Last recorded sale was $6,750,000 on 2026-06-16 (from CONDO 54 PARK PLACE LLC)'
  const hit = patternsHit(resp)
  assert.ok(hit.has('real_estate_source_citation'), 'should flag ACRIS citation')
  assert.ok(hit.has('corporate_entity'), 'should flag CONDO 54 PARK PLACE LLC')
  assert.ok(hit.has('dated_dollar_amount'), 'should flag $6,750,000 on 2026-06-16')
})

// ── Bug #4 — StreetEasy URL fabrication (the exact stress-test hallucination) ─
test('Bug #4 StreetEasy URL response flags url + source', () => {
  const resp =
    'here are live StreetEasy 2BR rentals in Williamsburg in that range: $4,500 — https://www.streeteasy.com/rental/5126522'
  const hit = patternsHit(resp)
  assert.ok(hit.has('external_url'), 'should flag the https URL')
  assert.ok(hit.has('real_estate_source_citation'), 'should flag StreetEasy citation')
})

// ── Individual pattern coverage ──────────────────────────────────────────────
test('bare external URL flags external_url', () => {
  assert.ok(patternsHit('check http://zillow.com/x for comps').has('external_url'))
})

test('Zillow / PropertyShark / PLUTO all flag source citation', () => {
  assert.ok(patternsHit('I pulled the PLUTO record and PropertyShark comps').has('real_estate_source_citation'))
  assert.ok(patternsHit('Zillow shows 3 similar units').has('real_estate_source_citation'))
})

test('ownership assertion flags', () => {
  assert.ok(patternsHit('the building is owned by a shell company').has('ownership_assertion'))
})

test('historical sale verb flags', () => {
  assert.ok(patternsHit('the unit last sold in 2019 for a lower price').has('historical_sale_verb'))
})

test('invented market stat flags', () => {
  assert.ok(patternsHit('prices are up 8.5% year-over-year in the UWS').has('invented_stat'))
})

// ── Brief 5.1.1, Fix 1 — "% down" mortgage LTV must NOT flag invented_stat ────
// The old pattern matched any "N% down" via the `down` direction token, which
// false-positived on mortgage-math questions (F03/F04 in Ryan's trial). These
// are legitimate down-payment terminology, not market claims.
test('mortgage down-payment percentages do NOT flag invented_stat', () => {
  for (const resp of [
    '20% down',
    '25% down',
    '20% down payment',
    '25% down closing',
    'On a $2M purchase at 20% down, your loan is $1.6M.',
    'Cash to close on the PH at 25% down is roughly the deposit plus fees.',
  ]) {
    assert.deepEqual(
      scanForStructuralHallucinations(resp),
      [],
      `expected no flags for ${JSON.stringify(resp)}, got ${JSON.stringify(scanForStructuralHallucinations(resp))}`,
    )
  }
})

// ── Brief 5.1.1, Fix 1 — genuine market stats must STILL flag ────────────────
test('genuine market stats still flag invented_stat', () => {
  for (const resp of [
    'prices down 10% YoY',
    'UWS is up 5% year-over-year',
    'appreciation of 8% annually',
    'the block saw 8% appreciation',
    'Chelsea is 10% higher than last year',
  ]) {
    assert.ok(
      patternsHit(resp).has('invented_stat'),
      `expected invented_stat flag for ${JSON.stringify(resp)}`,
    )
  }
})

test('dated dollar amount with ISO date flags', () => {
  assert.ok(patternsHit('recorded at $6,750,000 on 2026-06-16').has('dated_dollar_amount'))
})

// ── Legitimate seed responses must NOT trigger any flag ──────────────────────
test('legit sale listing line — zero flags', () => {
  const flags = scanForStructuralHallucinations(
    '461 6th St — 2BR, Park Slope | Active Sale | $1,750,000',
  )
  assert.deepEqual(flags, [], `expected no flags, got ${JSON.stringify(flags)}`)
})

test('legit multi-listing response — zero flags', () => {
  const resp =
    'You have two at 30 Park Pl: SEED_RENT_20 (PH, 3BR rental, $15,000/mo) and SEED_SALE_20 (PH, sale, $15,000,000). Both are penthouse units.'
  assert.deepEqual(scanForStructuralHallucinations(resp), [])
})

test('legit near-miss with prices and neighborhood — zero flags', () => {
  const resp =
    'In Park Slope under 2M: 461 6th St at $1,750,000 (exact) and a near-miss at $2,050,000. Nothing else fits.'
  assert.deepEqual(scanForStructuralHallucinations(resp), [])
})

test('PH unit numbers and studio addresses — zero flags', () => {
  const resp = 'Cheapest rental is a Midtown studio at $2,800. Also a PH at 30 Park Pl.'
  assert.deepEqual(scanForStructuralHallucinations(resp), [])
})

test('honest decline (no external data) — zero flags', () => {
  const resp =
    "I don't have public records or sale history — Drift only sees your inbox listings. Nothing at that address in the system."
  assert.deepEqual(scanForStructuralHallucinations(resp), [])
})

test('buyer match line with names — zero flags', () => {
  const resp = 'Sarah Chen is looking for a 2BR in Park Slope $1.5-2M — 461 6th St is a spot-on fit.'
  assert.deepEqual(scanForStructuralHallucinations(resp), [])
})
