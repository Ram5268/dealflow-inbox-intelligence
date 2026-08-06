export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { isTestModeOnly } from '@/lib/config/testMode'

// GET /api/matches[?unseen=1][&scoreMin=N][&type=opportunity|mojo|showing_confirmation|all]
// List with both sides hydrated. Sort: unseen first, then highest-scoring,
// then newest. seen rows are returned but visually de-emphasized client-side.
export async function GET(req: NextRequest) {
  const sp          = req.nextUrl.searchParams
  const onlyUnseen  = sp.get('unseen') === '1'
  const scoreMinRaw = sp.get('scoreMin')
  const scoreMin    = scoreMinRaw ? parseInt(scoreMinRaw, 10) : null
  const typeRaw     = sp.get('type')
  const type        = typeRaw && typeRaw !== 'all' ? typeRaw : null

  const where: Record<string, unknown> = {}
  if (onlyUnseen)                                    where.seen            = false
  if (scoreMin !== null && !Number.isNaN(scoreMin))  where.score           = { gte: scoreMin }
  if (type)                                          where.counterpartType = type

  const matches = await prisma.match.findMany({
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

  const enriched = matches.map(m => ({
    id:              m.id,
    score:           m.score,
    reason:          m.reason,
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
