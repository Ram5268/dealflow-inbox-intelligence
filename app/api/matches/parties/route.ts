export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getCurrentOrgId } from '@/lib/auth/orgContext'
import { isTestModeOnly } from '@/lib/config/testMode'
import { resolveSourceBadge } from '@/lib/matching/engine'
import { formatPriceRange } from '@/lib/utils'
import { Category } from '@prisma/client'
import { inChunks, loadDismissedPairs } from '@/lib/matching/dismissals'
import { partyBand } from '@/lib/matching/matchesList'

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
// "tier" is null on the live matcher, so hot/warm/possible are derived from score.
// Brief 48 (PR 12): by the stored tiers' thresholds (>=80 / 65-79 / <65,
// lib/matching/tiers.ts), the same as the /matches HOT and WARM tabs; they were
// 90 and 70.

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

// Brief 35: a Mojo contact's role is its intent, not its list name.
function mojoRole(intent: string | null): Role {
  return intent === 'BUYER' ? 'BUYER' : intent === 'RENTER' ? 'RENTER' : 'SELLER'
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
    select: { id: true, opportunityId: true, opportunityType: true, counterpartId: true, counterpartType: true, score: true, tier: true },
  })
  if (matches.length === 0) {
    return NextResponse.json({ parties: [], counts: { total: 0, buyers: 0, renters: 0, sellers: 0 } })
  }

  // Exclude dismissed pairs; lookups are chunked (Brief 35: the per-match OR hit P2029).
  const isDismissed = await loadDismissedPairs(prisma, matches)
  const live = matches.filter(m => !isDismissed(m))

  // Resolve which referenced ids are party ENTITIES. Contact supply (Brief 35) is
  // a seller MojoContact in opportunityId.
  const oppIds  = new Set<string>()
  const mojoIds = new Set<string>()
  for (const m of live) {
    if (m.opportunityType === 'contact') mojoIds.add(m.opportunityId)
    else oppIds.add(m.opportunityId)
    if (m.counterpartType === 'mojo') mojoIds.add(m.counterpartId)
    else oppIds.add(m.counterpartId)
  }

  const testMode = isTestModeOnly()
  const [oppEntities, mojoEntities] = await Promise.all([
    inChunks([...oppIds], chunk => prisma.extractedOpportunity.findMany({
      where: { id: { in: chunk }, category: { in: [...BUYER_CATS, ...RENTER_CATS, ...SELLER_CATS] as Category[] } },
      select: {
        id: true, category: true, extractedTitle: true, sourceAgentName: true, sourceBrokerage: true,
        neighborhood: true, price: true, minPrice: true, maxPrice: true, beds: true,
      },
    })),
    testMode ? Promise.resolve([]) : inChunks([...mojoIds], chunk => prisma.mojoContact.findMany({
      where: { id: { in: chunk } },
      select: { id: true, fullName: true, intent: true, mojoList: true, neighborhood: true, city: true },
    })),
  ])

  const oppMap  = new Map(oppEntities.map(o => [o.id, o]))
  const mojoMap = new Map(mojoEntities.map(m => [m.id, m]))
  const aggs = new Map<string, PartyAgg>()

  function bump(partyId: string, make: () => PartyAgg, matchId: string, score: number) {
    let a = aggs.get(partyId)
    if (!a) { a = make(); aggs.set(partyId, a) }
    a.matchCount++
    a.tierBreakdown[partyBand(score)]++
    if (score > a.topScore) { a.topScore = score; a.topMatchId = matchId }
  }

  const mojoParty = (mojo: (typeof mojoEntities)[number], m: (typeof live)[number], role: Role): PartyAgg => ({
    id: mojo.id, name: mojo.fullName, role, source: 'mojo', isSEExpert: false,
    criteria: [mojo.neighborhood ?? mojo.city, role === 'SELLER' ? mojo.mojoList : null].filter(Boolean).join(' · '),
    matchCount: 0, tierBreakdown: { hot: 0, warm: 0, possible: 0 }, topMatchId: m.id, topScore: -1,
  })

  for (const m of live) {
    // Brief 35: a contact-supply seller is a SELLER party.
    const seller = m.opportunityType === 'contact' ? mojoMap.get(m.opportunityId) : undefined
    if (seller) bump(seller.id, () => mojoParty(seller, m, 'SELLER'), m.id, m.score)
    // Opportunity-side party (buyer/renter/seller-lead as opportunityId or counterpartId).
    const eids = m.opportunityType === 'contact' ? [] : [m.opportunityId]
    for (const eid of m.counterpartType === 'mojo' ? eids : [...eids, m.counterpartId]) {
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
      if (mojo) bump(m.counterpartId, () => mojoParty(mojo, m, mojoRole(mojo.intent)), m.id, m.score)
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
