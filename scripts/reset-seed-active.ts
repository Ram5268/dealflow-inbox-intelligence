// One-time repair: reset seed test rows that the StreetEasy sweep marked 'stale'
// back to 'active'. During seed-only trial mode there is no real inbox flow, so
// the sweep had no legitimate work and was draining the demo inventory (e.g.
// SEED_RENT_18, the West Village 2BR, went stale between smoke tests). The sweep
// is now paused via STREETEASY_SYNC_ENABLED=false (see lib/streetEasySync.ts), so
// this only needs to run once to un-stale what the sweep already touched.
//
// Run: DATABASE_URL="..." npx tsx --no-cache scripts/reset-seed-active.ts
import { prisma } from '../lib/prisma'
import { refuseLiveDatabase } from '../lib/dbGuard'

// Brief 41.2 (engineering precaution): test or seed data only, so it refuses
// any database but a *_perf or *_test one, with no override.
refuseLiveDatabase(process.env.DATABASE_URL, 'scripts/reset-seed-active.ts (DATABASE_URL)')

async function main() {
  const { count } = await prisma.extractedOpportunity.updateMany({
    where: { isTestData: true, processingStatus: 'stale' },
    data: { processingStatus: 'active' },
  })
  console.log(`Reset ${count} seed test row(s) from 'stale' back to 'active'.`)
}

main()
  .catch(e => { console.error(e); process.exit(1) })
  .finally(() => prisma.$disconnect())
