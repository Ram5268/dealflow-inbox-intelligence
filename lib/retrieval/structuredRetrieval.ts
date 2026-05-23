import { prisma } from '../prisma'
import type { QueryPlan, ScoredRecord } from './types'

// Fetch up to 40 candidates using SQL-first filters.
// Returns partial ScoredRecord (no score/tier/grade yet — set by matchScorer).
export async function structuredRetrieval(plan: QueryPlan): Promise<ScoredRecord[]> {
  if (plan.searchCategories.length === 0) return []

  const cutoff = new Date(Date.now() - plan.filters.freshnessWindowDays * 24 * 60 * 60 * 1000)

  // Build all neighborhood strings: exact + adjacent
  const allNeighborhoods = [
    ...plan.filters.neighborhoods,
    ...Object.values(plan.adjacentNeighborhoods).flat(),
  ]
  const uniqueNeighborhoods = [...new Set(allNeighborhoods)]

  // Prisma where clause
  const where: Record<string, unknown> = {
    processingStatus: 'active',
    category:         { in: plan.searchCategories },
    createdAt:        { gte: cutoff },
  }

  if (plan.filters.boroughs.length > 0) {
    where.borough = { in: plan.filters.boroughs, mode: 'insensitive' }
  }

  // Price filter — check price, minPrice, maxPrice fields
  const priceFilters: object[] = []
  if (plan.filters.maxPrice !== null) {
    priceFilters.push(
      { price:    { lte: plan.filters.maxPrice } },
      { minPrice: { lte: plan.filters.maxPrice } },
      { maxPrice: { lte: plan.filters.maxPrice } },
    )
  }
  if (plan.filters.minPrice !== null) {
    priceFilters.push(
      { price:    { gte: plan.filters.minPrice } },
      { maxPrice: { gte: plan.filters.minPrice } },
    )
  }
  if (priceFilters.length > 0) {
    where.OR = priceFilters
  }

  // Bed filter
  if (plan.filters.minBeds !== null || plan.filters.maxBeds !== null) {
    const bedFilter: Record<string, number> = {}
    if (plan.filters.minBeds !== null) bedFilter.gte = plan.filters.minBeds
    if (plan.filters.maxBeds !== null) bedFilter.lte = plan.filters.maxBeds
    where.beds = bedFilter
  }

  // Neighborhood filter — use OR across all neighborhoods (case-insensitive CONTAINS)
  const neighborhoodWhere = uniqueNeighborhoods.length > 0
    ? {
        OR: uniqueNeighborhoods.map(n => ({
          neighborhood: { contains: n, mode: 'insensitive' as const },
        })),
      }
    : {}

  // When a neighborhood filter is present, respect it strictly — only return records
  // from that neighborhood. Never broaden to other areas when the user asked for a specific place.
  if (uniqueNeighborhoods.length > 0) {
    const neighborhoodResults = await prisma.extractedOpportunity.findMany({
      where: { ...where, ...neighborhoodWhere },
      orderBy: { createdAt: 'desc' },
      take: 40,
      select: OPPORTUNITY_SELECT,
    })
    return neighborhoodResults.map(toScoredRecord)
  }

  // No neighborhood filter — use broad results (borough-level or category-only)
  const broadResults = await prisma.extractedOpportunity.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: 40,
    select: OPPORTUNITY_SELECT,
  })
  return broadResults.map(toScoredRecord)
}

const OPPORTUNITY_SELECT = {
  id:               true,
  category:         true,
  address:          true,
  neighborhood:     true,
  borough:          true,
  price:            true,
  minPrice:         true,
  maxPrice:         true,
  beds:             true,
  baths:            true,
  propertyType:     true,
  availabilityDate: true,
  sourceAgentName:  true,
  sourceAgentEmail: true,
  sourceBrokerage:  true,
  clientSide:       true,
  extractedTitle:   true,
  extractedSummary: true,
  transactionType:  true,
  createdAt:        true,
  streetEasyId:     true,
} as const

function toScoredRecord(o: {
  id: string; category: string; address: string | null; neighborhood: string | null
  borough: string | null; price: number | null; minPrice: number | null; maxPrice: number | null
  beds: number | null; baths: number | null; propertyType: string | null
  availabilityDate: string | null; sourceAgentName: string | null; sourceAgentEmail: string | null
  sourceBrokerage: string | null; clientSide: string | null; extractedTitle: string
  extractedSummary: string; transactionType: string; createdAt: Date; streetEasyId: string | null
}): ScoredRecord {
  return {
    ...o,
    score: 0,
    tier:  'weak',
    grade: 'weak_match',
  }
}
