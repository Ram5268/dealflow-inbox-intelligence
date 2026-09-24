import type { ListingData, FeatureResult } from '../scorerTypes'

// Equity as a fraction of estimated value. More equity → more freedom to transact.
export function computeHighEquity(listing: ListingData): FeatureResult {
  const key = 'highEquity'
  if (listing.equityBalance == null || listing.estimatedValue == null || listing.estimatedValue === 0) {
    return { key, score: 0.5, confidence: 'LOW' }
  }
  const equityPct = listing.equityBalance / listing.estimatedValue
  let score: number
  if (equityPct >= 0.7) score = 1.0
  else if (equityPct >= 0.5) score = 0.75
  else if (equityPct >= 0.3) score = 0.5
  else if (equityPct >= 0.1) score = 0.25
  else score = 0.1
  return { key, score, confidence: 'HIGH' }
}
