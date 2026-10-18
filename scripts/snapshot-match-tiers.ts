import 'dotenv/config'
import { prisma } from '../lib/prisma'
import { refuseLiveDatabase } from '../lib/dbGuard'

// Brief 41.2 (engineering precaution): it measures the seed Match regenerations
// (test databases only), so it refuses any database but a *_perf or *_test
// one, with no override.
refuseLiveDatabase(process.env.DATABASE_URL, 'scripts/snapshot-match-tiers.ts (DATABASE_URL)')

// Brief 30.2 — match-tier distribution snapshot. Run before/after regenerating the
// Match table to measure the scoring-fix impact. Read-only (SELECT/groupBy only).
async function main() {
  const rows = await prisma.match.groupBy({
    by: ['counterpartType'],
    _count: { id: true },
  })
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
  console.log('Total Match rows by counterpartType:')
  for (const r of rows) console.log(`  ${r.counterpartType}: ${r._count.id}`)
  console.log('\nScore distribution:')
  for (const r of bucketed) console.log(`  ${r.bucket}: ${r.n}`)
  await prisma.$disconnect()
}
main().catch(e => { console.error(e); process.exit(1) })
