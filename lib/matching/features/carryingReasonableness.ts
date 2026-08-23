import type { ListingData, ScoringContext, FeatureResult } from '../scorerTypes'
import { carryingBucketKey } from '../compsKey'

// Is the monthly carrying cost (maintenance + common charges + taxes) reasonable
// versus comparable listings in the same (neighborhood, $500k band, propertyType)
// bucket? No carrying data → LOW. Thin comps bucket (<5, absent from map) → MEDIUM.
export function computeCarryingReasonableness(listing: ListingData, context: ScoringContext): FeatureResult {
  const key = 'carryingReasonableness'
  const { monthlyMaintenance, monthlyCommonCharges, monthlyTaxes } = listing
  if (monthlyMaintenance == null && monthlyCommonCharges == null && monthlyTaxes == null) {
    return { key, score: 0.5, confidence: 'LOW' }
  }
  const monthly = (monthlyMaintenance ?? 0) + (monthlyCommonCharges ?? 0) + (monthlyTaxes ?? 0)
  const median = context.compsMedians.get(carryingBucketKey(listing.neighborhood, listing.price, listing.propertyType))
  if (median == null || median === 0) return { key, score: 0.6, confidence: 'MEDIUM' }

  const ratio = monthly / median
  let score: number
  if (ratio <= 1.15) score = 1.0
  else if (ratio <= 1.4) score = 0.6
  else if (ratio <= 1.75) score = 0.3
  else score = 0.05
  return { key, score, confidence: 'HIGH' }
}
