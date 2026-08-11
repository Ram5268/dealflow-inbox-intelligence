export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getCurrentOrgId } from '@/lib/auth/orgContext'
import { isTestModeOnly } from '@/lib/config/testMode'
import { resolveSourceBadge } from '@/lib/matching/engine'
import { formatPriceRange } from '@/lib/utils'
import { Category } from '@prisma/client'

// Brief 7.4 (Section B) — party-grouped view of /matches. Instead of one card per
// match, aggregate matches by the DEMAND/LEAD party they involve, so Ryan sees
// "John Smith · 4 matches" rather than four separate rows.
//
// A party is: an ExtractedOpportunity that is a buyer/renter/seller-lead, OR a
// MojoContact. A Match is attributed to a party when the party's id is EITHER the
// match's opportunityId or counterpartId (the live matcher writes buyer ISOs on
// either side depending on which record arrived first). Listings never land in
// the party set, so there's no false attribution.
//
// "tier" is null on the live matcher, so hot/warm/possible are derived from score
// (>=90 / 70-89 / <70), consistent with the /matches GOLD·STRONG·ALL bands.

type Role = 'BUYER' | 'RENTER' | 'SELLER'

const BUYER_CATS  = new Set<string>([Category.BUYER_ISO])
const RENTER_CATS = new Set<string>([Category.RENTER_INQUIRY])
const SELLER_CATS = new Set<string>([Category.SELLER_LEAD, Category.LANDLORD_LEAD])

interface PartyAgg {
  id: string
  name: string
  role: Role
  source: 'inbox' | 'mojo'
  isSEExpert: boolean
  criteria: string
  matchCount: number
  tierBreakdown: { hot: number; warm: number; possible: number }
  topMatchId: string
  topScore: number
}

function bandOf(score: number): 'hot' | 'warm' | 'possible' {
  if (score >= 90) return 'hot'
  if (score >= 70) return 'warm'
  return 'possible'
}

function mojoRole(mojoList: string | null): Role {
  const s = (mojoList ?? '').toLowerCase()
  if (s.includes('buyer')) return 'BUYER'
  if (s.includes('renter')) return 'RENTER'
  return 'SELLER'
}

function oppRole(category: string): Role | null {
  if (BUYER_CATS.has(category))  return 'BUYER'
  if (RENTER_CATS.has(category)) return 'RENTER'
  if (SELLER_CATS.has(category)) return 'SELLER'
  return null
}

export async function GET(req: NextRequest) {
  const organizationId = await getCurrentOrgId()
  const sp        = req.nextUrl.searchParams
  const roleParam = (sp.get('role') ?? 'all').toLowerCase()
  const scoreMin  = sp.get('scoreMin') ? parseInt(sp.get('scoreMin')!, 10) : null
  const onlyUnseen = sp.get('unseen') === '1'

  const where: Record<string, unknown> = {
    organizationId,
    counterpartType: { not: 'showing_confirmation' },
  }
  if (onlyUnseen) where.seen = false
  if (scoreMin !== null && !Number.isNaN(scoreMin)) where.score = { gte: scoreMin }

  const matches = await prisma.match.findMany({
    where,
    select: { id: true, opportunityId: true, counterpartId: true, counterpartType: true, score: true, tier: true },
  })
  if (matches.length === 0) {
    return NextResponse.json({ parties: [], counts: { total: 0, buyers: 0, renters: 0, sellers: 0 } })
  }

  // Exclude dismissed pairs (same rule as /api/matches).
  const dismissals = await prisma.matchDismissal.findMany({
    where: { OR: matches.map(m => ({ partyId: m.counterpartId, listingId: m.opportunityId })) },
    select: { partyId: true, listingId: true },
  })
  const dismissed = new Set(dismissals.map(d => `${d.partyId}::${d.listingId}`))
  const live = matches.filter(m => !dismissed.has(`${m.counterpartId}::${m.opportunityId}`))

  // Resolve which referenced ids are party ENTITIES.
  const oppIds  = new Set<string>()
  const mojoIds = new Set<string>()
  for (const m of live) {
    oppIds.add(m.opportunityId)
    if (m.counterpartType === 'mojo') mojoIds.add(m.counterpartId)
    else oppIds.add(m.counterpartId)
  }

  const testMode = isTestModeOnly()
  const [oppEntities, mojoEntities] = await Promise.all([
    prisma.extractedOpportunity.findMany({
      where: { id: { in: [...oppIds] }, category: { in: [...BUYER_CATS, ...RENTER_CATS, ...SELLER_CATS] as Category[] } },
      select: {
        id: true, category: true, extractedTitle: true, sourceAgentName: true, sourceBrokerage: true,
        neighborhood: true, price: true, minPrice: true, maxPrice: true, beds: true,
      },
    }),
    testMode || mojoIds.size === 0 ? Promise.resolve([]) : prisma.mojoContact.findMany({
      where: { id: { in: [...mojoIds] } },
      select: { id: true, fullName: true, mojoList: true, neighborhood: true, city: true },
    }),
  ])

  const oppMap  = new Map(oppEntities.map(o => [o.id, o]))
  const mojoMap = new Map(mojoEntities.map(m => [m.id, m]))
  const aggs = new Map<string, PartyAgg>()

  function bump(partyId: string, make: () => PartyAgg, matchId: string, score: number) {
    let a = aggs.get(partyId)
    if (!a) { a = make(); aggs.set(partyId, a) }
    a.matchCount++
    a.tierBreakdown[bandOf(score)]++
    if (score > a.topScore) { a.topScore = score; a.topMatchId = matchId }
  }

  for (const m of live) {
    // Opportunity-side party (buyer/renter/seller-lead as opportunityId or counterpartId).
    for (const eid of m.counterpartType === 'mojo' ? [m.opportunityId] : [m.opportunityId, m.counterpartId]) {
      const opp = oppMap.get(eid)
      if (!opp) continue
      const role = oppRole(opp.category)
      if (!role) continue
      bump(eid, () => ({
        id: eid,
        name: opp.sourceAgentName ?? opp.extractedTitle,
        role,
        source: 'inbox',
        isSEExpert: resolveSourceBadge(opp.sourceBrokerage) === 'streeteasy_expert',
        criteria: [formatPriceRange(opp.minPrice, opp.maxPrice, opp.price), opp.beds ? `${opp.beds}BR` : null, opp.neighborhood].filter(Boolean).join(' · '),
        matchCount: 0, tierBreakdown: { hot: 0, warm: 0, possible: 0 }, topMatchId: m.id, topScore: -1,
      }), m.id, m.score)
    }
    // Mojo-side party.
    if (m.counterpartType === 'mojo') {
      const mojo = mojoMap.get(m.counterpartId)
      if (mojo) {
        bump(m.counterpartId, () => ({
          id: mojo.id,
          name: mojo.fullName,
          role: mojoRole(mojo.mojoList),
          source: 'mojo',
          isSEExpert: false,
          criteria: [mojo.neighborhood ?? mojo.city].filter(Boolean).join(' · '),
          matchCount: 0, tierBreakdown: { hot: 0, warm: 0, possible: 0 }, topMatchId: m.id, topScore: -1,
        }), m.id, m.score)
      }
    }
  }

  const all = [...aggs.values()].sort((a, b) => b.topScore - a.topScore || b.matchCount - a.matchCount)
  const counts = {
    total:   all.length,
    buyers:  all.filter(p => p.role === 'BUYER').length,
    renters: all.filter(p => p.role === 'RENTER').length,
    sellers: all.filter(p => p.role === 'SELLER').length,
  }

  const roleFilter: Role | null =
    roleParam === 'buyer' ? 'BUYER' : roleParam === 'renter' ? 'RENTER' : roleParam === 'seller' ? 'SELLER' : null
  const parties = (roleFilter ? all.filter(p => p.role === roleFilter) : all)
    .map(({ topScore, ...p }) => { void topScore; return p })

  return NextResponse.json({ parties, counts })
}
