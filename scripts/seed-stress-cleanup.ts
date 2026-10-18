// Brief 10.0 — cleanup: delete EVERY [TEST_10] row (Mojo buyers + inbox opps) and
// any Match / MatchDismissal rows referencing them, plus the shared anchor email.
// Real data (7,409 Mojo sellers, the 161 pre-existing fixture opps) is untouched:
// this only ever targets the [TEST_10] prefix + the Brief 10.0 anchor.
//
// Preview:  npx tsx scripts/seed-stress-cleanup.ts --dry-run
// Delete:   npx tsx scripts/seed-stress-cleanup.ts
import { TAG } from './seed-stress-common'
import { prisma } from '../lib/prisma'
import { refuseLiveDatabase } from '../lib/dbGuard'

// Brief 41.2 (engineering precaution): test or seed data only, so it refuses
// any database but a *_perf or *_test one, with no override.
refuseLiveDatabase(process.env.DATABASE_URL, 'scripts/seed-stress-cleanup.ts (DATABASE_URL)')

const DRY = process.argv.includes('--dry-run')

async function main() {
  const opps = await prisma.extractedOpportunity.findMany({
    where: { extractedTitle: { startsWith: `${TAG} ` } }, select: { id: true },
  })
  const mojo = await prisma.mojoContact.findMany({
    where: { fullName: { startsWith: `${TAG} ` } }, select: { id: true },
  })
  const oppIds = opps.map(o => o.id)
  const mojoIds = mojo.map(m => m.id)

  // Match rows referencing a TEST_10 row on EITHER side (counterpartId is not an
  // FK, so opp cascade-delete would miss counterpart-side rows — delete explicitly).
  const refIds = [...oppIds, ...mojoIds]
  const matchWhere = refIds.length
    ? { OR: [{ opportunityId: { in: oppIds } }, { counterpartId: { in: refIds } }] }
    : { id: '__none__' }
  const matchCount = await prisma.match.count({ where: matchWhere })
  const dismissalCount = oppIds.length
    ? await prisma.matchDismissal.count({ where: { OR: [{ partyId: { in: oppIds } }, { listingId: { in: oppIds } }] } })
    : 0
  const anchor = await prisma.rawEmail.findUnique({ where: { graphMessageId: `${TAG}-anchor-email` }, select: { id: true } })

  console.log(`${DRY ? '[DRY RUN] would delete' : 'Deleting'}:`)
  console.log(`  Match rows:          ${matchCount}`)
  console.log(`  MatchDismissal rows: ${dismissalCount}`)
  console.log(`  ExtractedOpportunity:${oppIds.length}`)
  console.log(`  MojoContact:         ${mojoIds.length}`)
  console.log(`  Anchor RawEmail:     ${anchor ? 1 : 0}`)

  if (DRY) { await prisma.$disconnect(); return }

  if (refIds.length) await prisma.match.deleteMany({ where: matchWhere })
  if (oppIds.length) {
    await prisma.matchDismissal.deleteMany({ where: { OR: [{ partyId: { in: oppIds } }, { listingId: { in: oppIds } }] } })
    await prisma.extractedOpportunity.deleteMany({ where: { id: { in: oppIds } } })
  }
  if (mojoIds.length) await prisma.mojoContact.deleteMany({ where: { id: { in: mojoIds } } })
  if (anchor) await prisma.rawEmail.deleteMany({ where: { graphMessageId: `${TAG}-anchor-email` } })

  console.log(`\n✅ Removed all ${TAG} rows.`)
  await prisma.$disconnect()
}

main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1) })
