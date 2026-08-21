import 'dotenv/config'
import { prisma } from '../lib/prisma'
import { runMatchmaking } from '../lib/matchmaking'
import { SUPPLY_SALE, SUPPLY_RENTAL } from '../lib/domain/Categories'

// Brief 31.0 — one-off DATA regeneration of the seed Match table using the
// Brief 30.2-fixed matcher. Pure JS, zero API cost.
//
// DEVIATION FROM BRIEF (Ryan-approved 2026-08-21): pass ONLY seed LISTING ids to
// runMatchmaking, not all seed ids. Passing all ids fires all four loops and files
// every pair in BOTH directions (listing→buyer AND buyer→listing) = ~5484 rows —
// 2x the brief's expected 2742, tripping its own gate 2 (>4000). Listing-ids-only
// fires loops 1+2 only, filing (opportunityId=listing, counterpartId=buyer) — the
// single direction the report engine reads (context.ts: where counterpartId=buyerId)
// and exactly the brief's expected 2742.

async function main() {
  const preCount = await prisma.match.count()
  console.log(`\n=== Pre-regenerate state ===`)
  console.log(`Match rows: ${preCount}`)
  if (preCount > 5000) {
    console.error(`ABORT: ${preCount} Match rows looks like production, not dev. Confirm DATABASE_URL points to Railway dev, then re-run.`)
    process.exit(2)
  }

  const seedOpps = await prisma.extractedOpportunity.findMany({
    where: { isTestData: true, isDuplicate: false, processingStatus: 'active' },
    select: { id: true, category: true },
  })
  console.log(`Seed opportunities: ${seedOpps.length}`)
  const seedIds = new Set(seedOpps.map(o => o.id))

  // Listing ids only (SUPPLY_SALE ∪ SUPPLY_RENTAL) — see deviation note above.
  const listingCats = new Set<string>([...SUPPLY_SALE, ...SUPPLY_RENTAL] as string[])
  const seedListingIds = seedOpps.filter(o => listingCats.has(o.category)).map(o => o.id)
  console.log(`Seed LISTING ids (passed to runMatchmaking): ${seedListingIds.length}`)

  // Delete Match rows where BOTH sides are seed opportunities. Preserve mojo +
  // non-seed + non-'opportunity' (e.g. showing_confirmation) rows.
  const candidateDeletes = await prisma.match.findMany({
    where: { counterpartType: 'opportunity' },
    select: { id: true, opportunityId: true, counterpartId: true },
  })
  const toDelete = candidateDeletes.filter(m => seedIds.has(m.opportunityId) && seedIds.has(m.counterpartId))
  console.log(`Match rows to delete (both sides seed, counterpartType=opportunity): ${toDelete.length}`)
  if (toDelete.length > 0) {
    await prisma.match.deleteMany({ where: { id: { in: toDelete.map(m => m.id) } } })
    console.log(`Deleted ${toDelete.length} rows.`)
  }

  const mojoLeft = await prisma.match.count({ where: { counterpartType: 'mojo' } })
  if (mojoLeft > 0) console.log(`(Preserved ${mojoLeft} Match rows with counterpartType='mojo'.)`)

  console.log(`\n=== Running runMatchmaking on ${seedListingIds.length} seed LISTING opps ===`)
  const t0 = Date.now()
  const result = await runMatchmaking(seedListingIds)
  const ms = Date.now() - t0
  console.log(`Done in ${ms}ms. Created ${result.total} match rows. High-confidence (>=70): ${result.highConfidence}.`)

  const postCount = await prisma.match.count()
  console.log(`\n=== Post-regenerate state ===`)
  console.log(`Match rows: ${postCount} (delta ${postCount - preCount >= 0 ? '+' : ''}${postCount - preCount})`)

  const bucketed = await prisma.$queryRaw<Array<{ bucket: string; n: bigint }>>`
    SELECT CASE
      WHEN score >= 80 THEN 'HOT (>=80)'
      WHEN score >= 65 THEN 'WARM (65-79)'
      WHEN score >= 50 THEN 'POSSIBLE (50-64)'
      ELSE 'BELOW (<50)'
    END AS bucket,
    COUNT(*) AS n
    FROM "Match"
    GROUP BY 1
    ORDER BY 1
  `
  console.log(`\nScore distribution:`)
  for (const r of bucketed) console.log(`  ${r.bucket}: ${r.n}`)

  const buyerAMatches = await prisma.match.findMany({
    where: { OR: [{ opportunityId: 'cmsp7l5he001qloo89haui4u2' }, { counterpartId: 'cmsp7l5he001qloo89haui4u2' }] },
    select: { id: true, opportunityId: true, counterpartId: true, score: true, reason: true },
    orderBy: { score: 'desc' },
    take: 5,
  })
  console.log(`\n=== BUYER_A (cmsp7l5he001qloo89haui4u2) — top 5 matches ===`)
  for (const m of buyerAMatches) console.log(`  score=${m.score} :: ${m.reason?.slice(0, 100)}`)
  const buyerAHot = buyerAMatches.find(m => m.score >= 80)
  if (!buyerAHot) {
    console.error(`\nWARN: BUYER_A has no HOT (>=80) match filed. In-memory A/B showed 90. Something may not have flowed through.`)
  } else {
    console.log(`\n✓ BUYER_A has a HOT match filed (score ${buyerAHot.score}). Fix confirmed in persisted state.`)
  }

  await prisma.$disconnect()
}
main().catch(e => { console.error(e); process.exit(1) })
