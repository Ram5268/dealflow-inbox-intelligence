// Wipes all records created by seed-test-data.ts — leaves real pipeline data untouched.
//
//   npx tsx scripts/clear-test-data.ts            # dry run (default): counts only
//   npx tsx scripts/clear-test-data.ts --apply    # delete them
import { prisma } from '../lib/prisma'
import { applyRequested, refuseLiveDatabase } from '../lib/dbGuard'

// Brief 41.2 (engineering precaution): test data only, so it refuses any
// database but a *_perf or *_test one, with no override. Even there it only
// counts, unless --apply.
refuseLiveDatabase(process.env.DATABASE_URL, 'scripts/clear-test-data.ts (DATABASE_URL)')
const APPLY = applyRequested()

async function main() {
  if (!APPLY) {
    const opportunities = await prisma.extractedOpportunity.count({ where: { isTestData: true } })
    const anchors = await prisma.rawEmail.count({ where: { subject: '__TEST_SEED__' } })
    console.log(`Dry run: would delete ${opportunities} test opportunities and ${anchors} test email anchor(s). Nothing deleted.`)
    console.log('Re-run with --apply to delete them.')
    return
  }
  const deleted = await prisma.extractedOpportunity.deleteMany({
    where: { isTestData: true },
  })
  console.log(`✅ Deleted ${deleted.count} test opportunities.`)

  // Clean up the anchor email if it exists
  await prisma.rawEmail.deleteMany({
    where: { subject: '__TEST_SEED__' },
  })
  console.log('✅ Removed test email anchor.')
}

main().catch(console.error).finally(() => prisma.$disconnect())
