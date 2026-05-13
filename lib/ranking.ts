import { ExtractedOpportunity } from '@prisma/client'
import { SearchCriteria } from './ai'

export interface RankedOpportunity {
  opportunity: ExtractedOpportunity
  score: number
  matchReasons: string[]
}

const BROOKLYN_NEIGHBORHOODS = [
  'bed-stuy', 'bedford-stuyvesant', 'clinton hill', 'fort greene', 'crown heights',
  'prospect heights', 'park slope', 'brooklyn heights', 'boerum hill', 'cobble hill',
  'carroll gardens', 'red hook', 'gowanus', 'sunset park', 'bay ridge', 'bensonhurst',
  'williamsburg', 'bushwick', 'east new york', 'brownsville', 'flatbush', 'ditmas park',
  'kensington', 'borough park', 'greenpoint', 'long island city', 'astoria',
]

function normalizeNeighborhood(n: string): string {
  return n.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim()
}

function neighborhoodSimilar(a: string, b: string): boolean {
  const na = normalizeNeighborhood(a)
  const nb = normalizeNeighborhood(b)
  if (na === nb) return true
  if (na.includes(nb) || nb.includes(na)) return true
  // bed-stuy / bedford-stuyvesant alias
  if ((na.includes('bed') && na.includes('stuy')) && (nb.includes('bed') || nb.includes('stuy'))) return true
  if ((nb.includes('bed') && nb.includes('stuy')) && (na.includes('bed') || na.includes('stuy'))) return true
  return false
}

function daysSince(dateStr: string | Date): number {
  const d = typeof dateStr === 'string' ? new Date(dateStr) : dateStr
  return (Date.now() - d.getTime()) / (1000 * 60 * 60 * 24)
}

export function rankOpportunities(
  opportunities: ExtractedOpportunity[],
  criteria: SearchCriteria,
  rawQuery: string
): RankedOpportunity[] {
  const queryWords = rawQuery.toLowerCase().split(/\s+/)

  const scored = opportunities.map((opp) => {
    let score = 0
    const reasons: string[] = []

    // Category match
    if (criteria.desiredCategories?.length) {
      if (criteria.desiredCategories.includes(opp.category)) {
        score += 30
        reasons.push(`Category matches: ${opp.category}`)
      }
    }

    // Transaction type match
    if (criteria.transactionType && opp.transactionType === criteria.transactionType) {
      score += 20
      reasons.push('Transaction type matches')
    }

    // Neighborhood match
    if (criteria.neighborhoods?.length && opp.neighborhood) {
      const exact = criteria.neighborhoods.some(
        (n) => normalizeNeighborhood(n) === normalizeNeighborhood(opp.neighborhood!)
      )
      const similar = criteria.neighborhoods.some((n) =>
        neighborhoodSimilar(n, opp.neighborhood!)
      )
      if (exact) {
        score += 25
        reasons.push(`Exact neighborhood match: ${opp.neighborhood}`)
      } else if (similar) {
        score += 15
        reasons.push(`Similar neighborhood: ${opp.neighborhood}`)
      }
    }

    // Borough match
    if (criteria.borough && opp.borough) {
      if (opp.borough.toLowerCase() === criteria.borough.toLowerCase()) {
        score += 10
        reasons.push(`Borough matches: ${opp.borough}`)
      }
    }

    // Budget fit
    if (criteria.maxPrice != null) {
      if (opp.price != null && opp.price <= criteria.maxPrice) {
        score += 15
        reasons.push(`Price ${opp.price.toLocaleString()} fits budget of ${criteria.maxPrice.toLocaleString()}`)
      } else if (opp.maxPrice != null && opp.maxPrice <= criteria.maxPrice) {
        score += 12
        reasons.push(`Max price ${opp.maxPrice.toLocaleString()} fits budget`)
      } else if (opp.price == null && opp.maxPrice == null) {
        score += 3 // no price info, slight bonus for not ruling it out
      }
    }

    if (criteria.minPrice != null && opp.price != null && opp.price >= criteria.minPrice) {
      score += 5
      reasons.push('Meets minimum price')
    }

    // Property type
    if (criteria.propertyType && opp.propertyType) {
      if (opp.propertyType.toLowerCase().includes(criteria.propertyType.toLowerCase())) {
        score += 10
        reasons.push(`Property type matches: ${opp.propertyType}`)
      }
    }

    // Units match
    if (criteria.units != null && opp.units != null) {
      if (opp.units >= criteria.units) {
        score += 10
        reasons.push(`${opp.units} units matches requirement`)
      }
    }

    // Beds match
    if (criteria.beds != null && opp.beds != null) {
      if (opp.beds >= criteria.beds) {
        score += 8
        reasons.push(`${opp.beds} beds matches requirement`)
      }
    }

    // Recency (up to 10 points, decaying)
    const age = daysSince(opp.createdAt)
    const recencyScore = Math.max(0, 10 - age / 3)
    score += recencyScore

    // Confidence score
    score += opp.confidenceScore * 10

    // Keyword similarity in title/summary
    const text = `${opp.extractedTitle} ${opp.extractedSummary} ${opp.neighborhood ?? ''} ${opp.borough ?? ''}`.toLowerCase()
    const kwMatches = queryWords.filter((w) => w.length > 3 && text.includes(w))
    if (kwMatches.length > 0) {
      score += kwMatches.length * 2
      reasons.push(`Keywords matched: ${kwMatches.join(', ')}`)
    }

    if (reasons.length === 0) reasons.push('Partial match based on available data')

    return { opportunity: opp, score, matchReasons: reasons }
  })

  return scored.sort((a, b) => b.score - a.score)
}
