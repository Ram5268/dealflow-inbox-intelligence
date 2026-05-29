import { prisma } from '../prisma'
import type { QueryPlan, ScoredRecord } from './types'

// Fetch up to 40 candidates using SQL-first filters.
// Returns partial ScoredRecord (no score/tier/grade yet — set by matchScorer).
export async function structuredRetrieval(plan: QueryPlan): Promise<ScoredRecord[]> {
  if (plan.searchCategories.length === 0) return []

  // Prefer hours-precise window when the parser detected an explicit time
  // phrase ("last N hours", "today", "this week", etc.). Falls back to the
  // intent-derived freshnessWindowDays default otherwise.
  const cutoff = plan.filters.freshnessWindowHours != null
    ? new Date(Date.now() - plan.filters.freshnessWindowHours * 60 * 60 * 1000)
    : new Date(Date.now() - plan.filters.freshnessWindowDays * 24 * 60 * 60 * 1000)

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

  // Units filter — NYC "N-family" / "multi-family" / "N-unit". Building-level
  // residential unit count, distinct from bedrooms. Strict numeric match
  // (units BETWEEN min AND max) is too aggressive on its own: most records
  // have units IS NULL yet describe multifamily inventory in their text.
  //
  // Soft fallback fires only when minUnits >= 2 (user asked for multi-family).
  // For exact-count queries (e.g. "2-family") AND range queries (e.g. "2-3
  // family"), specific-count tokens AND generic multifamily strings are
  // always included. Recall > precision: false negatives (missing a real
  // 2-family because the hotsheet only stored generic 'Multi-family')
  // hurt the buyer-search workflow more than false positives (a 3-family
  // surfacing in a 2-family search that the user can quickly skip).
  //
  // Pushed into additionalAnd so it composes cleanly with each branch's own
  // AND clauses (neighborhood/staleGuard) without the spread-overwrite footgun.
  const additionalAnd: object[] = []
  if (plan.filters.minUnits !== null || plan.filters.maxUnits !== null) {
    const minU = plan.filters.minUnits ?? null
    const maxU = plan.filters.maxUnits ?? null

    const numericClause: Record<string, number> = {}
    if (minU !== null) numericClause.gte = minU
    if (maxU !== null) numericClause.lte = maxU
    const matchByUnits = { units: numericClause }

    let matchByText: object | null = null

    if ((minU ?? 0) >= 2) {
      const NUM_WORDS: Record<number, string[]> = {
        2: ['2', 'two'], 3: ['3', 'three'], 4: ['4', 'four'],
        5: ['5', 'five'], 6: ['6', 'six'], 7: ['7', 'seven'], 8: ['8', 'eight'],
      }

      const lowerN = minU ?? 2
      const upperN = maxU ?? 8
      const countTokens: string[] = []
      for (let n = lowerN; n <= upperN; n++) {
        countTokens.push(...(NUM_WORDS[n] ?? []))
      }

      const specificCountOr = countTokens.flatMap(tok => [
        { extractedTitle:   { contains: `${tok}-family`, mode: 'insensitive' as const } },
        { extractedTitle:   { contains: `${tok} family`, mode: 'insensitive' as const } },
        { extractedSummary: { contains: `${tok}-family`, mode: 'insensitive' as const } },
        { extractedSummary: { contains: `${tok} family`, mode: 'insensitive' as const } },
        { extractedTitle:   { contains: `${tok}-unit`,   mode: 'insensitive' as const } },
        { extractedSummary: { contains: `${tok}-unit`,   mode: 'insensitive' as const } },
      ])

      const textClauses: object[] = [
        ...specificCountOr,
        { propertyType:     { contains: 'multi',        mode: 'insensitive' as const } },
        { extractedTitle:   { contains: 'multi-family', mode: 'insensitive' as const } },
        { extractedTitle:   { contains: 'multifamily',  mode: 'insensitive' as const } },
        { extractedSummary: { contains: 'multi-family', mode: 'insensitive' as const } },
        { extractedSummary: { contains: 'multifamily',  mode: 'insensitive' as const } },
      ]

      matchByText = { AND: [{ units: null }, { OR: textClauses }] }
    }

    additionalAnd.push(matchByText ? { OR: [matchByUnits, matchByText] } : matchByUnits)
  }

  // Neighborhood filter — use OR across all neighborhoods (case-insensitive CONTAINS)
  const neighborhoodWhere = uniqueNeighborhoods.length > 0
    ? {
        OR: uniqueNeighborhoods.map(n => ({
          neighborhood: { contains: n, mode: 'insensitive' as const },
        })),
      }
    : {}

  // Stale-listing guard (Phase E): records flagged off-market by the
  // StreetEasy status sweep ('delisted', 'sold', 'in_contract') must never
  // reach the user. NULL is treated as "not yet checked, assume active";
  // once a record has been checked, only 'active' or 'unknown' surfaces.
  // Combined via AND[] (not spread) for the same reason as Phase C.5's fix:
  // top-level OR keys silently overwrite each other.
  const staleGuard = {
    OR: [
      { streetEasyStatus: null },
      { streetEasyStatus: 'active' },
    ],
  }

  // When a neighborhood filter is present, respect it strictly — only return records
  // from that neighborhood. Never broaden to other areas when the user asked for a specific place.
  //
  // Phase C.5: the previous `{ ...where, ...neighborhoodWhere }` spread silently
  // overwrote `where.OR` (the price filter array) with `neighborhoodWhere.OR`
  // (the neighborhood matches), so the price filter was dropped whenever a
  // neighborhood filter was present. Joining via AND keeps both OR clauses
  // active and AND-ed against the base filters as intended.
  if (uniqueNeighborhoods.length > 0) {
    const neighborhoodResults = await prisma.extractedOpportunity.findMany({
      where: { ...where, AND: [...additionalAnd, neighborhoodWhere, staleGuard] },
      orderBy: { createdAt: 'desc' },
      take: 40,
      select: OPPORTUNITY_SELECT,
    })
    return neighborhoodResults.map(toScoredRecord)
  }

  // No neighborhood filter — use broad results (borough-level or category-only)
  const broadResults = await prisma.extractedOpportunity.findMany({
    where: { ...where, AND: [...additionalAnd, staleGuard] },
    orderBy: { createdAt: 'desc' },
    take: 40,
    select: OPPORTUNITY_SELECT,
  })
  return broadResults.map(toScoredRecord)
}

export const OPPORTUNITY_SELECT = {
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
  units:            true,
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

export function toScoredRecord(o: {
  id: string; category: string; address: string | null; neighborhood: string | null
  borough: string | null; price: number | null; minPrice: number | null; maxPrice: number | null
  beds: number | null; baths: number | null; units: number | null; propertyType: string | null
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

// Vague-query fallback: latest N active, non-noise, non-duplicate. No filters.
// Also excludes BUYER_ISO/RENTER_INQUIRY per DEALFLOW_AI rule — they're demand records,
// not inventory, and shouldn't appear in "what do I have?" responses.
export async function fetchRecentActive(limit = 25): Promise<ScoredRecord[]> {
  const rows = await prisma.extractedOpportunity.findMany({
    where: {
      processingStatus: 'active',
      isDuplicate:      false,
      category:         { notIn: ['NOISE', 'BUYER_ISO', 'RENTER_INQUIRY'] },
    },
    orderBy: { createdAt: 'desc' },
    take:    limit,
    select:  OPPORTUNITY_SELECT,
  })
  return rows.map(toScoredRecord)
}
