// Phase 4.6 — Smoke test for NYC propertyType enrichment.
// Runs resolvePropertyType() against synthetic opportunity objects for known
// real addresses and prints expected vs. actual. No DB writes to opportunities
// (cache writes use the real org so repeat lookups are cheap).
//
//   npx tsx scripts/smoke-property-type.ts
import 'dotenv/config'
import { prisma } from '../lib/prisma'
import { resolvePropertyType, stripBareUnitSuffix, geocodeAddress, firstStreetNumber, streetNumbersCompatible, type EnrichableOpportunity } from '../lib/enrichment/nyc'

// Phase 4.6.2 Step 1d (+ planner edge-case fixes) — pure-function unit tests.
async function runStep1Tests() {
  let allPass = true
  console.log('═══════════════════════════════════════════════════════════════════')
  console.log('Phase 4.6.2 — stripBareUnitSuffix() unit tests')
  console.log('═══════════════════════════════════════════════════════════════════')
  const stripTests = [
    // Step 1 originals
    { in: '49 east 21 street 11d',     out: '49 east 21 street' },
    { in: '480 Kent Avenue 21B',       out: '480 Kent Avenue' },
    { in: '92 Horatio Street, 2F',     out: '92 Horatio Street' },
    { in: '505 Greenwich Street, 10E', out: '505 Greenwich Street' },
    { in: '740 Park Avenue',           out: '740 Park Avenue' },        // unchanged
    { in: '740 Park Avenue Apt 5A',    out: '740 Park Avenue' },        // explicit unit
    { in: '740 Park Avenue #5A',       out: '740 Park Avenue' },        // # unit
    { in: '120 Broadway',              out: '120 Broadway' },           // unchanged
    { in: '3-18 Beach 87 Street',      out: '3-18 Beach 87 Street' },   // hyphenated preserved
    { in: '1 Times Square, 5A',        out: '1 Times Square' },         // trailing unit
    // Fix 4 — front-anchored apt marker
    { in: 'Apt 5A, 740 Park Avenue',   out: '740 Park Avenue' },
    { in: '#5A, 740 Park Avenue',      out: '740 Park Avenue' },
    { in: 'Unit 3B, 92 Horatio Street', out: '92 Horatio Street' },
    // Fix 3 — Floor / Fl / Flr
    { in: '350 5th Avenue Floor 20',   out: '350 5th Avenue' },
    { in: '350 5th Avenue Fl 20',      out: '350 5th Avenue' },
    { in: '350 5th Avenue, Fl 20',     out: '350 5th Avenue' },
    // Fix 3 — Studio / Penthouse / Loft
    { in: '157 West 57 Street Penthouse', out: '157 West 57 Street' },
    { in: '100 Main Street Studio',    out: '100 Main Street' },
    { in: '55 Berry Street Loft 3',    out: '55 Berry Street' },
    // Fix 3 — slash duplex units
    { in: '25 West 54 Street 11E/12F', out: '25 West 54 Street' },
    { in: '25 West 54 Street, 5/6F',   out: '25 West 54 Street' },
    // Phase 4.6.3 — named-street + unit, #APT, DUPLEX, bare-numeric, ordinal-floor
    { in: '41 Central Park West 12A',  out: '41 Central Park West' },
    { in: '15 Central Park West, 8B',  out: '15 Central Park West' },
    { in: '740 Park Avenue #APT 18C',  out: '740 Park Avenue' },
    { in: '99 John Street DUPLEX-N',   out: '99 John Street' },
    { in: '200 East 21st Street 808',  out: '200 East 21st Street' }, // bare numeric unit
    { in: '100 Main Street 14th Floor', out: '100 Main Street' },     // ordinal floor
    // Phase 4.6.3 GUARDS — must NOT strip (street-name tokens, not units)
    { in: '100 14th Street',           out: '100 14th Street' },      // 14th is the street
    { in: '500 5th Avenue',            out: '500 5th Avenue' },       // 5th is the street
    { in: 'Avenue C',                  out: 'Avenue C' },             // letter-only street
  ]
  for (const t of stripTests) {
    const got = stripBareUnitSuffix(t.in)
    const ok = got === t.out
    if (!ok) allPass = false
    console.log(`  ${t.in.padEnd(36)} -> ${got.padEnd(28)} (expect: ${t.out.padEnd(24)}) ${ok ? 'PASS' : 'FAIL'}`)
  }

  console.log('\n  firstStreetNumber() — building-name prefix not front-anchored (fix 2):')
  const firstNumTests = [
    { in: '768 5th Avenue, Manhattan, NY', out: '768' },   // normal: leading number
    { in: 'The Plaza, 768 5th Avenue',     out: '768' },   // building-name prefix
    { in: 'One57, 157 W 57 St',            out: '157' },   // "57" inside "One57" skipped
    { in: '3-18 Beach 87 Street',          out: '3-18' },  // Queens hyphen
    { in: '449 1/2 Hudson Street',         out: '449 1/2' }, // fractional captured (Phase 4.6.3)
    // apt-prefixed: stripBareUnitSuffix removes the front apt FIRST, then firstStreetNumber
    { in: 'Apt 5A, 740 Park Avenue',       out: '740', viaStrip: true },
  ]
  for (const t of firstNumTests) {
    const got = firstStreetNumber(t.viaStrip ? stripBareUnitSuffix(t.in) : t.in)
    const ok = got === t.out
    if (!ok) allPass = false
    console.log(`    ${t.in.padEnd(36)} -> ${String(got).padEnd(8)} (expect ${t.out}) ${ok ? 'PASS' : 'FAIL'}`)
  }

  console.log('\n  streetNumbersCompatible() — hyphen-range + letters (fix 1):')
  const compatTests = [
    { a: '44-50', b: '44',  exp: true },   // matched low-end of range
    { a: '44',    b: '44-50', exp: true }, // input single, label range
    { a: '49A',   b: '49',  exp: true },   // trailing letter ignored
    { a: '3-18',  b: '3-18', exp: true },  // Queens, exact
    { a: '49',    b: '11',  exp: false },  // unit-leak still rejected
    { a: '3-18',  b: '3-05', exp: false }, // different Queens building rejected
    { a: '449 1/2', b: '449',     exp: true },  // fraction dropped → base 449 (Phase 4.6.3)
    { a: '449 1/2', b: '548 1/2', exp: false }, // different base building rejected
  ]
  for (const t of compatTests) {
    const got = streetNumbersCompatible(t.a, t.b)
    const ok = got === t.exp
    if (!ok) allPass = false
    console.log(`    ${`"${t.a}" vs "${t.b}"`.padEnd(22)} -> ${String(got).padEnd(6)} (expect ${t.exp}) ${ok ? 'PASS' : 'FAIL'}`)
  }
  console.log(`\n  unit-test result: ${allPass ? 'ALL PASS ✅' : 'FAILURES ❌'}`)

  console.log('\n═══════════════════════════════════════════════════════════════════')
  console.log('Phase 4.6.2 Step 1 — live end-to-end geocode of the 4 known-fail inputs')
  console.log('  (each should now resolve to the CORRECT building)')
  console.log('═══════════════════════════════════════════════════════════════════')
  const liveTests = ['49 east 21 street 11d', '480 Kent Avenue 21B', '92 Horatio Street, 2F', '505 Greenwich Street, 10E']
  for (const addr of liveTests) {
    const stripped = stripBareUnitSuffix(addr)
    const result = await geocodeAddress(stripped, null)
    console.log(`  ${addr.padEnd(34)} stripped="${stripped}"`)
    console.log(`  ${''.padEnd(34)} -> bbl=${result.bbl ?? 'null'} label="${result.label ?? ''}" reject=${result.rejectReason ?? 'none'}\n`)
  }
}

interface Case {
  label:    string
  address:  string | null
  borough:  string | null
  state:    string | null
  category?: string
  expected: string
}

const CASES: Case[] = [
  { label: '120 Broadway',          address: '120 Broadway',          borough: 'Manhattan', state: 'NY', expected: 'commercial / mixed-use (O-class)' },
  { label: '423 Atlantic Avenue',   address: '423 Atlantic Avenue',   borough: 'Brooklyn',  state: 'NY', expected: 'multi-family or mixed-use' },
  { label: '2 Park Place',          address: '2 Park Place',          borough: 'Manhattan', state: 'NY', expected: 'condo (R-class)' },
  { label: '75 Wall Street',        address: '75 Wall Street',        borough: 'Manhattan', state: 'NY', expected: 'condo' },
  { label: '15 Central Park West',  address: '15 Central Park West',  borough: 'Manhattan', state: 'NY', expected: 'condo' },
  { label: '740 Park Avenue',       address: '740 Park Avenue',       borough: 'Manhattan', state: 'NY', expected: 'co-op (D4)' },
  { label: '432 Park Avenue',       address: '432 Park Avenue',       borough: 'Manhattan', state: 'NY', expected: 'condo' },
  { label: 'TBD (placeholder)',     address: 'TBD',                   borough: 'Manhattan', state: 'NY', expected: 'null — skipped:placeholder_address' },
  { label: '123 Ocean Road, NJ',    address: '123 Ocean Road',        borough: null,        state: 'NJ', expected: 'null — skipped:outside_nyc' },
]

async function main() {
  await runStep1Tests()

  const org = await prisma.organization.findFirst({ where: { slug: 'dealflow-ryan' } })
    ?? await prisma.organization.findFirst()
  const organizationId = org?.id ?? 'smoke-no-org'
  if (!org) console.warn('[smoke] no Organization found — cache writes will fail-soft (FK).')

  console.log('\n═══════════════════════════════════════════════════════════════════')
  console.log('Phase 4.6 — propertyType enrichment smoke test')
  console.log(`  org: ${organizationId}`)
  console.log('═══════════════════════════════════════════════════════════════════\n')

  for (const c of CASES) {
    const opp: EnrichableOpportunity = {
      category:      c.category ?? 'ACTIVE_SALE_LISTING',
      address:       c.address,
      state:         c.state,
      borough:       c.borough,
      neighborhood:  null,
      propertyTypes: [],
      organizationId,
    }
    const t0 = Date.now()
    let line: string
    try {
      const r = await resolvePropertyType(opp)
      line = `  ${c.label.padEnd(26)} → ${String(r.propertyType ?? 'null').padEnd(14)} [${r.confidence}]  ${r.propertyTypeReason}`
    } catch (e) {
      line = `  ${c.label.padEnd(26)} → THREW: ${(e as Error).message}`
    }
    console.log(line)
    console.log(`  ${''.padEnd(26)}   expected: ${c.expected}   (${Date.now() - t0}ms)\n`)
  }

  await prisma.$disconnect()
}

main().catch(async (e) => {
  console.error('FATAL:', e)
  await prisma.$disconnect()
  process.exit(1)
})
