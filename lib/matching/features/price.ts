import type { ListingData, BuyerData, FeatureResult } from '../scorerTypes'
import { priceOverlapScore } from '../priceOverlap'
import { sellerPriceRange, nearestPrice } from '../sellerPrice'

// Reuses the existing fractional priceOverlap. Tolerance widened to 0.15 to match
// the eligibility band. HIGH when both bounds + listing price are known; MEDIUM
// when the buyer side is an open/scalar range; LOW when a side is unknown.
// A seller known only by our estimated value is scored at the point of its ±25%
// range nearest the buyer's budget, and never above MEDIUM (sellerPrice.ts).
export function computePrice(listing: ListingData, buyer: BuyerData): FeatureResult {
  const key = 'price'
  const range = sellerPriceRange(listing)
  if (range == null || (buyer.priceMin == null && buyer.priceMax == null)) {
    return { key, score: 0.5, confidence: 'LOW' }
  }
  const score = priceOverlapScore(nearestPrice(range, buyer.priceMin, buyer.priceMax), buyer.priceMin, buyer.priceMax, 0.15)
  const bothBounds = buyer.priceMin != null && buyer.priceMax != null
  return { key, score, confidence: bothBounds && range.basis !== 'estimate' ? 'HIGH' : 'MEDIUM' }
}
