export const dynamic = 'force-dynamic'
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { startOfNewYorkDay } from '@/lib/time/newYork'

// Read-only counts for the Greeting screen pulse rows.
// No schema changes — plain Prisma count queries on existing tables.
export async function GET() {
  // Brief 48 (PR 4): "overnight" counts from New York midnight [planner]. setHours(0, 0, 0, 0) was
  // midnight on the server's own clock, UTC on Vercel: 8 PM New York time the evening before (7 PM in winter).
  const midnight = startOfNewYorkDay(new Date())

  const [overnightEmails, overnightOpps, totalOpps, lastAudit, newMatches, newShowingConfirmations, pendingReviewCount] = await Promise.all([
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
    prisma.match.count({ where: { seen: false, score: { gte: 50 } } }),
    prisma.match.count({ where: { seen: false, counterpartType: 'showing_confirmation' } }),
    prisma.reviewQueueItem.count({ where: { status: 'pending' } }),
  ])

  return NextResponse.json({
    overnightEmails,
    overnightOpps,
    totalOpps,
    lastSync: lastAudit?.createdAt ?? null,
    newMatches,
    newShowingConfirmations,
    pendingReviewCount,
  })
}
