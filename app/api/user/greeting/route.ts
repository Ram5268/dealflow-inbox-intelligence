export const dynamic = 'force-dynamic'
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

// Read-only counts for the Greeting screen pulse rows.
// No schema changes — plain Prisma count queries on existing tables.
export async function GET() {
  const midnight = new Date()
  midnight.setHours(0, 0, 0, 0)

  const [overnightEmails, overnightOpps, totalOpps, lastAudit] = await Promise.all([
    prisma.rawEmail.count({
      where: { receivedDateTime: { gte: midnight } },
    }),
    prisma.extractedOpportunity.count({
      where: { isDuplicate: false, createdAt: { gte: midnight } },
    }),
    prisma.extractedOpportunity.count({
      where: { isDuplicate: false },
    }),
    prisma.auditLog.findFirst({
      where: { action: 'BACKGROUND_SYNC' },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    }),
  ])

  return NextResponse.json({
    overnightEmails,
    overnightOpps,
    totalOpps,
    lastSync: lastAudit?.createdAt ?? null,
  })
}
