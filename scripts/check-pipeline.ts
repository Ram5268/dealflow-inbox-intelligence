import 'dotenv/config'
import { prisma } from '../lib/prisma'

async function main() {
  const [emailStats, oppStats, recentEmails, recentOpps, failedEmails] = await Promise.all([
    // Total emails + recent sync
    prisma.rawEmail.aggregate({
      _count: { id: true },
      _max: { receivedDateTime: true },
    }),
    // Opportunities by category
    prisma.extractedOpportunity.groupBy({
      by: ['category'],
      _count: { id: true },
      orderBy: { _count: { id: 'desc' } },
      take: 8,
    }),
    // Last 5 emails synced
    prisma.rawEmail.findMany({
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: { subject: true, senderEmail: true, receivedDateTime: true, processed: true, classifierStatus: true, extractionStatus: true },
    }),
    // Last 5 opportunities extracted
    prisma.extractedOpportunity.findMany({
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: { extractedTitle: true, category: true, confidenceScore: true, createdAt: true },
    }),
    // Emails stuck unprocessed
    prisma.rawEmail.count({ where: { processed: false } }),
  ])

  console.log('═══ EMAIL SYNC ═══')
  console.log(`Total emails in DB: ${emailStats._count.id}`)
  console.log(`Latest received:    ${emailStats._max.receivedDateTime}`)
  console.log(`Unprocessed emails: ${failedEmails}`)

  console.log('\n═══ OPPORTUNITIES ═══')
  oppStats.forEach(o => console.log(`  ${o.category.padEnd(30)} ${o._count.id}`))

  console.log('\n═══ LAST 5 EMAILS SYNCED ═══')
  recentEmails.forEach(e => console.log(
    `  [${e.classifierStatus ?? 'unclassified'}/${e.extractionStatus ?? 'unextracted'}] ${e.subject?.slice(0, 60)}`
  ))

  console.log('\n═══ LAST 5 OPPORTUNITIES EXTRACTED ═══')
  recentOpps.forEach(o => console.log(
    `  [${o.category}] ${o.extractedTitle?.slice(0, 55)} (${o.confidenceScore?.toFixed(2)})`
  ))

  await prisma.$disconnect()
}
main()
// run separately
