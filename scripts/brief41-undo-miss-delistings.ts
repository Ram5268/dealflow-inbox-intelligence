// Brief 41 (H5) — restore listings that were marked delisted only because a
// StreetEasy lookup found nothing.
//
// Before Brief 41, opening a listing (or the status sweep) marked it
// streetEasyStatus='delisted' + processingStatus='stale' whenever StreetEasy
// didn't find it: off-market and coming-soon listings, a missing key, a 429.
// That hid them from Drift's search and the buyer report. A delisting that came
// from StreetEasy itself always stored the listing's StreetEasy id, so
// "delisted with no StreetEasy id" is exactly a miss. This puts those back to
// active (and clears the false status). A production data step: run it only
// with Ryan's OK. It prints counts and ids only.
//
//   npx tsx scripts/brief41-undo-miss-delistings.ts            # dry run (default)
//   npx tsx scripts/brief41-undo-miss-delistings.ts --apply    # restore them + an AuditLog entry
import 'dotenv/config'
import { prisma } from '../lib/prisma'

const ORG_SLUG = 'dealflow-ryan'
const MISSED = { streetEasyStatus: 'delisted', streetEasyId: null, processingStatus: 'stale' } as const

async function main() {
  const apply = process.argv.includes('--apply')
  const rows = await prisma.extractedOpportunity.findMany({
    where: MISSED,
    select: { id: true, category: true, isTestData: true },
  })
  const byCategory: Record<string, number> = {}
  for (const r of rows) byCategory[r.category] = (byCategory[r.category] ?? 0) + 1
  console.log(JSON.stringify({
    hiddenByAMiss: rows.length,
    ofWhichTestData: rows.filter(r => r.isTestData).length,
    byCategory,
    ids: rows.slice(0, 50).map(r => r.id),
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
  const [restored] = await prisma.$transaction([
    prisma.extractedOpportunity.updateMany({
      where: { ...MISSED, id: { in: rows.map(r => r.id) } },
      data: { processingStatus: 'active', streetEasyStatus: null },
    }),
    prisma.auditLog.create({
      data: {
        organizationId: org.id,
        action: 'MISS_DELISTINGS_RESTORED',
        detailsJson: { source: 'brief41-undo-miss-delistings', at: new Date().toISOString(), restored: rows.length, byCategory },
      },
    }),
  ])
  console.log(`Restored ${restored.count} listing(s) to active; logged MISS_DELISTINGS_RESTORED.`)
}

main()
  .catch(e => { console.error(e); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
