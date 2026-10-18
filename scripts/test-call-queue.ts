// Brief 33 — spot-check the ranker against seed data. Prints distribution + top-10.
// persist=false — reads only, never writes CallQueueEntry (the cron writes).
//
// Run:  npx tsx scripts/test-call-queue.ts
import 'dotenv/config'
import { prisma } from '../lib/prisma'
import { buildCallQueue } from '../lib/ranking/queueBuilder'
import { getCurrentOrgId } from '../lib/auth/orgContext'
import { refuseLiveDatabase } from '../lib/dbGuard'

// Brief 41.2 (engineering precaution): a spot check of seed data that prints
// contact names, so it refuses any database but a *_perf or *_test one, with
// no override.
refuseLiveDatabase(process.env.DATABASE_URL, 'scripts/test-call-queue.ts (DATABASE_URL)')

async function main() {
  const orgId = await getCurrentOrgId()
  console.log(`\n=== buildCallQueue for org ${orgId} ===\n`)

  const { entries, stats } = await buildCallQueue(orgId, 50, false, { scope: 'all' })

  console.log(`Total contacts considered: ${stats.totalContactsConsidered}`)
  console.log(`Exclusions by reason:`)
  for (const [reason, count] of Object.entries(stats.exclusionCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${count.toString().padStart(6)}  ${reason}`)
  }
  console.log(`Queue length: ${stats.queueLength}`)
  console.log(`Priority distribution:`)
  console.log(`  top-10 avg:  ${stats.priorityDistribution.top10Avg.toFixed(1)}`)
  console.log(`  top-50 avg:  ${stats.priorityDistribution.top50Avg.toFixed(1)}`)
  console.log(`  rank #1:     ${stats.priorityDistribution.rank1Score}`)
  console.log(`  rank #50:    ${stats.priorityDistribution.rank50Score}`)
  console.log(`  spread:      ${stats.priorityDistribution.spread}`)

  console.log(`\nTop 10:`)
  for (const e of entries.slice(0, 10)) {
    console.log(`  ${e.rank.toString().padStart(3)}. [${e.priorityScore.toString().padStart(3)}] ${e.contact.fullName}`)
    console.log(`         reason: ${e.reason}`)
    if (e.primaryMatch) {
      console.log(`         primary match: fit=${e.primaryMatch.matchFit} capture=${e.primaryMatch.captureStatus} conf=${e.primaryMatch.matchFitConfidence}`)
    }
  }

  await prisma.$disconnect()
}
main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1) })
