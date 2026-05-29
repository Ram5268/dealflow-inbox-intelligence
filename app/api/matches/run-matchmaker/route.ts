export const dynamic = 'force-dynamic'
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { runMatchmaking } from '@/lib/matchmaking'

// POST /api/matches/run-matchmaker — manual matchmaker trigger from /matches.
// Iterates over opportunities from the last 30 days; runMatchmaking handles
// per-category routing internally. The unique constraint on Match
// (opportunityId, counterpartId, counterpartType) added in 2026-05-29
// ensures repeated runs don't create duplicates.
export async function POST() {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)

  const recentOpps = await prisma.extractedOpportunity.findMany({
    where: {
      createdAt:        { gte: since },
      isDuplicate:      false,
      processingStatus: 'active',
    },
    select: { id: true },
  })

  const result = await runMatchmaking(recentOpps.map(o => o.id))

  return NextResponse.json({
    ok:             true,
    newMatches:     result.total,
    highConfidence: result.highConfidence,
    processed:      recentOpps.length,
  })
}
