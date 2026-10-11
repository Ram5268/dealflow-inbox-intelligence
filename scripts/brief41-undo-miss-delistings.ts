// Brief 41 (H5) — restore listings that were marked delisted only because a
// StreetEasy lookup found nothing. Made safe in Brief 41.1 (PR H).
//
// Before Brief 41, opening a listing (or the status sweep) marked it
// streetEasyStatus='delisted' + processingStatus='stale' whenever StreetEasy
// didn't find it: off-market and coming-soon listings, a missing key, a 429.
// That hid them from Drift's search and the buyer report. A delisting that came
// from StreetEasy itself always stored the listing's StreetEasy id, so
// "delisted with no StreetEasy id" is exactly a miss. The plan
// (lib/streetEasyMissRepair.ts) clears the false status on all of them and
// decides each listing's status by category and date: back to active only
// where a miss means nothing (off-market, coming soon, buyer and renter
// requests); to the review queue for every other category (an active sale or
// rental may really have sold); still stale where the sweep's date rules say
// so (a past open house); Ryan's review decisions stand. A production data
// step: run it only with Ryan's OK on the dry run's split. It prints counts
// and ids, never listing content.
//
// --apply needs --expect <n>, the row count of the dry run Ryan approved, and
// writes a pre-image (id, old and new statuses) to a private JSON file before
// it changes anything: ~/dev/brief41-1/private/ unless --preimage-dir <dir>,
// never inside a git checkout. The same pre-image goes in the AuditLog entry.
//
//   npx tsx scripts/brief41-undo-miss-delistings.ts                         # dry run (default): the split and the --expect number
//   npx tsx scripts/brief41-undo-miss-delistings.ts --apply --expect <n>    # apply exactly that plan + an AuditLog entry
import 'dotenv/config'
import { resolve } from 'node:path'
import { prisma } from '../lib/prisma'
import {
  MISSED, MissRepairRefusal, applyMissRepair, formatMissRepairTable, missRepairSummary, parseExpect, planMissRepair,
} from '../lib/streetEasyMissRepair'
import { PrivateDirRefusal, assertPrivateDir, privateDirFrom, privateFileName, writePrivateJson } from '../lib/privateRecord'

const ORG_SLUG = 'dealflow-ryan'
const REPO_ROOT = resolve(__dirname, '..')

async function main() {
  const apply = process.argv.includes('--apply')
  const expect = parseExpect(process.argv)
  const privateDir = privateDirFrom(process.argv)
  if (apply) assertPrivateDir(privateDir, REPO_ROOT) // refuse a bad --preimage-dir before reading anything

  const org = await prisma.organization.findUnique({ where: { slug: ORG_SLUG }, select: { id: true } })
  if (!org) throw new MissRepairRefusal(`Refusing: no organization "${ORG_SLUG}" in this database. Nothing changed.`)

  const now = new Date()
  const rows = await prisma.extractedOpportunity.findMany({
    where: { organizationId: org.id, ...MISSED },
    select: {
      id: true, rawEmailId: true, category: true, isTestData: true, isDuplicate: true, processingStatus: true,
      streetEasyStatus: true, streetEasyId: true, streetEasyCheckedAt: true, availabilityDate: true, createdAt: true,
    },
  })
  const reviewItems = rows.length
    ? await prisma.reviewQueueItem.findMany({ where: { opportunityId: { in: rows.map(r => r.id) } }, select: { opportunityId: true, status: true } })
    : []
  const plan = planMissRepair(rows, reviewItems, now)
  console.log(formatMissRepairTable(plan))
  console.log(JSON.stringify(missRepairSummary(plan), null, 2))

  if (!apply) {
    console.log(`Dry run: nothing changed. To apply exactly this plan, re-run with --apply --expect ${plan.changes.length}`)
    return
  }
  const result = await applyMissRepair(prisma, plan, {
    organizationId: org.id,
    expect,
    now,
    writePreimage: preimage => writePrivateJson(privateDir, REPO_ROOT, privateFileName('brief41-undo-miss-delistings', now), preimage),
  })
  if (result.changed === 0) {
    console.log('Nothing to restore.')
    return
  }
  console.log(`Pre-image written first: ${result.preimageFile}`)
  console.log(`Cleared the false status on ${result.changed}; ${result.active} back to active, ${result.review} to the review queue (${result.reviewItemIds.length} new review item(s)). Logged MISS_DELISTINGS_RESTORED.`)
}

main()
  .catch(e => {
    if (e instanceof MissRepairRefusal || e instanceof PrivateDirRefusal) { console.log(e.message); process.exitCode = 2; return }
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
