// Phase 4.6 — Smoke test for NYC propertyType enrichment.
// Runs resolvePropertyType() against synthetic opportunity objects for known
// real addresses and prints expected vs. actual. No DB writes to opportunities
// (cache writes use the real org so repeat lookups are cheap).
//
//   npx tsx scripts/smoke-property-type.ts
import 'dotenv/config'
import { prisma } from '../lib/prisma'
import { resolvePropertyType, stripBareUnitSuffix, geocodeAddress, type EnrichableOpportunity } from '../lib/enrichment/nyc'

// Phase 4.6.2 Step 1d — unit-strip unit tests + end-to-end geocode checks.
async function runStep1Tests() {
  console.log('═══════════════════════════════════════════════════════════════════')
  console.log('Phase 4.6.2 Step 1 — stripBareUnitSuffix() unit tests')
  console.log('═══════════════════════════════════════════════════════════════════')
  const stripTests = [
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
  ]
  let allPass = true
  for (const t of stripTests) {
    const got = stripBareUnitSuffix(t.in)
    const ok = got === t.out
    if (!ok) allPass = false
    console.log(`  ${t.in.padEnd(40)} -> ${got.padEnd(40)} (expected: ${t.out.padEnd(28)}) ${ok ? 'PASS' : 'FAIL'}`)
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
