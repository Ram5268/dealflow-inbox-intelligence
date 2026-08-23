import type { ListingData, FeatureResult } from '../scorerTypes'

// No mortgage at all → maximally unencumbered seller. Unknown balance → LOW.
export function computeFreeAndClear(listing: ListingData): FeatureResult {
  const key = 'freeAndClear'
  if (listing.totalLoanBalance == null) return { key, score: 0.5, confidence: 'LOW' }
  if (listing.totalLoanBalance === 0) return { key, score: 1.0, confidence: 'HIGH' }
  return { key, score: 0.4, confidence: 'HIGH' } // active loan → not free & clear
}
