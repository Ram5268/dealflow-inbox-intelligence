import type { ListingData, BuyerData, FeatureResult } from '../scorerTypes'
import { priceOverlapScore } from '../priceOverlap'

// Reuses the existing fractional priceOverlap. Tolerance widened to 0.15 to match
// the eligibility band. HIGH when both bounds + listing price are known; MEDIUM
// when the buyer side is an open/scalar range; LOW when a side is unknown.
export function computePrice(listing: ListingData, buyer: BuyerData): FeatureResult {
  const key = 'price'
  if (listing.price == null || (buyer.priceMin == null && buyer.priceMax == null)) {
    return { key, score: 0.5, confidence: 'LOW' }
  }
  const score = priceOverlapScore(listing.price, buyer.priceMin, buyer.priceMax, 0.15)
  const bothBounds = buyer.priceMin != null && buyer.priceMax != null
  return { key, score, confidence: bothBounds ? 'HIGH' : 'MEDIUM' }
}
