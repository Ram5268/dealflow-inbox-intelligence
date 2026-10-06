export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { Category } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { isTestModeOnly } from '@/lib/config/testMode'
import { resolveSourceBadge } from '@/lib/matching/engine'
import { resolveDismissKey } from '@/lib/matching/dismissKey'
import { resolveSupplies } from '@/lib/matching/supplyResolver'
import { getCurrentOrgId } from '@/lib/auth/orgContext'
import { crmLeadUrl } from '@/lib/crmLink'
import { plainFitReason } from '@/lib/matching/fitReason'

// GET /api/matches[?unseen=1][&scoreMin=N][&type=opportunity|mojo|showing_confirmation|all][&includeDismissed=1]
// List with both sides hydrated. Sort: unseen first, then highest-scoring,
// then newest. seen rows are returned but visually de-emphasized client-side.
// Brief 7.1: dismissed matches (a MatchDismissal row on the party↔listing pair)
// are excluded by default; ?includeDismissed=1 shows them (debug only, not in UI).
// Brief 38: GET /api/matches?id=<matchId> returns just that match, org-scoped and
// in the same shape, ignoring the filters, dismissals and the 200 cap, so a
// /matches?m=<id> link opens the exact match wherever it sits in the list.
export async function GET(req: NextRequest) {
  const sp          = req.nextUrl.searchParams
  const id          = sp.get('id')
  const onlyUnseen  = !id && sp.get('unseen') === '1'
  const scoreMinRaw = id ? null : sp.get('scoreMin')
  const scoreMin    = scoreMinRaw ? parseInt(scoreMinRaw, 10) : null
  const typeRaw     = id ? null : sp.get('type')
  const type        = typeRaw && typeRaw !== 'all' ? typeRaw : null
  const includeDismissed = !!id || sp.get('includeDismissed') === '1'

  const where: Record<string, unknown> = { organizationId: await getCurrentOrgId() }
  if (id) where.id = id
  if (type) where.counterpartType = type
  if (onlyUnseen)                                    where.seen  = false
  if (scoreMin !== null && !Number.isNaN(scoreMin))  where.score = { gte: scoreMin }

  const allMatches = await prisma.match.findMany({
    where,
    orderBy: [{ seen: 'asc' }, { score: 'desc' }, { createdAt: 'desc' }],
    take: 200,
    select: {
      id: true, score: true, reason: true, tier: true, counterpartType: true,
      counterpartId: true, seen: true, createdAt: true,
      opportunityId: true, opportunityType: true,
    },
  })

  // Brief 32 — the supply (listing) side may be an ExtractedOpportunity OR a
  // MojoContact seller; resolve both through the shared helper. `primary` below
  // is the uniform ResolvedSupply. ResolvedSupply omits three opportunity-only UI
  // columns (propertyType / units / extractedSummary) that the matches page still
  // renders, so hydrate those separately for opportunity-type rows and merge.
  const supplies = await resolveSupplies(prisma, allMatches)
  const oppSupplyIds = allMatches.filter(m => m.opportunityType !== 'contact').map(m => m.opportunityId)
  const oppExtras = oppSupplyIds.length > 0
    ? await prisma.extractedOpportunity.findMany({
        where: { id: { in: oppSupplyIds } },
        select: { id: true, propertyType: true, units: true, extractedSummary: true },
      })
    : []
  const oppExtrasMap = Object.fromEntries(oppExtras.map(o => [o.id, o]))
  // Brief 35: the SELLER side of contact supply (units, list, phone, CRM link).
  // Real Mojo contacts stay hidden in test mode, like Mojo counterparts below.
  const sellerIds = isTestModeOnly() ? [] : allMatches.filter(m => m.opportunityType === 'contact').map(m => m.opportunityId)
  const sellers = sellerIds.length > 0
    ? await prisma.mojoContact.findMany({
        where: { id: { in: sellerIds } },
        select: { id: true, unitCount: true, mojoList: true, phone: true, metadata: true },
      })
    : []
  const sellerMap = Object.fromEntries(sellers.map(s => [s.id, s]))

  // Brief 7.1 — hide dismissed pairs. MatchDismissal keys on (partyId, listingId);
  // there's no FK to Match, so exclude in code. Brief 8.0-lite Fix #3a — resolve
  // the key from the opportunity's CATEGORY (via resolveDismissKey), matching how
  // the dismiss route now writes it and how the engine filters. The old
  // (partyId=counterpartId) shortcut inverted ISO-triggered pairs.
  let matches = allMatches
  if (!includeDismissed && allMatches.length > 0) {
    const keyFor = (m: (typeof allMatches)[number]) => resolveDismissKey({
      opportunityId: m.opportunityId,
      counterpartId: m.counterpartId,
      opportunityType: m.opportunityType, // Brief 35: 'contact' supply keys as the listing side
      opportunityCategory: supplies.get(m.opportunityId)?.category ?? Category.OFF_MARKET_SALE,
    })
    const dismissals = await prisma.matchDismissal.findMany({
      where: { OR: allMatches.map(keyFor) },
      select: { partyId: true, listingId: true },
    })
    const dismissedKeys = new Set(dismissals.map(d => `${d.partyId}::${d.listingId}`))
    matches = allMatches.filter(m => {
      const k = keyFor(m)
      return !dismissedKeys.has(`${k.partyId}::${k.listingId}`)
    })
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
            id: true, fullName: true, intent: true, address: true, city: true, neighborhood: true,
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

  const enriched = matches.map(m => {
    // Brief 32 — `primary` is the ResolvedSupply, merged with the opportunity-only
    // UI columns for opportunity-type rows (null for contact-type supplies).
    const supply = supplies.get(m.opportunityId) ?? null
    const extras = oppExtrasMap[m.opportunityId]
    const seller = sellerMap[m.opportunityId]
    const primary = supply
      ? {
          ...supply, propertyType: extras?.propertyType ?? null, units: extras?.units ?? seller?.unitCount ?? null,
          extractedSummary: extras?.extractedSummary ?? '',
          mojoList: seller?.mojoList ?? null, phone: seller?.phone ?? null, crmUrl: crmLeadUrl(seller?.metadata),
        }
      : null
    return {
    id:              m.id,
    score:           m.score,
    // Brief 41 (H7): the plain, safe reason (older rows hold raw scorer keys).
    reason:          m.reason == null || m.counterpartType === 'showing_confirmation'
      ? m.reason
      : plainFitReason(m.reason, { homeowner: m.opportunityType === 'contact' || m.counterpartType === 'mojo' }),
    tier:            m.tier,           // Brief 7.1 — 'HOT' | 'WARM' | 'POSSIBLE' | null
    partyPriority:   partyPriorityFor(m),
    counterpartType: m.counterpartType,
    seen:            m.seen,
    createdAt:       m.createdAt,
    primary,
    counterpart:
      m.counterpartType === 'opportunity' ? (oppMap[m.counterpartId]  ?? null) :
      m.counterpartType === 'mojo'        ? (mojoMap[m.counterpartId] ?? null) :
      null,
    }
  })

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
