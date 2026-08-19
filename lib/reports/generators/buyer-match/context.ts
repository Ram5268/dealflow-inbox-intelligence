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
      include: {
        opportunity: {
          select: {
            id: true, category: true, address: true, neighborhood: true, borough: true,
            price: true, beds: true, squareFeet: true, extractedTitle: true,
            sourceBrokerage: true, sourceAgentName: true, availabilityDate: true,
          },
        },
      },
    })
    cache = rows.map(m => ({
      matchId: m.id,
      tier: m.tier,
      score: m.score,
      reason: m.reason,
      listing: {
        id: m.opportunity.id,
        category: m.opportunity.category,
        address: m.opportunity.address,
        neighborhood: m.opportunity.neighborhood,
        borough: m.opportunity.borough,
        price: m.opportunity.price,
        beds: m.opportunity.beds,
        squareFeet: m.opportunity.squareFeet,
        extractedTitle: m.opportunity.extractedTitle,
        sourceBrokerage: m.opportunity.sourceBrokerage,
        sourceAgentName: m.opportunity.sourceAgentName,
        availabilityDate: m.opportunity.availabilityDate,
      },
    }))
    return cache
  }

  return { buyerId, prisma, buyer, matches }
}
