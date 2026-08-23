import type { ListingData, FeatureResult } from '../scorerTypes'

const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000

// Longer ownership tenure → more likely to sell. null lastSaleDate → LOW abstain.
export function computeTenure(listing: ListingData, now: Date): FeatureResult {
  const key = 'tenure'
  if (listing.lastSaleDate == null) return { key, score: 0.5, confidence: 'LOW' }
  const years = (now.getTime() - listing.lastSaleDate.getTime()) / MS_PER_YEAR
  let score: number
  if (years >= 20) score = 1.0
  else if (years >= 10) score = 0.7
  else if (years >= 5) score = 0.5
  else if (years >= 2) score = 0.3
  else score = 0.1 // recent buyer, unlikely to sell
  return { key, score, confidence: 'HIGH' }
}
