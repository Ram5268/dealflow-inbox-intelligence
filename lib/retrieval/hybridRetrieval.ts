import { prisma } from '../prisma'
import { embedText } from '../embeddings'
import type { ScoredRecord, QueryPlan } from './types'

// Re-rank candidates by vector similarity, scoped to the candidate set.
// Falls back to full-table HNSW search if no candidates.
export async function hybridRetrieval(
  query: string,
  candidates: ScoredRecord[],
  plan: QueryPlan,
): Promise<ScoredRecord[]> {
  if (!query.trim()) return candidates

  let vector: number[]
  try {
    vector = await embedText(query)
  } catch {
    return candidates  // if embedding fails, return structured results as-is
  }

  const pgVector = `[${vector.join(',')}]`

  if (candidates.length > 0) {
    // Scoped: vector search within the candidate set only
    const ids = candidates.map(c => c.id)

    type RawRow = { id: string; similarity: number }
    const rows = await prisma.$queryRaw<RawRow[]>`
      SELECT id, 1 - (embedding <=> ${pgVector}::vector) AS similarity
      FROM "ExtractedOpportunity"
      WHERE id = ANY(${ids}::text[])
        AND embedding IS NOT NULL
      ORDER BY embedding <=> ${pgVector}::vector
      LIMIT 20
    `

    // Build similarity lookup
    const simMap = new Map<string, number>()
    for (const r of rows) simMap.set(r.id, r.similarity)

    // Boost scores of candidates that also have high vector similarity
    const withBoost = candidates.map(c => {
      const sim = simMap.get(c.id) ?? 0
      return { ...c, vectorSim: sim }
    })

    // Sort: candidates that appear in semantic results first (boosted), then by recency
    withBoost.sort((a, b) => {
      const aInSem = simMap.has(a.id) ? 1 : 0
      const bInSem = simMap.has(b.id) ? 1 : 0
      if (aInSem !== bInSem) return bInSem - aInSem
      return (simMap.get(b.id) ?? 0) - (simMap.get(a.id) ?? 0)
    })

    return withBoost.slice(0, 25)

  } else {
    // Full-table fallback: HNSW search — only runs when no neighborhood was specified.
    // When the user asked for a specific neighborhood and nothing matched, return empty
    // so the LLM correctly says "none found" rather than returning wrong-category records.
    if (plan.searchCategories.length === 0) return []
    if (plan.filters.neighborhoods.length > 0) return []

    const categoriesArr = `{${plan.searchCategories.map(c => `"${c}"`).join(',')}}`

    type RawRow = { id: string; similarity: number }
    const rows = await prisma.$queryRaw<RawRow[]>`
      SELECT id, 1 - (embedding <=> ${pgVector}::vector) AS similarity
      FROM "ExtractedOpportunity"
      WHERE "processingStatus" = 'active'
        AND embedding IS NOT NULL
        AND category = ANY(${categoriesArr}::text[])
      ORDER BY embedding <=> ${pgVector}::vector
      LIMIT 20
    `

    if (rows.length === 0) return []

    const ids = rows.map(r => r.id)

    // Apply price and bed filters so the fallback respects the user's budget/criteria
    const fallbackWhere: Record<string, unknown> = { id: { in: ids } }
    if (plan.filters.maxPrice !== null) fallbackWhere.price = { lte: plan.filters.maxPrice }
    if (plan.filters.minBeds !== null || plan.filters.maxBeds !== null) {
      const bedFilter: Record<string, number> = {}
      if (plan.filters.minBeds !== null) bedFilter.gte = plan.filters.minBeds
      if (plan.filters.maxBeds !== null) bedFilter.lte = plan.filters.maxBeds
      fallbackWhere.beds = bedFilter
    }

    const opps = await prisma.extractedOpportunity.findMany({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      where: fallbackWhere as any,
      select: {
        id: true, category: true, address: true, neighborhood: true, borough: true,
        price: true, minPrice: true, maxPrice: true, beds: true, baths: true,
        propertyType: true, availabilityDate: true, sourceAgentName: true,
        sourceAgentEmail: true, sourceBrokerage: true, clientSide: true,
        extractedTitle: true, extractedSummary: true,
        transactionType: true, createdAt: true, streetEasyId: true,
      },
    })

    const simMap = new Map(rows.map(r => [r.id, r.similarity]))
    return opps
      .map(o => ({ ...o, score: 0, tier: 'weak' as const, grade: 'weak_match' as const }))
      .sort((a, b) => (simMap.get(b.id) ?? 0) - (simMap.get(a.id) ?? 0))
  }
}
