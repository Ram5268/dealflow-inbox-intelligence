// Brief 43 PR 7 (N12): search_listings now filters area, price, beds, units and
// address in the database instead of on the newest 500 rows. The database
// filter must never drop a listing the tool's exact checks would keep, so this
// checks, on thousands of generated rows and asks, that every row the exact
// rules keep also passes the where clause (evaluated by pr7FakeDb.ts with SQL's
// null rules). Plus: the tool schemas stay in lockstep with the Zod inputs, the
// "under" wording, and the guard's keep-list. Pure: no database, no network.
import { evalWhere } from './pr7FakeDb'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { listingsWhere, askedBudget, searchListingsInputSchema, type SearchListingsInput } from '../searchListings'
import { searchPartiesInputSchema, bedsMatches } from '../searchParties'
import { SEARCH_LISTINGS_TOOL, SEARCH_PARTIES_TOOL } from '../schemas'
import { parseStreetAddress, addressMatch } from '../addressMatch'
import { fromRaw, getAdjacent } from '@/lib/domain/Neighborhood'
import { priceOverlapScore } from '@/lib/matching/priceOverlap'

delete process.env.TEST_MODE_ONLY

// Small deterministic generator (mulberry32), so a failure reproduces.
function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const rand = rng(43_007)
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]
const maybe = <T>(p: number, f: () => T): T | null => (rand() < p ? f() : null)

const HOOD_STRINGS = [
  'Williamsburg', 'East Williamsburg', 'williamsburg', 'Bed-Stuy', 'Stuyvesant Heights', 'bedford stuyvesant', 'BEDFORD-STUYVESANT',
  'Harlem', 'East Harlem', 'Central Harlem', 'Flatbush', 'East Flatbush', 'Park Slope', 'South Slope', 'Greenpoint', 'Bushwick',
  'Some Unknown Place', 'Williamsburg/Greenpoint', 'Cobble Hill, Carroll Garden, Boerum Hill', 'PLG', 'UWS', 'Upper West Side',
  '  Crown Heights ', 'Tribeca',
] as const
const ROW_ADDRESSES = [
  '88 Example Ave', '188 Example Ave', '88 Example St', '88 Example Avenue, Brooklyn, NY 11216', '88 Example Ave #3B', 'Apt 2, 88 Example Ave',
  '12 Sample St', '12 Sample Street South', "115 St. Mark's Pl", '115 Saint Marks Place', '31-14 Example Blvd', '3114 Example Boulevard',
  '7 W 10th St', '7 West 10 Street', 'Example Ave', null,
] as const
const ASKED_ADDRESSES = ['88 Example Ave', '88 example', '88 Example Avenue, Brooklyn', '115 St Marks Place', '31-14 Example Boulevard', 'Example Ave', '7 West 10th St', '12 Sample St'] as const

function genRow(): Record<string, unknown> {
  const price = maybe(0.7, () => Math.round(500_000 + rand() * 4_500_000))
  return {
    id: 'r', organizationId: 'org', category: 'ACTIVE_SALE_LISTING', isDuplicate: false, processingStatus: 'active', isTestData: true,
    neighborhood: maybe(0.9, () => pick(HOOD_STRINGS)),
    neighborhoods: rand() < 0.1 ? [pick(HOOD_STRINGS)] : [],
    address: pick(ROW_ADDRESSES),
    price,
    minPrice: maybe(0.4, () => Math.round(500_000 + rand() * 4_500_000)),
    maxPrice: maybe(0.4, () => Math.round(500_000 + rand() * 4_500_000)),
    beds: maybe(0.5, () => pick([0, 1, 2, 3, 4, 5, 2.5])),
    minBeds: maybe(0.4, () => pick([0, 1, 2, 3, 4])),
    maxBeds: maybe(0.4, () => pick([1, 2, 3, 4, 5])),
    units: maybe(0.5, () => pick([1, 2, 3, 4, 6, 2.5])),
  }
}
function genInput(): SearchListingsInput {
  const input: SearchListingsInput = {}
  if (rand() < 0.5) input.neighborhoods = Array.from({ length: 1 + Math.floor(rand() * 2) }, () => pick([...HOOD_STRINGS, 'wburg', 'bedstuy']))
  if (rand() < 0.2) input.nearby = true
  if (rand() < 0.4) input.priceMin = Math.round(500_000 + rand() * 3_000_000)
  if (rand() < 0.4) input.priceMax = Math.round(1_000_000 + rand() * 4_000_000)
  if (rand() < 0.2) input.priceAround = Math.round(1_000_000 + rand() * 3_000_000)
  if (rand() < 0.4) input.priceTolerance = pick([0, 0.05, 0.15, 0.3])
  if (rand() < 0.2) input.beds = pick([0, 1, 2, 3, 2.5])
  if (rand() < 0.3) input.bedsMin = pick([1, 2, 3, 1.5])
  if (rand() < 0.3) input.bedsMax = pick([2, 3, 4, 3.5])
  if (rand() < 0.3) input.unitsMin = pick([1, 2, 3, 2.5])
  if (rand() < 0.3) input.unitsMax = pick([2, 3, 4])
  if (rand() < 0.3) input.address = pick(ASKED_ADDRESSES)
  return input
}

// The exact rules, written out here from their definitions.
const canon = (s: string | null | undefined) => (s && s.trim() ? fromRaw(s) ?? s.trim().toLowerCase() : null)
function exactKeeps(row: Record<string, unknown>, input: SearchListingsInput): boolean {
  if (input.neighborhoods?.length) {
    const want = new Set<string>()
    for (const n of input.neighborhoods) {
      const c = canon(n)
      if (!c) continue
      want.add(c)
      if (input.nearby) for (const a of getAdjacent(c)) want.add(a)
    }
    const rowHoods = [row.neighborhood as string | null, ...(row.neighborhoods as string[])].map(canon)
    if (want.size && !rowHoods.some(h => h != null && want.has(h))) return false
  }
  if (!bedsMatches(input.beds ?? null, input.bedsMin ?? null, input.bedsMax ?? null, row.beds as number | null, row.minBeds as number | null, row.maxBeds as number | null)) return false
  const budget = askedBudget(input)
  if (budget.min != null || budget.max != null) {
    const p = row.price as number | null, lo = row.minPrice as number | null, hi = row.maxPrice as number | null
    const eff = p ?? (lo != null && hi != null ? (lo + hi) / 2 : hi ?? lo ?? null)
    if (priceOverlapScore(eff, budget.min, budget.max, input.priceTolerance ?? 0) === 0) return false
  }
  if (input.unitsMin != null || input.unitsMax != null) {
    const u = row.units as number | null
    // a null unit count may still be read from the type text, so it stays in the pool
    if (u != null && ((input.unitsMin != null && u < input.unitsMin) || (input.unitsMax != null && u > input.unitsMax))) return false
  }
  if (input.address) {
    const asked = parseStreetAddress(input.address)
    if (asked && !addressMatch(asked, parseStreetAddress(row.address as string | null))) return false
  }
  return true
}

test('the database filter never drops a listing the exact rules keep (5,000 generated rows x asks)', () => {
  let kept = 0, sqlOnly = 0
  for (let i = 0; i < 5_000; i++) {
    const row = genRow(), input = searchListingsInputSchema.parse(genInput())
    const sql = evalWhere('extractedOpportunity', row, listingsWhere(input, 'org')) === true
    if (exactKeeps(row, input)) {
      kept++
      assert.ok(sql, `dropped by SQL: ${JSON.stringify({ row, input })}`)
    } else if (sql) sqlOnly++
  }
  // Sanity: the generator exercises both sides.
  assert.ok(kept > 300, `only ${kept} kept`)
  assert.ok(sqlOnly < 5_000 - kept, 'SQL filter passes everything')
})

test('the where clause carries the area, price and beds filters (not only org and category)', () => {
  const w = JSON.stringify(listingsWhere(searchListingsInputSchema.parse({ neighborhoods: ['Tribeca'], priceMax: 2_000_000, beds: 2 }), 'org'))
  assert.match(w, /"neighborhood":\{"contains":"tribeca","mode":"insensitive"\}/)
  assert.match(w, /"price":\{"lte":2000000\}/)
  assert.match(w, /"beds":\{"gte":2,"lte":2\}/)
})

test('fractional beds never reach an Int column (Prisma would reject them)', () => {
  const where = listingsWhere(searchListingsInputSchema.parse({ beds: 2.5 }), 'org')
  // pr7FakeDb throws on a fractional operand for minBeds/maxBeds.
  assert.doesNotThrow(() => evalWhere('extractedOpportunity', { ...genRow(), beds: null, minBeds: 2, maxBeds: 3 }, where))
})

test('askedBudget: "around X" is X plus or minus 15%, an explicit min or max wins', () => {
  assert.deepEqual(askedBudget({ priceAround: 3_000_000 }), { min: 2_550_000, max: 3_450_000, target: 3_000_000 })
  assert.deepEqual(askedBudget({ priceAround: 3_000_000, priceMax: 3_200_000 }), { min: 2_550_000, max: 3_200_000, target: 3_000_000 })
  assert.deepEqual(askedBudget({ priceMin: 2_600_000, priceMax: 3_450_000 }), { min: 2_600_000, max: 3_450_000, target: 3_025_000 })
  assert.deepEqual(askedBudget({ priceMax: 1_500_000 }), { min: null, max: 1_500_000, target: null })
})

test('tool schemas list exactly the Zod inputs (lockstep)', () => {
  const props = (t: typeof SEARCH_LISTINGS_TOOL) => Object.keys((t.input_schema as { properties: Record<string, unknown> }).properties).sort()
  assert.deepEqual(props(SEARCH_LISTINGS_TOOL), Object.keys(searchListingsInputSchema.shape).sort())
  assert.deepEqual(props(SEARCH_PARTIES_TOOL), Object.keys(searchPartiesInputSchema.shape).sort())
})

test('the tool text tells Drift "under" is a hard ceiling and an area is that area', () => {
  const p = (SEARCH_LISTINGS_TOOL.input_schema as { properties: Record<string, { description?: string }> }).properties
  assert.match(p.priceTolerance.description ?? '', /Default 0\b/)
  assert.doesNotMatch(p.priceTolerance.description ?? '', /default 0\.05/)
  assert.match(p.priceMax.description ?? '', /hard ceiling/)
  assert.match(p.neighborhoods.description ?? '', /East Williamsburg/)
  assert.match(p.address.description ?? '', /188/)
  assert.ok(p.unitsMin && p.unitsMax && p.propertyTypes && p.priceAround && p.nearby)
})

test('the guard keep-list grounds the new card fields (route.ts trimCardForGuard)', () => {
  const route = readFileSync(join(__dirname, '../../../../app/api/chat/route.ts'), 'utf8')
  const m = route.match(/function trimCardForGuard[\s\S]*?const keep = \[([^\]]*)\]/)
  assert.ok(m, 'keep-list not found')
  const keep = m[1].split(',').map(s => s.trim().replace(/^'|'$/g, ''))
  for (const f of ['units', 'propertyType', 'squareFeet', 'availabilityDate', 'sourceBrokerage']) assert.ok(keep.includes(f), f)
})
