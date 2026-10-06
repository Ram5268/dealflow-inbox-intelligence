// Brief 41 (H5) — restore listings that were marked delisted only because a
// StreetEasy lookup found nothing.
//
// Before Brief 41, opening a listing (or the status sweep) marked it
// streetEasyStatus='delisted' + processingStatus='stale' whenever StreetEasy
// didn't find it: off-market and coming-soon listings, a missing key, a 429.
// That hid them from Drift's search and the buyer report. A delisting that came
// from StreetEasy itself always stored the listing's StreetEasy id, so
// "delisted with no StreetEasy id" is exactly a miss. The plan
// (lib/streetEasyMissRepair.ts) clears the false status on all of them and puts
// back only what the miss made stale and Ryan hasn't decided on in review. A
// production data step: run it only with Ryan's OK. It prints counts and ids.
//
//   npx tsx scripts/brief41-undo-miss-delistings.ts            # dry run (default)
//   npx tsx scripts/brief41-undo-miss-delistings.ts --apply    # restore them + an AuditLog entry
import 'dotenv/config'
import { prisma } from '../lib/prisma'
import { planMissRepair } from '../lib/streetEasyMissRepair'

const ORG_SLUG = 'dealflow-ryan'
const MISSED = { streetEasyStatus: 'delisted', streetEasyId: null } as const

async function main() {
  const apply = process.argv.includes('--apply')
  const rows = await prisma.extractedOpportunity.findMany({
    where: MISSED,
    select: { id: true, category: true, isTestData: true, isDuplicate: true, processingStatus: true },
  })
  const reviewItems = rows.length
    ? await prisma.reviewQueueItem.findMany({ where: { opportunityId: { in: rows.map(r => r.id) } }, select: { opportunityId: true, status: true } })
    : []
  const plan = planMissRepair(rows, reviewItems)
  const byCategory: Record<string, number> = {}
  for (const r of rows) byCategory[r.category] = (byCategory[r.category] ?? 0) + 1
  console.log(JSON.stringify({
    delistedByAMiss: rows.length,
    ofWhichTestData: rows.filter(r => r.isTestData).length,
    byCategory,
    falseStatusToClear: plan.clearStatus.length,
    backToActive: plan.toActive.length,
    backToReviewQueue: plan.toNeedsReview.length,
    leftAsDecided: plan.keptByDecision.length,
    activeIds: plan.toActive.slice(0, 50),
    reviewIds: plan.toNeedsReview.slice(0, 50),
  }, null, 2))

  if (!apply) {
    console.log('Dry run: nothing changed. Re-run with --apply to restore them.')
    return
  }
  if (rows.length === 0) {
    console.log('Nothing to restore.')
    return
  }
  const org = await prisma.organization.findUniqueOrThrow({ where: { slug: ORG_SLUG }, select: { id: true } })
  const [cleared, active, review] = await prisma.$transaction([
    prisma.extractedOpportunity.updateMany({ where: { ...MISSED, id: { in: plan.clearStatus } }, data: { streetEasyStatus: null } }),
    prisma.extractedOpportunity.updateMany({ where: { id: { in: plan.toActive }, processingStatus: 'stale' }, data: { processingStatus: 'active' } }),
    prisma.extractedOpportunity.updateMany({ where: { id: { in: plan.toNeedsReview }, processingStatus: 'stale' }, data: { processingStatus: 'needs_review' } }),
    prisma.auditLog.create({
      data: {
        organizationId: org.id,
        action: 'MISS_DELISTINGS_RESTORED',
        detailsJson: {
          source: 'brief41-undo-miss-delistings', at: new Date().toISOString(), byCategory,
          cleared: plan.clearStatus.length, active: plan.toActive.length, review: plan.toNeedsReview.length, leftAsDecided: plan.keptByDecision.length,
        },
      },
    }),
  ])
  console.log(`Cleared the false status on ${cleared.count}; ${active.count} back to active, ${review.count} back to the review queue. Logged MISS_DELISTINGS_RESTORED.`)
}

main()
  .catch(e => { console.error(e); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
