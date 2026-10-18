// Brief 27.0 — shared context for the Buyer Match generator.
//
// The buyer is a demand-side ExtractedOpportunity (BUYER_ISO or RENTER_INQUIRY):
// that is what the matcher tiers and what the persisted Match rows reference as
// `counterpartId`. gatherContext loads the buyer eagerly (every section needs it)
// and exposes a memoized, lazy `matches()` so fragment sections that don't touch
// matches (e.g. criteria) never run the join.
import { Category } from '@prisma/client'
import type { PrismaClient } from '@prisma/client'
import type { GenContext, BuyerRecord, MatchedListing } from '../types'
import { resolveSupplies } from '../../../matching/supplyResolver'
import { buyerFacingSupply } from '../../../buyerFacingSupply'

const BUYER_SELECT = {
  id: true, category: true, extractedTitle: true, neighborhoods: true, neighborhood: true,
  borough: true, minBeds: true, maxBeds: true, beds: true, minPrice: true, maxPrice: true,
  price: true, mustHaves: true, dealbreakers: true, timeline: true, propertyTypes: true,
  isTestData: true, createdAt: true,
} as const

export async function gatherContext({
  buyerId,
  prisma,
}: {
  buyerId: string
  prisma: PrismaClient
}): Promise<GenContext> {
  const row = await prisma.extractedOpportunity.findUnique({
    where: { id: buyerId },
    select: BUYER_SELECT,
  })
  if (!row) throw new Error(`buyer-match: buyer ${buyerId} not found`)
  if (row.category !== Category.BUYER_ISO && row.category !== Category.RENTER_INQUIRY) {
    throw new Error(
      `buyer-match: ${buyerId} is category ${row.category}, not a demand party (BUYER_ISO / RENTER_INQUIRY). ` +
      `Pass a buyer/renter ISO opportunity id.`,
    )
  }

  const hoods = row.neighborhoods.length ? row.neighborhoods : row.neighborhood ? [row.neighborhood] : []
  const buyer: BuyerRecord = {
    id: row.id,
    category: row.category,
    name: row.extractedTitle,
    neighborhoods: hoods,
    borough: row.borough,
    minBeds: row.minBeds,
    maxBeds: row.maxBeds,
    beds: row.beds,
    minPrice: row.minPrice,
    maxPrice: row.maxPrice,
    price: row.price,
    mustHaves: row.mustHaves,
    dealbreakers: row.dealbreakers,
    timeline: row.timeline,
    propertyTypes: row.propertyTypes,
    isTestData: row.isTestData,
    createdAt: row.createdAt,
  }

  // Memoized match loader — the persisted Match rows are the matcher's output.
  let cache: MatchedListing[] | null = null
  const matches = async (): Promise<MatchedListing[]> => {
    if (cache) return cache
    const rows = await prisma.match.findMany({
      where: { counterpartId: buyerId, counterpartType: 'opportunity' },
      orderBy: [{ score: 'desc' }, { createdAt: 'desc' }],
      select: {
        id: true, tier: true, score: true, reason: true,
        opportunityId: true, opportunityType: true,
      },
    })
    // Brief 32 — the supply (listing) side may be an ExtractedOpportunity or a
    // MojoContact seller; resolve both via the shared helper. Rows whose supply
    // record is missing (deleted opp/contact) are dropped.
    const supplies = await resolveSupplies(prisma, rows)
    cache = rows.flatMap(m => {
      const found = supplies.get(m.opportunityId)
      if (!found) return []
      // Ryan's decision, 2026-10-17: saved seller notes may keep these details.
      // Buyer-facing text still never names motivation (engineering precaution,
      // Brief 41 H7): a lead or a client conversation here (an old or odd row;
      // no matcher writes one) is shown exactly like a homeowner.
      const s = buyerFacingSupply(found)
      return [{
        matchId: m.id,
        tier: m.tier,
        score: m.score,
        reason: m.reason,
        listing: {
          id: s.id,
          category: s.category,
          address: s.address,
          neighborhood: s.neighborhood,
          borough: s.borough,
          price: s.price,
          beds: s.beds,
          squareFeet: s.squareFeet,
          extractedTitle: s.extractedTitle,
          sourceBrokerage: s.sourceBrokerage,
          sourceAgentName: s.sourceAgentName,
          availabilityDate: s.availabilityDate,
          isHomeowner: s.opportunityType === 'contact',
        },
      }]
    })
    return cache
  }

  return { buyerId, prisma, buyer, matches }
}
