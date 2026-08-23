// Brief 32 Part A — backfill heuristic buyerArchetype onto existing [TEST_10]
// BUYER_ISO opportunities. [TEST_10] MojoContact SELLER motivation fields are
// deliberately LEFT NULL (they should abstain with LOW confidence — correct
// behavior; we do not fabricate distress signals for old seed).
//
// Run:  npx tsx scripts/seed-brief32-backfill.ts
import 'dotenv/config'
import { prisma } from '../lib/prisma'
import { ensureConnected } from './seed-stress-common'

function archetypeFor(text: string, maxPrice: number | null): string {
  const t = text.toLowerCase()
  if (t.includes('cash')) return 'CASH_BUYER'
  if (maxPrice != null && maxPrice >= 5_000_000) return 'LUXURY_ALL_CASH'
  if (t.includes('1031') || t.includes('exchange')) return 'EXCHANGE_1031'
  if (t.includes('first time') || t.includes('first-time') || t.includes('fha')) return 'FIRST_TIME_FHA'
  if (t.includes('investor') || t.includes('multi-family') || t.includes('multifamily')) return 'INVESTOR_LANDLORD'
  return 'TRADITIONAL_FINANCING'
}

async function main() {
  await ensureConnected()
  const rows = await prisma.extractedOpportunity.findMany({
    where: { extractedTitle: { startsWith: '[TEST_10] ' }, category: 'BUYER_ISO' },
    select: { id: true, extractedTitle: true, extractedSummary: true, maxPrice: true, buyerArchetype: true },
  })
  console.log(`Found ${rows.length} [TEST_10] BUYER_ISO opportunities.`)

  const byArch: Record<string, string[]> = {}
  for (const r of rows) {
    const arch = archetypeFor(`${r.extractedTitle} ${r.extractedSummary}`, r.maxPrice)
    ;(byArch[arch] ??= []).push(r.id)
  }

  const counts: Record<string, number> = {}
  for (const [arch, ids] of Object.entries(byArch)) {
    await prisma.extractedOpportunity.updateMany({ where: { id: { in: ids } }, data: { buyerArchetype: arch } })
    counts[arch] = ids.length
  }

  console.log('\n✅ Backfilled buyerArchetype on [TEST_10] BUYER_ISO rows:', counts)
  console.log('   [TEST_10] MojoContact SELLER motivation fields left NULL by design (LOW-confidence abstain).')
  await prisma.$disconnect()
}

main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1) })
