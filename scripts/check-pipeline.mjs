import { PrismaClient } from '@prisma/client'

const p = new PrismaClient({
  datasources: { db: { url: 'postgresql://postgres:SjxEeDDjaBIMUOGSIzjacsVXqhsyyGUt@yamanote.proxy.rlwy.net:22304/railway' } }
})

const [logs, reviewItems, recentOpps, needsReview] = await Promise.all([
  p.aIExtractionLog.groupBy({ by: ['extractorType'], _count: { id: true }, orderBy: { _count: { id: 'desc' } } }),
  p.reviewQueueItem.groupBy({ by: ['status'], _count: { id: true } }),
  p.extractedOpportunity.count({ where: { createdAt: { gte: new Date(Date.now() - 3600_000) } } }),
  p.extractedOpportunity.count({ where: { processingStatus: 'needs_review' } }),
])

console.log('\n── AIExtractionLog ──')
if (logs.length === 0) console.log(' (none yet — pipeline may not have fired)')
for (const l of logs) console.log(` ${l.extractorType ?? 'null'}: ${l._count.id} runs`)

console.log('\n── ReviewQueueItem ──')
if (reviewItems.length === 0) console.log(' (none)')
for (const r of reviewItems) console.log(` ${r.status}: ${r._count.id}`)

console.log('\n── Opportunities (last 1h) ──')
console.log(` new: ${recentOpps}`)
console.log(` needs_review total: ${needsReview}`)

await p.$disconnect()
