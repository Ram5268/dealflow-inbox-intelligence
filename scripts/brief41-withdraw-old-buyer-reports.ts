// Brief 41 (H7) — withdraw Buyer Match reports saved before the privacy fix.
// Tightened in Brief 41.1 (PR H).
//
// A report, and a single report section shown in chat, is stored when it's
// made. Ones made before Brief 41 can hold a homeowner's name, our estimate
// shown as a price (and $/SF worked out from it) and raw seller-circumstance
// keys, and Copy still copies them. This replaces their stored content with a
// short note; Ryan can ask Drift to make any of them again. A production data
// step: run it only with Ryan's OK. It never prints report or chat content.
//
// --before must be a full ISO time with a time zone and not later than now;
// the recommended cutoff is 2026-10-06T05:55:00Z (lib/reports/withdrawOldReports.ts).
// --apply first writes the ids it withdraws to a private JSON file
// (~/dev/brief41-1/private/ unless --preimage-dir <dir>, never inside a git
// checkout), then records the same ids in the AuditLog entry.
//
//   npx tsx scripts/brief41-withdraw-old-buyer-reports.ts --before 2026-10-06T05:55:00Z            # dry run (default): counts and ids only
//   npx tsx scripts/brief41-withdraw-old-buyer-reports.ts --before 2026-10-06T05:55:00Z --apply    # withdraw them + an AuditLog entry
// (Brief 41.2: on the live database --apply also needs --i-mean-live.)
import 'dotenv/config'
import { resolve } from 'node:path'
import { Prisma } from '@prisma/client'
import { prisma } from '../lib/prisma'
import { NOTE, RECOMMENDATION, RECOMMENDED_CUTOFF, TEMPLATE, applyWithdrawal, parseCutoff } from '../lib/reports/withdrawOldReports'
import { PrivateDirRefusal, assertPrivateDir, privateDirFrom, privateFileName, writePrivateJson } from '../lib/privateRecord'
import { maintenanceApply } from '../lib/dbGuard'

// Brief 41.2 (engineering precaution): a dry run unless --apply, and --apply
// on a database that isn't *_perf / *_test also needs --i-mean-live.
const APPLY = maintenanceApply(process.env.DATABASE_URL, 'scripts/brief41-withdraw-old-buyer-reports.ts (DATABASE_URL)')

const ORG_SLUG = 'dealflow-ryan'
const REPO_ROOT = resolve(__dirname, '..')

async function main() {
  const at = process.argv.indexOf('--before')
  const cutoff = parseCutoff(at > 0 ? process.argv[at + 1] : undefined, new Date())
  if ('error' in cutoff) {
    console.log(cutoff.error)
    process.exitCode = 2
    return
  }
  const { before } = cutoff
  const apply = APPLY
  const privateDir = privateDirFrom(process.argv)
  if (apply) assertPrivateDir(privateDir, REPO_ROOT) // refuse a bad --preimage-dir before reading anything
  console.log(RECOMMENDATION)
  if (before.toISOString() !== new Date(RECOMMENDED_CUTOFF).toISOString()) {
    console.log(`Note: --before ${before.toISOString()} is not the recommended cutoff. An earlier one leaves some pre-fix reports in place; a later one also withdraws reports made after the fix.`)
  }

  const reports = await prisma.report.findMany({
    where: { templateId: TEMPLATE, createdAt: { lt: before }, NOT: { markdown: NOTE } },
    select: { id: true },
  })
  const sections = await prisma.chatMessage.findMany({
    where: { createdAt: { lt: before }, attachedFragment: { path: ['templateId'], equals: TEMPLATE } },
    select: { id: true },
  })
  console.log(JSON.stringify({
    before: before.toISOString(),
    buyerMatchReports: reports.length,
    buyerMatchChatSections: sections.length,
    reportIds: reports.map(r => r.id),
    chatMessageIds: sections.map(m => m.id),
  }, null, 2))

  if (!apply) {
    console.log('Dry run: nothing changed. Re-run with --apply to withdraw them.')
    return
  }
  if (reports.length === 0 && sections.length === 0) {
    console.log('Nothing to withdraw.')
    return
  }
  const org = await prisma.organization.findUniqueOrThrow({ where: { slug: ORG_SLUG }, select: { id: true } })
  const now = new Date()
  const { recordFile } = await applyWithdrawal(prisma, {
    organizationId: org.id,
    before,
    reportIds: reports.map(r => r.id),
    chatMessageIds: sections.map(m => m.id),
    now,
    dbNull: Prisma.DbNull,
    writeRecord: record => writePrivateJson(privateDir, REPO_ROOT, privateFileName('brief41-withdraw-old-buyer-reports', now), record),
  })
  console.log(`Ids written first: ${recordFile}`)
  console.log(`Withdrew ${reports.length} report(s) and ${sections.length} chat section(s); logged OLD_BUYER_REPORTS_WITHDRAWN with their ids.`)
}

main()
  .catch(e => {
    if (e instanceof PrivateDirRefusal) { console.log(e.message); process.exitCode = 2; return }
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
