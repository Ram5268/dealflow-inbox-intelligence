export const dynamic = 'force-dynamic'
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export async function GET() {
  const [totalEmails, totalOpportunities, byCategoryRaw, recent, lastAudit] =
    await Promise.all([
      prisma.rawEmail.count(),
      prisma.extractedOpportunity.count({ where: { isDuplicate: false } }),
      prisma.extractedOpportunity.groupBy({
        by: ['category'],
        _count: { category: true },
        where: { isDuplicate: false },
      }),
      prisma.extractedOpportunity.findMany({
        where: { isDuplicate: false },
        orderBy: { createdAt: 'desc' },
        take: 5,
      }),
      prisma.auditLog.findFirst({
        where: { action: 'SYNC_RUN' },
        orderBy: { createdAt: 'desc' },
      }),
    ])

  const byCategoryMap: Record<string, number> = {}
  for (const row of byCategoryRaw) {
    byCategoryMap[row.category] = row._count.category
  }

  return NextResponse.json({
    totalEmails,
    totalOpportunities,
    byCategoryRaw: byCategoryMap,
    recent,
    lastSync: lastAudit?.createdAt ?? null,
  })
}
