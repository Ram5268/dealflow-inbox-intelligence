// Brief 32.A.1 — backfill buyer-side bathsMin/bathsMax on seed BUYER_ISO rows
// (unblocks the baths feature). Heuristic by archetype, else by bedsMin. Listing
// rows are untouched (they already carry a scalar baths).
//
// NOTE: MojoContact BUYERs are intentionally skipped — the schema adds baths only
// to ExtractedOpportunity, so mojo buyers stay "no baths preference" (the baths
// feature neutral-passes them). Gate 3 counts only BUYER_ISO opportunities.
//
// Run:  npx tsx scripts/seed-brief32-tuning-backfill.ts
import 'dotenv/config'
import { prisma } from '../lib/prisma'
import { ensureConnected, makeRng } from './seed-stress-common'

const rng = makeRng(0x32A1)

function bathsFor(bedsMin: number | null, archetype: string | null): [number, number | null] {
  if (archetype === 'LUXURY_ALL_CASH' || archetype === 'LUXURY_FINANCED') return [rng.chance(0.5) ? 3 : 2, null] // strict
  if (archetype === 'INVESTOR_LANDLORD' || archetype === 'FIRST_TIME_FHA') return [1, null] // flexible on baths

  let base: number
  if (bedsMin == null) base = 1
  else if (bedsMin <= 0) return [1, 1] // studio → exactly 1
  else if (bedsMin === 1) base = 1
  else if (bedsMin === 2) base = rng.chance(0.3) ? 2 : 1 // some strict
  else if (bedsMin === 3) base = 2
  else base = rng.chance(0.3) ? 3 : 2 // 4BR+

  const flexible = rng.chance(0.6) // 60% no stated max
  return [base, flexible ? null : base + 1]
}

async function main() {
  await ensureConnected()
  const rows = await prisma.extractedOpportunity.findMany({
    where: {
      category: 'BUYER_ISO', isTestData: true,
      OR: [{ extractedTitle: { startsWith: '[TEST_10] ' } }, { extractedTitle: { startsWith: '[TEST_32] ' } }],
    },
    select: { id: true, minBeds: true, buyerArchetype: true },
  })
  console.log(`Found ${rows.length} seed BUYER_ISO rows.`)

  let updated = 0
  for (const r of rows) {
    const [bathsMin, bathsMax] = bathsFor(r.minBeds, r.buyerArchetype)
    await prisma.extractedOpportunity.update({ where: { id: r.id }, data: { bathsMin, bathsMax } })
    updated++
  }

  const withBaths = await prisma.extractedOpportunity.count({
    where: { category: 'BUYER_ISO', isTestData: true, OR: [{ bathsMin: { not: null } }, { bathsMax: { not: null } }] },
  })
  console.log(`\n✅ Backfilled baths on ${updated} rows. BUYER_ISO test rows with baths now: ${withBaths}.`)
  await prisma.$disconnect()
}

main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1) })
