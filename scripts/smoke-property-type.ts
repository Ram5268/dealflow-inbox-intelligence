// Phase 4.6 — Smoke test for NYC propertyType enrichment.
// Runs resolvePropertyType() against synthetic opportunity objects for known
// real addresses and prints expected vs. actual. No DB writes to opportunities
// (cache writes use the real org so repeat lookups are cheap).
//
//   npx tsx scripts/smoke-property-type.ts
import 'dotenv/config'
import { prisma } from '../lib/prisma'
import { resolvePropertyType, type EnrichableOpportunity } from '../lib/enrichment/nyc'

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
  const org = await prisma.organization.findFirst({ where: { slug: 'dealflow-ryan' } })
    ?? await prisma.organization.findFirst()
  const organizationId = org?.id ?? 'smoke-no-org'
  if (!org) console.warn('[smoke] no Organization found — cache writes will fail-soft (FK).')

  console.log('═══════════════════════════════════════════════════════════════════')
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
