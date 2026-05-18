import type { ScoredRecord, QueryPlan, IntentBucket } from './types'

type Tier = ScoredRecord['tier']

// ── Intent-specific scoring profiles ─────────────────────────────────────────
// Each profile scores 0–100. Tier thresholds: excellent≥90, good≥70, fair≥50, weak<50.

function scoreRental(r: ScoredRecord, plan: QueryPlan): number {
  // Profile A: Rental Search / Renter Inquiry Matching
  // Neighborhood 35, Rent range 30, Beds 20, Availability 10, Freshness 5
  let score = 0

  // Neighborhood (35 pts)
  if (plan.filters.neighborhoods.length > 0 && r.neighborhood) {
    const rn = r.neighborhood.toLowerCase()
    const exact = plan.filters.neighborhoods.some(n => rn.includes(n.toLowerCase()))
    if (exact) {
      score += 35
    } else {
      const allAdj = Object.values(plan.adjacentNeighborhoods).flat()
      if (allAdj.some(n => rn.includes(n.toLowerCase()))) score += 20
    }
  } else if (plan.filters.neighborhoods.length === 0) {
    score += 20  // no neighborhood filter, no penalty
  }

  // Rent range (30 pts)
  const effectivePrice = r.price ?? r.maxPrice ?? r.minPrice
  if (plan.filters.maxPrice !== null && effectivePrice !== null) {
    if (effectivePrice <= plan.filters.maxPrice) score += 30
    else if (effectivePrice <= plan.filters.maxPrice * 1.1) score += 15
  } else if (plan.filters.maxPrice === null) {
    score += 20  // no price filter
  }

  // Beds (20 pts)
  if (r.beds !== null) {
    const minB = plan.filters.minBeds
    const maxB = plan.filters.maxBeds
    if (minB === null && maxB === null) {
      score += 15  // no bed filter
    } else if ((minB === null || r.beds >= minB) && (maxB === null || r.beds <= maxB)) {
      score += 20
    } else if (Math.abs(r.beds - (maxB ?? minB ?? r.beds)) <= 1) {
      score += 10
    }
  } else {
    score += 8  // beds unknown, small penalty
  }

  // Availability date (10 pts) — available now or soon is best
  if (r.availabilityDate) {
    const d = new Date(r.availabilityDate)
    const daysOut = (d.getTime() - Date.now()) / 86_400_000
    if (daysOut <= 30)  score += 10
    else if (daysOut <= 60) score += 5
  } else {
    score += 5  // no date = likely available now
  }

  // Freshness (5 pts)
  const daysOld = (Date.now() - r.createdAt.getTime()) / 86_400_000
  if (daysOld <= 7)  score += 5
  else if (daysOld <= 30) score += 3
  else if (daysOld <= 60) score += 1

  return Math.min(score, 100)
}

function scoreSale(r: ScoredRecord, plan: QueryPlan): number {
  // Profile B: Buyer Search / Buyer ISO Matching
  // Neighborhood 30, Budget 30, Asset type 20, Beds 15, Freshness 5
  let score = 0

  // Neighborhood (30 pts)
  if (plan.filters.neighborhoods.length > 0 && r.neighborhood) {
    const rn = r.neighborhood.toLowerCase()
    const exact = plan.filters.neighborhoods.some(n => rn.includes(n.toLowerCase()))
    if (exact) {
      score += 30
    } else {
      const allAdj = Object.values(plan.adjacentNeighborhoods).flat()
      if (allAdj.some(n => rn.includes(n.toLowerCase()))) score += 18
    }
  } else if (plan.filters.neighborhoods.length === 0) {
    score += 18
  }

  // Budget (30 pts)
  const effectivePrice = r.price ?? r.maxPrice ?? r.minPrice
  if (plan.filters.maxPrice !== null && effectivePrice !== null) {
    if (effectivePrice <= plan.filters.maxPrice) score += 30
    else if (effectivePrice <= plan.filters.maxPrice * 1.15) score += 15
    else if (effectivePrice <= plan.filters.maxPrice * 1.3) score += 5
  } else if (plan.filters.maxPrice === null) {
    score += 18
  }

  // Asset type (20 pts) — available info
  if (r.propertyType) score += 10
  score += 10  // baseline — we don't have buyer's preferred type in ParsedQuery yet

  // Beds (15 pts)
  if (r.beds !== null) {
    const minB = plan.filters.minBeds
    const maxB = plan.filters.maxBeds
    if (minB === null && maxB === null) {
      score += 10
    } else if ((minB === null || r.beds >= minB) && (maxB === null || r.beds <= maxB)) {
      score += 15
    } else if (Math.abs(r.beds - (maxB ?? minB ?? r.beds)) <= 1) {
      score += 8
    }
  } else {
    score += 5
  }

  // Freshness (5 pts)
  const daysOld = (Date.now() - r.createdAt.getTime()) / 86_400_000
  if (daysOld <= 7)  score += 5
  else if (daysOld <= 30) score += 3
  else if (daysOld <= 60) score += 1

  return Math.min(score, 100)
}

function scoreDemand(r: ScoredRecord, plan: QueryPlan): number {
  // For BUYER_ISO / RENTER_INQUIRY — score how well their criteria match current query context
  let score = 40  // baseline for demand records

  if (plan.filters.neighborhoods.length > 0 && r.neighborhood) {
    const rn = r.neighborhood.toLowerCase()
    if (plan.filters.neighborhoods.some(n => rn.includes(n.toLowerCase()))) score += 30
  } else {
    score += 15
  }

  const daysOld = (Date.now() - r.createdAt.getTime()) / 86_400_000
  if (daysOld <= 14) score += 20
  else if (daysOld <= 30) score += 10

  return Math.min(score, 100)
}

function scoreSellerLead(r: ScoredRecord, plan: QueryPlan): number {
  // Profile D (simplified): neighborhood 30, freshness as recency 30, type 20, price 20
  let score = 0

  if (plan.filters.neighborhoods.length > 0 && r.neighborhood) {
    const rn = r.neighborhood.toLowerCase()
    if (plan.filters.neighborhoods.some(n => rn.includes(n.toLowerCase()))) score += 30
    else score += 10
  } else {
    score += 20
  }

  const daysOld = (Date.now() - r.createdAt.getTime()) / 86_400_000
  if (daysOld <= 7)  score += 30
  else if (daysOld <= 30) score += 20
  else if (daysOld <= 90) score += 10

  if (r.propertyType) score += 20
  if (r.price) score += 20

  return Math.min(score, 100)
}

function scoreDefault(r: ScoredRecord, plan: QueryPlan): number {
  let score = 50

  if (plan.filters.neighborhoods.length > 0 && r.neighborhood) {
    const rn = r.neighborhood.toLowerCase()
    if (plan.filters.neighborhoods.some(n => rn.includes(n.toLowerCase()))) score += 20
  }

  const daysOld = (Date.now() - r.createdAt.getTime()) / 86_400_000
  if (daysOld <= 14) score += 15
  else if (daysOld <= 30) score += 8

  return Math.min(score, 100)
}

function toTier(score: number): Tier {
  if (score >= 90) return 'excellent'
  if (score >= 70) return 'good'
  if (score >= 50) return 'fair'
  return 'weak'
}

function selectProfile(intent: IntentBucket, r: ScoredRecord): 'rental' | 'sale' | 'demand' | 'lead' | 'default' {
  if (['BUYER_ISO','RENTER_INQUIRY'].includes(r.category))                     return 'demand'
  if (['SELLER_LEAD','LANDLORD_LEAD'].includes(r.category))                    return 'lead'
  if (intent === 'opportunity_search' && r.transactionType === 'RENTAL')       return 'rental'
  if (intent === 'opportunity_search')                                          return 'sale'
  if (['RENTAL_LISTING','COMING_SOON_RENTAL'].includes(r.category))            return 'rental'
  if (['ACTIVE_SALE_LISTING','OFF_MARKET_SALE','COMING_SOON_SALE',
       'BACK_ON_MARKET','PRICE_DROP','DEVELOPMENT_INVENTORY'].includes(r.category)) return 'sale'
  return 'default'
}

export function scoreRecords(records: ScoredRecord[], plan: QueryPlan): ScoredRecord[] {
  return records
    .map(r => {
      const profile = selectProfile(plan.intent, r)
      let score: number
      switch (profile) {
        case 'rental':  score = scoreRental(r, plan); break
        case 'sale':    score = scoreSale(r, plan);   break
        case 'demand':  score = scoreDemand(r, plan); break
        case 'lead':    score = scoreSellerLead(r, plan); break
        default:        score = scoreDefault(r, plan)
      }
      return { ...r, score, tier: toTier(score) }
    })
    .sort((a, b) => b.score - a.score)
}
