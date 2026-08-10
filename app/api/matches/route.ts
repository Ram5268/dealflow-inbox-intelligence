export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { isTestModeOnly } from '@/lib/config/testMode'
import { isMatchingTestModeOnly } from '@/lib/config/matchingTestMode'
import { resolveSourceBadge } from '@/lib/matching/engine'

// GET /api/matches[?unseen=1][&scoreMin=N][&type=opportunity|mojo|showing_confirmation|all][&includeDismissed=1]
// List with both sides hydrated. Sort: unseen first, then highest-scoring,
// then newest. seen rows are returned but visually de-emphasized client-side.
// Brief 7.1: dismissed matches (a MatchDismissal row on the party↔listing pair)
// are excluded by default; ?includeDismissed=1 shows them (debug only, not in UI).
export async function GET(req: NextRequest) {
  const sp          = req.nextUrl.searchParams
  const onlyUnseen  = sp.get('unseen') === '1'
  const scoreMinRaw = sp.get('scoreMin')
  const scoreMin    = scoreMinRaw ? parseInt(scoreMinRaw, 10) : null
  const typeRaw     = sp.get('type')
  const type        = typeRaw && typeRaw !== 'all' ? typeRaw : null
  const includeDismissed = sp.get('includeDismissed') === '1'

  // Hard partition test data from real data so Ryan can inspect one or the other
  // without cross-pollution. MATCHING_TEST_MODE_ONLY=true → only isTestData=true
  // opportunities AND exclude Mojo counterparts entirely (Mojo has no isTestData
  // column yet; every Mojo row is real production data until Brief 7.2). Flag off
  // → only isTestData=false opportunities (no seed pollution in the real view).
  const matchingTestMode = isMatchingTestModeOnly()
  const where: Record<string, unknown> = {
    opportunity: { isTestData: matchingTestMode ? true : false },
  }
  if (matchingTestMode) {
    where.counterpartType = { not: 'mojo' }
  } else if (type) {
    where.counterpartType = type
  }
  if (onlyUnseen)                                    where.seen  = false
  if (scoreMin !== null && !Number.isNaN(scoreMin))  where.score = { gte: scoreMin }

  const allMatches = await prisma.match.findMany({
    where,
    orderBy: [{ seen: 'asc' }, { score: 'desc' }, { createdAt: 'desc' }],
    take: 200,
    include: {
      opportunity: {
        select: {
          id: true, category: true, address: true, neighborhood: true,
          price: true, minPrice: true, maxPrice: true, beds: true,
          propertyType: true, units: true, sourceAgentName: true,
          sourceBrokerage: true, extractedTitle: true, extractedSummary: true,
        },
      },
    },
  })

  // Brief 7.1 — hide dismissed pairs. MatchDismissal keys on (partyId, listingId)
  // = (counterpartId, opportunityId); there's no FK to Match, so exclude in code.
  let matches = allMatches
  if (!includeDismissed && allMatches.length > 0) {
    const dismissals = await prisma.matchDismissal.findMany({
      where: {
        OR: allMatches.map(m => ({ partyId: m.counterpartId, listingId: m.opportunityId })),
      },
      select: { partyId: true, listingId: true },
    })
    const dismissedKeys = new Set(dismissals.map(d => `${d.partyId}::${d.listingId}`))
    matches = allMatches.filter(m => !dismissedKeys.has(`${m.counterpartId}::${m.opportunityId}`))
  }

  const oppCounterpartIds  = matches.filter(m => m.counterpartType === 'opportunity').map(m => m.counterpartId)
  // TEST_MODE_ONLY hard gate: never hydrate real Mojo contacts into match results.
  const mojoCounterpartIds = isTestModeOnly() ? [] :
    matches.filter(m => m.counterpartType === 'mojo').map(m => m.counterpartId)

  const [oppCounterparts, mojoCounterparts] = await Promise.all([
    oppCounterpartIds.length > 0
      ? prisma.extractedOpportunity.findMany({
          where:  { id: { in: oppCounterpartIds } },
          select: {
            id: true, category: true, address: true, neighborhood: true,
            price: true, minPrice: true, maxPrice: true, beds: true,
            sourceAgentName: true, sourceBrokerage: true, extractedTitle: true,
            extractedSummary: true,
          },
        })
      : [],
    mojoCounterpartIds.length > 0
      ? prisma.mojoContact.findMany({
          where:  { id: { in: mojoCounterpartIds } },
          select: {
            id: true, fullName: true, address: true, city: true, neighborhood: true,
            phone: true, email: true, status: true, notes: true,
          },
        })
      : [],
  ])

  const oppMap  = Object.fromEntries(oppCounterparts.map(o  => [o.id,  o]))
  const mojoMap = Object.fromEntries(mojoCounterparts.map(m => [m.id, m]))

  // Brief 7.1 — partyPriority ('SE' | 'NORMAL' | null) is DERIVED, not stored:
  // the SE preference lives in ranking.ts (SOURCE_BOOST) keyed off the party's
  // resolved source badge. The counterpart IS the demand party, so resolve its
  // brokerage the same way the engine does. Mojo → NORMAL; showings → null.
  function partyPriorityFor(m: (typeof matches)[number]): 'SE' | 'NORMAL' | null {
    if (m.counterpartType === 'opportunity') {
      const opp = oppMap[m.counterpartId]
      if (!opp) return null
      return resolveSourceBadge(opp.sourceBrokerage) === 'streeteasy_expert' ? 'SE' : 'NORMAL'
    }
    if (m.counterpartType === 'mojo') return 'NORMAL'
    return null
  }

  const enriched = matches.map(m => ({
    id:              m.id,
    score:           m.score,
    reason:          m.reason,
    tier:            m.tier,           // Brief 7.1 — 'HOT' | 'WARM' | 'POSSIBLE' | null
    partyPriority:   partyPriorityFor(m),
    counterpartType: m.counterpartType,
    seen:            m.seen,
    createdAt:       m.createdAt,
    primary:         m.opportunity,
    counterpart:
      m.counterpartType === 'opportunity' ? (oppMap[m.counterpartId]  ?? null) :
      m.counterpartType === 'mojo'        ? (mojoMap[m.counterpartId] ?? null) :
      null,
  }))

  const counts = {
    total:    matches.length,
    unseen:   matches.filter(m => !m.seen).length,
    mojo:     matches.filter(m => m.counterpartType === 'mojo').length,
    listings: matches.filter(m => m.counterpartType === 'opportunity').length,
    showings: matches.filter(m => m.counterpartType === 'showing_confirmation').length,
  }

  return NextResponse.json({ matches: enriched, counts })
}

// PATCH /api/matches — mark a match as seen.
export async function PATCH(req: NextRequest) {
  const { id } = await req.json() as { id?: string }
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  await prisma.match.update({ where: { id }, data: { seen: true } })
  return NextResponse.json({ ok: true })
}
