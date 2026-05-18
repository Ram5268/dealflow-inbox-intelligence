import { prisma } from '../lib/prisma'

async function main() {
  const [logs, reviewItems, recentOpps, needsReview] = await Promise.all([
    prisma.aIExtractionLog.groupBy({ by: ['extractorType'], _count: { id: true }, orderBy: { _count: { id: 'desc' } } }),
    prisma.reviewQueueItem.groupBy({ by: ['status'], _count: { id: true } }),
    prisma.extractedOpportunity.count({ where: { createdAt: { gte: new Date(Date.now() - 3600_000) } } }),
    prisma.extractedOpportunity.count({ where: { processingStatus: 'needs_review' } }),
  ])

  console.log('\n── AIExtractionLog ──')
  if (logs.length === 0) console.log('  (none yet — new pipeline may not have fired or no new emails)')
  for (const l of logs) console.log(`  ${l.extractorType ?? 'null'}: ${l._count.id} runs`)

  console.log('\n── ReviewQueueItem ──')
  if (reviewItems.length === 0) console.log('  (none)')
  for (const r of reviewItems) console.log(`  ${r.status}: ${r._count.id}`)

  console.log('\n── Opportunities (last 1h) ──')
  console.log(`  new: ${recentOpps}`)
  console.log(`  needs_review total: ${needsReview}`)

  await prisma.$disconnect()
}

main().catch(console.error)
