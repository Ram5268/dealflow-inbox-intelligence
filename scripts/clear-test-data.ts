// Wipes all records created by seed-test-data.ts — leaves real pipeline data untouched.
import { prisma } from '../lib/prisma'

async function main() {
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
