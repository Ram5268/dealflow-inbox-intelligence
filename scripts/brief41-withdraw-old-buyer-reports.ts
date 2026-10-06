// Brief 41 (H7) — withdraw Buyer Match reports saved before the privacy fix.
//
// A report, and a single report section shown in chat, is stored when it's
// made. Ones made before Brief 41 can hold a homeowner's name, our estimate
// shown as a price (and $/SF worked out from it) and raw seller-circumstance
// keys, and Copy still copies them. This replaces their stored content with a
// short note; Ryan can ask Drift to make any of them again. A production data
// step: run it only with Ryan's OK. It never prints report or chat content.
//
//   npx tsx scripts/brief41-withdraw-old-buyer-reports.ts --before <ISO time the fix went live>            # dry run (default): counts only
//   npx tsx scripts/brief41-withdraw-old-buyer-reports.ts --before <ISO time the fix went live> --apply    # withdraw them + an AuditLog entry
import 'dotenv/config'
import { Prisma } from '@prisma/client'
import { prisma } from '../lib/prisma'

const TEMPLATE = 'buyer-match'
const ORG_SLUG = 'dealflow-ryan'
const NOTE = 'This report was made before a privacy fix (Brief 41) and has been withdrawn. Ask Drift to make it again.'
const SECTION_NOTE = 'This report section was made before a privacy fix (Brief 41) and has been withdrawn. Ask Drift to make it again.'

async function main() {
  const at = process.argv.indexOf('--before')
  const before = at > 0 ? new Date(process.argv[at + 1] ?? '') : null
  if (!before || Number.isNaN(before.getTime())) {
    console.log('Usage: --before <ISO time the fix went live> [--apply]')
    process.exitCode = 2
    return
  }
  const apply = process.argv.includes('--apply')

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
  await prisma.$transaction([
    prisma.report.updateMany({
      where: { id: { in: reports.map(r => r.id) } },
      data: {
        markdown: NOTE,
        sections: [{ key: 'withdrawn', title: 'Report withdrawn', content: { prose: NOTE }, sources: [] }],
        sources: [],
      },
    }),
    // The chat message that carried a section also restated it in prose.
    prisma.chatMessage.updateMany({
      where: { id: { in: sections.map(m => m.id) } },
      data: { attachedFragment: Prisma.DbNull, content: SECTION_NOTE },
    }),
    prisma.auditLog.create({
      data: {
        organizationId: org.id,
        action: 'OLD_BUYER_REPORTS_WITHDRAWN',
        detailsJson: {
          source: 'brief41-withdraw-old-buyer-reports',
          at: new Date().toISOString(),
          before: before.toISOString(),
          reports: reports.length,
          chatSections: sections.length,
        },
      },
    }),
  ])
  console.log(`Withdrew ${reports.length} report(s) and ${sections.length} chat section(s); logged OLD_BUYER_REPORTS_WITHDRAWN.`)
}

main()
  .catch(e => { console.error(e); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
